/**
 * Coverage-aware review building (API-012).
 *
 * The review is aggregate-first: facts plus coverage plus only the
 * actionable exceptions. Coverage bands are derived from named reasons —
 * partial history, failed institutions, unlinked cards, unresolved
 * movement — never from an invented percentage. Review items carry stable
 * keys so rebuilds preserve what the user already resolved.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import type { ItemSyncOverview } from './analysis-orchestration.service.js';
import {
  computeFinancialFacts,
  createFactSnapshot,
  loadFactsData,
  type FactsData,
} from './financial-facts.service.js';
import { transitionRun } from './onboarding-lifecycle.service.js';
import type { FinancialFacts } from '../types/financial-facts.js';
import type {
  Coverage,
  CoverageReason,
  GeneratedReviewItem,
} from '../types/review.js';

const UNCATEGORIZED = 'Uncategorized';

export type CoverageInput = {
  facts: FinancialFacts;
  items: ItemSyncOverview[];
  requestedDays: number;
  pendingCount: number;
  lastSyncedAt: string | null;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

export function computeCoverage(input: CoverageInput): Coverage {
  const { facts, items, requestedDays } = input;

  const usable = items.filter((item) => item.usable);
  const failed = items.filter((item) => item.syncStatus === 'failed');

  const perItem = items.map((item) => ({
    itemRowId: item.itemRowId,
    institutionName: item.institutionName,
    historyDays: item.historyDaysAvailable,
    status:
      item.syncStatus === 'failed'
        ? ('failed' as const)
        : item.syncStatus === 'complete'
          ? (item.historyDaysAvailable ?? 0) >= requestedDays * 0.9
            ? ('ready' as const)
            : ('limited' as const)
          : ('pending' as const),
  }));

  // Transfer resolution: how much movement-shaped value resolved to a known
  // role rather than staying unknown.
  const movementKnown =
    facts.movement.internalTransferTotal +
    facts.movement.linkedCardPaymentTotal +
    facts.movement.savingsTransferTotal +
    facts.movement.externalCardPaymentTotal;
  const unknownValue =
    facts.unknowns.unknownOutflowTotal + facts.unknowns.unknownInflowTotal;
  const movementShaped = movementKnown + unknownValue;
  const transferRate =
    movementShaped === 0 ? 1 : round2(movementKnown / movementShaped);

  const uncategorized =
    facts.spend.categoryTotals.find((entry) => entry.bucket === UNCATEGORIZED)
      ?.total ?? 0;
  const categorizedShare =
    facts.spend.grossEconomicSpend === 0
      ? 1
      : round2(1 - uncategorized / facts.spend.grossEconomicSpend);

  const totalOutflowObserved =
    facts.spend.grossEconomicSpend +
    facts.movement.externalCardPaymentTotal +
    facts.unknowns.unknownOutflowTotal;
  const externalCardShare =
    totalOutflowObserved === 0
      ? 0
      : facts.movement.externalCardPaymentTotal / totalOutflowObserved;

  const reasons: CoverageReason[] = [];

  if (usable.length === 0) {
    reasons.push({
      code: 'NO_USABLE_ITEM',
      message: 'No connected institution produced usable transaction history.',
    });
  }

  for (const item of failed) {
    reasons.push({
      code: 'ITEM_FAILED',
      message: `${item.institutionName ?? 'One institution'} could not be synced; its activity is missing from every total.`,
    });
  }

  if (
    usable.length > 0 &&
    facts.period.observedDays < requestedDays * 0.9
  ) {
    reasons.push({
      code: 'LIMITED_HISTORY',
      message: `Only ${facts.period.observedDays} of the requested ${requestedDays} days of history were available.`,
    });
  }

  if (externalCardShare > 0.1) {
    reasons.push({
      code: 'UNLINKED_CARD_PAYMENT',
      message: `Payments to an unlinked card represent ${Math.round(
        externalCardShare * 100,
      )}% of observed cash outflow.`,
    });
  }

  if (categorizedShare < 0.7 && facts.spend.grossEconomicSpend > 0) {
    reasons.push({
      code: 'LOW_CATEGORY_COVERAGE',
      message: 'A large share of spending has no usable category.',
    });
  }

  if (transferRate < 0.7 && movementShaped > 0) {
    reasons.push({
      code: 'UNRESOLVED_TRANSFERS',
      message: 'A meaningful share of transfer-shaped activity could not be resolved.',
    });
  }

  if (facts.unknowns.unknownShareOfOutflow > 0.3) {
    reasons.push({
      code: 'HIGH_UNKNOWN_SHARE',
      message: `${Math.round(
        facts.unknowns.unknownShareOfOutflow * 100,
      )}% of outgoing value could not be classified.`,
    });
  }

  if (facts.currency.excludedTransactionCount > 0) {
    reasons.push({
      code: 'MIXED_CURRENCY',
      message: `${facts.currency.excludedTransactionCount} transactions in ${facts.currency.excludedCurrencies.join(
        ', ',
      )} were excluded; every total is in ${facts.currency.primary ?? 'the primary currency'}.`,
    });
  }

  const hasDepository = items.length > 0; // refined below from facts data
  const hasCredit = facts.movement.linkedCardPaymentTotal > 0;

  let band: Coverage['band'];

  if (
    usable.length === 0 ||
    facts.period.observedDays < 30 ||
    facts.unknowns.unknownShareOfOutflow > 0.5
  ) {
    band = 'insufficient';
  } else if (reasons.length > 0) {
    band = 'partial';
  } else {
    band = 'complete';
  }

  return {
    band,
    reasons,
    dimensions: {
      accounts: {
        connectedItems: items.length,
        usableItems: usable.length,
        failedItems: failed.length,
        hasDepository,
        hasCredit,
      },
      history: {
        requestedDays,
        observedDays: facts.period.observedDays,
        perItem,
      },
      transferResolution: { rate: transferRate },
      categories: { categorizedShare },
      freshness: {
        lastSyncedAt: input.lastSyncedAt,
        pendingCount: input.pendingCount,
      },
    },
  };
}

/** What the user can actually act on inside the high-unknown review item. */
export type UnknownActivitySummary = {
  topMerchants: Array<{
    merchantKey: string;
    displayName: string | null;
    total: number;
    count: number;
  }>;
  sampleTransactions: Array<{
    transactionRowId: string;
    displayName: string | null;
    amount: number;
    date: string;
  }>;
};

