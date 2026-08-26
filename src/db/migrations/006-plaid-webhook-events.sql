-- API-007: webhook audit and deduplication.
--
-- event_hash is sha256(raw body + a 5-minute time bucket): identical retry
-- deliveries within the bucket collapse into one processed event, while a
-- legitimately repeated event (same body, much later) processes again.

CREATE TABLE IF NOT EXISTS plaid_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_hash TEXT NOT NULL UNIQUE,
  item_id TEXT,
  webhook_type TEXT NOT NULL,
  webhook_code TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plaid_webhook_events_item_idx
  ON plaid_webhook_events (item_id, received_at DESC);
