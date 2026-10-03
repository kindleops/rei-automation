-- Campaign launch-claim proof schema: EXACT production definitions (read-only
-- catalog reads of lcppdrmrdfblstpcbgpf on 2026-10-02 — pg_get_functiondef and
-- pg_attribute/pg_constraint), schema only, no production rows. The lifecycle
-- edge set (campaign_status_transitions) is configuration, copied verbatim.
-- For a THROWAWAY database only (PGlite or a disposable Supabase branch).

DROP FUNCTION IF EXISTS public.campaign_launch_finish(uuid, uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.campaign_launch_claim(uuid, text, uuid, integer);
DROP FUNCTION IF EXISTS public.campaign_transition_status(uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.idempotency_begin(text, text, uuid, text, jsonb, integer, text);
DROP FUNCTION IF EXISTS public.idempotency_complete(text, text, text, jsonb, boolean);
DROP FUNCTION IF EXISTS public.idempotency_fail(text, text, text, jsonb, boolean);
DROP FUNCTION IF EXISTS public.idempotency_meta(public.idempotency_ledger);
DROP TABLE IF EXISTS public.proof_effects, public.send_queue, public.campaign_targets, public.campaign_status_transitions, public.campaigns, public.idempotency_ledger CASCADE;

CREATE TABLE public.campaigns (id uuid DEFAULT gen_random_uuid() NOT NULL, name text NOT NULL, description text, status text DEFAULT 'draft'::text, objective text, candidate_source text DEFAULT 'v_feeder_candidates_fast'::text, market text, state text, language_policy text DEFAULT 'auto'::text, agent_persona text, daily_cap integer, total_cap integer, batch_max integer, market_cap integer, per_sender_cap integer, send_interval_seconds integer, contact_window_start text, contact_window_end text, auto_queue_enabled boolean DEFAULT false, auto_send_enabled boolean DEFAULT false, auto_reply_mode text DEFAULT 'disabled'::text, emergency_stop_at timestamp with time zone, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), last_transition_from text, last_transition_reason text, last_transition_at timestamp with time zone, built_at timestamp with time zone, queued_at timestamp with time zone, scheduled_at timestamp with time zone, scheduled_for timestamp with time zone, activating_at timestamp with time zone, activated_at timestamp with time zone, paused_at timestamp with time zone, completed_at timestamp with time zone, failed_at timestamp with time zone, failure_reason text, archived_at timestamp with time zone, activation_attempt_count integer DEFAULT 0 NOT NULL, hydration_cursor jsonb DEFAULT '{}'::jsonb NOT NULL, execution_lock_token uuid, execution_lock_owner text, execution_heartbeat_at timestamp with time zone, queued_count integer DEFAULT 0 NOT NULL, sent_count integer DEFAULT 0 NOT NULL, delivered_count integer DEFAULT 0 NOT NULL, failed_count integer DEFAULT 0 NOT NULL, replied_count integer DEFAULT 0 NOT NULL, positive_count integer DEFAULT 0 NOT NULL, opt_out_count integer DEFAULT 0 NOT NULL, progress_synced_at timestamp with time zone, target_build_version integer DEFAULT 0 NOT NULL, last_activation_idempotency_key text, resumed_at timestamp with time zone,
  PRIMARY KEY (id),
  CONSTRAINT campaigns_auto_reply_mode_check CHECK ((auto_reply_mode = ANY (ARRAY['disabled'::text, 'dry_run'::text, 'live_limited'::text]))),
  CONSTRAINT campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'built'::text, 'queued'::text, 'scheduled'::text, 'activating'::text, 'active'::text, 'paused'::text, 'completed'::text, 'failed'::text, 'archived'::text, 'ready'::text, 'previewed'::text, 'live_limited'::text, 'started'::text, 'live_scheduled'::text]))));

