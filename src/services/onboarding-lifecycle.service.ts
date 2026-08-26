/**
 * Derivation and transition rules for the onboarding lifecycle.
 *
 * The pure functions here (gates, phase, actions, transitions) are the state
 * machine from the design's Diagram 3. Everything the status endpoint reports
 * and every guard the worker enforces goes through them, so they are unit
 * tested exhaustively and never touch the database. The repository functions
 * below them are thin persistence around the same rules.
 */

import type { PoolClient } from 'pg';

import { pool } from '../db.js';
import type {
  AnalysisRunStatus,
  AnalysisRunSummary,
  LifecycleState,
  OnboardingAction,
  OnboardingGates,
  OnboardingPhase,
} from '../types/onboarding.js';
import { OnboardingError } from '../types/onboarding.js';

export const DEFAULT_LOOKBACK_DAYS = 180;

/** Runs in these statuses still own the user's single active-run slot. */
const ACTIVE_RUN_STATUSES: readonly AnalysisRunStatus[] = [
  'waiting_for_history',
  'processing',
  'review_ready',
  'recomputing',
  'failed',
];

const RUN_TRANSITIONS: Record<AnalysisRunStatus, readonly AnalysisRunStatus[]> = {
  waiting_for_history: ['processing', 'failed', 'superseded'],
  processing: ['review_ready', 'waiting_for_history', 'failed', 'superseded'],
  review_ready: ['recomputing', 'confirmed', 'waiting_for_history', 'failed', 'superseded'],
  recomputing: ['review_ready', 'failed', 'superseded'],
  failed: ['waiting_for_history', 'processing', 'superseded'],
  confirmed: [],
  superseded: [],
};

