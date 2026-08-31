/**
 * The authoritative onboarding state machine surface (API-014).
 *
 * GET /onboarding/status derives everything — gates, phase, available
 * actions, institution aggregation — from stored state through the same
 * pure functions the worker uses, so the API can never disagree with
 * itself. Confirmation is the only path to on_boarding_complete and is
 * idempotent; retry is explicit and bounded.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import {
  declareLinkingComplete as lifecycleDeclareLinkingComplete,
  deriveAvailableActions,
  deriveGates,
  derivePhase,
  ensureActiveRun,
  getLatestRun,
  getLifecycleState,
  recomputeOnboardingComplete,
  transitionRun,
} from './onboarding-lifecycle.service.js';
import {
  getItemSyncOverviews,
  maybeStartUserAnalysis,
  type ItemSyncOverview,
} from './analysis-orchestration.service.js';
import type {
  LifecycleState,
  OnboardingAction,
  OnboardingGates,
  OnboardingPhase,
} from '../types/onboarding.js';
import { OnboardingError } from '../types/onboarding.js';

export type OnboardingStatusResponse = {
  phase: OnboardingPhase;
  gates: OnboardingGates;
  analysis: {
    runId: string;
    status: string;
    requestedLookbackDays: number;
    institutions: {
      total: number;
      ready: number;
      limited: number;
      failed: number;
      pending: number;
    };
    startedAt: string;
    reviewReadyAt: string | null;
    retryAllowed: boolean;
  } | null;
  availableActions: OnboardingAction[];
  onboardingComplete: boolean;
};

export type StatusDeps = {
  getLifecycleState(userId: string): Promise<LifecycleState>;
  getItems(userId: string): Promise<ItemSyncOverview[]>;
  requestedDaysShare?: number;
};

async function defaultStatusDeps(): Promise<StatusDeps> {
  return {
    getLifecycleState,
    getItems: (userId) => getItemSyncOverviews(userId),
  };
}

/** Aggregate per-Item sync overviews into the status breakdown. */
export function aggregateInstitutions(
  items: ItemSyncOverview[],
  requestedDays: number,
): { total: number; ready: number; limited: number; failed: number; pending: number } {
  let ready = 0;
  let limited = 0;
  let failed = 0;
  let pending = 0;

  for (const item of items) {
    if (item.syncStatus === 'failed') {
      failed += 1;
    } else if (item.syncStatus === 'complete') {
      if ((item.historyDaysAvailable ?? 0) >= requestedDays * 0.9) {
        ready += 1;
      } else {
        limited += 1;
      }
    } else {
      pending += 1;
    }
  }

  return { total: items.length, ready, limited, failed, pending };
}

export async function getOnboardingStatus(
  userId: string,
  depsOverride?: StatusDeps,
): Promise<OnboardingStatusResponse> {
  const deps = depsOverride ?? (await defaultStatusDeps());

  const state = await deps.getLifecycleState(userId);
  const items = await deps.getItems(userId);

  const gates = deriveGates(state);
  const phase = derivePhase(gates, state.latestRun?.status ?? null);
  const availableActions = deriveAvailableActions(phase);

  const run = state.latestRun;
  const anyItemFailed = items.some((item) => item.syncStatus === 'failed');

  return {
    phase,
    gates,
    analysis: run
      ? {
          runId: run.id,
          status: run.status,
          requestedLookbackDays: run.requestedLookbackDays,
          institutions: aggregateInstitutions(items, run.requestedLookbackDays),
          startedAt: run.startedAt,
          reviewReadyAt: run.reviewReadyAt,
          retryAllowed: run.status === 'failed' || anyItemFailed,
        }
      : null,
    availableActions,
    // The persisted flag is set at confirmation and is forward-only; OR-ing
    // it in keeps a finished user complete even if a later run appears and
    // the latest-run gates momentarily read incomplete.
    onboardingComplete:
      state.onboardingCompleteFlag ||
      (gates.manualProfileComplete &&
        gates.analysisReviewable &&
        gates.financialReviewConfirmed),
  };
}

// ---------------------------------------------------------------------------
// Declare linking complete
// ---------------------------------------------------------------------------

