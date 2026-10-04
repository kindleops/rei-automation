-- PROPOSED ROLLBACK for PROPOSED_20261005120000_lead_visibility.sql.
-- First set system_control lead_visibility_sync_enabled = false (the code then
-- stops naming these columns within 60 s — the gate's cache window).
-- Deals archived through the overlay become visible again (their stage/status
-- were never changed, so nothing else needs restoring).
BEGIN;
DROP TABLE IF EXISTS public.lead_visibility_actions;
DROP INDEX IF EXISTS public.idx_acq_opp_archived_at;
ALTER TABLE public.acquisition_opportunities
  DROP COLUMN IF EXISTS archive_action_id,
  DROP COLUMN IF EXISTS archive_reason,
  DROP COLUMN IF EXISTS archived_by,
  DROP COLUMN IF EXISTS archived_at;
COMMIT;
