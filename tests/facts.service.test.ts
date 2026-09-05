import {
  budgetStatus,
  comparePeriods,
  detectRecurring,
  previousPeriod,
  summarizeBalances,
  summarizeSpend,
} from '../src/services/facts.service.js';
import type { AccountBalance, Transaction } from '../src/types/facts.js';

let sequence = 0;

function txn(overrides: Partial<Transaction> & Pick<Transaction, 'date' | 'amount'>): Transaction {
  sequence += 1;
  return {
    transactionId: `txn-${sequence}`,
    accountId: 'acct-1',
    category: null,
    merchantName: null,
    pending: false,
    isoCurrencyCode: 'USD',
    ...overrides,
  };
}

const JANUARY = { start: '2026-01-01', end: '2026-01-31' };

describe('summarizeSpend', () => {
  it('treats positive amounts as spend and negative as income, per Plaid', () => {
    // This is the assertion that catches an inverted sign convention. If these
    // two ever swap, every number in the app is backwards.
    const summary = summarizeSpend(
      [txn({ date: '2026-01-05', amount: 40 }), txn({ date: '2026-01-06', amount: -2000 })],
      JANUARY,
    );

    expect(summary.totalSpend).toBe(40);
    expect(summary.totalIncome).toBe(2000);
    expect(summary.net).toBe(1960);
  });

  it('excludes transactions outside the range, inclusive of both ends', () => {
    const summary = summarizeSpend(
      [
        txn({ date: '2025-12-31', amount: 100 }),
        txn({ date: '2026-01-01', amount: 10 }),
        txn({ date: '2026-01-31', amount: 5 }),
        txn({ date: '2026-02-01', amount: 100 }),
      ],
      JANUARY,
    );

    expect(summary.totalSpend).toBe(15);
    expect(summary.transactionCount).toBe(2);
  });

  it('excludes pending transactions by default and includes them on request', () => {
    const transactions = [
      txn({ date: '2026-01-10', amount: 30 }),
      txn({ date: '2026-01-11', amount: 70, pending: true }),
    ];

    expect(summarizeSpend(transactions, JANUARY).totalSpend).toBe(30);
    expect(summarizeSpend(transactions, JANUARY, { includePending: true }).totalSpend).toBe(100);
  });

  it('groups by category, sorts descending, and computes share of spend', () => {
    const summary = summarizeSpend(
      [
        txn({ date: '2026-01-02', amount: 15, category: 'Food' }),
        txn({ date: '2026-01-03', amount: 75, category: 'Rent' }),
        txn({ date: '2026-01-04', amount: 10, category: 'Food' }),
      ],
      JANUARY,
    );

    expect(summary.byCategory).toEqual([
      { category: 'Rent', total: 75, transactionCount: 1, shareOfSpend: 0.75 },
      { category: 'Food', total: 25, transactionCount: 2, shareOfSpend: 0.25 },
    ]);
  });

  it('buckets missing categories as Uncategorized', () => {
    const summary = summarizeSpend([txn({ date: '2026-01-02', amount: 10 })], JANUARY);
    expect(summary.byCategory[0]?.category).toBe('Uncategorized');
  });

  it('rounds away floating point drift', () => {
    const summary = summarizeSpend(
      [txn({ date: '2026-01-02', amount: 0.1 }), txn({ date: '2026-01-03', amount: 0.2 })],
      JANUARY,
    );
    expect(summary.totalSpend).toBe(0.3);
  });

  it('returns zeroed totals for an empty period rather than throwing', () => {
    const summary = summarizeSpend([], JANUARY);
    expect(summary).toMatchObject({ totalSpend: 0, totalIncome: 0, net: 0, transactionCount: 0 });
    expect(summary.byCategory).toEqual([]);
  });
});

describe('previousPeriod', () => {
  it('returns an equally sized window ending the day before the range starts', () => {
    // January spans 31 days, so the comparison window is the 31 days before it.
    expect(previousPeriod(JANUARY)).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  });

  it('handles a single day', () => {
    expect(previousPeriod({ start: '2026-03-10', end: '2026-03-10' })).toEqual({
      start: '2026-03-09',
      end: '2026-03-09',
    });
  });
});

describe('comparePeriods', () => {
  const transactions = [
    txn({ date: '2025-12-15', amount: 100, category: 'Food' }),
    txn({ date: '2025-12-16', amount: 50, category: 'Games' }),
    txn({ date: '2026-01-15', amount: 150, category: 'Food' }),
  ];

  it('computes the overall delta and percent change', () => {
    const comparison = comparePeriods(transactions, JANUARY);

    expect(comparison.current.totalSpend).toBe(150);
    expect(comparison.previous.totalSpend).toBe(150);
    expect(comparison.spendDelta).toBe(0);
    expect(comparison.spendPercentChange).toBe(0);
  });

  it('includes categories that appear in only one period', () => {
    const games = comparePeriods(transactions, JANUARY).byCategory.find(
      (c) => c.category === 'Games',
    );

    expect(games).toEqual({
      category: 'Games',
      current: 0,
      previous: 50,
      delta: -50,
      percentChange: -1,
    });
  });

  it('reports null percent change when the previous period was zero', () => {
    const comparison = comparePeriods([txn({ date: '2026-01-15', amount: 20 })], JANUARY);
    expect(comparison.spendPercentChange).toBeNull();
    expect(comparison.spendDelta).toBe(20);
  });
});

