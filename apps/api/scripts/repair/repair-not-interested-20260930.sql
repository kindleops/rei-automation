-- ════════════════════════════════════════════════════════════════════════
-- SUPERSEDED (2026-10-08): DO NOT RUN. Replaced by the nurture-reconcile held
-- staging (NURTURE_STAGE_APPLY.sql: held rows, owner release by explicit id
-- list after re-running the gates). This one-off writes queue_status
-- 'scheduled' directly and would bypass the hold. The guard below refuses.
-- ════════════════════════════════════════════════════════════════════════
do $superseded$ begin
  raise exception 'superseded by the nurture-reconcile held staging; do not run';
end $superseded$;

-- SUPERSEDED — DO NOT RUN (was: owner-approved repair 2026-09-30): "A not interested is a 30 day follow up",
-- and the dead-deal reopen. Run AFTER deploy #2+#3 is live. One atomic block.
--
-- 1. Snapshot every row this touches (RLS on, anon/authenticated revoked).
-- 2. Re-arm 10 cancelled nurture_not_interested follow-ups due 2026-10-10..30:
--    contactable, not suppressed, no reply since, no other live follow-up.
-- 3. 34 not-interested deals (suppressed/dead on contactable threads) -> nurture;
--    the one at stage `closed` moves to its thread's stage (offer_interest).
-- 4. Reopen Diane Forsberg (358fc746 / +16122720901) at offer_interest, active.

