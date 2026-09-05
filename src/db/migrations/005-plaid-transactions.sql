-- API-005: auditable Plaid transaction evidence and per-Item sync state.
--
-- Raw Plaid payloads are immutable evidence (raw JSONB); Plaid's explicit
-- added/modified/removed lifecycle is the only thing that mutates them.
-- Derived classification lives in its own table (API-008), versioned
-- separately, so analysis can be rebuilt without touching evidence.

CREATE TABLE IF NOT EXISTS plaid_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plaid_item_id UUID NOT NULL UNIQUE REFERENCES plaid_items(id) ON DELETE CASCADE,
  -- Last committed /transactions/sync cursor. NULL until the first page of
  -- the initial sync has been committed. Only ever advanced in the same
  -- transaction as the page's transaction changes.
  cursor TEXT,
  -- Raw transactions_update_status from Plaid's latest sync response.
  update_status TEXT NOT NULL DEFAULT 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    sync_status IN ('pending', 'syncing', 'complete', 'failed')
  ),
  oldest_transaction_date DATE,
  initialized_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plaid_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id UUID NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES plaid_accounts(account_id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE,
  pending_transaction_id TEXT,
  date DATE NOT NULL,
  authorized_date DATE,
  -- Plaid sign convention preserved verbatim: positive = money out.
  amount NUMERIC(14, 2) NOT NULL,
  iso_currency_code TEXT,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  merchant_name TEXT,
  merchant_normalized TEXT,
  payment_channel TEXT,
  pfc_primary TEXT,
  pfc_detailed TEXT,
  pfc_confidence TEXT,
  pfc_version TEXT NOT NULL DEFAULT 'v2',
  transaction_code TEXT,
  raw JSONB NOT NULL,
  is_removed BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plaid_transactions_user_date_idx
  ON plaid_transactions (user_id, date DESC);

CREATE INDEX IF NOT EXISTS plaid_transactions_item_date_idx
  ON plaid_transactions (plaid_item_id, date DESC);

CREATE INDEX IF NOT EXISTS plaid_transactions_account_date_idx
  ON plaid_transactions (account_id, date DESC);

CREATE INDEX IF NOT EXISTS plaid_transactions_merchant_idx
  ON plaid_transactions (user_id, merchant_normalized)
  WHERE merchant_normalized IS NOT NULL;

-- Reconciliation candidate lookups match on absolute amount within a date
-- window across a user's accounts.
CREATE INDEX IF NOT EXISTS plaid_transactions_user_amount_idx
  ON plaid_transactions (user_id, amount, date)
  WHERE is_removed = FALSE;
