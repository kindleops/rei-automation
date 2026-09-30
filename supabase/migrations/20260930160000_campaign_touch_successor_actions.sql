-- §11 campaign-touch successor actions.
--
-- WHY. A campaign touch the carrier filtered (the provider accepted it, then the
-- delivery receipt said `failed`) may be re-planned on a different template.
-- queue-row-identity binds that re-plan to action_sequence = generation + 1
-- (38c30957), which is a NEW logical key. This table, however, allowed exactly
-- ONE communication per (campaign_target_id, touch_number). The insert hit
-- uq_seller_logical_communications_campaign_touch, the RPC raised, the store
-- answered `logical_communication_store_error`, and the processor released the
-- row, every minute, indefinitely. Measured 2026-09-29 13:00Z .. 2026-09-30:
-- 166 released retries, ~2,800 refused claims an hour, 0 sent. The same 50
-- rows filled every 50-row claim batch, so the other 116 were never reached.
--
-- WHAT CHANGES.
--   1. One ROOT communication per campaign touch (supersedes IS NULL), and a
--      communication is superseded at most once. The chain for a touch is
--      linear, so two retries can never both succeed the same predecessor.
--   2. get_or_create creates a successor ONLY when the touch's latest
--      communication is settled and the carrier said it was NOT delivered:
--        - same key version; state and delivery_possibility provider_accepted;
--        - no attempt still in flight;
--        - a receipt says failed (message_events.delivery_status,
--          send_queue.delivery_confirmed or the callback ledger) and nothing
--          anywhere says delivered.
--      Anything else is a refusal with a reason, never a new communication.
--   3. A uniqueness collision is returned as a refusal instead of raised, so the
--      caller sees WHY, and a store outage stays distinguishable from a "no".
--
-- WHAT DOES NOT CHANGE. A delivered, ambiguous, in-flight, suppressed, no-send,
-- cancelled or failed-before-acceptance touch never gains a successor. Attempt
-- allocation is untouched. Every existing row is a root (0 of 837 rows carry
-- supersedes_communication_id on 2026-09-30), so the relaxed index holds today.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_campaign_touch_root
  ON public.seller_logical_communications (campaign_target_id, touch_number)
  WHERE campaign_target_id IS NOT NULL
    AND touch_number IS NOT NULL
    AND supersedes_communication_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_supersedes_once
  ON public.seller_logical_communications (supersedes_communication_id)
  WHERE supersedes_communication_id IS NOT NULL;

DROP INDEX IF EXISTS public.uq_seller_logical_communications_campaign_touch;

