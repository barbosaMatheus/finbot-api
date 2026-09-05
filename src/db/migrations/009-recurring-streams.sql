-- API-010: detected recurring streams. stream_key (direction + normalized
-- merchant) is stable across rebuilds so user confirmations/dismissals
-- survive replays; detection fields are refreshed wholesale each run.

CREATE TABLE IF NOT EXISTS recurring_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  merchant_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (
    cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'irregular')
  ),
  cadence_days NUMERIC(6, 2) NOT NULL,
  occurrences INTEGER NOT NULL,
  average_amount NUMERIC(14, 2) NOT NULL,
  last_amount NUMERIC(14, 2) NOT NULL,
  amount_variance NUMERIC(6, 4) NOT NULL,
  first_date DATE NOT NULL,
  last_date DATE NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  transaction_row_ids UUID[] NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  rule_version TEXT NOT NULL,
  -- The user's judgment outlives rebuilds.
  user_status TEXT NOT NULL DEFAULT 'detected' CHECK (
    user_status IN ('detected', 'confirmed', 'dismissed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, stream_key)
);

CREATE INDEX IF NOT EXISTS recurring_streams_user_idx
  ON recurring_streams (user_id, direction);
