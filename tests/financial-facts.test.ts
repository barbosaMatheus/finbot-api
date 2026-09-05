import { describe, expect, jest, test } from '@jest/globals';

import {
  buildFinancialFacts,
  computeFinancialFacts,
  summarizeBalances,
  type FactsData,
  type FactsJobDeps,
} from '../src/services/financial-facts.service.js';
import type {
  AccountBalance,
  FactsRecurringStream,
  FactsTransaction,
} from '../src/types/financial-facts.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

const THROUGH = '2026-08-24';

let counter = 0;

function txn(overrides: Partial<FactsTransaction>): FactsTransaction {
  counter += 1;
  return {
    rowId: `row-${counter}`,
    amount: 100,
    date: '2026-08-01',
    pending: false,
    accountId: null,
    isoCurrencyCode: 'USD',
    role: 'expense',
    displayBucket: 'Shopping',
    accountType: 'depository',
    linked: false,
    ...overrides,
  };
}

function stream(overrides: Partial<FactsRecurringStream>): FactsRecurringStream {
  return {
    streamKey: 'inflow:acme payroll',
    direction: 'inflow',
    displayName: 'ACME Payroll',
    cadence: 'biweekly',
    cadenceDays: 14,
    averageAmount: 2600,
    lastAmount: 2600,
    amountVariance: 0.01,
    confidence: 'high',
    lastDate: '2026-08-20',
    userStatus: 'detected',
    dominantRole: 'earned_income',
    anchorDayOfMonth: null,
    dateJitterDays: 2,
    amountClass: 'fixed',
    planningAmount: null,
    amounts: [],
    ...overrides,
  };
}

function data(overrides: Partial<FactsData> = {}): FactsData {
  return {
    transactions: [],
    accounts: [],
    streams: [],
    declaredObligations: [],
    ...overrides,
  };
}

