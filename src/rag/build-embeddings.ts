import { pgVectorSize } from '../db.js';
import { chunkText, type ChunkerOptions } from './text-chunker.js';
import { textToEmbedding } from './text-embedder.js';

export type BuildEmbeddingVectorOptions = {
  vectorDimension?: number;
  chunkOptions?: {
    maxChunkSize?: number;
    overlap?: number;
    minChunkSize?: number;
  };
  embeddingOptions?: Record<string, unknown>;
};

export type ChunkEmbedding = {
  chunkText: string;
  embedding: number[];
  chunkPosition: number;
};

type EmbeddingSettings = {
  nGram?: number;
  useTfIdf?: boolean;
  idfMap?: Map<string, number> | Record<string, number>;
};

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
