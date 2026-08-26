-- API-002: separate manual completion, financial analysis, review, and final
-- onboarding completion. users.on_boarding_complete remains the single derived
-- final gate; it is never set directly by saving manual answers.

ALTER TABLE users ADD COLUMN IF NOT EXISTS manual_profile_completed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS linking_declared_complete_at TIMESTAMPTZ;

-- One row per user-level analysis attempt. A user has at most one run that is
-- not confirmed or superseded; retries mutate the existing failed run rather
-- than creating a parallel one.
CREATE TABLE IF NOT EXISTS financial_analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_lookback_days INTEGER NOT NULL DEFAULT 180 CHECK (requested_lookback_days > 0),
  status TEXT NOT NULL DEFAULT 'waiting_for_history' CHECK (
    status IN (
      'waiting_for_history',
      'processing',
      'review_ready',
      'recomputing',
      'confirmed',
      'failed',
      'superseded'
    )
  ),
  rule_version TEXT NOT NULL DEFAULT 'v1',
  triggering_item_ids UUID[] NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  confirmed_snapshot_version INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_ready_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS financial_analysis_runs_user_created_idx
  ON financial_analysis_runs (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS financial_analysis_runs_one_active_idx
  ON financial_analysis_runs (user_id)
  WHERE status NOT IN ('confirmed', 'superseded');

-- Versioned deterministic output of one analysis pass. Recomputation after a
-- correction writes a new version under the same run; confirmation pins the
-- version it confirmed so stale confirmations can be rejected.
CREATE TABLE IF NOT EXISTS financial_fact_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID NOT NULL REFERENCES financial_analysis_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  facts JSONB NOT NULL,
  coverage JSONB NOT NULL,
  rule_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (analysis_run_id, version)
);

CREATE INDEX IF NOT EXISTS financial_fact_snapshots_user_idx
  ON financial_fact_snapshots (user_id, created_at DESC);

-- Actionable exceptions surfaced by the review. item_key is a stable identity
-- (e.g. 'external_card_payment:autopay card payment') so rebuilding the review
-- after replay upserts instead of duplicating, preserving user resolutions.
CREATE TABLE IF NOT EXISTS financial_review_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID NOT NULL REFERENCES financial_analysis_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  type TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'resolved', 'accepted', 'dismissed')
  ),
  evidence JSONB NOT NULL DEFAULT '{}',
  proposed_value JSONB,
  confirmed_value JSONB,
  allowed_actions TEXT[] NOT NULL DEFAULT '{}',
  resolution JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (analysis_run_id, item_key)
);

CREATE INDEX IF NOT EXISTS financial_review_items_run_status_idx
  ON financial_review_items (analysis_run_id, status);
