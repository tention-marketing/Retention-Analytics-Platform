-- Preserve BOTH conversion figures Klaviyo reports, because they answer different
-- questions and the dashboard shows the unique one.
--
-- Confirmed against the live API and the Klaviyo dashboard on 2026-07-29:
--   conversions        = total attributed orders for the conversion metric
--   conversion_uniques = distinct converting customers, displayed in the Klaviyo
--                        Overview as "Placed order recipients"
-- A real send made the difference concrete: campaign 01KYJNYFWNN58ESQSYY0BJESSR
-- returned conversions=15 and conversion_uniques=14, and the dashboard showed 14.
--
-- Storing only one would either break reconciliation against the dashboard (total)
-- or silently discard order counts (unique), so campaign_stats keeps both. Both
-- values already arrive on the same grouped values-report call, so this costs no
-- extra API requests. ADDITIVE to §3's schema — no column is redefined or dropped.
--
-- Existing rows default to 0 and are refilled by the next sync (upsert refreshes
-- stats in place); a 0 here means "not yet re-synced", not "no conversions".
ALTER TABLE campaign_stats
  ADD COLUMN IF NOT EXISTS conversion_uniques INT DEFAULT 0;
