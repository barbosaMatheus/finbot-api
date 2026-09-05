-- API-009: one-to-one links between the two postings of a transfer or card
-- payment. Links are pure derivation — rebuilt wholesale by the
-- reconciliation job — with the scoring evidence preserved for audit.

CREATE TABLE IF NOT EXISTS transaction_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outflow_transaction_row_id UUID NOT NULL REFERENCES plaid_transactions(id) ON DELETE CASCADE,
  inflow_transaction_row_id UUID NOT NULL REFERENCES plaid_transactions(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (
    link_type IN ('credit_card_payment', 'internal_transfer', 'savings_transfer')
  ),
  match_score NUMERIC(6, 4) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  rule_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One-to-one matching: each posting participates in at most one link.
  UNIQUE (outflow_transaction_row_id),
  UNIQUE (inflow_transaction_row_id)
);

CREATE INDEX IF NOT EXISTS transaction_links_user_idx
  ON transaction_links (user_id);
