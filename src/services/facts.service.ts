/**
 * The computed-facts layer.
 *
 * Pure functions over transaction and balance records. No database access, no
 * network, no model. Everything here is deterministic and unit-testable, which
 * is the point: these are the only numbers the assistant is permitted to state.
 *
 * See `src/types/facts.ts` for the sign convention — it is the single easiest
 * thing to get backwards in this file.
 */

import type {
  AccountBalance,
  BalanceSummary,
  BudgetLimit,
  BudgetStatus,
  CategoryDelta,
  CategoryTotal,
  DateRange,
  PeriodComparison,
  RecurringCharge,
  RecurringOptions,
  SpendSummary,
  SummaryOptions,
  Transaction,
} from '../types/facts.js';

const UNCATEGORIZED = 'Uncategorized';
const MS_PER_DAY = 86_400_000;

/** Account types whose balance is money owed rather than money held. */
const LIABILITY_TYPES = new Set(['credit', 'loan']);

/**
 * Rounds to whole cents. Money is summed as floating point here, so totals
 * accumulate representation error (the classic 0.1 + 0.2 problem); every value
 * that leaves this module is rounded so the assistant never reports something
 * like 42.300000000000004. `+ 0` normalises negative zero.
 */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function parseIsoDate(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new TypeError(`Expected an ISO date of the form YYYY-MM-DD, got "${iso}"`);
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return toIsoDate(parseIsoDate(iso) + days * MS_PER_DAY);
}

/** Inclusive day count: a range whose start and end are equal spans one day. */
function daysInRange(range: DateRange): number {
  return Math.round((parseIsoDate(range.end) - parseIsoDate(range.start)) / MS_PER_DAY) + 1;
}

