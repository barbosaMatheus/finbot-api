-- Gameplan step 4: the tables the weekly loop needs (cadence note "Events
-- and data this implies"; gameplan note §7, §8, §10.7). Every stored plan
-- carries the engine's own definitions as JSON so a grade replays from what
-- the user was shown, never from a recomputation.

-- Anchor settings (cadence note §2). 'auto' lets detection decide: payday
-- when a stable income stream exists, otherwise the fixed day. anchor_day
-- is 0–6 with Sunday = 0.
ALTER TABLE user_info
  ADD COLUMN IF NOT EXISTS anchor_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (anchor_mode IN ('auto', 'payday', 'fixed_day')),
  ADD COLUMN IF NOT EXISTS anchor_day SMALLINT NOT NULL DEFAULT 0
    CHECK (anchor_day BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS anchor_time_of_day TEXT NOT NULL DEFAULT 'evening'
    CHECK (anchor_time_of_day IN ('morning', 'midday', 'evening'));

-- The bucket most of a stream's members were classified into, so an
-- erratic essential stream can join the floor (§10.3) and a bill stream can
-- be left out of its bucket's cap average. Nullable like the other
-- detection fields; refreshed wholesale on the next run.
ALTER TABLE recurring_streams ADD COLUMN IF NOT EXISTS dominant_bucket TEXT;

CREATE TABLE IF NOT EXISTS gameplan_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('payday', 'fixed_day', 'first')),
  -- The effective anchor for this period; detection or the user's setting.
  anchor_mode TEXT NOT NULL CHECK (anchor_mode IN ('payday', 'fixed_day')),
  -- planned: plan built, anchor not yet acknowledged. open: "Got it".
  -- closed: graded. One period per user is ever not closed.
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'open', 'closed')),
  first_period BOOLEAN NOT NULL DEFAULT FALSE,
  opening_paycheck NUMERIC(14, 2),
  primary_income_stream_key TEXT,
  -- The engine's Shortlist as built (or last revised), for replay.
  plan JSONB,
  plan_source TEXT CHECK (plan_source IN ('model', 'template')),
  plan_fallback_reason TEXT,
  plan_model TEXT,
  -- Heads-up state the plan was built with: oneTimeCosts, billOverrides,
  -- relaxedBuckets, incomeAdjustment.
  heads_up_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  swap_used BOOLEAN NOT NULL DEFAULT FALSE,
  awareness_completed_at TIMESTAMPTZ,
  anchor_ready_at TIMESTAMPTZ,
  anchor_opened_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  mid_period_graded_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason TEXT CHECK (close_reason IN ('payday', 'schedule', 'fallback')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS gameplan_periods_one_live_idx
  ON gameplan_periods (user_id)
  WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS gameplan_periods_user_start_idx
  ON gameplan_periods (user_id, start_date DESC);

-- Five rows per period: ranks 1–3 are the plan, 4–5 the alternates. A swap
-- or a heads-up changes roles and appends new rows; nothing is deleted, so
-- the grade always finds what was shown.
CREATE TABLE IF NOT EXISTS gameplan_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES gameplan_periods(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  rank SMALLINT NOT NULL CHECK (rank >= 1),
  role TEXT NOT NULL CHECK (role IN ('plan', 'alternate', 'swapped_out', 'revised_out')),
  definition JSONB NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  score NUMERIC(8, 2),
  why TEXT,
  why_source TEXT CHECK (why_source IN ('model', 'template')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES gameplan_periods(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'heads_up')),
  reason_text TEXT,
  adjustment JSONB,
  before_plan JSONB NOT NULL,
  after_plan JSONB NOT NULL,
  diff JSONB,
  reply TEXT,
  reply_source TEXT CHECK (reply_source IN ('model', 'template')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plan_revisions_period_idx ON plan_revisions (period_id, created_at);

CREATE TABLE IF NOT EXISTS period_grades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES gameplan_periods(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mid_period', 'final')),
  grade JSONB NOT NULL,
  actuals JSONB NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  improvements TEXT,
  narration_source TEXT CHECK (narration_source IN ('model', 'template')),
  narration_fallback_reason TEXT,
  graded_through DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, kind)
);

CREATE TABLE IF NOT EXISTS user_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_id UUID REFERENCES gameplan_periods(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('got_in_the_way', 'heads_up', 'whats_been_hard')),
  text TEXT NOT NULL,
  -- For a got_in_the_way line: whether the miss was a one-off event or
  -- structural, which decides how the next cap is set (§5).
  attribution TEXT CHECK (attribution IN ('one_off', 'structural')),
  embedded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_reflections_user_idx ON user_reflections (user_id, created_at DESC);

-- The nudge ledger (§8): at most one a day, never twice for one transaction.
CREATE TABLE IF NOT EXISTS gameplan_nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_id UUID REFERENCES gameplan_periods(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('unusual_transaction', 'target_blown', 'unexpected_income', 'bill_overrun')
  ),
  transaction_row_id UUID REFERENCES plaid_transactions(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gameplan_nudges_user_sent_idx ON gameplan_nudges (user_id, sent_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS gameplan_nudges_transaction_idx
  ON gameplan_nudges (transaction_row_id)
  WHERE transaction_row_id IS NOT NULL;

-- Running totals for bills with a cadence longer than the period (§10.7).
-- Advanced when a period closes; reset when the bill lands.
CREATE TABLE IF NOT EXISTS gameplan_accruals (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  accrued NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (accrued >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, stream_key)
);

-- Idempotency ledger for the gameplan push types (anchor ready, reminder,
-- nudge, re-engage), keyed by period rather than analysis run.
CREATE TABLE IF NOT EXISTS gameplan_push_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_id UUID REFERENCES gameplan_periods(id) ON DELETE CASCADE,
  push_token_id UUID NOT NULL REFERENCES push_tokens(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_status TEXT,
  UNIQUE (push_token_id, notification_key)
);
