import { describe, expect, jest, test } from '@jest/globals';

import { buildShortlist } from '../../src/gameplan/candidates.js';
import { gradePeriod } from '../../src/gameplan/grading.js';
import type { TargetDefinition } from '../../src/gameplan/types.js';
import { buildActuals, gradeThrough, type GradeTransaction } from '../../src/services/gameplan-grade.service.js';
import { detectPayday } from '../../src/services/gameplan-refresh.service.js';
import type { GameplanPeriod } from '../../src/services/gameplan-store.service.js';
import { silentAnchorStreak } from '../../src/services/gameplan-build.service.js';
import { SAM_PERIOD, samInput, samStreams, stream } from './fixtures.js';

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

let counter = 0;

function txn(overrides: Partial<GradeTransaction>): GradeTransaction {
  counter += 1;
  return {
    rowId: `row-${counter}`,
    amount: 20,
    date: '2026-09-28',
    pending: false,
    role: 'expense',
    displayBucket: 'Eating Out',
    merchantKey: 'cafe',
    merchantName: 'Cafe',
    accountId: 'acc-checking',
    accountType: 'depository',
    ...overrides,
  };
}

/** Sam's streams with the merchant keys the grade matches postings on. */
const streams = samStreams().map((entry) => ({
  ...entry,
  merchantKey: entry.streamKey.replace(/^(inflow|outflow):/, ''),
}));

const targets: TargetDefinition[] = buildShortlist({ ...samInput(), streams }).plan.map((c) => c.definition);

describe('buildActuals (§1 "measured by")', () => {
  test('spend and counts per bucket, bill postings with fee detection, the largest transfer and payment', () => {
    const transactions: GradeTransaction[] = [
      txn({ amount: 60, date: '2026-09-26' }),
      txn({ amount: 48, date: '2026-10-02' }),
      txn({ amount: 40, date: '2026-10-05', merchantKey: 'pizza', merchantName: 'Pizza' }),
      // Rent posts on the 1st, then an overdraft fee two days later on the same account.
      txn({ amount: 1200, date: '2026-10-01', displayBucket: 'Housing & Utilities', merchantKey: 'oak street lofts', merchantName: 'Oak Street Lofts' }),
      txn({ amount: 34, date: '2026-10-03', role: 'interest_or_fee', displayBucket: 'Fees & Interest', merchantKey: null, merchantName: 'OVERDRAFT FEE' }),
      // Electric posts high, no fee.
      txn({ amount: 210, date: '2026-10-07', displayBucket: 'Housing & Utilities', merchantKey: 'city power', merchantName: 'City Power' }),
      // A savings transfer and a card payment.
      txn({ amount: 112, date: '2026-09-26', role: 'savings_or_investment_transfer', displayBucket: null, merchantKey: 'transfer to savings' }),
      txn({ amount: 300, date: '2026-09-30', role: 'credit_card_payment', displayBucket: null, merchantKey: 'chase card payment' }),
      // Pending and out-of-range postings never count.
      txn({ amount: 500, date: '2026-10-06', pending: true }),
      txn({ amount: 90, date: '2026-10-09' }),
    ];

    const actuals = buildActuals({
      period: SAM_PERIOD,
      through: '2026-10-08',
      targets,
      transactions,
      streams,
      balanceAtClose: 640,
      awarenessCompleted: false,
    });

    expect(actuals.spendByBucket['Eating Out']).toBe(148);
    expect(actuals.countByBucket['Eating Out']).toBe(3);
    expect(actuals.largestSavingsTransfer).toBe(112);
    expect(actuals.largestDebtPayment).toBe(300);
    expect(actuals.balanceAtClose).toBe(640);
    expect(actuals.postedBills).toEqual([
      { key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: true },
      { key: 'outflow:city power', amount: 210, date: '2026-10-07', feeOrOverdraft: false },
    ]);

    // And the engine grades it: rent's fee is a miss; the transfer met; eating out close.
    const grade = gradePeriod(targets, actuals);
    expect(grade.results.map((r) => [r.target.type, r.outcome])).toEqual([
      ['savings_transfer', 'met'],
      ['spend_cap', 'close'],
      ['bill_readiness', 'missed'],
    ]);
    expect(grade.billOverrunTotal).toBe(70);
  });

  test('a bill stream a cap left out of its base is left out of the bucket’s spend too', () => {
    const netflix = stream({
      streamKey: 'outflow:netflix',
      displayName: 'Netflix',
      averageAmount: 15.49,
      lastAmount: 15.49,
      lastDate: '2026-09-15',
      anchorDayOfMonth: 15,
      planningAmount: 15.49,
      amounts: [15.49, 15.49, 15.49],
      dominantBucket: 'Entertainment',
      merchantKey: 'netflix',
    });
    const cap: TargetDefinition = {
      type: 'spend_cap',
      bucket: 'Entertainment',
      cap: 40,
      periodAverage: 50,
      bucketAverage: 57,
      billShare: 7,
      excludedBillStreams: ['outflow:netflix'],
      base: 50,
      reduction: 0.2,
      sharedAccounts: false,
    };

    const actuals = buildActuals({
      period: SAM_PERIOD,
      through: '2026-10-08',
      targets: [cap],
      transactions: [
        txn({ amount: 15.49, date: '2026-10-01', displayBucket: 'Entertainment', merchantKey: 'netflix' }),
        txn({ amount: 30, date: '2026-10-02', displayBucket: 'Entertainment', merchantKey: 'cinema' }),
      ],
      streams: [netflix],
      balanceAtClose: null,
      awarenessCompleted: false,
    });

    expect(actuals.spendByBucket['Entertainment']).toBe(30);
    expect(actuals.countByBucket['Entertainment']).toBe(1);
  });

  test('gradeThrough: the period end, today, or the day before a detected payday', () => {
    const period = { start: '2026-09-25', end: '2026-10-08' };
    expect(gradeThrough(period, { userId: 'u', periodId: 'p', kind: 'final', reason: 'schedule' }, '2026-10-11')).toBe('2026-10-08');
    expect(gradeThrough(period, { userId: 'u', periodId: 'p', kind: 'mid_period', reason: 'schedule' }, '2026-10-02')).toBe('2026-10-02');
    expect(
      gradeThrough(period, { userId: 'u', periodId: 'p', kind: 'final', reason: 'payday', paydayDate: '2026-10-07' }, '2026-10-07'),
    ).toBe('2026-10-06');
  });
});

