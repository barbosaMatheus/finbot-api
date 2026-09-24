/**
 * EVALUATE_NUDGES (gameplan note §8, decision 8; cadence note §3): after
 * each sync, at most one fact a day, no advice. Detection is pure; the
 * evaluator reads the ledger, sends one push, and records it.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { addDays, dayNumber, daysBetween } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { median } from '../lib/stats.js';
import type { UserJobPayload } from '../jobs/types.js';
import type { FactsRecurringStream } from '../types/financial-facts.js';
import { loadFactsData, type FactsData } from './financial-facts.service.js';
import { buildActuals, listGradeTransactions, type GradeTransaction } from './gameplan-grade.service.js';
import { primaryIncomeStream } from './gameplan-period.service.js';
import { GAMEPLAN_PUSH, sendGameplanPush, type GameplanPushInput } from './gameplan-push.service.js';
import {
  getLivePeriod,
  insertNudge,
  lastNudgeAt,
  nudgedTransactionIds,
  type GameplanPeriod,
  type NudgeKind,
} from './gameplan-store.service.js';
import { money } from '../llm/templates.js';

/** Unusual: at least this many times the user's median for the merchant or bucket… */
export const UNUSUAL_MEDIAN_MULTIPLE = 3;
/** …and at least this share of the period's free cash. */
export const UNUSUAL_FREE_CASH_SHARE = 0.05;
/** Any single purchase at or above this share of free cash is unusual on its own. */
export const LARGE_FREE_CASH_SHARE = 0.25;
/** Unexpected income: a non-stream deposit at least this share of the typical paycheck… */
export const UNEXPECTED_INCOME_PAYCHECK_SHARE = 0.5;
/** …or this much when there is no income stream. */
export const UNEXPECTED_INCOME_FLOOR = 500;
/** A bill overrun: more than this share or this many dollars over its planning amount. */
export const OVERRUN_SHARE = 0.1;
export const OVERRUN_FLOOR = 25;
/** A posting older than this is stale news, not a nudge. */
export const FRESH_DAYS = 3;
/** Medians need at least this many postings to mean anything. */
const MIN_MEDIAN_SAMPLES = 3;

export type NudgeCandidate = {
  kind: NudgeKind;
  transactionRowId: string | null;
  body: string;
  payload: Record<string, unknown>;
};