function isWithin(date: string, range: DateRange): boolean {
  const value = parseIsoDate(date);
  return value >= parseIsoDate(range.start) && value <= parseIsoDate(range.end);
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return roundCents((current - previous) / previous);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function selectTransactions(
  transactions: readonly Transaction[],
  range: DateRange,
  includePending: boolean,
): Transaction[] {
  return transactions.filter(
    (transaction) =>
      (includePending || !transaction.pending) && isWithin(transaction.date, range),
  );
}

/**
 * Totals spend, income, and per-category breakdown for a period.
 *
 * Spend and income are both returned as positive numbers regardless of Plaid's
 * signing, because "you spent -420" reads as a bug to a user.
 */
export function summarizeSpend(
  transactions: readonly Transaction[],
  range: DateRange,
  options: SummaryOptions = {},
): SpendSummary {
  const selected = selectTransactions(transactions, range, options.includePending ?? false);

  let totalSpend = 0;
  let totalIncome = 0;
  const totals = new Map<string, { total: number; count: number }>();

  for (const transaction of selected) {
    if (transaction.amount > 0) {
      totalSpend += transaction.amount;
      const key = transaction.category ?? UNCATEGORIZED;
      const entry = totals.get(key) ?? { total: 0, count: 0 };
      entry.total += transaction.amount;
      entry.count += 1;
      totals.set(key, entry);
    } else if (transaction.amount < 0) {
      totalIncome += -transaction.amount;
    }
    // Exactly zero contributes to neither, but still counts as a transaction.
  }

  const byCategory: CategoryTotal[] = [...totals.entries()]
    .map(([category, entry]) => ({
      category,
      total: roundCents(entry.total),
      transactionCount: entry.count,
      shareOfSpend: totalSpend === 0 ? 0 : roundCents(entry.total / totalSpend),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    range,
    totalSpend: roundCents(totalSpend),
    totalIncome: roundCents(totalIncome),
    net: roundCents(totalIncome - totalSpend),
    transactionCount: selected.length,
    byCategory,
  };
}

/**
 * The equally sized window immediately before `range`. A calendar month is
 * compared against the same number of days before it, not against the previous
 * calendar month — so a 31-day period is always compared with 31 days.
 */
export function previousPeriod(range: DateRange): DateRange {
  const length = daysInRange(range);
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

/**
 * Compares a period against the one immediately preceding it, overall and by
 * category. Categories present in only one of the two periods still appear,
 * with zero on the missing side — a category the user stopped spending in
 * entirely is exactly the kind of change worth surfacing.
 */
export function comparePeriods(
  transactions: readonly Transaction[],
  range: DateRange,
  options: SummaryOptions = {},
): PeriodComparison {
  const current = summarizeSpend(transactions, range, options);
  const previous = summarizeSpend(transactions, previousPeriod(range), options);

  const currentByCategory = new Map(current.byCategory.map((c) => [c.category, c.total]));
  const previousByCategory = new Map(previous.byCategory.map((c) => [c.category, c.total]));

  const byCategory: CategoryDelta[] = [
    ...new Set([...currentByCategory.keys(), ...previousByCategory.keys()]),
  ]
    .map((category) => {
      const currentTotal = currentByCategory.get(category) ?? 0;
      const previousTotal = previousByCategory.get(category) ?? 0;
      return {
        category,
        current: currentTotal,
        previous: previousTotal,
        delta: roundCents(currentTotal - previousTotal),
        percentChange: percentChange(currentTotal, previousTotal),
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    current,
    previous,
    spendDelta: roundCents(current.totalSpend - previous.totalSpend),
    spendPercentChange: percentChange(current.totalSpend, previous.totalSpend),
    byCategory,
  };
}

/**
 * Finds merchants charging on a regular cadence — subscriptions, memberships,
 * bills.
 *
 * A merchant qualifies when it has at least `minOccurrences` outgoing charges
 * and every gap between them sits within `toleranceDays` of the median gap.
 * Testing every gap rather than the average matters: three charges on
 * consecutive days followed by one a year later has a plausible mean gap and is
 * obviously not a subscription.
 */
export function detectRecurring(
  transactions: readonly Transaction[],
  options: RecurringOptions = {},
): RecurringCharge[] {
  const { minOccurrences = 3, toleranceDays = 5, includePending = false } = options;

  const byMerchant = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    if (!includePending && transaction.pending) continue;
    if (transaction.amount <= 0) continue;
    if (!transaction.merchantName) continue;
    const key = transaction.merchantName.trim().toLowerCase();
    const bucket = byMerchant.get(key);
    if (bucket) bucket.push(transaction);
    else byMerchant.set(key, [transaction]);
  }

  const recurring: RecurringCharge[] = [];

  for (const group of byMerchant.values()) {
    if (group.length < minOccurrences) continue;

    const sorted = [...group].sort((a, b) => parseIsoDate(a.date) - parseIsoDate(b.date));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      gaps.push((parseIsoDate(sorted[i]!.date) - parseIsoDate(sorted[i - 1]!.date)) / MS_PER_DAY);
    }

    const cadence = median(gaps);
    if (cadence <= 0) continue;
    if (gaps.some((gap) => Math.abs(gap - cadence) > toleranceDays)) continue;

    const total = sorted.reduce((sum, transaction) => sum + transaction.amount, 0);

    recurring.push({
      // The original casing, not the lowercased grouping key.
      merchantName: sorted[0]!.merchantName!,
      averageAmount: roundCents(total / sorted.length),
      occurrences: sorted.length,
      cadenceDays: Math.round(cadence),
      firstDate: sorted[0]!.date,
      lastDate: sorted[sorted.length - 1]!.date,
    });
  }

  return recurring.sort((a, b) => b.averageAmount - a.averageAmount);
}

/**
 * Spend against per-category limits, with a pace projection.
 *
 * `asOf` is required rather than read from the clock so the result is
 * deterministic and testable. Projection extrapolates from the fraction of the
 * period elapsed, and is null before the period starts. When `asOf` is past the
 * end of the period the projection is simply actual spend, since there is no
 * remaining time to extrapolate into.
 */
export function budgetStatus(
  transactions: readonly Transaction[],
  range: DateRange,
  limits: readonly BudgetLimit[],
  asOf: string,
  options: SummaryOptions = {},
): BudgetStatus[] {
  const summary = summarizeSpend(transactions, range, options);
  const spentByCategory = new Map(summary.byCategory.map((c) => [c.category, c.total]));

  const totalDays = daysInRange(range);
  const elapsedDays = Math.min(
    totalDays,
    Math.round((parseIsoDate(asOf) - parseIsoDate(range.start)) / MS_PER_DAY) + 1,
  );
  const elapsedFraction = elapsedDays <= 0 ? 0 : elapsedDays / totalDays;

  return limits.map(({ category, limit }) => {
    const spent = spentByCategory.get(category) ?? 0;
    const projectedSpend =
      elapsedFraction === 0 ? null : roundCents(spent / elapsedFraction);

    return {
      category,
      limit: roundCents(limit),
      spent,
      remaining: roundCents(limit - spent),
      percentUsed: limit === 0 ? 0 : roundCents(spent / limit),
      projectedSpend,
      projectedOverage:
        projectedSpend === null ? null : roundCents(Math.max(0, projectedSpend - limit)),
    };
  });
}

/**
 * Rolls up account balances into assets, liabilities, and what is actually
 * spendable right now.
 *
 * Credit and loan balances are reported by Plaid as positive numbers
 * representing debt, so they are summed into liabilities rather than assets —
 * treating a credit card balance as money you have is the single most dangerous
 * mistake this function could make.
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
