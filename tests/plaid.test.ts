import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/middleware/require-auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'user-1', email: 'user@test.com' };
    next();
  },
}));

jest.mock('../src/services/plaid.service', () => ({
  createLinkToken: jest.fn(),
  exchangePublicToken: jest.fn(),
  completeHostedLink: jest.fn(),
  listConnections: jest.fn(),
}));

import plaidRouter from '../src/routes/plaid.js';
import {
  completeHostedLink,
  createLinkToken,
  exchangePublicToken,
  listConnections,
} from '../src/services/plaid.service.js';
import { PlaidError } from '../src/types/plaid.js';

type MockFn = ReturnType<typeof jest.fn>;

const mockedCreateLinkToken = createLinkToken as unknown as MockFn;
const mockedExchange = exchangePublicToken as unknown as MockFn;
const mockedCompleteHostedLink = completeHostedLink as unknown as MockFn;
const mockedListConnections = listConnections as unknown as MockFn;

const app = express();
app.use(express.json());
app.use('/plaid', plaidRouter);

const connection = {
  id: 'item-row-1',
  itemId: 'item-1',
  institutionId: 'ins_1',
  institutionName: 'Chase',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: [],
};

beforeEach(() => {
  mockedCreateLinkToken.mockReset();
  mockedExchange.mockReset();
  mockedCompleteHostedLink.mockReset();
  mockedListConnections.mockReset();
});

describe('POST /plaid/link-token', () => {
  test('returns the link token for the authenticated user', async () => {
    mockedCreateLinkToken.mockResolvedValueOnce({
      linkToken: 'link-sandbox-1',
      expiration: '2026-01-01T04:00:00Z',
      hostedLinkUrl: 'https://hosted.plaid.com/link/abc',
    });

    const response = await request(app).post('/plaid/link-token');

    expect(mockedCreateLinkToken).toHaveBeenCalledWith('user-1', {
      mode: undefined,
      itemRowId: undefined,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      linkToken: 'link-sandbox-1',
      expiration: '2026-01-01T04:00:00Z',
      hostedLinkUrl: 'https://hosted.plaid.com/link/abc',
    });
  });

  test('maps a PlaidError to its status code', async () => {
    mockedCreateLinkToken.mockRejectedValueOnce(
      new PlaidError('invalid client_id', 502),
    );

    const response = await request(app).post('/plaid/link-token');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'invalid client_id' });
  });
});

describe('POST /plaid/exchange-public-token', () => {
  test('exchanges the public token and returns the connection', async () => {
    mockedExchange.mockResolvedValueOnce(connection);

    const response = await request(app)
      .post('/plaid/exchange-public-token')
      .send({ publicToken: 'public-sandbox-1' });

    expect(mockedExchange).toHaveBeenCalledWith('user-1', 'public-sandbox-1');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ connection });
  });

  test('rejects a missing public token', async () => {
    const response = await request(app).post('/plaid/exchange-public-token').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(mockedExchange).not.toHaveBeenCalled();
  });
});

describe('POST /plaid/hosted-link/complete', () => {
  test('reports pending while the browser session is unfinished', async () => {
    mockedCompleteHostedLink.mockResolvedValueOnce({ status: 'pending' });

    const response = await request(app)
      .post('/plaid/hosted-link/complete')
      .send({ linkToken: 'link-sandbox-1' });

    expect(mockedCompleteHostedLink).toHaveBeenCalledWith('user-1', 'link-sandbox-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'pending' });
  });

  test('returns the connection once the session finishes', async () => {
    mockedCompleteHostedLink.mockResolvedValueOnce({ status: 'connected', connection });

    const response = await request(app)
      .post('/plaid/hosted-link/complete')
      .send({ linkToken: 'link-sandbox-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'connected', connection });
  });
});

describe('GET /plaid/connections', () => {
  test('lists the connections for the authenticated user', async () => {
    mockedListConnections.mockResolvedValueOnce([connection]);

    const response = await request(app).get('/plaid/connections');

    expect(mockedListConnections).toHaveBeenCalledWith('user-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connections: [connection] });
  });
});
