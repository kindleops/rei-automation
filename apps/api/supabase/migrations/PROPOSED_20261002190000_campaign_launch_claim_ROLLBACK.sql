-- ROLLBACK for PROPOSED_20261002190000_campaign_launch_claim.sql
-- Drops the two functions only. Launch claims already written live in
-- public.idempotency_ledger (scope 'campaign_launch') and stay valid for the
-- composer's fallback path (idempotency_begin), which needs no function here.
BEGIN;
DROP FUNCTION IF EXISTS public.campaign_launch_finish(uuid, uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.campaign_launch_claim(uuid, text, uuid, integer);
COMMIT;