describe('detectPayday (cadence note §2)', () => {
  const period = {
    id: 'p',
    userId: 'u',
    start: '2026-09-25',
    end: '2026-10-08',
    trigger: 'payday',
    anchorMode: 'payday',
    status: 'open',
    firstPeriod: false,
    openingPaycheck: 2200,
    primaryIncomeStreamKey: 'inflow:acme payroll',
    plan: null,
    planNarration: null,
    headsUp: { oneTimeCosts: [], billOverrides: {}, relaxedBuckets: [], incomeAdjustment: 0 },
    swapUsed: false,
    awarenessCompletedAt: null,
    anchorReadyAt: null,
    anchorOpenedAt: null,
    reminderSentAt: null,
    midPeriodGradedAt: null,
    closedAt: null,
    closeReason: null,
  } satisfies GameplanPeriod;

  const payroll = samStreams().find((entry) => entry.streamKey === 'inflow:acme payroll')!;

  test('a new posting on the primary stream after the period opened, near the usual amount, is a payday', () => {
    const landed = { ...payroll, lastDate: '2026-10-09', lastAmount: 2200 };
    expect(detectPayday(period, [landed], '2026-10-09')).toEqual({
      streamKey: 'inflow:acme payroll',
      date: '2026-10-09',
      amount: 2200,
    });
  });

  test('the opening paycheck, a bonus, a future-dated posting, and a fixed-day period never trigger', () => {
    expect(detectPayday(period, [payroll], '2026-10-01')).toBeNull();
    expect(detectPayday(period, [{ ...payroll, lastDate: '2026-10-02', lastAmount: 4000 }], '2026-10-02')).toBeNull();
    expect(detectPayday(period, [{ ...payroll, lastDate: '2026-10-09' }], '2026-10-08')).toBeNull();
    expect(detectPayday({ ...period, anchorMode: 'fixed_day' }, [{ ...payroll, lastDate: '2026-10-09' }], '2026-10-09')).toBeNull();
  });
});

describe('silentAnchorStreak (cadence note §6)', () => {
  const closed = (opened: boolean) => ({
    period: { anchorOpenedAt: opened ? '2026-09-01T00:00:00Z' : null } as GameplanPeriod,
    finalGrade: null,
  });

  test('counts consecutive silent anchors from the most recent', () => {
    expect(silentAnchorStreak([])).toBe(0);
    expect(silentAnchorStreak([closed(false), closed(false), closed(true)])).toBe(2);
    expect(silentAnchorStreak([closed(true), closed(false)])).toBe(0);
  });
});