CREATE OR REPLACE FUNCTION public.seller_logical_communication_get_or_create(
  p_logical_key text,
  p_logical_key_version text,
  p_communication_type text,
  p_lineage jsonb DEFAULT '{}'::jsonb,
  p_policy jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_row        public.seller_logical_communications;
  v_existing   public.seller_logical_communications;
  v_tail       public.seller_logical_communications;
  v_conflict   text[] := ARRAY[]::text[];
  v_target     uuid := (NULLIF(p_lineage->>'campaign_target_id',''))::uuid;
  v_touch      integer := (NULLIF(p_lineage->>'touch_number',''))::integer;
  v_supersedes uuid := (NULLIF(p_lineage->>'supersedes_communication_id',''))::uuid;
  v_constraint text;
  v_uuid_re    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  -- ── campaign touch: a NEW key for a touch that already has a communication ──
  -- The key is hash(version, type, target, touch, action_sequence), so a
  -- different key for the same touch under the same version is a different
  -- action of that touch. It may exist only as the successor of a settled,
  -- carrier-failed predecessor.
  IF p_communication_type = 'campaign_touch'
     AND v_target IS NOT NULL AND v_touch IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.seller_logical_communications WHERE logical_key = p_logical_key
     ) THEN

    SELECT c.* INTO v_tail
      FROM public.seller_logical_communications c
     WHERE c.campaign_target_id = v_target
       AND c.touch_number = v_touch
       AND NOT EXISTS (
         SELECT 1 FROM public.seller_logical_communications s
          WHERE s.supersedes_communication_id = c.id
       )
     ORDER BY c.created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      IF v_supersedes IS NOT NULL AND v_supersedes <> v_tail.id THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_supersedes_mismatch',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id);
      END IF;

      IF v_tail.logical_key_version IS DISTINCT FROM p_logical_key_version THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_key_version_mismatch',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id);
      END IF;

      IF v_tail.state = 'delivered' OR v_tail.delivery_possibility = 'delivered' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_delivered',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id);
      END IF;

      IF v_tail.state IN ('suppressed', 'no_send', 'cancelled') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_forbids_successor',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id,
          'state', v_tail.state);
      END IF;

      IF v_tail.state <> 'provider_accepted' OR v_tail.delivery_possibility <> 'provider_accepted' THEN
        -- created/ready/claimed/request-started/ambiguous/reconciling are not
        -- settled; failed-before-acceptance retries inside its own attempts.
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_not_carrier_failed',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id,
          'state', v_tail.state, 'delivery_possibility', v_tail.delivery_possibility);
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.seller_communication_attempts a
         WHERE a.logical_communication_id = v_tail.id AND a.completed_at IS NULL
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_in_flight',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id);
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.seller_communication_attempts a
          LEFT JOIN public.send_queue q
            ON q.id = CASE WHEN a.queue_row_id ~ v_uuid_re THEN a.queue_row_id::uuid END
         WHERE a.logical_communication_id = v_tail.id
           AND (
             a.outcome_class = 'delivered'
             OR a.delivery_possibility = 'delivered'
             OR q.delivered_at IS NOT NULL
             OR q.delivery_confirmed = 'confirmed'
             OR EXISTS (SELECT 1 FROM public.message_events m
                         WHERE m.provider_message_sid = a.provider_message_id
                           AND m.delivery_status = 'delivered')
             OR EXISTS (SELECT 1 FROM public.seller_provider_callback_events e
                         WHERE e.provider_message_sid = a.provider_message_id
                           AND e.provider_status = 'delivered')
           )
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_delivered',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id);
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM public.seller_communication_attempts a
          LEFT JOIN public.send_queue q
            ON q.id = CASE WHEN a.queue_row_id ~ v_uuid_re THEN a.queue_row_id::uuid END
         WHERE a.logical_communication_id = v_tail.id
           AND a.provider_message_id IS NOT NULL
           AND (
             q.delivery_confirmed = 'failed'
             OR EXISTS (SELECT 1 FROM public.message_events m
                         WHERE m.provider_message_sid = a.provider_message_id
                           AND m.delivery_status = 'failed')
             OR EXISTS (SELECT 1 FROM public.seller_provider_callback_events e
                         WHERE e.provider_message_sid = a.provider_message_id
                           AND e.provider_status IN ('failed', 'undelivered'))
           )
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'campaign_touch_predecessor_not_carrier_failed',
          'logical_key', p_logical_key, 'existing_logical_communication_id', v_tail.id,
          'state', v_tail.state, 'delivery_possibility', v_tail.delivery_possibility);
      END IF;

      v_supersedes := v_tail.id;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.seller_logical_communications (
      logical_key, logical_key_version, communication_type,
      thread_key, to_phone_number, property_id, opportunity_id, master_owner_id,
      decision_id, message_event_id, campaign_id, campaign_target_id, touch_number,
      follow_up_id, referral_id, source_event_id,
      seller_offer_id, seller_offer_version, operator_action_id,
      canary_run_id, canary_leg, supersedes_communication_id,
      logical_key_policy_version, retry_policy_version, outcome_policy_version
    ) VALUES (
      p_logical_key, p_logical_key_version, p_communication_type,
      NULLIF(p_lineage->>'thread_key','')          , NULLIF(p_lineage->>'to_phone_number',''),
      NULLIF(p_lineage->>'property_id','')         , (NULLIF(p_lineage->>'opportunity_id',''))::uuid,
      NULLIF(p_lineage->>'master_owner_id',''),
      NULLIF(p_lineage->>'decision_id','')         , NULLIF(p_lineage->>'message_event_id',''),
      (NULLIF(p_lineage->>'campaign_id',''))::uuid , v_target,
      v_touch,
      (NULLIF(p_lineage->>'follow_up_id',''))::uuid, NULLIF(p_lineage->>'referral_id',''),
      NULLIF(p_lineage->>'source_event_id',''),
      NULLIF(p_lineage->>'seller_offer_id','')     , (NULLIF(p_lineage->>'seller_offer_version',''))::integer,
      NULLIF(p_lineage->>'operator_action_id',''),
      NULLIF(p_lineage->>'canary_run_id','')       , NULLIF(p_lineage->>'canary_leg',''),
      v_supersedes,
      NULLIF(p_policy->>'logical_key_policy_version',''),
      NULLIF(p_policy->>'retry_policy_version',''),
      NULLIF(p_policy->>'outcome_policy_version','')
    )
    ON CONFLICT (logical_key) DO UPDATE
       SET last_observed_at  = now(),
           observation_count = public.seller_logical_communications.observation_count + 1
     WHERE public.seller_logical_communications.communication_type   IS NOT DISTINCT FROM EXCLUDED.communication_type
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
  EXCEPTION WHEN unique_violation THEN
    -- A second root for a touch, a second successor of one predecessor, or a
    -- duplicate decision/offer action: a refusal the caller can read, not a
    -- raise that looks like the store is down.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RETURN jsonb_build_object('ok', false, 'reason', 'logical_communication_uniqueness_conflict',
      'constraint', v_constraint, 'logical_key', p_logical_key);
  END;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reused', v_row.observation_count > 1,
      'logical_communication_id', v_row.id,
      'logical_key', v_row.logical_key,
      'state', v_row.state,
      'delivery_possibility', v_row.delivery_possibility,
      'retry_authority', v_row.retry_authority,
      'supersedes_communication_id', v_row.supersedes_communication_id,
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
  IF v_existing.decision_id          IS DISTINCT FROM NULLIF(p_lineage->>'decision_id','')                  THEN v_conflict := array_append(v_conflict, 'decision_id'); END IF;
  IF v_existing.message_event_id     IS DISTINCT FROM NULLIF(p_lineage->>'message_event_id','')             THEN v_conflict := array_append(v_conflict, 'message_event_id'); END IF;
  IF v_existing.campaign_target_id   IS DISTINCT FROM v_target                                              THEN v_conflict := array_append(v_conflict, 'campaign_target_id'); END IF;
  IF v_existing.touch_number         IS DISTINCT FROM v_touch                                               THEN v_conflict := array_append(v_conflict, 'touch_number'); END IF;
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
$function$;

REVOKE ALL ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) TO service_role;

COMMIT;
