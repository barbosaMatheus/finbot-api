/**
 * User-level analysis pipeline handlers. Stages chain through the queue:
 * classify → reconcile → recurring → facts → review. Each stage re-reads
 * everything it needs from the database, so replays and duplicate
 * deliveries converge.
 */

import { classifyUserTransactions } from '../../services/classification.service.js';
import { reconcileUserTransfers } from '../../services/reconciliation.service.js';
import { detectUserRecurring } from '../../services/recurrence.service.js';
import { buildFinancialFacts } from '../../services/financial-facts.service.js';
import { buildFinancialReview } from '../../services/review.service.js';
import { sendReviewReadyNotification } from '../../services/push.service.js';
import { ensureRunInFlight } from '../../services/onboarding-lifecycle.service.js';
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.CLASSIFY_USER_TRANSACTIONS, async (payload) => {
  // The pipeline owns the 'processing' promotion (idempotent; recomputing
  // runs pass through untouched) so a crash between enqueue and transition
  // in maybeStartUserAnalysis self-heals when the job executes.
  await ensureRunInFlight(payload.analysisRunId);
  await classifyUserTransactions(payload);
});

setJobHandler(JOB.RECONCILE_USER_TRANSFERS, async (payload) => {
  await reconcileUserTransfers(payload);
});

setJobHandler(JOB.DETECT_USER_RECURRING, async (payload) => {
  await detectUserRecurring(payload);
});

setJobHandler(JOB.BUILD_FINANCIAL_FACTS, async (payload) => {
  await buildFinancialFacts(payload);
});

setJobHandler(JOB.BUILD_FINANCIAL_REVIEW, async (payload) => {
  await buildFinancialReview(payload);
});

setJobHandler(JOB.SEND_REVIEW_READY_NOTIFICATION, async (payload) => {
  await sendReviewReadyNotification(payload);
});
