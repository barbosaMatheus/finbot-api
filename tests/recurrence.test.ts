import { describe, expect, jest, test } from '@jest/globals';

import {
  EVIDENCE_AMOUNTS_LIMIT,
  classifyAmount,
  dateJitterDays,
  detectRecurringStreams,
  detectUserRecurring,
  medianDayOfMonth,
  planningAmountFor,
  type RecurrenceDeps,
  type RecurrenceInput,
} from '../src/services/recurrence.service.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

let counter = 0;

function input(overrides: Partial<RecurrenceInput>): RecurrenceInput {
  counter += 1;
  return {
    rowId: `row-${counter}`,
    merchantKey: 'netflix',
    displayName: 'Netflix',
    amount: 15.49,
    date: '2026-08-01',
    pending: false,
    role: 'expense',
    ...overrides,
  };
}

/** Generate dated occurrences at a given day interval ending 2026-08-20. */
function series(
  overrides: Partial<RecurrenceInput>,
  gapDays: number,
  count: number,
  jitter: number[] = [],
): RecurrenceInput[] {
  const end = Date.parse('2026-08-20T00:00:00Z');
  const items: RecurrenceInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const wobble = jitter[i] ?? 0;
    const ms = end - (count - 1 - i) * gapDays * 86_400_000 + wobble * 86_400_000;
    items.push(
      input({ ...overrides, date: new Date(ms).toISOString().slice(0, 10) }),
    );
  }

  return items;
}

