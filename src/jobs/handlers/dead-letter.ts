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
import { setDeadLetterHandler } from '../register.js';

setDeadLetterHandler(async (payload, context) => {
  const data = payload as Partial<{
    plaidItemRowId: string;
    userId: string;
    analysisRunId: string;
  }>;

  logger.error('job dead-lettered', {
    jobId: context.jobId,
    userId: data.userId,
    itemId: data.plaidItemRowId,
    analysisRunId: data.analysisRunId,
  });

  if (data.plaidItemRowId && data.userId) {
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
      // The run may already be terminal; that is fine.
      logger.warn('could not mark run failed from dead letter', {
        analysisRunId: data.analysisRunId,
        error: err instanceof Error ? err : String(err),
      });
    }
  }
});
