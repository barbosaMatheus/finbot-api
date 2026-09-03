import { describe, expect, jest, test } from '@jest/globals';

import {
  detectRecurringStreams,
  detectUserRecurring,
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
    expect(prunes[0]![1]).toEqual(['outflow:netflix']);
    expect(chained).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });
});
