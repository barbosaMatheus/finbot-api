import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, it } from '@jest/globals';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

jest.mock('../src/rag/text-chunker', () => ({
  chunkText: jest.fn(),
}));

jest.mock('../src/rag/text-embedder', () => ({
  textToEmbedding: jest.fn(),
}));

import embedTextRouter from '../src/routes/embbed-text.js';
import { pool } from '../src/db.js';
import { chunkText } from '../src/rag/text-chunker.js';
import { textToEmbedding } from '../src/rag/text-embedder.js';

type MockFn = ReturnType<typeof jest.fn>;

const mockedPool = pool as unknown as {
  query: MockFn;
  end: MockFn;
};
const mockedChunkText = chunkText as unknown as MockFn;
const mockedTextToEmbedding = textToEmbedding as unknown as MockFn;

const app = express();
app.use(express.json());
app.use('/embeddings', embedTextRouter);

describe('POST /embeddings', () => {
  beforeEach(() => {
    mockedPool.query.mockReset();
    mockedPool.end.mockReset();
    mockedChunkText.mockReset();
    mockedTextToEmbedding.mockReset();
  });

  it('stores a context document and one embedding per chunk', async () => {
    mockedChunkText.mockReturnValue([
      { text: 'first chunk', start: 0, end: 11 },
      { text: 'second chunk', start: 11, end: 23 },
    ]);
    mockedTextToEmbedding.mockImplementation((value: string) => [value.length, 0.5, 1]);

    mockedPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'doc-1',
            user_id: '11111111-1111-1111-1111-111111111111',
            context: 'sample text',
            created_at: '2024-01-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'emb-1', chunk_position: 0, created_at: '2024-01-01T00:00:00.000Z' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'emb-2', chunk_position: 1, created_at: '2024-01-01T00:00:00.000Z' }],
      });

    const response = await request(app)
      .post('/embeddings')
      .send({
        text: 'sample text',
        userId: '123e4567-e89b-12d3-a456-426614174000',
        vectorDimension: 3,
        embeddingOptions: {},
      });

    expect(response.status).toBe(201);
    expect(response.body.documentId).toBe('doc-1');
    expect(response.body.embeddings).toHaveLength(2);
    expect(mockedChunkText).toHaveBeenCalled();
    expect(mockedTextToEmbedding).toHaveBeenCalledTimes(2);
    expect(mockedPool.query).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid input before touching the database', async () => {
    const response = await request(app)
      .post('/embeddings')
      .send({
        text: ' ',
        userId: 'not-a-uuid',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(mockedPool.query).not.toHaveBeenCalled();
  });
});
