-- PROPOSED (not applied) — Campaign Composer 2.0: one launch per campaign, decided by the database.
--
-- WHY. A launch builds targets, then schedules or activates through the
-- lifecycle. Two launch requests for one campaign (double-click, two tabs, a
-- retry after a timeout, two servers) must produce exactly one launch. The
-- server's in-process single-flight cannot see another process.
--
-- WHAT IS ALREADY ENFORCED IN PROD WITHOUT THIS MIGRATION. The composer claims
-- the launch with the existing public.idempotency_begin('campaign_launch',
-- <campaign_id>, …) — the durable ledger's atomic INSERT … ON CONFLICT (scope,
-- key) DO NOTHING claim (20260831000000). One claimant wins; concurrent ones get
-- event_already_processing; after completion every later attempt gets
-- duplicate_event_ignored. The lifecycle edges (campaign_transition_status,
-- advisory-locked) are the second line.
--
-- WHAT THIS ADDS (closing three gaps of the generic ledger):
--   1. The claim and the campaign's state are decided in ONE transaction under
--      the campaign row lock: a campaign that is no longer draft/built (already
--      scheduled/activated by any path — Composer, legacy builder, war room,
--      cron) cannot be claimed, even after the ledger row was purged (30-day
--      retention) or its lease went stale.
--   2. finish is FENCED on the claim token (idempotency_complete/fail are not):
--      a holder whose lease went stale and was reclaimed cannot overwrite the
--      new holder's outcome.
--   3. A launched claim is retained (retain_until far future) so a retry months
--      later still answers with the original result.
--
-- Security: SECURITY DEFINER, search_path = '', EXECUTE for service_role only.
-- Rollback: PROPOSED_20261002190000_campaign_launch_claim_ROLLBACK.sql
-- Pretest: apps/api/scripts/proof/campaign-launch-claim-pglite.mjs (PGlite).

BEGIN;

CREATE OR REPLACE FUNCTION public.campaign_launch_claim(
  p_campaign_id uuid,
  p_launch_key text,
  p_claim_token uuid,
  p_lease_ms integer DEFAULT 1800000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_row public.idempotency_ledger%ROWTYPE;
  v_claim jsonb;
BEGIN
  IF p_campaign_id IS NULL OR trim(COALESCE(p_launch_key, '')) = '' OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', 'missing_campaign_or_key');
  END IF;

  -- Serialises with every lifecycle transition and with concurrent claims.
  SELECT lower(c.status) INTO v_status FROM public.campaigns c WHERE c.id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'claimed', false, 'reason', 'campaign_not_found');
  END IF;

  SELECT * INTO v_row FROM public.idempotency_ledger
   WHERE scope = 'campaign_launch' AND key = p_campaign_id::text;

  -- A completed launch answers every retry with its own result.
  IF FOUND AND v_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'already_launched',
      'launch_key', v_row.metadata->>'launch_key', 'result', v_row.metadata->'result', 'status', v_status);
  END IF;

  IF v_status NOT IN ('draft', 'built') THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'reason', 'campaign_not_launchable', 'status', v_status);
  END IF;

  v_claim := public.idempotency_begin(
    'campaign_launch', p_campaign_id::text, p_claim_token, 'composer launch',
    jsonb_build_object('launch_key', trim(p_launch_key)), p_lease_ms, NULL);

  IF (v_claim->>'duplicate')::boolean IS DISTINCT FROM false THEN
    RETURN jsonb_build_object('ok', true, 'claimed', false,
      'reason', CASE WHEN v_claim->>'reason' = 'event_already_processing' THEN 'launch_in_progress' ELSE COALESCE(v_claim->>'reason', 'not_claimed') END,
      'launch_key', v_claim->'meta'->>'launch_key', 'status', v_status);
  END IF;

  -- The ledger merges metadata on reclaim; the winner's key is the one recorded.
  UPDATE public.idempotency_ledger
     SET metadata = metadata || jsonb_build_object('launch_key', trim(p_launch_key))
   WHERE scope = 'campaign_launch' AND key = p_campaign_id::text;

  RETURN jsonb_build_object('ok', true, 'claimed', true, 'reason', v_claim->>'reason',
    'claim_token', p_claim_token::text, 'status', v_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.campaign_launch_finish(
  p_campaign_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_result jsonb DEFAULT '{}'::jsonb,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_outcome NOT IN ('completed', 'failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_outcome');
  END IF;
  UPDATE public.idempotency_ledger
     SET status = p_outcome,
         completed_at = CASE WHEN p_outcome = 'completed' THEN now() ELSE completed_at END,
         failed_at = CASE WHEN p_outcome = 'failed' THEN now() ELSE failed_at END,
         last_error = CASE WHEN p_outcome = 'failed' THEN NULLIF(trim(COALESCE(p_error, '')), '') ELSE NULL END,
         claim_token = NULL,
         metadata = metadata || jsonb_build_object('result', COALESCE(p_result, '{}'::jsonb)),
         retain_until = CASE WHEN p_outcome = 'completed' THEN now() + interval '10 years' ELSE retain_until END,
         updated_at = now()
   WHERE scope = 'campaign_launch' AND key = p_campaign_id::text AND claim_token = p_claim_token;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_count = 1, 'fenced', v_count = 0, 'outcome', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.campaign_launch_claim(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_launch_finish(uuid, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_launch_claim(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_launch_finish(uuid, uuid, text, jsonb, text) TO service_role;

COMMIT;
