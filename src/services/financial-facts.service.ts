/**
 * Facts computation over the reconciled ledger (API-011).
 *
 * computeFinancialFacts is pure: same inputs and build date, same output.
 * The read path touches only FinBot tables — never live Plaid. Account
 * movement (transfers, linked card payments) is excluded from spend and
 * income; a card purchase and its matched checking payment count exactly
 * once; payments to unlinked cards surface as cash obligations, not spend.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import { summarizeBalances } from './facts.service.js';
import type { AccountBalance } from '../types/facts.js';
import {
  FACTS_RULE_VERSION,
  type CategoryTotal,
  type FactsRecurringStream,
  type FactsTransaction,
  type FinancialFacts,
} from '../types/financial-facts.js';

const DAYS_PER_MONTH = 30.44;
const UNCATEGORIZED = 'Uncategorized';

function roundCents(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function monthlyFromCadence(averageAmount: number, cadenceDays: number): number {
  if (cadenceDays <= 0) return 0;
  return roundCents(averageAmount * (DAYS_PER_MONTH / cadenceDays));
}

export type FactsData = {
  transactions: FactsTransaction[];
  accounts: AccountBalance[];
  streams: FactsRecurringStream[];
};

/**
 * Pure facts computation. `throughDate` is the build date (YYYY-MM-DD),
 * injected so results are reproducible.
 */
export function computeFinancialFacts(
  data: FactsData,
  throughDate: string,
): FinancialFacts {
  const settled = data.transactions.filter((txn) => !txn.pending);

  const oldest = settled.reduce<string | null>(
    (min, txn) => (min === null || txn.date < min ? txn.date : min),
    null,
  );

  const observedDays = oldest
    ? Math.max(1, Math.round(parseDay(throughDate) - parseDay(oldest)) + 1)
    : 0;

  // Floor the normalization window at ~one month so two days of history
  // cannot extrapolate into a wild monthly figure.
  const normalizationMonths = Math.max(observedDays, 28) / DAYS_PER_MONTH;

  let grossSpend = 0;
  let refunds = 0;
  let debtPayments = 0;
  let externalCardPayments = 0;
  let linkedCardPayments = 0;
  let internalTransfers = 0;
  let savingsTransfers = 0;
  let unknownOutflow = 0;
  let unknownInflow = 0;
  let observedIncome = 0;
  let totalOutflow = 0;

  const buckets = new Map<string, { total: number; count: number }>();

  for (const txn of settled) {
    const magnitude = Math.abs(txn.amount);

    if (txn.amount > 0) {
      totalOutflow += magnitude;
    }

    switch (txn.role) {
      case 'expense':
      case 'interest_or_fee': {
        if (txn.amount > 0) {
          grossSpend += magnitude;
          const key = txn.displayBucket ?? UNCATEGORIZED;
          const bucket = buckets.get(key) ?? { total: 0, count: 0 };
          bucket.total += magnitude;
          bucket.count += 1;
          buckets.set(key, bucket);
        }
        break;
      }
      case 'refund_or_credit':
        if (txn.amount < 0) refunds += magnitude;
        break;
      case 'earned_income':
        if (txn.amount < 0) observedIncome += magnitude;
        break;
      case 'debt_principal_payment':
        if (txn.amount > 0) debtPayments += magnitude;
        break;
      case 'credit_card_payment':
        if (txn.amount > 0) {
          if (txn.linked) linkedCardPayments += magnitude;
          else externalCardPayments += magnitude;
        }
        break;
      case 'internal_transfer':
        if (txn.amount > 0) internalTransfers += magnitude;
        break;
      case 'savings_or_investment_transfer':
        if (txn.amount > 0) savingsTransfers += magnitude;
        break;
      case 'unknown_outflow':
        unknownOutflow += magnitude;
        break;
      case 'unknown_inflow':
        unknownInflow += magnitude;
        break;
    }
  }

  const netSpend = Math.max(0, grossSpend - refunds);

  const categoryTotals: CategoryTotal[] = [...buckets.entries()]
    .map(([bucket, entry]) => ({
      bucket,
      total: roundCents(entry.total),
      monthlyAverage: roundCents(entry.total / normalizationMonths),
      share: grossSpend === 0 ? 0 : roundCents(entry.total / grossSpend),
      transactionCount: entry.count,
    }))
    .sort((a, b) => b.total - a.total);

  const activeStreams = data.streams.filter(
    (stream) => stream.userStatus !== 'dismissed',
  );

  const incomeStreams = activeStreams
    .filter(
      (stream) =>
        stream.direction === 'inflow' &&
        (stream.confidence === 'high' || stream.confidence === 'medium'),
    )
    .map((stream) => ({
      streamKey: stream.streamKey,
      displayName: stream.displayName,
      cadence: stream.cadence,
      monthlyAmount: monthlyFromCadence(stream.averageAmount, stream.cadenceDays),
      confidence: stream.confidence,
    }));

  const streamIncome = incomeStreams.reduce(
    (sum, stream) => sum + stream.monthlyAmount,
    0,
  );

  const observedMonthlyIncome = roundCents(observedIncome / normalizationMonths);

  const monthlyIncomeEstimate =
    incomeStreams.length > 0 ? roundCents(streamIncome) : observedMonthlyIncome;

  const netSpendMonthly = roundCents(netSpend / normalizationMonths);
  const debtMonthly = roundCents(debtPayments / normalizationMonths);
  const externalCardMonthly = roundCents(externalCardPayments / normalizationMonths);

  return {
    ruleVersion: FACTS_RULE_VERSION,
    period: {
      oldestObservedDate: oldest,
      throughDate,
      observedDays,
      normalizationMonths: Math.round(normalizationMonths * 100) / 100,
    },
    income: {
      monthlyIncomeEstimate,
      estimateSource:
        incomeStreams.length > 0
          ? 'recurring_streams'
          : observedIncome > 0
            ? 'observed_average'
            : 'none',
      totalObservedIncome: roundCents(observedIncome),
      incomeStreams,
    },
    spend: {
      averageMonthlyEconomicSpend: netSpendMonthly,
      grossEconomicSpend: roundCents(grossSpend),
      refundsAndCredits: roundCents(refunds),
      netEconomicSpend: roundCents(netSpend),
      categoryTotals,
    },
    cashObligations: {
      averageMonthlyCashObligations: roundCents(
        netSpendMonthly + debtMonthly + externalCardMonthly,
      ),
      components: {
        netEconomicSpendMonthly: netSpendMonthly,
        debtPaymentsMonthly: debtMonthly,
        externalCardPaymentsMonthly: externalCardMonthly,
      },
    },
    balances: summarizeBalances(data.accounts),
    recurring: {
      outflows: activeStreams
        .filter((stream) => stream.direction === 'outflow')
        .map((stream) => ({
          streamKey: stream.streamKey,
          displayName: stream.displayName,
          cadence: stream.cadence,
          averageAmount: stream.averageAmount,
          monthlyAmount: monthlyFromCadence(stream.averageAmount, stream.cadenceDays),
          amountVariance: stream.amountVariance,
          confidence: stream.confidence,
          lastDate: stream.lastDate,
        })),
    },
    movement: {
      internalTransferTotal: roundCents(internalTransfers),
      linkedCardPaymentTotal: roundCents(linkedCardPayments),
      savingsTransferTotal: roundCents(savingsTransfers),
      externalCardPaymentTotal: roundCents(externalCardPayments),
    },
    unknowns: {
      unknownOutflowTotal: roundCents(unknownOutflow),
      unknownInflowTotal: roundCents(unknownInflow),
      unknownShareOfOutflow:
        totalOutflow === 0 ? 0 : roundCents(unknownOutflow / totalOutflow),
    },
  };
}

