/**
 * The eval harness's users: six profiles × facts that between them reach
 * the plan's main branches — the balanced plan, a fixed-day week with no
 * paycheck, the cash check, a dated goal, discovery, shared accounts. Each carries what happened in the
 * period (for the grade) and one heads-up (for the diff), and pins the
 * plan the engine must produce so a change in the numbers is caught
 * before a change in the words is measured.
 */

import type { Adjustment, PeriodActuals, ShortlistInput } from '../gameplan/types.js';
import { category, facts, inputFixture, monthlyForPeriod, samInput, samStreams } from './fixtures.js';

export type ScenarioExpectation = {
  planIds: string[];
  /** Cap or amount per plan target id. */
  amounts: Record<string, number>;
  freeCash: number;
  shelf: number;
  /** Plan-level reason codes that must be present. */
  reasons: string[];
};

export type Scenario = {
  id: string;
  title: string;
  input: ShortlistInput;
  actuals: PeriodActuals;
  adjustment: Adjustment;
  expected: ScenarioExpectation;
};

function actuals(overrides: Partial<PeriodActuals> = {}): PeriodActuals {
  return {
    spendByBucket: {},
    countByBucket: {},
    postedBills: [],
    largestSavingsTransfer: 0,
    largestDebtPayment: 0,
    balanceAtClose: null,
    awarenessCompleted: false,
    ...overrides,
  };
}

function adjustment(overrides: Partial<Adjustment>): Adjustment {
  return {
    kind: 'other',
    amount: null,
    affectedCategory: null,
    affectedStream: null,
    timing: null,
    text: '',
    ...overrides,
  };
}