CREATE TABLE public.campaign_status_transitions (from_status text NOT NULL, to_status text NOT NULL, PRIMARY KEY (from_status, to_status));
INSERT INTO public.campaign_status_transitions VALUES ('activating','active'),('activating','failed'),('activating','paused'),('active','archived'),('active','completed'),('active','failed'),('active','paused'),('archived','draft'),('built','activating'),('built','archived'),('built','draft'),('built','queued'),('built','scheduled'),('completed','archived'),('draft','archived'),('draft','built'),('draft','scheduled'),('failed','activating'),('failed','archived'),('failed','built'),('failed','paused'),('failed','scheduled'),('paused','activating'),('paused','active'),('paused','archived'),('paused','completed'),('paused','scheduled'),('queued','archived'),('queued','built'),('queued','draft'),('queued','paused'),('queued','scheduled'),('scheduled','activating'),('scheduled','active'),('scheduled','archived'),('scheduled','draft'),('scheduled','paused'),('scheduled','queued');

CREATE TABLE public.campaign_targets (id uuid DEFAULT gen_random_uuid() NOT NULL, campaign_key text, campaign_name text, market text, asset_type text, strategy text, language text DEFAULT 'auto'::text, source_view_id bigint, source_view_name text, daily_cap integer DEFAULT 50, status text DEFAULT 'draft'::text, created_by_discord_user_id text, approved_by_discord_user_id text, last_scan_summary jsonb DEFAULT '{}'::jsonb, last_scan_at timestamp with time zone, last_launched_at timestamp with time zone, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), campaign_id uuid, master_owner_id text, property_id text, phone_id text, to_phone_number text, owner_name text, property_address text, state text, timezone text, priority_score numeric, identity_status text, routing_status text, suppression_status text, template_status text, target_status text DEFAULT 'ready'::text, block_reason text, prospect_id text, touch_number integer DEFAULT 1 NOT NULL, matched_property_count integer DEFAULT 1 NOT NULL, portfolio_property_ids jsonb DEFAULT '[]'::jsonb NOT NULL, primary_property_id text, recipient_dedup_key text,
  PRIMARY KEY (id), UNIQUE (campaign_key));
CREATE UNIQUE INDEX idx_campaign_targets_recipient_dedup ON public.campaign_targets USING btree (campaign_id, touch_number, to_phone_number) WHERE ((to_phone_number IS NOT NULL) AND (target_status = ANY (ARRAY['ready'::text, 'planned'::text, 'queued'::text, 'scheduled'::text])));

CREATE TABLE public.send_queue (id uuid DEFAULT gen_random_uuid() NOT NULL, queue_key text NOT NULL, queue_status text DEFAULT 'queued'::text NOT NULL, scheduled_for timestamp with time zone DEFAULT now(), send_priority integer DEFAULT 5, is_locked boolean DEFAULT false, locked_at timestamp with time zone, lock_token text, retry_count integer DEFAULT 0, max_retries integer DEFAULT 3, next_retry_at timestamp with time zone, message_body text NOT NULL, phone_number_id uuid, to_phone_number character varying(20) NOT NULL, from_phone_number character varying(20), metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), property_address text, queue_id text, queue_sequence integer, property_type text, owner_type text, scheduled_for_local timestamp with time zone, scheduled_for_utc timestamp with time zone, timezone text, contact_window text, sent_at timestamp with time zone, delivered_at timestamp with time zone, failed_reason text, delivery_confirmed text, master_owner_id text, prospect_id text, property_id text, market_id text, sms_agent_id text, textgrid_number_id text, template_id text, touch_number integer, dnc_check text, current_stage text, message_type text, use_case_template text, message_text text, personalization_tags_used jsonb, character_count integer, provider_message_id text, local_send_date date, local_send_hour integer, paused_reason text, last_guard_checked_at timestamp with time zone, dedupe_key text, seller_first_name text, seller_display_name text, thread_key text, template_source text, priority text DEFAULT 'normal'::text, risk text DEFAULT 'low'::text, sms_eligible boolean DEFAULT true, routing_allowed boolean DEFAULT true, safety_status text DEFAULT 'pending'::text, type text DEFAULT 'outbound'::text, detected_intent text, stage_before text, stage_after text, textgrid_message_id text, selected_template_id text, market text, textgrid_number text, guard_status text, guard_reason text, selected_agent_id text, risk_level text, ai_confidence double precision, estimated_cost double precision, approved_at timestamp with time zone, held_at timestamp with time zone, language text, owner_id text, blocked_reason text, blocked_reasons text, source text, property_address_state text, routing_tier integer, routing_reason text, rendered_message text, source_event_id text, inbound_message_id text, template_selected text, property_address_city text, property_address_zip text, seller_status text, pipeline_stage text, agent_name text, template_key text, campaign_id uuid, campaign_target_id uuid, campaign_send_window_id uuid, phone_id text, logical_communication_id uuid, execution_enrolled_at timestamp with time zone, execution_policy_version text, execution_authorized_by text,
  PRIMARY KEY (id), UNIQUE (queue_key));
