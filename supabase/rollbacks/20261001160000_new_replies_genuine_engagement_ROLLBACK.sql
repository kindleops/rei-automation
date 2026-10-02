-- ROLLBACK for supabase/migrations/20261001160000_new_replies_genuine_engagement.sql
-- (NOT a forward migration; it lives outside supabase/migrations on purpose.)
--
-- Restores the pre-7.2 definition of public.v_inbox_thread_state_buckets as
-- production ran it on 2026-10-02 (pg_get_viewdef md5
-- 63943bb52c861f8fd5713a7a2e185dc5, 125 columns). CREATE OR REPLACE VIEW cannot
-- drop the four columns 20261001160000 appends (f_last_intent, f_reply_resolved,
-- f_nonengagement_latest, f_closed_disposition), and two views depend on this
-- one (v_inbox_bucket_counts, v_inbox_zero_counts). So the columns stay as inert
-- stubs instead of a DROP ... CASCADE that would take the counts views with it.
--
-- Equivalence was proven read-only on production before this file was
-- committed: the SELECT below, run as a plain query, matches the live (pre-7.2)
-- view on every row for every f_* / in_* column (0 differences). After running
-- it, re-check with supabase/tests/new_replies_view_rollback_test.sql.
--
-- Run as one transaction (SQL editor / psql) only to undo 20261001160000.

begin;

