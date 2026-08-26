-- Plaid bank connections.
--
-- One row in plaid_items per linked Item (an Item is one set of credentials at
-- one institution). The Plaid access_token is a long-lived, reversible
-- credential to the user's bank data, so it is stored encrypted (AES-256-GCM,
-- see src/lib/crypto.ts) rather than in plaintext.
--
-- plaid_accounts is a snapshot of the accounts inside an Item, captured once at
-- link time via /accounts/get so the app has something real to display.

CREATE TABLE IF NOT EXISTS plaid_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plaid_items_user_id_idx ON plaid_items (user_id);

CREATE TABLE IF NOT EXISTS plaid_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plaid_item_id UUID NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  current_balance NUMERIC(14, 2),
  available_balance NUMERIC(14, 2),
  iso_currency_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plaid_accounts_plaid_item_id_idx ON plaid_accounts (plaid_item_id);