CREATE UNIQUE INDEX uq_send_queue_active_dedupe_key ON public.send_queue USING btree (dedupe_key) WHERE ((sent_at IS NULL) AND (queue_status = ANY (ARRAY['queued'::text, 'ready'::text, 'runnable'::text, 'scheduled'::text, 'pending'::text, 'paused'::text, 'paused_after_hours'::text, 'processing'::text, 'approved'::text, 'approval'::text, 'held'::text, 'sending'::text])) AND (dedupe_key IS NOT NULL));

CREATE TABLE public.idempotency_ledger (scope text NOT NULL, key text NOT NULL, claim_token uuid, status text DEFAULT 'processing'::text NOT NULL, summary text, payload_hash text, attempts integer DEFAULT 1 NOT NULL, started_at timestamp with time zone DEFAULT now() NOT NULL, completed_at timestamp with time zone, failed_at timestamp with time zone, last_error text, skip_content_fields boolean DEFAULT false NOT NULL, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, retain_until timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_ledger_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text]))));

-- proof bookkeeping: every materialisation / queue-fill ATTEMPT the flow makes (not only rows that landed)
CREATE TABLE public.proof_effects (id bigserial PRIMARY KEY, campaign_id uuid NOT NULL, effect text NOT NULL, actor text, at timestamptz DEFAULT clock_timestamp());

-- ── functions: pg_get_functiondef output from production, verbatim ─────────
CREATE OR REPLACE FUNCTION public.idempotency_meta(p_row idempotency_ledger)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT COALESCE(p_row.metadata, '{}'::jsonb) || jsonb_build_object(
    'scope', p_row.scope,
    'key', p_row.key,
    'summary', p_row.summary,
    'status', p_row.status,
    'payload_hash', p_row.payload_hash,
    'attempts', p_row.attempts,
    'started_at', p_row.started_at,
    'completed_at', p_row.completed_at,
    'failed_at', p_row.failed_at,
    'last_error', p_row.last_error,
    'claim_token', p_row.claim_token::text
  );
$function$;

