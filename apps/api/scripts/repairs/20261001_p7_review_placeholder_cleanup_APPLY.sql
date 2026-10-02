-- ════════════════════════════════════════════════════════════════════════════
-- RC 7.1 · P7 — APPLY: clear PROVEN sweep placeholders (clear_ok rows only)
-- ════════════════════════════════════════════════════════════════════════════
-- DO NOT RUN without explicit owner approval. Run the preview
-- (20261001_p7_review_placeholder_cleanup.sql, PART 1) first and compare.
--
-- Refuses unless, in the SAME transaction:
--   set local rc71.p7_apply = 'clear-sweep-placeholders';
--
-- Clears next_action = 'human_review' -> NULL only on rows the classifier marks
-- clear_ok (P1–P6), conditional on the row still carrying 'human_review'
-- (idempotent; a row that changed since the preview is skipped). One audit row
-- per change. next_action_at is not touched (the sweep wrote NULL there).
-- Ends in ROLLBACK by default: change the last line to COMMIT only after the
-- printed counts match the preview.
-- ════════════════════════════════════════════════════════════════════════════
begin;
-- set local rc71.p7_apply = 'clear-sweep-placeholders';   -- the apply flag

do $$
begin
  if coalesce(current_setting('rc71.p7_apply', true), '') <> 'clear-sweep-placeholders' then
    raise exception 'P7 apply refused: set local rc71.p7_apply = ''clear-sweep-placeholders'' in this transaction (owner approval required)';
  end if;
end $$;

