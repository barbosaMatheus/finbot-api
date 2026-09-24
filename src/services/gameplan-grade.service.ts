/**
 * GRADE_PERIOD: what actually happened in a period, read from the ledger
 * (§7 "measured by"), graded by the engine against the targets the user
 * was shown, narrated by the port, stored. A final grade closes the period,
 * advances the accruals (§10.7), and opens the next period.
 */

import { addDays, dayNumber, minIso } from '../lib/dates.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { pool } from '../db.js';
import { gradePeriod } from '../gameplan/grading.js';
import type { PeriodActuals, PostedBill, TargetDefinition } from '../gameplan/types.js';
import type { LlmProvider } from '../llm/types.js';
import { llmProviderFromEnv } from '../llm/provider.js';
import type { EconomicRole } from '../types/classification.js';
import type { FactsRecurringStream } from '../types/financial-facts.js';
import { loadFactsData, summarizeBalances, type FactsData } from './financial-facts.service.js';
import { rolloverPeriod, type PeriodDeps } from './gameplan-period.service.js';
import {
  closePeriod,
  getPeriod,
  insertGrade,
  listTargets,
  markMidPeriodGraded,
  setAccruals,
  type GameplanPeriod,
} from './gameplan-store.service.js';

/** Roles a bill posting can carry (the same set recurrence groups outflows from). */
const BILL_ROLES: ReadonlySet<EconomicRole> = new Set([
  'expense',
  'interest_or_fee',
  'debt_principal_payment',
  'unknown_outflow',
]);
const DEBT_ROLES: ReadonlySet<EconomicRole> = new Set(['credit_card_payment', 'debt_principal_payment']);
/** A fee posted this soon after a bill counts against it. */
const FEE_WINDOW_DAYS = 3;
/** Postings this far before the period may still belong to a carry-over window. */
const LOOKBACK_DAYS = 14;

/** One settled ledger row as the grade reads it. */
export type GradeTransaction = {
  rowId: string;
  /** Plaid sign: positive = money out. */
  amount: number;
  date: string;
  pending: boolean;
  role: EconomicRole;
  displayBucket: string | null;
  merchantKey: string | null;
  merchantName: string | null;
  accountId: string | null;
  accountType: string | null;
};

export async function listGradeTransactions(
  userId: string,
  since: string,
  db: Queryable = pool,
): Promise<GradeTransaction[]> {
  const { rows } = await db.query<{
    row_id: string;
    amount: string;
    date: string;
    pending: boolean;
    economic_role: EconomicRole;
    display_bucket: string | null;
    merchant_normalized: string | null;
    merchant_name: string | null;
    name: string | null;
    account_id: string | null;
    account_type: string | null;
  }>(
    `SELECT t.id AS row_id, t.amount::text AS amount, t.date::text AS date, t.pending,
            c.economic_role, c.display_bucket, t.merchant_normalized, t.merchant_name, t.name,
            t.account_id, a.type AS account_type
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
     LEFT JOIN plaid_accounts a ON a.account_id = t.account_id
     WHERE t.user_id = $1 AND t.is_removed = FALSE AND t.date >= $2::date
     ORDER BY t.date ASC`,
    [userId, since],
  );

  return rows.map((row) => ({
    rowId: row.row_id,
    amount: Number(row.amount),
    date: row.date,
    pending: row.pending,
    role: row.economic_role,
    displayBucket: row.display_bucket,
    merchantKey: row.merchant_normalized,
    merchantName: row.merchant_name ?? row.name,
    accountId: row.account_id,
    accountType: row.account_type,
  }));
}

export type ActualsInput = {
  period: { start: string; end: string };
  /** Grade through this date (inclusive): the period end, today, or the day before the next payday. */
  through: string;
  targets: readonly TargetDefinition[];
  transactions: readonly GradeTransaction[];
  streams: ReadonlyArray<Pick<FactsRecurringStream, 'streamKey' | 'merchantKey'>>;
  balanceAtClose: number | null;
  awarenessCompleted: boolean;
};

function inRange(date: string, start: string, end: string): boolean {
  return dayNumber(date) >= dayNumber(start) && dayNumber(date) <= dayNumber(end);
}

/**
 * The period's actuals from settled postings (§1 "measured by"). Pure, so
 * a grade can be replayed from a stored ledger slice.
 */
