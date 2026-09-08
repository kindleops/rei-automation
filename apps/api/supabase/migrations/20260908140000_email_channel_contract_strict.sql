-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL-2: the CONTRACT step of expand / deploy / contract.
--
-- DO NOT APPLY THIS UNTIL THE lck_v2 CODE IS DEPLOYED AND CONFIRMED.
--
--   expand    20260908120000_email_channel_canonical_domain.sql
--             adds channel, and accepts a caller that does not name one,
--             stamping the row channel_source = 'expand_default_sms'.
--   deploy    the lck_v2 code ships. Every caller now names its channel,
--             because buildLogicalCommunicationKey() refuses to produce a key
--             without one.
--   contract  THIS FILE. Removes the tolerance, so a channel-less caller is
--             refused again -- which is the behaviour the whole channel-identity
--             design depends on.
--
-- WHY THE TOLERANCE MUST NOT BECOME PERMANENT
--   During expand it is provably safe: the only callers that can omit a channel
--   predate lck_v2, and every one of them is SMS. After deploy that reasoning
--   expires. A channel-less caller then means a BUG in new code, and coercing it
--   to 'sms' would file an email action as an SMS one -- re-opening the exact
--   cross-channel collision this release exists to close, silently, in the one
--   place nobody would look.
--
-- THE GUARD
--   This migration REFUSES to apply while any caller is still relying on the
--   tolerance. It looks at the most recent 'expand_default_sms' row: if one was
--   written inside the quiet window, the deploy is not actually complete and
--   contracting now would start refusing live traffic.
--
--   The window is 60 minutes by default and can be widened for a slow rollout:
--
--     SET LOCAL email.contract_quiet_minutes = '180';
--
--   It is deliberately a REFUSAL rather than a warning. A contract step that
--   proceeds over its own guard is a contract step nobody can trust.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. refuse to contract while the tolerance is still in use ───────────────

DO $$
DECLARE
  v_quiet_minutes integer := COALESCE(
    NULLIF(current_setting('email.contract_quiet_minutes', true), '')::integer,
    60
  );
  v_latest    timestamptz;
  v_total     bigint;
BEGIN
  SELECT max(created_at), count(*)
    INTO v_latest, v_total
    FROM public.seller_logical_communications
   WHERE channel_source = 'expand_default_sms';

  IF v_latest IS NOT NULL AND v_latest > now() - make_interval(mins => v_quiet_minutes) THEN
    RAISE EXCEPTION
      'refusing to contract: a caller supplied no channel at % (within the % minute quiet window; % such rows exist). The lck_v2 deploy is not complete, and contracting now would refuse live sends.',
      v_latest, v_quiet_minutes, v_total
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RAISE NOTICE
    'contract guard passed: % historical expand_default_sms row(s), most recent %.',
    COALESCE(v_total, 0), COALESCE(v_latest::text, 'none');
END $$;

-- ── 2. the strict RPC ───────────────────────────────────────────────────────
--
-- Identical to the expand form except that a missing channel is REFUSED. The
-- refusal is a structured { ok: false, reason } rather than a raised exception,
-- for the same reason the identity-conflict path is: the caller is the canonical
-- dispatcher, and it already knows how to turn a refusal into a denied send with
-- a named cause. An exception would reach it as a generic store error and lose
-- the reason.

