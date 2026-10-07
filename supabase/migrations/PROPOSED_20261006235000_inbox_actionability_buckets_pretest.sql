-- PRETEST for PROPOSED_20261006235000_inbox_actionability_buckets.sql
-- Read-only. Runs the PROPOSED view body inline (no DDL) next to the live view
-- and reports before/after per bucket, the intents that leave New Replies /
-- Priority, and the plan. Run in one session before the apply.
set statement_timeout = '30s';
set default_transaction_read_only = on;

-- P1. Before/after per bucket (expect: priority falls, new_replies has 0 rows
--     whose latest reply is non-actionable, no thread in two of NR/PR/FU).
with proposed as (
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
        -- 7.2: sold / unqualified close the thread for this property
        when lower(coalesce(s.disposition, '')) = any (array['sold','unqualified']) then 'dead'
        when lower(coalesce(s.disposition, '')) = 'not_interested' then 'follow_up'
        when s.latest_direction = 'inbound' then 'new_replies'
        else 'cold'
      end)) as f_bucket,
    -- 7.2: what the latest inbound was (empty unless the latest message is inbound)
    case when lower(coalesce(s.latest_direction, '')) = 'inbound'
         then lower(coalesce(s.last_intent, '')) else '' end as f_last_intent,
    -- 8.5: the thread's latest inbound intent whatever was sent after it
    -- (last_intent is written on inbound only)
    lower(coalesce(s.last_intent, '')) as f_thread_intent
  from inbox_thread_state s
  left join pending_send ps on ps.thread_key = s.thread_key
), g as (
  select f.*,
    coalesce(f.is_suppressed, false) or f.f_bucket = 'suppressed' as f_suppressed_contact,
    f.f_disposition = any (array['wrong_number','wrong_person']) as f_wrong_number_contact,
    f.f_delivery = '' or f.f_delivery = any (array['sent','delivered','accepted','queued','pending','sending','submitted','delivery_unknown']) as f_delivery_ok,
    f.f_out_at is not null and (f.last_inbound_at is null or f.last_inbound_at < f.f_out_at) as f_outbound_last_no_reply,
    f.f_disposition = any (array['sold','unqualified']) as f_closed_disposition,
    -- 8.5: every NON-ACTIONABLE latest reply (reply-actionability.js NON_ACTIONABLE_REPLY_INTENTS)
    f.f_last_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_reply_resolved,
    f.f_thread_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_thread_resolved,
    -- 8.5: PRIORITY_REPLY_INTENTS / POSITIVE_REPLY_INTENTS
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request']) as f_priority_intent,
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request','ownership_confirmed','latent_interest','condition_disclosed']) as f_positive_intent,
    -- 8.5: a parked nurture re-opens on a later understood, actionable reply
    (f.f_last_intent <> all (array['', 'unclear']) and f.f_last_intent <> all (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only'])) as f_reopening_reply,
    f.f_direction = 'inbound' and coalesce(f.last_inbound_at, f.latest_message_at) is not null
      and (f.last_outbound_at is null or coalesce(f.last_inbound_at, f.latest_message_at) >= f.last_outbound_at) as f_unanswered,
    f.f_last_intent = any (array['reaction_only','acknowledgement']) as f_nonengagement_latest
  from f
), h as (
  select g.*,
    (g.f_bucket = any (array['dead','suppressed'])) or g.f_wrong_number_contact or g.f_suppressed_contact
      or g.f_closed_disposition as f_terminal
  from g
), i as (
  select h.*,
    not h.f_archived and not h.f_snoozed and not h.f_pending_schedule as f_available,
    not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule as f_actionable,
    (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'outbound' and h.f_outbound_last_no_reply
      and h.f_out_at >= (now() - '24:00:00'::interval)
      and h.f_delivery_ok and not h.f_metadata_no_contact)
    -- 7.2: a reaction / acknowledgement / auto-reply that left nothing open is
    -- still "waiting on the seller" inside the reply window of our last send.
    or (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'inbound' and h.f_nonengagement_latest and h.f_bucket = 'cold'
      and h.last_outbound_at is not null
      and h.last_outbound_at >= (now() - '24:00:00'::interval)
      and not h.f_metadata_no_contact) as in_waiting
  from h
), j as (
  select i.*,
    -- 8.5 PRIORITY: high-value actionable only. The stored bucket must say
    -- priority AND the latest inbound intent must be priority-grade.
    i.f_actionable and i.f_bucket = 'priority' and i.f_priority_intent and not i.f_thread_resolved as p_priority
  from i
), k as (
  select j.*,
    -- 8.5 NEW REPLIES: an unanswered, actionable (or undetermined) reply.
    j.f_actionable and not j.p_priority and not j.f_needs_review and not j.f_reply_resolved and j.f_unanswered
      and (
        (j.f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
        -- a stored 'priority' whose latest reply is not priority-grade
        or j.f_bucket = 'priority'
        -- a parked nurture re-opened by a later actionable reply
        or (j.f_bucket = 'follow_up' and j.f_reopening_reply)
      ) as p_new_replies,
    -- 8.5 temperature: warm/hot only from a plausible positive latest intent;
    -- a manual temperature is the operator's call.
    case
      when j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual'
        then lower(coalesce(j.lead_temperature, j.temperature))
      when lower(coalesce(j.lead_temperature, j.temperature, '')) = any (array['hot','warm'])
        and not (j.f_positive_intent and not j.f_terminal)
        then 'cold'
      else lower(coalesce(j.lead_temperature, j.temperature))
    end as p_lead_temperature,
    not j.f_terminal and (
      ((j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot')
      or (not (j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and j.f_priority_intent
        and (lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot' or j.is_hot_lead = true))
    ) as p_hot_lead
  from j
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
    p_priority as in_priority,
    p_new_replies as in_new_replies,
    f_available and (f_bucket = 'needs_review' or f_needs_review) as in_needs_review,
    f_available and f_bucket = 'follow_up' and not p_new_replies as in_follow_up,
    f_actionable and f_bucket = 'cold' and not in_waiting as in_cold,
    not f_archived and (f_bucket = 'dead' or f_wrong_number_contact or f_closed_disposition) as in_dead,
    not f_archived and (f_bucket = 'suppressed' or f_suppressed_contact) as in_suppressed,
    not f_archived and not in_waiting as in_all_messages,
    not f_archived as in_all,
    not f_archived and property_id is null as in_unlinked,
    p_priority
      or (f_available and (f_bucket = 'needs_review' or f_needs_review))
      or (f_available and f_bucket = 'follow_up')
      or p_new_replies as in_active,
    -- appended (7.2)
    f_last_intent,
    f_reply_resolved,
    f_nonengagement_latest,
    f_closed_disposition,
    -- appended (8.5)
    f_thread_intent,
    f_thread_resolved,
    f_priority_intent,
    f_positive_intent,
    f_reopening_reply,
    p_lead_temperature as f_lead_temperature,
    p_hot_lead as f_hot_lead
from k
)
select 'priority' as bucket,
       (select count(*) from public.v_inbox_thread_state_buckets where in_priority) as before,
       (select count(*) from proposed where in_priority) as after
union all select 'new_replies',
       (select count(*) from public.v_inbox_thread_state_buckets where in_new_replies),
       (select count(*) from proposed where in_new_replies)
union all select 'follow_up',
       (select count(*) from public.v_inbox_thread_state_buckets where in_follow_up),
       (select count(*) from proposed where in_follow_up)
union all select 'needs_review',
       (select count(*) from public.v_inbox_thread_state_buckets where in_needs_review),
       (select count(*) from proposed where in_needs_review)
union all select 'active',
       (select count(*) from public.v_inbox_thread_state_buckets where in_active),
       (select count(*) from proposed where in_active)
union all select 'all_messages',
       (select count(*) from public.v_inbox_thread_state_buckets where in_all_messages),
       (select count(*) from proposed where in_all_messages)
union all select 'hot_lead_recorded',
       (select count(*) from public.v_inbox_thread_state_buckets where not f_archived and (is_hot_lead or lower(coalesce(lead_temperature, temperature, '')) = 'hot')),
       (select count(*) from proposed where not f_archived and f_hot_lead)
union all select 'warm_or_hot_shown',
       (select count(*) from public.v_inbox_thread_state_buckets where not f_archived and lower(coalesce(lead_temperature, temperature, '')) in ('hot','warm')),
       (select count(*) from proposed where not f_archived and f_lead_temperature in ('hot','warm'))
union all select 'must_be_zero_nr_and_followup', null, (select count(*) from proposed where in_new_replies and in_follow_up)
union all select 'must_be_zero_nr_nonactionable', null, (select count(*) from proposed where in_new_replies and f_reply_resolved)
union all select 'must_be_zero_pr_not_priority_grade', null, (select count(*) from proposed where in_priority and not f_priority_intent)
union all select 'must_be_zero_hot_nonactionable', null, (select count(*) from proposed where f_hot_lead and (f_thread_resolved or f_terminal));

-- P2. Which threads move, by latest intent.
with proposed as (
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
        -- 7.2: sold / unqualified close the thread for this property
        when lower(coalesce(s.disposition, '')) = any (array['sold','unqualified']) then 'dead'
        when lower(coalesce(s.disposition, '')) = 'not_interested' then 'follow_up'
        when s.latest_direction = 'inbound' then 'new_replies'
        else 'cold'
      end)) as f_bucket,
    -- 7.2: what the latest inbound was (empty unless the latest message is inbound)
    case when lower(coalesce(s.latest_direction, '')) = 'inbound'
         then lower(coalesce(s.last_intent, '')) else '' end as f_last_intent,
    -- 8.5: the thread's latest inbound intent whatever was sent after it
    -- (last_intent is written on inbound only)
    lower(coalesce(s.last_intent, '')) as f_thread_intent
  from inbox_thread_state s
  left join pending_send ps on ps.thread_key = s.thread_key
), g as (
  select f.*,
    coalesce(f.is_suppressed, false) or f.f_bucket = 'suppressed' as f_suppressed_contact,
    f.f_disposition = any (array['wrong_number','wrong_person']) as f_wrong_number_contact,
    f.f_delivery = '' or f.f_delivery = any (array['sent','delivered','accepted','queued','pending','sending','submitted','delivery_unknown']) as f_delivery_ok,
    f.f_out_at is not null and (f.last_inbound_at is null or f.last_inbound_at < f.f_out_at) as f_outbound_last_no_reply,
    f.f_disposition = any (array['sold','unqualified']) as f_closed_disposition,
    -- 8.5: every NON-ACTIONABLE latest reply (reply-actionability.js NON_ACTIONABLE_REPLY_INTENTS)
    f.f_last_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_reply_resolved,
    f.f_thread_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_thread_resolved,
    -- 8.5: PRIORITY_REPLY_INTENTS / POSITIVE_REPLY_INTENTS
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request']) as f_priority_intent,
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request','ownership_confirmed','latent_interest','condition_disclosed']) as f_positive_intent,
    -- 8.5: a parked nurture re-opens on a later understood, actionable reply
    (f.f_last_intent <> all (array['', 'unclear']) and f.f_last_intent <> all (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only'])) as f_reopening_reply,
    f.f_direction = 'inbound' and coalesce(f.last_inbound_at, f.latest_message_at) is not null
      and (f.last_outbound_at is null or coalesce(f.last_inbound_at, f.latest_message_at) >= f.last_outbound_at) as f_unanswered,
    f.f_last_intent = any (array['reaction_only','acknowledgement']) as f_nonengagement_latest
  from f
), h as (
  select g.*,
    (g.f_bucket = any (array['dead','suppressed'])) or g.f_wrong_number_contact or g.f_suppressed_contact
      or g.f_closed_disposition as f_terminal
  from g
), i as (
  select h.*,
    not h.f_archived and not h.f_snoozed and not h.f_pending_schedule as f_available,
    not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule as f_actionable,
    (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'outbound' and h.f_outbound_last_no_reply
      and h.f_out_at >= (now() - '24:00:00'::interval)
      and h.f_delivery_ok and not h.f_metadata_no_contact)
    -- 7.2: a reaction / acknowledgement / auto-reply that left nothing open is
    -- still "waiting on the seller" inside the reply window of our last send.
    or (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'inbound' and h.f_nonengagement_latest and h.f_bucket = 'cold'
      and h.last_outbound_at is not null
      and h.last_outbound_at >= (now() - '24:00:00'::interval)
      and not h.f_metadata_no_contact) as in_waiting
  from h
), j as (
  select i.*,
    -- 8.5 PRIORITY: high-value actionable only. The stored bucket must say
    -- priority AND the latest inbound intent must be priority-grade.
    i.f_actionable and i.f_bucket = 'priority' and i.f_priority_intent and not i.f_thread_resolved as p_priority
  from i
), k as (
  select j.*,
    -- 8.5 NEW REPLIES: an unanswered, actionable (or undetermined) reply.
    j.f_actionable and not j.p_priority and not j.f_needs_review and not j.f_reply_resolved and j.f_unanswered
      and (
        (j.f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
        -- a stored 'priority' whose latest reply is not priority-grade
        or j.f_bucket = 'priority'
        -- a parked nurture re-opened by a later actionable reply
        or (j.f_bucket = 'follow_up' and j.f_reopening_reply)
      ) as p_new_replies,
    -- 8.5 temperature: warm/hot only from a plausible positive latest intent;
    -- a manual temperature is the operator's call.
    case
      when j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual'
        then lower(coalesce(j.lead_temperature, j.temperature))
      when lower(coalesce(j.lead_temperature, j.temperature, '')) = any (array['hot','warm'])
        and not (j.f_positive_intent and not j.f_terminal)
        then 'cold'
      else lower(coalesce(j.lead_temperature, j.temperature))
    end as p_lead_temperature,
    not j.f_terminal and (
      ((j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot')
      or (not (j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and j.f_priority_intent
        and (lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot' or j.is_hot_lead = true))
    ) as p_hot_lead
  from j
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
    p_priority as in_priority,
    p_new_replies as in_new_replies,
    f_available and (f_bucket = 'needs_review' or f_needs_review) as in_needs_review,
    f_available and f_bucket = 'follow_up' and not p_new_replies as in_follow_up,
    f_actionable and f_bucket = 'cold' and not in_waiting as in_cold,
    not f_archived and (f_bucket = 'dead' or f_wrong_number_contact or f_closed_disposition) as in_dead,
    not f_archived and (f_bucket = 'suppressed' or f_suppressed_contact) as in_suppressed,
    not f_archived and not in_waiting as in_all_messages,
    not f_archived as in_all,
    not f_archived and property_id is null as in_unlinked,
    p_priority
      or (f_available and (f_bucket = 'needs_review' or f_needs_review))
      or (f_available and f_bucket = 'follow_up')
      or p_new_replies as in_active,
    -- appended (7.2)
    f_last_intent,
    f_reply_resolved,
    f_nonengagement_latest,
    f_closed_disposition,
    -- appended (8.5)
    f_thread_intent,
    f_thread_resolved,
    f_priority_intent,
    f_positive_intent,
    f_reopening_reply,
    p_lead_temperature as f_lead_temperature,
    p_hot_lead as f_hot_lead
from k
)
select coalesce(nullif(p.f_thread_intent, ''), '<none>') as latest_intent,
       case when o.in_priority then 'priority' when o.in_new_replies then 'new_replies' when o.in_follow_up then 'follow_up' else 'other' end as before,
       case when p.in_priority then 'priority' when p.in_new_replies then 'new_replies' when p.in_follow_up then 'follow_up' else 'other' end as after,
       count(*)
  from proposed p join public.v_inbox_thread_state_buckets o using (id)
 where (o.in_priority, o.in_new_replies, o.in_follow_up) is distinct from (p.in_priority, p.in_new_replies, p.in_follow_up)
 group by 1, 2, 3 order by 4 desc;

-- P3. Plan + timing of the hot path (the list query: one flag, newest first).
--     Same shape as today: one pass over inbox_thread_state + the pending-send
--     hash; no new joins. Compare with the live view's plan below it.
explain (analyze, buffers)
with proposed as (
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
        -- 7.2: sold / unqualified close the thread for this property
        when lower(coalesce(s.disposition, '')) = any (array['sold','unqualified']) then 'dead'
        when lower(coalesce(s.disposition, '')) = 'not_interested' then 'follow_up'
        when s.latest_direction = 'inbound' then 'new_replies'
        else 'cold'
      end)) as f_bucket,
    -- 7.2: what the latest inbound was (empty unless the latest message is inbound)
    case when lower(coalesce(s.latest_direction, '')) = 'inbound'
         then lower(coalesce(s.last_intent, '')) else '' end as f_last_intent,
    -- 8.5: the thread's latest inbound intent whatever was sent after it
    -- (last_intent is written on inbound only)
    lower(coalesce(s.last_intent, '')) as f_thread_intent
  from inbox_thread_state s
  left join pending_send ps on ps.thread_key = s.thread_key
), g as (
  select f.*,
    coalesce(f.is_suppressed, false) or f.f_bucket = 'suppressed' as f_suppressed_contact,
    f.f_disposition = any (array['wrong_number','wrong_person']) as f_wrong_number_contact,
    f.f_delivery = '' or f.f_delivery = any (array['sent','delivered','accepted','queued','pending','sending','submitted','delivery_unknown']) as f_delivery_ok,
    f.f_out_at is not null and (f.last_inbound_at is null or f.last_inbound_at < f.f_out_at) as f_outbound_last_no_reply,
    f.f_disposition = any (array['sold','unqualified']) as f_closed_disposition,
    -- 8.5: every NON-ACTIONABLE latest reply (reply-actionability.js NON_ACTIONABLE_REPLY_INTENTS)
    f.f_last_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_reply_resolved,
    f.f_thread_intent = any (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only']) as f_thread_resolved,
    -- 8.5: PRIORITY_REPLY_INTENTS / POSITIVE_REPLY_INTENTS
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request']) as f_priority_intent,
    f.f_thread_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request','ownership_confirmed','latent_interest','condition_disclosed']) as f_positive_intent,
    -- 8.5: a parked nurture re-opens on a later understood, actionable reply
    (f.f_last_intent <> all (array['', 'unclear']) and f.f_last_intent <> all (array['opt_out','hostile_or_legal','hostile_or_troll','wrong_number','wrong_person','property_specific_non_owner','tenant_respondent','former_owner_respondent','sold_property','not_interested','need_time','asking_price_implausible','acknowledgement','reaction_only'])) as f_reopening_reply,
    f.f_direction = 'inbound' and coalesce(f.last_inbound_at, f.latest_message_at) is not null
      and (f.last_outbound_at is null or coalesce(f.last_inbound_at, f.latest_message_at) >= f.last_outbound_at) as f_unanswered,
    f.f_last_intent = any (array['reaction_only','acknowledgement']) as f_nonengagement_latest
  from f
), h as (
  select g.*,
    (g.f_bucket = any (array['dead','suppressed'])) or g.f_wrong_number_contact or g.f_suppressed_contact
      or g.f_closed_disposition as f_terminal
  from g
), i as (
  select h.*,
    not h.f_archived and not h.f_snoozed and not h.f_pending_schedule as f_available,
    not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule as f_actionable,
    (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'outbound' and h.f_outbound_last_no_reply
      and h.f_out_at >= (now() - '24:00:00'::interval)
      and h.f_delivery_ok and not h.f_metadata_no_contact)
    -- 7.2: a reaction / acknowledgement / auto-reply that left nothing open is
    -- still "waiting on the seller" inside the reply window of our last send.
    or (not h.f_archived and not h.f_terminal and not h.f_snoozed and not h.f_pending_schedule
      and h.f_direction = 'inbound' and h.f_nonengagement_latest and h.f_bucket = 'cold'
      and h.last_outbound_at is not null
      and h.last_outbound_at >= (now() - '24:00:00'::interval)
      and not h.f_metadata_no_contact) as in_waiting
  from h
), j as (
  select i.*,
    -- 8.5 PRIORITY: high-value actionable only. The stored bucket must say
    -- priority AND the latest inbound intent must be priority-grade.
    i.f_actionable and i.f_bucket = 'priority' and i.f_priority_intent and not i.f_thread_resolved as p_priority
  from i
), k as (
  select j.*,
    -- 8.5 NEW REPLIES: an unanswered, actionable (or undetermined) reply.
    j.f_actionable and not j.p_priority and not j.f_needs_review and not j.f_reply_resolved and j.f_unanswered
      and (
        (j.f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
        -- a stored 'priority' whose latest reply is not priority-grade
        or j.f_bucket = 'priority'
        -- a parked nurture re-opened by a later actionable reply
        or (j.f_bucket = 'follow_up' and j.f_reopening_reply)
      ) as p_new_replies,
    -- 8.5 temperature: warm/hot only from a plausible positive latest intent;
    -- a manual temperature is the operator's call.
    case
      when j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual'
        then lower(coalesce(j.lead_temperature, j.temperature))
      when lower(coalesce(j.lead_temperature, j.temperature, '')) = any (array['hot','warm'])
        and not (j.f_positive_intent and not j.f_terminal)
        then 'cold'
      else lower(coalesce(j.lead_temperature, j.temperature))
    end as p_lead_temperature,
    not j.f_terminal and (
      ((j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot')
      or (not (j.manual_temperature_lock = true or lower(coalesce(j.temperature_source, '')) = 'manual')
        and j.f_priority_intent
        and (lower(coalesce(j.lead_temperature, j.temperature, '')) = 'hot' or j.is_hot_lead = true))
    ) as p_hot_lead
  from j
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
    p_priority as in_priority,
    p_new_replies as in_new_replies,
    f_available and (f_bucket = 'needs_review' or f_needs_review) as in_needs_review,
    f_available and f_bucket = 'follow_up' and not p_new_replies as in_follow_up,
    f_actionable and f_bucket = 'cold' and not in_waiting as in_cold,
    not f_archived and (f_bucket = 'dead' or f_wrong_number_contact or f_closed_disposition) as in_dead,
    not f_archived and (f_bucket = 'suppressed' or f_suppressed_contact) as in_suppressed,
    not f_archived and not in_waiting as in_all_messages,
    not f_archived as in_all,
    not f_archived and property_id is null as in_unlinked,
    p_priority
      or (f_available and (f_bucket = 'needs_review' or f_needs_review))
      or (f_available and f_bucket = 'follow_up')
      or p_new_replies as in_active,
    -- appended (7.2)
    f_last_intent,
    f_reply_resolved,
    f_nonengagement_latest,
    f_closed_disposition,
    -- appended (8.5)
    f_thread_intent,
    f_thread_resolved,
    f_priority_intent,
    f_positive_intent,
    f_reopening_reply,
    p_lead_temperature as f_lead_temperature,
    p_hot_lead as f_hot_lead
from k
)
select thread_key from proposed where in_new_replies order by latest_message_at desc nulls last, thread_key desc limit 51;

explain (analyze, buffers)
select thread_key from public.v_inbox_thread_state_buckets where in_new_replies order by latest_message_at desc nulls last, thread_key desc limit 51;
