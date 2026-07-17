CREATE TABLE IF NOT EXISTS user_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  date_of_birth DATE,
  marital_status TEXT NOT NULL CHECK (marital_status IN ('Single', 'Married', 'Domestic Partnership')),
  dependents_count INTEGER NOT NULL DEFAULT 0 CHECK (dependents_count >= 0),
  employment_status TEXT NOT NULL CHECK (employment_status IN ('Full-time', 'Part-time', 'Self-employed', 'Unemployed', 'Retired', 'Student')),
  monthly_take_home_income NUMERIC(12, 2) NOT NULL CHECK (monthly_take_home_income >= 0),
  monthly_housing_costs NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (monthly_housing_costs >= 0),
  monthly_food_grocery_costs NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (monthly_food_grocery_costs >= 0),
  monthly_transportation_costs NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (monthly_transportation_costs >= 0),
  savings_emergency_funds NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (savings_emergency_funds >= 0),
  total_debt NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_debt >= 0),
  debt_interest_factor BOOLEAN NOT NULL DEFAULT false,
  monthly_entertainment_subscriptions_costs NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (monthly_entertainment_subscriptions_costs >= 0),
  entertainment_subscriptions TEXT[] NOT NULL DEFAULT '{}',
  financial_goals TEXT[] NOT NULL DEFAULT '{}' CHECK (
    financial_goals <@ ARRAY['Build emergency fund', 'Pay off debt', 'Save for retirement', 'Save for a home', 'Invest more', 'Reduce spending']
    AND cardinality(financial_goals) = 3
  ),
  additional_money_pools TEXT[] NOT NULL DEFAULT '{}' CHECK (
    additional_money_pools <@ ARRAY['Vacation', 'Fun', 'Emergency', 'Savings', 'Investing']
    AND cardinality(additional_money_pools) = 3
  ),
  investment_risk_comfort TEXT NOT NULL CHECK (investment_risk_comfort IN ('Conservative', 'Moderate', 'Aggressive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