create table if not exists public._repair_not_interested_20260930 (
  kind text not null,
  row_id text not null,
  before jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public._repair_not_interested_20260930 enable row level security;
revoke all on public._repair_not_interested_20260930 from anon, authenticated;

do $repair$
declare
  v_followups uuid[] := array[
    'be7cb206-55d4-4d1a-9d15-0d64f477fc3e','15f78fc9-a040-470a-ae83-069ecd6934da',
    '86e21bb9-adef-43e6-acaa-76c5d7480142','860a4c0f-15fc-4fbb-bf77-e254927143f9',
    'cf487153-7d42-4d53-83ac-70a891f31597','95390ba1-3887-4ebe-a256-8b228ca5c7b0',
    'bbf0f529-43c1-4225-bd7c-e30506c24c46','599fc258-2bbd-4eb3-9350-9d7118069ed0',
    '4e3f3054-a6dc-46a7-8190-3761a7b5342c','d5000bd3-c8e8-42b0-b7a0-4b487c500ed3'
  ]::uuid[];
  v_rearmed int;
  v_nurtured int;
  v_diane int;
  v_now timestamptz := now();
  v_commit boolean := false; -- DRY RUN unless flipped to true
begin
  -- 1. snapshots
  insert into public._repair_not_interested_20260930 (kind, row_id, before)
  select 'send_queue', sq.id::text, to_jsonb(sq) from public.send_queue sq where sq.id = any(v_followups);

  insert into public._repair_not_interested_20260930 (kind, row_id, before)
  select 'acquisition_opportunities', o.id::text, to_jsonb(o)
  from public.acquisition_opportunities o
  join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
  where (o.latest_intent = 'not_interested' and o.opportunity_status in ('suppressed','dead')
         and coalesce(t.is_suppressed, false) = false and t.contactability_status = 'contactable')
     or o.id = '358fc746-6e07-4d97-88ef-26eae0c03744';

  insert into public._repair_not_interested_20260930 (kind, row_id, before)
  select 'inbox_thread_state', t.thread_key, to_jsonb(t) from public.inbox_thread_state t where t.thread_key = '+16122720901';

  -- 2. re-arm the follow-ups (still guarded: only cancelled, never sent, due ahead, thread contactable, no reply since)
  update public.send_queue sq set
    queue_status = 'scheduled',
    safety_status = 'pending',
    guard_status = null,
    guard_reason = null,
    failed_reason = null,
    updated_at = v_now,
    metadata = (sq.metadata - 'cancelled_by' - 'finalized_at' - 'skip_reason') || jsonb_build_object(
      'rearmed_at', v_now,
      'rearmed_reason', 'owner_rule_not_interested_30_day_follow_up_20260930',
      'rearmed_from', jsonb_build_object(
        'guard_reason', sq.guard_reason,
        'cancelled_by', sq.metadata->>'cancelled_by',
        'skip_reason', sq.metadata->>'skip_reason'))
  where sq.id = any(v_followups)
    and sq.queue_status = 'cancelled'
    and sq.sent_at is null
    and coalesce(sq.scheduled_for_utc, sq.scheduled_for) > v_now
    and exists (select 1 from public.inbox_thread_state t
                where t.thread_key = sq.to_phone_number
                  and coalesce(t.is_suppressed, false) = false
                  and t.contactability_status = 'contactable')
    and not exists (select 1 from public.message_events me
                    where me.direction = 'inbound'
                      and (me.from_phone_number = sq.to_phone_number or me.thread_key = sq.to_phone_number)
                      and me.created_at > sq.created_at + interval '1 minute');
  get diagnostics v_rearmed = row_count;

  -- 3. not-interested deals -> nurture (the closed one takes its thread's stage)
  with targets as (
    select o.id, o.opportunity_status as from_status, o.acquisition_stage as from_stage,
           case when o.acquisition_stage = 'closed' then coalesce(nullif(t.lifecycle_stage, ''), 'ownership_confirmation') else o.acquisition_stage end as to_stage
    from public.acquisition_opportunities o
    join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
    where o.latest_intent = 'not_interested' and o.opportunity_status in ('suppressed','dead')
      and coalesce(t.is_suppressed, false) = false and t.contactability_status = 'contactable'
  ), updated as (
    update public.acquisition_opportunities o set
      opportunity_status = 'nurture',
      acquisition_stage = tg.to_stage,
      stage_entered_at = case when tg.to_stage is distinct from tg.from_stage then v_now else o.stage_entered_at end,
      last_updated_source = 'owner_rule_repair_20260930',
      version = coalesce(o.version, 1) + 1,
      updated_at = v_now
    from targets tg where o.id = tg.id
    returning o.id, tg.from_status, tg.from_stage, tg.to_stage
  ), hist_status as (
    insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
    select u.id, 'opportunity_status_changed', 'opportunity_status', u.from_status, 'nurture',
           'owner_rule_not_interested_is_30_day_follow_up', 'repair_20260930', 'owner_rule_repair_20260930',
           'repair-ni-status:' || u.id, jsonb_build_object('repair', 'not_interested_nurture_20260930')
    from updated u
    returning 1
  ), hist_stage as (
    insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
    select u.id, 'stage_transition', 'acquisition_stage', u.from_stage, u.to_stage,
           'owner_rule_not_interested_is_30_day_follow_up', 'repair_20260930', 'owner_rule_repair_20260930',
           'repair-ni-stage:' || u.id, jsonb_build_object('repair', 'not_interested_nurture_20260930')
    from updated u where u.to_stage is distinct from u.from_stage
    returning 1
  )
  select count(*) into v_nurtured from updated;

  -- 4. Diane: reopen at the conversation's stage (same writes as reopenClosedLostOpportunity)
  update public.acquisition_opportunities o set
    opportunity_status = 'active',
    acquisition_stage = 'offer_interest',
    stage_entered_at = v_now,
    last_updated_source = 'seller_autopilot',
    last_updated_by = 'repair_20260930',
    version = coalesce(o.version, 1) + 1,
    updated_at = v_now
  where o.id = '358fc746-6e07-4d97-88ef-26eae0c03744'
    and o.opportunity_status = 'dead' and o.acquisition_stage = 'closed';
  get diagnostics v_diane = row_count;

  if v_diane = 1 then
    insert into public.acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value, new_value, reason, actor, source, idempotency_key, metadata)
    values
      ('358fc746-6e07-4d97-88ef-26eae0c03744', 'opportunity_status_changed', 'opportunity_status', 'dead', 'active',
       'reengaged_new_campaign_touch', 'repair_20260930', 'seller_autopilot', 'reopen-status:358fc746:26abfd0b',
       jsonb_build_object('reopen', true, 'queue_id', '26abfd0b-5e2e-4006-9222-f95bef2e1818', 'campaign_id', '7f2ba659-16ad-463b-851d-3381c81e2e38', 'touch_number', 1, 'touch_sent_at', '2026-09-30T14:47:07.321Z', 'closed_at', '2026-05-26T22:39:02.939Z', 'intent', 'ownership_confirmed')),
      ('358fc746-6e07-4d97-88ef-26eae0c03744', 'stage_transition', 'acquisition_stage', 'closed', 'offer_interest',
       'reengaged_new_campaign_touch', 'repair_20260930', 'seller_autopilot', 'reopen-stage:358fc746:26abfd0b',
       jsonb_build_object('reopen', true, 'queue_id', '26abfd0b-5e2e-4006-9222-f95bef2e1818', 'campaign_id', '7f2ba659-16ad-463b-851d-3381c81e2e38'));

    update public.inbox_thread_state t set
      lifecycle_stage = 'offer_interest',
      seller_stage = 'offer_interest',
      updated_at = v_now
    where t.thread_key = '+16122720901' and t.lifecycle_stage = 'closed';
  end if;

  raise notice 'repair_20260930 rearmed=% nurtured=% diane_reopened=%', v_rearmed, v_nurtured, v_diane;
  -- Never more than planned. Fewer is legitimate (a seller replied, or the
  -- deployed reopen already handled Diane).
  if v_rearmed > 10 or v_nurtured > 34 or v_diane > 1 then
    raise exception 'repair_20260930 touched more than planned (rearmed=%, nurtured=%, diane=%): rolled back', v_rearmed, v_nurtured, v_diane;
  end if;
  if not v_commit then
    raise exception 'DRY RUN rolled back: rearmed=% nurtured=% diane_reopened=%', v_rearmed, v_nurtured, v_diane;
  end if;
end
$repair$;