describe('detectRecurringStreams', () => {
  test('biweekly payroll over 180 days is a high-confidence inflow stream', () => {
    const payroll = series(
      { merchantKey: 'acme payroll', displayName: 'ACME Payroll', amount: -2600, role: 'earned_income' },
      14,
      13,
      [0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 0],
    );

    const streams = detectRecurringStreams(payroll);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      direction: 'inflow',
      cadence: 'biweekly',
      confidence: 'high',
      occurrences: 13,
    });
    expect(streams[0]!.averageAmount).toBeCloseTo(2600, 0);
  });

  test('a stream carries the dominant role of its members', () => {
    // Facts uses this to keep non-income inflows (roommate Zelle) out of
    // the income estimate.
    const payroll = series(
      { merchantKey: 'acme payroll', displayName: 'ACME', amount: -2600, role: 'earned_income' },
      14,
      6,
    );
    const zelle = series(
      { merchantKey: 'zelle roommate', displayName: 'Zelle', amount: -900, role: 'unknown_inflow' },
      30,
      4,
    );

    const streams = detectRecurringStreams([...payroll, ...zelle]);

    expect(
      streams.find((s) => s.merchantKey === 'acme payroll')?.dominantRole,
    ).toBe('earned_income');
    expect(
      streams.find((s) => s.merchantKey === 'zelle roommate')?.dominantRole,
    ).toBe('unknown_inflow');
  });

  test('monthly subscription is a high-confidence outflow stream', () => {
    const netflix = series({ merchantKey: 'netflix', amount: 15.49 }, 30, 6, [0, 1, -1, 0, 1, 0]);

    const streams = detectRecurringStreams(netflix);

    expect(streams[0]).toMatchObject({
      direction: 'outflow',
      cadence: 'monthly',
      confidence: 'high',
    });
  });

  test('variable utility bill is recurring with medium confidence', () => {
    const utility = [
      ...series({ merchantKey: 'city power', displayName: 'City Power', amount: 80 }, 30, 1),
    ];
    // Six monthly bills with meaningful amount variation.
    const amounts = [82.1, 120.5, 95.0, 60.25, 110.4, 75.9];
    const bills = series({ merchantKey: 'city power', displayName: 'City Power' }, 30, 6).map(
      (item, index) => ({ ...item, amount: amounts[index]! }),
    );

    const streams = detectRecurringStreams(bills);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.cadence).toBe('monthly');
    expect(streams[0]!.confidence).toBe('medium');
    expect(streams[0]!.amountVariance).toBeGreaterThan(0.15);
    void utility;
  });

  test('annual charge with three occurrences over three years', () => {
    const annual = [
      input({ merchantKey: 'amazon prime', amount: 139, date: '2024-08-15' }),
      input({ merchantKey: 'amazon prime', amount: 139, date: '2025-08-14' }),
      input({ merchantKey: 'amazon prime', amount: 139, date: '2026-08-16' }),
    ];

    const streams = detectRecurringStreams(annual);

    expect(streams[0]).toMatchObject({ cadence: 'annual', confidence: 'high' });
  });

  test('non-recurring lookalikes stay low confidence / irregular', () => {
    const random = [
      input({ merchantKey: 'amazon', amount: 23, date: '2026-05-02' }),
      input({ merchantKey: 'amazon', amount: 154, date: '2026-05-06' }),
      input({ merchantKey: 'amazon', amount: 12, date: '2026-07-19' }),
      input({ merchantKey: 'amazon', amount: 65, date: '2026-08-11' }),
    ];

    const streams = detectRecurringStreams(random);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.confidence).toBe('low');
  });

  test('fewer than three settled occurrences is not a stream', () => {
    const two = series({ merchantKey: 'gym co', amount: 40 }, 30, 2);
    expect(detectRecurringStreams(two)).toHaveLength(0);

    const pendingThird = [
      ...series({ merchantKey: 'gym co', amount: 40 }, 30, 2),
      input({ merchantKey: 'gym co', amount: 40, pending: true }),
    ];
    expect(detectRecurringStreams(pendingThird)).toHaveLength(0);
  });

  test('internal transfers and card payments never form streams', () => {
    const transfers = series(
      { merchantKey: 'transfer to savings', amount: 500, role: 'savings_or_investment_transfer' },
      30,
      6,
    );
    const payments = series(
      { merchantKey: 'chase card payment', amount: 800, role: 'credit_card_payment' },
      30,
      6,
    );
    const incomingTransfers = series(
      { merchantKey: 'transfer in', amount: -500, role: 'internal_transfer' },
      30,
      6,
    );

    expect(
      detectRecurringStreams([...transfers, ...payments, ...incomingTransfers]),
    ).toHaveLength(0);
  });

  test('recurring debt payments do count as outflow streams', () => {
    const carLoan = series(
      { merchantKey: 'toyota financial', displayName: 'Toyota Financial', amount: 389, role: 'debt_principal_payment' },
      30,
      6,
    );

    const streams = detectRecurringStreams(carLoan);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.cadence).toBe('monthly');
  });

  test('same-day duplicates collapse into one occurrence', () => {
    const doubled = [
      input({ merchantKey: 'spotify', amount: 11.99, date: '2026-06-01' }),
      input({ merchantKey: 'spotify', amount: 11.99, date: '2026-06-01' }),
      input({ merchantKey: 'spotify', amount: 11.99, date: '2026-07-01' }),
      input({ merchantKey: 'spotify', amount: 11.99, date: '2026-08-01' }),
    ];

    const streams = detectRecurringStreams(doubled);

    expect(streams[0]!.occurrences).toBe(3);
    // The doubled day counts as one occurrence of 2x the amount.
    expect(streams[0]!.cadence).toBe('monthly');
  });

  test('merchants without a normalized key are skipped', () => {
    const anonymous = series({ merchantKey: null, amount: 50 }, 30, 6);
    expect(detectRecurringStreams(anonymous)).toHaveLength(0);
  });

  test('weekly cadence is recognized', () => {
    const weekly = series({ merchantKey: 'cleaning co', amount: 60 }, 7, 10);
    expect(detectRecurringStreams(weekly)[0]!.cadence).toBe('weekly');
  });

  test('quarterly cadence is recognized', () => {
    const quarterly = series({ merchantKey: 'water utility', amount: 130 }, 91, 4);
    expect(detectRecurringStreams(quarterly)[0]!.cadence).toBe('quarterly');
  });

  test('semi-annual cadence is recognized', () => {
    const premium = series({ merchantKey: 'geico', amount: 712 }, 182, 4, [0, 3, -2, 1]);
    const streams = detectRecurringStreams(premium);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ cadence: 'semiannual', confidence: 'high' });
  });

  test('two matching long-cadence outflows surface as a low-confidence candidate', () => {
    const premium = [
      input({ merchantKey: 'geico', amount: 712, date: '2026-02-14' }),
      input({ merchantKey: 'geico', amount: 705, date: '2026-08-16' }),
    ];
    const hoa = [
      input({ merchantKey: 'oakridge hoa', amount: 500, date: '2025-08-01' }),
      input({ merchantKey: 'oakridge hoa', amount: 500, date: '2026-08-03' }),
    ];

    const streams = detectRecurringStreams([...premium, ...hoa]);

    expect(streams).toHaveLength(2);
    expect(streams.find((stream) => stream.merchantKey === 'geico')).toMatchObject({
      cadence: 'semiannual',
      confidence: 'low',
      occurrences: 2,
    });
    expect(streams.find((stream) => stream.merchantKey === 'oakridge hoa')).toMatchObject({
      cadence: 'annual',
      confidence: 'low',
      occurrences: 2,
    });
  });

  test('two occurrences stay out when amounts differ, the gap is short, or the direction is inflow', () => {
    const mismatched = [
      input({ merchantKey: 'geico', amount: 712, date: '2026-02-14' }),
      input({ merchantKey: 'geico', amount: 400, date: '2026-08-16' }),
    ];
    expect(detectRecurringStreams(mismatched)).toHaveLength(0);

    const shortGap = series({ merchantKey: 'gym co', amount: 40 }, 30, 2);
    expect(detectRecurringStreams(shortGap)).toHaveLength(0);

    const bonus = [
      input({ merchantKey: 'acme bonus', amount: -3000, role: 'earned_income', date: '2025-08-15' }),
      input({ merchantKey: 'acme bonus', amount: -3000, role: 'earned_income', date: '2026-08-14' }),
    ];
    expect(detectRecurringStreams(bonus)).toHaveLength(0);
  });
});

