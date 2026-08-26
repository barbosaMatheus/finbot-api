/**
 * Item sync job handlers (API-006).
 *
 * INITIALIZE_ITEM_SYNC ensures the sync-state row exists and enqueues the
 * first sync session. SYNC_ITEM_TRANSACTIONS runs a full cursor session via
 * plaid-sync.service. Both are idempotent references into the database.
 */

import { pool } from '../../db.js';
import { syncItemTransactions } from '../../services/plaid-sync.service.js';
import { ensureSyncState } from '../../services/transaction-store.service.js';
import { enqueueItemSync } from '../enqueue.js';
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.INITIALIZE_ITEM_SYNC, async (payload) => {
  await ensureSyncState(pool, payload.plaidItemRowId);
  await enqueueItemSync(payload);
});

setJobHandler(JOB.SYNC_ITEM_TRANSACTIONS, async (payload) => {
  await syncItemTransactions(payload);
});