CREATE OR REPLACE FUNCTION public.idempotency_begin(p_scope text, p_key text, p_claim_token uuid, p_summary text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_lease_ms integer DEFAULT 600000, p_payload_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_lease_ms integer;
  v_token uuid;
  v_row public.idempotency_ledger%ROWTYPE;
  v_inserted_scope text;
  v_attempt integer;
  v_stale boolean;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));

  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'duplicate', false,
      'reason', 'missing_idempotency_scope_or_key');
  END IF;

  v_lease_ms := LEAST(GREATEST(COALESCE(p_lease_ms, 600000), 1), 86400000);
  v_token := COALESCE(p_claim_token, gen_random_uuid());

  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.idempotency_ledger (
      scope, key, claim_token, status, summary, payload_hash,
      attempts, started_at, metadata
    ) VALUES (
      v_scope, v_key, v_token, 'processing',
      NULLIF(trim(COALESCE(p_summary, '')), ''),
      NULLIF(trim(COALESCE(p_payload_hash, '')), ''),
      1, v_now, COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (scope, key) DO NOTHING
    RETURNING scope INTO v_inserted_scope;

    IF v_inserted_scope IS NOT NULL THEN
      SELECT * INTO v_row FROM public.idempotency_ledger
       WHERE scope = v_scope AND key = v_key;
      RETURN jsonb_build_object(
        'ok', true, 'duplicate', false, 'reason', 'event_claimed',
        'scope', v_scope, 'key', v_key, 'claim_token', v_token::text,
        'meta', public.idempotency_meta(v_row));
    END IF;

    -- Concurrent claimants serialize here until the winner commits.
    SELECT * INTO v_row FROM public.idempotency_ledger
     WHERE scope = v_scope AND key = v_key
     FOR UPDATE;

    IF FOUND THEN
      EXIT;
    END IF;
    -- Row purged between conflict and lock: retry the insert.
  END LOOP;

  IF v_row.key IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'duplicate', false, 'reason', 'idempotency_row_unstable');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true, 'reason', 'duplicate_event_ignored',
      'scope', v_scope, 'key', v_key,
      'meta', public.idempotency_meta(v_row));
  END IF;

  -- isProcessingLeaseStale(): stale when started_at is unusable, or when
  -- now() - started_at exceeds the caller-supplied lease.
  v_stale := (v_row.started_at IS NULL)
             OR (v_now - v_row.started_at > make_interval(secs => v_lease_ms / 1000.0));

  IF v_row.status = 'processing' AND NOT v_stale THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true, 'reason', 'event_already_processing',
      'scope', v_scope, 'key', v_key,
      'meta', public.idempotency_meta(v_row));
  END IF;

  -- Reclaimable: failed, or processing past its lease. Rotating claim_token
  -- is what fences the previous holder out.
  UPDATE public.idempotency_ledger
     SET claim_token = v_token,
         status = 'processing',
         summary = NULLIF(trim(COALESCE(p_summary, '')), ''),
         payload_hash = COALESCE(
           NULLIF(trim(COALESCE(p_payload_hash, '')), ''), payload_hash),
         attempts = v_row.attempts + 1,
         started_at = v_now,
         completed_at = NULL,
         failed_at = NULL,
         last_error = NULL,
         metadata = COALESCE(v_row.metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'reason', 'stale_or_failed_event_reclaimed',
    'scope', v_scope, 'key', v_key, 'claim_token', v_token::text,
    'previous_status', 'reclaimed',
    'meta', public.idempotency_meta(v_row));
END;
$function$;

CREATE OR REPLACE FUNCTION public.idempotency_complete(p_scope text, p_key text, p_summary text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_skip_content_fields boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_row public.idempotency_ledger%ROWTYPE;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));
  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_record_item_id');
  END IF;

  UPDATE public.idempotency_ledger
     SET status = 'completed',
         completed_at = v_now,
         summary = NULLIF(trim(COALESCE(p_summary, '')), ''),
         claim_token = NULL,
         skip_content_fields = COALESCE(p_skip_content_fields, false),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- The JS version wrote unconditionally, creating the row if absent.
    INSERT INTO public.idempotency_ledger (
      scope, key, status, summary, completed_at,
      skip_content_fields, metadata, started_at
    ) VALUES (
      v_scope, v_key, 'completed',
      NULLIF(trim(COALESCE(p_summary, '')), ''), v_now,
      COALESCE(p_skip_content_fields, false),
      COALESCE(p_metadata, '{}'::jsonb), v_now
    )
    ON CONFLICT (scope, key) DO UPDATE
      SET status = 'completed', completed_at = v_now, claim_token = NULL,
          updated_at = v_now
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'reason', 'idempotency_record_completed',
    'scope', v_scope, 'key', v_key,
    'meta', public.idempotency_meta(v_row));
END;
$function$;