create temp table p7_clear on commit drop as
with
real_holds as (
  select distinct right(regexp_replace(conversation_id, '\D', '', 'g'), 10) as k10, opportunity_id
  from seller_automation_decisions
  where lineage->>'exception_sla_deadline' is not null
     or lineage->>'coverage_state' = 'human_exception_with_owned_workflow'
),
last_reply as (
  select right(regexp_replace(coalesce(thread_key, from_phone_number), '\D', '', 'g'), 10) as k10, max(created_at) as at
  from message_events where direction = 'inbound' group by 1
),
last_message as (
  select distinct on (k10) k10, direction, at from (
    select right(regexp_replace(coalesce(thread_key, case when direction = 'inbound' then from_phone_number else to_phone_number end), '\D', '', 'g'), 10) as k10,
           direction, created_at as at
    from message_events
  ) x order by k10, at desc
),
last_manual_send as (
  select right(regexp_replace(coalesce(thread_key, to_phone_number), '\D', '', 'g'), 10) as k10, max(created_at) as at
  from send_queue
  where metadata->>'source' in ('manual_inbox', 'inbox') or message_type = 'manual_reply'
  group by 1
),
last_operator_state as (
  select thread_key, max(created_at) as at
  from universal_lead_state_events
  where change_source like 'manual%' or operator_id is not null
  group by 1
),
autopilot_thread_holds as (
  select distinct thread_key from universal_lead_state_events
  where field_name = 'next_action' and new_value = 'human_review'
    and source_view in ('seller_inbound_orchestrator', 'seller_autopilot')
),
threads as (
  select t.thread_key, right(regexp_replace(t.thread_key, '\D', '', 'g'), 10) as k10
  from inbox_thread_state t
  where t.next_action = 'human_review' and coalesce(t.is_archived, false) = false
),
thread_stamp as (
  select distinct on (e.thread_key) e.thread_key, e.source_view, e.reason, e.created_at as stamped_at
  from universal_lead_state_events e
  join threads t on t.thread_key = e.thread_key
  where e.field_name = 'next_action' and e.new_value = 'human_review'
  order by e.thread_key, e.created_at desc
),
thread_verdict as (
  select
    'thread'::text as subject_kind,
    t.thread_key as subject_id,
    t.thread_key,
    s.stamped_at,
    s.source_view as stamp_source,
    s.reason as stamp_reason,
    (s.source_view = 'seller_execution_gap_recovery' and s.reason = 'stale_active_without_next_action') as p1_sweep_stamp,
    (r.at is null or r.at <= s.stamped_at) as p2_no_reply_after,
    not exists (select 1 from real_holds h where h.k10 = t.k10) as p3_no_real_hold,
    ((op.at is null or op.at <= s.stamped_at) and (ms.at is null or ms.at <= s.stamped_at)) as p4_no_operator_action,
    (ah.thread_key is null) as p5_no_autopilot_hold,
    (lm.direction is distinct from 'inbound') as p6_no_unanswered_seller_message
  from threads t
  left join last_message lm on lm.k10 = t.k10
  left join thread_stamp s on s.thread_key = t.thread_key
  left join last_reply r on r.k10 = t.k10
  left join last_manual_send ms on ms.k10 = t.k10
  left join last_operator_state op on op.thread_key = t.thread_key
  left join autopilot_thread_holds ah on ah.thread_key = t.thread_key
),
deals as (
  select o.id, o.primary_thread_key, right(regexp_replace(coalesce(o.primary_thread_key, ''), '\D', '', 'g'), 10) as k10
  from acquisition_opportunities o
  where o.next_action = 'human_review'
),
deal_stamp as (
  select distinct on (h.opportunity_id) h.opportunity_id, h.source, h.actor, h.reason, h.created_at as stamped_at
  from acquisition_opportunity_history h
  join deals d on d.id = h.opportunity_id
  where h.field_name = 'next_action' and h.new_value = 'human_review'
  order by h.opportunity_id, h.created_at desc
),
deal_operator as (
  select opportunity_id, max(created_at) as at from acquisition_opportunity_history
  where source = 'operator' or source like 'rc71_%' or actor in ('operator', 'certification', 'cert')
  group by 1
),
deal_autopilot_holds as (
  select distinct opportunity_id from acquisition_opportunity_history
  where field_name = 'next_action' and new_value = 'human_review' and source = 'seller_autopilot'
),
deal_verdict as (
  select
    'deal'::text as subject_kind,
    d.id::text as subject_id,
    d.primary_thread_key as thread_key,
    s.stamped_at,
    s.source as stamp_source,
    coalesce(s.reason, s.actor) as stamp_reason,
    (s.source = 'seller_execution_gap_recovery' and s.actor = 'gap_recovery_sweep') as p1_sweep_stamp,
    (d.k10 = '' or r.at is null or r.at <= s.stamped_at) as p2_no_reply_after,
    not exists (select 1 from real_holds h where (d.k10 <> '' and h.k10 = d.k10) or h.opportunity_id = d.id) as p3_no_real_hold,
    ((dop.at is null or dop.at <= s.stamped_at) and (op.at is null or op.at <= s.stamped_at)
      and (ms.at is null or ms.at <= s.stamped_at)) as p4_no_operator_action,
    (dah.opportunity_id is null and ah.thread_key is null) as p5_no_autopilot_hold,
    (d.k10 = '' or lm.direction is distinct from 'inbound') as p6_no_unanswered_seller_message
  from deals d
  left join last_message lm on d.k10 <> '' and lm.k10 = d.k10
  left join deal_stamp s on s.opportunity_id = d.id
  left join last_reply r on d.k10 <> '' and r.k10 = d.k10
  left join last_manual_send ms on d.k10 <> '' and ms.k10 = d.k10
  left join last_operator_state op on op.thread_key = d.primary_thread_key
  left join deal_operator dop on dop.opportunity_id = d.id
  left join deal_autopilot_holds dah on dah.opportunity_id = d.id
  left join autopilot_thread_holds ah on ah.thread_key = d.primary_thread_key
),
verdicts as (
  select v.*,
    -- proven sweep placeholder (P1–P5, the owner's tests)
    coalesce(p1_sweep_stamp, false) and coalesce(p2_no_reply_after, false) and coalesce(p3_no_real_hold, false)
      and coalesce(p4_no_operator_action, false) and coalesce(p5_no_autopilot_hold, false) as is_placeholder,
    -- and safe to clear: nothing is waiting on us (P6). A placeholder whose
    -- seller's last message is unanswered is listed for triage, not cleared.
    coalesce(p1_sweep_stamp, false) and coalesce(p2_no_reply_after, false) and coalesce(p3_no_real_hold, false)
      and coalesce(p4_no_operator_action, false) and coalesce(p5_no_autopilot_hold, false)
      and coalesce(p6_no_unanswered_seller_message, false) as clear_ok
  from (select * from thread_verdict union all select * from deal_verdict) v
)
select subject_kind, subject_id, thread_key, stamped_at from verdicts where clear_ok;

with cleared as (
  update inbox_thread_state t set next_action = null, updated_at = now()
  from p7_clear p
  where p.subject_kind = 'thread' and t.thread_key = p.thread_key and t.next_action = 'human_review'
  returning t.thread_key, t.property_id
)
insert into universal_lead_state_events (thread_key, property_id, field_name, previous_value, new_value,
  operator_id, source_view, reason, change_source, executed_next_action, metadata, created_at)
select thread_key, property_id, 'next_action', 'human_review', null, null, 'rc71_p7_cleanup',
  'sweep_placeholder_cleared', 'system', false, jsonb_build_object('rc', '7.1', 'owner_approved', true), now()
from cleared;

with cleared as (
  update acquisition_opportunities o set next_action = null, updated_at = now()
  from p7_clear p
  where p.subject_kind = 'deal' and o.id::text = p.subject_id and o.next_action = 'human_review'
  returning o.id
)
insert into acquisition_opportunity_history (opportunity_id, event_type, field_name, previous_value,
  new_value, reason, actor, source, metadata, created_at)
select id, 'next_action_changed', 'next_action', 'human_review', null, 'sweep_placeholder_cleared',
  'owner-approved:rc-7.1', 'rc71_p7_cleanup', jsonb_build_object('rc', '7.1'), now()
from cleared;

-- verify: these must equal the preview's clear_ok counts
select 'thread' kind, count(*) from universal_lead_state_events where source_view = 'rc71_p7_cleanup' and created_at > now() - interval '5 minutes'
union all
select 'deal', count(*) from acquisition_opportunity_history where source = 'rc71_p7_cleanup' and created_at > now() - interval '5 minutes';

rollback;   -- change to COMMIT only after the counts match the preview
