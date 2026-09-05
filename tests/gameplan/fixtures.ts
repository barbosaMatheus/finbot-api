/**
 * Fixtures for the gameplan engine tests. `samInput()` is the walkthrough
 * from the team design page: Sam, $2,200 biweekly, balanced pace, building
 * a cushion — shelf $1,472, free cash $448, transfer $112, eating-out cap
 * $136 from a $170 period average.
 */

import type { ShortlistInput } from '../../src/gameplan/types.js';
import type {
  CategoryTotal,
  FactsRecurringStream,
  FinancialFacts,
} from '../../src/types/financial-facts.js';

/** 14-day period ÷ 30.44 days per month. */
const PERIOD_FACTOR = 14 / 30.44;

export function category(
  bucket: string,
  monthlyAverage: number,
  overrides: Partial<CategoryTotal> = {},
): CategoryTotal {
  const total = overrides.total ?? Math.round(monthlyAverage * 5.98 * 100) / 100;
  return {
    bucket,
    total,
    monthlyAverage,
    share: 0,
    transactionCount: overrides.transactionCount ?? 10,
    ...overrides,
  };
}

/** A monthly figure that scales to exactly `periodAmount` over 14 days after rounding to cents. */
export function monthlyForPeriod(periodAmount: number): number {
  return Math.round((periodAmount / PERIOD_FACTOR) * 100) / 100;
}

export function facts(overrides: {
  categoryTotals?: CategoryTotal[];
  availableToSpend?: number;
  totalLiabilities?: number;
  accountCount?: number;
  monthlyIncomeEstimate?: number;
  unknownOutflowTotal?: number;
  unknownShareOfOutflow?: number;
  spendWindowDays?: number;
} = {}): FinancialFacts {
  const categoryTotals = overrides.categoryTotals ?? [];
  const gross = categoryTotals.reduce((sum, entry) => sum + entry.total, 0);
  const availableToSpend = overrides.availableToSpend ?? 2900;
  const totalLiabilities = overrides.totalLiabilities ?? 0;

  return {
    ruleVersion: 'facts-v4',
    period: {
      oldestObservedDate: '2024-09-25',
      throughDate: '2026-09-25',
      observedDays: 730,
      spendWindowDays: overrides.spendWindowDays ?? 182,
      spendWindowStart: '2026-03-27',
      normalizationMonths: 5.98,
    },
    currency: { primary: 'USD', excludedTransactionCount: 0, excludedCurrencies: [] },
    income: {
      monthlyIncomeEstimate: overrides.monthlyIncomeEstimate ?? 4766,
      estimateSource: 'recurring_streams',
      totalObservedIncome: 28600,
      incomeStreams: [],
    },
    spend: {
      averageMonthlyEconomicSpend: gross / 5.98,
      grossEconomicSpend: gross,
      refundsAndCredits: 0,
      netEconomicSpend: gross,
      categoryTotals,
    },
    cashObligations: {
      averageMonthlyCashObligations: 0,
      components: {
        netEconomicSpendMonthly: 0,
        debtPaymentsMonthly: 0,
        externalCardPaymentsMonthly: 0,
        declaredObligationsMonthly: 0,
      },
      declaredOneTime: { total: 0, count: 0 },
    },
    balances: {
      totalAssets: availableToSpend,
      totalLiabilities,
      netPosition: availableToSpend - totalLiabilities,
      availableToSpend,
      accountCount: overrides.accountCount ?? 2,
    },
    recurring: { outflows: [] },
    movement: {
      internalTransferTotal: 0,
      linkedCardPaymentTotal: 0,
      savingsTransferTotal: 0,
      externalCardPaymentTotal: 0,
    },
    unknowns: {
      unknownOutflowTotal: overrides.unknownOutflowTotal ?? 30,
      unknownInflowTotal: 0,
      unknownShareOfOutflow: overrides.unknownShareOfOutflow ?? 0.01,
    },
  };
}

export function stream(overrides: Partial<FactsRecurringStream> = {}): FactsRecurringStream {
  return {
    streamKey: 'outflow:generic bill',
    direction: 'outflow',
    displayName: 'Generic Bill',
    cadence: 'monthly',
    cadenceDays: 30.4,
    averageAmount: 100,
    lastAmount: 100,
    amountVariance: 0,
    confidence: 'high',
    lastDate: '2026-09-10',
    userStatus: 'confirmed',
    dominantRole: 'expense',
    anchorDayOfMonth: 10,
    dateJitterDays: 2,
    amountClass: 'fixed',
    planningAmount: 100,
    amounts: [100, 100, 100],
    ...overrides,
  };
}

