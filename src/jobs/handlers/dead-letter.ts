/**
 * Dead-letter observer: when a job exhausts its retries, its payload lands
 * on the DEAD_LETTER queue and this handler turns that into visible business
 * state — a failed Item sync or a failed analysis run — so users see a retry
 * action instead of an eternal spinner. Payloads stay queued for operator
 * redrive; this only mirrors the failure into FinBot tables.
 */

import { logger } from '../../lib/logger.js';
import { markItemSyncFailed } from '../../services/plaid-sync.service.js';
import { transitionRun } from '../../services/onboarding-lifecycle.service.js';
import { OnboardingError } from '../../types/onboarding.js';
import { setDeadLetterHandler, type DeadLetterHandler } from '../register.js';
import { JOB } from '../types.js';

/** Exported so tests can drive the handler directly. */
export const handleDeadLetter: DeadLetterHandler = async (payload, context) => {
  const data = payload as Partial<{
    plaidItemRowId: string;
    userId: string;
    analysisRunId: string;
  }>;

  logger.error('job dead-lettered', {
    jobId: context.jobId,
    sourceQueue: context.sourceName ?? 'unknown',
    userId: data.userId,
    itemId: data.plaidItemRowId,
    analysisRunId: data.analysisRunId,
  });

  // A dead notification job must never touch run state: its payload carries
  // the same analysisRunId as pipeline jobs, and review_ready → failed is a
  // legal transition — classifying by payload shape used to regress a
  // healthy, reviewable run to failed over nothing but a missed push.
  if (context.sourceName === JOB.SEND_REVIEW_READY_NOTIFICATION) {
    return;
  }

  if (data.plaidItemRowId && data.userId) {
    // Transient errors propagate: the register wrapper rethrows and the DL
    // queue's retry policy gets another shot at recording the failure.
    await markItemSyncFailed(data.plaidItemRowId, data.userId);
    return;
  }

  if (data.analysisRunId) {
    try {
      await transitionRun(data.analysisRunId, 'failed', {
        errorCode: 'ANALYSIS_JOB_FAILED',
        errorMessage: 'A background analysis step failed after retries.',
      });
    } catch (err) {
      // Only a state-machine rejection is benign (the run is already
      // terminal). Anything else is transient — rethrow so the DL retry
      // policy applies instead of silently losing the failure signal.
      if (err instanceof OnboardingError) {
        logger.warn('could not mark run failed from dead letter', {
          analysisRunId: data.analysisRunId,
          error: err.message,
        });
        return;
      }

      throw err;
    }
  }
};

setDeadLetterHandler(handleDeadLetter);
