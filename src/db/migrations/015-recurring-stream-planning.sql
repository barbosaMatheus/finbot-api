-- Gameplan step 1: the fields a plan needs to EXPECT a bill rather than know
-- it (venture note gameplan-generation.md §10.2–10.3). Where it lands: a
-- calendar anchor for monthly-and-longer cadences plus the observed date
-- jitter. How much: an amount class from the relative variance, and the
-- planning amount a period reserves (fixed → last posting, variable → the
-- higher of last and the 75th percentile, erratic → none, not a bill).
--
-- Nullable, as 011 was: rows written by recur-v2 carry NULLs until the next
-- detection run refreshes them wholesale, which happens after every sync.
ALTER TABLE recurring_streams
  ADD COLUMN IF NOT EXISTS anchor_day_of_month SMALLINT
    CHECK (anchor_day_of_month BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS date_jitter_days SMALLINT
    CHECK (date_jitter_days >= 0),
  ADD COLUMN IF NOT EXISTS amount_class TEXT
    CHECK (amount_class IN ('fixed', 'variable', 'erratic')),
  ADD COLUMN IF NOT EXISTS planning_amount NUMERIC(14, 2)
    CHECK (planning_amount >= 0);
