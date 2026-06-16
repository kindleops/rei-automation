-- Phase 2A campaign lifecycle — deployed directly to prod via MCP on 2026-06-16,
-- recorded here for provenance (repo migration history is squash-pending; this
-- file is purely additive and idempotent so it is safe to replay).
--
-- 1. Additive lifecycle timestamp/audit columns on campaigns.
-- 2. Widen campaigns_status_check to the full canonical lifecycle.
-- 3. campaign_transition_status(): advisory-locked, edge-validated transition fn.

alter table public.campaigns
  add column if not exists last_transition_from   text,
  add column if not exists last_transition_reason text,
  add column if not exists last_transition_at     timestamptz,
  add column if not exists built_at                timestamptz,
  add column if not exists queued_at               timestamptz,
  add column if not exists scheduled_at            timestamptz,
  add column if not exists scheduled_for           timestamptz,
  add column if not exists activating_at           timestamptz,
  add column if not exists activated_at            timestamptz,
  add column if not exists paused_at               timestamptz,
  add column if not exists completed_at            timestamptz,
  add column if not exists failed_at               timestamptz,
  add column if not exists failure_reason          text,
  add column if not exists archived_at             timestamptz;

-- Canonical: draft, built, queued, scheduled, activating, active, paused, completed, failed, archived
-- Legacy retained for existing rows + alias folding: ready, previewed, live_limited, started, live_scheduled
alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check
  check (status = any (array[
    'draft','built','queued','scheduled','activating','active','paused','completed','failed','archived',
    'ready','previewed','live_limited','started','live_scheduled'
  ]::text[]));

create or replace function public.campaign_transition_status(
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
  -- Serialize concurrent transitions for this campaign.
  perform pg_advisory_xact_lock(hashtext('campaign_transition:' || p_campaign_id::text));

  select status into v_from from public.campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'campaign_not_found:%', p_campaign_id;
  end if;

  -- Fold legacy/readiness markers onto the canonical lifecycle.
  v_from_norm := case lower(coalesce(trim(v_from), ''))
    when 'ready'          then 'built'
    when 'previewed'      then 'built'
    when 'live_limited'   then 'active'
    when 'started'        then 'activating'
    when 'live_scheduled' then 'scheduled'
    when ''               then 'draft'
    else lower(trim(v_from))
  end;

  -- Idempotent no-op (canonicalize a stored alias in place).
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
    when 'archived'   then false
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
    activated_at  = case when v_to = 'active'     then v_now else activated_at end,
    paused_at     = case when v_to = 'paused'     then v_now else paused_at end,
    completed_at  = case when v_to = 'completed'  then v_now else completed_at end,
    failed_at     = case when v_to = 'failed'     then v_now else failed_at end,
    failure_reason = case when v_to = 'failed'    then p_reason else failure_reason end,
    archived_at   = case when v_to = 'archived'   then v_now else archived_at end
  where id = p_campaign_id;

  return query select * from public.campaigns where id = p_campaign_id;
end;
$$;
