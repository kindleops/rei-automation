-- ROLLBACK for PROPOSED_20261005120000_campaign_identity_release_evidence.sql.
-- Removes the accessor and its index. Nothing else referenced them before the
-- migration; the build degrades to "no evidence → nothing released" (today's
-- behavior) when the accessor is missing.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.campaign_identity_release_evidence(text[], text[]);
DROP INDEX IF EXISTS seller.property_entity_contact_v1_selected_person_idx;
