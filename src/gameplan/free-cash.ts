/**
 * Free cash for the period (§2 of the gameplan note): what is left of the
 * period's income after the bill shelf, the essential floor and any
 * confirmed one-time costs, plus the cash check that catches the user who
 * is overdrawn the day after payday.
 */

import { rangesOverlap } from '../lib/dates.js';
import { isStreamStale } from '../lib/streams.js';
import type { FactsRecurringStream, FinancialFacts } from '../types/financial-facts.js';
import { billBasis, expectedOccurrences, periodLengthDays } from './expected-bills.js';
import type { BillShelf, FreeCash, IncomeSource, OneTimeCost, Period, ShortlistInput } from './types.js';

export const DAYS_PER_MONTH = 30.44;

/**
 * Variable essentials the plan never cuts (§2). Their historical period
 * average is the floor. Bills (rent, utilities) are not here: they sit on
 * the shelf as streams, and counting their bucket here would reserve them
 * twice.
 */
export const ESSENTIAL_BUCKETS: ReadonlySet<string> = new Set(['Groceries', 'Fuel', 'Transportation']);

/**
 * Buckets a spend cap is never set on: the essentials above, buckets whose
 * spend is bills already on the shelf, and buckets outside the user's
 * day-to-day choice.
 */
export const NEVER_CAPPED_BUCKETS: ReadonlySet<string> = new Set([
  ...ESSENTIAL_BUCKETS,
  'Housing & Utilities',
  'Medical',
  'Fees & Interest',
  'Government & Nonprofit',
  'Uncategorized',
]);

/**
 * Buckets whose erratic streams are essential spend the plan never cuts —
 * a utility paid with whatever was left, a recurring pharmacy run. Not the
 * floor buckets themselves: those are already counted from category totals.
 */
export const ESSENTIAL_STREAM_BUCKETS: ReadonlySet<string> = new Set(['Housing & Utilities', 'Medical']);

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

/** A stream's average posting normalized to a month. */
export function streamMonthlyAmount(amount: number, cadenceDays: number): number {
  return cadenceDays > 0 ? round2(amount * (DAYS_PER_MONTH / cadenceDays)) : 0;
}

/**
 * The bill streams that live in a bucket: what a spend cap on that bucket
 * leaves out of its base, since the shelf already reserves for them.
 */
export function billStreamsInBucket(
  streams: readonly FactsRecurringStream[],
  bucket: string,
  today: string,
): Array<{ streamKey: string; monthlyAmount: number }> {
  const bills: Array<{ streamKey: string; monthlyAmount: number }> = [];

  for (const stream of streams) {
    if (stream.direction !== 'outflow' || stream.dominantBucket !== bucket) continue;
    if (billBasis(stream) === null || isStreamStale(stream, today)) continue;
    if (stream.amountClass === 'erratic' || stream.planningAmount === null) continue;
    bills.push({
      streamKey: stream.streamKey,
      monthlyAmount: streamMonthlyAmount(stream.planningAmount, stream.cadenceDays),
    });
  }

  return bills;
}

/** A monthly figure scaled to the period's length. */
export function scaleMonthlyToPeriod(monthly: number, period: Period): number {
  return round2(monthly * (periodLengthDays(period) / DAYS_PER_MONTH));
}

/** Historical spend in a bucket, scaled to the period; 0 when the bucket is absent. */
export function periodAverageFor(facts: FinancialFacts, bucket: string, period: Period): number {
  const total = facts.spend.categoryTotals.find((entry) => entry.bucket === bucket);
  return total ? scaleMonthlyToPeriod(total.monthlyAverage, period) : 0;
}

/** Whether an inflow stream is income the plan may count on (same rule as the facts engine). */
export function isIncomeStream(stream: FactsRecurringStream): boolean {
  if (stream.direction !== 'inflow' || stream.userStatus === 'dismissed') return false;
  if (stream.userStatus === 'confirmed') return true;
  return (
    (stream.dominantRole ?? null) === 'earned_income' &&
    (stream.confidence === 'high' || stream.confidence === 'medium')
  );
}

/**
 * Income expected inside the period from streams other than the one that
 * opened it. Each posting counts at the lower of its last and average
 * amount: reserve for the low side of income, the way bills reserve for
 * the high side.
 */
export function expectedStreamIncome(
  streams: readonly FactsRecurringStream[],
  period: Period,
  today: string,
  excludeStreamKey: string | null,
): number {
  let total = 0;

  for (const stream of streams) {
    if (!isIncomeStream(stream) || stream.streamKey === excludeStreamKey) continue;
    if (isStreamStale(stream, today)) continue;

    const perPosting = Math.min(stream.lastAmount, stream.averageAmount);
    for (const window of expectedOccurrences(stream, period.end)) {
      if (rangesOverlap({ start: window.expectedDate, end: window.expectedDate }, period)) {
        total += perPosting;
      }
    }
  }

  return round2(total);
}

