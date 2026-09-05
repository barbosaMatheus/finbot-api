/**
 * Deterministic economic-role classification (API-008).
 *
 * Ordered signals per the design: user override → account semantics guards →
 * PFCv2 intent → deterministic description rules → explicit fallback. Rules
 * are pure and versioned; reconciliation (API-009) may later refine
 * transfer-shaped roles using cross-account evidence.
 *
 * Hard invariants, tested:
 *  - money arriving on a credit account is never earned income;
 *  - transfer- or payment-shaped activity is never income or spend;
 *  - anything unresolved stays an explicit unknown, never a guess.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import type {
  ClassifiableTransaction,
  ClassificationOverride,
  ClassificationResult,
  ConfidenceBand,
} from '../types/classification.js';
import { CLASSIFICATION_RULE_VERSION } from '../types/classification.js';

/** PFC primary → user-facing display bucket for economic spend. */
const DISPLAY_BUCKETS: Record<string, string> = {
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  RENT_AND_UTILITIES: 'Housing & Utilities',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  ENTERTAINMENT: 'Entertainment',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  HOME_IMPROVEMENT: 'Home',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Nonprofit',
  BANK_FEES: 'Fees & Interest',
};

const UNCATEGORIZED = 'Uncategorized';

/**
 * Two PFC primaries are split by their detailed category because the plan
 * treats the halves differently: groceries and fuel are essentials the
 * gameplan never caps, eating out and other transport are discretionary
 * (gameplan note §2). Everything else keeps its primary's bucket.
 */
function displayBucketFor(primary: string, detailed: string): string | undefined {
  if (primary === 'FOOD_AND_DRINK') {
    return detailed === 'FOOD_AND_DRINK_GROCERIES' ? 'Groceries' : 'Eating Out';
  }

  if (primary === 'TRANSPORTATION') {
    return detailed === 'TRANSPORTATION_GAS' ? 'Fuel' : 'Transportation';
  }

  return DISPLAY_BUCKETS[primary];
}

function pfcConfidenceBand(confidence: string | null): ConfidenceBand {
  switch (confidence) {
    case 'VERY_HIGH':
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    default:
      return 'low';
  }
}

function isCredit(txn: ClassifiableTransaction): boolean {
  return txn.accountType === 'credit';
}

function isDepository(txn: ClassifiableTransaction): boolean {
  return txn.accountType === 'depository';
}

function text(txn: ClassifiableTransaction): string {
  return `${txn.merchantNormalized ?? ''} ${txn.name ?? ''}`.toLowerCase();
}

const CARD_PAYMENT_PATTERN =
  /\b(autopay|card\s*payment|crd\s*pmt|e-?payment|epay|pymt|online\s+payment|payment\s*[-–]?\s*thank\s*you|cardmember\s+pay)\b/;

/**
 * Extra descriptors seen on the CARD side of a payment credit — statement
 * wording only credit-card statements use ("PAYMENT RECEIVED", "DIRECTPAY").
 * Deliberately NOT merged into CARD_PAYMENT_PATTERN: that pattern also
 * classifies depository outflows, where "direct pay" wording is ordinary
 * billpay and must stay classifiable as spend.
 */
const CARD_CREDIT_PAYMENT_PATTERN =
  /\b(payment\s+received|direct\s*pay|ach\s+pmt)\b/;

const PAYROLL_PATTERN =
  /\b(payroll|direct\s*dep(osit)?|dir\s*dep|des:\s*payroll|salary|paycheck)\b/;

const INTEREST_FEE_PATTERN =
  /\b(interest\s+charge|finance\s+charge|late\s+fee|annual\s+fee|overdraft|service\s+fee|monthly\s+fee|atm\s+fee)\b/;

/**
 * Classify one transaction from stored evidence alone. Pure and total: every
 * input produces a result, if only an explicit unknown.
 */
