-- Manual profile v2: the wizard asks only what connected accounts cannot
-- answer. Every money figure the old wizard collected (take-home pay,
-- housing, food, transport, savings, debt, subscriptions) is derived by the
-- facts engine and confirmed on the review, so those columns go away rather
-- than lingering as a second, contradictory source of the same numbers.
--
-- Forward-only and idempotent: safe to run on a database that never had the
-- old columns and on one that did.

ALTER TABLE user_info
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS marital_status,
  DROP COLUMN IF EXISTS employment_status,
  DROP COLUMN IF EXISTS monthly_take_home_income,
  DROP COLUMN IF EXISTS monthly_housing_costs,
  DROP COLUMN IF EXISTS monthly_food_grocery_costs,
  DROP COLUMN IF EXISTS monthly_transportation_costs,
  DROP COLUMN IF EXISTS savings_emergency_funds,
  DROP COLUMN IF EXISTS total_debt,
  DROP COLUMN IF EXISTS debt_interest_factor,
  DROP COLUMN IF EXISTS monthly_entertainment_subscriptions_costs,
  DROP COLUMN IF EXISTS entertainment_subscriptions,
  DROP COLUMN IF EXISTS financial_goals,
  DROP COLUMN IF EXISTS additional_money_pools,
  DROP COLUMN IF EXISTS investment_risk_comfort;

ALTER TABLE user_info
  ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shared_accounts BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS income_pattern TEXT NOT NULL DEFAULT 'steady',
  -- [{ kind, label, amount, cadence }] — bills and debts Plaid cannot see.
  ADD COLUMN IF NOT EXISTS declared_obligations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS upcoming_events TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS primary_goal TEXT NOT NULL DEFAULT 'not_sure',
  ADD COLUMN IF NOT EXISTS secondary_goals TEXT[] NOT NULL DEFAULT '{}',
  -- { description, targetAmount, targetMonth } when primary_goal = 'save_for_specific'.
  ADD COLUMN IF NOT EXISTS goal_detail JSONB,
  ADD COLUMN IF NOT EXISTS coaching_pace TEXT NOT NULL DEFAULT 'balanced',
  -- Written only by review corrections (keep_manual_value / set_value /
  -- use_observed_value). Never asked in the wizard.
  ADD COLUMN IF NOT EXISTS income_override NUMERIC(12, 2);

ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_income_pattern_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_income_pattern_check CHECK (
  income_pattern IN ('steady', 'varies', 'unpredictable', 'none')
);

ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_primary_goal_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_primary_goal_check CHECK (
  primary_goal IN (
    'stop_overspending',
    'pay_down_debt',
    'build_cushion',
    'save_for_specific',
    'understand_spending',
    'not_sure'
  )
);

ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_secondary_goals_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_secondary_goals_check CHECK (
  secondary_goals <@ ARRAY[
    'stop_overspending',
    'pay_down_debt',
    'build_cushion',
    'save_for_specific',
    'understand_spending'
  ]
  AND cardinality(secondary_goals) <= 2
);

ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_coaching_pace_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_coaching_pace_check CHECK (
  coaching_pace IN ('ease_in', 'balanced', 'push')
);

ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_income_override_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_income_override_check CHECK (
  income_override IS NULL OR income_override >= 0
);