describe('computeFinancialFacts', () => {
  test('card purchase and its matched checking payment count exactly once', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          // The purchase: economic spend on the card.
          txn({ amount: 500, role: 'expense', accountType: 'credit', displayBucket: 'Shopping' }),
          // The payment pair, linked by reconciliation: pure movement.
          txn({ amount: 500, role: 'credit_card_payment', linked: true }),
          txn({ amount: -500, role: 'credit_card_payment', accountType: 'credit', linked: true }),
        ],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(500);
    expect(facts.movement.linkedCardPaymentTotal).toBe(500);
    expect(facts.movement.externalCardPaymentTotal).toBe(0);
    // Income never appears from the card-side credit.
    expect(facts.income.totalObservedIncome).toBe(0);
  });

  test('unlinked card payment is a cash obligation, not spend', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [txn({ amount: 820, role: 'credit_card_payment', linked: false })],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(0);
    expect(facts.movement.externalCardPaymentTotal).toBe(820);
    expect(
      facts.cashObligations.components.externalCardPaymentsMonthly,
    ).toBeGreaterThan(0);
  });

  test('refunds net against gross spend at the total level', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 500, role: 'expense' }),
          txn({ amount: -500, role: 'refund_or_credit' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(500);
    expect(facts.spend.refundsAndCredits).toBe(500);
    expect(facts.spend.netEconomicSpend).toBe(0);
    expect(facts.spend.averageMonthlyEconomicSpend).toBe(0);
  });

  test('income estimate prefers recurring streams over observed average', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [txn({ amount: -2600, role: 'earned_income', date: '2026-08-20' })],
        streams: [stream({})],
      }),
      THROUGH,
    );

    expect(facts.income.estimateSource).toBe('recurring_streams');
    // 2600 every 14 days ≈ 5653/month.
    expect(facts.income.monthlyIncomeEstimate).toBeCloseTo(2600 * (30.44 / 14), 0);
  });

  test('without streams, income falls back to the observed monthly average', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: -2600, role: 'earned_income', date: '2026-07-01' }),
          txn({ amount: -2600, role: 'earned_income', date: '2026-08-01' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.income.estimateSource).toBe('observed_average');
    expect(facts.income.monthlyIncomeEstimate).toBeGreaterThan(0);
  });

  test('dismissed streams are excluded from estimates', () => {
    const facts = computeFinancialFacts(
      data({ streams: [stream({ userStatus: 'dismissed' })] }),
      THROUGH,
    );

    expect(facts.income.incomeStreams).toHaveLength(0);
    expect(facts.income.estimateSource).toBe('none');
  });

  test('transfers and savings are movement, never spend or income', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 400, role: 'savings_or_investment_transfer' }),
          txn({ amount: 250, role: 'internal_transfer' }),
          txn({ amount: -250, role: 'internal_transfer' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(0);
    expect(facts.income.totalObservedIncome).toBe(0);
    expect(facts.movement.savingsTransferTotal).toBe(400);
    expect(facts.movement.internalTransferTotal).toBe(250);
  });

  test('monthly normalization uses the observed window', () => {
    // ~six months of history: 100/month spend.
    const transactions = [0, 1, 2, 3, 4, 5].map((month) =>
      txn({
        amount: 100,
        role: 'expense',
        date: `2026-0${3 + month}-01`.slice(0, 10),
      }),
    );

    const facts = computeFinancialFacts(data({ transactions }), THROUGH);

    expect(facts.period.oldestObservedDate).toBe('2026-03-01');
    expect(facts.spend.averageMonthlyEconomicSpend).toBeGreaterThan(80);
    expect(facts.spend.averageMonthlyEconomicSpend).toBeLessThan(120);
  });

  test('spend normalizes over the trailing six months; coverage still reports the full history', () => {
    // 24 months of $100/month, then the last six months at $300/month. Two
    // years are pulled for long-cadence bill detection; "what you spend
    // now" must read ~300, not the two-year ~150.
    const transactions: FactsTransaction[] = [];

    for (let i = 0; i < 24; i += 1) {
      const date = new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10);
      transactions.push(txn({ amount: i >= 18 ? 300 : 100, role: 'expense', date }));
    }

    const facts = computeFinancialFacts(data({ transactions }), THROUGH);

    expect(facts.period.oldestObservedDate).toBe('2024-09-01');
    expect(facts.period.observedDays).toBeGreaterThan(700);
    expect(facts.period.spendWindowDays).toBe(182);
    expect(facts.period.spendWindowStart).toBe('2026-02-24');
    expect(facts.spend.averageMonthlyEconomicSpend).toBeGreaterThan(270);
    expect(facts.spend.averageMonthlyEconomicSpend).toBeLessThan(330);
    // The window clips totals too: six in-window postings, not 24.
    expect(facts.spend.categoryTotals[0]?.transactionCount).toBe(6);
  });

  test('history shorter than the spend window reports its own length', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 100, role: 'expense', date: '2026-06-01' }),
          txn({ amount: 100, role: 'expense', date: '2026-08-01' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.period.observedDays).toBe(85);
    expect(facts.period.spendWindowDays).toBe(85);
    expect(facts.period.spendWindowStart).toBe('2026-06-01');
  });

  test('declared off-book obligations join cash obligations; one-time amounts are surfaced, not smeared', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [txn({ amount: 100, role: 'expense', date: '2026-08-01' })],
        declaredObligations: [
          { kind: 'rent_to_person', label: null, amount: 500, cadence: 'monthly' },
          { kind: 'family_loan', label: null, amount: 50, cadence: 'weekly' },
          { kind: 'other', label: 'ER bill', amount: 1200, cadence: 'one_time' },
        ],
      }),
      THROUGH,
    );

    // 500 + 50 × 52/12 = 716.67; the one-time $1,200 stays out of the monthly figure.
    expect(facts.cashObligations.components.declaredObligationsMonthly).toBe(716.67);
    expect(facts.cashObligations.averageMonthlyCashObligations).toBeCloseTo(
      facts.cashObligations.components.netEconomicSpendMonthly + 716.67,
      1,
    );
    expect(facts.cashObligations.declaredOneTime).toEqual({ total: 1200, count: 1 });
  });

  test('no declared obligations contributes nothing', () => {
    const facts = computeFinancialFacts(data(), THROUGH);

    expect(facts.cashObligations.components.declaredObligationsMonthly).toBe(0);
    expect(facts.cashObligations.declaredOneTime).toEqual({ total: 0, count: 0 });
  });

  test('short windows are floored to ~one month to avoid wild extrapolation', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [txn({ amount: 300, role: 'expense', date: '2026-08-23' })],
      }),
      THROUGH,
    );

    // Two days of data must not become 300 * 15 = 4500/month.
    expect(facts.spend.averageMonthlyEconomicSpend).toBeLessThanOrEqual(330);
  });

  test('balances flow through the existing summarizeBalances', () => {
    const facts = computeFinancialFacts(
      data({
        accounts: [
          {
            accountId: 'a',
            name: 'Checking',
            type: 'depository',
            currentBalance: 3000,
            availableBalance: 2800,
          },
          {
            accountId: 'b',
            name: 'Card',
            type: 'credit',
            currentBalance: 900,
            availableBalance: null,
          },
        ],
      }),
      THROUGH,
    );

    expect(facts.balances.totalAssets).toBe(3000);
    expect(facts.balances.totalLiabilities).toBe(900);
    expect(facts.balances.availableToSpend).toBe(2800);
    expect(facts.balances.netPosition).toBe(2100);
  });

  test('unknown share of outflow is explicit', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 300, role: 'expense' }),
          txn({ amount: 100, role: 'unknown_outflow' }),
          txn({ amount: -50, role: 'unknown_inflow' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.unknowns.unknownOutflowTotal).toBe(100);
    expect(facts.unknowns.unknownInflowTotal).toBe(50);
    expect(facts.unknowns.unknownShareOfOutflow).toBe(0.25);
  });

  test('pending transactions are excluded everywhere', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 100, role: 'expense', pending: true }),
          txn({ amount: -2000, role: 'earned_income', pending: true }),
        ],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(0);
    expect(facts.income.totalObservedIncome).toBe(0);
    expect(facts.period.oldestObservedDate).toBeNull();
  });

  test('same input produces identical output (reproducible)', () => {
    const input = data({
      transactions: [
        txn({ amount: 120.55, role: 'expense', displayBucket: 'Food & Drink' }),
        txn({ amount: -2600, role: 'earned_income' }),
      ],
      streams: [stream({})],
    });

    const first = computeFinancialFacts(input, THROUGH);
    const second = computeFinancialFacts(input, THROUGH);

    expect(second).toEqual(first);
  });

  // --- Phase-3 money-math regressions --------------------------------------

  test('an ended payroll stream no longer counts as income (job change)', () => {
    // Old employer paid biweekly through May; new employer pays monthly.
    // Summing both used to report ~2x real income.
    const facts = computeFinancialFacts(
      data({
        transactions: [txn({ amount: -4000, role: 'earned_income', date: '2026-08-15' })],
        streams: [
          stream({
            streamKey: 'inflow:old employer',
            displayName: 'Old Employer',
            lastDate: '2026-05-10',
          }),
          stream({
            streamKey: 'inflow:new employer',
            displayName: 'New Employer',
            cadence: 'monthly',
            cadenceDays: 30.4,
            averageAmount: 4000,
            lastDate: '2026-08-15',
          }),
        ],
      }),
      THROUGH,
    );

    expect(facts.income.incomeStreams).toHaveLength(1);
    expect(facts.income.incomeStreams[0]?.displayName).toBe('New Employer');
    expect(facts.income.monthlyIncomeEstimate).toBeCloseTo(4000 * (30.44 / 30.4), 0);
  });

  test('a cancelled subscription stops appearing in recurring outflows', () => {
    const facts = computeFinancialFacts(
      data({
        streams: [
          stream({
            streamKey: 'outflow:oldgym',
            direction: 'outflow',
            displayName: 'Old Gym',
            cadence: 'monthly',
            cadenceDays: 30.4,
            averageAmount: 60,
            dominantRole: 'expense',
            lastDate: '2026-04-01',
          }),
          stream({
            streamKey: 'outflow:netflix',
            direction: 'outflow',
            displayName: 'Netflix',
            cadence: 'monthly',
            cadenceDays: 30.4,
            averageAmount: 22.99,
            dominantRole: 'expense',
            lastDate: '2026-08-12',
          }),
        ],
      }),
      THROUGH,
    );

    expect(facts.recurring.outflows.map((s) => s.displayName)).toEqual(['Netflix']);
  });

  test('recurring outflows carry the planning fields and the observed range', () => {
    // Gameplan step 1: what the review shows is what the plan will reserve.
    const facts = computeFinancialFacts(
      data({
        streams: [
          stream({
            streamKey: 'outflow:city power',
            direction: 'outflow',
            displayName: 'City Power',
            cadence: 'monthly',
            cadenceDays: 30.4,
            averageAmount: 118,
            lastAmount: 132,
            amountVariance: 0.21,
            dominantRole: 'expense',
            lastDate: '2026-08-12',
            anchorDayOfMonth: 12,
            dateJitterDays: 3,
            amountClass: 'variable',
            planningAmount: 140,
            amounts: [90, 140, 120, 132],
          }),
          stream({
            streamKey: 'outflow:amazon',
            direction: 'outflow',
            displayName: 'Amazon',
            cadence: 'irregular',
            cadenceDays: 23,
            averageAmount: 63.5,
            lastAmount: 65,
            amountVariance: 0.9,
            dominantRole: 'expense',
            lastDate: '2026-08-11',
            anchorDayOfMonth: null,
            dateJitterDays: 14,
            amountClass: 'erratic',
            planningAmount: null,
            amounts: [23, 154, 12, 65],
          }),
        ],
      }),
      THROUGH,
    );

    const [power, amazon] = facts.recurring.outflows;

    expect(power).toMatchObject({
      cadenceDays: 30.4,
      lastAmount: 132,
      amountClass: 'variable',
      planningAmount: 140,
      amountRange: { low: 90, high: 140 },
      anchorDayOfMonth: 12,
      dateJitterDays: 3,
    });
    // Erratic: the range is still informative, but nothing is reserved.
    expect(amazon).toMatchObject({
      amountClass: 'erratic',
      planningAmount: null,
      amountRange: { low: 12, high: 154 },
      anchorDayOfMonth: null,
    });
  });

  test('a stream the detector has not refreshed reads as unknown, never invented', () => {
    const facts = computeFinancialFacts(
      data({
        streams: [
          stream({
            streamKey: 'outflow:legacy',
            direction: 'outflow',
            displayName: 'Legacy Row',
            cadence: 'monthly',
            cadenceDays: 30.4,
            averageAmount: 40,
            lastAmount: 40,
            dominantRole: 'expense',
            lastDate: '2026-08-12',
            anchorDayOfMonth: null,
            dateJitterDays: null,
            amountClass: null,
            planningAmount: null,
            amounts: [],
          }),
        ],
      }),
      THROUGH,
    );

    expect(facts.recurring.outflows[0]).toMatchObject({
      amountClass: null,
      planningAmount: null,
      amountRange: null,
      anchorDayOfMonth: null,
      dateJitterDays: null,
    });
  });

  test('a recurring unknown_inflow stream never becomes income by itself', () => {
    // A roommate's regular Zelle deposit: classification refused to call it
    // income, and recurrence must not promote it through the back door.
    const facts = computeFinancialFacts(
      data({
        streams: [
          stream({
            streamKey: 'inflow:zelle roommate',
            displayName: 'Zelle Roommate',
            averageAmount: 900,
            dominantRole: 'unknown_inflow',
          }),
        ],
      }),
      THROUGH,
    );

    expect(facts.income.incomeStreams).toHaveLength(0);
    expect(facts.income.estimateSource).toBe('none');
  });

  test('a user-confirmed inflow stream counts as income regardless of role', () => {
    // The gig-worker escape hatch: explicit confirmation outranks the
    // classifier's refusal.
    const facts = computeFinancialFacts(
      data({
        streams: [
          stream({
            streamKey: 'inflow:zelle client',
            displayName: 'Zelle Client',
            averageAmount: 900,
            dominantRole: 'unknown_inflow',
            userStatus: 'confirmed',
          }),
        ],
      }),
      THROUGH,
    );

    expect(facts.income.incomeStreams).toHaveLength(1);
    expect(facts.income.estimateSource).toBe('recurring_streams');
  });

  test('accounts with unequal history depth normalize independently', () => {
    // 180 days of checking at $600/mo plus a card connected 30 days ago
    // with $900 of spend. One global window used to read the card as
    // ~$150/mo instead of ~$900/mo.
    const transactions = [
      txn({ amount: 600, accountId: 'checking', date: '2026-03-01' }),
      txn({ amount: 600, accountId: 'checking', date: '2026-05-15' }),
      txn({ amount: 600, accountId: 'checking', date: '2026-08-01' }),
      txn({ amount: 900, accountId: 'card', accountType: 'credit', date: '2026-08-10' }),
    ];

    const facts = computeFinancialFacts(data({ transactions }), THROUGH);

    // Checking: 1800 over ~5.8 months ≈ 310/mo. Card: 900 over the 28-day
    // floor ≈ 978/mo. The combined figure must be near their sum, not the
    // ~460/mo a global window would produce.
    expect(facts.spend.averageMonthlyEconomicSpend).toBeGreaterThan(1200);
    expect(facts.spend.averageMonthlyEconomicSpend).toBeLessThan(1350);
  });

  test('mixed currencies are excluded and reported, never summed', () => {
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: 100, isoCurrencyCode: 'USD' }),
          txn({ amount: 100, isoCurrencyCode: 'USD' }),
          txn({ amount: 250, isoCurrencyCode: 'CAD' }),
        ],
        accounts: [
          {
            accountId: 'us-1',
            name: 'US Checking',
            type: 'depository',
            currentBalance: 5000,
            availableBalance: 5000,
            isoCurrencyCode: 'USD',
          },
          {
            accountId: 'ca-1',
            name: 'CA Checking',
            type: 'depository',
            currentBalance: 3000,
            availableBalance: 3000,
            isoCurrencyCode: 'CAD',
          },
        ],
      }),
      THROUGH,
    );

    expect(facts.currency.primary).toBe('USD');
    expect(facts.currency.excludedTransactionCount).toBe(1);
    expect(facts.currency.excludedCurrencies).toEqual(['CAD']);
    expect(facts.spend.grossEconomicSpend).toBe(200);
    // Balances too: 3000 CAD must not inflate USD assets.
    expect(facts.balances.totalAssets).toBe(5000);
  });

  test('unmatched card payment stops inflating obligations once a card is connected', () => {
    const withCard = computeFinancialFacts(
      data({
        transactions: [txn({ amount: 820, role: 'credit_card_payment', linked: false })],
        accounts: [
          {
            accountId: 'card-1',
            name: 'Card',
            type: 'credit',
            currentBalance: 500,
            availableBalance: null,
            isoCurrencyCode: 'USD',
          },
        ],
      }),
      THROUGH,
    );

    // The card's purchases are already in netSpend; counting its payment
    // again used to overstate obligations by the full payment amount.
    expect(withCard.cashObligations.components.externalCardPaymentsMonthly).toBe(0);
    expect(withCard.cashObligations.averageMonthlyCashObligations).toBe(0);
    // Still observable as movement so the review can surface it.
    expect(withCard.movement.externalCardPaymentTotal).toBe(820);

    const withoutCard = computeFinancialFacts(
      data({
        transactions: [txn({ amount: 820, role: 'credit_card_payment', linked: false })],
      }),
      THROUGH,
    );

    expect(
      withoutCard.cashObligations.components.externalCardPaymentsMonthly,
    ).toBeGreaterThan(0);
  });

  test('a role contradicting the amount sign lands in unknowns, not nowhere', () => {
    // e.g. a merchant override calling an inflow 'expense' used to delete
    // the transaction from every total simultaneously.
    const facts = computeFinancialFacts(
      data({
        transactions: [
          txn({ amount: -300, role: 'expense' }),
          txn({ amount: 300, role: 'earned_income' }),
        ],
      }),
      THROUGH,
    );

    expect(facts.spend.grossEconomicSpend).toBe(0);
    expect(facts.income.totalObservedIncome).toBe(0);
    expect(facts.unknowns.unknownInflowTotal).toBe(300);
    expect(facts.unknowns.unknownOutflowTotal).toBe(300);
  });
});

