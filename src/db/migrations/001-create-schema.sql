CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  on_boarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contents TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  date_of_birth DATE,
  marital_status TEXT NOT NULL CHECK (
    marital_status IN (
      'Single',
      'Married',
      'Domestic Partnership',
      'Divorced',
      'Widowed',
      'Prefer not to say'
    )
  ),
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
    additional_money_pools <@ ARRAY[
      'Vacation',
      'Fun',
      'Miscellaneous',
      'Emergency',
      'Savings',
      'Investing'
    ]
    AND cardinality(additional_money_pools) < 4
  ),
  investment_risk_comfort TEXT NOT NULL CHECK (investment_risk_comfort IN ('Conservative', 'Moderate', 'Aggressive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_text_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context_document_id UUID NOT NULL REFERENCES context_documents(id) ON DELETE CASCADE,
  response_text TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL,
  chunk_position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_token_hash ON refresh_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_id ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_context_documents_user_id ON context_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_context_documents_user_id_source ON context_documents (user_id, source);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_user_id ON user_text_embeddings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_context_document_id ON user_text_embeddings(context_document_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_chunk_position ON user_text_embeddings(chunk_position);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_created_at ON user_text_embeddings(created_at);
