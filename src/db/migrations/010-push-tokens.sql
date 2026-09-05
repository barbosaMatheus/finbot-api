-- API-015: Expo push tokens and idempotent send records.
--
-- push_notification_sends is the idempotency ledger: the unique constraint
-- guarantees one logical review-ready notification per analysis run and
-- device, no matter how often the job retries.

CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_id TEXT,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, expo_token)
);

CREATE INDEX IF NOT EXISTS push_tokens_user_enabled_idx
  ON push_tokens (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS push_notification_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_run_id UUID NOT NULL REFERENCES financial_analysis_runs(id) ON DELETE CASCADE,
  push_token_id UUID NOT NULL REFERENCES push_tokens(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL DEFAULT 'financial_review_ready',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_status TEXT,
  UNIQUE (analysis_run_id, push_token_id, notification_type)
);
