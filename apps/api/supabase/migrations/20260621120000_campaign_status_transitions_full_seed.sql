-- Seed canonical campaign_status_transitions from the JS state machine.
-- Production was missing edges (only archived -> draft), causing illegal_campaign_transition.

DELETE FROM public.campaign_status_transitions;

INSERT INTO public.campaign_status_transitions (from_status, to_status) VALUES
  ('draft', 'built'),
  ('draft', 'scheduled'),
  ('draft', 'archived'),
  ('built', 'queued'),
  ('built', 'scheduled'),
  ('built', 'activating'),
  ('built', 'draft'),
  ('built', 'archived'),
  ('queued', 'scheduled'),
  ('queued', 'built'),
  ('queued', 'draft'),
  ('queued', 'paused'),
  ('queued', 'archived'),
  ('scheduled', 'activating'),
  ('scheduled', 'active'),
  ('scheduled', 'queued'),
  ('scheduled', 'draft'),
  ('scheduled', 'paused'),
  ('scheduled', 'archived'),
  ('activating', 'active'),
  ('activating', 'failed'),
  ('activating', 'paused'),
  ('active', 'paused'),
  ('active', 'completed'),
  ('active', 'failed'),
  ('active', 'archived'),
  ('paused', 'active'),
  ('paused', 'activating'),
  ('paused', 'scheduled'),
  ('paused', 'completed'),
  ('paused', 'archived'),
  ('failed', 'built'),
  ('failed', 'scheduled'),
  ('failed', 'paused'),
  ('failed', 'activating'),
  ('failed', 'archived'),
  ('completed', 'archived'),
  ('archived', 'draft');

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
$$;