export function classifyTransaction(
  txn: ClassifiableTransaction,
): ClassificationResult {
  const outflow = txn.amount > 0;
  const inflow = txn.amount < 0;
  const primary = txn.pfcPrimary ?? '';
  const detailed = txn.pfcDetailed ?? '';
  const description = text(txn);

  // --- Account-semantics guards (strongest structural evidence) -----------

  if (isCredit(txn) && inflow) {
    // Money arriving on a credit card is a payment, refund, reward, or
    // dispute credit. It is categorically never earned income.
    const paymentShaped =
      primary === 'LOAN_PAYMENTS' ||
      detailed === 'TRANSFER_IN_ACCOUNT_TRANSFER' ||
      CARD_PAYMENT_PATTERN.test(description) ||
      CARD_CREDIT_PAYMENT_PATTERN.test(description);

    if (paymentShaped) {
      return {
        role: 'credit_card_payment',
        displayBucket: null,
        source: 'account_semantics',
        ruleId: 'credit-inflow-payment',
        confidence: 'high',
        explanation:
          'Incoming credit on a card that matches payment evidence; the card side of a card payment.',
      };
    }

    return {
      role: 'refund_or_credit',
      displayBucket: null,
      source: 'account_semantics',
      ruleId: 'credit-inflow-credit',
      // A payment-matching description never reaches this branch (it is
      // paymentShaped above), so this is always the without-evidence case.
      confidence: 'medium',
      explanation:
        'Incoming credit on a card without payment evidence; treated as a refund, reward, or statement credit — never income.',
    };
  }

  if (isCredit(txn) && outflow) {
    if (primary === 'BANK_FEES' || INTEREST_FEE_PATTERN.test(description)) {
      return {
        role: 'interest_or_fee',
        displayBucket: 'Fees & Interest',
        source: 'account_semantics',
        ruleId: 'credit-outflow-fee',
        confidence: 'high',
        explanation: 'Interest or fee posted on a credit account; a real economic cost.',
      };
    }
    // Otherwise fall through: purchases on a card are ordinary expenses.
  }

  // --- PFC intent ---------------------------------------------------------

  if (primary === 'BANK_FEES' && outflow) {
    return {
      role: 'interest_or_fee',
      displayBucket: 'Fees & Interest',
      source: 'pfc',
      ruleId: 'pfc-bank-fees',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation: 'Plaid categorizes this as a bank fee or interest charge.',
    };
  }

  if (primary === 'LOAN_PAYMENTS' && outflow) {
    if (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') {
      return {
        role: 'credit_card_payment',
        displayBucket: null,
        source: 'pfc',
        ruleId: 'pfc-card-payment',
        confidence: pfcConfidenceBand(txn.pfcConfidence),
        explanation:
          'Outflow categorized as a credit card payment; account movement, not spend.',
      };
    }

    return {
      role: 'debt_principal_payment',
      displayBucket: null,
      source: 'pfc',
      ruleId: 'pfc-loan-payment',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation:
        'Outflow categorized as a loan payment; a cash obligation, never counted as categorized spend or income.',
    };
  }

  if (primary === 'TRANSFER_OUT' && outflow) {
    const savingsLike =
      detailed === 'TRANSFER_OUT_SAVINGS' ||
      detailed === 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS';

    return {
      role: savingsLike ? 'savings_or_investment_transfer' : 'internal_transfer',
      displayBucket: null,
      source: 'pfc',
      ruleId: savingsLike ? 'pfc-transfer-savings' : 'pfc-transfer-out',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation: savingsLike
        ? 'Transfer into savings or investments; money kept, not spent.'
        : 'Outgoing transfer between accounts; account movement, not spend.',
    };
  }

  if (primary === 'TRANSFER_IN' && inflow) {
    return {
      role: 'internal_transfer',
      displayBucket: null,
      source: 'pfc',
      ruleId: 'pfc-transfer-in',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation:
        'Incoming transfer between accounts; account movement, never income.',
    };
  }

  if (primary === 'INCOME' && inflow && !isCredit(txn)) {
    if (detailed === 'INCOME_TAX_REFUND') {
      return {
        role: 'refund_or_credit',
        displayBucket: null,
        source: 'pfc',
        ruleId: 'pfc-tax-refund',
        confidence: pfcConfidenceBand(txn.pfcConfidence),
        explanation: 'Tax refund; a return of money, not recurring earned income.',
      };
    }

    return {
      role: 'earned_income',
      displayBucket: null,
      source: 'pfc',
      ruleId: 'pfc-income',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation: 'Plaid categorizes this deposit as income.',
    };
  }

  // Inflow carrying a spend-shaped PFC on a non-credit account: a refund to
  // the account (e.g. a returned purchase).
  if (inflow && primary && DISPLAY_BUCKETS[primary] && primary !== 'BANK_FEES') {
    return {
      role: 'refund_or_credit',
      displayBucket: null,
      source: 'pfc',
      ruleId: 'pfc-spend-shaped-inflow',
      confidence: 'medium',
      explanation:
        'Money returned under a spending category; treated as a refund, not income.',
    };
  }

  // --- Deterministic description rules ------------------------------------

  if (outflow && isDepository(txn) && CARD_PAYMENT_PATTERN.test(description)) {
    return {
      role: 'credit_card_payment',
      displayBucket: null,
      source: 'deterministic_rule',
      ruleId: 'desc-card-payment',
      confidence: 'medium',
      explanation:
        'Checking outflow whose description matches a card payment; account movement pending reconciliation.',
    };
  }

  if (inflow && isDepository(txn) && PAYROLL_PATTERN.test(description)) {
    return {
      role: 'earned_income',
      displayBucket: null,
      source: 'deterministic_rule',
      ruleId: 'desc-payroll',
      confidence: 'high',
      explanation: 'Deposit description matches payroll or direct deposit.',
    };
  }

  if (outflow && INTEREST_FEE_PATTERN.test(description)) {
    return {
      role: 'interest_or_fee',
      displayBucket: 'Fees & Interest',
      source: 'deterministic_rule',
      ruleId: 'desc-fee',
      confidence: 'medium',
      explanation: 'Description matches an interest charge or account fee.',
    };
  }

  // --- Ordinary categorized spend -----------------------------------------

  if (outflow && primary && DISPLAY_BUCKETS[primary]) {
    const bucket = displayBucketFor(primary, detailed) ?? UNCATEGORIZED;

    return {
      role: 'expense',
      displayBucket: bucket,
      source: 'pfc',
      ruleId: 'pfc-expense',
      confidence: pfcConfidenceBand(txn.pfcConfidence),
      explanation: `Categorized spend (${bucket}).`,
    };
  }

  if (outflow && isCredit(txn)) {
    // A card purchase with no usable PFC is still clearly spend.
    return {
      role: 'expense',
      displayBucket: UNCATEGORIZED,
      source: 'account_semantics',
      ruleId: 'credit-outflow-expense',
      confidence: 'medium',
      explanation: 'Purchase on a credit card without a usable category.',
    };
  }

  // --- Explicit fallback ---------------------------------------------------

  if (outflow) {
    return {
      role: 'unknown_outflow',
      displayBucket: null,
      source: 'fallback',
      ruleId: 'fallback-outflow',
      confidence: 'low',
      explanation: 'Money out without enough evidence to classify.',
    };
  }

  if (inflow) {
    return {
      role: 'unknown_inflow',
      displayBucket: null,
      source: 'fallback',
      ruleId: 'fallback-inflow',
      confidence: 'low',
      explanation: 'Money in without enough evidence to classify; never assumed to be income.',
    };
  }

  return {
    role: 'unknown_outflow',
    displayBucket: null,
    source: 'fallback',
    ruleId: 'fallback-zero',
    confidence: 'low',
    explanation: 'Zero-amount posting.',
  };
}

