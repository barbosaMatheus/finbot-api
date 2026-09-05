/**
 * Local recurring-stream detection (API-010).
 *
 * Groups settled economic activity by direction + normalized merchant,
 * measures cadence with median gaps and permitted variance (not exact
 * dates), measures amount variance for variable bills, and emits evidence
 * with an explicit confidence band. Low-confidence streams are reported as
 * low confidence — never silently promoted to "subscription".
 *
 * Internal transfers and card-payment pairs are excluded by construction:
 * only economic roles participate.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { median, percentile } from '../lib/stats.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import type { EconomicRole } from '../types/classification.js';
import type { AmountClass } from '../types/financial-facts.js';

export type { AmountClass };

export const RECURRENCE_RULE_VERSION = 'recur-v3';

/** Roles that can form outgoing recurring streams (bills, subscriptions). */
const OUTFLOW_STREAM_ROLES: ReadonlySet<EconomicRole> = new Set([
  'expense',
  'interest_or_fee',
  'debt_principal_payment',
  'unknown_outflow',
]);

/** Roles that can form incoming recurring streams (payroll, benefits). */
const INFLOW_STREAM_ROLES: ReadonlySet<EconomicRole> = new Set([
  'earned_income',
  'unknown_inflow',
]);

export type RecurrenceInput = {
  rowId: string;
  merchantKey: string | null;
  displayName: string | null;
  /** Plaid sign: positive = money out. */
  amount: number;
  date: string;
  pending: boolean;
  role: EconomicRole;
  /** The classifier's display bucket, when the member is economic spend. */
  displayBucket?: string | null;
};

export type Cadence =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'irregular';

export type RecurringStream = {
  streamKey: string;
  direction: 'inflow' | 'outflow';
  merchantKey: string;
  /** Most frequent economic role among the stream's member transactions. */
  dominantRole: EconomicRole;
  /**
   * Most frequent display bucket among the members, or null when none was
   * classified as spend. The plan uses it to keep a bill stream out of its
   * bucket's cap average and to let an erratic essential stream join the
   * floor (§10.3).
   */
  dominantBucket: string | null;
  displayName: string;
  cadence: Cadence;
  cadenceDays: number;
  occurrences: number;
  /** Mean absolute amount, positive. */
  averageAmount: number;
  lastAmount: number;
  /** Relative amount variation (stddev / mean), 0 = perfectly fixed. */
  amountVariance: number;
  firstDate: string;
  lastDate: string;
  confidence: 'high' | 'medium' | 'low';
  /**
   * Median calendar day the stream lands on, for cadences pinned to the
   * calendar (monthly and longer). Null for weekly, biweekly and irregular
   * streams, whose anchor is the gap from the last posting.
   */
  anchorDayOfMonth: number | null;
  /**
   * Half-width of the expected window in days: the 90th percentile of
   * |gap − median gap| over the stream's history, floored at 2. An autopay
   * gets ±2; a bill paid by hand gets whatever its habit shows.
   */
  dateJitterDays: number;
  amountClass: AmountClass;
  /**
   * What a plan sets aside for the next posting. Fixed → the last amount (a
   * rent increase shows there first); variable → the higher of the last
   * amount and the 75th percentile of recent amounts (reserve for the high
   * side); erratic → null, not a bill. Null for inflows: a paycheck is not
   * reserved for, and over-estimating income is the wrong asymmetry.
   */
  planningAmount: number | null;
  transactionRowIds: string[];
  evidence: {
    gaps: number[];
    gapRegularity: number;
    /** Most recent occurrence amounts (oldest first, at most 24), so the planning percentile is replayable. */
    amounts: number[];
  };
};

export type RecurrenceOptions = {
  minOccurrences?: number;
};

const CADENCE_CLASSES: Array<{ cadence: Cadence; days: number; tolerance: number }> = [
  { cadence: 'weekly', days: 7, tolerance: 2 },
  { cadence: 'biweekly', days: 14, tolerance: 3 },
  { cadence: 'monthly', days: 30.4, tolerance: 6 },
  { cadence: 'quarterly', days: 91, tolerance: 14 },
  { cadence: 'semiannual', days: 182, tolerance: 21 },
  { cadence: 'annual', days: 365, tolerance: 30 },
];