/** Sam's bills as they posted: rent on time, electric $70 over, internet as expected. */
const samPostedBills = [
  { key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: false },
  { key: 'outflow:city power', amount: 210, date: '2026-10-07', feeOrOverdraft: false },
  { key: 'outflow:comcast', amount: 77, date: '2026-10-05', feeOrOverdraft: false },
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'sam',
    title: 'Sam — $2,200 biweekly, balanced, building a cushion (the team walkthrough)',
    input: samInput(),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 148, Shopping: 60 },
      countByBucket: { 'Eating Out': 4, Shopping: 3 },
      postedBills: samPostedBills,
      largestSavingsTransfer: 50,
      balanceAtClose: 400,
    }),
    adjustment: adjustment({ kind: 'spend_event', affectedCategory: 'Eating Out', text: "my sister's in town next weekend" }),
    expected: {
      planIds: ['savings_transfer', 'spend_cap:Eating Out', 'bill_readiness'],
      amounts: { savings_transfer: 112, 'spend_cap:Eating Out': 136, bill_readiness: 1472 },
      freeCash: 448,
      shelf: 1472,
      reasons: [],
    },
  },
  {
    id: 'fixed-day',
    title: 'A fixed-day week with no stable paycheck: income from the estimate, a light shelf',
    input: inputFixture({
      period: { start: '2026-10-04', end: '2026-10-10', trigger: 'fixed_day' },
      today: '2026-10-04',
      openingPaycheck: null,
      primaryIncomeStreamKey: null,
      streams: samStreams()
        .filter((entry) => entry.streamKey !== 'inflow:acme payroll')
        .map((entry) =>
          entry.streamKey === 'outflow:oak street lofts'
            ? { ...entry, lastDate: '2026-10-01' }
            : entry.streamKey === 'outflow:comcast'
              ? { ...entry, lastDate: '2026-10-05' }
              : entry,
        ),
      facts: { ...samInput().facts, income: { ...samInput().facts.income, monthlyIncomeEstimate: 3044 } },
    }),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 70 },
      postedBills: [{ key: 'outflow:city power', amount: 132, date: '2026-10-08', feeOrOverdraft: false }],
      largestSavingsTransfer: 0,
      balanceAtClose: 2900,
    }),
    adjustment: adjustment({ kind: 'cost', amount: 100, text: 'car repair, about $100' }),
    expected: {
      planIds: ['savings_transfer', 'spend_cap:Eating Out', 'bill_readiness'],
      amounts: { savings_transfer: 97, 'spend_cap:Eating Out': 68, bill_readiness: 171 },
      freeCash: 389,
      shelf: 171,
      reasons: [],
    },
  },
  {
    id: 'tight',
    title: 'Tight cash after payday: the cash check removes the savings target',
    input: inputFixture({
      facts: { ...samInput().facts, balances: { ...samInput().facts.balances, availableToSpend: 900 } },
    }),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 130 },
      postedBills: samPostedBills,
      balanceAtClose: 120,
    }),
    adjustment: adjustment({ kind: 'other', text: 'busy week' }),
    expected: {
      planIds: ['bill_readiness', 'spend_cap:Eating Out', 'spend_cap:Shopping'],
      amounts: { bill_readiness: 1472, 'spend_cap:Eating Out': 136, 'spend_cap:Shopping': 80 },
      freeCash: 448,
      shelf: 1472,
      reasons: ['tight_cash_check'],
    },
  },
  {
    id: 'save-for-specific',
    title: 'Saving $1,200 for a trip by the end of October',
    input: inputFixture({
      profile: {
        ...samInput().profile,
        primaryGoal: 'save_for_specific',
        goalDetail: { description: 'a trip', targetAmount: 1200, targetMonth: '2026-10' },
      },
    }),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 110 },
      postedBills: samPostedBills,
      largestSavingsTransfer: 400,
      balanceAtClose: 300,
    }),
    adjustment: adjustment({ kind: 'income_change', amount: -200, text: 'hours got cut, about $200 less' }),
    expected: {
      planIds: ['savings_transfer', 'spend_cap:Eating Out', 'bill_readiness'],
      amounts: { savings_transfer: 400, 'spend_cap:Eating Out': 136, bill_readiness: 1472 },
      freeCash: 448,
      shelf: 1472,
      reasons: [],
    },
  },
  {
    id: 'not-sure',
    title: '"Not sure": the discovery plan',
    input: inputFixture({ profile: { ...samInput().profile, primaryGoal: 'not_sure' } }),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 150 },
      postedBills: samPostedBills,
      balanceAtClose: 500,
      awarenessCompleted: true,
    }),
    adjustment: adjustment({ kind: 'cost', amount: null, text: 'car trouble' }),
    expected: {
      planIds: ['bill_readiness', 'awareness:biggest_purchases', 'spend_cap:Eating Out'],
      amounts: { bill_readiness: 1472, 'spend_cap:Eating Out': 136 },
      freeCash: 448,
      shelf: 1472,
      reasons: ['discovery_plan'],
    },
  },
  {
    id: 'shared',
    title: 'Shared accounts: caps carry the caveat and a miss reads softer',
    input: inputFixture({
      profile: { ...samInput().profile, sharedAccounts: true },
      facts: facts({
        categoryTotals: [
          ...samInput().facts.spend.categoryTotals.filter((entry) => entry.bucket !== 'Entertainment'),
          category('Entertainment', monthlyForPeriod(60)),
        ],
      }),
    }),
    actuals: actuals({
      spendByBucket: { 'Eating Out': 165 },
      postedBills: samPostedBills,
      largestSavingsTransfer: 112,
      balanceAtClose: 450,
    }),
    adjustment: adjustment({ kind: 'bill_change', affectedStream: 'outflow:city power', amount: 160, text: 'electric is going up to $160' }),
    expected: {
      planIds: ['savings_transfer', 'spend_cap:Eating Out', 'bill_readiness'],
      amounts: { savings_transfer: 112, 'spend_cap:Eating Out': 136, bill_readiness: 1472 },
      freeCash: 448,
      shelf: 1472,
      reasons: ['shared_accounts'],
    },
  },
];
