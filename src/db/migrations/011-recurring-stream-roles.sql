-- Phase-3 money-math fix: streams carry the dominant economic role of their
-- member transactions so the facts engine can keep non-income inflows (a
-- roommate's Zelle, marketplace payouts) out of the income estimate.
--
-- Nullable: rows written before this migration have no role until the next
-- detection run refreshes them wholesale; the facts engine treats NULL as
-- not-earned-income, which is the conservative reading.

ALTER TABLE recurring_streams
  ADD COLUMN IF NOT EXISTS dominant_role TEXT;
