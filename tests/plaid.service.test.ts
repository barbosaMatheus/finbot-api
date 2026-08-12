import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

/** Loose signature so each mock can resolve whatever the SDK shape needs. */
type AsyncMock = (...args: unknown[]) => Promise<unknown>;

const mockClient = {
  itemPublicTokenExchange: jest.fn<AsyncMock>(),
  accountsGet: jest.fn<AsyncMock>(),
  institutionsGetById: jest.fn<AsyncMock>(),
  linkTokenCreate: jest.fn<AsyncMock>(),
  linkTokenGet: jest.fn<AsyncMock>(),
};

jest.mock('../src/lib/plaid', () => ({
  getPlaidClient: () => mockClient,
  getPlaidProducts: () => ['transactions'],
  getPlaidCountryCodes: () => ['US'],
  getPlaidRedirectUri: () => undefined,
  getPlaidAndroidPackageName: () => undefined,
  getHostedLinkRedirectUri: () => undefined,
  PLAID_CLIENT_NAME: 'FinBot',
}));

const dbClient = {
  query: jest.fn<AsyncMock>(),
  release: jest.fn(),
};

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(async () => dbClient),
  },
}));

import { decryptSecret } from '../src/lib/crypto.js';
import { exchangePublicToken } from '../src/services/plaid.service.js';

const itemRow = {
  id: 'item-row-1',
  item_id: 'item-1',
  institution_id: 'ins_3',
  institution_name: 'Chase',
  status: 'active',
  created_at: new Date('2026-01-01T00:00:00Z'),
};

beforeAll(() => {
  process.env.PLAID_TOKEN_ENC_KEY = randomBytes(32).toString('base64');
});

beforeEach(() => {
  jest.clearAllMocks();

  mockClient.itemPublicTokenExchange.mockResolvedValue({
    data: { access_token: 'access-sandbox-secret', item_id: 'item-1' },
  });
  mockClient.accountsGet.mockResolvedValue({
    data: {
      accounts: [
        {
          account_id: 'acc-1',
          name: 'Plaid Checking',
          official_name: 'Plaid Gold Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
          balances: { current: 110, available: 100, iso_currency_code: 'USD' },
        },
      ],
      item: { institution_id: 'ins_3' },
    },
  });
  mockClient.institutionsGetById.mockResolvedValue({
    data: { institution: { name: 'Chase' } },
  });

  // BEGIN, item upsert, account upsert, account select, COMMIT
  dbClient.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [itemRow] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          plaid_item_id: 'item-row-1',
          account_id: 'acc-1',
          name: 'Plaid Checking',
          official_name: 'Plaid Gold Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
          current_balance: '110.00',
          available_balance: '100.00',
          iso_currency_code: 'USD',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
});

describe('exchangePublicToken', () => {
  test('never writes the access token in plaintext', async () => {
    await exchangePublicToken('user-1', 'public-sandbox-1');

    const insertCall = dbClient.query.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO plaid_items'),
    );

    expect(insertCall).toBeDefined();

    const params = insertCall?.[1] as unknown[];
    const stored = params[2] as string;

    expect(stored).not.toContain('access-sandbox-secret');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored)).toBe('access-sandbox-secret');
  });

  test('returns the connection with its accounts, numeric balances coerced', async () => {
    const connection = await exchangePublicToken('user-1', 'public-sandbox-1');

    expect(connection).toEqual({
      id: 'item-row-1',
      itemId: 'item-1',
      institutionId: 'ins_3',
      institutionName: 'Chase',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      accounts: [
        {
          accountId: 'acc-1',
          name: 'Plaid Checking',
          officialName: 'Plaid Gold Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking',
          currentBalance: 110,
          availableBalance: 100,
          isoCurrencyCode: 'USD',
        },
      ],
    });
  });

  test('commits the transaction and releases the client', async () => {
    await exchangePublicToken('user-1', 'public-sandbox-1');

    const statements = dbClient.query.mock.calls.map((call) =>
      String(call[0]),
    );

    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
    expect(dbClient.release).toHaveBeenCalled();
  });
});
