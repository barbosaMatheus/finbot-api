/**
 * Review corrections and recomputation (API-013).
 *
 * Corrections are scoped — one transaction, a merchant, a recurring
 * stream, a manual profile fact, or acceptance of a coverage limitation —
 * and always recorded with who changed what, the original evidence, and
 * when. Overrides land in tables the analysis pipeline reads first, so a
 * full replay preserves them. Data-changing corrections trigger a
 * debounced pipeline rebuild that produces the next snapshot version.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { normalizeMerchant } from '../lib/merchant.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import { ECONOMIC_ROLES, type EconomicRole } from '../types/classification.js';
import { OnboardingError } from '../types/onboarding.js';

export type CorrectionAction =
  | 'accept_coverage_limitation'
  | 'keep_manual_value'
  | 'use_observed_value'
  | 'set_value'
  | 'confirm_stream'
  | 'dismiss_stream'
  | 'reclassify_transaction'
  | 'reclassify_merchant';

export type CorrectionRequest = {
  userId: string;
  reviewItemId: string;
  action: CorrectionAction;
  /** The snapshot version the client was looking at. */
  snapshotVersion: number;
  value?: unknown;
};

export type CorrectionsDeps = {
  db: Queryable;
  enqueueRecompute(payload: UserAnalysisJobPayload): Promise<unknown>;
  transitionRun(runId: string, to: 'recomputing'): Promise<void>;
  now(): Date;
};

async function defaultDeps(): Promise<CorrectionsDeps> {
  const [enqueue, lifecycle] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('./onboarding-lifecycle.service.js'),
  ]);

  return {
    db: pool,
    enqueueRecompute: (payload) => enqueue.enqueueUserAnalysis(payload),
    transitionRun: (runId, to) => lifecycle.transitionRun(runId, to),
    now: () => new Date(),
  };
}

type ItemRow = {
  id: string;
  analysis_run_id: string;
  user_id: string;
  item_key: string;
  type: string;
  required: boolean;
  status: string;
  evidence: unknown;
  allowed_actions: string[];
  run_status: string;
};

function assertRole(value: unknown): EconomicRole {
  if (typeof value === 'string' && (ECONOMIC_ROLES as readonly string[]).includes(value)) {
    return value as EconomicRole;
  }

  throw new OnboardingError(
    `Unsupported economic role "${String(value)}"`,
    422,
    'INVALID_CORRECTION_SCOPE',
  );
}

/** Roles that only make sense for money going out (Plaid sign: positive). */
const OUTFLOW_ONLY_ROLES: ReadonlySet<EconomicRole> = new Set([
  'expense',
  'interest_or_fee',
  'debt_principal_payment',
  'unknown_outflow',
]);

/** Roles that only make sense for money coming in (Plaid sign: negative). */
const INFLOW_ONLY_ROLES: ReadonlySet<EconomicRole> = new Set([
  'earned_income',
  'refund_or_credit',
  'unknown_inflow',
]);

/**
 * A role contradicting the amount's direction would make the transaction
 * vanish from (or misfile in) every facts total. Rejecting it here gives
 * the user an actionable error instead of a silently wrong review.
 */
function assertRoleMatchesDirection(role: EconomicRole, amount: number): void {
  const contradiction =
    (amount > 0 && INFLOW_ONLY_ROLES.has(role)) ||
    (amount < 0 && OUTFLOW_ONLY_ROLES.has(role));

  if (contradiction) {
    throw new OnboardingError(
      `Role "${role}" does not fit a ${amount > 0 ? 'money-out' : 'money-in'} transaction`,
      422,
      'INVALID_CORRECTION_SCOPE',
    );
  }
}

function valueAsRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }

  throw new OnboardingError(
    'This action requires a value payload',
    422,
    'INVALID_CORRECTION_SCOPE',
  );
}

/** Actions whose effects change derived data and require a rebuild. */
const RECOMPUTE_ACTIONS: ReadonlySet<CorrectionAction> = new Set([
  'confirm_stream',
  'dismiss_stream',
  'reclassify_transaction',
  'reclassify_merchant',
]);