export type NudgeDetectionInput = {
  period: GameplanPeriod;
  /** Settled postings from the period start through today. */
  periodTransactions: readonly GradeTransaction[];
  /** The whole ledger, for medians. */
  history: readonly GradeTransaction[];
  streams: readonly FactsRecurringStream[];
  today: string;
  alreadyNudged: ReadonlySet<string>;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function label(txn: GradeTransaction): string {
  return txn.merchantName ?? txn.merchantKey ?? 'a purchase';
}

/**
 * Every nudge the ledger supports right now, most important first: a bill
 * overrun, an unusual purchase, a cap blown before the midpoint, a
 * deposit that is not on any stream.
 */
export function detectNudges(input: NudgeDetectionInput): NudgeCandidate[] {
  const shortlist = input.period.plan;
  if (!shortlist) return [];

  const freeCash = shortlist.freeCash.freeCash;
  const candidates: NudgeCandidate[] = [];
  const freshSince = addDays(input.today, -FRESH_DAYS);
  const fresh = input.periodTransactions.filter(
    (txn) => !txn.pending && dayNumber(txn.date) >= dayNumber(freshSince) && !input.alreadyNudged.has(txn.rowId),
  );

  // Bill overrun (§8, §10.4): an expected bill posted well over its planning amount.
  const merchantOf = new Map<string, string | null>();
  for (const stream of input.streams) merchantOf.set(stream.streamKey, stream.merchantKey ?? null);

  for (const bill of shortlist.shelf.bills) {
    if (bill.source !== 'stream') continue;
    const merchant = merchantOf.get(bill.key);
    if (!merchant) continue;
    for (const txn of fresh) {
      if (txn.amount <= 0 || txn.merchantKey !== merchant) continue;
      const over = round2(txn.amount - bill.planningAmount);
      if (over <= Math.max(bill.planningAmount * OVERRUN_SHARE, OVERRUN_FLOOR)) continue;
      candidates.push({
        kind: 'bill_overrun',
        transactionRowId: txn.rowId,
        body: `${bill.displayName} came in at ${money(txn.amount)}, ${money(over)} over what we set aside.`,
        payload: { bill: bill.key, amount: txn.amount, planningAmount: bill.planningAmount, over },
      });
    }
  }

  // Unusual transaction: 3× the median for that merchant (else bucket) and
  // ≥ 5 % of free cash, or any single one ≥ 25 % of free cash.
  const byMerchant = new Map<string, number[]>();
  const byBucket = new Map<string, number[]>();
  for (const txn of input.history) {
    if (txn.pending || txn.amount <= 0 || txn.role !== 'expense') continue;
    if (txn.merchantKey) byMerchant.set(txn.merchantKey, [...(byMerchant.get(txn.merchantKey) ?? []), txn.amount]);
    if (txn.displayBucket) byBucket.set(txn.displayBucket, [...(byBucket.get(txn.displayBucket) ?? []), txn.amount]);
  }

  // An expected bill's posting is never "unusual": only the overrun rule
  // above speaks for it.
  const billMerchants = new Set<string>();
  for (const bill of shortlist.shelf.bills) {
    const merchant = merchantOf.get(bill.key);
    if (merchant) billMerchants.add(merchant);
  }

  for (const txn of fresh) {
    if (txn.amount <= 0 || (txn.role !== 'expense' && txn.role !== 'unknown_outflow')) continue;
    if (txn.merchantKey && billMerchants.has(txn.merchantKey)) continue;
    if (candidates.some((entry) => entry.transactionRowId === txn.rowId)) continue;

    const merchantSamples = txn.merchantKey ? byMerchant.get(txn.merchantKey) ?? [] : [];
    const bucketSamples = txn.displayBucket ? byBucket.get(txn.displayBucket) ?? [] : [];
    const samples = merchantSamples.length >= MIN_MEDIAN_SAMPLES ? merchantSamples : bucketSamples;
    const typical = samples.length >= MIN_MEDIAN_SAMPLES ? round2(median(samples)) : null;

    const large = freeCash > 0 && txn.amount >= freeCash * LARGE_FREE_CASH_SHARE;
    const unusual =
      typical !== null &&
      txn.amount >= typical * UNUSUAL_MEDIAN_MULTIPLE &&
      freeCash > 0 &&
      txn.amount >= freeCash * UNUSUAL_FREE_CASH_SHARE;

    if (!large && !unusual) continue;

    candidates.push({
      kind: 'unusual_transaction',
      transactionRowId: txn.rowId,
      body: unusual && typical !== null
        ? `${money(txn.amount)} at ${label(txn)} — well above your usual ${money(typical)} there.`
        : `${money(txn.amount)} at ${label(txn)} is a quarter of what was left for this period.`,
      payload: { amount: txn.amount, typical, freeCash },
    });
  }

  // A cap blown before the midpoint.
  const length = daysBetween(input.period.start, input.period.end) + 1;
  const beforeMidpoint = daysBetween(input.period.start, input.today) < length / 2;
  if (beforeMidpoint) {
    const targets = shortlist.plan.map((candidate) => candidate.definition);
    const actuals = buildActuals({
      period: input.period,
      through: input.today,
      targets,
      transactions: input.periodTransactions,
      streams: input.streams,
      balanceAtClose: null,
      awarenessCompleted: false,
    });
    for (const target of targets) {
      if (target.type !== 'spend_cap') continue;
      const spent = actuals.spendByBucket[target.bucket] ?? 0;
      if (spent <= target.cap) continue;
      const blownKey = `blown:${input.period.id}:${target.bucket}`;
      if (input.alreadyNudged.has(blownKey)) continue;
      candidates.push({
        kind: 'target_blown',
        transactionRowId: null,
        body: `${target.bucket} has passed its ${money(target.cap)} cap with half the period still to go.`,
        payload: { bucket: target.bucket, cap: target.cap, spent, key: blownKey },
      });
    }
  }

  // Unexpected income: a deposit that is not on any stream.
  const streamMerchants = new Set(
    input.streams.filter((stream) => stream.direction === 'inflow').map((stream) => stream.merchantKey ?? ''),
  );
  const paycheck = primaryIncomeStream(input.streams, input.today);
  const threshold = paycheck ? paycheck.averageAmount * UNEXPECTED_INCOME_PAYCHECK_SHARE : UNEXPECTED_INCOME_FLOOR;

  for (const txn of fresh) {
    if (txn.amount >= 0 || (txn.role !== 'earned_income' && txn.role !== 'unknown_inflow')) continue;
    if (txn.merchantKey && streamMerchants.has(txn.merchantKey)) continue;
    const amount = Math.abs(txn.amount);
    if (amount < threshold) continue;
    candidates.push({
      kind: 'unexpected_income',
      transactionRowId: txn.rowId,
      body: `${money(amount)} came in from ${label(txn)}, which is not one of your usual deposits.`,
      payload: { amount, threshold },
    });
  }

  return candidates;
}

export type NudgeDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  listTransactions(userId: string, since: string): Promise<GradeTransaction[]>;
  sendPush(input: GameplanPushInput): Promise<unknown>;
  now(): Date;
};