// ---------------------------------------------------------------------------
// Data loading and snapshot persistence
// ---------------------------------------------------------------------------

export async function loadFactsData(
  userId: string,
  db: Queryable = pool,
): Promise<FactsData> {
  const { rows: txnRows } = await db.query<{
    row_id: string;
    amount: string;
    date: string;
    pending: boolean;
    economic_role: FactsTransaction['role'];
    display_bucket: string | null;
    account_type: string | null;
    linked: boolean;
  }>(
    `SELECT t.id AS row_id, t.amount::text AS amount, t.date::text AS date,
            t.pending, c.economic_role, c.display_bucket,
            a.type AS account_type,
            (l_out.id IS NOT NULL OR l_in.id IS NOT NULL) AS linked
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     LEFT JOIN plaid_accounts a ON a.account_id = t.account_id
     LEFT JOIN transaction_links l_out ON l_out.outflow_transaction_row_id = t.id
     LEFT JOIN transaction_links l_in ON l_in.inflow_transaction_row_id = t.id
     WHERE t.user_id = $1 AND t.is_removed = FALSE`,
    [userId],
  );

  const { rows: accountRows } = await db.query<{
    account_id: string;
    name: string;
    type: string;
    current_balance: string | null;
    available_balance: string | null;
  }>(
    `SELECT a.account_id, a.name, a.type,
            a.current_balance::text AS current_balance,
            a.available_balance::text AS available_balance
     FROM plaid_accounts a
     JOIN plaid_items i ON i.id = a.plaid_item_id
     WHERE i.user_id = $1 AND i.status = 'active'`,
    [userId],
  );

  const { rows: streamRows } = await db.query<{
    stream_key: string;
    direction: 'inflow' | 'outflow';
    display_name: string;
    cadence: string;
    cadence_days: string;
    average_amount: string;
    amount_variance: string;
    confidence: 'high' | 'medium' | 'low';
    last_date: string;
    user_status: 'detected' | 'confirmed' | 'dismissed';
  }>(
    `SELECT stream_key, direction, display_name, cadence,
            cadence_days::text AS cadence_days,
            average_amount::text AS average_amount,
            amount_variance::text AS amount_variance,
            confidence, last_date::text AS last_date, user_status
     FROM recurring_streams
     WHERE user_id = $1`,
    [userId],
  );

  return {
    transactions: txnRows.map((row) => ({
      rowId: row.row_id,
      amount: Number(row.amount),
      date: row.date,
      pending: row.pending,
      role: row.economic_role,
      displayBucket: row.display_bucket,
      accountType: row.account_type,
      linked: row.linked,
    })),
    accounts: accountRows.map((row) => ({
      accountId: row.account_id,
      name: row.name,
      type: row.type,
      currentBalance: row.current_balance === null ? null : Number(row.current_balance),
      availableBalance:
        row.available_balance === null ? null : Number(row.available_balance),
    })),
    streams: streamRows.map((row) => ({
      streamKey: row.stream_key,
      direction: row.direction,
      displayName: row.display_name,
      cadence: row.cadence,
      cadenceDays: Number(row.cadence_days),
      averageAmount: Number(row.average_amount),
      amountVariance: Number(row.amount_variance),
      confidence: row.confidence,
      lastDate: row.last_date,
      userStatus: row.user_status,
    })),
  };
}

