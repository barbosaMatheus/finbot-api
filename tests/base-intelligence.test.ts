import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import baseIntelligenceRouter from '../src/routes/base-intelligence.js';
import { pool } from '../src/db.js';

type MockFn = ReturnType<typeof jest.fn>;

const mockedPool = pool as unknown as {
  query: MockFn;
  end: MockFn;
};

const app = express();
app.use(express.json());
app.use('/base-intelligence', baseIntelligenceRouter);

describe('GET /base-intelligence', () => {
  beforeEach(() => {
    mockedPool.query.mockReset();
    mockedPool.end.mockReset();
  });

  test('returns the latest contents row', async () => {
    mockedPool.query.mockResolvedValueOnce({ rows: [{ contents: 'second entry' }] });

    const response = await request(app).get('/base-intelligence');

    expect(mockedPool.query).toHaveBeenCalledWith(
      'SELECT contents FROM base_intelligence ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contents: 'second entry' });
  });
});