create or replace view public.v_inbox_thread_state_buckets as
with pending_send as (
  select distinct q.thread_key
    from send_queue q
   where q.thread_key is not null
     and lower(q.queue_status) = any (array['scheduled','queued','pending','approved','ready','processing','sending'])
), f as (
  select s.*,
    coalesce(s.is_archived, false) as f_archived,
    s.snoozed_until is not null and s.snoozed_until > now() as f_snoozed,
    ps.thread_key is not null as f_pending_schedule,
    lower(coalesce(s.disposition, '')) as f_disposition,
    lower(coalesce(s.latest_direction, '')) as f_direction,
    lower(coalesce(s.latest_delivery_status, '')) as f_delivery,
    s.manual_override = true or coalesce(s.confidence, 1::numeric) < 0.5 as f_needs_review,
    coalesce((s.metadata ->> 'terminal_no_contact')::boolean, false)
      or coalesce((s.metadata ->> 'do_not_contact')::boolean, false) as f_metadata_no_contact,
    coalesce(s.last_outbound_at, s.latest_message_at) as f_out_at,
    lower(coalesce(s.inbox_bucket,
      case
        when s.is_suppressed = true then 'suppressed'
        when lower(coalesce(s.disposition, '')) = any (array['wrong_number','wrong_person']) then 'dead'
        when lower(coalesce(s.disposition, '')) = 'not_interested' then 'follow_up'
        when s.latest_direction = 'inbound' then 'new_replies'
        else 'cold'
      end)) as f_bucket
  from inbox_thread_state s
  left join pending_send ps on ps.thread_key = s.thread_key
), g as (
  select f.*,
    coalesce(f.is_suppressed, false) or f.f_bucket = 'suppressed' as f_suppressed_contact,
    f.f_disposition = any (array['wrong_number','wrong_person']) as f_wrong_number_contact,
    f.f_delivery = '' or f.f_delivery = any (array['sent','delivered','accepted','queued','pending','sending','submitted','delivery_unknown']) as f_delivery_ok,
    f.f_out_at is not null and (f.last_inbound_at is null or f.last_inbound_at < f.f_out_at) as f_outbound_last_no_reply
  from f
), h as (
  select g.*,
    (g.f_bucket = any (array['dead','suppressed'])) or g.f_wrong_number_contact or g.f_suppressed_contact as f_terminal
  from g
), i as (
  select h.*,
    not h.f_archived and not h.f_snoozed and not h.f_pending_schedule as f_available,
    not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule as f_actionable,
    (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'outbound' and h.f_outbound_last_no_reply
      and h.f_out_at >= (now() - '24:00:00'::interval)
      and h.f_delivery_ok and not h.f_metadata_no_contact) as in_waiting
  from h
)
select
    id,
    thread_key,
    seller_phone,
    canonical_e164,
    our_number,
    master_owner_id,
    prospect_id,
    property_id,
    market,
    stage,
    status,
    priority,
    is_archived,
    is_read,
    is_pinned,
    is_urgent,
    last_read_at,
    archived_at,
    metadata,
    created_at,
    updated_at,
    is_starred,
    is_hidden,
    is_suppressed,
    hidden_at,
    suppressed_at,
    last_intent,
    next_action,
    automation_state,
    latest_reply_template_id,
    message_count,
    inbound_count,
    outbound_count,
    latest_message_event_id,
    latest_message_body,
    latest_message_at,
    latest_direction,
    latest_event_type,
    latest_delivery_status,
    last_inbound_at,
    last_outbound_at,
    pending_queue_count,
    failed_queue_count,
    blocked_queue_count,
    next_scheduled_for,
    is_hot_lead,
    follow_up_at,
    agent_id,
    persona_id,
    automation_status,
    inbox_bucket,
    automation_lane,
    disposition,
    next_action_at,
    reason_codes,
    confidence,
    classifier_version,
    classified_at,
    classification_run_id,
    previous_inbox_bucket,
    previous_automation_lane,
    manual_override,
    manual_override_at,
    manual_override_by,
    lifecycle_stage,
    operational_status,
    lead_temperature,
    temperature,
    seller_stage,
    conversation_status,
    contactability_status,
    stage_source,
    status_source,
    temperature_source,
    disposition_source,
    contactability_source,
    manual_stage_lock,
    manual_temperature_lock,
    snoozed_until,
    snooze_reason,
    archive_scope,
    archive_reason,
    paused_reason,
    updated_by,
    legacy_stage,
    legacy_status,
    temperature_confidence,
    temperature_reason,
    seller_display_name,
    source_application,
    source_channel,
    source_submission_id,
    source_metadata,
    f_archived,
    f_snoozed,
    f_pending_schedule,
    f_disposition,
    f_direction,
    f_delivery,
    f_needs_review,
    f_metadata_no_contact,
    f_out_at,
    f_bucket,
    f_suppressed_contact,
    f_wrong_number_contact,
    f_delivery_ok,
    f_outbound_last_no_reply,
    f_terminal,
    f_available,
    f_actionable,
    in_waiting,
    f_archived as in_archived,
    not f_archived and f_snoozed as in_snoozed,
    not f_archived and f_pending_schedule as in_scheduled,
    f_actionable and f_bucket = 'priority' as in_priority,
    f_actionable
      and (f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
      and not f_needs_review
      and f_direction = 'inbound'
      and coalesce(last_inbound_at, latest_message_at) is not null
      and (last_outbound_at is null or coalesce(last_inbound_at, latest_message_at) >= last_outbound_at) as in_new_replies,
    f_available and (f_bucket = 'needs_review' or f_needs_review) as in_needs_review,
    f_available and f_bucket = 'follow_up' as in_follow_up,
    f_actionable and f_bucket = 'cold' and not in_waiting as in_cold,
    not f_archived and (f_bucket = 'dead' or f_wrong_number_contact) as in_dead,
    not f_archived and (f_bucket = 'suppressed' or f_suppressed_contact) as in_suppressed,
    not f_archived and not in_waiting as in_all_messages,
    not f_archived as in_all,
    not f_archived and property_id is null as in_unlinked,
    (f_actionable and f_bucket = 'priority')
      or (f_available and (f_bucket = 'needs_review' or f_needs_review))
      or (f_available and f_bucket = 'follow_up')
      or (f_actionable
        and (f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
        and not f_needs_review
        and f_direction = 'inbound'
        and coalesce(last_inbound_at, latest_message_at) is not null
        and (last_outbound_at is null or coalesce(last_inbound_at, latest_message_at) >= last_outbound_at)) as in_active,
    -- The four 7.2 columns cannot be dropped by CREATE OR REPLACE VIEW, and
    -- v_inbox_bucket_counts / v_inbox_zero_counts depend on this view: they
    -- stay as INERT stubs (same names, types, order), so the rollback needs no
    -- DROP ... CASCADE. Every flag is the pre-7.2 definition again.
    ''::text as f_last_intent,
    false as f_reply_resolved,
    false as f_nonengagement_latest,
    false as f_closed_disposition
from i;

commit;