export const SAM_PERIOD = { start: '2026-09-25', end: '2026-10-08', trigger: 'payday' as const };

export function samStreams(): FactsRecurringStream[] {
  return [
    stream({
      streamKey: 'inflow:acme payroll',
      direction: 'inflow',
      displayName: 'ACME Payroll',
      cadence: 'biweekly',
      cadenceDays: 14,
      averageAmount: 2200,
      lastAmount: 2200,
      lastDate: '2026-09-25',
      dominantRole: 'earned_income',
      anchorDayOfMonth: null,
      planningAmount: null,
      amounts: [2200, 2200, 2200, 2200],
    }),
    stream({
      streamKey: 'outflow:oak street lofts',
      displayName: 'Oak Street Lofts',
      averageAmount: 1200,
      lastAmount: 1200,
      lastDate: '2026-09-01',
      anchorDayOfMonth: 1,
      planningAmount: 1200,
      amounts: [1200, 1200, 1200, 1200, 1200, 1200],
    }),
    stream({
      streamKey: 'outflow:city power',
      displayName: 'City Power',
      averageAmount: 118,
      lastAmount: 132,
      amountVariance: 0.21,
      lastDate: '2026-09-08',
      anchorDayOfMonth: 8,
      dateJitterDays: 3,
      amountClass: 'variable',
      planningAmount: 140,
      amounts: [90, 140, 120, 132],
    }),
    stream({
      streamKey: 'outflow:comcast',
      displayName: 'Comcast',
      averageAmount: 77,
      lastAmount: 77,
      lastDate: '2026-09-05',
      anchorDayOfMonth: 5,
      planningAmount: 77,
      amounts: [77, 77, 77],
    }),
    stream({
      streamKey: 'outflow:geico',
      displayName: 'GEICO',
      cadence: 'semiannual',
      cadenceDays: 182,
      averageAmount: 710,
      lastAmount: 712,
      amountVariance: 0.01,
      lastDate: '2026-09-14',
      anchorDayOfMonth: 14,
      dateJitterDays: 3,
      planningAmount: 712,
      amounts: [708, 712],
    }),
    stream({
      streamKey: 'outflow:netflix',
      displayName: 'Netflix',
      averageAmount: 15.49,
      lastAmount: 15.49,
      lastDate: '2026-09-15',
      anchorDayOfMonth: 15,
      planningAmount: 15.49,
      amounts: [15.49, 15.49, 15.49],
    }),
  ];
}

export function samFacts(): FinancialFacts {
  return facts({
    categoryTotals: [
      category('Groceries', monthlyForPeriod(180)),
      category('Fuel', monthlyForPeriod(60)),
      category('Transportation', monthlyForPeriod(40)),
      category('Eating Out', monthlyForPeriod(170), { transactionCount: 40 }),
      // Small frequent purchases: 65 in the window at $20 → 5 a period.
      category('Shopping', monthlyForPeriod(100), { total: 1300, transactionCount: 65 }),
      category('Housing & Utilities', 1400),
      category('Entertainment', monthlyForPeriod(30)),
    ],
    availableToSpend: 2900,
  });
}

export function inputFixture(overrides: Partial<ShortlistInput> = {}): ShortlistInput {
  return {
    facts: samFacts(),
    streams: samStreams(),
    declaredObligations: [],
    profile: {
      primaryGoal: 'build_cushion',
      secondaryGoals: [],
      coachingPace: 'balanced',
      sharedAccounts: false,
      goalDetail: null,
    },
    period: SAM_PERIOD,
    today: '2026-09-25',
    openingPaycheck: 2200,
    primaryIncomeStreamKey: 'inflow:acme payroll',
    firstPeriod: false,
    history: { moneyCommitOutcomes: [], missedCaps: [], discoveryPeriodsDone: 0 },
    accruedToDate: {},
    oneTimeCosts: [],
    billOverrides: {},
    relaxedBuckets: [],
    incomeAdjustment: 0,
    ...overrides,
  };
}

/** The walkthrough: Sam, $2,200 biweekly, balanced, building a cushion. */
export function samInput(): ShortlistInput {
  return inputFixture();
}
