/**
 * User-level analysis pipeline handlers. Stages chain through the queue:
 * classify → reconcile → recurring → facts → review. Each stage re-reads
 * everything it needs from the database, so replays and duplicate
 * deliveries converge.
 */

import { classifyUserTransactions } from '../../services/classification.service.js';
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.CLASSIFY_USER_TRANSACTIONS, async (payload) => {
  await classifyUserTransactions(payload);
});
