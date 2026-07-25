import request from 'supertest';
import { describe, test, expect, jest, beforeEach } from "@jest/globals";

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

import app from '../src/app';
import { pool } from '../src/db';

const mockedPool = pool as unknown as {
  query: jest.Mock;
  end: jest.Mock;
};

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
