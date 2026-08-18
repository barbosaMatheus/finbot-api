import { pgVectorSize, pool } from '../db.js';
import {
  buildChunkEmbeddings,
  type BuildEmbeddingVectorOptions,
} from '../rag/build-embeddings.js';

export const ONBOARDING_CONTEXT_SOURCE = 'onboarding_additional_context';

type PersistUserTextEmbeddingsInput = {
  userId: string;
  text: string;
  source?: string;
  options?: BuildEmbeddingVectorOptions;
};

export type PersistedEmbeddingResult = {
  documentId: string;
  userId: string;
  context: string;
  source: string;
  createdAt: Date;
  embeddings: Array<{
    id: string;
    embedding: number[];
    chunkPosition: number;
  }>;
};

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

export async function deleteContextDocumentsBySource(
  userId: string,
  source: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM context_documents
     WHERE user_id = $1::uuid AND source = $2`,
    [userId, source],
  );
}

export async function persistUserTextEmbeddings(
  input: PersistUserTextEmbeddingsInput,
): Promise<PersistedEmbeddingResult> {
  const source = input.source ?? 'general';
  const vectorSize = Math.min(
    input.options?.vectorDimension &&
      Number.isInteger(input.options.vectorDimension) &&
      input.options.vectorDimension > 0
      ? input.options.vectorDimension
      : pgVectorSize,
    768,
  );

  const chunkEmbeddings = buildChunkEmbeddings(input.text, {
    ...input.options,
    vectorDimension: vectorSize,
  });

  const documentResult = await pool.query(
    `
      INSERT INTO context_documents (user_id, context, source, created_at)
      VALUES ($1::uuid, $2, $3, NOW())
      RETURNING id, user_id, context, source, created_at
    `,
    [input.userId, input.text, source],
  );

  const documentRow = documentResult.rows[0];
  const insertedEmbeddings: PersistedEmbeddingResult['embeddings'] = [];

  for (const chunk of chunkEmbeddings) {
    const persistedVector = padEmbedding(chunk.embedding, vectorSize);
    const result = await pool.query(
      `
        INSERT INTO user_text_embeddings (
          user_id,
          context_document_id,
          response_text,
          embedding,
          chunk_position
        )
        VALUES ($1::uuid, $2::uuid, $3, $4::vector(${vectorSize}), $5)
        RETURNING id, chunk_position
      `,
      [
        input.userId,
        documentRow.id,
        chunk.chunkText,
        toPgVectorString(persistedVector),
        chunk.chunkPosition,
      ],
    );

    insertedEmbeddings.push({
      id: result.rows[0].id,
      embedding: persistedVector,
      chunkPosition: result.rows[0].chunk_position,
    });
  }

  return {
    documentId: documentRow.id,
    userId: documentRow.user_id,
    context: documentRow.context,
    source: documentRow.source,
    createdAt: documentRow.created_at,
    embeddings: insertedEmbeddings,
  };
}

/** Replace prior docs for a source, then insert fresh embeddings (idempotent per source). */
export async function replaceUserTextEmbeddings(
  input: PersistUserTextEmbeddingsInput,
): Promise<PersistedEmbeddingResult | null> {
  const source = input.source ?? 'general';
  const trimmed = input.text.trim();

  await deleteContextDocumentsBySource(input.userId, source);

  if (!trimmed) {
    return null;
  }

  return persistUserTextEmbeddings({
    ...input,
    text: trimmed,
    source,
  });
}
