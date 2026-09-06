/**
 * REFRESH_USER_ANALYSIS: a finished user's routine sync. Onboarding's
 * pipeline never runs again for a confirmed run (it would re-lock the app
 * shell), yet the plan needs fresh streams after every sync commit: the
 * live shelf (§10.4), the payday detector (cadence note §2) and the nudges
 * (§8) all read them. So the three derivation stages run here in-process,
 * then the payday check and the nudge evaluation follow.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { dayNumber } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import type { GradePeriodJobPayload, UserAnalysisJobPayload, UserJobPayload } from '../jobs/types.js';
import type { FactsRecurringStream } from '../types/financial-facts.js';
import { classifyUserTransactions } from './classification.service.js';
import { loadFactsData } from './financial-facts.service.js';
import { getLivePeriod, type GameplanPeriod } from './gameplan-store.service.js';
import { primaryIncomeStream } from './gameplan-period.service.js';
import { getLatestRun } from './onboarding-lifecycle.service.js';
import { defaultListLinkable, reconcileUserTransfers } from './reconciliation.service.js';
import { defaultListInputs, detectUserRecurring } from './recurrence.service.js';
import { listUserTransactions } from './transaction-store.service.js';

/** A payday posting must be within this share of the stream's average to open a period. */
export const PAYDAY_AMOUNT_TOLERANCE = 0.25;

export type RefreshDeps = {
  db: Queryable;
  classify(payload: UserAnalysisJobPayload): Promise<unknown>;
  reconcile(payload: UserAnalysisJobPayload): Promise<unknown>;
  recur(payload: UserAnalysisJobPayload): Promise<unknown>;
  loadStreams(userId: string): Promise<FactsRecurringStream[]>;
  enqueueGrade(payload: GradePeriodJobPayload): Promise<unknown>;
  enqueueNudges(payload: UserJobPayload): Promise<unknown>;
  now(): Date;
};

async function defaultDeps(): Promise<RefreshDeps> {
  const enqueue = await import('../jobs/enqueue.js');
  const noChain = async () => null;

  return {
    db: pool,
    classify: (payload) =>
      classifyUserTransactions(payload, {
        db: pool,
        listTransactions: (userId) => listUserTransactions(userId, { includePending: true }),
        enqueueNextStage: noChain,
      }),
    reconcile: (payload) =>
      reconcileUserTransfers(payload, { db: pool, listLinkable: defaultListLinkable, enqueueNextStage: noChain }),
    recur: (payload) =>
      detectUserRecurring(payload, { db: pool, listInputs: defaultListInputs, enqueueNextStage: noChain }),
    loadStreams: async (userId) => (await loadFactsData(userId)).streams,
    enqueueGrade: (payload) => enqueue.enqueueGradePeriod(payload),
    enqueueNudges: (payload) => enqueue.enqueueEvaluateNudges(payload),
    now: () => new Date(),
  };
}

export type PaydayDetection = { streamKey: string; date: string; amount: number } | null;

/**
 * A new posting on the primary income stream after the period opened,
 * close enough to the usual amount, is a payday (cadence note §2). Bonuses
 * and secondary streams never open a period.
 */
export function detectPayday(
  period: GameplanPeriod,
  streams: readonly FactsRecurringStream[],
  today: string,
): PaydayDetection {
  if (period.anchorMode !== 'payday') return null;

  const stream = primaryIncomeStream(streams, today);
  if (!stream) return null;
  if (dayNumber(stream.lastDate) <= dayNumber(period.start)) return null;
  if (dayNumber(stream.lastDate) > dayNumber(today)) return null;

  const tolerance = stream.averageAmount * PAYDAY_AMOUNT_TOLERANCE;
  if (Math.abs(stream.lastAmount - stream.averageAmount) > tolerance) return null;

  return { streamKey: stream.streamKey, date: stream.lastDate, amount: stream.lastAmount };
}

export type RefreshResult = {
  status: 'refreshed' | 'skipped';
  paydayDetected: boolean;
};

export async function refreshUserAnalysis(
  payload: UserJobPayload,
  depsOverride?: Partial<RefreshDeps>,
): Promise<RefreshResult> {
  const deps: RefreshDeps = { ...(await defaultDeps()), ...depsOverride };

  const latest = await getLatestRun(payload.userId, deps.db);
  if (latest?.status !== 'confirmed') {
    logger.info('user refresh skipped; onboarding not confirmed', {
      userId: payload.userId,
      runStatus: latest?.status ?? 'missing',
    });
    return { status: 'skipped', paydayDetected: false };
  }

  const stagePayload: UserAnalysisJobPayload = { userId: payload.userId, analysisRunId: latest.id };
  await deps.classify(stagePayload);
  await deps.reconcile(stagePayload);
  await deps.recur(stagePayload);

  const today = deps.now().toISOString().slice(0, 10);
  const period = await getLivePeriod(payload.userId, deps.db);
  let paydayDetected = false;

  if (period) {
    const streams = await deps.loadStreams(payload.userId);
    const payday = detectPayday(period, streams, today);

    if (payday) {
      paydayDetected = true;
      logger.info('payday detected', {
        userId: payload.userId,
        periodId: period.id,
        streamKey: payday.streamKey,
        date: payday.date,
      });
      await deps.enqueueGrade({
        userId: payload.userId,
        periodId: period.id,
        kind: 'final',
        reason: 'payday',
        paydayDate: payday.date,
        paydayAmount: payday.amount,
      });
    }
  }

  await deps.enqueueNudges({ userId: payload.userId });

  return { status: 'refreshed', paydayDetected };
}
