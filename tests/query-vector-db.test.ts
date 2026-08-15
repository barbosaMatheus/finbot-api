import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, it } from '@jest/globals';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
  pgVectorSize: 3,
}));

jest.mock('../src/routes/embbed-text', () => ({
  buildEmbeddingVector: jest.fn(() => [0.5, 0.5, 0.5]),
}));

import queryVectorDbRouter from '../src/routes/query-vector-db.js';
import { pool } from '../src/db.js';
import { buildEmbeddingVector } from '../src/routes/embbed-text.js';

const mockedPool = pool as any;
const mockedBuildEmbeddingVector = buildEmbeddingVector as unknown as jest.Mock;

const app = express();
app.use(express.json());
app.use('/query-vector-db', queryVectorDbRouter);

describe('POST /query-vector-db', () => {
  beforeEach(() => {
    mockedPool.query.mockReset();
    mockedPool.end.mockReset();
    mockedBuildEmbeddingVector.mockClear();
  });

  it('returns the closest chunk text for a user and query text', async () => {
    mockedPool.query.mockResolvedValue({
      rows: [
        {
          id: 'emb-1',
          user_id: '123e4567-e89b-12d3-a456-426614174000',
          context_document_id: 'doc-1',
          response_text: 'matching chunk text',
          chunk_position: 0,
          distance: 0.12,
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const response = await request(app)
      .post('/query-vector-db')
      .send({
        userId: '123e4567-e89b-12d3-a456-426614174000',
        topN: 3,
        text: 'sample query text',
        vectorDimension: 3,
        maxChunkSize: 8,
        overlap: 2,
        minChunkSize: 3,
      });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0].responseText).toBe('matching chunk text');
    expect(mockedBuildEmbeddingVector).toHaveBeenCalledWith(
      'sample query text',
      expect.objectContaining({
        vectorDimension: 3,
        chunkOptions: {
          maxChunkSize: 8,
          overlap: 2,
          minChunkSize: 3,
        },
      }),
    );
    expect(mockedPool.query).toHaveBeenCalled();
  });

  it('rejects invalid input before hitting the database', async () => {
    const response = await request(app)
      .post('/query-vector-db')
      .send({
        userId: 'not-a-uuid',
        topN: 0,
        text: ' ',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(mockedPool.query).not.toHaveBeenCalled();
  });
});