/**
 * Cadences long enough that three occurrences would need a year or more of
 * history. Two matching outflows at one of these gaps may form a candidate.
 */
const LONG_CADENCES: ReadonlySet<Cadence> = new Set(['quarterly', 'semiannual', 'annual']);

/** Two occurrences form a candidate only when their amounts agree this closely. */
const SPARSE_AMOUNT_TOLERANCE = 0.1;

/** Cadences pinned to a calendar day rather than to the gap from the last posting. */
const CALENDAR_ANCHORED_CADENCES: ReadonlySet<Cadence> = new Set([
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
]);

/** Relative variance at or below which a stream's amount is fixed. */
export const FIXED_AMOUNT_MAX_VARIANCE = 0.05;
/** Relative variance at or below which a stream's amount is variable; beyond it, erratic. */
export const VARIABLE_AMOUNT_MAX_VARIANCE = 0.5;
/** Narrowest window a bill ever gets, even with perfectly regular gaps. */
export const MIN_DATE_JITTER_DAYS = 2;
/** How many recent amounts the evidence keeps for the planning percentile. */
export const EVIDENCE_AMOUNTS_LIMIT = 24;
const PLANNING_AMOUNT_PERCENTILE = 0.75;
const DATE_JITTER_PERCENTILE = 0.9;

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function classifyCadence(medianGap: number): { cadence: Cadence; tolerance: number } {
  for (const cls of CADENCE_CLASSES) {
    if (Math.abs(medianGap - cls.days) <= cls.tolerance) {
      return { cadence: cls.cadence, tolerance: cls.tolerance };
    }
  }

  return { cadence: 'irregular', tolerance: 0 };
}

export function classifyAmount(relativeVariance: number): AmountClass {
  if (relativeVariance <= FIXED_AMOUNT_MAX_VARIANCE) return 'fixed';
  if (relativeVariance <= VARIABLE_AMOUNT_MAX_VARIANCE) return 'variable';
  return 'erratic';
}

/**
 * Median day-of-month of a set of dates. A bill pinned to the 1st that
 * posts on the 31st whenever the 1st falls on a weekend has members on
 * both sides of the month boundary, and a plain median of [31, 1, 1, 31]
 * would say the 16th. So the days are also read "unwrapped" — the early
 * days pushed past 31 — and whichever reading is tighter wins.
 */
export function medianDayOfMonth(dates: readonly string[]): number {
  const days = dates.map((iso) => Number(iso.slice(8, 10)));
  const unwrapped = days.map((day) => (day <= 15 ? day + 31 : day));

  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
  const chosen = spread(unwrapped) < spread(days) ? unwrapped : days;

  const mid = Math.round(median(chosen));
  return mid > 31 ? mid - 31 : mid;
}

/** The 90th percentile of |gap − median gap|, in whole days, floored at 2. */
export function dateJitterDays(gaps: readonly number[], medianGap: number): number {
  if (gaps.length === 0) return MIN_DATE_JITTER_DAYS;

  const deviations = gaps.map((gap) => Math.abs(gap - medianGap));
  return Math.max(MIN_DATE_JITTER_DAYS, Math.ceil(percentile(deviations, DATE_JITTER_PERCENTILE)));
}

/** Planning amount by class (§10.3 of the gameplan note); null when nothing is reserved. */
export function planningAmountFor(
  amountClass: AmountClass,
  lastAmount: number,
  recentAmounts: readonly number[],
): number | null {
  switch (amountClass) {
    case 'fixed':
      return round2(lastAmount);
    case 'variable':
      return round2(Math.max(lastAmount, percentile(recentAmounts, PLANNING_AMOUNT_PERCENTILE)));
    case 'erratic':
      return null;
  }
}