export async function applyReviewItemAction(
  request: CorrectionRequest,
  depsOverride?: CorrectionsDeps,
): Promise<{ status: string; recomputeQueued: boolean }> {
  const deps = depsOverride ?? (await defaultDeps());

  const { rows } = await deps.db.query<ItemRow>(
    `SELECT ri.id, ri.analysis_run_id, ri.user_id, ri.item_key, ri.type,
            ri.required, ri.status, ri.evidence, ri.allowed_actions,
            r.status AS run_status
     FROM financial_review_items ri
     JOIN financial_analysis_runs r ON r.id = ri.analysis_run_id
     WHERE ri.id = $1 AND ri.user_id = $2`,
    [request.reviewItemId, request.userId],
  );

  const item = rows[0];

  if (!item) {
    // Not found OR another user's item — indistinguishable on purpose.
    throw new OnboardingError('Review item not found', 404, 'REVIEW_ITEM_NOT_FOUND');
  }

  if (item.run_status !== 'review_ready') {
    throw new OnboardingError(
      'The review cannot be corrected right now',
      409,
      item.run_status === 'recomputing'
        ? 'RECOMPUTE_IN_PROGRESS'
        : 'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  const { rows: versionRows } = await deps.db.query<{ version: number }>(
    `SELECT MAX(version)::int AS version
     FROM financial_fact_snapshots
     WHERE analysis_run_id = $1`,
    [item.analysis_run_id],
  );

  const latestVersion = versionRows[0]?.version ?? 0;

  if (latestVersion !== request.snapshotVersion) {
    throw new OnboardingError(
      'The review changed since you loaded it; refresh to continue',
      409,
      'REVIEW_VERSION_STALE',
    );
  }

  if (!item.allowed_actions.includes(request.action)) {
    throw new OnboardingError(
      `Action "${request.action}" is not available for this item`,
      422,
      'INVALID_CORRECTION_SCOPE',
    );
  }

  const confirmedValue = await applySideEffects(deps, request, item);

  const newStatus =
    request.action === 'accept_coverage_limitation' ? 'accepted' : 'resolved';

  await deps.db.query(
    `UPDATE financial_review_items
     SET status = $2,
         confirmed_value = $3::jsonb,
         resolution = $4::jsonb,
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      item.id,
      newStatus,
      confirmedValue === null ? null : JSON.stringify(confirmedValue),
      JSON.stringify({
        action: request.action,
        resolvedBy: 'user',
        at: deps.now().toISOString(),
        originalEvidence: item.evidence,
        value: request.value ?? null,
      }),
    ],
  );

  let recomputeQueued = false;

  if (RECOMPUTE_ACTIONS.has(request.action)) {
    await deps.transitionRun(item.analysis_run_id, 'recomputing');
    await deps.enqueueRecompute({
      userId: request.userId,
      analysisRunId: item.analysis_run_id,
    });
    recomputeQueued = true;
  }

  logger.info('review item corrected', {
    userId: request.userId,
    analysisRunId: item.analysis_run_id,
    itemKey: item.item_key,
    action: request.action,
    recomputeQueued,
  });

  return { status: newStatus, recomputeQueued };
}

async function applySideEffects(
  deps: CorrectionsDeps,
  request: CorrectionRequest,
  item: ItemRow,
): Promise<Record<string, unknown> | null> {
  switch (request.action) {
    case 'accept_coverage_limitation':
    case 'keep_manual_value':
      return { kept: request.action === 'keep_manual_value' ? 'manual' : 'limitation' };

    case 'use_observed_value': {
      const evidence = item.evidence as { observedMonthlyIncome?: number } | null;
      const observed = evidence?.observedMonthlyIncome;

      if (typeof observed !== 'number' || observed < 0) {
        throw new OnboardingError(
          'No observed value is available to apply',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      await deps.db.query(
        `UPDATE user_info SET income_override = $2, updated_at = NOW()
         WHERE user_id = $1`,
        [request.userId, observed],
      );

      return { monthlyIncome: observed, source: 'observed' };
    }

    case 'set_value': {
      const value = valueAsRecord(request.value);
      const amount = value.amount;

      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new OnboardingError(
          'set_value requires a non-negative numeric amount',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      // The review is the only writer of income_override: the wizard never
      // asks for income, so this is the user's explicit correction.
      await deps.db.query(
        `UPDATE user_info SET income_override = $2, updated_at = NOW()
         WHERE user_id = $1`,
        [request.userId, amount],
      );

      return { monthlyIncome: amount, source: 'user' };
    }

    case 'confirm_stream':
    case 'dismiss_stream': {
      const streamKey = item.item_key.startsWith('stream:')
        ? item.item_key.slice('stream:'.length)
        : null;

      if (!streamKey) {
        throw new OnboardingError(
          'This item is not a recurring stream',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      const userStatus = request.action === 'confirm_stream' ? 'confirmed' : 'dismissed';

      await deps.db.query(
        `UPDATE recurring_streams
         SET user_status = $3, updated_at = NOW()
         WHERE user_id = $1 AND stream_key = $2`,
        [request.userId, streamKey, userStatus],
      );

      return { streamKey, userStatus };
    }

    case 'reclassify_transaction': {
      const value = valueAsRecord(request.value);
      const role = assertRole(value.role);
      const transactionRowId = value.transactionRowId;

      if (typeof transactionRowId !== 'string' || transactionRowId.length === 0) {
        throw new OnboardingError(
          'reclassify_transaction requires transactionRowId',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      // Scope check: the transaction must belong to this user; the amount
      // is read alongside so the role can be validated against direction.
      const { rows } = await deps.db.query<{ id: string; amount: string }>(
        `SELECT id, amount::text AS amount
         FROM plaid_transactions WHERE id = $1 AND user_id = $2`,
        [transactionRowId, request.userId],
      );

      if (!rows[0]) {
        throw new OnboardingError(
          'Transaction not found',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      assertRoleMatchesDirection(role, Number(rows[0].amount));

      await deps.db.query(
        `INSERT INTO user_classification_overrides (
           user_id, scope, transaction_row_id, economic_role, display_bucket, evidence
         )
         VALUES ($1, 'transaction', $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, transaction_row_id) WHERE scope = 'transaction'
         DO UPDATE SET
           economic_role = EXCLUDED.economic_role,
           display_bucket = EXCLUDED.display_bucket,
           evidence = EXCLUDED.evidence,
           updated_at = NOW()`,
        [
          request.userId,
          transactionRowId,
          role,
          typeof value.displayBucket === 'string' ? value.displayBucket : null,
          JSON.stringify({ reviewItemKey: item.item_key }),
        ],
      );

      return { transactionRowId, role };
    }

    case 'reclassify_merchant': {
      const value = valueAsRecord(request.value);
      const role = assertRole(value.role);
      const merchant = value.merchantNormalized;

      if (typeof merchant !== 'string' || merchant.trim().length === 0) {
        throw new OnboardingError(
          'reclassify_merchant requires merchantNormalized',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      // The stored key must be the SAME normalization the pipeline writes
      // to merchant_normalized, or the override matches nothing: a raw
      // "NETFLIX.COM" would store "netflix.com" while transactions carry
      // "netflix", and the correction would silently no-op.
      const merchantKey = normalizeMerchant(merchant);

      if (!merchantKey) {
        throw new OnboardingError(
          'That merchant name has no usable identity to match on',
          422,
          'INVALID_CORRECTION_SCOPE',
        );
      }

      await deps.db.query(
        `INSERT INTO user_classification_overrides (
           user_id, scope, merchant_normalized, economic_role, display_bucket, evidence
         )
         VALUES ($1, 'merchant', $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, merchant_normalized) WHERE scope = 'merchant'
         DO UPDATE SET
           economic_role = EXCLUDED.economic_role,
           display_bucket = EXCLUDED.display_bucket,
           evidence = EXCLUDED.evidence,
           updated_at = NOW()`,
        [
          request.userId,
          merchantKey,
          role,
          typeof value.displayBucket === 'string' ? value.displayBucket : null,
          JSON.stringify({ reviewItemKey: item.item_key }),
        ],
      );

      return { merchantNormalized: merchantKey, role };
    }
  }
}

/**
 * Explicit recompute: rebuild the whole pipeline for the user's current
 * run. Idempotent — an already-recomputing run reports as queued.
 */
export async function requestRecompute(
  userId: string,
  depsOverride?: CorrectionsDeps,
): Promise<{ status: 'queued' | 'already_recomputing' }> {
  const deps = depsOverride ?? (await defaultDeps());
  const lifecycle = await import('./onboarding-lifecycle.service.js');

  const run = await lifecycle.getLatestRun(userId, deps.db);

  if (!run) {
    throw new OnboardingError(
      'No analysis run exists yet',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  if (run.status === 'recomputing') {
    return { status: 'already_recomputing' };
  }

  if (run.status !== 'review_ready') {
    throw new OnboardingError(
      'The analysis cannot be recomputed right now',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  await deps.transitionRun(run.id, 'recomputing');
  await deps.enqueueRecompute({ userId, analysisRunId: run.id });

  return { status: 'queued' };
}
