import { describe, expect, test } from '@jest/globals';

import {
  expectedBills,
  expectedOccurrences,
  expectedWindow,
  nextExpectedDate,
  periodOpensMonth,
} from '../../src/gameplan/expected-bills.js';
import { SAM_PERIOD, samStreams, stream } from './fixtures.js';

const TODAY = '2026-09-25';

describe('nextExpectedDate (§10.2)', () => {
  test('monthly bills advance to the anchor day of the next month', () => {
    expect(nextExpectedDate(stream({ lastDate: '2026-09-01', anchorDayOfMonth: 1 }))).toBe('2026-10-01');
    expect(nextExpectedDate(stream({ lastDate: '2026-09-12', anchorDayOfMonth: 12 }))).toBe('2026-10-12');
  });

  test('a posting on the far side of the month boundary belongs to the nearer anchor', () => {
    // Rent for February paid January 31st: the next posting is March 1st.
    expect(nextExpectedDate(stream({ lastDate: '2026-01-31', anchorDayOfMonth: 1 }))).toBe('2026-03-01');
    expect(nextExpectedDate(stream({ lastDate: '2026-02-02', anchorDayOfMonth: 1 }))).toBe('2026-03-01');
  });

  test('the anchor clamps to short months', () => {
    expect(nextExpectedDate(stream({ lastDate: '2026-01-31', anchorDayOfMonth: 31 }))).toBe('2026-02-28');
  });

  test('longer calendar cadences step by their months', () => {
    expect(
      nextExpectedDate(stream({ cadence: 'quarterly', cadenceDays: 91, lastDate: '2026-09-14', anchorDayOfMonth: 14 })),
    ).toBe('2026-12-14');
    expect(
      nextExpectedDate(stream({ cadence: 'semiannual', cadenceDays: 182, lastDate: '2026-09-14', anchorDayOfMonth: 14 })),
    ).toBe('2027-03-14');
    expect(
      nextExpectedDate(stream({ cadence: 'annual', cadenceDays: 365, lastDate: '2026-08-03', anchorDayOfMonth: 3 })),
    ).toBe('2027-08-03');
  });

  test('gap cadences add the median gap; so does a monthly stream with no anchor yet', () => {
    expect(
      nextExpectedDate(stream({ cadence: 'biweekly', cadenceDays: 14, lastDate: '2026-09-25', anchorDayOfMonth: null })),
    ).toBe('2026-10-09');
    expect(
      nextExpectedDate(stream({ cadence: 'weekly', cadenceDays: 7.2, lastDate: '2026-09-25', anchorDayOfMonth: null })),
    ).toBe('2026-10-02');
    expect(nextExpectedDate(stream({ lastDate: '2026-09-10', anchorDayOfMonth: null }))).toBe('2026-10-10');
  });
});

describe('expectedWindow and occurrences', () => {
  test('the window is ± the observed jitter, defaulting to 2', () => {
    expect(expectedWindow(stream({ dateJitterDays: 3 }), '2026-10-08')).toEqual({
      expectedDate: '2026-10-08',
      start: '2026-10-05',
      end: '2026-10-11',
    });
    expect(expectedWindow(stream({ dateJitterDays: null }), '2026-10-08').start).toBe('2026-10-06');
  });

  test('a weekly stream yields every posting whose window opens by the limit', () => {
    const weekly = stream({ cadence: 'weekly', cadenceDays: 7, lastDate: '2026-09-24', anchorDayOfMonth: null });
    const dates = (until: string) => expectedOccurrences(weekly, until).map((window) => window.expectedDate);

    // Oct 15's window opens Oct 13: in by the 13th, out by the 12th.
    expect(dates('2026-10-08')).toEqual(['2026-10-01', '2026-10-08']);
    expect(dates('2026-10-12')).toEqual(['2026-10-01', '2026-10-08']);
    expect(dates('2026-10-13')).toEqual(['2026-10-01', '2026-10-08', '2026-10-15']);
  });
});