export type SnapshotRecord = {
  id: string;
  analysisRunId: string;
  version: number;
  facts: FinancialFacts;
  coverage: unknown;
  ruleVersion: string;
  createdAt: string;
};

/** Insert the next snapshot version for a run. */
export async function createFactSnapshot(
  db: Queryable,
  input: {
    analysisRunId: string;
    userId: string;
    facts: FinancialFacts;
    coverage: unknown;
  },
): Promise<SnapshotRecord> {
  const { rows } = await db.query<{
    id: string;
    version: number;
    created_at: Date;
  }>(
    `INSERT INTO financial_fact_snapshots (
       analysis_run_id, user_id, version, facts, coverage, rule_version
     )
     SELECT $1, $2,
            COALESCE(MAX(version), 0) + 1,
            $3::jsonb, $4::jsonb, $5
     FROM financial_fact_snapshots
     WHERE analysis_run_id = $1
     RETURNING id, version, created_at`,
    [
      input.analysisRunId,
      input.userId,
      JSON.stringify(input.facts),
      JSON.stringify(input.coverage),
      FACTS_RULE_VERSION,
    ],
  );

  const row = rows[0];

  if (!row) {
    throw new Error('snapshot insert returned no row');
  }

  return {
    id: row.id,
    analysisRunId: input.analysisRunId,
    version: row.version,
    facts: input.facts,
    coverage: input.coverage,
    ruleVersion: FACTS_RULE_VERSION,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getLatestSnapshot(
  analysisRunId: string,
  db: Queryable = pool,
): Promise<SnapshotRecord | null> {
  const { rows } = await db.query<{
    id: string;
    version: number;
    facts: FinancialFacts;
    coverage: unknown;
    rule_version: string;
    created_at: Date;
  }>(
    `SELECT id, version, facts, coverage, rule_version, created_at
     FROM financial_fact_snapshots
     WHERE analysis_run_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [analysisRunId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    analysisRunId,
    version: row.version,
    facts: row.facts,
    coverage: row.coverage,
    ruleVersion: row.rule_version,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pipeline job
// ---------------------------------------------------------------------------

export type FactsJobDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  enqueueNextStage(payload: UserAnalysisJobPayload): Promise<unknown>;
  now(): Date;
};

async function defaultDeps(): Promise<FactsJobDeps> {
  const [enqueue, jobs] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('../jobs/types.js'),
  ]);

  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    enqueueNextStage: (payload) =>
      enqueue.enqueueAnalysisStage(jobs.JOB.BUILD_FINANCIAL_REVIEW, payload),
    now: () => new Date(),
  };
}

/**
 * BUILD_FINANCIAL_FACTS: verify the deterministic computation succeeds over
 * current data, then chain the review build (which recomputes facts and
 * coverage together and writes the snapshot exactly once per rebuild).
 */
export async function buildFinancialFacts(
  payload: UserAnalysisJobPayload,
  depsOverride?: FactsJobDeps,
): Promise<FinancialFacts> {
  const deps = depsOverride ?? (await defaultDeps());

  const data = await deps.loadData(payload.userId);
  const facts = computeFinancialFacts(data, deps.now().toISOString().slice(0, 10));

  logger.info('facts computed', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    observedDays: facts.period.observedDays,
    monthlyIncomeEstimate: facts.income.monthlyIncomeEstimate,
    monthlySpend: facts.spend.averageMonthlyEconomicSpend,
  });

  await deps.enqueueNextStage(payload);

  return facts;
}