export type ReviewItemInput = {
  facts: FinancialFacts;
  coverage: Coverage;
  items: ItemSyncOverview[];
  manualMonthlyIncome: number | null;
  externalCardPaymentDescription: string | null;
  unknownActivity?: UnknownActivitySummary | null;
};

/** Only actionable exceptions become review items. */
export function generateReviewItems(input: ReviewItemInput): GeneratedReviewItem[] {
  const { facts, coverage, items, manualMonthlyIncome } = input;
  const generated: GeneratedReviewItem[] = [];

  if (facts.movement.externalCardPaymentTotal > 0) {
    generated.push({
      itemKey: 'external_card_payment',
      type: 'external_card_payment_unattributed',
      required: true,
      evidence: {
        description: input.externalCardPaymentDescription ?? 'Card payment',
        totalObserved: facts.movement.externalCardPaymentTotal,
        // Observed monthly average — NOT the obligations component, which
        // is deliberately zero when a credit account is connected.
        averageMonthlyAmount: round2(
          facts.movement.externalCardPaymentTotal /
            Math.max(facts.period.normalizationMonths, 1),
        ),
      },
      proposedValue: null,
      allowedActions: ['connect_account', 'accept_coverage_limitation'],
    });
  }

  const observedIncome = facts.income.monthlyIncomeEstimate;

  if (
    manualMonthlyIncome !== null &&
    manualMonthlyIncome > 0 &&
    observedIncome > 0 &&
    Math.abs(observedIncome - manualMonthlyIncome) / manualMonthlyIncome > 0.25
  ) {
    generated.push({
      itemKey: 'income_mismatch',
      type: 'income_mismatch',
      required: true,
      evidence: {
        manualMonthlyIncome,
        observedMonthlyIncome: observedIncome,
        estimateSource: facts.income.estimateSource,
      },
      proposedValue: { monthlyIncomeEstimate: observedIncome },
      allowedActions: ['use_observed_value', 'keep_manual_value', 'set_value'],
    });
  }

  for (const item of items) {
    if (item.syncStatus === 'failed') {
      generated.push({
        itemKey: `item_failed:${item.itemRowId}`,
        type: 'institution_connection_failed',
        required: true,
        evidence: {
          institutionName: item.institutionName,
          errorCode: item.lastErrorCode,
        },
        proposedValue: null,
        allowedActions: ['reconnect_institution', 'accept_coverage_limitation'],
      });
    }
  }

  for (const entry of coverage.dimensions.history.perItem) {
    if (entry.status === 'limited') {
      generated.push({
        itemKey: `limited_history:${entry.itemRowId}`,
        type: 'limited_history',
        required: false,
        evidence: {
          institutionName: entry.institutionName,
          historyDays: entry.historyDays,
          requestedDays: coverage.dimensions.history.requestedDays,
        },
        proposedValue: null,
        allowedActions: ['accept_coverage_limitation'],
      });
    }
  }

  if (facts.unknowns.unknownShareOfOutflow > 0.3) {
    generated.push({
      itemKey: 'high_unknown_share',
      type: 'high_unknown_activity',
      required: false,
      evidence: {
        unknownOutflowTotal: facts.unknowns.unknownOutflowTotal,
        unknownShareOfOutflow: facts.unknowns.unknownShareOfOutflow,
        // Without concrete keys the reclassify actions are unusable: the
        // client has nothing to reference. Merchant keys here are already
        // normalized — corrections match them verbatim.
        topMerchants: input.unknownActivity?.topMerchants ?? [],
        sampleTransactions: input.unknownActivity?.sampleTransactions ?? [],
      },
      proposedValue: null,
      allowedActions: [
        'accept_coverage_limitation',
        'reclassify_merchant',
        'reclassify_transaction',
      ],
    });
  }

  for (const stream of facts.recurring.outflows) {
    // Surfaced when it moves the monthly picture OR when a single hit is
    // large: a $500 annual HOA payment normalizes to ~$42/month, under the
    // monthly bar, yet is exactly the bill a plan must not be surprised by.
    if (
      stream.confidence === 'low' &&
      (stream.monthlyAmount >= 50 ||
        (stream.averageAmount >= 250 && stream.cadence !== 'irregular'))
    ) {
      generated.push({
        itemKey: `stream:${stream.streamKey}`,
        type: 'unconfirmed_recurring_stream',
        required: false,
        evidence: {
          displayName: stream.displayName,
          cadence: stream.cadence,
          monthlyAmount: stream.monthlyAmount,
          confidence: stream.confidence,
        },
        proposedValue: null,
        allowedActions: ['confirm_stream', 'dismiss_stream'],
      });
    }
  }

  return generated;
}

