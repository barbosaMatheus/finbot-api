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
import {
  declaredObligationsMonthly,
  type DeclaredObligation,
} from '../types/manual-profile.js';
import { parseObligations } from './user-info.service.js';
import { isStreamStale } from '../lib/streams.js';
import {
  FACTS_RULE_VERSION,
  type AccountBalance,
  type AmountClass,
  type BalanceSummary,
  type CategoryTotal,
  type FactsRecurringStream,
  type FactsTransaction,
  type FinancialFacts,
} from '../types/financial-facts.js';

const DAYS_PER_MONTH = 30.44;
const UNCATEGORIZED = 'Uncategorized';

/**
 * Trailing window (six months) for every flow total and monthly figure.
 * History is pulled two years deep so long-cadence bills can be detected,
 * but a two-year average smooths over a raise or a move, and the review
 * must describe the recent past. Recurring streams — computed upstream over
 * the full history — are unaffected.
 */
export const SPEND_WINDOW_DAYS = 182;

function roundCents(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function isoDate(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

function monthlyFromCadence(averageAmount: number, cadenceDays: number): number {
  if (cadenceDays <= 0) return 0;
  return roundCents(averageAmount * (DAYS_PER_MONTH / cadenceDays));
}

/** Plaid account types whose balance is debt, not money the user has. */
const LIABILITY_TYPES: ReadonlySet<string> = new Set(['credit', 'loan']);

/**
 * Rolls up account balances into assets, liabilities, and what is actually
 * spendable right now.
 *
 * Credit and loan balances are reported by Plaid as positive numbers
 * representing debt, so they are summed into liabilities rather than assets —
 * treating a credit card balance as money you have is the single most
 * dangerous mistake this function could make.
 *
 * `availableToSpend` counts only depository accounts, and prefers available
 * balance over current balance because the difference is money already
 * committed to pending transactions.
 */
export function summarizeBalances(accounts: readonly AccountBalance[]): BalanceSummary {
  let totalAssets = 0;
  let totalLiabilities = 0;
  let availableToSpend = 0;

  for (const account of accounts) {
    const current = account.currentBalance ?? 0;

    if (LIABILITY_TYPES.has(account.type)) {
      totalLiabilities += current;
      continue;
    }

    totalAssets += current;

    if (account.type === 'depository') {
      availableToSpend += account.availableBalance ?? current;
    }
  }

  return {
    totalAssets: roundCents(totalAssets),
    totalLiabilities: roundCents(totalLiabilities),
    netPosition: roundCents(totalAssets - totalLiabilities),
    availableToSpend: roundCents(availableToSpend),
    accountCount: accounts.length,
  };
}

export type FactsData = {
  transactions: FactsTransaction[];
  accounts: AccountBalance[];
  streams: FactsRecurringStream[];
  /** Off-book bills declared in onboarding (user_info.declared_obligations). */
  declaredObligations: DeclaredObligation[];
};

// The staleness rule lives in lib/streams.ts so the gameplan engine can
// share it without importing the database pool; re-exported for callers.
export { isStreamStale };

/** The lowest and highest recent amount, the range the review quotes; null with no evidence. */
export function amountRangeOf(amounts: readonly number[]): { low: number; high: number } | null {
  if (amounts.length === 0) return null;
  return { low: Math.min(...amounts), high: Math.max(...amounts) };
}

/** Recent amounts from a stream's evidence JSON; anything malformed reads as no evidence. */
function parseEvidenceAmounts(evidence: unknown): number[] {
  if (typeof evidence !== 'object' || evidence === null) return [];
  const amounts = (evidence as { amounts?: unknown }).amounts;
  if (!Array.isArray(amounts)) return [];
  return amounts.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

/**
 * Pure facts computation. `throughDate` is the build date (YYYY-MM-DD),
 * injected so results are reproducible.
 */
export function computeFinancialFacts(
  data: FactsData,
  throughDate: string,
): FinancialFacts {
  const settledAll = data.transactions.filter((txn) => !txn.pending);

  // --- Currency partition --------------------------------------------------
  // Sums of unlike units are meaningless. Facts are computed in the user's
  // primary currency (the one most settled transactions carry; ties break
  // alphabetically); everything else is excluded and REPORTED, never
  // silently added as if a CAD dollar were a USD dollar.
  const currencyCounts = new Map<string, number>();

  for (const txn of settledAll) {
    if (txn.isoCurrencyCode) {
      currencyCounts.set(
        txn.isoCurrencyCode,
        (currencyCounts.get(txn.isoCurrencyCode) ?? 0) + 1,
      );
    }
  }

  const primaryCurrency =
    [...currencyCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? null;

  const inPrimary = (code: string | null | undefined): boolean =>
    code == null || primaryCurrency === null || code === primaryCurrency;

  const settled = settledAll.filter((txn) => inPrimary(txn.isoCurrencyCode));
  const excluded = settledAll.filter((txn) => !inPrimary(txn.isoCurrencyCode));
  const excludedCurrencies = [
    ...new Set(excluded.map((txn) => txn.isoCurrencyCode as string)),
  ].sort();

  const accounts = data.accounts.filter((account) =>
    inPrimary(account.isoCurrencyCode),
  );

  // --- Observed coverage (full history) ------------------------------------
  const oldestByAccount = new Map<string | null, string>();
  let oldest: string | null = null;

  for (const txn of settled) {
    if (oldest === null || txn.date < oldest) oldest = txn.date;

    const current = oldestByAccount.get(txn.accountId);
    if (current === undefined || txn.date < current) {
      oldestByAccount.set(txn.accountId, txn.date);
    }
  }

  const observedDays = oldest
    ? Math.max(1, Math.round(parseDay(throughDate) - parseDay(oldest)) + 1)
    : 0;

  // --- Trailing spend window -----------------------------------------------
  // Every flow total and monthly figure below is computed over the trailing
  // SPEND_WINDOW_DAYS only (see the constant). Coverage above still reports
  // the full history so the review can say how much was seen.
  const windowStart = isoDate(parseDay(throughDate) - (SPEND_WINDOW_DAYS - 1));
  const inWindow = settled.filter((txn) => txn.date >= windowStart);
  const spendWindowStart =
    oldest === null ? null : oldest > windowStart ? oldest : windowStart;
  const spendWindowDays =
    oldest === null ? 0 : Math.min(observedDays, SPEND_WINDOW_DAYS);

  // --- Per-account normalization windows -----------------------------------
  // One global window understates accounts with shallow history: 30 days of
  // card activity normalized over a 180-day checking window reads ~6× too
  // low. Every monthly figure is the sum of per-account contributions, each
  // normalized over that account's own observed window, clipped to the
  // trailing spend window. Floor every window at ~one month so two days of
  // history cannot extrapolate into a wild monthly figure.
  const normalizationMonths = Math.max(spendWindowDays, 28) / DAYS_PER_MONTH;

  const monthsForAccount = (accountId: string | null): number => {
    const accountOldest = oldestByAccount.get(accountId);

    if (accountOldest === undefined) {
      return normalizationMonths;
    }

    const accountStart = accountOldest > windowStart ? accountOldest : windowStart;
    const days = Math.max(
      1,
      Math.round(parseDay(throughDate) - parseDay(accountStart)) + 1,
    );

    return Math.max(days, 28) / DAYS_PER_MONTH;
  };

  let grossSpend = 0;
  let grossSpendMonthly = 0;
  let refunds = 0;
  let refundsMonthly = 0;
  let debtPayments = 0;
  let debtPaymentsMonthly = 0;
  let externalCardPayments = 0;
  let externalCardPaymentsMonthly = 0;
  let linkedCardPayments = 0;
  let internalTransfers = 0;
  let savingsTransfers = 0;
  let unknownOutflow = 0;
  let unknownInflow = 0;
  let observedIncome = 0;
  let observedIncomeMonthly = 0;
  let totalOutflow = 0;

  const buckets = new Map<string, { total: number; monthly: number; count: number }>();

  for (const txn of inWindow) {
    const magnitude = Math.abs(txn.amount);
    const months = monthsForAccount(txn.accountId);

    if (txn.amount > 0) {
      totalOutflow += magnitude;
    }

    // A role whose expected direction contradicts the amount sign (e.g. an
    // override calling an inflow 'expense') must land in unknowns, never
    // silently vanish from every total.
    let counted = true;

    switch (txn.role) {
      case 'expense':
      case 'interest_or_fee': {
        if (txn.amount > 0) {
          grossSpend += magnitude;
          grossSpendMonthly += magnitude / months;
          const key = txn.displayBucket ?? UNCATEGORIZED;
          const bucket = buckets.get(key) ?? { total: 0, monthly: 0, count: 0 };
          bucket.total += magnitude;
          bucket.monthly += magnitude / months;
          bucket.count += 1;
          buckets.set(key, bucket);
        } else {
          counted = false;
        }
        break;
      }
      case 'refund_or_credit':
        if (txn.amount < 0) {
          refunds += magnitude;
          refundsMonthly += magnitude / months;
        } else {
          counted = false;
        }
        break;
      case 'earned_income':
        if (txn.amount < 0) {
          observedIncome += magnitude;
          observedIncomeMonthly += magnitude / months;
        } else {
          counted = false;
        }
        break;
      case 'debt_principal_payment':
        if (txn.amount > 0) {
          debtPayments += magnitude;
          debtPaymentsMonthly += magnitude / months;
        } else {
          counted = false;
        }
        break;
      case 'credit_card_payment':
        // The inflow side (the card's credit) is legitimate movement; only
        // the paying outflow is measured.
        if (txn.amount > 0) {
          if (txn.linked) {
            linkedCardPayments += magnitude;
          } else {
            externalCardPayments += magnitude;
            externalCardPaymentsMonthly += magnitude / months;
          }
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

    if (!counted) {
      if (txn.amount > 0) unknownOutflow += magnitude;
      else unknownInflow += magnitude;
    }
  }

  const netSpend = Math.max(0, grossSpend - refunds);
  const netSpendMonthly = roundCents(Math.max(0, grossSpendMonthly - refundsMonthly));

  const categoryTotals: CategoryTotal[] = [...buckets.entries()]
    .map(([bucket, entry]) => ({
      bucket,
      total: roundCents(entry.total),
      monthlyAverage: roundCents(entry.monthly),
      share: grossSpend === 0 ? 0 : roundCents(entry.total / grossSpend),
      transactionCount: entry.count,
    }))
    .sort((a, b) => b.total - a.total);

  const activeStreams = data.streams.filter(
    (stream) => stream.userStatus !== 'dismissed' && !isStreamStale(stream, throughDate),
  );

  const incomeStreams = activeStreams
    .filter(
      (stream) =>
        stream.direction === 'inflow' &&
        // Only earned income feeds the estimate. A regular Zelle or
        // marketplace deposit that classification refused to call income
        // must not become income through the recurrence back door — unless
        // the user explicitly confirmed the stream as real income.
        (stream.userStatus === 'confirmed' ||
          ((stream.dominantRole ?? null) === 'earned_income' &&
            (stream.confidence === 'high' || stream.confidence === 'medium'))),
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

  const observedMonthlyIncome = roundCents(observedIncomeMonthly);

  const monthlyIncomeEstimate =
    incomeStreams.length > 0 ? roundCents(streamIncome) : observedMonthlyIncome;

  const debtMonthly = roundCents(debtPaymentsMonthly);
  const externalCardMonthly = roundCents(externalCardPaymentsMonthly);

  // A payment to a card we can see is movement — its purchases are already
  // in netSpend, so counting the payment again double-counts the card's
  // entire spend. Only when the user has NO connected credit account does
  // an unmatched card payment represent spending we cannot otherwise see.
  const hasLinkedCreditAccount = accounts.some((account) => account.type === 'credit');
  const externalCardObligationsMonthly = hasLinkedCreditAccount ? 0 : externalCardMonthly;

  // Off-book bills from onboarding Q5 — rent to a person, a family loan,
  // child support. Plaid cannot see them, and without them every number is
  // wrong for anyone who has one. Monthly and weekly amounts normalize into
  // the obligations figure; one-time amounts are surfaced whole, never
  // smeared across months.
  const declaredMonthly = declaredObligationsMonthly(data.declaredObligations);
  const declaredOneTime = data.declaredObligations.filter(
    (obligation) => obligation.cadence === 'one_time',
  );
  const declaredOneTimeTotal = roundCents(
    declaredOneTime.reduce((sum, obligation) => sum + obligation.amount, 0),
  );

  return {
    ruleVersion: FACTS_RULE_VERSION,
    period: {
      oldestObservedDate: oldest,
      throughDate,
      observedDays,
      spendWindowDays,
      spendWindowStart,
      normalizationMonths: Math.round(normalizationMonths * 100) / 100,
    },
    currency: {
      primary: primaryCurrency,
      excludedTransactionCount: excluded.length,
      excludedCurrencies,
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
        netSpendMonthly + debtMonthly + externalCardObligationsMonthly + declaredMonthly,
      ),
      components: {
        netEconomicSpendMonthly: netSpendMonthly,
        debtPaymentsMonthly: debtMonthly,
        // The value COUNTED into obligations — zero when a credit account
        // is connected (the observed total stays in movement).
        externalCardPaymentsMonthly: externalCardObligationsMonthly,
        declaredObligationsMonthly: declaredMonthly,
      },
      declaredOneTime: { total: declaredOneTimeTotal, count: declaredOneTime.length },
    },
    balances: summarizeBalances(accounts),
    recurring: {
      outflows: activeStreams
        .filter((stream) => stream.direction === 'outflow')
        .map((stream) => ({
          streamKey: stream.streamKey,
          displayName: stream.displayName,
          cadence: stream.cadence,
          cadenceDays: stream.cadenceDays,
          averageAmount: stream.averageAmount,
          lastAmount: stream.lastAmount,
          monthlyAmount: monthlyFromCadence(stream.averageAmount, stream.cadenceDays),
          amountVariance: stream.amountVariance,
          amountClass: stream.amountClass,
          planningAmount: stream.planningAmount,
          amountRange: amountRangeOf(stream.amounts),
          anchorDayOfMonth: stream.anchorDayOfMonth,
          dateJitterDays: stream.dateJitterDays,
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
    account_id: string | null;
    iso_currency_code: string | null;
    economic_role: FactsTransaction['role'];
    display_bucket: string | null;
    account_type: string | null;
    linked: boolean;
  }>(
    `SELECT t.id AS row_id, t.amount::text AS amount, t.date::text AS date,
            t.pending, t.account_id, t.iso_currency_code,
            c.economic_role, c.display_bucket,
            a.type AS account_type,
            (l_out.id IS NOT NULL OR l_in.id IS NOT NULL) AS linked
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
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
    iso_currency_code: string | null;
  }>(
    `SELECT a.account_id, a.name, a.type,
            a.current_balance::text AS current_balance,
            a.available_balance::text AS available_balance,
            a.iso_currency_code
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
    dominant_role: string | null;
    last_amount: string;
    anchor_day_of_month: number | null;
    date_jitter_days: number | null;
    amount_class: AmountClass | null;
    planning_amount: string | null;
    evidence: unknown;
    dominant_bucket: string | null;
    merchant_key: string;
  }>(
    `SELECT stream_key, direction, display_name, cadence,
            cadence_days::text AS cadence_days,
            average_amount::text AS average_amount,
            amount_variance::text AS amount_variance,
            confidence, last_date::text AS last_date, user_status,
            dominant_role,
            last_amount::text AS last_amount,
            anchor_day_of_month, date_jitter_days, amount_class,
            planning_amount::text AS planning_amount,
            evidence, dominant_bucket, merchant_key
     FROM recurring_streams
     WHERE user_id = $1`,
    [userId],
  );

  const { rows: profileRows } = await db.query<{ declared_obligations: unknown }>(
    `SELECT declared_obligations FROM user_info WHERE user_id = $1::uuid`,
    [userId],
  );

  return {
    declaredObligations: parseObligations(profileRows[0]?.declared_obligations),
    transactions: txnRows.map((row) => ({
      rowId: row.row_id,
      amount: Number(row.amount),
      date: row.date,
      pending: row.pending,
      accountId: row.account_id,
      isoCurrencyCode: row.iso_currency_code,
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
      isoCurrencyCode: row.iso_currency_code,
    })),
    streams: streamRows.map((row) => ({
      streamKey: row.stream_key,
      direction: row.direction,
      displayName: row.display_name,
      cadence: row.cadence,
      cadenceDays: Number(row.cadence_days),
      averageAmount: Number(row.average_amount),
      lastAmount: Number(row.last_amount),
      amountVariance: Number(row.amount_variance),
      confidence: row.confidence,
      lastDate: row.last_date,
      userStatus: row.user_status,
      dominantRole: row.dominant_role,
      anchorDayOfMonth: row.anchor_day_of_month,
      dateJitterDays: row.date_jitter_days,
      amountClass: row.amount_class,
      planningAmount: row.planning_amount === null ? null : Number(row.planning_amount),
      amounts: parseEvidenceAmounts(row.evidence),
      dominantBucket: row.dominant_bucket,
      merchantKey: row.merchant_key,
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
