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
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import type { EconomicRole } from '../types/classification.js';

export const RECURRENCE_RULE_VERSION = 'recur-v1';

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
};

export type Cadence =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'irregular';

export type RecurringStream = {
  streamKey: string;
  direction: 'inflow' | 'outflow';
  merchantKey: string;
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
  transactionRowIds: string[];
  evidence: {
    gaps: number[];
    gapRegularity: number;
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
  { cadence: 'annual', days: 365, tolerance: 30 },
];

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

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

    if (occurrences.length < minOccurrences) continue;

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

    if (cadence !== 'irregular' && gapRegularity >= 0.8 && relVariance <= 0.15) {
      confidence = 'high';
    } else if (cadence !== 'irregular' && gapRegularity >= 0.6 && relVariance <= 0.5) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    const direction = streamKey.startsWith('outflow') ? 'outflow' : 'inflow';
    const displayName =
      group.find((input) => input.displayName)?.displayName ??
      group[0]!.merchantKey ??
      'Unknown';

    streams.push({
      streamKey,
      direction,
      merchantKey: group[0]!.merchantKey!,
      displayName,
      cadence,
      cadenceDays: Math.round(medianGap * 100) / 100,
      occurrences: occurrences.length,
      averageAmount: round2(mean),
      lastAmount: round2(amounts[amounts.length - 1]!),
      amountVariance: Math.round(relVariance * 10_000) / 10_000,
      firstDate: occurrences[0]!.date,
      lastDate: occurrences[occurrences.length - 1]!.date,
      confidence,
      transactionRowIds: occurrences.flatMap((occ) => occ.rowIds),
      evidence: {
        gaps,
        gapRegularity: Math.round(gapRegularity * 100) / 100,
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

async function defaultListInputs(userId: string): Promise<RecurrenceInput[]> {
  const { rows } = await pool.query<{
    row_id: string;
    merchant_normalized: string | null;
    merchant_name: string | null;
    name: string | null;
    amount: string;
    date: string;
    pending: boolean;
    economic_role: EconomicRole;
  }>(
    `SELECT t.id AS row_id, t.merchant_normalized, t.merchant_name, t.name,
            t.amount::text AS amount, t.date::text AS date, t.pending,
            c.economic_role
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     WHERE t.user_id = $1 AND t.is_removed = FALSE`,
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
         transaction_row_ids, evidence, rule_version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date,
               $13::date, $14, $15::uuid[], $16::jsonb, $17)
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