// ---------------------------------------------------------------------------
// Review build job
// ---------------------------------------------------------------------------

export type ReviewBuildDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  getItems(userId: string): Promise<ItemSyncOverview[]>;
  getRun(analysisRunId: string): Promise<{
    status: string;
    requestedLookbackDays: number;
    startedAt: string;
  } | null>;
  getManualMonthlyIncome(userId: string): Promise<number | null>;
  getUnknownActivity(userId: string): Promise<UnknownActivitySummary>;
  transitionRun(runId: string, to: 'review_ready'): Promise<void>;
  /** Hook for the delayed-push policy (API-015). */
  onReviewReady(payload: UserAnalysisJobPayload, runStartedAt: string): Promise<void>;
  now(): Date;
};

async function defaultDeps(): Promise<ReviewBuildDeps> {
  const orchestration = await import('./analysis-orchestration.service.js');
  const lifecycle = await import('./onboarding-lifecycle.service.js');

  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    getItems: (userId) => orchestration.getItemSyncOverviews(userId),
    getRun: async (analysisRunId) => {
      const { rows } = await pool.query<{
        status: string;
        requested_lookback_days: number;
        started_at: Date;
      }>(
        `SELECT status, requested_lookback_days, started_at
         FROM financial_analysis_runs WHERE id = $1`,
        [analysisRunId],
      );
      const row = rows[0];
      return row
        ? {
            status: row.status,
            requestedLookbackDays: row.requested_lookback_days,
            startedAt: row.started_at.toISOString(),
          }
        : null;
    },
    // The wizard no longer asks for income; the only manual figure is an
    // override the user set on a previous review, so a mismatch item can
    // only ever be "your correction disagrees with newer evidence".
    getManualMonthlyIncome: async (userId) => {
      const { rows } = await pool.query<{ income_override: string | null }>(
        `SELECT income_override FROM user_info WHERE user_id = $1`,
        [userId],
      );
      const override = rows[0]?.income_override ?? null;
      return override === null ? null : Number(override);
    },
    getUnknownActivity: async (userId) => {
      const [{ rows: merchantRows }, { rows: txnRows }] = await Promise.all([
        pool.query<{
          merchant_normalized: string;
          display_name: string | null;
          total: string;
          count: string;
        }>(
          `SELECT t.merchant_normalized,
                  MAX(COALESCE(t.merchant_name, t.name)) AS display_name,
                  SUM(ABS(t.amount))::text AS total,
                  COUNT(*)::text AS count
           FROM plaid_transactions t
           JOIN transaction_classifications c ON c.transaction_row_id = t.id
           JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
           WHERE t.user_id = $1 AND t.is_removed = FALSE AND t.pending = FALSE
             AND c.economic_role IN ('unknown_outflow', 'unknown_inflow')
             AND t.merchant_normalized IS NOT NULL
           GROUP BY t.merchant_normalized
           ORDER BY SUM(ABS(t.amount)) DESC
           LIMIT 5`,
          [userId],
        ),
        pool.query<{
          id: string;
          display_name: string | null;
          amount: string;
          date: string;
        }>(
          `SELECT t.id, COALESCE(t.merchant_name, t.name) AS display_name,
                  t.amount::text AS amount, t.date::text AS date
           FROM plaid_transactions t
           JOIN transaction_classifications c ON c.transaction_row_id = t.id
           JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
           WHERE t.user_id = $1 AND t.is_removed = FALSE AND t.pending = FALSE
             AND c.economic_role IN ('unknown_outflow', 'unknown_inflow')
           ORDER BY ABS(t.amount) DESC
           LIMIT 5`,
          [userId],
        ),
      ]);

      return {
        topMerchants: merchantRows.map((row) => ({
          merchantKey: row.merchant_normalized,
          displayName: row.display_name,
          total: Number(row.total),
          count: Number(row.count),
        })),
        sampleTransactions: txnRows.map((row) => ({
          transactionRowId: row.id,
          displayName: row.display_name,
          amount: Number(row.amount),
          date: row.date,
        })),
      };
    },
    transitionRun: (runId, to) => lifecycle.transitionRun(runId, to),
    onReviewReady: async (payload, runStartedAt) => {
      // Delay policy (API-015): a review that took longer than the expected
      // window earns exactly one push per device. Fast completions rely on
      // foreground polling and send nothing.
      const push = await import('./push.service.js');
      const enqueue = await import('../jobs/enqueue.js');

      const elapsedSeconds =
        (Date.now() - Date.parse(runStartedAt)) / 1000;

      if (elapsedSeconds > push.expectedAnalysisWindowSeconds()) {
        await enqueue.enqueueReviewReadyNotification(payload, 0);
      }
    },
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Review read model (GET /onboarding/financial-review)
// ---------------------------------------------------------------------------

export type ReviewResponse = {
  reviewId: string;
  analysisRunId: string;
  snapshotVersion: number;
  status: 'needs_confirmation' | 'recomputing' | 'confirmed';
  period: {
    requestedDays: number;
    oldestObservedDate: string | null;
    throughDate: string;
  };
  coverage: { band: Coverage['band']; reasons: Coverage['reasons'] };
  coverageDetail: Coverage['dimensions'];
  facts: {
    monthlyIncomeEstimate: number;
    averageMonthlyEconomicSpend: number;
    averageMonthlyCashObligations: number;
    availableToSpend: number;
  };
  fullFacts: FinancialFacts;
  recurringStreams: FinancialFacts['recurring']['outflows'];
  incomeStreams: FinancialFacts['income']['incomeStreams'];
  categoryTotals: FinancialFacts['spend']['categoryTotals'];
  reviewItems: Array<{
    id: string;
    itemKey: string;
    type: string;
    required: boolean;
    status: string;
    evidence: unknown;
    proposedValue: unknown;
    confirmedValue: unknown;
    allowedActions: string[];
  }>;
};

/**
 * Latest review for a user. Throws OnboardingError(409,
 * ANALYSIS_NOT_REVIEWABLE) while analysis has not produced a snapshot yet.
 */
export async function getFinancialReviewForUser(
  userId: string,
  db: Queryable = pool,
): Promise<ReviewResponse> {
  const lifecycle = await import('./onboarding-lifecycle.service.js');
  const { OnboardingError } = await import('../types/onboarding.js');
  const factsService = await import('./financial-facts.service.js');

  const run = await lifecycle.getLatestRun(userId, db);

  const reviewableStatuses = ['review_ready', 'recomputing', 'confirmed'];

  if (!run || !reviewableStatuses.includes(run.status)) {
    throw new OnboardingError(
      'Financial analysis is not reviewable yet',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  const snapshot = await factsService.getLatestSnapshot(run.id, db);

  if (!snapshot) {
    throw new OnboardingError(
      'Financial analysis is not reviewable yet',
      409,
      'ANALYSIS_NOT_REVIEWABLE',
    );
  }

  const { rows: itemRows } = await db.query<{
    id: string;
    item_key: string;
    type: string;
    required: boolean;
    status: string;
    evidence: unknown;
    proposed_value: unknown;
    confirmed_value: unknown;
    allowed_actions: string[];
  }>(
    `SELECT id, item_key, type, required, status, evidence, proposed_value,
            confirmed_value, allowed_actions
     FROM financial_review_items
     WHERE analysis_run_id = $1
     ORDER BY required DESC, created_at ASC`,
    [run.id],
  );

  const facts = snapshot.facts;
  const coverage = snapshot.coverage as Coverage;

  return {
    reviewId: snapshot.id,
    analysisRunId: run.id,
    snapshotVersion: snapshot.version,
    status:
      run.status === 'confirmed'
        ? 'confirmed'
        : run.status === 'recomputing'
          ? 'recomputing'
          : 'needs_confirmation',
    period: {
      requestedDays: run.requestedLookbackDays,
      oldestObservedDate: facts.period.oldestObservedDate,
      throughDate: facts.period.throughDate,
    },
    coverage: { band: coverage.band, reasons: coverage.reasons },
    coverageDetail: coverage.dimensions,
    facts: {
      monthlyIncomeEstimate: facts.income.monthlyIncomeEstimate,
      averageMonthlyEconomicSpend: facts.spend.averageMonthlyEconomicSpend,
      averageMonthlyCashObligations:
        facts.cashObligations.averageMonthlyCashObligations,
      availableToSpend: facts.balances.availableToSpend,
    },
    fullFacts: facts,
    recurringStreams: facts.recurring.outflows,
    incomeStreams: facts.income.incomeStreams,
    categoryTotals: facts.spend.categoryTotals,
    reviewItems: itemRows.map((row) => ({
      id: row.id,
      itemKey: row.item_key,
      type: row.type,
      required: row.required,
      status: row.status,
      evidence: row.evidence,
      proposedValue: row.proposed_value,
      confirmedValue: row.confirmed_value,
      allowedActions: row.allowed_actions,
    })),
  };
}

/**
 * BUILD_FINANCIAL_REVIEW: compute facts + coverage together, write exactly
 * one new snapshot version, upsert review items preserving user
 * resolutions, prune vanished open items, and mark the run reviewable.
 */
export async function buildFinancialReview(
  payload: UserAnalysisJobPayload,
  depsOverride?: ReviewBuildDeps,
): Promise<{ snapshotVersion: number; reviewItems: number }> {
  const deps = depsOverride ?? (await defaultDeps());

  const run = await deps.getRun(payload.analysisRunId);

  if (!run) {
    throw new Error(`analysis run ${payload.analysisRunId} not found`);
  }

  if (run.status !== 'processing' && run.status !== 'recomputing') {
    // Replayed job for an already-reviewable or terminal run: no-op.
    logger.info('review build skipped; run not in a building state', {
      analysisRunId: payload.analysisRunId,
      status: run.status,
    });
    return { snapshotVersion: 0, reviewItems: 0 };
  }

  const [data, items, manualIncome, unknownActivity] = await Promise.all([
    deps.loadData(payload.userId),
    deps.getItems(payload.userId),
    deps.getManualMonthlyIncome(payload.userId),
    deps.getUnknownActivity(payload.userId),
  ]);

  const facts = computeFinancialFacts(data, deps.now().toISOString().slice(0, 10));

  const pendingCount = data.transactions.filter((txn) => txn.pending).length;

  // The freshness dimension reports when data actually last synced — the
  // newest per-Item sync time — not the build clock, which always read as
  // "fresh" no matter how stale the underlying data was.
  const lastSyncedAt = items.reduce<string | null>(
    (newest, item) =>
      item.lastSyncedAt && (newest === null || item.lastSyncedAt > newest)
        ? item.lastSyncedAt
        : newest,
    null,
  );

  const coverage = computeCoverage({
    facts,
    items,
    requestedDays: run.requestedLookbackDays,
    pendingCount,
    lastSyncedAt,
  });

  const generated = generateReviewItems({
    facts,
    coverage,
    items,
    manualMonthlyIncome: manualIncome,
    externalCardPaymentDescription: null,
    unknownActivity,
  });

  const snapshot = await createFactSnapshot(deps.db, {
    analysisRunId: payload.analysisRunId,
    userId: payload.userId,
    facts,
    coverage,
  });

  for (const item of generated) {
    await deps.db.query(
      `INSERT INTO financial_review_items (
         analysis_run_id, user_id, item_key, type, required, evidence,
         proposed_value, allowed_actions
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[])
       ON CONFLICT (analysis_run_id, item_key) DO UPDATE SET
         type = EXCLUDED.type,
         required = EXCLUDED.required,
         evidence = EXCLUDED.evidence,
         proposed_value = EXCLUDED.proposed_value,
         allowed_actions = EXCLUDED.allowed_actions,
         updated_at = NOW()`,
      [
        payload.analysisRunId,
        payload.userId,
        item.itemKey,
        item.type,
        item.required,
        JSON.stringify(item.evidence),
        item.proposedValue === null ? null : JSON.stringify(item.proposedValue),
        item.allowedActions,
      ],
    );
  }

  // Open items whose condition vanished (e.g. the card got connected) are
  // removed; resolved/accepted items stay for the audit trail.
  await deps.db.query(
    `DELETE FROM financial_review_items
     WHERE analysis_run_id = $1
       AND status = 'open'
       AND NOT (item_key = ANY($2::text[]))`,
    [payload.analysisRunId, generated.map((item) => item.itemKey)],
  );

  await deps.transitionRun(payload.analysisRunId, 'review_ready');
  await deps.onReviewReady(payload, run.startedAt);

  logger.info('review built', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    snapshotVersion: snapshot.version,
    coverageBand: coverage.band,
    reviewItems: generated.length,
  });

  return { snapshotVersion: snapshot.version, reviewItems: generated.length };
}