// Gameplan step 1 (gameplan-generation.md §10.2–10.3): a stream carries what
// a plan needs to EXPECT its next posting — where in the calendar it lands,
// how wide the window is, and how much to set aside.
describe('planning fields', () => {
  test('a fixed bill reserves its LAST amount, not its average, and lands on its calendar day', () => {
    // Rent on the 1st; the landlord raised it in the last posting. The plan
    // must reserve $1,250, which the average will not reach for months.
    const rent = ['03', '04', '05', '06', '07', '08'].map((month, index) =>
      input({
        merchantKey: 'oak street lofts',
        amount: index === 5 ? 1250 : 1200,
        date: `2026-${month}-01`,
      }),
    );

    const [stream] = detectRecurringStreams(rent);

    expect(stream).toMatchObject({
      cadence: 'monthly',
      amountClass: 'fixed',
      planningAmount: 1250,
      anchorDayOfMonth: 1,
      dateJitterDays: 2,
    });
    expect(stream!.averageAmount).toBeLessThan(1250);
    expect(stream!.evidence.amounts).toEqual([1200, 1200, 1200, 1200, 1200, 1250]);
  });

  test('a variable bill reserves the higher of its last amount and its 75th percentile', () => {
    const amounts = [82.1, 120.5, 95.0, 60.25, 110.4, 75.9];
    const bills = series({ merchantKey: 'city power', displayName: 'City Power' }, 30, 6).map(
      (item, index) => ({ ...item, amount: amounts[index]! }),
    );

    const [stream] = detectRecurringStreams(bills);

    // Sorted: 60.25 75.9 82.1 95 110.4 120.5 → nearest-rank p75 is 110.4,
    // above the last posting of 75.9. Reserve for the high side.
    expect(stream).toMatchObject({ amountClass: 'variable', planningAmount: 110.4 });
    expect(stream!.evidence.amounts).toEqual(amounts);
  });

  test('the last amount wins when it is above the 75th percentile', () => {
    const amounts = [82.1, 75.9, 95.0, 60.25, 110.4, 120.5];
    const bills = series({ merchantKey: 'city power', displayName: 'City Power' }, 30, 6).map(
      (item, index) => ({ ...item, amount: amounts[index]! }),
    );

    expect(detectRecurringStreams(bills)[0]).toMatchObject({
      amountClass: 'variable',
      planningAmount: 120.5,
    });
  });

  test('an erratic stream is not a bill: no planning amount', () => {
    const random = [
      input({ merchantKey: 'amazon', amount: 23, date: '2026-05-02' }),
      input({ merchantKey: 'amazon', amount: 154, date: '2026-05-06' }),
      input({ merchantKey: 'amazon', amount: 12, date: '2026-07-19' }),
      input({ merchantKey: 'amazon', amount: 65, date: '2026-08-11' }),
    ];

    expect(detectRecurringStreams(random)[0]).toMatchObject({
      amountClass: 'erratic',
      planningAmount: null,
      anchorDayOfMonth: null,
    });
  });

  test('weekly and biweekly streams anchor on the gap, not the calendar', () => {
    const weekly = series({ merchantKey: 'cleaning co', amount: 60 }, 7, 10);
    const payroll = series(
      { merchantKey: 'acme payroll', amount: -2600, role: 'earned_income' },
      14,
      8,
    );

    const streams = detectRecurringStreams([...weekly, ...payroll]);

    expect(streams.find((s) => s.merchantKey === 'cleaning co')).toMatchObject({
      anchorDayOfMonth: null,
      dateJitterDays: 2,
      amountClass: 'fixed',
      planningAmount: 60,
    });
    // An inflow's amount is classified but never reserved for.
    expect(streams.find((s) => s.merchantKey === 'acme payroll')).toMatchObject({
      anchorDayOfMonth: null,
      amountClass: 'fixed',
      planningAmount: null,
    });
  });

  test('a bill paid by hand gets the window its habit shows', () => {
    // Gaps of 25, 38, 29, 33 days: median 31, deviations 6 7 2 2 → p90 = 7.
    const dates = ['2026-03-01', '2026-03-26', '2026-05-03', '2026-06-01', '2026-07-04'];
    const [stream] = detectRecurringStreams(
      dates.map((date) => input({ merchantKey: 'water co', amount: 45, date })),
    );

    expect(stream).toMatchObject({ cadence: 'monthly', dateJitterDays: 7 });
  });

  test('a bill straddling the month boundary anchors on the 1st, not the 16th', () => {
    // Pinned to the 1st but posted on the 31st / 30th when the 1st was a
    // weekend: days 31 1 1 30 1 1. A plain median would say the 16th.
    const dates = ['2026-01-31', '2026-03-01', '2026-04-01', '2026-04-30', '2026-06-01', '2026-07-01'];
    const [stream] = detectRecurringStreams(
      dates.map((date) => input({ merchantKey: 'oak street lofts', amount: 1200, date })),
    );

    expect(stream).toMatchObject({ cadence: 'monthly', anchorDayOfMonth: 1 });
  });

  test('a drifting bill with a wide spread keeps the plain median', () => {
    // Days 5 8 12 16 20: wide, but not a wrap. Unwrapping would be worse.
    const dates = ['2026-03-05', '2026-04-08', '2026-05-12', '2026-06-16', '2026-07-20'];
    const [stream] = detectRecurringStreams(
      dates.map((date) => input({ merchantKey: 'lawn guy', amount: 80, date })),
    );

    expect(stream).toMatchObject({ cadence: 'monthly', anchorDayOfMonth: 12 });
  });

  test('evidence keeps only the most recent amounts, and the percentile reads from them', () => {
    const weekly = series({ merchantKey: 'cleaning co' }, 7, 30).map((item, index) => ({
      ...item,
      amount: 10 + index,
    }));

    const [stream] = detectRecurringStreams(weekly);

    expect(stream!.occurrences).toBe(30);
    expect(stream!.evidence.amounts).toHaveLength(EVIDENCE_AMOUNTS_LIMIT);
    expect(stream!.evidence.amounts[0]).toBe(16);
    expect(stream!.evidence.amounts[EVIDENCE_AMOUNTS_LIMIT - 1]).toBe(39);
    // Variable class; the last amount (39) is the maximum, so it is reserved.
    expect(stream).toMatchObject({ amountClass: 'variable', planningAmount: 39 });
  });

  test('helpers: class boundaries, jitter floor, planning by class, day-of-month median', () => {
    expect(classifyAmount(0)).toBe('fixed');
    expect(classifyAmount(0.05)).toBe('fixed');
    expect(classifyAmount(0.0501)).toBe('variable');
    expect(classifyAmount(0.5)).toBe('variable');
    expect(classifyAmount(0.51)).toBe('erratic');

    expect(dateJitterDays([], 30)).toBe(2);
    expect(dateJitterDays([30, 30, 30], 30)).toBe(2);
    expect(dateJitterDays([30, 31, 30, 31], 30.5)).toBe(2);

    expect(planningAmountFor('fixed', 99.999, [50, 60])).toBe(100);
    // Sorted 90 100 120 140: nearest-rank p75 of four is the third (120).
    expect(planningAmountFor('variable', 50, [90, 140, 120, 100])).toBe(120);
    expect(planningAmountFor('variable', 150, [90, 140, 120, 100])).toBe(150);
    expect(planningAmountFor('erratic', 150, [90, 140])).toBeNull();

    expect(medianDayOfMonth(['2026-03-12', '2026-04-12', '2026-05-13'])).toBe(12);
    expect(medianDayOfMonth(['2026-01-31', '2026-03-01', '2026-04-01'])).toBe(1);
    expect(medianDayOfMonth(['2026-03-28', '2026-04-29', '2026-05-30', '2026-07-02'])).toBe(30);
  });
});

