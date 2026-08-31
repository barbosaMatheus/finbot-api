import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

/** Loose signature so each mock can resolve whatever the SDK shape needs. */
type AsyncMock = (...args: unknown[]) => Promise<unknown>;

const mockClient = {
  itemPublicTokenExchange: jest.fn<AsyncMock>(),
  accountsGet: jest.fn<AsyncMock>(),
  institutionsGetById: jest.fn<AsyncMock>(),
  linkTokenCreate: jest.fn<AsyncMock>(),
  linkTokenGet: jest.fn<AsyncMock>(),
  itemRemove: jest.fn<AsyncMock>(),
  itemWebhookUpdate: jest.fn<AsyncMock>(),
};

jest.mock('../src/lib/plaid', () => ({
  getPlaidClient: () => mockClient,
  getPlaidProducts: () => ['transactions'],
  getPlaidCountryCodes: () => ['US'],
  getPlaidRedirectUri: () => undefined,
  getPlaidAndroidPackageName: () => undefined,
  getHostedLinkRedirectUri: () => undefined,
  getPlaidWebhookUrl: () => process.env.PLAID_WEBHOOK_URL?.trim() || undefined,
  getRequestedHistoryDays: () => 180,
  PLAID_CLIENT_NAME: 'FinBot',
}));

const dbClient = {
  query: jest.fn<AsyncMock>(),
  release: jest.fn(),
};

jest.mock('../src/db', () => ({
  pool: {
    // Empty result set by default so incidental reads (duplicate
    // detection, sync-state lookups) resolve harmlessly.
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn(async () => dbClient),
  },
}));

import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import {
  createLinkToken,
  exchangePublicToken,
  syncItemWebhooks,
} from '../src/services/plaid.service.js';

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