async function defaultDeps(): Promise<NudgeDeps> {
  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    listTransactions: (userId, since) => listGradeTransactions(userId, since),
    sendPush: (input) => sendGameplanPush(input),
    now: () => new Date(),
  };
}

export type NudgeResult = { sent: boolean; kind: NudgeKind | null; skipped: string | null };

export async function evaluateNudges(
  payload: UserJobPayload,
  depsOverride?: Partial<NudgeDeps>,
): Promise<NudgeResult> {
  const deps: NudgeDeps = { ...(await defaultDeps()), ...depsOverride };
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);

  const period = await getLivePeriod(payload.userId, deps.db);
  if (!period || !period.plan) return { sent: false, kind: null, skipped: 'no_plan' };

  // At most one a day (§8).
  const last = await lastNudgeAt(payload.userId, deps.db);
  if (last && last.toISOString().slice(0, 10) === today) {
    return { sent: false, kind: null, skipped: 'one_per_day' };
  }

  const [data, history, nudged] = await Promise.all([
    deps.loadData(payload.userId),
    deps.listTransactions(payload.userId, '1970-01-01'),
    nudgedTransactionIds(payload.userId, deps.db),
  ]);
  const periodTransactions = history.filter((txn) => dayNumber(txn.date) >= dayNumber(period.start));

  const candidates = detectNudges({
    period,
    periodTransactions,
    history,
    streams: data.streams,
    today,
    alreadyNudged: nudged,
  });

  for (const candidate of candidates) {
    const nudgeId = await insertNudge(
      {
        userId: payload.userId,
        periodId: period.id,
        kind: candidate.kind,
        transactionRowId: candidate.transactionRowId,
        payload: candidate.payload,
        body: candidate.body,
        sentAt: now,
      },
      deps.db,
    );
    if (!nudgeId) continue;

    await deps.sendPush({
      userId: payload.userId,
      periodId: period.id,
      notificationKey: `nudge:${nudgeId}`,
      type: GAMEPLAN_PUSH.nudge,
      body: candidate.body,
    });

    logger.info('nudge sent', { userId: payload.userId, periodId: period.id, kind: candidate.kind });
    return { sent: true, kind: candidate.kind, skipped: null };
  }

  return { sent: false, kind: null, skipped: 'nothing_to_say' };
}
