import { describe, expect, test } from '@jest/globals';

import { expectedBills } from '../../src/gameplan/expected-bills.js';
import {
  computeFreeCash,
  essentialFloor,
  expectedStreamIncome,
  incomeInPeriod,
} from '../../src/gameplan/free-cash.js';
import { SAM_PERIOD, category, facts, inputFixture, samInput, stream } from './fixtures.js';

function shelfFor(input = samInput()) {
  return expectedBills(input.streams, input.declaredObligations, input.period, input.today, {
    accruedToDate: input.accruedToDate,
    billOverrides: input.billOverrides,
  });
}

describe('computeFreeCash (§2, decision 2)', () => {
  test("Sam: $2,200 − $1,472 shelf − $280 floor = $448 free cash, cash check positive", () => {
    const input = samInput();
    const result = computeFreeCash(input, shelfFor(input));

    expect(result).toMatchObject({
      incomeInPeriod: 2200,
      incomeSource: 'opening_paycheck',
      shelf: 1472,
      essentialFloor: 280,
      oneTimeCosts: 0,
      freeCash: 448,
      availableBalance: 2900,
      cashCheck: 1428,
      tight: false,
      tightReason: null,
    });
    expect(result.essentialBuckets.map((entry) => entry.bucket).sort()).toEqual([
      'Fuel',
      'Groceries',
      'Transportation',
    ]);
  });

  test('the floor is groceries, fuel and transport only — never housing, whose bills sit on the shelf', () => {
    const floor = essentialFloor(samInput().facts, SAM_PERIOD);
    expect(floor.total).toBe(280);
    expect(floor.buckets.some((entry) => entry.bucket === 'Housing & Utilities')).toBe(false);
  });

  test('an erratic stream in an essential bucket joins the floor (§10.3)', () => {
    // Water paid with whatever was left: not a bill, but not optional either.
    const water = stream({
      streamKey: 'outflow:water co',
      displayName: 'Water Co',
      averageAmount: 60,
      lastAmount: 90,
      amountVariance: 0.7,
      amountClass: 'erratic',
      planningAmount: null,
      dominantBucket: 'Housing & Utilities',
      lastDate: '2026-09-12',
    });
    const floor = essentialFloor(samInput().facts, SAM_PERIOD, [...samInput().streams, water], '2026-09-25');

    expect(floor.streams).toEqual([{ streamKey: 'outflow:water co', displayName: 'Water Co', periodAverage: 27.63 }]);
    expect(floor.total).toBe(307.63);

    // Stale, dismissed, or in a discretionary bucket: not essential.
    expect(essentialFloor(samInput().facts, SAM_PERIOD, [{ ...water, lastDate: '2026-06-01' }], '2026-09-25').streams).toEqual([]);
    expect(essentialFloor(samInput().facts, SAM_PERIOD, [{ ...water, dominantBucket: 'Shopping' }], '2026-09-25').streams).toEqual([]);
  });

  test('a negative cash check makes the period tight even when the flow figure is fine', () => {
    // Overdrawn the day after payday: $900 in the bank against a $1,472 shelf.
    const input = inputFixture({ facts: { ...samInput().facts, balances: { ...samInput().facts.balances, availableToSpend: 900 } } });
    const result = computeFreeCash(input, shelfFor(input));

    expect(result.freeCash).toBe(448);
    expect(result.cashCheck).toBe(-572);
    expect(result).toMatchObject({ tight: true, tightReason: 'cash_check' });
  });

  test('free cash at or below zero is tight too', () => {
    const input = inputFixture({ openingPaycheck: 1700 });
    const result = computeFreeCash(input, shelfFor(input));

    expect(result.freeCash).toBe(-52);
    expect(result).toMatchObject({ tight: true, tightReason: 'no_free_cash' });
  });

  test('confirmed one-time costs and an income change move free cash by exactly their amount', () => {
    const input = inputFixture({
      oneTimeCosts: [{ label: 'car repair', amount: 400 }],
      incomeAdjustment: -100,
    });
    const result = computeFreeCash(input, shelfFor(input));

    expect(result.incomeInPeriod).toBe(2100);
    expect(result.oneTimeCosts).toBe(400);
    expect(result.freeCash).toBe(-52);
  });

  test('without a balance there is no cash check', () => {
    const input = inputFixture({ facts: facts({ accountCount: 0 }) });
    const result = computeFreeCash(input, shelfFor(input));
    expect(result.cashCheck).toBeNull();
    expect(result.availableBalance).toBeNull();
  });
});

describe('incomeInPeriod', () => {
  test('a payday period counts the opening paycheck plus other streams landing before it ends', () => {
    const partner = stream({
      streamKey: 'inflow:partner',
      direction: 'inflow',
      displayName: 'Partner',
      cadence: 'monthly',
      cadenceDays: 30.4,
      averageAmount: 800,
      lastAmount: 750,
      lastDate: '2026-09-03',
      anchorDayOfMonth: 3,
      dominantRole: 'unknown_inflow',
      userStatus: 'confirmed',
      planningAmount: null,
    });
    const input = inputFixture({ streams: [...samInput().streams, partner] });

    // The partner's deposit lands Oct 3, inside the period, at the lower of last and average.
    expect(expectedStreamIncome(input.streams, SAM_PERIOD, input.today, 'inflow:acme payroll')).toBe(750);
    expect(incomeInPeriod(input)).toEqual({ amount: 2950, source: 'opening_paycheck' });
  });

  test('a fixed-day period counts the streams expected inside it, else the scaled estimate', () => {
    const period = { start: '2026-09-27', end: '2026-10-03', trigger: 'fixed_day' as const };

    const withStreams = inputFixture({
      period,
      openingPaycheck: null,
      streams: [
        stream({
          streamKey: 'inflow:acme payroll',
          direction: 'inflow',
          cadence: 'biweekly',
          cadenceDays: 14,
          averageAmount: 2200,
          lastAmount: 2200,
          lastDate: '2026-09-18',
          anchorDayOfMonth: null,
          dominantRole: 'earned_income',
          planningAmount: null,
        }),
      ],
    });
    expect(incomeInPeriod(withStreams)).toEqual({ amount: 2200, source: 'streams' });

    const noStreams = inputFixture({
      period,
      openingPaycheck: null,
      streams: [],
      facts: facts({ monthlyIncomeEstimate: 3044 }),
    });
    expect(incomeInPeriod(noStreams)).toEqual({ amount: 700, source: 'estimate' });

    const nothing = inputFixture({ period, openingPaycheck: null, streams: [], facts: facts({ monthlyIncomeEstimate: 0 }) });
    expect(incomeInPeriod(nothing)).toEqual({ amount: 0, source: 'none' });
  });

  test('an unconfirmed unknown_inflow stream never counts as income', () => {
    const zelle = stream({
      streamKey: 'inflow:zelle roommate',
      direction: 'inflow',
      averageAmount: 900,
      lastAmount: 900,
      lastDate: '2026-09-03',
      anchorDayOfMonth: 3,
      dominantRole: 'unknown_inflow',
      userStatus: 'detected',
      planningAmount: null,
    });
    expect(expectedStreamIncome([zelle], SAM_PERIOD, '2026-09-25', null)).toBe(0);
  });
});

describe('scaling', () => {
  test('a monthly average scales to the period by 30.44 days a month', () => {
    const floor = essentialFloor(facts({ categoryTotals: [category('Groceries', 304.4)] }), SAM_PERIOD);
    expect(floor.total).toBe(140);
  });
});
