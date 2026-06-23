-- Phase 1 — Repair missing production campaign progress / execution columns.
--
-- Production may have 20260616210000 (lifecycle) without 20260603233000/234000
-- (progress engine). This migration is purely additive + idempotent: safe to
-- replay on any environment.

-- ---------------------------------------------------------------------------
-- 1. Missing execution + progress columns on campaigns
-- ---------------------------------------------------------------------------
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS activation_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hydration_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS execution_lock_token uuid,
  ADD COLUMN IF NOT EXISTS execution_lock_owner text,
  ADD COLUMN IF NOT EXISTS execution_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS queued_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivered_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS positive_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opt_out_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS target_build_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_activation_idempotency_key text,
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

-- Bounded attribution index for progress recompute (idempotent).
CREATE INDEX IF NOT EXISTS idx_send_queue_campaign_id
  ON public.send_queue (campaign_id)
  WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Progress engine (from 20260603234000_campaign_progress_engine.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_recompute_progress(p_campaign_id uuid)
RETURNS public.campaigns
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.campaigns;
  v_queued    integer := 0;
  v_sent      integer := 0;
  v_delivered integer := 0;
  v_failed    integer := 0;
  v_replied   integer := 0;
  v_positive  integer := 0;
  v_opt_out   integer := 0;
BEGIN
  SELECT
    count(*) FILTER (WHERE queue_status IN
      ('queued','scheduled','pending','ready','approved','processing','sending')),
    count(*) FILTER (WHERE sent_at IS NOT NULL OR queue_status IN ('sent','delivered')),
    count(*) FILTER (WHERE delivered_at IS NOT NULL OR queue_status = 'delivered'),
    count(*) FILTER (WHERE queue_status IN ('failed','failed_transport')
                        OR failed_reason IS NOT NULL)
  INTO v_queued, v_sent, v_delivered, v_failed
  FROM public.send_queue
  WHERE campaign_id = p_campaign_id;

  SELECT
    count(*) FILTER (WHERE me.direction = 'inbound'),
    count(*) FILTER (WHERE me.direction = 'inbound' AND me.detected_intent IN
      ('ownership_confirmed','asking_price_provided','asks_offer',
       'seller_interested','needs_call','need_time')),
    count(*) FILTER (WHERE me.direction = 'inbound'
       AND (me.is_opt_out IS TRUE OR me.detected_intent = 'opt_out'))
  INTO v_replied, v_positive, v_opt_out
  FROM public.message_events me
  WHERE me.queue_id IN (
    SELECT id FROM public.send_queue WHERE campaign_id = p_campaign_id
  );

  UPDATE public.campaigns SET
    queued_count       = coalesce(v_queued, 0),
    sent_count         = coalesce(v_sent, 0),
    delivered_count    = coalesce(v_delivered, 0),
    failed_count       = coalesce(v_failed, 0),
    replied_count      = coalesce(v_replied, 0),
    positive_count     = coalesce(v_positive, 0),
    opt_out_count      = coalesce(v_opt_out, 0),
    progress_synced_at = now(),
    updated_at         = now()
  WHERE id = p_campaign_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE VIEW public.campaign_runtime_summary AS
SELECT
  c.id AS campaign_id,
  c.name,
  c.status,
  c.scheduled_for,
  c.activated_at,
  c.paused_at,
  c.completed_at,
  c.failed_at,
  c.failure_reason,
  c.last_transition_at,
  c.activation_attempt_count,
  c.execution_lock_token IS NOT NULL AS hydration_active,
  c.execution_heartbeat_at,
  c.hydration_cursor,
  c.progress_synced_at,
  c.queued_count,
  c.sent_count,
  c.delivered_count,
  c.failed_count,
  c.replied_count,
  c.positive_count,
  c.opt_out_count,
  (c.queued_count + c.sent_count) AS total_planned,
  CASE WHEN c.sent_count > 0
       THEN round((c.delivered_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS delivery_rate_pct,
  CASE WHEN c.sent_count > 0
       THEN round((c.replied_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS reply_rate_pct,
  CASE WHEN c.replied_count > 0
       THEN round((c.positive_count::numeric / c.replied_count) * 100, 1) ELSE 0 END AS positive_rate_pct,
  CASE WHEN c.sent_count > 0
       THEN round((c.opt_out_count::numeric / c.sent_count) * 100, 1) ELSE 0 END AS opt_out_rate_pct,
  CASE WHEN (c.queued_count + c.sent_count) > 0
       THEN round((c.sent_count::numeric / (c.queued_count + c.sent_count)) * 100, 1) ELSE 0 END AS hydration_progress_pct
FROM public.campaigns c;

-- ---------------------------------------------------------------------------
-- 3. Lifecycle repair — allow archived -> draft restore + resumed_at stamp
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_status_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO public.campaign_status_transitions (from_status, to_status) VALUES
  ('archived', 'draft')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.campaign_transition_status(
  p_campaign_id   uuid,
  p_to_status     text,
  p_reason        text        default null,
  p_scheduled_for timestamptz default null
) returns setof public.campaigns
language plpgsql
as $$
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

  v_from_norm := case lower(coalesce(trim(v_from), ''))
    when 'ready'          then 'built'
    when 'previewed'      then 'built'
    when 'live_limited'   then 'active'
    when 'started'        then 'activating'
    when 'live_scheduled' then 'scheduled'
    when ''               then 'draft'
    else lower(trim(v_from))
  end;

  if v_from_norm = v_to then
    update public.campaigns set status = v_to, updated_at = v_now where id = p_campaign_id;
    return query select * from public.campaigns where id = p_campaign_id;
    return;
  end if;

  v_allowed := case v_from_norm
    when 'draft'      then v_to in ('built','scheduled','archived')
    when 'built'      then v_to in ('queued','scheduled','draft','archived')
    when 'queued'     then v_to in ('scheduled','built','draft','paused','archived')
    when 'scheduled'  then v_to in ('activating','active','queued','draft','paused','archived')
    when 'activating' then v_to in ('active','failed','paused')
    when 'active'     then v_to in ('paused','completed','failed')
    when 'paused'     then v_to in ('active','scheduled','completed','archived')
    when 'failed'     then v_to in ('paused','activating','archived')
    when 'completed'  then v_to in ('archived')
    when 'archived'   then v_to in ('draft')
    else false
  end;

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
$$;