/** Apply the user's override for this transaction, if one matches. */
export function applyOverride(
  txn: ClassifiableTransaction,
  overrides: readonly ClassificationOverride[],
): ClassificationResult | null {
  const byTransaction = overrides.find(
    (override) =>
      override.scope === 'transaction' && override.transactionRowId === txn.rowId,
  );

  const byMerchant = txn.merchantNormalized
    ? overrides.find(
        (override) =>
          override.scope === 'merchant' &&
          override.merchantNormalized === txn.merchantNormalized,
      )
    : undefined;

  const winner = byTransaction ?? byMerchant;

  if (!winner) {
    return null;
  }

  return {
    role: winner.role,
    displayBucket: winner.displayBucket,
    source: 'user_override',
    ruleId: winner.scope === 'transaction' ? 'override-transaction' : 'override-merchant',
    confidence: 'high',
    explanation:
      winner.scope === 'transaction'
        ? 'You corrected this transaction.'
        : 'You corrected this merchant; the correction applies to all its transactions.',
  };
}

// ---------------------------------------------------------------------------
// Persistence and the pipeline job
// ---------------------------------------------------------------------------

export async function listOverrides(
  userId: string,
  db: Queryable = pool,
): Promise<ClassificationOverride[]> {
  const { rows } = await db.query<{
    scope: 'transaction' | 'merchant';
    transaction_row_id: string | null;
    merchant_normalized: string | null;
    economic_role: ClassificationOverride['role'];
    display_bucket: string | null;
  }>(
    `SELECT scope, transaction_row_id, merchant_normalized, economic_role, display_bucket
     FROM user_classification_overrides
     WHERE user_id = $1`,
    [userId],
  );

  return rows.map((row) => ({
    scope: row.scope,
    transactionRowId: row.transaction_row_id,
    merchantNormalized: row.merchant_normalized,
    role: row.economic_role,
    displayBucket: row.display_bucket,
  }));
}