export function canTransitionRun(
  from: AnalysisRunStatus,
  to: AnalysisRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(
  from: AnalysisRunStatus,
  to: AnalysisRunStatus,
): void {
  if (!canTransitionRun(from, to)) {
    throw new OnboardingError(
      `Analysis run cannot move from ${from} to ${to}`,
      409,
      'INVALID_RUN_TRANSITION',
    );
  }
}

export function deriveGates(state: {
  hasActiveItem: boolean;
  linkingDeclaredCompleteAt: Date | null;
  manualProfileCompletedAt: Date | null;
  latestRun: Pick<AnalysisRunSummary, 'status'> | null;
}): OnboardingGates {
  const runStatus = state.latestRun?.status ?? null;

  return {
    hasLinkedInstitution: state.hasActiveItem,
    linkingDeclaredComplete: state.linkingDeclaredCompleteAt !== null,
    manualProfileComplete: state.manualProfileCompletedAt !== null,
    analysisReviewable: runStatus === 'review_ready' || runStatus === 'confirmed',
    financialReviewConfirmed: runStatus === 'confirmed',
  };
}

export function isOnboardingComplete(gates: OnboardingGates): boolean {
  return (
    gates.manualProfileComplete &&
    gates.analysisReviewable &&
    gates.financialReviewConfirmed
  );
}

/**
 * The single routing decision for the restricted shell. Linking comes first,
 * then the manual wizard, then whatever the analysis run is doing. A failed
 * run outranks the waiting states so the user is shown the retry action
 * instead of an eternal spinner.
 */
export function derivePhase(
  gates: OnboardingGates,
  latestRunStatus: AnalysisRunStatus | null,
): OnboardingPhase {
  if (isOnboardingComplete(gates)) {
    return 'complete';
  }

  if (!gates.hasLinkedInstitution || !gates.linkingDeclaredComplete) {
    return 'financial_linking';
  }

  if (!gates.manualProfileComplete) {
    return 'manual_profile_in_progress';
  }

  switch (latestRunStatus) {
    case 'processing':
      return 'classifying';
    case 'review_ready':
      return 'review_ready';
    case 'recomputing':
      return 'recomputing';
    case 'failed':
      return 'failed_retryable';
    case 'confirmed':
      // Confirmed but final flag not yet observed — treat as complete; the
      // flag recompute happens in the same transaction as confirmation.
      return 'complete';
    case 'waiting_for_history':
    case null:
    default:
      return 'waiting_for_history';
  }
}

export function deriveAvailableActions(phase: OnboardingPhase): OnboardingAction[] {
  const always: OnboardingAction[] = [
    'manage_connections',
    'manage_notifications',
    'logout',
  ];

  switch (phase) {
    case 'financial_linking':
      return ['link_institution', 'declare_linking_complete', ...always];
    case 'manual_profile_in_progress':
      return ['continue_manual_profile', ...always];
    case 'waiting_for_history':
    case 'classifying':
      return ['view_waiting', ...always];
    case 'review_ready':
      return ['view_review', 'correct_review', 'confirm_review', ...always];
    case 'recomputing':
      return ['view_review', ...always];
    case 'failed_retryable':
      return ['retry_analysis', 'link_institution', ...always];
    case 'complete':
      return ['logout'];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type RunRow = {
  id: string;
  status: AnalysisRunStatus;
  requested_lookback_days: number;
  rule_version: string;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: Date;
  review_ready_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
};

function toRunSummary(row: RunRow): AnalysisRunSummary {
  return {
    id: row.id,
    status: row.status,
    requestedLookbackDays: row.requested_lookback_days,
    ruleVersion: row.rule_version,
    retryCount: row.retry_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at.toISOString(),
    reviewReadyAt: row.review_ready_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

export async function getLatestRun(
  userId: string,
  db: Queryable = pool,
): Promise<AnalysisRunSummary | null> {
  const { rows } = await db.query<RunRow>(
    `SELECT id, status, requested_lookback_days, rule_version, retry_count,
            error_code, error_message, started_at, review_ready_at,
            confirmed_at, failed_at
     FROM financial_analysis_runs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );

  return rows[0] ? toRunSummary(rows[0]) : null;
}

/** The run that currently owns the user's active slot, if any. */
export async function getActiveRun(
  userId: string,
  db: Queryable = pool,
): Promise<AnalysisRunSummary | null> {
  const { rows } = await db.query<RunRow>(
    `SELECT id, status, requested_lookback_days, rule_version, retry_count,
            error_code, error_message, started_at, review_ready_at,
            confirmed_at, failed_at
     FROM financial_analysis_runs
     WHERE user_id = $1 AND status = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, ACTIVE_RUN_STATUSES],
  );

  return rows[0] ? toRunSummary(rows[0]) : null;
}

export async function getLifecycleState(userId: string): Promise<LifecycleState> {
  const { rows: userRows } = await pool.query<{
    id: string;
    on_boarding_complete: boolean;
    manual_profile_completed_at: Date | null;
    linking_declared_complete_at: Date | null;
  }>(
    `SELECT id, on_boarding_complete, manual_profile_completed_at,
            linking_declared_complete_at
     FROM users
     WHERE id = $1`,
    [userId],
  );

  const user = userRows[0];

  if (!user) {
    throw new OnboardingError('User not found', 404, 'USER_NOT_FOUND');
  }

  const { rows: itemRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM plaid_items
     WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );

  const activeItemCount = Number(itemRows[0]?.count ?? '0');

  return {
    userId,
    hasActiveItem: activeItemCount > 0,
    activeItemCount,
    linkingDeclaredCompleteAt: user.linking_declared_complete_at,
    manualProfileCompletedAt: user.manual_profile_completed_at,
    latestRun: await getLatestRun(userId),
    onboardingCompleteFlag: user.on_boarding_complete,
  };
}

/**
 * Recompute and persist the derived final flag inside the caller's
 * transaction. Called wherever a gate can change: manual save, run
 * confirmation, disconnects.
 */
export async function recomputeOnboardingComplete(
  db: Queryable,
  userId: string,
): Promise<boolean> {
  const { rows } = await db.query<{
    manual_profile_completed_at: Date | null;
    linking_declared_complete_at: Date | null;
  }>(
    `SELECT manual_profile_completed_at, linking_declared_complete_at
     FROM users WHERE id = $1`,
    [userId],
  );

  const user = rows[0];

  if (!user) {
    throw new OnboardingError('User not found', 404, 'USER_NOT_FOUND');
  }

  const { rows: itemRows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM plaid_items WHERE user_id = $1 AND status = 'active'
     ) AS exists`,
    [userId],
  );

  const latestRun = await getLatestRun(userId, db);

  const gates = deriveGates({
    hasActiveItem: itemRows[0]?.exists ?? false,
    linkingDeclaredCompleteAt: user.linking_declared_complete_at,
    manualProfileCompletedAt: user.manual_profile_completed_at,
    latestRun,
  });

  const complete = isOnboardingComplete(gates);

  await db.query(
    `UPDATE users SET on_boarding_complete = $2 WHERE id = $1`,
    [userId, complete],
  );

  return complete;
}

export async function markManualProfileComplete(
  db: Queryable,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE users
     SET manual_profile_completed_at = COALESCE(manual_profile_completed_at, NOW())
     WHERE id = $1`,
    [userId],
  );
}

export async function declareLinkingComplete(userId: string): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM plaid_items WHERE user_id = $1 AND status = 'active'
     ) AS exists`,
    [userId],
  );

  if (!rows[0]?.exists) {
    throw new OnboardingError(
      'Connect at least one institution before continuing',
      409,
      'NO_LINKED_INSTITUTION',
    );
  }

  await pool.query(
    `UPDATE users
     SET linking_declared_complete_at = COALESCE(linking_declared_complete_at, NOW())
     WHERE id = $1`,
    [userId],
  );
}

/**
 * Ensure the user has an active analysis run, creating one if the slot is
 * free. Uses the partial unique index as the concurrency guard: a losing
 * racer falls back to reading the winner's row.
 */
export async function ensureActiveRun(
  userId: string,
  options: { lookbackDays?: number; triggeringItemIds?: string[] } = {},
): Promise<AnalysisRunSummary> {
  const existing = await getActiveRun(userId);

  if (existing) {
    if (options.triggeringItemIds?.length) {
      await pool.query(
        `UPDATE financial_analysis_runs
         SET triggering_item_ids = ARRAY(
               SELECT DISTINCT unnest(triggering_item_ids || $2::uuid[])
             ),
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, options.triggeringItemIds],
      );
    }

    return existing;
  }

  const { rows } = await pool.query<RunRow>(
    `INSERT INTO financial_analysis_runs (
       user_id, requested_lookback_days, triggering_item_ids
     )
     VALUES ($1, $2, $3::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING id, status, requested_lookback_days, rule_version, retry_count,
               error_code, error_message, started_at, review_ready_at,
               confirmed_at, failed_at`,
    [
      userId,
      options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      options.triggeringItemIds ?? [],
    ],
  );

  if (rows[0]) {
    return toRunSummary(rows[0]);
  }

  const winner = await getActiveRun(userId);

  if (!winner) {
    throw new OnboardingError(
      'Could not create an analysis run',
      500,
      'RUN_CREATE_FAILED',
    );
  }

  return winner;
}

