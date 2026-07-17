CREATE TABLE IF NOT EXISTS base_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    contents TEXT NOT NULL
);