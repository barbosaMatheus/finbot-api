/**
 * Types for the computed-facts layer.
 *
 * Every number the assistant is ever allowed to state about a user's money is
 * produced here, in TypeScript, from real records. The model receives these as
 * stated facts and explains them — it never derives a figure itself.
 *
 * That split is deliberate. Language models are least reliable exactly where
 * this product is most sensitive: arithmetic over retrieved records. A finance
 * assistant that is confidently wrong about a balance is worse than one that is
 * vague, because the user acts on it.
 */

/**
 * A single transaction, normalised from Plaid.
 *
 * IMPORTANT — sign convention. This follows Plaid: `amount` is **positive when
 * money leaves the account** (a purchase) and **negative when money arrives**
 * (a deposit, refund, or transfer in). This is the opposite of what most people
 * assume, and getting it backwards silently inverts every total in the app, so
 * it is asserted in the tests.
 */
export type Transaction = {
  transactionId: string;
  accountId: string;
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Positive = money out. Negative = money in. */
  amount: number;
  category: string | null;
  merchantName: string | null;
  pending: boolean;
  isoCurrencyCode: string | null;
};

/** An inclusive calendar date range, both ends `YYYY-MM-DD`. */
export type DateRange = {
  start: string;
  end: string;
};

export type CategoryTotal = {
  category: string;
  total: number;
  transactionCount: number;
  /** Share of total spend in the period, 0–1. */
  shareOfSpend: number;
};

export type SpendSummary = {
  range: DateRange;
  /** Money out, as a positive number. */
  totalSpend: number;
  /** Money in, as a positive number. */
  totalIncome: number;
  /** income − spend. Negative means the user spent more than they earned. */
  net: number;
  transactionCount: number;
  /** Descending by total. */
  byCategory: CategoryTotal[];
};

export type CategoryDelta = {
  category: string;
  current: number;
  previous: number;
  /** current − previous. Positive means spending went up. */
  delta: number;
  /** null when the previous period was zero, since the change is undefined. */
  percentChange: number | null;
};

export type PeriodComparison = {
  current: SpendSummary;
  previous: SpendSummary;
  spendDelta: number;
  spendPercentChange: number | null;
  byCategory: CategoryDelta[];
};

export type RecurringCharge = {
  merchantName: string;
  /** Mean charge amount, positive. */
  averageAmount: number;
  occurrences: number;
  /** Median gap between charges, in days. */
  cadenceDays: number;
  firstDate: string;
  lastDate: string;
};

export type BudgetLimit = {
  category: string;
  /** Spend ceiling for the period, positive. */
  limit: number;
};

export type BudgetStatus = {
  category: string;
  limit: number;
  spent: number;
  /** limit − spent. Negative means already over. */
  remaining: number;
  /** 0–1+, where values above 1 mean over budget. */
  percentUsed: number;
  /**
   * Spend extrapolated to the end of the period at the current pace. Null when
   * the period has not started yet, since there is nothing to extrapolate from.
   */
  projectedSpend: number | null;
  /** projectedSpend − limit, floored at 0. Null when projection is null. */
  projectedOverage: number | null;
};

export type AccountBalance = {
  accountId: string;
  name: string;
  /** Plaid account type: `depository`, `credit`, `loan`, `investment`, … */
  type: string;
  currentBalance: number | null;
  availableBalance: number | null;
  /** Optional so legacy callers compile; the facts engine filters on it. */
  isoCurrencyCode?: string | null;
};

export type BalanceSummary = {
  /** Sum of asset accounts. */
  totalAssets: number;
  /** Sum of liability balances, as a positive number. */
  totalLiabilities: number;
  /** assets − liabilities. */
  netPosition: number;
  /** Spendable right now: available balance across depository accounts. */
  availableToSpend: number;
  accountCount: number;
};

export type SummaryOptions = {
  /**
   * Pending transactions are excluded by default. They can change amount or
   * disappear entirely, so including them makes totals unstable between runs.
   */
  includePending?: boolean;
};

export type RecurringOptions = {
  /** Minimum charges from one merchant before it counts as recurring. */
  minOccurrences?: number;
  /** How much each gap may deviate from the median, in days. */
  toleranceDays?: number;
  includePending?: boolean;
};