/**
 * Income in the period (§2). Payday users: the paycheck that opened the
 * period plus other streams expected before it ends. Fixed-day users: the
 * streams expected in the period, else the monthly estimate scaled down —
 * the review has not yet proposed an income floor from the lowest recent
 * months, so the estimate stands in and is labelled as such.
 */
export function incomeInPeriod(input: ShortlistInput): { amount: number; source: IncomeSource } {
  const { period, streams, today } = input;

  if (period.trigger === 'payday' && input.openingPaycheck !== null && input.openingPaycheck > 0) {
    const others = expectedStreamIncome(streams, period, today, input.primaryIncomeStreamKey);
    return { amount: round2(input.openingPaycheck + others), source: 'opening_paycheck' };
  }

  const fromStreams = expectedStreamIncome(streams, period, today, null);
  if (fromStreams > 0) return { amount: fromStreams, source: 'streams' };

  const estimate = scaleMonthlyToPeriod(input.facts.income.monthlyIncomeEstimate, period);
  return estimate > 0 ? { amount: estimate, source: 'estimate' } : { amount: 0, source: 'none' };
}

/**
 * Essential floor: the historical period average of the essential buckets,
 * plus erratic streams in essential buckets (§10.3) — never reduced (§2).
 */
export function essentialFloor(
  facts: FinancialFacts,
  period: Period,
  streams: readonly FactsRecurringStream[] = [],
  today: string | null = null,
): { total: number; buckets: FreeCash['essentialBuckets']; streams: FreeCash['essentialStreams'] } {
  const buckets: FreeCash['essentialBuckets'] = [];

  for (const entry of facts.spend.categoryTotals) {
    if (!ESSENTIAL_BUCKETS.has(entry.bucket)) continue;
    const periodAverage = scaleMonthlyToPeriod(entry.monthlyAverage, period);
    if (periodAverage > 0) buckets.push({ bucket: entry.bucket, periodAverage });
  }

  const essentialStreams: FreeCash['essentialStreams'] = [];

  for (const stream of streams) {
    if (stream.direction !== 'outflow' || stream.userStatus === 'dismissed') continue;
    if (stream.amountClass !== 'erratic') continue;
    if (!stream.dominantBucket || !ESSENTIAL_STREAM_BUCKETS.has(stream.dominantBucket)) continue;
    if (today !== null && isStreamStale(stream, today)) continue;

    const periodAverage = scaleMonthlyToPeriod(
      streamMonthlyAmount(stream.averageAmount, stream.cadenceDays),
      period,
    );
    if (periodAverage > 0) {
      essentialStreams.push({ streamKey: stream.streamKey, displayName: stream.displayName, periodAverage });
    }
  }

  const total =
    buckets.reduce((sum, entry) => sum + entry.periodAverage, 0) +
    essentialStreams.reduce((sum, entry) => sum + entry.periodAverage, 0);

  return { total: round2(total), buckets, streams: essentialStreams };
}

/**
 * free_cash = income_in_period − bill_shelf − essential_floor − one_time_costs
 * cash_check = available_balance − what the balance must hold for the bills
 *
 * A negative cash check makes the period tight regardless of the flow
 * figure; so does free cash at or below zero. Either way no money-commit
 * target is generated (§2).
 */
export function computeFreeCash(input: ShortlistInput, shelf: BillShelf): FreeCash {
  const income = incomeInPeriod(input);
  const incomeAmount = round2(Math.max(0, income.amount + (input.incomeAdjustment ?? 0)));
  const floor = essentialFloor(input.facts, input.period, input.streams, input.today);
  const oneTime = round2(sumOneTime(input.oneTimeCosts));

  const freeCash = round2(incomeAmount - shelf.total - floor.total - oneTime);

  const availableBalance = input.facts.balances.accountCount > 0
    ? input.facts.balances.availableToSpend
    : null;
  const cashCheck = availableBalance === null ? null : round2(availableBalance - shelf.cashRequired);

  const tightReason: FreeCash['tightReason'] =
    cashCheck !== null && cashCheck < 0 ? 'cash_check' : freeCash <= 0 ? 'no_free_cash' : null;

  return {
    incomeInPeriod: incomeAmount,
    incomeSource: income.source,
    shelf: shelf.total,
    essentialFloor: floor.total,
    essentialBuckets: floor.buckets,
    essentialStreams: floor.streams,
    oneTimeCosts: oneTime,
    freeCash,
    availableBalance,
    cashCheck,
    tight: tightReason !== null,
    tightReason,
  };
}

function sumOneTime(costs: readonly OneTimeCost[]): number {
  return costs.reduce((sum, cost) => sum + Math.max(0, cost.amount), 0);
}