describe('detectRecurring', () => {
  it('detects a monthly subscription', () => {
    const found = detectRecurring([
      txn({ date: '2026-01-03', amount: 15.99, merchantName: 'Netflix' }),
      txn({ date: '2026-02-02', amount: 15.99, merchantName: 'Netflix' }),
      txn({ date: '2026-03-04', amount: 15.99, merchantName: 'Netflix' }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      merchantName: 'Netflix',
      averageAmount: 15.99,
      occurrences: 3,
      cadenceDays: 30,
      firstDate: '2026-01-03',
      lastDate: '2026-03-04',
    });
  });

  it('ignores merchants with too few charges', () => {
    expect(
      detectRecurring([
        txn({ date: '2026-01-03', amount: 15.99, merchantName: 'Netflix' }),
        txn({ date: '2026-02-02', amount: 15.99, merchantName: 'Netflix' }),
      ]),
    ).toEqual([]);
  });

  it('rejects irregular gaps even when the mean gap looks plausible', () => {
    // Three consecutive days then a charge much later. A mean-based check would
    // accept this; every gap must sit near the median.
    expect(
      detectRecurring([
        txn({ date: '2026-01-01', amount: 10, merchantName: 'Corner Store' }),
        txn({ date: '2026-01-02', amount: 10, merchantName: 'Corner Store' }),
        txn({ date: '2026-01-03', amount: 10, merchantName: 'Corner Store' }),
        txn({ date: '2026-06-01', amount: 10, merchantName: 'Corner Store' }),
      ]),
    ).toEqual([]);
  });

  it('groups case-insensitively but reports the original casing', () => {
    const found = detectRecurring([
      txn({ date: '2026-01-03', amount: 10, merchantName: 'Spotify' }),
      txn({ date: '2026-02-03', amount: 10, merchantName: 'SPOTIFY' }),
      txn({ date: '2026-03-05', amount: 10, merchantName: 'spotify' }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.merchantName).toBe('Spotify');
  });

  it('ignores income, which is never a recurring charge', () => {
    expect(
      detectRecurring([
        txn({ date: '2026-01-01', amount: -2000, merchantName: 'Employer' }),
        txn({ date: '2026-02-01', amount: -2000, merchantName: 'Employer' }),
        txn({ date: '2026-03-01', amount: -2000, merchantName: 'Employer' }),
      ]),
    ).toEqual([]);
  });
});

describe('budgetStatus', () => {
  const transactions = [txn({ date: '2026-01-05', amount: 100, category: 'Food' })];

  it('reports spend, remaining, and percent used', () => {
    const [food] = budgetStatus(transactions, JANUARY, [{ category: 'Food', limit: 400 }], '2026-01-31');

    expect(food).toMatchObject({ spent: 100, remaining: 300, percentUsed: 0.25 });
  });

  it('projects end-of-period spend from the pace so far', () => {
    // 10 days into a 31 day month having spent 100 → roughly 310 by month end.
    const [food] = budgetStatus(transactions, JANUARY, [{ category: 'Food', limit: 400 }], '2026-01-10');

    expect(food?.projectedSpend).toBe(310);
    expect(food?.projectedOverage).toBe(0);
  });

  it('reports projected overage when the pace overshoots the limit', () => {
    const [food] = budgetStatus(transactions, JANUARY, [{ category: 'Food', limit: 200 }], '2026-01-10');

    expect(food?.projectedSpend).toBe(310);
    expect(food?.projectedOverage).toBe(110);
  });

  it('goes negative on remaining once over budget rather than clamping', () => {
    const [food] = budgetStatus(transactions, JANUARY, [{ category: 'Food', limit: 60 }], '2026-01-31');

    expect(food?.remaining).toBe(-40);
    expect(food?.percentUsed).toBeGreaterThan(1);
  });

  it('returns a zeroed row for a category with no spending', () => {
    const [games] = budgetStatus(transactions, JANUARY, [{ category: 'Games', limit: 50 }], '2026-01-31');

    expect(games).toMatchObject({ spent: 0, remaining: 50, percentUsed: 0 });
  });

  it('does not project before the period has started', () => {
    const [food] = budgetStatus(transactions, JANUARY, [{ category: 'Food', limit: 400 }], '2025-12-20');

    expect(food?.projectedSpend).toBeNull();
    expect(food?.projectedOverage).toBeNull();
  });
});

describe('summarizeBalances', () => {
  const accounts: AccountBalance[] = [
    {
      accountId: 'a',
      name: 'Checking',
      type: 'depository',
      currentBalance: 1500,
      availableBalance: 1420,
    },
    { accountId: 'b', name: 'Savings', type: 'depository', currentBalance: 5000, availableBalance: 5000 },
    { accountId: 'c', name: 'Visa', type: 'credit', currentBalance: 800, availableBalance: null },
  ];

  it('counts credit balances as liabilities, never as assets', () => {
    const summary = summarizeBalances(accounts);

    expect(summary.totalAssets).toBe(6500);
    expect(summary.totalLiabilities).toBe(800);
    expect(summary.netPosition).toBe(5700);
  });

  it('prefers available balance over current for spendable money', () => {
    // 1420 available on checking, not 1500 — the difference is already spent.
    expect(summarizeBalances(accounts).availableToSpend).toBe(6420);
  });

  it('falls back to current balance when available is missing', () => {
    expect(
      summarizeBalances([
        { accountId: 'a', name: 'Checking', type: 'depository', currentBalance: 300, availableBalance: null },
      ]).availableToSpend,
    ).toBe(300);
  });

  it('handles no accounts', () => {
    expect(summarizeBalances([])).toEqual({
      totalAssets: 0,
      totalLiabilities: 0,
      netPosition: 0,
      availableToSpend: 0,
      accountCount: 0,
    });
  });
});
