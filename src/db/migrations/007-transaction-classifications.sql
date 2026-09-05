-- API-008: derived economic classification, versioned separately from the
-- immutable transaction evidence, plus user overrides that always win for
-- their scope and survive full replays.

CREATE TABLE IF NOT EXISTS transaction_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_row_id UUID NOT NULL UNIQUE REFERENCES plaid_transactions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  economic_role TEXT NOT NULL CHECK (
    economic_role IN (
      'expense',
      'earned_income',
      'refund_or_credit',
      'internal_transfer',
      'credit_card_payment',
      'debt_principal_payment',
      'interest_or_fee',
      'savings_or_investment_transfer',
      'unknown_outflow',
      'unknown_inflow'
    )
  ),
  display_bucket TEXT,
  source TEXT NOT NULL CHECK (
    source IN (
      'pfc',
      'account_semantics',
      'deterministic_rule',
      'reconciliation',
      'user_override',
      'fallback'
    )
  ),
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  explanation TEXT NOT NULL,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transaction_classifications_user_role_idx
  ON transaction_classifications (user_id, economic_role);

CREATE TABLE IF NOT EXISTS user_classification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('transaction', 'merchant')),
  transaction_row_id UUID REFERENCES plaid_transactions(id) ON DELETE CASCADE,
  merchant_normalized TEXT,
  economic_role TEXT NOT NULL CHECK (
    economic_role IN (
      'expense',
      'earned_income',
      'refund_or_credit',
      'internal_transfer',
      'credit_card_payment',
      'debt_principal_payment',
      'interest_or_fee',
      'savings_or_investment_transfer',
      'unknown_outflow',
      'unknown_inflow'
    )
  ),
  display_bucket TEXT,
  -- Who changed what, and the original evidence, for the audit trail.
  evidence JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'transaction' AND transaction_row_id IS NOT NULL)
    OR (scope = 'merchant' AND merchant_normalized IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_overrides_transaction_idx
  ON user_classification_overrides (user_id, transaction_row_id)
  WHERE scope = 'transaction';

CREATE UNIQUE INDEX IF NOT EXISTS user_overrides_merchant_idx
  ON user_classification_overrides (user_id, merchant_normalized)
  WHERE scope = 'merchant';
