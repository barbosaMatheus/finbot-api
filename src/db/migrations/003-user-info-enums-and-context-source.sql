-- Forward-only migration replacing the in-place edits that the
-- feature/ingest-onboarding branch made to the already-applied
-- 001-create-schema.sql. Written defensively so it converges on the same
-- schema whether the database ran main's 001 or the branch-edited 001.

-- Widen marital_status to the values the onboarding wizard actually offers.
ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_marital_status_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_marital_status_check CHECK (
  marital_status IN (
    'Single',
    'Married',
    'Domestic Partnership',
    'Divorced',
    'Widowed',
    'Prefer not to say'
  )
);

-- Add the 'Miscellaneous' money pool offered by the wizard.
ALTER TABLE user_info DROP CONSTRAINT IF EXISTS user_info_additional_money_pools_check;
ALTER TABLE user_info ADD CONSTRAINT user_info_additional_money_pools_check CHECK (
  additional_money_pools <@ ARRAY[
    'Vacation',
    'Fun',
    'Miscellaneous',
    'Emergency',
    'Savings',
    'Investing'
  ]
  AND cardinality(additional_money_pools) < 4
);

-- Tag context documents by where they came from so onboarding free-text can be
-- replaced on re-submit without touching other context.
ALTER TABLE context_documents ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_context_documents_user_id_source ON context_documents (user_id, source);