describe('detectUserRecurring job', () => {
  test('upserts streams by stable key, prunes vanished ones, chains facts', async () => {
    const upserts: unknown[][] = [];
    const prunes: unknown[][] = [];
    const chained: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        if (text.includes('INSERT INTO recurring_streams')) {
          expect(text).toContain('ON CONFLICT (user_id, stream_key) DO UPDATE');
          // user_status is deliberately not refreshed by the upsert.
          expect(text).not.toContain('user_status = EXCLUDED');
          // The planning fields are refreshed wholesale like every other
          // detection field.
          expect(text).toContain('planning_amount = EXCLUDED.planning_amount');
          expect(text).toContain('anchor_day_of_month = EXCLUDED.anchor_day_of_month');
          upserts.push(values);
          return { rows: [] as R[], rowCount: 1 };
        }

        if (text.includes('DELETE FROM recurring_streams')) {
          prunes.push(values);
          return { rows: [] as R[], rowCount: 0 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 50)}`);
      },
    };

    const deps: RecurrenceDeps = {
      db,
      listInputs: async () =>
        series({ merchantKey: 'netflix', amount: 15.49 }, 30, 6),
      enqueueNextStage: async (payload) => {
        chained.push(payload);
        return null;
      },
    };

    const result = await detectUserRecurring(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(result.streams).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]![1]).toBe('outflow:netflix');
    // Six postings 30 days apart ending Aug 20: days 23 22 22 21 21 20 →
    // anchor 22, jitter floor 2, fixed at the last amount.
    expect(upserts[0]).toHaveLength(22);
    expect(upserts[0]!.slice(18)).toEqual([22, 2, 'fixed', 15.49]);
    expect(prunes[0]![1]).toEqual(['outflow:netflix']);
    expect(chained).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });
});
