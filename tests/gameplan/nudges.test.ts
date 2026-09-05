import { describe, expect, jest, test } from '@jest/globals';

import { buildShortlist } from '../../src/gameplan/candidates.js';
import type { GradeTransaction } from '../../src/services/gameplan-grade.service.js';
import { detectNudges } from '../../src/services/gameplan-nudge.service.js';
import type { GameplanPeriod } from '../../src/services/gameplan-store.service.js';
import { samInput, samStreams } from './fixtures.js';

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const streams = samStreams().map((entry) => ({
  ...entry,
  merchantKey: entry.streamKey.replace(/^(inflow|outflow):/, ''),
}));

const period: GameplanPeriod = {
  id: 'period-1',
  userId: 'user-1',
  start: '2026-09-25',
  end: '2026-10-08',
  trigger: 'payday',
  anchorMode: 'payday',
  status: 'open',
  firstPeriod: false,
  openingPaycheck: 2200,
  primaryIncomeStreamKey: 'inflow:acme payroll',
  plan: buildShortlist({ ...samInput(), streams }),
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
};

let counter = 0;

function txn(overrides: Partial<GradeTransaction>): GradeTransaction {
  counter += 1;
  return {
    rowId: `row-${counter}`,
    amount: 20,
    date: '2026-10-07',
    pending: false,
    role: 'expense',
    displayBucket: 'Eating Out',
    merchantKey: 'coffee co',
    merchantName: 'Coffee Co',
    accountId: 'acc',
    accountType: 'depository',
    ...overrides,
  };
}

/** Five ordinary $20 coffees in the history, for the medians. */
const coffeeHistory = [1, 2, 3, 4, 5].map((n) => txn({ date: `2026-08-0${n}`, amount: 20 }));

function detect(periodTransactions: GradeTransaction[], today = '2026-10-08', alreadyNudged = new Set<string>()) {
  return detectNudges({
    period,
    periodTransactions,
    history: [...coffeeHistory, ...periodTransactions],
    streams,
    today,
    alreadyNudged,
  });
}

describe('detectNudges (§8, decision 8)', () => {
  test('a bill that posts more than 10 % or $25 over its planning amount', () => {
    const electric = txn({ amount: 210, displayBucket: 'Housing & Utilities', merchantKey: 'city power', merchantName: 'City Power' });
    const [nudge] = detect([electric]);
    expect(nudge).toMatchObject({ kind: 'bill_overrun', transactionRowId: electric.rowId });
    expect(nudge!.body).toBe('City Power came in at $210, $70 over what we set aside.');

    // $150 against $140 set aside is inside the tolerance — and a bill
    // posting is never reported as an unusual purchase either.
    expect(
      detect([txn({ amount: 150, displayBucket: 'Housing & Utilities', merchantKey: 'city power', merchantName: 'City Power' })]),
    ).toEqual([]);
  });

  test('an unusual purchase: 3× the merchant median and ≥ 5 % of free cash, or ≥ 25 % of free cash alone', () => {
    const big = txn({ amount: 80 });
    expect(detect([big])[0]).toMatchObject({ kind: 'unusual_transaction', transactionRowId: big.rowId });
    expect(detect([big])[0]!.body).toBe('$80 at Coffee Co — well above your usual $20 there.');

    // $50 is 2.5× the median: not unusual.
    expect(detect([txn({ amount: 50 })])).toEqual([]);

    // A quarter of the $448 free cash with no history at all.
    const large = txn({ amount: 120, merchantKey: 'bike shop', merchantName: 'Bike Shop', displayBucket: 'Shopping' });
    expect(detect([large])[0]!.body).toBe('$120 at Bike Shop is a quarter of what was left for this period.');
  });

  test('a cap blown before the midpoint, once', () => {
    const spend = [txn({ amount: 70, date: '2026-09-26' }), txn({ amount: 70, date: '2026-09-27' })];
    const early = detect(spend, '2026-09-28');
    expect(early.map((nudge) => nudge.kind)).toContain('target_blown');
    expect(early.find((nudge) => nudge.kind === 'target_blown')!.body).toBe(
      'Eating Out has passed its $136 cap with half the period still to go.',
    );

    // After the midpoint the grade handles it.
    expect(detect(spend, '2026-10-05').some((nudge) => nudge.kind === 'target_blown')).toBe(false);
    // Already nudged for this cap: quiet.
    expect(detect(spend, '2026-09-28', new Set(['blown:period-1:Eating Out'])).some((n) => n.kind === 'target_blown')).toBe(false);
  });

  test('a deposit not on any stream at ≥ 50 % of the typical paycheck', () => {
    const venmo = txn({ amount: -1500, role: 'unknown_inflow', displayBucket: null, merchantKey: 'venmo', merchantName: 'Venmo' });
    expect(detect([venmo])[0]).toMatchObject({ kind: 'unexpected_income' });
    expect(detect([venmo])[0]!.body).toBe('$1,500 came in from Venmo, which is not one of your usual deposits.');

    expect(detect([txn({ amount: -500, role: 'unknown_inflow', merchantKey: 'venmo' })])).toEqual([]);
    // The paycheck itself is on a stream.
    expect(detect([txn({ amount: -2200, role: 'earned_income', merchantKey: 'acme payroll' })])).toEqual([]);
  });

  test('stale postings and ones already nudged are ignored; a bill overrun outranks an unusual purchase', () => {
    const old = txn({ amount: 80, date: '2026-10-01' });
    expect(detect([old])).toEqual([]);
    const fresh = txn({ amount: 80 });
    expect(detect([fresh], '2026-10-08', new Set([fresh.rowId]))).toEqual([]);

    const electric = txn({ amount: 210, merchantKey: 'city power' });
    expect(detect([fresh, electric]).map((nudge) => nudge.kind)).toEqual(['bill_overrun', 'unusual_transaction']);
  });

  test('no plan, no nudges', () => {
    expect(detectNudges({ period: { ...period, plan: null }, periodTransactions: [txn({ amount: 500 })], history: [], streams, today: '2026-10-08', alreadyNudged: new Set() })).toEqual([]);
  });
});