/**
 * Move a run to a new status, enforcing the transition table, and stamp the
 * matching timestamp columns. Idempotent: moving to the status the run is
 * already in is a no-op so at-least-once jobs can replay safely.
 */
export async function transitionRun(
  runId: string,
  to: AnalysisRunStatus,
  options: {
    db?: Queryable;
    errorCode?: string | null;
    errorMessage?: string | null;
  } = {},
): Promise<void> {
  const db = options.db ?? pool;

  const { rows } = await db.query<{ status: AnalysisRunStatus }>(
    `SELECT status FROM financial_analysis_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );

  const current = rows[0];

  if (!current) {
    throw new OnboardingError('Analysis run not found', 404, 'RUN_NOT_FOUND');
  }

  if (current.status === to) {
    return;
  }

  assertRunTransition(current.status, to);

  await db.query(
    `UPDATE financial_analysis_runs
     SET status = $2,
         error_code = $3,
         error_message = $4,
         review_ready_at = CASE
           WHEN $2 = 'review_ready' AND review_ready_at IS NULL THEN NOW()
           ELSE review_ready_at
         END,
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE confirmed_at END,
         failed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE failed_at END,
         retry_count = CASE
           WHEN $5::boolean THEN retry_count + 1
           ELSE retry_count
         END,
         updated_at = NOW()
     WHERE id = $1`,
    [
      runId,
      to,
      options.errorCode ?? null,
      options.errorMessage ?? null,
      current.status === 'failed' && (to === 'waiting_for_history' || to === 'processing'),
    ],
  );
}
