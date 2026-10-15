-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Baseline of the LIVE production send_queue surface that the
-- send_queue migrations under test replace, captured read-only (BEGIN READ ONLY, catalog
-- queries) on 2026-10-15:
--   * public.send_queue — every column, type, NOT NULL and default exactly as in production
--     (no FKs to campaign tables: those tables are not part of these tests), the two CHECKs;
--   * public.send_queue_lifecycle_guard_events (the guard triggers write to it);
--   * public.message_events — the columns the asking-price guard reads;
--   * the four live BEFORE triggers on send_queue, function bodies verbatim:
--       guard_send_queue_execution_mode, guard_send_queue_stale_expiration,
--       trg_block_repeat_asking_price (the 2026-10-13 owner directive), zz_send_queue_touch_updated_at.
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
create extension if not exists pgcrypto;

create table if not exists public.send_queue (
  id uuid not null default gen_random_uuid(),
  queue_key text not null,
  queue_status text not null default 'queued'::text,
  scheduled_for timestamp with time zone default now(),
  send_priority integer default 5,
  is_locked boolean default false,
  locked_at timestamp with time zone,
  lock_token text,
  retry_count integer default 0,
  max_retries integer default 3,
  next_retry_at timestamp with time zone,
  message_body text not null,
  phone_number_id uuid,
  to_phone_number character varying(20) not null,
  from_phone_number character varying(20),
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  property_address text,
  queue_id text,
  queue_sequence integer,
  property_type text,
  owner_type text,
  scheduled_for_local timestamp with time zone,
  scheduled_for_utc timestamp with time zone,
  timezone text,
  contact_window text,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  failed_reason text,
  delivery_confirmed text,
  master_owner_id text,
  prospect_id text,
  property_id text,
  market_id text,
  sms_agent_id text,
  textgrid_number_id text,
  template_id text,
  touch_number integer,
  dnc_check text,
  current_stage text,
  message_type text,
  use_case_template text,
  message_text text,
  personalization_tags_used jsonb,
  character_count integer,
  provider_message_id text,
  local_send_date date,
  local_send_hour integer,
  paused_reason text,
  last_guard_checked_at timestamp with time zone,
  dedupe_key text,
  seller_first_name text,
  seller_display_name text,
  thread_key text,
  template_source text,
  priority text default 'normal'::text,
  risk text default 'low'::text,
  sms_eligible boolean default true,
  routing_allowed boolean default true,
  safety_status text default 'pending'::text,
  type text default 'outbound'::text,
  detected_intent text,
  stage_before text,
  stage_after text,
  textgrid_message_id text,
  selected_template_id text,
  market text,
  textgrid_number text,
  guard_status text,
  guard_reason text,
  selected_agent_id text,
  risk_level text,
  ai_confidence double precision,
  estimated_cost double precision,
  approved_at timestamp with time zone,
  held_at timestamp with time zone,
  language text,
  owner_id text,
  blocked_reason text,
  blocked_reasons text,
  source text,
  property_address_state text,
  routing_tier integer,
  routing_reason text,
  rendered_message text,
  source_event_id text,
  inbound_message_id text,
  template_selected text,
  property_address_city text,
  property_address_zip text,
  seller_status text,
  pipeline_stage text,
  agent_name text,
  template_key text,
  campaign_id uuid,
  campaign_target_id uuid,
  campaign_send_window_id uuid,
  phone_id text,
  logical_communication_id uuid,
  execution_enrolled_at timestamp with time zone,
  execution_policy_version text,
  execution_authorized_by text,
  constraint send_queue_queue_key_key unique (queue_key),
  constraint send_queue_no_confirm_live_no_send_conflict check ((not ((lower(coalesce((metadata ->> 'confirm_live'::text), ''::text)) = 'true'::text) and (lower(coalesce((metadata ->> 'no_send'::text), ''::text)) = 'true'::text)))) not valid,
  constraint send_queue_no_proof_confirm_live_conflict check ((not ((lower(coalesce((metadata ->> 'proof_hydration'::text), ''::text)) = 'true'::text) and (lower(coalesce((metadata ->> 'confirm_live'::text), ''::text)) = 'true'::text)))) not valid
);
alter table public.send_queue add primary key (id);
create index if not exists idx_send_queue_thread_key on public.send_queue (thread_key);