export function buildActuals(input: ActualsInput): PeriodActuals {
  const merchantOf = new Map<string, string | null>();
  for (const stream of input.streams) merchantOf.set(stream.streamKey, stream.merchantKey ?? null);

  // Bill streams a cap left out of its base: their postings leave the
  // bucket's spend too.
  const excludedMerchantsByBucket = new Map<string, Set<string>>();
  for (const target of input.targets) {
    if (target.type !== 'spend_cap') continue;
    const merchants = new Set<string>();
    for (const key of target.excludedBillStreams) {
      const merchant = merchantOf.get(key);
      if (merchant) merchants.add(merchant);
    }
    excludedMerchantsByBucket.set(target.bucket, merchants);
  }

  const settled = input.transactions.filter(
    (txn) => !txn.pending && inRange(txn.date, input.period.start, input.through),
  );

  const spendByBucket: Record<string, number> = {};
  const countByBucket: Record<string, number> = {};
  let largestSavingsTransfer = 0;
  let largestDebtPayment = 0;

  for (const txn of settled) {
    if (txn.amount <= 0) continue;

    if (txn.role === 'expense' && txn.displayBucket) {
      const excluded = excludedMerchantsByBucket.get(txn.displayBucket);
      if (excluded && txn.merchantKey && excluded.has(txn.merchantKey)) continue;
      spendByBucket[txn.displayBucket] = round2((spendByBucket[txn.displayBucket] ?? 0) + txn.amount);
      countByBucket[txn.displayBucket] = (countByBucket[txn.displayBucket] ?? 0) + 1;
    }

    if (txn.role === 'savings_or_investment_transfer') {
      largestSavingsTransfer = Math.max(largestSavingsTransfer, txn.amount);
    }
    if (DEBT_ROLES.has(txn.role)) {
      largestDebtPayment = Math.max(largestDebtPayment, txn.amount);
    }
  }

  const postedBills: PostedBill[] = [];
  const fees = input.transactions.filter((txn) => !txn.pending && txn.role === 'interest_or_fee');

  for (const target of input.targets) {
    if (target.type !== 'bill_readiness') continue;

    for (const bill of target.bills) {
      if (bill.source !== 'stream') continue;
      const merchant = merchantOf.get(bill.key);
      if (!merchant) continue;

      // A carry-over may post before the period opened; anything from its
      // window start counts.
      const from = bill.windowStart ? minIso(bill.windowStart, input.period.start) : input.period.start;

      for (const txn of input.transactions) {
        if (txn.pending || txn.amount <= 0 || txn.merchantKey !== merchant) continue;
        if (!BILL_ROLES.has(txn.role)) continue;
        if (!inRange(txn.date, from, input.through)) continue;
        if (postedBills.some((posted) => posted.key === bill.key && posted.date === txn.date)) continue;

        const feeOrOverdraft = fees.some(
          (fee) =>
            fee.accountId === txn.accountId &&
            inRange(fee.date, txn.date, addDays(txn.date, FEE_WINDOW_DAYS)),
        );
        postedBills.push({ key: bill.key, amount: txn.amount, date: txn.date, feeOrOverdraft });
      }
    }
  }

  return {
    spendByBucket,
    countByBucket,
    postedBills,
    largestSavingsTransfer,
    largestDebtPayment,
    balanceAtClose: input.balanceAtClose,
    awarenessCompleted: input.awarenessCompleted,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

export type GradeDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  listTransactions(userId: string, since: string): Promise<GradeTransaction[]>;
  provider: LlmProvider;
  now(): Date;
  /** Opens the next period after a final grade; the period service's deps. */
  periodDeps: Partial<PeriodDeps>;
};

async function defaultDeps(): Promise<GradeDeps> {
  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    listTransactions: (userId, since) => listGradeTransactions(userId, since),
    provider: llmProviderFromEnv(),
    now: () => new Date(),
    periodDeps: {},
  };
}

export type GradePayload = {
  userId: string;
  periodId: string;
  kind: 'mid_period' | 'final';
  reason: 'payday' | 'schedule' | 'fallback';
  paydayDate?: string;
  paydayAmount?: number;
};

export type GradeResult = {
  status: 'graded' | 'skipped';
  periodId: string;
  nextPeriodId: string | null;
};