export async function upsertClassification(
  db: Queryable,
  userId: string,
  transactionRowId: string,
  result: ClassificationResult,
): Promise<void> {
  await db.query(
    `INSERT INTO transaction_classifications (
       transaction_row_id, user_id, economic_role, display_bucket, source,
       rule_id, rule_version, confidence, explanation
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transaction_row_id) DO UPDATE SET
       economic_role = EXCLUDED.economic_role,
       display_bucket = EXCLUDED.display_bucket,
       source = EXCLUDED.source,
       rule_id = EXCLUDED.rule_id,
       rule_version = EXCLUDED.rule_version,
       confidence = EXCLUDED.confidence,
       explanation = EXCLUDED.explanation,
       updated_at = NOW()`,
    [
      transactionRowId,
      userId,
      result.role,
      result.displayBucket,
      result.source,
      result.ruleId,
      CLASSIFICATION_RULE_VERSION,
      result.confidence,
      result.explanation,
    ],
  );
}

export type ClassifyDeps = {
  db: Queryable;
  listTransactions(userId: string): Promise<ClassifiableTransaction[]>;
  enqueueNextStage(payload: UserAnalysisJobPayload): Promise<unknown>;
};

async function defaultDeps(): Promise<ClassifyDeps> {
  const [store, enqueue, jobs] = await Promise.all([
    import('./transaction-store.service.js'),
    import('../jobs/enqueue.js'),
    import('../jobs/types.js'),
  ]);

  return {
    db: pool,
    listTransactions: async (userId) =>
      store.listUserTransactions(userId, { includePending: true }),
    enqueueNextStage: (payload) =>
      enqueue.enqueueAnalysisStage(jobs.JOB.RECONCILE_USER_TRANSFERS, payload),
  };
}

/**
 * CLASSIFY_USER_TRANSACTIONS: classify the user's whole ledger (idempotent
 * upsert per transaction), then chain reconciliation.
 */
export async function classifyUserTransactions(
  payload: UserAnalysisJobPayload,
  depsOverride?: ClassifyDeps,
): Promise<{ classified: number }> {
  const deps = depsOverride ?? (await defaultDeps());

  const [transactions, overrides] = await Promise.all([
    deps.listTransactions(payload.userId),
    listOverrides(payload.userId, deps.db),
  ]);

  let classified = 0;

  for (const txn of transactions) {
    const result = applyOverride(txn, overrides) ?? classifyTransaction(txn);
    await upsertClassification(deps.db, payload.userId, txn.rowId, result);
    classified += 1;
  }

  logger.info('classification complete', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    classified,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
  });

  await deps.enqueueNextStage(payload);

  return { classified };
}
