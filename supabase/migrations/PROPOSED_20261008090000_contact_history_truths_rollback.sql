-- PROPOSED · rollback for PROPOSED_20261008090000_contact_history_truths.sql
-- Set CAMPAIGN_CONTACT_TRUTHS=off and remove the four columns from the graph select list FIRST
-- (an unknown column fails the whole PostgREST query).
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.refresh_campaign_target_graph_contact_truths(text, integer);
DROP FUNCTION IF EXISTS public.contact_history_truths(text[]);
DROP INDEX IF EXISTS public.ctg_contact_truths_flagged_idx;
ALTER TABLE public.campaign_target_graph
  DROP COLUMN IF EXISTS person_ever_contacted,
  DROP COLUMN IF EXISTS person_last_contact_at,
  DROP COLUMN IF EXISTS current_best_contact_touched,
  DROP COLUMN IF EXISTS property_prior_person_keys,
  DROP COLUMN IF EXISTS property_prior_person_unknown,
  DROP COLUMN IF EXISTS retext_hold,
  DROP COLUMN IF EXISTS retext_hold_why,
  DROP COLUMN IF EXISTS contact_truths_at;
-- property_ever_contacted / property_last_outbound_at / property_outbound_count are shared with the
-- owner-approved PROPOSED_20261005161000; drop them only if that migration was never applied:
-- ALTER TABLE public.campaign_target_graph DROP COLUMN IF EXISTS property_ever_contacted,
--   DROP COLUMN IF EXISTS property_last_outbound_at, DROP COLUMN IF EXISTS property_outbound_count;
-- The owner_phone index is harmless to keep; to drop: DROP INDEX CONCURRENTLY IF EXISTS seller.owner_phone_phone_value_plain_idx;
