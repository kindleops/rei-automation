-- ════════════════════════════════════════════════════════════════════════════
-- RC 7.1 · P7 — clear the gap-recovery sweep's `human_review` PLACEHOLDERS
-- ════════════════════════════════════════════════════════════════════════════
--
-- The stale-thread sweep (recover-seller-execution-gaps.js, fixed on branch in
-- 8f2201f2) stamped next_action = 'human_review' with no reason and no date
-- onto every stale thread whose deal had no next action, and onto that deal.
-- This file PROVES which existing flags are such placeholders and clears ONLY
-- those. Genuine review work is listed separately and never touched.
--
-- A flag is a PLACEHOLDER only when EVERY one of these holds:
--   P1  its latest human_review stamp was written by the sweep
--       (threads: universal_lead_state_events source_view
--        'seller_execution_gap_recovery', reason 'stale_active_without_next_action';
--        deals: acquisition_opportunity_history source
--        'seller_execution_gap_recovery', actor 'gap_recovery_sweep')
--   P2  no seller reply (message_events inbound) on the thread AFTER the stamp
--   P3  no real hold/SLA in the decision ledger for the thread or deal, ever
--       (seller_automation_decisions.lineage.exception_sla_deadline, or
--        coverage_state 'human_exception_with_owned_workflow')
--   P4  no operator action on the thread or deal AFTER the stamp
--       (lead-state events with change_source manual*/operator_id;
--        opportunity history from source 'operator' / owner corrections;
--        a manual Inbox send)
--   P5  no autopilot review hold was ever recorded for it
--       (a human_review written by seller_inbound_orchestrator / seller_autopilot,
--        e.g. S2_AMBIGUOUS_HOLD_REVIEW, HOLD_HOSTILE_LEGAL_REVIEW)
-- Anything failing any test is GENUINE (or not provably a placeholder) and is
-- reported with the failing tests; it is never cleared.
--   P6  (safety, beyond the proof) the seller's latest message is not an
--       unanswered inbound. A proven placeholder whose seller is still waiting
--       is listed for operator triage and NOT cleared by PART 2.
--
-- PART 1 is read-only. PART 2 (APPLY) refuses to run unless the session flag
--   SET rc71.p7_apply = 'clear-sweep-placeholders';
-- is set in the same transaction. Do NOT run PART 2 without owner approval.
-- Clearing sets next_action back to NULL (the value before the stamp — the
-- sweep only ever stamped rows whose next action was absent), leaves
-- next_action_at untouched (the sweep wrote NULL there), and writes one audit
-- row per change (universal_lead_state_events / acquisition_opportunity_history)
-- so the cleanup is itself traceable and reversible.
-- ════════════════════════════════════════════════════════════════════════════

-- ── PART 1 · PREVIEW (read-only) ────────────────────────────────────────────
-- Run as-is. Returns one row per flagged thread/deal with its verdict.

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
-- 1a · counts
select subject_kind,
       count(*) as flagged,
       count(*) filter (where is_placeholder) as placeholder,
       count(*) filter (where clear_ok) as clear_ok,
       count(*) filter (where is_placeholder and not clear_ok) as placeholder_but_seller_waiting,
       count(*) filter (where not is_placeholder) as genuine_or_unproven,
       count(*) filter (where not coalesce(p1_sweep_stamp, false)) as fails_p1_not_sweep_stamp,
       count(*) filter (where p1_sweep_stamp and not p2_no_reply_after) as fails_p2_reply_after,
       count(*) filter (where p1_sweep_stamp and not p3_no_real_hold) as fails_p3_real_hold,
       count(*) filter (where p1_sweep_stamp and not p4_no_operator_action) as fails_p4_operator_action,
       count(*) filter (where p1_sweep_stamp and not p5_no_autopilot_hold) as fails_p5_autopilot_hold
from verdicts
group by subject_kind
order by subject_kind;
-- 1b · the genuine / unproven list: replace the final SELECT above with
--   select * from verdicts where not is_placeholder order by subject_kind, stamped_at;
-- 1c · placeholders where the seller is waiting (triage, never auto-cleared):
--   select * from verdicts where is_placeholder and not clear_ok order by subject_kind, stamped_at;

-- ── PART 2 · APPLY ─────────────────────────────────────────────────────────
-- Lives in 20261001_p7_review_placeholder_cleanup_APPLY.sql (same classifier,
-- refuses to run without the session flag). Owner approval required.