/**
 * Long-cadence bills — insurance premiums, HOA dues, annual fees — are the
 * largest single hits a plan can be surprised by, and they take years to
 * reach three occurrences. Two settled OUTFLOWS to the same merchant, a gap
 * in a quarterly-or-longer class and amounts within 10 % of each other are
 * surfaced as a LOW-confidence candidate for the user to confirm on the
 * review. Nothing else this thin becomes a stream; inflows never do (a
 * bonus twice a year must not become income through this door).
 */
function isSparseLongCadenceCandidate(
  occurrences: ReadonlyArray<{ date: string; amount: number }>,
  direction: 'inflow' | 'outflow',
): boolean {
  if (direction !== 'outflow' || occurrences.length !== 2) return false;

  const [first, second] = occurrences;
  const gap = parseDay(second!.date) - parseDay(first!.date);
  if (!LONG_CADENCES.has(classifyCadence(gap).cadence)) return false;

  const larger = Math.max(first!.amount, second!.amount);
  if (larger <= 0) return false;

  return Math.abs(first!.amount - second!.amount) / larger <= SPARSE_AMOUNT_TOLERANCE;
}

/**
 * Detect recurring streams from classified activity. Pure and
 * deterministic; sorted by descending average amount within direction.
 */
export function detectRecurringStreams(
  inputs: readonly RecurrenceInput[],
  options: RecurrenceOptions = {},
): RecurringStream[] {
  const minOccurrences = options.minOccurrences ?? 3;

  const groups = new Map<string, RecurrenceInput[]>();

  for (const input of inputs) {
    if (input.pending) continue;
    if (!input.merchantKey) continue;

    const direction =
      input.amount > 0 && OUTFLOW_STREAM_ROLES.has(input.role)
        ? 'outflow'
        : input.amount < 0 && INFLOW_STREAM_ROLES.has(input.role)
          ? 'inflow'
          : null;

    if (!direction) continue;

    const key = `${direction}:${input.merchantKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(input);
    else groups.set(key, [input]);
  }

  const streams: RecurringStream[] = [];

  for (const [streamKey, group] of groups) {
    // Collapse same-day postings into one occurrence: three coffees in one
    // day are one shopping trip, not a thrice-daily subscription.
    const byDay = new Map<string, RecurrenceInput[]>();

    for (const input of group) {
      const bucket = byDay.get(input.date);
      if (bucket) bucket.push(input);
      else byDay.set(input.date, [input]);
    }

    const occurrences = [...byDay.entries()]
      .map(([date, txns]) => ({
        date,
        amount: txns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0),
        rowIds: txns.map((txn) => txn.rowId),
      }))
      .sort((a, b) => parseDay(a.date) - parseDay(b.date));

    const direction = streamKey.startsWith('outflow') ? 'outflow' : 'inflow';
    const sparse = occurrences.length < minOccurrences;
    if (sparse && !isSparseLongCadenceCandidate(occurrences, direction)) continue;

    const gaps: number[] = [];
    for (let i = 1; i < occurrences.length; i += 1) {
      gaps.push(parseDay(occurrences[i]!.date) - parseDay(occurrences[i - 1]!.date));
    }

    const medianGap = median(gaps);
    if (medianGap <= 0) continue;

    const { cadence, tolerance } = classifyCadence(medianGap);

    const gapRegularity =
      cadence === 'irregular'
        ? 0
        : gaps.filter((gap) => Math.abs(gap - medianGap) <= tolerance).length / gaps.length;

    const amounts = occurrences.map((occ) => occ.amount);
    const mean = amounts.reduce((sum, value) => sum + value, 0) / amounts.length;
    const variance =
      amounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / amounts.length;
    const relVariance = mean === 0 ? 0 : Math.sqrt(variance) / mean;

    let confidence: RecurringStream['confidence'];

    if (sparse) {
      // One gap is trivially "regular"; two matching amounts are trivially
      // "fixed". The evidence is thin by construction, so say so.
      confidence = 'low';
    } else if (cadence !== 'irregular' && gapRegularity >= 0.8 && relVariance <= 0.15) {
      confidence = 'high';
    } else if (cadence !== 'irregular' && gapRegularity >= 0.6 && relVariance <= 0.5) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    const displayName =
      group.find((input) => input.displayName)?.displayName ??
      group[0]!.merchantKey ??
      'Unknown';

    // The stream's dominant role — what most of its members were classified
    // as. Downstream, only earned_income inflow streams may feed the income
    // estimate; a stream of unknown_inflow deposits stays out of it.
    const roleCounts = new Map<EconomicRole, number>();

    for (const input of group) {
      roleCounts.set(input.role, (roleCounts.get(input.role) ?? 0) + 1);
    }

    const dominantRole = [...roleCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]![0];

    const bucketCounts = new Map<string, number>();
    for (const input of group) {
      if (input.displayBucket) {
        bucketCounts.set(input.displayBucket, (bucketCounts.get(input.displayBucket) ?? 0) + 1);
      }
    }
    const dominantBucket =
      [...bucketCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      null;

    // What a plan needs in order to EXPECT the next posting rather than
    // know it: where in the calendar it lands, how wide the window is, and
    // how much to set aside. Classified from the stored (rounded) variance
    // so the class and the number it was read from always agree.
    const amountVariance = Math.round(relVariance * 10_000) / 10_000;
    const lastAmount = round2(amounts[amounts.length - 1]!);
    const recentAmounts = amounts.slice(-EVIDENCE_AMOUNTS_LIMIT).map(round2);
    const amountClass = classifyAmount(amountVariance);

    streams.push({
      streamKey,
      direction,
      merchantKey: group[0]!.merchantKey!,
      dominantRole,
      dominantBucket,
      displayName,
      cadence,
      cadenceDays: Math.round(medianGap * 100) / 100,
      occurrences: occurrences.length,
      averageAmount: round2(mean),
      lastAmount,
      amountVariance,
      firstDate: occurrences[0]!.date,
      lastDate: occurrences[occurrences.length - 1]!.date,
      confidence,
      anchorDayOfMonth: CALENDAR_ANCHORED_CADENCES.has(cadence)
        ? medianDayOfMonth(occurrences.map((occ) => occ.date))
        : null,
      dateJitterDays: dateJitterDays(gaps, medianGap),
      amountClass,
      planningAmount:
        direction === 'outflow' ? planningAmountFor(amountClass, lastAmount, recentAmounts) : null,
      transactionRowIds: occurrences.flatMap((occ) => occ.rowIds),
      evidence: {
        gaps,
        gapRegularity: Math.round(gapRegularity * 100) / 100,
        amounts: recentAmounts,
      },
    });
  }

  return streams.sort(
    (a, b) =>
      a.direction.localeCompare(b.direction) || b.averageAmount - a.averageAmount,
  );
}

// ---------------------------------------------------------------------------
// Pipeline job
// ---------------------------------------------------------------------------

export type RecurrenceDeps = {
  db: Queryable;
  listInputs(userId: string): Promise<RecurrenceInput[]>;
  enqueueNextStage(payload: UserAnalysisJobPayload): Promise<unknown>;
};

/** The detector's default input read; exported so the post-onboarding refresh can run the stage in-process. */
export async function defaultListInputs(userId: string): Promise<RecurrenceInput[]> {
  const { rows } = await pool.query<{
    row_id: string;
    merchant_normalized: string | null;
    merchant_name: string | null;
    name: string | null;
    amount: string;
    date: string;
    pending: boolean;
    economic_role: EconomicRole;
    display_bucket: string | null;
  }>(
    `WITH primary_currency AS (
       SELECT t.iso_currency_code AS code
       FROM plaid_transactions t
       JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
       WHERE t.user_id = $1 AND t.is_removed = FALSE
         AND t.iso_currency_code IS NOT NULL
       GROUP BY t.iso_currency_code
       ORDER BY COUNT(*) DESC, t.iso_currency_code
       LIMIT 1
     )
     SELECT t.id AS row_id, t.merchant_normalized, t.merchant_name, t.name,
            t.amount::text AS amount, t.date::text AS date, t.pending,
            c.economic_role, c.display_bucket
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     -- Same active-item filter as the facts read, and only the primary
     -- currency: a stream must never mix currencies or count postings the
     -- facts engine cannot see.
     JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
     WHERE t.user_id = $1 AND t.is_removed = FALSE
       AND (t.iso_currency_code IS NULL
            OR t.iso_currency_code = (SELECT code FROM primary_currency))`,
    [userId],
  );

  return rows.map((row) => ({
    rowId: row.row_id,
    merchantKey: row.merchant_normalized,
    displayName: row.merchant_name ?? row.name,
    amount: Number(row.amount),
    date: row.date,
    pending: row.pending,
    role: row.economic_role,
    displayBucket: row.display_bucket,
  }));
}

async function defaultDeps(): Promise<RecurrenceDeps> {
  const [enqueue, jobs] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('../jobs/types.js'),
  ]);

  return {
    db: pool,
    listInputs: defaultListInputs,
    enqueueNextStage: (payload) =>
      enqueue.enqueueAnalysisStage(jobs.JOB.BUILD_FINANCIAL_FACTS, payload),
  };
}

/**
 * DETECT_USER_RECURRING: recompute streams, upsert by stable stream key so
 * user confirmations survive, remove streams that vanished, then chain the
 * facts build.
 */
export async function detectUserRecurring(
  payload: UserAnalysisJobPayload,
  depsOverride?: RecurrenceDeps,
): Promise<{ streams: number }> {
  const deps = depsOverride ?? (await defaultDeps());

  const inputs = await deps.listInputs(payload.userId);
  const streams = detectRecurringStreams(inputs);

  for (const stream of streams) {
    await deps.db.query(
      `INSERT INTO recurring_streams (
         user_id, stream_key, direction, merchant_key, display_name, cadence,
         cadence_days, occurrences, average_amount, last_amount,
         amount_variance, first_date, last_date, confidence,
         transaction_row_ids, evidence, rule_version, dominant_role,
         anchor_day_of_month, date_jitter_days, amount_class, planning_amount,
         dominant_bucket
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date,
               $13::date, $14, $15::uuid[], $16::jsonb, $17, $18,
               $19, $20, $21, $22, $23)
       ON CONFLICT (user_id, stream_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         cadence = EXCLUDED.cadence,
         cadence_days = EXCLUDED.cadence_days,
         occurrences = EXCLUDED.occurrences,
         average_amount = EXCLUDED.average_amount,
         last_amount = EXCLUDED.last_amount,
         amount_variance = EXCLUDED.amount_variance,
         first_date = EXCLUDED.first_date,
         last_date = EXCLUDED.last_date,
         confidence = EXCLUDED.confidence,
         transaction_row_ids = EXCLUDED.transaction_row_ids,
         evidence = EXCLUDED.evidence,
         rule_version = EXCLUDED.rule_version,
         dominant_role = EXCLUDED.dominant_role,
         anchor_day_of_month = EXCLUDED.anchor_day_of_month,
         date_jitter_days = EXCLUDED.date_jitter_days,
         amount_class = EXCLUDED.amount_class,
         planning_amount = EXCLUDED.planning_amount,
         dominant_bucket = EXCLUDED.dominant_bucket,
         updated_at = NOW()`,
      [
        payload.userId,
        stream.streamKey,
        stream.direction,
        stream.merchantKey,
        stream.displayName,
        stream.cadence,
        stream.cadenceDays,
        stream.occurrences,
        stream.averageAmount,
        stream.lastAmount,
        stream.amountVariance,
        stream.firstDate,
        stream.lastDate,
        stream.confidence,
        stream.transactionRowIds,
        JSON.stringify(stream.evidence),
        RECURRENCE_RULE_VERSION,
        stream.dominantRole,
        stream.anchorDayOfMonth,
        stream.dateJitterDays,
        stream.amountClass,
        stream.planningAmount,
        stream.dominantBucket,
      ],
    );
  }

  await deps.db.query(
    `DELETE FROM recurring_streams
     WHERE user_id = $1 AND NOT (stream_key = ANY($2::text[]))`,
    [payload.userId, streams.map((stream) => stream.streamKey)],
  );

  logger.info('recurrence detection complete', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    streams: streams.length,
  });

  await deps.enqueueNextStage(payload);

  return { streams: streams.length };
}
