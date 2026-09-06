/**
 * Economic classification domain types (API-008).
 *
 * The central distinction of the whole analysis: economic activity (money
 * actually earned or spent) versus account movement (the same dollars
 * changing pockets). Getting this wrong double-counts card payments or
 * invents phantom income, so every role decision carries its source, rule
 * id, confidence, and a human-readable explanation.
 */

export const ECONOMIC_ROLES = [
  'expense',
  'earned_income',
  'refund_or_credit',
  'internal_transfer',
  'credit_card_payment',
  'debt_principal_payment',
  'interest_or_fee',
  'savings_or_investment_transfer',
  'unknown_outflow',
  'unknown_inflow',
] as const;

export type EconomicRole = (typeof ECONOMIC_ROLES)[number];

export type ClassificationSource =
  | 'pfc'
  | 'account_semantics'
  | 'deterministic_rule'
  | 'reconciliation'
  | 'user_override'
  | 'fallback';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type ClassificationResult = {
  role: EconomicRole;
  /** Human display category for economic spend; null for non-expenses. */
  displayBucket: string | null;
  source: ClassificationSource;
  ruleId: string;
  confidence: ConfidenceBand;
  explanation: string;
};

/** The classifier's input: normalized transaction plus account context. */
export type ClassifiableTransaction = {
  rowId: string;
  /** Plaid sign convention: positive = money out. */
  amount: number;
  accountType: string | null;
  accountSubtype: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  pfcConfidence: string | null;
  merchantNormalized: string | null;
  name: string | null;
  transactionCode: string | null;
};

export type ClassificationOverride = {
  scope: 'transaction' | 'merchant';
  transactionRowId: string | null;
  merchantNormalized: string | null;
  role: EconomicRole;
  displayBucket: string | null;
};

/** Bump when rule behavior changes so snapshots can be rebuilt comparably. */
export const CLASSIFICATION_RULE_VERSION = 'class-v2';