describe('webhook URL registration', () => {
  afterEach(() => {
    delete process.env.PLAID_WEBHOOK_URL;
  });

  test('createLinkToken registers the webhook receiver with Plaid', async () => {
    process.env.PLAID_WEBHOOK_URL = 'https://api.example.com/plaid/webhook';
    mockClient.linkTokenCreate.mockResolvedValue({
      data: { link_token: 'link-1', expiration: null, hosted_link_url: null },
    });

    await createLinkToken('user-1');

    expect(mockClient.linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ webhook: 'https://api.example.com/plaid/webhook' }),
    );
  });

  test('createLinkToken omits the webhook field when the URL is unset', async () => {
    mockClient.linkTokenCreate.mockResolvedValue({
      data: { link_token: 'link-1', expiration: null, hosted_link_url: null },
    });

    await createLinkToken('user-1');

    expect(mockClient.linkTokenCreate.mock.calls[0]?.[0]).not.toHaveProperty('webhook');
  });

  test('syncItemWebhooks points existing active Items at the receiver', async () => {
    process.env.PLAID_WEBHOOK_URL = 'https://api.example.com/plaid/webhook';

    const { pool } = jest.requireMock('../src/db') as { pool: { query: jest.Mock } };
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'item-row-1', access_token_encrypted: encryptSecret('access-1') },
        { id: 'item-row-2', access_token_encrypted: encryptSecret('access-2') },
      ],
      rowCount: 2,
    });

    await syncItemWebhooks();

    expect(mockClient.itemWebhookUpdate).toHaveBeenCalledTimes(2);
    expect(mockClient.itemWebhookUpdate).toHaveBeenCalledWith({
      access_token: 'access-1',
      webhook: 'https://api.example.com/plaid/webhook',
    });
  });

  test('syncItemWebhooks is a no-op without a configured URL', async () => {
    await syncItemWebhooks();

    expect(mockClient.itemWebhookUpdate).not.toHaveBeenCalled();
  });

  test('one Item failing to update does not stop the rest', async () => {
    process.env.PLAID_WEBHOOK_URL = 'https://api.example.com/plaid/webhook';

    const { pool } = jest.requireMock('../src/db') as { pool: { query: jest.Mock } };
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'item-row-1', access_token_encrypted: encryptSecret('access-1') },
        { id: 'item-row-2', access_token_encrypted: encryptSecret('access-2') },
      ],
      rowCount: 2,
    });
    mockClient.itemWebhookUpdate
      .mockRejectedValueOnce(new Error('ITEM_LOGIN_REQUIRED'))
      .mockResolvedValueOnce({ data: {} });

    await syncItemWebhooks();

    expect(mockClient.itemWebhookUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('credential redaction in error logging', () => {
  let consoleOutput: string[];
  let spies: Array<jest.SpiedFunction<(...args: unknown[]) => void>>;

  beforeEach(() => {
    consoleOutput = [];
    spies = (['error', 'warn', 'log'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        // Expand objects the way Node's console would, so a raw axios error
        // passed to console.* is caught even though String(err) would hide it.
        consoleOutput.push(args.map((arg) => inspect(arg, { depth: 10 })).join(' '));
      }),
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
  });

  /** An axios-shaped network error carrying our credentials, as the SDK throws. */
  const axiosNetworkError = () => {
    const err = new Error('getaddrinfo ENOTFOUND production.plaid.com') as Error & {
      config?: unknown;
      isAxiosError?: boolean;
    };
    err.name = 'AxiosError';
    err.isAxiosError = true;
    err.config = {
      headers: {
        'PLAID-CLIENT-ID': 'leaked-client-id',
        'PLAID-SECRET': 'leaked-plaid-secret',
      },
      data: JSON.stringify({ access_token: 'leaked-access-token' }),
    };
    return err;
  };

  test('network-level Plaid failures never log the axios config', async () => {
    mockClient.itemPublicTokenExchange.mockRejectedValue(axiosNetworkError());

    await expect(
      exchangePublicToken('user-1', 'public-sandbox-1'),
    ).rejects.toThrow('Could not complete the bank connection');

    const output = consoleOutput.join('\n');
    expect(output).not.toContain('leaked-plaid-secret');
    expect(output).not.toContain('leaked-client-id');
    expect(output).not.toContain('leaked-access-token');
    // The failure itself is still observable.
    expect(output).toContain('plaid request failed');
  });

  test('institution-name lookup failures never log the axios config', async () => {
    mockClient.institutionsGetById.mockRejectedValue(axiosNetworkError());

    await exchangePublicToken('user-1', 'public-sandbox-1');

    const output = consoleOutput.join('\n');
    expect(output).not.toContain('leaked-plaid-secret');
    expect(output).not.toContain('leaked-client-id');
    expect(output).not.toContain('leaked-access-token');
    expect(output).toContain('could not resolve institution name');
  });
});

describe('duplicate Item detection (API-016)', () => {
  test('re-linking the same institution with the same accounts reuses the existing Item', async () => {
    const { pool } = jest.requireMock('../src/db') as {
      pool: { query: jest.Mock };
    };

    // A different Plaid item_id, same institution, same account fingerprint.
    mockClient.itemPublicTokenExchange.mockResolvedValue({
      data: { access_token: 'access-sandbox-new', item_id: 'item-2' },
    });

    // listConnections inside duplicate detection: items, accounts, health.
    pool.query
      .mockResolvedValueOnce({ rows: [itemRow], rowCount: 1 })
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
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const connection = await exchangePublicToken('user-1', 'public-sandbox-2');

    expect(connection.duplicate).toBe(true);
    expect(connection.itemId).toBe('item-1');
    // The unnecessary access token is revoked at Plaid.
    expect(mockClient.itemRemove).toHaveBeenCalledWith({
      access_token: 'access-sandbox-new',
    });
    // No new Item row was written.
    const insertCalls = dbClient.query.mock.calls.filter((call) =>
      String(call[0]).includes('INSERT INTO plaid_items'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  test('same institution with different accounts is a real second Item', async () => {
    const { pool } = jest.requireMock('../src/db') as {
      pool: { query: jest.Mock };
    };

    mockClient.itemPublicTokenExchange.mockResolvedValue({
      data: { access_token: 'access-sandbox-new', item_id: 'item-2' },
    });
    mockClient.accountsGet.mockResolvedValue({
      data: {
        accounts: [
          {
            account_id: 'acc-9',
            name: 'Plaid Credit Card',
            official_name: null,
            mask: '9999',
            type: 'credit',
            subtype: 'credit card',
            balances: { current: 250, available: null, iso_currency_code: 'USD' },
          },
        ],
        item: { institution_id: 'ins_3' },
      },
    });

    pool.query
      .mockResolvedValueOnce({ rows: [itemRow], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plaid_item_id: 'item-row-1',
            account_id: 'acc-1',
            name: 'Plaid Checking',
            official_name: null,
            mask: '0000',
            type: 'depository',
            subtype: 'checking',
            current_balance: '110.00',
            available_balance: '100.00',
            iso_currency_code: 'USD',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // ensureSyncState after persist
      .mockResolvedValue({ rows: [], rowCount: 0 });

    // Persist path uses the tx client; feed it the second item row.
    dbClient.query.mockReset();
    dbClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...itemRow, id: 'item-row-2', item_id: 'item-2' }] })
      .mockResolvedValueOnce({ rows: [] }) // account upsert
      .mockResolvedValueOnce({ rows: [] }) // account select
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const connection = await exchangePublicToken('user-1', 'public-sandbox-2');

    expect(connection.duplicate).toBeUndefined();
    expect(mockClient.itemRemove).not.toHaveBeenCalled();
  });
});
