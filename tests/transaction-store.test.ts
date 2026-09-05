import { describe, expect, test } from '@jest/globals';
import type { RemovedTransaction, Transaction } from 'plaid';

import { normalizeMerchant } from '../src/lib/merchant.js';
import {
  applySyncChanges,
  normalizeTransaction,
} from '../src/services/transaction-store.service.js';

function plaidTxn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 'txn-1',
    account_id: 'acc-1',
    amount: 42.5,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: '2026-08-01',
    authorized_date: '2026-07-31',
    name: 'STARBUCKS STORE #1234',
    merchant_name: 'Starbucks',
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'in store',
    personal_finance_category: {
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_COFFEE',
      confidence_level: 'VERY_HIGH',
    },
    transaction_code: null,
    ...overrides,
  } as Transaction;
}

describe('normalizeTransaction', () => {
  test('preserves the Plaid sign convention exactly', () => {
    // Positive = money out. Inverting this silently flips every total.
    expect(normalizeTransaction(plaidTxn({ amount: 42.5 })).amount).toBe(42.5);
    expect(normalizeTransaction(plaidTxn({ amount: -1200 })).amount).toBe(-1200);
  });

  test('maps PFCv2 fields with confidence and version', () => {
    const normalized = normalizeTransaction(plaidTxn());

    expect(normalized.pfcPrimary).toBe('FOOD_AND_DRINK');
    expect(normalized.pfcDetailed).toBe('FOOD_AND_DRINK_COFFEE');
    expect(normalized.pfcConfidence).toBe('VERY_HIGH');
    expect(normalized.pfcVersion).toBe('v2');
  });

  test('missing PFC yields explicit nulls, not guesses', () => {
    const normalized = normalizeTransaction(
      plaidTxn({ personal_finance_category: null }),
    );

    expect(normalized.pfcPrimary).toBeNull();
    expect(normalized.pfcDetailed).toBeNull();
    expect(normalized.pfcConfidence).toBeNull();
  });

  test('unrecognized confidence collapses to UNKNOWN', () => {
    const normalized = normalizeTransaction(
      plaidTxn({
        personal_finance_category: {
          primary: 'INCOME',
          detailed: 'INCOME_WAGES',
          confidence_level: 'SOMETHING_NEW',
        },
      }),
    );

    expect(normalized.pfcConfidence).toBe('UNKNOWN');
  });

  test('keeps the pending lifecycle linkage', () => {
    const normalized = normalizeTransaction(
      plaidTxn({ pending: true, pending_transaction_id: null }),
    );
    expect(normalized.pending).toBe(true);

    const posted = normalizeTransaction(
      plaidTxn({ transaction_id: 'txn-2', pending_transaction_id: 'txn-1' }),
    );
    expect(posted.pendingTransactionId).toBe('txn-1');
  });

  test('stores the whole raw payload as evidence', () => {
    const txn = plaidTxn();
    expect(normalizeTransaction(txn).raw).toBe(txn);
  });

  test('normalizes the merchant for grouping', () => {
    expect(normalizeTransaction(plaidTxn()).merchantNormalized).toBe('starbucks');
  });
});

describe('normalizeMerchant', () => {
  test.each<[string, string]>([
    ['NETFLIX.COM', 'netflix'],
    ['Netflix', 'netflix'],
    ['SQ *BLUE BOTTLE COFFEE', 'blue bottle coffee'],
    ['TST* JOES PIZZA #42', 'joes pizza'],
    ['PAYPAL *SPOTIFY', 'spotify'],
    ['STARBUCKS STORE #1234', 'starbucks store'],
    ['AMAZON.COM*RT4Z55TZ0', 'amazon'],
    ['Comcast Cable Comm 08/15', 'comcast cable comm'],
    ['DELTA AIR 0062339195income', 'delta air 0062339195income'],
    ['ACME Payments LLC', 'acme'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeMerchant(input)).toBe(expected);
  });

  test('falls back to the transaction name when merchant is missing', () => {
    expect(normalizeMerchant(null, 'UBER   *TRIP')).toBe('uber trip');
  });

  test('returns null when nothing usable remains', () => {
    expect(normalizeMerchant('   ')).toBeNull();
    expect(normalizeMerchant('####')).toBeNull();
    expect(normalizeMerchant(null, null)).toBeNull();
  });

  test('same merchant different statements agree on one key', () => {
    const a = normalizeMerchant('NETFLIX.COM #4521');
    const b = normalizeMerchant('Netflix');
    expect(a).toBe(b);
  });
});

type Captured = { text: string; values: unknown[] };

function fakeDb() {
  const queries: Captured[] = [];
  return {
    queries,
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 1 } as never;
    },
  };
}

describe('applySyncChanges', () => {
  test('added and modified upsert on transaction_id so replays converge', async () => {
    const db = fakeDb();

    const counts = await applySyncChanges(db, {
      userId: 'user-1',
      plaidItemRowId: 'item-row-1',
      added: [plaidTxn()],
      modified: [plaidTxn({ transaction_id: 'txn-9', amount: 10 })],
      removed: [],
    });

    expect(counts).toEqual({ added: 1, modified: 1, removed: 0 });
    // Two upserts plus the override-migration statement.
    expect(db.queries).toHaveLength(3);

    for (const q of db.queries.slice(0, 2)) {
      expect(q.text).toContain('ON CONFLICT (transaction_id) DO UPDATE');
      // Re-adding a previously removed transaction resurrects it.
      expect(q.text).toContain('is_removed = FALSE');
    }

    // Corrections survive settle: transaction-scoped overrides move from
    // the dead pending row to its posted replacement, scoped to this user.
    const migration = db.queries[2]!;
    expect(migration.text).toContain('UPDATE user_classification_overrides');
    expect(migration.text).toContain('pending_transaction_id');
    expect(migration.values).toEqual(['user-1']);
  });

  test('removed ids flip the removed flag instead of deleting evidence', async () => {
    const db = fakeDb();

    const counts = await applySyncChanges(db, {
      userId: 'user-1',
      plaidItemRowId: 'item-row-1',
      added: [],
      modified: [],
      removed: [
        { transaction_id: 'txn-1' } as RemovedTransaction,
        { transaction_id: 'txn-2' } as RemovedTransaction,
      ],
    });

    expect(counts.removed).toBe(1); // one UPDATE statement, rowCount from fake
    const removal = db.queries[0]!;
    expect(removal.text).toContain('SET is_removed = TRUE');
    expect(removal.text).not.toContain('DELETE');
    expect(removal.values[1]).toEqual(['txn-1', 'txn-2']);
  });

  test('binds normalized values in insert order', async () => {
    const db = fakeDb();
    await applySyncChanges(db, {
      userId: 'user-1',
      plaidItemRowId: 'item-row-1',
      added: [plaidTxn()],
      modified: [],
      removed: [],
    });

    const insert = db.queries[0]!;
    expect(insert.values[0]).toBe('user-1');
    expect(insert.values[1]).toBe('item-row-1');
    expect(insert.values[2]).toBe('acc-1');
    expect(insert.values[3]).toBe('txn-1');
    expect(insert.values[7]).toBe(42.5); // amount keeps Plaid sign
    expect(insert.values[14]).toBe('FOOD_AND_DRINK');
    expect(insert.values[16]).toBe('VERY_HIGH');
    expect(insert.values[17]).toBe('v2');
  });
});