CREATE OR REPLACE FUNCTION public.idempotency_fail(p_scope text, p_key text, p_error text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_skip_content_fields boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_scope text;
  v_key text;
  v_now timestamptz := now();
  v_error text;
  v_row public.idempotency_ledger%ROWTYPE;
BEGIN
  v_scope := trim(COALESCE(p_scope, ''));
  v_key := trim(COALESCE(p_key, ''));
  IF v_scope = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_record_item_id');
  END IF;

  v_error := COALESCE(NULLIF(trim(COALESCE(p_error, '')), ''), 'unknown_error');

  UPDATE public.idempotency_ledger
     SET status = 'failed',
         failed_at = v_now,
         last_error = v_error,
         claim_token = NULL,
         skip_content_fields = COALESCE(p_skip_content_fields, false),
         metadata = COALESCE(metadata, '{}'::jsonb)
                    || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = v_now
   WHERE scope = v_scope AND key = v_key
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    INSERT INTO public.idempotency_ledger (
      scope, key, status, failed_at, last_error,
      skip_content_fields, metadata, started_at
    ) VALUES (
      v_scope, v_key, 'failed', v_now, v_error,
      COALESCE(p_skip_content_fields, false),
      COALESCE(p_metadata, '{}'::jsonb), v_now
    )
    ON CONFLICT (scope, key) DO UPDATE
      SET status = 'failed', failed_at = v_now, last_error = v_error,
          claim_token = NULL, updated_at = v_now
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'reason', 'idempotency_record_failed',
    'scope', v_scope, 'key', v_key,
    'error_message', v_error,
    'meta', public.idempotency_meta(v_row));
END;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_transition_status(p_campaign_id uuid, p_to_status text, p_reason text DEFAULT NULL::text, p_scheduled_for timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS SETOF campaigns
 LANGUAGE plpgsql
AS $function$
declare
  v_from      text;
  v_from_norm text;
  v_to        text := lower(trim(p_to_status));
  v_allowed   boolean;
  v_now       timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtext('campaign_transition:' || p_campaign_id::text));

  select status into v_from from public.campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign_not_found:%', p_campaign_id;
  end if;

  if v_from is null or trim(v_from) = '' then
    raise exception 'campaign_status_missing:%', p_campaign_id;
  end if;

  v_from_norm := case lower(trim(v_from))
    when 'ready'          then 'built'
    when 'previewed'      then 'built'
    when 'live_limited'   then 'active'
    when 'started'        then 'activating'
    when 'live_scheduled' then 'scheduled'
    else lower(trim(v_from))
  end;

  if v_from_norm = v_to then
    update public.campaigns set
      status = v_to,
      updated_at = v_now,
      scheduled_for = case
        when v_to = 'scheduled' and p_scheduled_for is not null then p_scheduled_for
        else scheduled_for
      end
    where id = p_campaign_id;
    return query select * from public.campaigns where id = p_campaign_id;
    return;
  end if;

  select exists (
    select 1 from public.campaign_status_transitions
    where from_status = v_from_norm and to_status = v_to
  ) into v_allowed;

  if not v_allowed then
    raise exception 'illegal_campaign_transition:% -> %', v_from_norm, v_to;
  end if;

  update public.campaigns set
    status                 = v_to,
    last_transition_from   = v_from_norm,
    last_transition_reason = p_reason,
    last_transition_at     = v_now,
    updated_at             = v_now,
    built_at      = case when v_to = 'built'      then v_now else built_at end,
    queued_at     = case when v_to = 'queued'     then v_now else queued_at end,
    scheduled_at  = case when v_to = 'scheduled'  then v_now else scheduled_at end,
    scheduled_for = case when v_to = 'scheduled'  then coalesce(p_scheduled_for, scheduled_for, v_now) else scheduled_for end,
    activating_at = case when v_to = 'activating' then v_now else activating_at end,
    activation_attempt_count = case when v_to = 'activating'
                                    then activation_attempt_count + 1
                                    else activation_attempt_count end,
    activated_at  = case when v_to = 'active'     then coalesce(activated_at, v_now) else activated_at end,
    resumed_at    = case when v_to = 'active' and v_from_norm = 'paused' then v_now else resumed_at end,
    paused_at     = case when v_to = 'paused'     then v_now else paused_at end,
    completed_at  = case when v_to = 'completed'  then v_now else completed_at end,
    failed_at     = case when v_to = 'failed'     then v_now else failed_at end,
    failure_reason = case when v_to = 'failed'    then p_reason else failure_reason end,
    archived_at   = case when v_to = 'archived'   then v_now else archived_at end
  where id = p_campaign_id;

  return query select * from public.campaigns where id = p_campaign_id;
end;
$function$;