create table if not exists public.send_queue_lifecycle_guard_events (
  id uuid not null default gen_random_uuid() primary key,
  queue_row_id uuid not null,
  event_type text not null,
  previous_queue_status text,
  attempted_queue_status text,
  scheduled_for timestamp with time zone,
  blocked_at timestamp with time zone not null default now(),
  caller_route text,
  deploy_sha text,
  audit_payload jsonb not null default '{}'::jsonb
);

create table if not exists public.message_events (
  id uuid not null default gen_random_uuid() primary key,
  message_event_key text,
  direction text,
  event_type text,
  message_body text,
  thread_key text,
  queue_id uuid,
  metadata jsonb,
  created_at timestamp with time zone default now(),
  sent_at timestamp with time zone,
  received_at timestamp with time zone,
  delivered_at timestamp with time zone,
  event_timestamp timestamp with time zone
);
create index if not exists idx_message_events_thread_event_ts on public.message_events (thread_key, event_timestamp);

CREATE OR REPLACE FUNCTION public.guard_send_queue_execution_mode()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.metadata->>'no_send')::boolean IS TRUE
       AND (NEW.metadata->>'confirm_live')::boolean IS TRUE
       AND COALESCE(NEW.metadata->>'launch_mode', '') <> 'proof_hydration_no_send' THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        COALESCE(NEW.id, gen_random_uuid()),
        'CONTRADICTORY_EXECUTION_MODE_BLOCKED',
        NULL,
        NEW.queue_status,
        NEW.scheduled_for,
        jsonb_build_object('reason', 'proof_and_live_flags')
      );
      RAISE EXCEPTION 'send_queue_contradictory_execution_mode';
    END IF;

    IF (NEW.metadata->>'execution_mode') IN ('immediate_live', 'scheduled_live')
       AND (
         (NEW.metadata->>'no_send')::boolean IS TRUE
         OR (NEW.metadata->>'proof_hydration')::boolean IS TRUE
       ) THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        COALESCE(NEW.id, gen_random_uuid()),
        'LIVE_EXECUTION_MODE_WITH_PROOF_FLAGS',
        NULL,
        NEW.queue_status,
        NEW.scheduled_for,
        jsonb_build_object('execution_mode', NEW.metadata->>'execution_mode')
      );
      RAISE EXCEPTION 'send_queue_live_mode_with_proof_flags';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.queue_status IN ('sent', 'delivered')
       AND (OLD.sent_at IS NOT NULL OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL)
       AND NEW.queue_status IN ('queued', 'scheduled', 'pending', 'processing', 'sending') THEN
      INSERT INTO public.send_queue_lifecycle_guard_events (
        queue_row_id, event_type, previous_queue_status, attempted_queue_status,
        scheduled_for, audit_payload
      ) VALUES (
        OLD.id,
        'SENT_ROW_REVERT_BLOCKED',
        OLD.queue_status,
        NEW.queue_status,
        OLD.scheduled_for,
        jsonb_build_object('reason', 'sent_evidence_immutable')
      );
      NEW.queue_status := OLD.queue_status;
      NEW.sent_at := OLD.sent_at;
      NEW.provider_message_id := OLD.provider_message_id;
      NEW.textgrid_message_id := OLD.textgrid_message_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_send_queue_stale_expiration()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_blocked boolean := false;
  v_reason text := null;
