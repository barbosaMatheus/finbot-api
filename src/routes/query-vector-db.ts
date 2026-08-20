import { Router } from 'express';
import { z } from 'zod';

import { pgVectorSize, pool } from '../db.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/require-auth.js';
import { buildEmbeddingVector } from './embbed-text.js';

const router = Router();

const queryVectorDbSchema = z.object({
  topN: z.coerce.number().int().positive().max(50).default(5),
  text: z.string().trim().min(1, 'text is required'),
  vectorDimension: z.coerce.number().int().positive().optional(),
  maxChunkSize: z.coerce.number().int().positive().optional(),
  overlap: z.coerce.number().int().nonnegative().optional(),
  minChunkSize: z.coerce.number().int().nonnegative().optional(),
  embeddingOptions: z.record(z.string(), z.unknown()).optional(),
});

function toPgVectorString(values: number[]): string {
  return `[${values.map((value) => Number.isFinite(value) ? value : 0).join(',')}]`;
}

router.post('/', requireAuth, validateBody(queryVectorDbSchema), async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body as z.infer<typeof queryVectorDbSchema>;
    const requestedVectorSize = body.vectorDimension ?? pgVectorSize;
    const vectorSize = Number.isInteger(requestedVectorSize) && requestedVectorSize > 0
      ? Math.min(requestedVectorSize, 768)
      : pgVectorSize;

    const queryVector = buildEmbeddingVector(body.text, {
      vectorDimension: vectorSize,
      chunkOptions: {
        maxChunkSize: body.maxChunkSize,
        overlap: body.overlap,
        minChunkSize: body.minChunkSize,
      },
      embeddingOptions: body.embeddingOptions,
    });

    const result = await pool.query(
      `
        SELECT
          id,
          user_id,
          context_document_id,
          response_text,
          chunk_position,
          created_at,
          embedding <=> $1::vector(${vectorSize}) AS distance
        FROM user_text_embeddings
        WHERE user_id = $2::uuid
        ORDER BY embedding <=> $1::vector(${vectorSize}) ASC
        LIMIT $3
      `,
      [toPgVectorString(queryVector), userId, body.topN],
    );

    res.status(200).json({
      userId,
      topN: body.topN,
      queryText: body.text,
      results: result.rows.map((row) => ({
        id: row.id,
        contextDocumentId: row.context_document_id,
        responseText: row.response_text,
        chunkPosition: row.chunk_position,
        createdAt: row.created_at,
        distance: Number(row.distance),
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;


