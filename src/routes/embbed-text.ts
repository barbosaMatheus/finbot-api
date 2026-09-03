import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { persistUserTextEmbeddings } from '../services/embedding.service.js';

const router = Router();

const embeddingOptionsSchema = z.record(z.string(), z.unknown()).optional();

export const embedTextSchema = z.object({
  text: z.string().trim().min(1, 'text is required'),
  userId: z.string().uuid(),
  source: z.string().trim().min(1).optional(),
  maxChunkSize: z.number().int().positive().optional(),
  overlap: z.number().int().nonnegative().optional(),
  minChunkSize: z.number().int().nonnegative().optional(),
  vectorDimension: z.number().int().positive().optional(),
  embeddingOptions: embeddingOptionsSchema.optional(),
});

// Re-export builders for any existing imports.
export {
  buildChunkEmbeddings,
  buildEmbeddingVector,
  type BuildEmbeddingVectorOptions,
  type ChunkEmbedding,
} from '../rag/build-embeddings.js';

router.post('/', validateBody(embedTextSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof embedTextSchema>;
    const result = await persistUserTextEmbeddings({
      userId: body.userId,
      text: body.text,
      source: body.source,
      options: {
        vectorDimension: body.vectorDimension,
        chunkOptions: {
          maxChunkSize: body.maxChunkSize,
          overlap: body.overlap,
          minChunkSize: body.minChunkSize,
        },
        embeddingOptions: body.embeddingOptions,
      },
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('violates foreign key')) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    next(err);
  }
});

export default router;
