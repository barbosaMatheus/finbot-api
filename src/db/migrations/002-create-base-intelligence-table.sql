CREATE TABLE IF NOT EXISTS base_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    contents TEXT NOT NULL
);