describe('expectedBills — the shelf (§10)', () => {
  test("Sam's shelf is $1,472: rent, electric, internet, and the insurance share", () => {
    const shelf = expectedBills(samStreams(), [], SAM_PERIOD, TODAY);

    expect(shelf.total).toBe(1472);
    expect(shelf.cashRequired).toBe(1472);
    expect(shelf.earliestWindowStart).toBe('2026-09-29');

    const byKey = new Map(shelf.bills.map((bill) => [bill.key, bill]));
    expect(byKey.get('outflow:oak street lofts')).toMatchObject({
      status: 'expected',
      basis: 'confirmed',
      shelfAmount: 1200,
      expectedDate: '2026-10-01',
      windowStart: '2026-09-29',
      windowEnd: '2026-10-03',
    });
    expect(byKey.get('outflow:city power')).toMatchObject({
      status: 'expected',
      shelfAmount: 140,
      amountRange: { low: 90, high: 140 },
      windowStart: '2026-10-05',
      windowEnd: '2026-10-11',
    });
    expect(byKey.get('outflow:comcast')).toMatchObject({ shelfAmount: 77 });

    // $712 thirteen periods out reserves $55 a period (§10.7).
    expect(byKey.get('outflow:geico')).toMatchObject({
      status: 'accruing',
      shelfAmount: 55,
      expectedDate: '2027-03-14',
      accrual: { totalAmount: 712, share: 55, accruedBefore: 0, accruedAfter: 55, periodsUntilExpected: 13 },
    });

    // Netflix lands on the 15th, after the period; it is left off and said so.
    expect(byKey.has('outflow:netflix')).toBe(false);
    expect(shelf.excluded).toContainEqual({
      streamKey: 'outflow:netflix',
      displayName: 'Netflix',
      reason: 'outside_period',
    });
  });

  test('a window that closed before the period and has not posted carries over (§10.2)', () => {
    // Expected Sep 20 ± 2, nothing posted since Aug 20, not yet stale.
    const late = stream({ lastDate: '2026-08-20', anchorDayOfMonth: 20, displayName: 'Water Co' });
    const shelf = expectedBills([late], [], SAM_PERIOD, TODAY);

    expect(shelf.bills[0]).toMatchObject({
      status: 'carry_over',
      shelfAmount: 100,
      expectedDate: '2026-09-20',
    });
    // The carry-over is already late, so the shelf is "by" the period start.
    expect(shelf.earliestWindowStart).toBe('2026-09-25');
  });

  test('a bill that already posted this period is not reserved again', () => {
    const posted = stream({ lastDate: '2026-09-26', anchorDayOfMonth: 26 });
    const shelf = expectedBills([posted], [], SAM_PERIOD, '2026-09-27');

    expect(shelf.bills).toHaveLength(0);
    expect(shelf.excluded[0]).toMatchObject({ reason: 'posted_this_period' });
  });

  test('a weekly bill in a biweekly period is reserved for each posting', () => {
    const cleaning = stream({
      streamKey: 'outflow:cleaning co',
      displayName: 'Cleaning Co',
      cadence: 'weekly',
      cadenceDays: 7,
      lastDate: '2026-09-24',
      anchorDayOfMonth: null,
      planningAmount: 60,
      lastAmount: 60,
      averageAmount: 60,
    });
    const shelf = expectedBills([cleaning], [], SAM_PERIOD, TODAY);

    expect(shelf.bills.map((bill) => bill.expectedDate)).toEqual(['2026-10-01', '2026-10-08']);
    expect(shelf.total).toBe(120);
  });

  test('dismissed, unconfirmed medium-confidence, stale, erratic and unplanned streams stay off (§10.1, §10.3)', () => {
    const shelf = expectedBills(
      [
        stream({ streamKey: 'a', userStatus: 'dismissed' }),
        stream({ streamKey: 'b', userStatus: 'detected', confidence: 'medium' }),
        stream({ streamKey: 'c', lastDate: '2026-06-10' }),
        stream({ streamKey: 'd', amountClass: 'erratic', planningAmount: null }),
        stream({ streamKey: 'e', amountClass: null, planningAmount: null }),
        stream({ streamKey: 'f', userStatus: 'detected', confidence: 'high' }),
      ],
      [],
      SAM_PERIOD,
      TODAY,
    );

    expect(shelf.excluded.map((entry) => [entry.streamKey, entry.reason])).toEqual([
      ['a', 'dismissed'],
      ['b', 'low_confidence'],
      ['c', 'stale'],
      ['d', 'erratic'],
      ['e', 'no_planning_amount'],
    ]);
    // Detected at high confidence counts, and the basis says so.
    expect(shelf.bills).toHaveLength(1);
    expect(shelf.bills[0]).toMatchObject({ key: 'f', basis: 'high_confidence' });
  });

  test('declared obligations: monthly by the first period of the month, weekly every period, one-time never (§10.6)', () => {
    const obligations = [
      { kind: 'rent_to_person' as const, label: null, amount: 500, cadence: 'monthly' as const },
      { kind: 'other' as const, label: 'Babysitter', amount: 40, cadence: 'weekly' as const },
      { kind: 'medical_plan' as const, label: null, amount: 900, cadence: 'one_time' as const },
    ];

    // Sep 25 – Oct 8 is not the first period opening in September.
    const later = expectedBills([], obligations, SAM_PERIOD, TODAY);
    expect(later.bills.map((bill) => [bill.displayName, bill.shelfAmount])).toEqual([['Babysitter', 80]]);
    expect(periodOpensMonth(SAM_PERIOD)).toBe(false);

    const first = { start: '2026-10-09', end: '2026-10-22', trigger: 'payday' as const };
    const early = expectedBills([], obligations, first, '2026-10-09');
    expect(early.bills.map((bill) => [bill.displayName, bill.shelfAmount])).toEqual([
      ['rent paid to a person', 500],
      ['Babysitter', 80],
    ]);
    expect(early.bills[0]).toMatchObject({ key: 'declared:0', basis: 'declared', expectedDate: null });
  });

  test('accrual continues from what earlier periods set aside, and the landing period reserves the rest (§10.7)', () => {
    const geico = samStreams().find((entry) => entry.streamKey === 'outflow:geico')!;

    const midway = expectedBills([geico], [], SAM_PERIOD, TODAY, {
      accruedToDate: { 'outflow:geico': 330 },
    });
    expect(midway.bills[0]!.accrual).toMatchObject({ accruedBefore: 330, share: 30, accruedAfter: 360 });
    expect(midway.cashRequired).toBe(360);

    const landing = { start: '2027-03-05', end: '2027-03-18', trigger: 'payday' as const };
    const lands = expectedBills([geico], [], landing, '2027-03-05', {
      accruedToDate: { 'outflow:geico': 660 },
    });
    expect(lands.bills[0]).toMatchObject({ status: 'expected', shelfAmount: 52, expectedDate: '2027-03-14' });
    expect(lands.bills[0]!.accrual).toMatchObject({ accruedBefore: 660, accruedAfter: 712, periodsUntilExpected: 1 });
    // The balance must hold what was accrued plus the rest.
    expect(lands.cashRequired).toBe(712);
  });

  test('a bill_change override replaces the planning amount for this period (§10.5)', () => {
    const shelf = expectedBills(samStreams(), [], SAM_PERIOD, TODAY, {
      billOverrides: { 'outflow:oak street lofts': 1300 },
    });
    expect(shelf.bills.find((bill) => bill.key === 'outflow:oak street lofts')!.shelfAmount).toBe(1300);
    expect(shelf.total).toBe(1572);
  });
});