CREATE OR REPLACE FUNCTION public.seller_logical_communication_get_or_create(
  p_logical_key          text,
  p_logical_key_version  text,
  p_communication_type   text,
  p_lineage              jsonb DEFAULT '{}'::jsonb,
  p_policy               jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_row            public.seller_logical_communications;
  v_existing       public.seller_logical_communications;
  v_conflict       text[] := ARRAY[]::text[];
  v_channel        text;
BEGIN
  -- CONTRACTED. No coercion, no default, no fallback. A caller that cannot say
  -- how its message travels has not earned a send, exactly as a caller that
  -- cannot name its domain action has not.
  v_channel := NULLIF(p_lineage->>'channel', '');
  IF v_channel IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'missing_communication_channel',
      'logical_key', p_logical_key
    );
  END IF;

  INSERT INTO public.seller_logical_communications (
    logical_key, logical_key_version, communication_type,
    channel, channel_source, thread_key, to_phone_number, to_email,
    property_id, opportunity_id, master_owner_id,
    decision_id, message_event_id, campaign_id, campaign_target_id, touch_number,
    follow_up_id, referral_id, source_event_id,
    seller_offer_id, seller_offer_version, operator_action_id,
    canary_run_id, canary_leg, supersedes_communication_id,
    logical_key_policy_version, retry_policy_version, outcome_policy_version
  ) VALUES (
    p_logical_key, p_logical_key_version, p_communication_type,
    v_channel                                    , 'caller',
    NULLIF(p_lineage->>'thread_key',''),
    NULLIF(p_lineage->>'to_phone_number','')     , NULLIF(p_lineage->>'to_email',''),
    NULLIF(p_lineage->>'property_id','')         , (NULLIF(p_lineage->>'opportunity_id',''))::uuid,
    NULLIF(p_lineage->>'master_owner_id',''),
    NULLIF(p_lineage->>'decision_id','')         , NULLIF(p_lineage->>'message_event_id',''),
    (NULLIF(p_lineage->>'campaign_id',''))::uuid , (NULLIF(p_lineage->>'campaign_target_id',''))::uuid,
    (NULLIF(p_lineage->>'touch_number',''))::integer,
    (NULLIF(p_lineage->>'follow_up_id',''))::uuid, NULLIF(p_lineage->>'referral_id',''),
    NULLIF(p_lineage->>'source_event_id',''),
    NULLIF(p_lineage->>'seller_offer_id','')     , (NULLIF(p_lineage->>'seller_offer_version',''))::integer,
    NULLIF(p_lineage->>'operator_action_id',''),
    NULLIF(p_lineage->>'canary_run_id','')       , NULLIF(p_lineage->>'canary_leg',''),
    (NULLIF(p_lineage->>'supersedes_communication_id',''))::uuid,
    NULLIF(p_policy->>'logical_key_policy_version',''),
    NULLIF(p_policy->>'retry_policy_version',''),
    NULLIF(p_policy->>'outcome_policy_version','')
  )
  ON CONFLICT (logical_key) DO UPDATE
     SET last_observed_at  = now(),
         observation_count = public.seller_logical_communications.observation_count + 1
   WHERE public.seller_logical_communications.communication_type   IS NOT DISTINCT FROM EXCLUDED.communication_type
     AND public.seller_logical_communications.channel              IS NOT DISTINCT FROM EXCLUDED.channel
     AND public.seller_logical_communications.decision_id          IS NOT DISTINCT FROM EXCLUDED.decision_id
     AND public.seller_logical_communications.message_event_id     IS NOT DISTINCT FROM EXCLUDED.message_event_id
     AND public.seller_logical_communications.campaign_target_id   IS NOT DISTINCT FROM EXCLUDED.campaign_target_id
     AND public.seller_logical_communications.touch_number         IS NOT DISTINCT FROM EXCLUDED.touch_number
     AND public.seller_logical_communications.follow_up_id         IS NOT DISTINCT FROM EXCLUDED.follow_up_id
     AND public.seller_logical_communications.referral_id          IS NOT DISTINCT FROM EXCLUDED.referral_id
     AND public.seller_logical_communications.source_event_id      IS NOT DISTINCT FROM EXCLUDED.source_event_id
     AND public.seller_logical_communications.seller_offer_id      IS NOT DISTINCT FROM EXCLUDED.seller_offer_id
     AND public.seller_logical_communications.seller_offer_version IS NOT DISTINCT FROM EXCLUDED.seller_offer_version
     AND public.seller_logical_communications.operator_action_id   IS NOT DISTINCT FROM EXCLUDED.operator_action_id
     AND public.seller_logical_communications.canary_run_id        IS NOT DISTINCT FROM EXCLUDED.canary_run_id
     AND public.seller_logical_communications.canary_leg           IS NOT DISTINCT FROM EXCLUDED.canary_leg
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reused', v_row.observation_count > 1,
      'logical_communication_id', v_row.id,
      'logical_key', v_row.logical_key,
      'channel', v_row.channel,
      'state', v_row.state,
      'delivery_possibility', v_row.delivery_possibility,
      'retry_authority', v_row.retry_authority,
      'updated_at', v_row.updated_at,
      'last_observed_at', v_row.last_observed_at,
      'observation_count', v_row.observation_count
    );
  END IF;

  SELECT * INTO v_existing
  FROM public.seller_logical_communications
  WHERE logical_key = p_logical_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'logical_communication_upsert_failed');
  END IF;

  IF v_existing.communication_type   IS DISTINCT FROM p_communication_type                                  THEN v_conflict := array_append(v_conflict, 'communication_type'); END IF;
  IF v_existing.channel              IS DISTINCT FROM v_channel                                             THEN v_conflict := array_append(v_conflict, 'channel'); END IF;
  IF v_existing.decision_id          IS DISTINCT FROM NULLIF(p_lineage->>'decision_id','')                  THEN v_conflict := array_append(v_conflict, 'decision_id'); END IF;
  IF v_existing.message_event_id     IS DISTINCT FROM NULLIF(p_lineage->>'message_event_id','')             THEN v_conflict := array_append(v_conflict, 'message_event_id'); END IF;
  IF v_existing.campaign_target_id   IS DISTINCT FROM (NULLIF(p_lineage->>'campaign_target_id',''))::uuid   THEN v_conflict := array_append(v_conflict, 'campaign_target_id'); END IF;
  IF v_existing.touch_number         IS DISTINCT FROM (NULLIF(p_lineage->>'touch_number',''))::integer      THEN v_conflict := array_append(v_conflict, 'touch_number'); END IF;
  IF v_existing.follow_up_id         IS DISTINCT FROM (NULLIF(p_lineage->>'follow_up_id',''))::uuid         THEN v_conflict := array_append(v_conflict, 'follow_up_id'); END IF;
  IF v_existing.referral_id          IS DISTINCT FROM NULLIF(p_lineage->>'referral_id','')                  THEN v_conflict := array_append(v_conflict, 'referral_id'); END IF;
  IF v_existing.source_event_id      IS DISTINCT FROM NULLIF(p_lineage->>'source_event_id','')              THEN v_conflict := array_append(v_conflict, 'source_event_id'); END IF;
  IF v_existing.seller_offer_id      IS DISTINCT FROM NULLIF(p_lineage->>'seller_offer_id','')              THEN v_conflict := array_append(v_conflict, 'seller_offer_id'); END IF;
  IF v_existing.seller_offer_version IS DISTINCT FROM (NULLIF(p_lineage->>'seller_offer_version',''))::integer THEN v_conflict := array_append(v_conflict, 'seller_offer_version'); END IF;
  IF v_existing.operator_action_id   IS DISTINCT FROM NULLIF(p_lineage->>'operator_action_id','')           THEN v_conflict := array_append(v_conflict, 'operator_action_id'); END IF;
  IF v_existing.canary_run_id        IS DISTINCT FROM NULLIF(p_lineage->>'canary_run_id','')                THEN v_conflict := array_append(v_conflict, 'canary_run_id'); END IF;
  IF v_existing.canary_leg           IS DISTINCT FROM NULLIF(p_lineage->>'canary_leg','')                   THEN v_conflict := array_append(v_conflict, 'canary_leg'); END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'logical_communication_identity_conflict',
    'logical_key', p_logical_key,
    'existing_logical_communication_id', v_existing.id,
    'conflicting_fields', to_jsonb(v_conflict)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) TO service_role;

-- ── 3. record that the tolerance is gone ────────────────────────────────────
--
-- 'expand_default_sms' stays legal in the CHECK constraint: historical rows
-- written during the expand window are real and must not become invalid. What
-- changes is that nothing can produce a new one.

COMMENT ON COLUMN public.seller_logical_communications.channel_source IS
  'Where channel came from: caller (named it) or backfill (pre-lck_v2 row). expand_default_sms rows are historical evidence of the expand window; the contract migration removed the coercion that produced them, so no new ones can appear.';

COMMIT;
