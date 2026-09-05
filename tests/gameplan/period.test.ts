import { describe, expect, jest, test } from '@jest/globals';

import {
  closeDueDate,
  detectAnchor,
  dueActions,
  firstPeriodBounds,
  midPeriodDueDate,
  nextWeekday,
  periodEnd,
  primaryIncomeStream,
} from '../../src/services/gameplan-period.service.js';
import { DEFAULT_ANCHOR_SETTINGS, type GameplanPeriod } from '../../src/services/gameplan-store.service.js';
import { samStreams, stream } from './fixtures.js';

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const TODAY = '2026-09-25';
const payroll = samStreams().find((entry) => entry.streamKey === 'inflow:acme payroll')!;

function period(overrides: Partial<GameplanPeriod> = {}): GameplanPeriod {
  return {
    id: 'period-1',
    userId: 'user-1',
    start: '2026-09-25',
    end: '2026-10-08',
    trigger: 'payday',
    anchorMode: 'payday',
    status: 'planned',
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
    ...overrides,
  };
}

describe('primaryIncomeStream and detectAnchor (cadence note §2)', () => {
  test('the largest stable income stream wins; irregular and stale streams never anchor', () => {
    const side = stream({
      streamKey: 'inflow:gig',
      direction: 'inflow',
      cadence: 'irregular',
      cadenceDays: 23,
      averageAmount: 900,
      lastAmount: 900,
      lastDate: '2026-09-20',
      dominantRole: 'earned_income',
      planningAmount: null,
      anchorDayOfMonth: null,
    });
    const old = stream({
      ...payroll,
      streamKey: 'inflow:old employer',
      averageAmount: 5000,
      lastAmount: 5000,
      lastDate: '2026-07-01',
    });

    expect(primaryIncomeStream([side, old, payroll], TODAY)?.streamKey).toBe('inflow:acme payroll');
    expect(primaryIncomeStream([side], TODAY)).toBeNull();
  });

  test('auto: payday when a stable stream exists, otherwise the fixed day', () => {
    expect(detectAnchor(samStreams(), DEFAULT_ANCHOR_SETTINGS, TODAY)).toMatchObject({
      mode: 'payday',
      nextExpectedPayday: '2026-10-09',
      basis: 'detected',
    });
    expect(detectAnchor([], DEFAULT_ANCHOR_SETTINGS, TODAY)).toEqual({
      mode: 'fixed_day',
      anchorDay: 0,
      basis: 'no_stable_stream',
    });
  });

  test('the user’s setting wins, except that payday needs a stream to exist', () => {
    expect(detectAnchor(samStreams(), { ...DEFAULT_ANCHOR_SETTINGS, anchorMode: 'fixed_day', anchorDay: 3 }, TODAY)).toEqual({
      mode: 'fixed_day',
      anchorDay: 3,
      basis: 'setting',
    });
    expect(detectAnchor([], { ...DEFAULT_ANCHOR_SETTINGS, anchorMode: 'payday' }, TODAY)).toMatchObject({
      mode: 'fixed_day',
      basis: 'no_stable_stream',
    });
  });
});

describe('period bounds', () => {
  const payday = detectAnchor(samStreams(), DEFAULT_ANCHOR_SETTINGS, TODAY);
  const sunday = detectAnchor([], DEFAULT_ANCHOR_SETTINGS, TODAY);

  test('nextWeekday is strictly after the given day', () => {
    expect(nextWeekday('2026-09-25', 0)).toBe('2026-09-27'); // Friday → Sunday
    expect(nextWeekday('2026-09-27', 0)).toBe('2026-10-04'); // Sunday → next Sunday
    expect(nextWeekday('2026-09-25', 5)).toBe('2026-10-02'); // Friday → next Friday
  });

  test('a payday period ends the day before the next expected payday; a fixed-day period the day before the anchor day', () => {
    expect(periodEnd(payday, '2026-09-25')).toBe('2026-10-08');
    expect(periodEnd(sunday, '2026-09-27')).toBe('2026-10-03');
    expect(periodEnd(sunday, '2026-09-25')).toBe('2026-09-26');
  });

  test('the first period runs to the next boundary, or merges into the following one when under four days', () => {
    expect(firstPeriodBounds(payday, '2026-09-25')).toEqual({ start: '2026-09-25', end: '2026-10-08', trigger: 'first' });
    // Two days before payday: too short, so it runs through the next full period.
    expect(firstPeriodBounds(payday, '2026-10-07')).toEqual({ start: '2026-10-07', end: '2026-10-22', trigger: 'first' });
    expect(firstPeriodBounds(sunday, '2026-09-25')).toEqual({ start: '2026-09-25', end: '2026-10-03', trigger: 'first' });
  });

  test('close and mid-period due dates', () => {
    expect(closeDueDate({ end: '2026-10-08', anchorMode: 'payday' })).toBe('2026-10-11');
    expect(closeDueDate({ end: '2026-10-03', anchorMode: 'fixed_day' })).toBe('2026-10-04');
    expect(midPeriodDueDate({ start: '2026-09-25', end: '2026-10-08' })).toBeNull();
    expect(midPeriodDueDate({ start: '2026-09-01', end: '2026-09-30' })).toBe('2026-09-16');
  });
});

describe('dueActions', () => {
  test('nothing before the due date; the final grade once the anchor hour is reached', () => {
    expect(dueActions(period(), DEFAULT_ANCHOR_SETTINGS, new Date('2026-10-10T20:00:00Z'))).toEqual([]);
    expect(dueActions(period(), DEFAULT_ANCHOR_SETTINGS, new Date('2026-10-11T12:00:00Z'))).toEqual([]);
    expect(dueActions(period(), DEFAULT_ANCHOR_SETTINGS, new Date('2026-10-11T18:30:00Z'))).toEqual(['final_grade']);
    expect(dueActions(period(), { ...DEFAULT_ANCHOR_SETTINGS, anchorTimeOfDay: 'morning' }, new Date('2026-10-11T08:00:00Z'))).toEqual(['final_grade']);
  });

  test('a missed anchor gets one reminder the next morning, and long periods a mid-period grade', () => {
    const missed = period({ anchorReadyAt: '2026-09-25T18:00:00Z' });
    expect(dueActions(missed, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-25T23:00:00Z'))).toEqual([]);
    expect(dueActions(missed, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-26T08:05:00Z'))).toEqual(['reminder']);
    expect(dueActions({ ...missed, reminderSentAt: '2026-09-26T08:05:00Z' }, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-27T09:00:00Z'))).toEqual([]);
    expect(dueActions({ ...missed, status: 'open' }, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-26T09:00:00Z'))).toEqual([]);

    const monthly = period({ start: '2026-09-01', end: '2026-09-30', anchorMode: 'payday' });
    expect(dueActions(monthly, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-16T19:00:00Z'))).toEqual(['mid_period_grade']);
    expect(dueActions({ ...monthly, midPeriodGradedAt: '2026-09-16T19:00:00Z' }, DEFAULT_ANCHOR_SETTINGS, new Date('2026-09-17T19:00:00Z'))).toEqual([]);
  });
});