export async function declareLinkingComplete(userId: string): Promise<void> {
  await lifecycleDeclareLinkingComplete(userId);

  // Backstop: any active Item missing a sync kick-off gets one now.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT i.id
     FROM plaid_items i
     LEFT JOIN plaid_sync_state s ON s.plaid_item_id = i.id
     WHERE i.user_id = $1 AND i.status = 'active' AND s.plaid_item_id IS NULL`,
    [userId],
  );

  if (rows.length > 0) {
    const { startItemSync } = await import('./plaid.service.js');

    for (const row of rows) {
      await startItemSync(userId, row.id);
    }
  }

  await ensureActiveRun(userId);
  await maybeStartUserAnalysis(userId);
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export type ConfirmDeps = {
  db: Queryable;
};

export async function confirmFinancialReview(
  userId: string,
  snapshotVersion: number,
  depsOverride?: ConfirmDeps,
): Promise<{ onboardingComplete: boolean; alreadyConfirmed: boolean }> {
  const deps = depsOverride ?? { db: pool };

  const run = await getLatestRun(userId, deps.db);

  if (!run) {
    throw new OnboardingError(
      'Financial analysis is not reviewable yet',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  const { rows: versionRows } = await deps.db.query<{ version: number | null }>(
    `SELECT MAX(version)::int AS version
     FROM financial_fact_snapshots
     WHERE analysis_run_id = $1`,
    [run.id],
  );

  const latestVersion = versionRows[0]?.version ?? 0;

  if (run.status === 'confirmed') {
    // Idempotent: confirming what is already confirmed succeeds quietly.
    return { onboardingComplete: true, alreadyConfirmed: true };
  }

  if (run.status !== 'review_ready') {
    throw new OnboardingError(
      'Financial analysis is not reviewable yet',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  if (latestVersion !== snapshotVersion) {
    throw new OnboardingError(
      'The review changed since you loaded it; refresh to continue',
      409,
      'REVIEW_VERSION_STALE',
    );
  }

  const { rows: unresolvedRows } = await deps.db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM financial_review_items
     WHERE analysis_run_id = $1 AND required = TRUE AND status = 'open'`,
    [run.id],
  );

  if (Number(unresolvedRows[0]?.count ?? '0') > 0) {
    throw new OnboardingError(
      'Required review items are still unresolved',
      409,
      'REVIEW_ITEMS_UNRESOLVED',
    );
  }

  await transitionRun(run.id, 'confirmed', { db: deps.db });

  await deps.db.query(
    `UPDATE financial_analysis_runs
     SET confirmed_snapshot_version = $2, updated_at = NOW()
     WHERE id = $1`,
    [run.id, snapshotVersion],
  );

  const onboardingComplete = await recomputeOnboardingComplete(deps.db, userId);

  logger.info('financial review confirmed', {
    userId,
    analysisRunId: run.id,
    snapshotVersion,
    onboardingComplete,
  });

  return { onboardingComplete, alreadyConfirmed: false };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export type RetryDeps = {
  db: Queryable;
  getItems(userId: string): Promise<ItemSyncOverview[]>;
  enqueueItemSync(payload: { plaidItemRowId: string; userId: string }): Promise<unknown>;
  transitionRun(runId: string, to: 'waiting_for_history'): Promise<void>;
  maybeStartAnalysis(userId: string): Promise<unknown>;
};

async function defaultRetryDeps(): Promise<RetryDeps> {
  const enqueue = await import('../jobs/enqueue.js');

  return {
    db: pool,
    getItems: (userId) => getItemSyncOverviews(userId),
    enqueueItemSync: (payload) => enqueue.enqueueItemSync(payload),
    transitionRun: (runId, to) => transitionRun(runId, to),
    maybeStartAnalysis: (userId) => maybeStartUserAnalysis(userId),
  };
}

export async function retryAnalysis(
  userId: string,
  depsOverride?: RetryDeps,
): Promise<{ status: 'retry_queued' | 'already_running' }> {
  const deps = depsOverride ?? (await defaultRetryDeps());

  const run = await getLatestRun(userId, deps.db);

  if (!run) {
    throw new OnboardingError('There is nothing to retry', 409, 'RETRY_NOT_AVAILABLE');
  }

  if (run.status === 'processing' || run.status === 'recomputing') {
    return { status: 'already_running' };
  }

  const items = await deps.getItems(userId);
  const failedItems = items.filter((item) => item.syncStatus === 'failed');

  if (run.status === 'review_ready' || run.status === 'confirmed') {
    if (failedItems.length === 0) {
      throw new OnboardingError(
        'There is nothing to retry',
        409,
        'RETRY_NOT_AVAILABLE',
      );
    }
  }

  if (run.status === 'waiting_for_history' && failedItems.length === 0) {
    return { status: 'already_running' };
  }

  for (const item of failedItems) {
    await deps.db.query(
      `UPDATE plaid_sync_state
       SET sync_status = 'syncing',
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
       WHERE plaid_item_id = $1`,
      [item.itemRowId],
    );

    await deps.enqueueItemSync({ plaidItemRowId: item.itemRowId, userId });
  }

  if (run.status === 'failed') {
    await deps.transitionRun(run.id, 'waiting_for_history');
  }

  await deps.maybeStartAnalysis(userId);

  logger.info('analysis retry requested', {
    userId,
    analysisRunId: run.id,
    retriedItems: failedItems.length,
  });

  return { status: 'retry_queued' };
}
