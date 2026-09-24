/**
 * Expected bills (§10 of the gameplan note): which bills exist, when each
 * lands — a window, not a day — how much to reserve, and the shelf that
 * comes out of it. Pure: recomputed from the streams after every sync,
 * never stored and mutated by hand (§10.4).
 *
 * Vocabulary: a bill "lands" around a day. Plaid shows when money left,
 * never when a bill was due, so nothing here is called "due".
 */

import {
  addDays,
  anchoredDate,
  dayNumber,
  dayOfMonth,
  daysBetween,
  maxIso,
  minIso,
  parseIsoDate,
  rangesOverlap,
} from '../lib/dates.js';
import { isStreamStale } from '../lib/streams.js';
import type { FactsRecurringStream } from '../types/financial-facts.js';
import { OBLIGATION_KIND_LABELS, type DeclaredObligation } from '../types/manual-profile.js';
import type { BillShelf, ExpectedBill, ExpectedBillBasis, Period } from './types.js';

/** Months per posting for cadences pinned to the calendar (§10.2). */
const CALENDAR_STEP_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/**
 * Cadences that accrue across periods instead of landing in one (§10.7,
 * decision 12). A monthly bill in a biweekly period is not accrued: it
 * lands every other period, and the note accepts the alternating tight and
 * roomy periods as honest.
 */
export const ACCRUING_CADENCES: ReadonlySet<string> = new Set(['quarterly', 'semiannual', 'annual']);

/** Window half-width for a stream detected before jitter existed. */
const DEFAULT_JITTER_DAYS = 2;

/** A weekly bill in a monthly period lands four or five times; nothing needs more. */
const MAX_OCCURRENCES_PER_PERIOD = 8;

const WEEKS_PER_MONTH_CEIL = (days: number): number => Math.ceil(days / 7);

type StreamTiming = Pick<
  FactsRecurringStream,
  'cadence' | 'cadenceDays' | 'lastDate' | 'anchorDayOfMonth' | 'dateJitterDays'
>;

export type ExpectedWindow = { expectedDate: string; start: string; end: string };

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

export function periodLengthDays(period: Period): number {
  return daysBetween(period.start, period.end) + 1;
}

/**
 * Why a stream counts as a bill (§10.1), or null when it does not: the
 * user said yes, or detection is confident and the user has not answered.
 */
export function billBasis(
  stream: Pick<FactsRecurringStream, 'userStatus' | 'confidence'>,
): ExpectedBillBasis | null {
  if (stream.userStatus === 'dismissed') return null;
  if (stream.userStatus === 'confirmed') return 'confirmed';
  return stream.confidence === 'high' ? 'high_confidence' : null;
}

/**
 * The next expected posting after the stream's last one. Calendar-anchored
 * cadences advance by whole months to the anchor day; gap cadences add the
 * median gap. Shared with the inflow side: an income stream's next expected
 * date is the cadence note's `nextExpectedPayday`.
 */
export function nextExpectedDate(stream: StreamTiming): string {
  const step = CALENDAR_STEP_MONTHS[stream.cadence];

  if (step !== undefined && stream.anchorDayOfMonth !== null) {
    // The last posting belongs to whichever anchor occurrence it is nearest:
    // rent for February paid on January 31st is February's posting, so the
    // next one is March 1st, not February 1st.
    const anchor = stream.anchorDayOfMonth;
    const candidates = [-1, 0, 1].map((offset) => anchoredDate(stream.lastDate, offset, anchor));
    const nominal = candidates.reduce((best, candidate) =>
      Math.abs(daysBetween(stream.lastDate, candidate)) <
      Math.abs(daysBetween(stream.lastDate, best))
        ? candidate
        : best,
    );

    return anchoredDate(nominal, step, anchor);
  }

  return addDays(stream.lastDate, Math.max(1, Math.round(stream.cadenceDays)));
}

