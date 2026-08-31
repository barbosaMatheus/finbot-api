/**
 * User-level analysis orchestration.
 *
 * Items sync independently; a user's analysis run starts only when the user
 * has declared linking complete and every active Item has reached a terminal
 * sync state for the run (historical-ready, limited-history, or failed). At
 * least one Item must be usable — a run with nothing but failures fails with
 * a retryable error instead of producing an empty review.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import {
  ensureActiveRun,
  getActiveRun,
  getLatestRun,
  transitionRun,
} from './onboarding-lifecycle.service.js';

export type ItemSyncOverview = {
  itemRowId: string;
  institutionName: string | null;
  syncStatus: 'pending' | 'syncing' | 'complete' | 'failed';
  updateStatus: string;
  oldestTransactionDate: string | null;
  historyDaysAvailable: number | null;
  lastErrorCode: string | null;
  terminal: boolean;
  usable: boolean;
};

type OverviewRow = {
  item_row_id: string;
  institution_name: string | null;
  sync_status: 'pending' | 'syncing' | 'complete' | 'failed' | null;
  update_status: string | null;
  oldest_transaction_date: string | null;
  last_error_code: string | null;
};

function daysBetween(oldestIso: string, now: Date): number {
  const oldest = Date.parse(`${oldestIso}T00:00:00Z`);
  return Math.max(0, Math.round((now.getTime() - oldest) / 86_400_000));
}

export async function getItemSyncOverviews(
  userId: string,
  db: Queryable = pool,
  now: Date = new Date(),
): Promise<ItemSyncOverview[]> {
  const { rows } = await db.query<OverviewRow>(
    `SELECT i.id AS item_row_id,
            i.institution_name,
            s.sync_status,
            s.update_status,
            s.oldest_transaction_date::text AS oldest_transaction_date,
            s.last_error_code
     FROM plaid_items i
     LEFT JOIN plaid_sync_state s ON s.plaid_item_id = i.id
     WHERE i.user_id = $1 AND i.status = 'active'
     ORDER BY i.created_at`,
    [userId],
  );

  return rows.map((row) => {
    const syncStatus = row.sync_status ?? 'pending';
    const terminal = syncStatus === 'complete' || syncStatus === 'failed';

    return {
      itemRowId: row.item_row_id,
      institutionName: row.institution_name,
      syncStatus,
      updateStatus: row.update_status ?? 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
      oldestTransactionDate: row.oldest_transaction_date,
      historyDaysAvailable: row.oldest_transaction_date
        ? daysBetween(row.oldest_transaction_date, now)
        : null,
      lastErrorCode: row.last_error_code,
      terminal,
      usable: syncStatus === 'complete',
    };
  });
}

export type OrchestrationDeps = {
  db: Queryable;
  enqueueAnalysis(payload: UserAnalysisJobPayload): Promise<unknown>;
  getActiveRun: typeof getActiveRun;
  getLatestRun: typeof getLatestRun;
  ensureActiveRun: typeof ensureActiveRun;
  transitionRun: typeof transitionRun;
  now(): Date;
};

async function defaultDeps(): Promise<OrchestrationDeps> {
  const enqueue = await import('../jobs/enqueue.js');

  return {
    db: pool,
    enqueueAnalysis: (payload) => enqueue.enqueueUserAnalysis(payload),
    getActiveRun,
    getLatestRun,
    ensureActiveRun,
    transitionRun,
    now: () => new Date(),
  };
}

/**
 * Evaluate whether the user's analysis can start (or fail), and make it so.
 * Called after any Item reaches a terminal sync state, after the user
 * declares linking complete, and from retry. Idempotent and debounced by
 * its callers; safe to invoke redundantly.
 */
export async function maybeStartUserAnalysis(
  userId: string,
  depsOverride?: Partial<OrchestrationDeps>,
): Promise<'started' | 'failed' | 'waiting' | 'skipped'> {
  const deps: OrchestrationDeps = { ...(await defaultDeps()), ...depsOverride };

  const { rows: userRows } = await deps.db.query<{
    linking_declared_complete_at: Date | null;
  }>(`SELECT linking_declared_complete_at FROM users WHERE id = $1`, [userId]);

  const user = userRows[0];

  if (!user?.linking_declared_complete_at) {
    return 'skipped';
  }

  const items = await getItemSyncOverviews(userId, deps.db, deps.now());

  if (items.length === 0) {
    return 'skipped';
  }

  // A confirmed latest run means this user finished onboarding. Routine
  // post-completion webhooks land here via item sync; they must never spawn
  // a fresh run, which would flip the status surface back to
  // waiting_for_history and re-lock the app shell for a finished user.
  const latest = await deps.getLatestRun(userId, deps.db);

  if (latest?.status === 'confirmed') {
    return 'skipped';
  }

  const run =
    (await deps.getActiveRun(userId, deps.db)) ?? (await deps.ensureActiveRun(userId));

  if (run.status !== 'waiting_for_history') {
    return 'skipped';
  }

  if (!items.every((item) => item.terminal)) {
    return 'waiting';
  }

  const usable = items.filter((item) => item.usable);

  if (usable.length === 0) {
    await deps.transitionRun(run.id, 'failed', {
      errorCode: 'NO_USABLE_ITEM',
      errorMessage:
        'No connected institution produced usable balances or transaction history.',
    });

    logger.warn('analysis run failed: no usable items', {
      userId,
      analysisRunId: run.id,
    });

    return 'failed';
  }

  await deps.transitionRun(run.id, 'processing');
  await deps.enqueueAnalysis({ userId, analysisRunId: run.id });

  logger.info('analysis run started', {
    userId,
    analysisRunId: run.id,
    usableItems: usable.length,
    totalItems: items.length,
  });

  return 'started';
}
