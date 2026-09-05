import { describe, expect, jest, test } from '@jest/globals';

import type { ItemSyncOverview } from '../src/services/analysis-orchestration.service.js';
import { computeFinancialFacts, type FactsData } from '../src/services/financial-facts.service.js';
import {
  buildFinancialReview,
  computeCoverage,
  generateReviewItems,
  type ReviewBuildDeps,
} from '../src/services/review.service.js';
import type { FactsTransaction, FinancialFacts } from '../src/types/financial-facts.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

const THROUGH = '2026-08-24';

let counter = 0;

function txn(overrides: Partial<FactsTransaction>): FactsTransaction {
  counter += 1;
  return {
    rowId: `row-${counter}`,
    amount: 100,
    date: '2026-03-05',
    pending: false,
    role: 'expense',
    displayBucket: 'Shopping',
    accountType: 'depository',
    linked: false,
    ...overrides,
  };
}

function item(overrides: Partial<ItemSyncOverview>): ItemSyncOverview {
  return {
    itemRowId: 'item-1',
    institutionName: 'Chase',
    syncStatus: 'complete',
    updateStatus: 'HISTORICAL_UPDATE_COMPLETE',
    oldestTransactionDate: '2026-03-01',
    historyDaysAvailable: 176,
    lastErrorCode: null,
    terminal: true,
    usable: true,
    ...overrides,
  };
}

function factsFrom(data: Partial<FactsData>): FinancialFacts {
  return computeFinancialFacts(
    { transactions: [], accounts: [], streams: [], declaredObligations: [], ...data },
    THROUGH,
  );
}

function coverageInput(
  facts: FinancialFacts,
  items: ItemSyncOverview[],
  requestedDays = 180,
) {
  return {
    facts,
    items,
    requestedDays,
    pendingCount: 0,
    lastSyncedAt: '2026-08-24T12:00:00Z',
  };
}