BEGIN
  IF NEW.queue_status = 'expired'
     AND NEW.failed_reason = 'stale_runnable_row_expired'
     AND (
       OLD.queue_status IN ('scheduled', 'queued')
       OR (OLD.scheduled_for IS NOT NULL AND OLD.scheduled_for > NOW())
       OR OLD.sent_at IS NOT NULL
       OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL
       OR NULLIF(trim(OLD.textgrid_message_id), '') IS NOT NULL
       OR (OLD.is_locked IS TRUE AND OLD.queue_status = 'processing')
     ) THEN
    v_blocked := true;
    IF OLD.queue_status IN ('scheduled', 'queued') THEN
      v_reason := 'scheduled_or_queued_containment';
    ELSIF OLD.scheduled_for IS NOT NULL AND OLD.scheduled_for > NOW() THEN
      v_reason := 'future_scheduled_for';
    ELSIF OLD.sent_at IS NOT NULL
       OR NULLIF(trim(OLD.provider_message_id), '') IS NOT NULL
       OR NULLIF(trim(OLD.textgrid_message_id), '') IS NOT NULL THEN
      v_reason := 'send_evidence_present';
    ELSE
      v_reason := 'active_processing_lease';
    END IF;

    INSERT INTO public.send_queue_lifecycle_guard_events (
      queue_row_id,
      event_type,
      previous_queue_status,
      attempted_queue_status,
      scheduled_for,
      caller_route,
      deploy_sha,
      audit_payload
    ) VALUES (
      OLD.id,
      'FUTURE_ROW_EXPIRATION_BLOCKED',
      OLD.queue_status,
      NEW.queue_status,
      OLD.scheduled_for,
      COALESCE(NEW.metadata->>'lifecycle_caller_route', NULL),
      COALESCE(NEW.metadata->>'lifecycle_deploy_sha', NULL),
      jsonb_build_object(
        'block_reason', v_reason,
        'now', NOW(),
        'old_scheduled_for', OLD.scheduled_for,
        'old_scheduled_for_utc', OLD.scheduled_for_utc,
        'old_failed_reason', OLD.failed_reason
      )
    );

    NEW.queue_status := OLD.queue_status;
    NEW.failed_reason := OLD.failed_reason;
    NEW.is_locked := OLD.is_locked;
    NEW.lock_token := OLD.lock_token;
    NEW.locked_at := OLD.locked_at;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_queue_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Compare everything except updated_at itself. to_jsonb() comparison keeps
    -- this column-list agnostic, so adding a send_queue column cannot silently
    -- create a new class of unnoticed churn.
    IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      NEW.updated_at := OLD.updated_at;
      RETURN NEW;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.block_repeat_asking_price()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- Owner directive 2026-10-13: never ask a seller for their asking price twice.
BEGIN
  IF NEW.queue_status IN ('scheduled','queued','pending','approval')
     AND NEW.thread_key IS NOT NULL
     AND coalesce(NEW.use_case_template,'') ~* 'asking_price'
     AND EXISTS (SELECT 1 FROM public.send_queue p
                 WHERE p.thread_key = NEW.thread_key AND p.id <> NEW.id
                   AND p.queue_status IN ('sent','delivered','processing')
                   AND coalesce(p.use_case_template,'') ~* 'asking_price')
  THEN
    NEW.queue_status := 'cancelled';
    NEW.paused_reason := 'blocked_repeat_asking_price';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER guard_send_queue_execution_mode BEFORE INSERT OR UPDATE ON public.send_queue FOR EACH ROW EXECUTE FUNCTION guard_send_queue_execution_mode();
CREATE TRIGGER guard_send_queue_stale_expiration BEFORE UPDATE ON public.send_queue FOR EACH ROW EXECUTE FUNCTION guard_send_queue_stale_expiration();
CREATE TRIGGER trg_block_repeat_asking_price BEFORE INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc ON public.send_queue FOR EACH ROW EXECUTE FUNCTION block_repeat_asking_price();
CREATE TRIGGER zz_send_queue_touch_updated_at BEFORE INSERT OR UPDATE ON public.send_queue FOR EACH ROW EXECUTE FUNCTION send_queue_touch_updated_at();

-- production grants on the table (relacl, read-only capture)
revoke all on public.send_queue from public, anon, authenticated;
grant select, maintain on public.send_queue to authenticated;
grant all on public.send_queue to service_role;
