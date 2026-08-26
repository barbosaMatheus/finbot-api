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
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.CLASSIFY_USER_TRANSACTIONS, async (payload) => {
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
