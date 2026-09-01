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
import { OnboardingError } from '../types/onboarding.js';
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
  /** When this Item's data last actually synced (not when it was read). */
  lastSyncedAt?: string | null;
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
  last_synced_at: Date | null;
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
            s.last_error_code,
            s.last_synced_at
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
      lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
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

  // Enqueue before flipping status: the reverse order could crash between
  // the two awaits and strand the run in 'processing' with nothing queued —
  // an unrecoverable spinner (retry reports already_running, this function
  // reports skipped). With enqueue-first, a crash leaves the run in
  // waiting_for_history and the classify handler promotes it on execution
  // (ensureRunInFlight).
  await deps.enqueueAnalysis({ userId, analysisRunId: run.id });
  await deps.transitionRun(run.id, 'processing');

  logger.info('analysis run started', {
    userId,
    analysisRunId: run.id,
    usableItems: usable.length,
    totalItems: items.length,
  });

  return 'started';
}

// ---------------------------------------------------------------------------
// Stale-run watchdog
// ---------------------------------------------------------------------------

/** In-flight runs quiet this long get their pipeline re-enqueued. */
export const STALL_REKICK_MINUTES = 15;

/** In-flight runs quiet this long are failed retryably — no eternal spinner. */
export const STALL_FAIL_MINUTES = 120;

/** waiting_for_history runs quiet this long get syncs + gate re-evaluated. */
export const WAITING_SWEEP_MINUTES = 30;

export type SweepDeps = {
  db: Queryable;
  enqueueAnalysis(payload: UserAnalysisJobPayload): Promise<unknown>;
  ensureItemSyncs(userId: string): Promise<number>;
  maybeStartAnalysis(userId: string): Promise<unknown>;
  transitionRun: typeof transitionRun;
};

async function defaultSweepDeps(): Promise<SweepDeps> {
  const [enqueue, plaid] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('./plaid.service.js'),
  ]);

  return {
    db: pool,
    enqueueAnalysis: (payload) => enqueue.enqueueUserAnalysis(payload),
    ensureItemSyncs: (userId) => plaid.ensureItemSyncs(userId),
    maybeStartAnalysis: (userId) => maybeStartUserAnalysis(userId),
    transitionRun,
  };
}

type StaleRunRow = { id: string; user_id: string };

/**
 * SWEEP_STALE_RUNS: the safety net under every other recovery mechanism.
 *
 * pg-boss's own expiration covers jobs whose worker died mid-run; the dead
 * letter covers jobs that exhausted retries. What neither covers is a run
 * with NO live job at all — an enqueue that never happened (crash between
 * stages, dropped singleton). Nothing would ever touch such a run again,
 * and the status surface reads "working" forever.
 *
 * Three escalating responses, all idempotent:
 *  - in-flight (processing/recomputing) and quiet past STALL_FAIL_MINUTES:
 *    fail retryably so the user gets a retry action instead of a spinner;
 *  - in-flight and quiet past STALL_REKICK_MINUTES: re-enqueue the pipeline
 *    (stages are idempotent upserts and the enqueue is debounced per user);
 *  - waiting_for_history and quiet past WAITING_SWEEP_MINUTES: re-kick dead
 *    sync chains and re-evaluate the start gate.
 */
export async function sweepStaleRuns(
  depsOverride?: Partial<SweepDeps>,
): Promise<{ failed: number; rekicked: number; waitingKicked: number }> {
  const deps: SweepDeps = { ...(await defaultSweepDeps()), ...depsOverride };

  let failed = 0;

  const { rows: hopeless } = await deps.db.query<StaleRunRow>(
    `SELECT id, user_id FROM financial_analysis_runs
     WHERE status IN ('processing', 'recomputing')
       AND updated_at < NOW() - make_interval(mins => $1)`,
    [STALL_FAIL_MINUTES],
  );

  for (const run of hopeless) {
    try {
      await deps.transitionRun(run.id, 'failed', {
        errorCode: 'ANALYSIS_STALLED',
        errorMessage: 'The analysis stalled and was marked failed; retry to run it again.',
      });
      failed += 1;
    } catch (err) {
      // A state-machine rejection means someone else moved the run first —
      // exactly the kind of race the sweep should lose quietly.
      if (!(err instanceof OnboardingError)) {
        throw err;
      }
    }
  }

  // Runs failed above are no longer in an in-flight status, so this
  // shorter-window query never double-touches them.
  const { rows: quiet } = await deps.db.query<StaleRunRow>(
    `SELECT id, user_id FROM financial_analysis_runs
     WHERE status IN ('processing', 'recomputing')
       AND updated_at < NOW() - make_interval(mins => $1)`,
    [STALL_REKICK_MINUTES],
  );

  for (const run of quiet) {
    await deps.enqueueAnalysis({ userId: run.user_id, analysisRunId: run.id });
  }

  const { rows: waiting } = await deps.db.query<StaleRunRow>(
    `SELECT id, user_id FROM financial_analysis_runs
     WHERE status = 'waiting_for_history'
       AND updated_at < NOW() - make_interval(mins => $1)`,
    [WAITING_SWEEP_MINUTES],
  );

  for (const run of waiting) {
    await deps.ensureItemSyncs(run.user_id);
    await deps.maybeStartAnalysis(run.user_id);
  }

  if (failed > 0 || quiet.length > 0 || waiting.length > 0) {
    logger.info('stale-run sweep', {
      failed,
      rekicked: quiet.length,
      waitingKicked: waiting.length,
    });
  }

  return { failed, rekicked: quiet.length, waitingKicked: waiting.length };
}