/** The window around an expected date: ± the stream's observed jitter (§10.2). */
export function expectedWindow(stream: StreamTiming, expectedDate: string): ExpectedWindow {
  const jitter = stream.dateJitterDays ?? DEFAULT_JITTER_DAYS;
  return {
    expectedDate,
    start: addDays(expectedDate, -jitter),
    end: addDays(expectedDate, jitter),
  };
}

/**
 * Successive expected postings, starting with the first after the last
 * posting, until the window opens after `until`. Bounded.
 */
export function expectedOccurrences(stream: StreamTiming, until: string): ExpectedWindow[] {
  const windows: ExpectedWindow[] = [];
  let cursor: StreamTiming = stream;

  while (windows.length < MAX_OCCURRENCES_PER_PERIOD) {
    const expectedDate = nextExpectedDate(cursor);
    const window = expectedWindow(stream, expectedDate);
    if (dayNumber(window.start) > dayNumber(until)) break;
    windows.push(window);
    cursor = { ...cursor, lastDate: expectedDate };
  }

  return windows;
}

export type ExpectedBillsOptions = {
  /** Running accrual totals per stream key from earlier periods (§10.7). */
  accruedToDate?: Record<string, number>;
  /** Planning-amount overrides for this period from bill_change heads-ups (§10.5). */
  billOverrides?: Record<string, number>;
};

/**
 * The bill shelf for a period: every expected bill with its window and the
 * amount reserved, carry-overs from before the period, and the accrual
 * share of any long-cadence bill. Declared obligations join at their
 * declared amount. Dismissed, low-confidence, stale and erratic streams are
 * listed as excluded so the "why" can be honest about them.
 */
