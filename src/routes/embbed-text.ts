import { Router } from 'express';
import { z } from 'zod';

import { pgVectorSize, pool } from '../db.js';
import { validateBody } from '../middleware/validate.js';
import { chunkText, type ChunkerOptions } from '../rag/text-chunker.js';
import { textToEmbedding } from '../rag/text-embedder.js';

const router = Router();

const embeddingOptionsSchema = z.record(z.string(), z.unknown()).optional();

const embedTextSchema = z.object({
  text: z.string().trim().min(1, 'text is required'),
  userId: z.string().uuid(),
  maxChunkSize: z.number().int().positive().optional(),
  overlap: z.number().int().nonnegative().optional(),
  minChunkSize: z.number().int().nonnegative().optional(),
  vectorDimension: z.number().int().positive().optional(),
  embeddingOptions: embeddingOptionsSchema,
});

export interface BuildEmbeddingVectorOptions {
  vectorDimension?: number;
  chunkOptions?: {
    maxChunkSize?: number;
    overlap?: number;
    minChunkSize?: number;
  };
  embeddingOptions?: Record<string, unknown>;
}

interface EmbeddingSettings {
  nGram?: number;
  useTfIdf?: boolean;
  idfMap?: Map<string, number> | Record<string, number>;
}

function normalizeEmbeddingOptions(
  embeddingOptions?: Record<string, unknown>,
): EmbeddingSettings {
  const normalized: EmbeddingSettings = {};

  if (typeof embeddingOptions?.nGram === 'number') {
    normalized.nGram = embeddingOptions.nGram;
  }

  if (typeof embeddingOptions?.useTfIdf === 'boolean') {
    normalized.useTfIdf = embeddingOptions.useTfIdf;
  }

  if (embeddingOptions?.idfMap !== undefined) {
    const candidate = embeddingOptions.idfMap;

    if (candidate instanceof Map) {
      normalized.idfMap = candidate;
    } else if (candidate && typeof candidate === 'object') {
      const mapped: Record<string, number> = {};
      for (const [key, value] of Object.entries(candidate)) {
        if (typeof value === 'number') {
          mapped[key] = value;
        }
      }
      normalized.idfMap = mapped;
    }
  }

  return normalized;
}

export interface ChunkEmbedding {
  chunkText: string;
  embedding: number[];
  chunkPosition: number;
}

export function buildEmbeddingVector(
  text: string,
  options: BuildEmbeddingVectorOptions = {},
): number[] {
  const vectorDimension = options.vectorDimension ?? pgVectorSize;
  const chunkOptions: ChunkerOptions = {
    maxChunkSize: options.chunkOptions?.maxChunkSize ?? 1200,
    overlap: options.chunkOptions?.overlap ?? 200,
    minChunkSize: options.chunkOptions?.minChunkSize ?? 300,
  };

  const chunks = chunkText(text, chunkOptions);
  const embeddingOptions = normalizeEmbeddingOptions(options.embeddingOptions);

  if (chunks.length === 0) {
    return textToEmbedding(text, vectorDimension, embeddingOptions);
  }

  const embeddings = chunks.map((chunk) =>
    textToEmbedding(chunk.text, vectorDimension, embeddingOptions),
  );

  const summed = new Float32Array(vectorDimension);
  for (const embedding of embeddings) {
    for (let i = 0; i < vectorDimension; i++) {
      summed[i] += embedding[i] ?? 0;
    }
  }

  const averaged = Array.from(summed, (value) => value / embeddings.length);
  const norm = Math.sqrt(averaged.reduce((sum, value) => sum + value * value, 0));

  if (norm === 0) {
    return averaged;
  }

  return averaged.map((value) => value / norm);
}

export function buildChunkEmbeddings(
  text: string,
  options: BuildEmbeddingVectorOptions = {},
): ChunkEmbedding[] {
  const vectorDimension = options.vectorDimension ?? pgVectorSize;
  const chunkOptions: ChunkerOptions = {
    maxChunkSize: options.chunkOptions?.maxChunkSize ?? 1200,
    overlap: options.chunkOptions?.overlap ?? 200,
    minChunkSize: options.chunkOptions?.minChunkSize ?? 300,
  };

  const chunks = chunkText(text, chunkOptions);
  const embeddingOptions = normalizeEmbeddingOptions(options.embeddingOptions);

  if (chunks.length === 0) {
    const embedding = textToEmbedding(text, vectorDimension, embeddingOptions);
    return [{ chunkText: text, embedding, chunkPosition: 0 }];
  }

  return chunks.map((chunk, index) => ({
    chunkText: chunk.text,
    embedding: textToEmbedding(chunk.text, vectorDimension, embeddingOptions),
    chunkPosition: index,
  }));
}

function padEmbedding(values: number[], vectorSize: number): number[] {
  const padded = new Array<number>(vectorSize).fill(0);
  for (let i = 0; i < values.length && i < vectorSize; i++) {
    padded[i] = values[i];
  }
  return padded;
}

function toPgVectorString(values: number[]): string {
  return `[${values.join(',')}]`;
}

router.post('/', validateBody(embedTextSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof embedTextSchema>;
    const requestedVectorSize = body.vectorDimension ?? pgVectorSize;
    const vectorSize = Number.isInteger(requestedVectorSize) && requestedVectorSize > 0
      ? Math.min(requestedVectorSize, 768)
      : 768;
    const chunkEmbeddings = buildChunkEmbeddings(body.text, {
      vectorDimension: vectorSize,
      chunkOptions: {
        maxChunkSize: body.maxChunkSize,
        overlap: body.overlap,
        minChunkSize: body.minChunkSize,
      },
      embeddingOptions: body.embeddingOptions,
    });

    const documentResult = await pool.query(
      `
        INSERT INTO context_documents (user_id, context, created_at)
        VALUES ($1::uuid, $2, NOW())
        RETURNING id, user_id, context, created_at
      `,
      [body.userId, body.text],
    );

    const documentRow = documentResult.rows[0];
    const insertedEmbeddings = [] as Array<{ id: string; embedding: number[]; chunkPosition: number }>;

    for (const chunk of chunkEmbeddings) {
      const persistedVector = padEmbedding(chunk.embedding, vectorSize);
      const insertQuery = `
        INSERT INTO user_text_embeddings (
          user_id,
          context_document_id,
          response_text,
          embedding,
          chunk_position
        )
        VALUES ($1::uuid, $2::uuid, $3, $4::vector(${vectorSize}), $5)
        RETURNING id, chunk_position, created_at
      `;
      const result = await pool.query(insertQuery, [
        body.userId,
        documentRow.id,
        chunk.chunkText,
        toPgVectorString(persistedVector),
        chunk.chunkPosition,
      ]);

      insertedEmbeddings.push({
        id: result.rows[0].id,
        embedding: persistedVector,
        chunkPosition: result.rows[0].chunk_position,
      });
    }

    res.status(201).json({
      documentId: documentRow.id,
      userId: documentRow.user_id,
      context: documentRow.context,
      createdAt: documentRow.created_at,
      embeddings: insertedEmbeddings,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('violates foreign key')) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    next(err);
  }
});

export default router;
