/**
 * Deterministic financial facts (API-011).
 *
 * The versioned JSON stored in financial_fact_snapshots.facts. Exact
 * arithmetic over stored, economically classified records — no live Plaid
 * call, no model, no clock other than the injected build time. Coverage
 * (how complete the records are) is a separate concept stored alongside.
 */

export const FACTS_RULE_VERSION = 'facts-v3';

export type CategoryTotal = {
  bucket: string;
  /** Gross observed spend in this bucket over the window, positive. */
  total: number;
  monthlyAverage: number;
  /** Share of gross economic spend, 0–1. */
  share: number;
  transactionCount: number;
};

export type IncomeStreamFact = {
  streamKey: string;
  displayName: string;
  cadence: string;
  monthlyAmount: number;
  confidence: 'high' | 'medium' | 'low';
};

export type RecurringOutflowFact = {
  streamKey: string;
  displayName: string;
  cadence: string;
  averageAmount: number;
  monthlyAmount: number;
  amountVariance: number;
  confidence: 'high' | 'medium' | 'low';
  lastDate: string;
};

export type FinancialFacts = {
  ruleVersion: string;
  period: {
    oldestObservedDate: string | null;
    throughDate: string;
    observedDays: number;
    /**
     * Flow totals and monthly figures (spend, observed income, obligations)
     * are computed over at most this many trailing days, so "what you
     * spend now" tracks the recent past even when two years of history
     * were pulled for long-cadence bill detection. Recurring streams use
     * the full history. Effective value: min(observedDays, 182).
     */
    spendWindowDays: number;
    /** First date inside the spend window; null with no history. */
    spendWindowStart: string | null;
    /** Months the monthly figures were normalized over (spendWindowDays / 30.44, floored at ~1). */
    normalizationMonths: number;
  };
  /**
   * Facts are computed in one currency; transactions and accounts in any
   * other currency are excluded and reported here, never silently summed
   * as if units agreed.
   */
  currency: {
    primary: string | null;
    excludedTransactionCount: number;
    excludedCurrencies: string[];
  };
  income: {
    /** Best monthly estimate: recurring streams when available, else observed. */
    monthlyIncomeEstimate: number;
    estimateSource: 'recurring_streams' | 'observed_average' | 'none';
    totalObservedIncome: number;
    incomeStreams: IncomeStreamFact[];
  };
  spend: {
    averageMonthlyEconomicSpend: number;
    grossEconomicSpend: number;
    refundsAndCredits: number;
    netEconomicSpend: number;
    categoryTotals: CategoryTotal[];
  };
  cashObligations: {
    /** The sum of every component below, declared obligations included. */
    averageMonthlyCashObligations: number;
    components: {
      netEconomicSpendMonthly: number;
      debtPaymentsMonthly: number;
      externalCardPaymentsMonthly: number;
      /**
       * Off-book bills the user declared in onboarding (rent to a person, a
       * family loan, child support…), normalized to a month: monthly as is,
       * weekly × 52/12. One-time amounts never enter this figure.
       */
      declaredObligationsMonthly: number;
    };
    /** Declared one-time amounts, surfaced whole rather than normalized. */
    declaredOneTime: { total: number; count: number };
  };
  balances: {
    totalAssets: number;
    totalLiabilities: number;
    netPosition: number;
    availableToSpend: number;
    accountCount: number;
  };
  recurring: {
    outflows: RecurringOutflowFact[];
  };
  movement: {
    internalTransferTotal: number;
    linkedCardPaymentTotal: number;
    savingsTransferTotal: number;
    /** Card-payment-shaped checking outflows with no linked card side. */
    externalCardPaymentTotal: number;
  };
  unknowns: {
    unknownOutflowTotal: number;
    unknownInflowTotal: number;
    /** Share of total outflow value that stayed unknown, 0–1. */
    unknownShareOfOutflow: number;
  };
};

/** One classified, link-aware transaction as the facts engine consumes it. */
export type FactsTransaction = {
  rowId: string;
  /** Plaid sign: positive = money out. */
  amount: number;
  date: string;
  pending: boolean;
  /** Account this posted to; drives the per-account normalization window. */
  accountId: string | null;
  isoCurrencyCode: string | null;
  role:
    | 'expense'
    | 'earned_income'
    | 'refund_or_credit'
    | 'internal_transfer'
    | 'credit_card_payment'
    | 'debt_principal_payment'
    | 'interest_or_fee'
    | 'savings_or_investment_transfer'
    | 'unknown_outflow'
    | 'unknown_inflow';
  displayBucket: string | null;
  accountType: string | null;
  /** Whether this posting is one side of a persisted transaction link. */
  linked: boolean;
};

export type FactsRecurringStream = {
  streamKey: string;
  direction: 'inflow' | 'outflow';
  displayName: string;
  cadence: string;
  cadenceDays: number;
  averageAmount: number;
  amountVariance: number;
  confidence: 'high' | 'medium' | 'low';
  lastDate: string;
  userStatus: 'detected' | 'confirmed' | 'dismissed';
  /**
   * Dominant economic role of the stream's members. Only 'earned_income'
   * inflow streams may feed the income estimate; null (pre-migration rows)
   * reads as not-income.
   */
  dominantRole?: string | null;
};

/** One Plaid account balance as the facts engine consumes it. */
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