describe('buildFinancialFacts job', () => {
  test('computes facts from loaded data and chains the review build', async () => {
    const chained: unknown[] = [];

    const deps: FactsJobDeps = {
      db: { query: async () => ({ rows: [], rowCount: 0 }) },
      loadData: async () =>
        data({ transactions: [txn({ amount: 100, role: 'expense' })] }),
      enqueueNextStage: async (payload) => {
        chained.push(payload);
        return null;
      },
      now: () => new Date('2026-08-24T12:00:00Z'),
    };

    const facts = await buildFinancialFacts(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(facts.period.throughDate).toBe('2026-08-24');
    expect(chained).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });
});

describe('summarizeBalances', () => {
  const accounts: AccountBalance[] = [
    { accountId: 'a', name: 'Checking', type: 'depository', currentBalance: 1500, availableBalance: 1420 },
    { accountId: 'b', name: 'Savings', type: 'depository', currentBalance: 5000, availableBalance: 5000 },
    { accountId: 'c', name: 'Visa', type: 'credit', currentBalance: 800, availableBalance: null },
  ];

  test('counts credit balances as liabilities, never as assets', () => {
    const summary = summarizeBalances(accounts);

    expect(summary.totalAssets).toBe(6500);
    expect(summary.totalLiabilities).toBe(800);
    expect(summary.netPosition).toBe(5700);
  });

  test('prefers available balance over current for spendable money', () => {
    // 1420 available on checking, not 1500 — the difference is already spent.
    expect(summarizeBalances(accounts).availableToSpend).toBe(6420);
  });

  test('falls back to current balance when available is missing', () => {
    expect(
      summarizeBalances([
        { accountId: 'a', name: 'Checking', type: 'depository', currentBalance: 300, availableBalance: null },
      ]).availableToSpend,
    ).toBe(300);
  });

  test('handles no accounts', () => {
    expect(summarizeBalances([])).toEqual({
      totalAssets: 0,
      totalLiabilities: 0,
      netPosition: 0,
      availableToSpend: 0,
      accountCount: 0,
    });
  });
});
