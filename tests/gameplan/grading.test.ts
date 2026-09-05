import { describe, expect, test } from '@jest/globals';

import { buildShortlist } from '../../src/gameplan/candidates.js';
import { gradePeriod, gradeTarget } from '../../src/gameplan/grading.js';
import type { PeriodActuals, TargetDefinition } from '../../src/gameplan/types.js';
import { samInput } from './fixtures.js';

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

const samPlan = buildShortlist(samInput()).plan.map((candidate) => candidate.definition);
const transfer = samPlan.find((target) => target.type === 'savings_transfer')!;
const cap = samPlan.find((target) => target.type === 'spend_cap')!;
const bills = samPlan.find((target) => target.type === 'bill_readiness')!;
const noOverrun = { billOverrunTotal: 0, overrunBills: [] };

describe('grade measures (§7, decision 7)', () => {
  test('spend cap: within → met, over by ≤ 10 % → close, beyond → missed, with the deciding numbers', () => {
    expect(gradeTarget(cap, actuals({ spendByBucket: { 'Eating Out': 120 } }), noOverrun)).toMatchObject({
      outcome: 'met',
      details: [{ code: 'within', measured: 120, threshold: 136 }],
    });
    expect(gradeTarget(cap, actuals({ spendByBucket: { 'Eating Out': 148 } }), noOverrun)).toMatchObject({
      outcome: 'close',
      details: [{ code: 'over_by', measured: 148, threshold: 136, overBy: 12, overByShare: 0.09 }],
    });
    expect(gradeTarget(cap, actuals({ spendByBucket: { 'Eating Out': 196 } }), noOverrun).outcome).toBe('missed');
    // No spend at all is within.
    expect(gradeTarget(cap, actuals(), noOverrun).outcome).toBe('met');
  });

  test('on shared accounts a cap miss reads as close unless the overage is large (§2)', () => {
    const shared: TargetDefinition = { ...cap, type: 'spend_cap', sharedAccounts: true };
    const softened = gradeTarget(shared, actuals({ spendByBucket: { 'Eating Out': 165 } }), noOverrun);
    expect(softened.outcome).toBe('close');
    expect(softened.details).toContainEqual({ code: 'shared_softened', overByShare: 0.21 });
    expect(gradeTarget(shared, actuals({ spendByBucket: { 'Eating Out': 196 } }), noOverrun).outcome).toBe('missed');
  });

  test('frequency cap: within → met, over by one → close, more → missed', () => {
    const frequency: TargetDefinition = { type: 'frequency_cap', bucket: 'Shopping', maxCount: 4, periodCount: 5, averageTicket: 20 };
    expect(gradeTarget(frequency, actuals({ countByBucket: { Shopping: 4 } }), noOverrun).outcome).toBe('met');
    expect(gradeTarget(frequency, actuals({ countByBucket: { Shopping: 5 } }), noOverrun).outcome).toBe('close');
    expect(gradeTarget(frequency, actuals({ countByBucket: { Shopping: 6 } }), noOverrun).outcome).toBe('missed');
  });

  test('money-commit: ≥ amount → met, ≥ 80 % → close, else missed', () => {
    expect(gradeTarget(transfer, actuals({ largestSavingsTransfer: 112 }), noOverrun).outcome).toBe('met');
    expect(gradeTarget(transfer, actuals({ largestSavingsTransfer: 90 }), noOverrun)).toMatchObject({
      outcome: 'close',
      details: [{ code: 'commit_short', measured: 90, threshold: 112, shortBy: 22 }],
    });
    expect(gradeTarget(transfer, actuals({ largestSavingsTransfer: 50 }), noOverrun).outcome).toBe('missed');
  });

  test('a money-commit short by no more than a bill overrun grades close and names the bill (§7)', () => {
    const result = gradeTarget(
      transfer,
      actuals({ largestSavingsTransfer: 50 }),
      { billOverrunTotal: 70, overrunBills: ['City Power'] },
    );
    expect(result.outcome).toBe('close');
    expect(result.details).toContainEqual({ code: 'bill_overrun_covered', shortBy: 62, overrun: 70, bills: ['City Power'] });

    // Short by more than the overrun is still a miss.
    expect(gradeTarget(transfer, actuals({ largestSavingsTransfer: 20 }), { billOverrunTotal: 70, overrunBills: ['City Power'] }).outcome).toBe('missed');
  });

  test('awareness: done or not', () => {
    const awareness: TargetDefinition = { type: 'awareness', kind: 'biggest_purchases', unknownAmount: null, unknownShare: null, count: 3, bills: null };
    expect(gradeTarget(awareness, actuals({ awarenessCompleted: true }), noOverrun).outcome).toBe('met');
    expect(gradeTarget(awareness, actuals(), noOverrun).outcome).toBe('missed');
  });
});