export function expectedBills(
  streams: readonly FactsRecurringStream[],
  declaredObligations: readonly DeclaredObligation[],
  period: Period,
  today: string,
  options: ExpectedBillsOptions = {},
): BillShelf {
  const accruedToDate = options.accruedToDate ?? {};
  const billOverrides = options.billOverrides ?? {};
  const bills: ExpectedBill[] = [];
  const excluded: BillShelf['excluded'] = [];
  const periodDays = periodLengthDays(period);

  for (const stream of streams) {
    if (stream.direction !== 'outflow') continue;

    const basis = billBasis(stream);
    if (basis === null) {
      excluded.push({
        streamKey: stream.streamKey,
        displayName: stream.displayName,
        reason: stream.userStatus === 'dismissed' ? 'dismissed' : 'low_confidence',
      });
      continue;
    }

    if (isStreamStale(stream, today)) {
      excluded.push({ streamKey: stream.streamKey, displayName: stream.displayName, reason: 'stale' });
      continue;
    }

    if (stream.amountClass === 'erratic') {
      excluded.push({ streamKey: stream.streamKey, displayName: stream.displayName, reason: 'erratic' });
      continue;
    }

    const planningAmount = billOverrides[stream.streamKey] ?? stream.planningAmount;
    if (planningAmount === null || planningAmount === undefined) {
      excluded.push({
        streamKey: stream.streamKey,
        displayName: stream.displayName,
        reason: 'no_planning_amount',
      });
      continue;
    }

    const common = {
      key: stream.streamKey,
      displayName: stream.displayName,
      source: 'stream' as const,
      basis,
      cadence: stream.cadence,
      amountClass: stream.amountClass,
      planningAmount: round2(planningAmount),
      amountRange: stream.amounts.length > 0
        ? { low: Math.min(...stream.amounts), high: Math.max(...stream.amounts) }
        : null,
    };

    if (ACCRUING_CADENCES.has(stream.cadence)) {
      // One posting at a time matters for a long-cadence bill; what changes
      // is whether it lands this period or is still being saved for.
      const window = expectedWindow(stream, nextExpectedDate(stream));
      const accruedBefore = round2(Math.max(0, accruedToDate[stream.streamKey] ?? 0));
      const remaining = round2(Math.max(0, planningAmount - accruedBefore));
      const overlaps = rangesOverlap(window, period);
      const closedBefore = dayNumber(window.end) < dayNumber(period.start);

      if (overlaps || closedBefore) {
        // Lands now (or is late): whatever is not yet accrued comes out of
        // this period, and the accrued part must still be in the balance.
        bills.push({
          ...common,
          status: closedBefore ? 'carry_over' : 'expected',
          shelfAmount: remaining,
          expectedDate: window.expectedDate,
          windowStart: window.start,
          windowEnd: window.end,
          accrual: {
            totalAmount: round2(planningAmount),
            share: remaining,
            accruedBefore,
            accruedAfter: round2(planningAmount),
            periodsUntilExpected: 1,
          },
        });
        continue;
      }

      const periodsUntilExpected = Math.max(
        1,
        Math.ceil(daysBetween(period.start, window.expectedDate) / periodDays),
      );
      const share = Math.min(remaining, Math.ceil(remaining / periodsUntilExpected));

      bills.push({
        ...common,
        status: 'accruing',
        shelfAmount: share,
        expectedDate: window.expectedDate,
        windowStart: window.start,
        windowEnd: window.end,
        accrual: {
          totalAmount: round2(planningAmount),
          share,
          accruedBefore,
          accruedAfter: round2(accruedBefore + share),
          periodsUntilExpected,
        },
      });
      continue;
    }

    let inPeriod = 0;

    for (const window of expectedOccurrences(stream, period.end)) {
      const closedBefore = dayNumber(window.end) < dayNumber(period.start);
      if (!closedBefore && !rangesOverlap(window, period)) continue;

      bills.push({
        ...common,
        status: closedBefore ? 'carry_over' : 'expected',
        shelfAmount: round2(planningAmount),
        expectedDate: window.expectedDate,
        windowStart: window.start,
        windowEnd: window.end,
        accrual: null,
      });
      inPeriod += 1;
    }

    if (inPeriod === 0) {
      excluded.push({
        streamKey: stream.streamKey,
        displayName: stream.displayName,
        reason:
          dayNumber(stream.lastDate) >= dayNumber(period.start)
            ? 'posted_this_period'
            : 'outside_period',
      });
    }
  }

  // Declared obligations carry an amount and a cadence but no day (§10.6):
  // a monthly one is reserved by the first period that opens in each
  // calendar month, a weekly one by every period, once per week it spans.
  declaredObligations.forEach((obligation, index) => {
    if (obligation.cadence === 'one_time') return;

    const opensMonth = dayOfMonth(period.start) <= periodDays;
    if (obligation.cadence === 'monthly' && !opensMonth) return;

    const multiplier = obligation.cadence === 'weekly' ? WEEKS_PER_MONTH_CEIL(periodDays) : 1;
    const amount = round2(obligation.amount * multiplier);

    bills.push({
      key: `declared:${index}`,
      displayName: obligation.label?.trim() || OBLIGATION_KIND_LABELS[obligation.kind],
      source: 'declared',
      status: 'expected',
      basis: 'declared',
      cadence: obligation.cadence,
      amountClass: null,
      shelfAmount: amount,
      planningAmount: amount,
      amountRange: null,
      expectedDate: null,
      windowStart: null,
      windowEnd: null,
      accrual: null,
    });
  });

  const total = round2(bills.reduce((sum, bill) => sum + bill.shelfAmount, 0));
  const accruedHeld = bills.reduce((sum, bill) => sum + (bill.accrual?.accruedBefore ?? 0), 0);

  let earliestWindowStart: string | null = null;
  for (const bill of bills) {
    if (bill.status === 'accruing' || bill.windowStart === null) continue;
    const start = maxIso(bill.windowStart, period.start);
    earliestWindowStart = earliestWindowStart === null ? start : minIso(earliestWindowStart, start);
  }

  return {
    bills,
    total,
    cashRequired: round2(total + accruedHeld),
    earliestWindowStart,
    excluded,
  };
}

/** Whether a period start is the first one opening in its calendar month, under contiguous equal periods. */
export function periodOpensMonth(period: Period): boolean {
  return parseIsoDate(period.start).day <= periodLengthDays(period);
}