/** The last day a grade covers: the period end, today, or the day before a detected payday. */
export function gradeThrough(period: Pick<GameplanPeriod, 'start' | 'end'>, payload: GradePayload, today: string): string {
  let through = minIso(period.end, today);
  if (payload.reason === 'payday' && payload.paydayDate) {
    through = minIso(through, addDays(payload.paydayDate, -1));
  }
  return dayNumber(through) < dayNumber(period.start) ? period.start : through;
}

export async function gradeGameplanPeriod(
  payload: GradePayload,
  depsOverride?: Partial<GradeDeps>,
): Promise<GradeResult> {
  const deps: GradeDeps = { ...(await defaultDeps()), ...depsOverride };
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);

  const period = await getPeriod(payload.periodId, deps.db);
  if (!period || period.userId !== payload.userId || period.status === 'closed') {
    logger.info('period grade skipped', { periodId: payload.periodId, status: period?.status ?? 'missing' });
    return { status: 'skipped', periodId: payload.periodId, nextPeriodId: null };
  }

  const targets = (await listTargets(period.id, deps.db))
    .filter((target) => target.role === 'plan')
    .map((target) => target.definition);

  const through = gradeThrough(period, payload, today);
  const [data, transactions] = await Promise.all([
    deps.loadData(period.userId),
    deps.listTransactions(period.userId, addDays(period.start, -LOOKBACK_DAYS)),
  ]);

  if (targets.length > 0) {
    const actuals = buildActuals({
      period,
      through,
      targets,
      transactions,
      streams: data.streams,
      balanceAtClose: data.accounts.length > 0 ? summarizeBalances(data.accounts).availableToSpend : null,
      awarenessCompleted: period.awarenessCompletedAt !== null,
    });

    const grade = gradePeriod(targets, actuals);
    const narration = await deps.provider.explain({
      kind: 'grade',
      grade,
      period: { start: period.start, end: period.end, trigger: period.trigger },
    });

    await insertGrade(
      {
        periodId: period.id,
        userId: period.userId,
        kind: payload.kind,
        grade,
        actuals,
        lines: narration.output.lines,
        improvements: narration.output.improvements,
        narration: { source: narration.source, fallbackReason: narration.fallbackReason, model: narration.model },
        gradedThrough: through,
      },
      deps.db,
    );

    logger.info('period graded', {
      userId: period.userId,
      periodId: period.id,
      kind: payload.kind,
      through,
      outcomes: grade.results.map((result) => `${result.target.type}:${result.outcome}`),
      narrationSource: narration.source,
    });

    if (payload.kind === 'final') {
      await advanceAccruals(period, targets, actuals, deps.db);
    }
  } else {
    logger.warn('period graded without targets; the plan was never built', {
      userId: period.userId,
      periodId: period.id,
      kind: payload.kind,
    });
  }

  if (payload.kind === 'mid_period') {
    await markMidPeriodGraded(period.id, now, deps.db);
    return { status: 'graded', periodId: period.id, nextPeriodId: null };
  }

  const closed = await closePeriod(period.id, now, payload.reason, deps.db);
  if (!closed) {
    return { status: 'skipped', periodId: period.id, nextPeriodId: null };
  }

  const next = await rolloverPeriod(
    {
      closed: { ...period, status: 'closed', closedAt: now.toISOString(), closeReason: payload.reason },
      reason: payload.reason,
      ...(payload.paydayDate ? { paydayDate: payload.paydayDate } : {}),
      ...(payload.paydayAmount !== undefined ? { paydayAmount: payload.paydayAmount } : {}),
    },
    { db: deps.db, now: deps.now, ...deps.periodDeps },
  );

  return { status: 'graded', periodId: period.id, nextPeriodId: next.id };
}

/**
 * Long-cadence accruals (§10.7): a bill that landed resets to zero; one
 * still being saved for advances to this period's running total.
 */
async function advanceAccruals(
  period: GameplanPeriod,
  targets: readonly TargetDefinition[],
  actuals: PeriodActuals,
  db: Queryable,
): Promise<void> {
  const updates: Record<string, number> = {};

  for (const target of targets) {
    if (target.type !== 'bill_readiness') continue;
    for (const bill of target.bills) {
      if (!bill.accrual) continue;
      const posted = actuals.postedBills.some((entry) => entry.key === bill.key);
      updates[bill.key] = posted ? 0 : bill.accrual.accruedAfter;
    }
  }

  if (Object.keys(updates).length > 0) {
    await setAccruals(period.userId, updates, db);
  }
}
