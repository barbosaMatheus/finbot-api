/**
 * Typed enqueue helpers — the only way API code puts work on the queue.
 *
 * Debounce keys make duplicate triggers cheap: several webhook events for one
 * Item collapse into one sync job, and several Item completions collapse into
 * one user-level analysis rebuild. Handlers are idempotent regardless; the
 * debounce is load-shedding, not correctness.
 */

import { logger } from '../lib/logger.js';
import { getBoss } from './boss.js';
import { JOB, type BossLike, type ItemJobPayload, type UserAnalysisJobPayload } from './types.js';

/** Seconds within which duplicate Item-sync triggers collapse into one job. */
const ITEM_SYNC_DEBOUNCE_SECONDS = 15;

/** Seconds within which several Item updates produce one analysis rebuild. */
const USER_ANALYSIS_DEBOUNCE_SECONDS = 20;

async function resolveBoss(boss?: BossLike): Promise<BossLike> {
  return boss ?? ((await getBoss()) as unknown as BossLike);
}

export async function enqueueInitializeItemSync(
  payload: ItemJobPayload,
  boss?: BossLike,
): Promise<string | null> {
  const instance = await resolveBoss(boss);

  const jobId = await instance.send(JOB.INITIALIZE_ITEM_SYNC, payload, {
    singletonKey: payload.plaidItemRowId,
  });

  logger.info('job enqueued', {
    jobType: JOB.INITIALIZE_ITEM_SYNC,
    jobId,
    itemId: payload.plaidItemRowId,
    userId: payload.userId,
  });

  return jobId;
}

export async function enqueueItemSync(
  payload: ItemJobPayload,
  boss?: BossLike,
): Promise<string | null> {
  const instance = await resolveBoss(boss);

  const jobId = await instance.sendDebounced(
    JOB.SYNC_ITEM_TRANSACTIONS,
    payload,
    null,
    ITEM_SYNC_DEBOUNCE_SECONDS,
    payload.plaidItemRowId,
  );

  logger.info('job enqueued', {
    jobType: JOB.SYNC_ITEM_TRANSACTIONS,
    jobId,
    itemId: payload.plaidItemRowId,
    userId: payload.userId,
    debounced: jobId === null,
  });

  return jobId;
}

/**
 * Kick off (or re-kick) the user-level analysis pipeline. The pipeline is a
 * chain — classify → reconcile → recurring → facts → review — and this
 * enqueues its first stage, debounced per user.
 */
export async function enqueueUserAnalysis(
  payload: UserAnalysisJobPayload,
  boss?: BossLike,
): Promise<string | null> {
  const instance = await resolveBoss(boss);

  const jobId = await instance.sendDebounced(
    JOB.CLASSIFY_USER_TRANSACTIONS,
    payload,
    null,
    USER_ANALYSIS_DEBOUNCE_SECONDS,
    payload.userId,
  );

  logger.info('job enqueued', {
    jobType: JOB.CLASSIFY_USER_TRANSACTIONS,
    jobId,
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    debounced: jobId === null,
  });

  return jobId;
}

/** Chain the next stage of the analysis pipeline (no debounce inside a run). */
export async function enqueueAnalysisStage(
  stage:
    | typeof JOB.RECONCILE_USER_TRANSFERS
    | typeof JOB.DETECT_USER_RECURRING
    | typeof JOB.BUILD_FINANCIAL_FACTS
    | typeof JOB.BUILD_FINANCIAL_REVIEW,
  payload: UserAnalysisJobPayload,
  boss?: BossLike,
): Promise<string | null> {
  const instance = await resolveBoss(boss);

  const jobId = await instance.send(stage, payload, {
    singletonKey: `${payload.analysisRunId}:${stage}`,
    singletonSeconds: 10,
  });

  logger.info('job enqueued', {
    jobType: stage,
    jobId,
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
  });

  return jobId;
}

/**
 * Schedule the delayed review-ready notification. `startAfterSeconds` is the
 * configured expected window; the handler checks device tokens and whether
 * the user already confirmed before sending anything.
 */
export async function enqueueReviewReadyNotification(
  payload: UserAnalysisJobPayload,
  startAfterSeconds: number,
  boss?: BossLike,
): Promise<string | null> {
  const instance = await resolveBoss(boss);

  const jobId = await instance.send(JOB.SEND_REVIEW_READY_NOTIFICATION, payload, {
    startAfter: startAfterSeconds,
    // One logical notification per analysis run.
    singletonKey: payload.analysisRunId,
  });

  logger.info('job enqueued', {
    jobType: JOB.SEND_REVIEW_READY_NOTIFICATION,
    jobId,
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    startAfterSeconds,
  });

  return jobId;
}