describe('bill readiness in the grade (§7, §10.4)', () => {
  test('every bill posted without a fee, balance covers the accrual share → met, each posting named', () => {
    const result = gradeTarget(
      bills,
      actuals({
        postedBills: [
          { key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: false },
          { key: 'outflow:city power', amount: 128, date: '2026-10-07', feeOrOverdraft: false },
          { key: 'outflow:comcast', amount: 77, date: '2026-10-05', feeOrOverdraft: false },
        ],
        balanceAtClose: 600,
      }),
      noOverrun,
    );

    expect(result.outcome).toBe('met');
    expect(result.details).toContainEqual({
      code: 'bill_posted',
      key: 'outflow:city power',
      displayName: 'City Power',
      amount: 128,
      planningAmount: 140,
    });
    // The insurance share is not a posting; the balance must still hold it.
    expect(result.details).toContainEqual({ code: 'balance_covers', balance: 600, remaining: 55 });
  });

  test('a fee or overdraft on any bill is a miss', () => {
    const result = gradeTarget(
      bills,
      actuals({
        postedBills: [{ key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: true }],
        balanceAtClose: 900,
      }),
      noOverrun,
    );
    expect(result.outcome).toBe('missed');
    expect(result.details).toContainEqual({ code: 'bill_fee', key: 'outflow:oak street lofts', displayName: 'Oak Street Lofts' });
  });

  test('a bill that never landed is neither met nor missed; the grade names it and its window', () => {
    const result = gradeTarget(bills, actuals(), noOverrun);
    expect(result.outcome).toBe('unresolved');
    expect(result.details).toContainEqual({
      code: 'bill_unresolved',
      key: 'outflow:city power',
      displayName: 'City Power',
      windowEnd: '2026-10-11',
    });
  });

  test('at close, a balance short of what remains on the shelf is a miss', () => {
    const result = gradeTarget(
      bills,
      actuals({
        postedBills: [{ key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: false }],
        balanceAtClose: 100,
      }),
      noOverrun,
    );
    expect(result.outcome).toBe('missed');
    expect(result.details).toContainEqual({ code: 'balance_short', balance: 100, remaining: 272 });
  });
});

describe('gradePeriod', () => {
  test('results are ordered met → close → unresolved → missed; overruns feed the commit rule', () => {
    const grade = gradePeriod(
      samPlan,
      actuals({
        spendByBucket: { 'Eating Out': 148 },
        postedBills: [
          { key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: false },
          { key: 'outflow:city power', amount: 210, date: '2026-10-07', feeOrOverdraft: false },
          { key: 'outflow:comcast', amount: 77, date: '2026-10-05', feeOrOverdraft: false },
        ],
        largestSavingsTransfer: 50,
        balanceAtClose: 400,
      }),
    );

    // Electric came in $70 over what was set aside; the transfer fell $62 short.
    expect(grade.billOverrunTotal).toBe(70);
    // Met first; ties keep the plan's own order (transfer, cap, bills).
    expect(grade.results.map((result) => [result.target.type, result.outcome])).toEqual([
      ['bill_readiness', 'met'],
      ['savings_transfer', 'close'],
      ['spend_cap', 'close'],
    ]);
    expect(grade.results[1]!.details).toContainEqual({
      code: 'bill_overrun_covered',
      shortBy: 62,
      overrun: 70,
      bills: ['City Power'],
    });
    expect(grade.moneyCommitOutcome).toBe('close');
    expect(grade.misses).toEqual([]);
  });

  test('misses are listed for "what got in the way?", and the commit outcome feeds the next pace', () => {
    const grade = gradePeriod(samPlan, actuals({ spendByBucket: { 'Eating Out': 240 }, largestSavingsTransfer: 0 }));

    expect(grade.results.map((result) => result.outcome)).toEqual(['unresolved', 'missed', 'missed']);
    expect(grade.moneyCommitOutcome).toBe('missed');
    expect(grade.misses.map((result) => result.target.type)).toEqual(['savings_transfer', 'spend_cap']);
  });
});