describe('computeCoverage', () => {
  test('healthy full history is complete with no reasons', () => {
    const facts = factsFrom({
      transactions: [
        txn({ date: '2026-03-01' }),
        txn({ date: '2026-08-20', amount: -2600, role: 'earned_income', displayBucket: null }),
      ],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(coverage.band).toBe('complete');
    expect(coverage.reasons).toHaveLength(0);
  });

  test('short history is partial with LIMITED_HISTORY', () => {
    const facts = factsFrom({
      transactions: [txn({ date: '2026-07-01' }), txn({ date: '2026-08-20' })],
    });

    const coverage = computeCoverage(
      coverageInput(facts, [item({ historyDaysAvailable: 54 })]),
    );

    expect(coverage.band).toBe('partial');
    expect(coverage.reasons.map((reason) => reason.code)).toContain('LIMITED_HISTORY');
    expect(
      coverage.dimensions.history.perItem[0]!.status,
    ).toBe('limited');
  });

  test('under 30 observed days is insufficient', () => {
    const facts = factsFrom({
      transactions: [txn({ date: '2026-08-10' }), txn({ date: '2026-08-20' })],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(coverage.band).toBe('insufficient');
  });

  test('a failed institution is partial with ITEM_FAILED', () => {
    const facts = factsFrom({
      transactions: [txn({ date: '2026-03-01' }), txn({ date: '2026-08-20' })],
    });

    const coverage = computeCoverage(
      coverageInput(facts, [
        item({}),
        item({
          itemRowId: 'item-2',
          institutionName: 'Amex',
          syncStatus: 'failed',
          usable: false,
        }),
      ]),
    );

    expect(coverage.band).toBe('partial');
    expect(coverage.reasons.map((reason) => reason.code)).toContain('ITEM_FAILED');
    expect(coverage.dimensions.accounts.failedItems).toBe(1);
  });

  test('no usable item is insufficient with NO_USABLE_ITEM', () => {
    const facts = factsFrom({});

    const coverage = computeCoverage(
      coverageInput(facts, [item({ syncStatus: 'failed', usable: false })]),
    );

    expect(coverage.band).toBe('insufficient');
    expect(coverage.reasons.map((reason) => reason.code)).toContain('NO_USABLE_ITEM');
  });

  test('large unlinked card payments produce UNLINKED_CARD_PAYMENT', () => {
    const facts = factsFrom({
      transactions: [
        txn({ amount: 3000, date: '2026-03-01' }),
        txn({ amount: 820, role: 'credit_card_payment', linked: false, date: '2026-08-01' }),
      ],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(coverage.reasons.map((reason) => reason.code)).toContain(
      'UNLINKED_CARD_PAYMENT',
    );
    // The message uses a real observed share, not an invented confidence.
    const reason = coverage.reasons.find((r) => r.code === 'UNLINKED_CARD_PAYMENT');
    expect(reason?.message).toMatch(/\d+% of observed cash outflow/);
  });

  test('coverage never exposes a bare percentage confidence field', () => {
    const facts = factsFrom({ transactions: [txn({ date: '2026-03-01' })] });
    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(JSON.stringify(coverage)).not.toMatch(/"confidence"\s*:\s*\d/);
    expect(coverage).not.toHaveProperty('percentage');
  });
});

describe('computeCoverage — currency', () => {
  const usd = (rowId: string, amount: number, isoCurrencyCode: string) => ({
    rowId,
    amount,
    date: '2026-08-01',
    pending: false,
    accountId: null,
    isoCurrencyCode,
    role: 'expense' as const,
    displayBucket: 'Shopping',
    accountType: 'depository',
    linked: false,
  });

  test('mixed currencies surface as a coverage reason', () => {
    const facts = factsFrom({
      transactions: [
        usd('t1', 100, 'USD'),
        usd('t2', 100, 'USD'),
        usd('t3', 80, 'EUR'),
      ],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(facts.currency.excludedTransactionCount).toBe(1);
    expect(coverage.reasons.map((r) => r.code)).toContain('MIXED_CURRENCY');
  });

  test('a single-currency user has no currency reason', () => {
    const facts = factsFrom({
      transactions: [usd('t1', 100, 'USD'), usd('t2', 100, 'USD')],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    expect(coverage.reasons.map((r) => r.code)).not.toContain('MIXED_CURRENCY');
  });
});

describe('generateReviewItems', () => {
  test('external card payment produces a required item with connect/accept actions', () => {
    const facts = factsFrom({
      transactions: [
        txn({ amount: 820, role: 'credit_card_payment', linked: false, date: '2026-06-01' }),
        txn({ amount: 820, role: 'credit_card_payment', linked: false, date: '2026-07-01' }),
      ],
    });
    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    const items = generateReviewItems({
      facts,
      coverage,
      items: [item({})],
      manualMonthlyIncome: null,
      externalCardPaymentDescription: 'AUTOPAY CARD PAYMENT',
    });

    const external = items.find(
      (entry) => entry.type === 'external_card_payment_unattributed',
    );

    expect(external).toBeDefined();
    expect(external!.required).toBe(true);
    expect(external!.allowedActions).toEqual([
      'connect_account',
      'accept_coverage_limitation',
    ]);
    expect(external!.evidence).toMatchObject({
      description: 'AUTOPAY CARD PAYMENT',
      totalObserved: 1640,
    });
  });

  test('a large single-hit low-confidence stream is surfaced even when it normalizes small', () => {
    const facts = factsFrom({
      streams: [
        {
          streamKey: 'outflow:oakridge hoa',
          direction: 'outflow',
          displayName: 'Oakridge HOA',
          cadence: 'annual',
          cadenceDays: 365,
          averageAmount: 500,
          lastAmount: 500,
          amountVariance: 0,
          confidence: 'low',
          lastDate: '2026-08-03',
          userStatus: 'detected',
          dominantRole: 'expense',
          anchorDayOfMonth: 3,
          dateJitterDays: 2,
          amountClass: 'fixed',
          planningAmount: 500,
          amounts: [500, 500],
        },
        {
          streamKey: 'outflow:small gym',
          direction: 'outflow',
          displayName: 'Small Gym',
          cadence: 'monthly',
          cadenceDays: 30.4,
          averageAmount: 30,
          lastAmount: 30,
          amountVariance: 0.3,
          confidence: 'low',
          lastDate: '2026-08-10',
          userStatus: 'detected',
          dominantRole: 'expense',
          anchorDayOfMonth: 10,
          dateJitterDays: 2,
          amountClass: 'variable',
          planningAmount: 30,
          amounts: [30, 30],
        },
      ],
    });
    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    const items = generateReviewItems({
      facts,
      coverage,
      items: [item({})],
      manualMonthlyIncome: null,
      externalCardPaymentDescription: null,
    });

    const keys = items
      .filter((entry) => entry.type === 'unconfirmed_recurring_stream')
      .map((entry) => entry.itemKey);

    // $500 once a year is ~$42/month — under the monthly bar, but exactly
    // the hit a plan must know about.
    expect(keys).toContain('stream:outflow:oakridge hoa');
    // $30/month at low confidence moves nothing; it stays off the review.
    expect(keys).not.toContain('stream:outflow:small gym');
  });

  test('material manual-vs-observed income conflict is a required item', () => {
    const facts = factsFrom({
      transactions: [
        txn({ amount: -2600, role: 'earned_income', date: '2026-07-01', displayBucket: null }),
        txn({ amount: -2600, role: 'earned_income', date: '2026-08-01', displayBucket: null }),
      ],
    });
    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    const items = generateReviewItems({
      facts,
      coverage,
      items: [item({})],
      manualMonthlyIncome: 9000,
      externalCardPaymentDescription: null,
    });

    const mismatch = items.find((entry) => entry.type === 'income_mismatch');

    expect(mismatch).toBeDefined();
    expect(mismatch!.required).toBe(true);
    expect(mismatch!.evidence).toMatchObject({ manualMonthlyIncome: 9000 });
  });

  test('close income agreement produces no mismatch item', () => {
    const facts = factsFrom({
      transactions: [
        txn({ amount: -5000, role: 'earned_income', date: '2026-07-01', displayBucket: null }),
      ],
    });
    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    const monthly = facts.income.monthlyIncomeEstimate;
    const items = generateReviewItems({
      facts,
      coverage,
      items: [item({})],
      manualMonthlyIncome: monthly * 1.1,
      externalCardPaymentDescription: null,
    });

    expect(items.find((entry) => entry.type === 'income_mismatch')).toBeUndefined();
  });

  test('failed institutions become required reconnect-or-accept items', () => {
    const facts = factsFrom({ transactions: [txn({ date: '2026-03-01' })] });
    const failedItem = item({
      itemRowId: 'item-2',
      institutionName: 'Amex',
      syncStatus: 'failed',
      usable: false,
      lastErrorCode: 'ITEM_LOGIN_REQUIRED',
    });
    const coverage = computeCoverage(coverageInput(facts, [item({}), failedItem]));

    const items = generateReviewItems({
      facts,
      coverage,
      items: [item({}), failedItem],
      manualMonthlyIncome: null,
      externalCardPaymentDescription: null,
    });

    const failed = items.find((entry) => entry.type === 'institution_connection_failed');

    expect(failed).toBeDefined();
    expect(failed!.itemKey).toBe('item_failed:item-2');
    expect(failed!.required).toBe(true);
  });

  test('limited history becomes an optional acceptance item', () => {
    const facts = factsFrom({
      transactions: [txn({ date: '2026-07-01' }), txn({ date: '2026-08-20' })],
    });
    const limited = item({ historyDaysAvailable: 54 });
    const coverage = computeCoverage(coverageInput(facts, [limited]));

    const items = generateReviewItems({
      facts,
      coverage,
      items: [limited],
      manualMonthlyIncome: null,
      externalCardPaymentDescription: null,
    });

    const entry = items.find((candidate) => candidate.type === 'limited_history');

    expect(entry).toBeDefined();
    expect(entry!.required).toBe(false);
  });
});

describe('generateReviewItems — high unknown activity', () => {
  const unknownTxn = (rowId: string, amount: number) => ({
    rowId,
    amount,
    date: '2026-08-01',
    pending: false,
    accountId: null,
    isoCurrencyCode: 'USD',
    role: 'unknown_outflow' as const,
    displayBucket: null,
    accountType: 'depository',
    linked: false,
  });

  test('the item carries actionable merchant keys and transaction samples', () => {
    // Regression: reclassify_transaction was never offered by any item, and
    // the evidence contained only totals — the client had nothing to
    // reference, so both reclassify paths were unreachable.
    const facts = factsFrom({
      transactions: [unknownTxn('u1', 400), unknownTxn('u2', 300)],
    });

    const coverage = computeCoverage(coverageInput(facts, [item({})]));

    const generated = generateReviewItems({
      facts,
      coverage,
      items: [item({})],
      manualMonthlyIncome: null,
      externalCardPaymentDescription: null,
      unknownActivity: {
        topMerchants: [
          { merchantKey: 'venmo', displayName: 'Venmo', total: 700, count: 2 },
        ],
        sampleTransactions: [
          { transactionRowId: 'u1', displayName: 'VENMO PAYMENT', amount: 400, date: '2026-08-01' },
        ],
      },
    });

    const unknownItem = generated.find((g) => g.type === 'high_unknown_activity');

    expect(unknownItem).toBeDefined();
    expect(unknownItem!.allowedActions).toEqual(
      expect.arrayContaining(['reclassify_merchant', 'reclassify_transaction']),
    );

    const evidence = unknownItem!.evidence as {
      topMerchants: unknown[];
      sampleTransactions: unknown[];
    };

    expect(evidence.topMerchants).toHaveLength(1);
    expect(evidence.sampleTransactions).toHaveLength(1);
  });
});

describe('buildFinancialReview job', () => {
  function buildDeps(runStatus: string) {
    const snapshots: unknown[][] = [];
    const itemUpserts: unknown[][] = [];
    const prunes: unknown[][] = [];
    const transitions: string[] = [];
    const readyHooks: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        if (text.includes('INSERT INTO financial_fact_snapshots')) {
          snapshots.push(values);
          return {
            rows: [{ id: 'snap-1', version: 1, created_at: new Date() } as R],
            rowCount: 1,
          };
        }

        if (text.includes('INSERT INTO financial_review_items')) {
          itemUpserts.push(values);
          return { rows: [] as R[], rowCount: 1 };
        }

        if (text.includes('DELETE FROM financial_review_items')) {
          prunes.push(values);
          return { rows: [] as R[], rowCount: 0 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 60)}`);
      },
    };

    const deps: ReviewBuildDeps = {
      db,
      loadData: async () => ({
        transactions: [
          txn({ date: '2026-03-01', amount: 100 }),
          txn({ amount: 820, role: 'credit_card_payment', linked: false, date: '2026-07-01' }),
        ],
        accounts: [],
        streams: [],
        declaredObligations: [],
      }),
      getItems: async () => [item({})],
      getRun: async () => ({
        status: runStatus,
        requestedLookbackDays: 180,
        startedAt: '2026-08-24T10:00:00Z',
      }),
      getManualMonthlyIncome: async () => null,
      getUnknownActivity: async () => ({
        topMerchants: [],
        sampleTransactions: [],
      }),
      transitionRun: async (_runId, to) => {
        transitions.push(to);
      },
      onReviewReady: async (payload) => {
        readyHooks.push(payload);
      },
      now: () => new Date('2026-08-24T12:00:00Z'),
    };

    return { deps, snapshots, itemUpserts, prunes, transitions, readyHooks };
  }

  test('writes one snapshot, upserts items, prunes stale, marks reviewable', async () => {
    const { deps, snapshots, itemUpserts, prunes, transitions, readyHooks } =
      buildDeps('processing');

    const result = await buildFinancialReview(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(result.snapshotVersion).toBe(1);
    expect(snapshots).toHaveLength(1);
    expect(itemUpserts.length).toBeGreaterThan(0);
    expect(prunes).toHaveLength(1);
    expect(transitions).toEqual(['review_ready']);
    expect(readyHooks).toHaveLength(1);
  });

  test('freshness reports the newest real sync time, not the build clock', async () => {
    // Regression: lastSyncedAt was stamped deps.now(), so the review always
    // looked freshly synced no matter how stale the data was.
    const { deps, snapshots } = buildDeps('processing');
    deps.getItems = async () => [
      item({ lastSyncedAt: '2026-08-20T08:00:00.000Z' }),
      item({ itemRowId: 'b', lastSyncedAt: '2026-08-22T09:30:00.000Z' }),
    ];

    await buildFinancialReview({ userId: 'user-1', analysisRunId: 'run-1' }, deps);

    const coverage = JSON.parse(String(snapshots[0]![3])) as {
      dimensions: { freshness: { lastSyncedAt: string | null } };
    };

    expect(coverage.dimensions.freshness.lastSyncedAt).toBe(
      '2026-08-22T09:30:00.000Z',
    );
  });

  test('replay against an already-reviewable run is a no-op', async () => {
    const { deps, snapshots, transitions } = buildDeps('review_ready');

    const result = await buildFinancialReview(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(result.snapshotVersion).toBe(0);
    expect(snapshots).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  test('review item upsert preserves user resolution status', async () => {
    const { deps } = buildDeps('processing');
    // Contract check on SQL text: status is not part of the DO UPDATE set.
    const originalQuery = deps.db.query.bind(deps.db);
    deps.db.query = async (text: string, values?: unknown[]) => {
      if (text.includes('INSERT INTO financial_review_items')) {
        expect(text).toContain('ON CONFLICT (analysis_run_id, item_key) DO UPDATE');
        expect(text).not.toContain('status = EXCLUDED');
      }
      return originalQuery(text, values);
    };

    await buildFinancialReview({ userId: 'user-1', analysisRunId: 'run-1' }, deps);
  });
});
