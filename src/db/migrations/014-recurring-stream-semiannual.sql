-- Recurrence detection gained a semi-annual cadence class (insurance
-- premiums, twice-yearly dues). The inline CHECK from 009 was auto-named by
-- Postgres as recurring_streams_cadence_check; replace it with a named one
-- that admits the new value.
ALTER TABLE recurring_streams DROP CONSTRAINT IF EXISTS recurring_streams_cadence_check;
ALTER TABLE recurring_streams ADD CONSTRAINT recurring_streams_cadence_check CHECK (
  cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual', 'irregular')
);
