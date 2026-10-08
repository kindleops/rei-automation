-- PROPOSED -- Inbox round 9 (2026-10-07). WRITTEN, NOT APPLIED.
--
-- Owner, 2026-10-07: "There is a serious problem with our inbox and
-- classifying messages wrongly. All the messages in New Replies and Priority
-- really shouldn't even be there." Policy: New Replies = positive or
-- actionable replies only; Priority = hot / high-value only; residual unclear
-- replies go to a separate NON-ALERTING "Unclear" lane (under All, counted, no
-- badge, no push).
--
-- SUPERSEDES PROPOSED_20261006235000_inbox_actionability_buckets (never
-- applied): this file carries its full 8.5 view body plus the round-9 change,
-- so apply THIS ONE ONLY (applying 8.5 first is harmless). On top of 8.5:
--   f_new_reply_intent  latest inbound intent is on the New Replies WHITELIST
--                       (reply-actionability.js NEW_REPLY_ACTIONABLE_INTENTS)
--   in_new_replies      8.5 predicate AND f_new_reply_intent
--   in_unclear          the same unanswered reply when NOT f_new_reply_intent
--   f_reopening_reply   a nurture re-opens only on a whitelisted reply
--   v_inbox_bucket_counts  + unclear (appended)
-- Priority (8.5): stored 'priority' AND a priority-grade latest intent -- an
-- implausible ask ("2 million" on a $254K house) or a frustration close is
-- never Priority.
-- CREATE OR REPLACE appends columns only (live 7.2 = 129 columns; 8.5 = 136;
-- this = 138). v_inbox_zero_counts reads v_inbox_bucket_counts by name.
-- JS mirror: apps/api/src/lib/domain/inbox/inbox-bucket-predicates.js +
--            reply-actionability.js. Change together
--            (tests/critical/inbox-round9-buckets.test.mjs reads this file).
-- Pretest:  PROPOSED_20261008020000_inbox_round9_buckets_pretest.sql
-- Rollback: PROPOSED_20261008020000_inbox_round9_buckets_rollback.sql

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
    -- 9 (round 9): a parked nurture re-opens on a later ACTIONABLE reply (the
    -- New Replies whitelist, reply-actionability.js NEW_REPLY_ACTIONABLE_INTENTS)
    f.f_last_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request','ownership_confirmed','latent_interest','condition_disclosed','asking_price_absent','tenant_occupied','non_owner_referral','co_owner_respondent','executor_heir_respondent','family_member_respondent','entity_representative_respondent','agent_representative_respondent','property_manager_respondent','lien_tax_issue','title_issue','bankruptcy_disclosed','trust_ownership','llc_corporation','requests_email','property_correction','going_to_market']) as f_reopening_reply,
    -- 9: New Replies is a WHITELIST of actionable latest replies. No recorded
    -- intent ('') is unknown, not unclear: it stays visible in New Replies.
    f.f_last_intent = '' or f.f_last_intent = any (array['asking_price_provided','asks_offer','contract_requested','seller_interested','callback_requested','voicemail_call_request','ownership_confirmed','latent_interest','condition_disclosed','asking_price_absent','tenant_occupied','non_owner_referral','co_owner_respondent','executor_heir_respondent','family_member_respondent','entity_representative_respondent','agent_representative_respondent','property_manager_respondent','lien_tax_issue','title_issue','bankruptcy_disclosed','trust_ownership','llc_corporation','requests_email','property_correction','going_to_market']) as f_new_reply_intent,
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
    -- 9 NEW REPLIES: an unanswered reply whose latest intent is ACTIONABLE.
    j.f_actionable and not j.p_priority and not j.f_needs_review and not j.f_reply_resolved and j.f_unanswered
      and j.f_new_reply_intent
      and (
        (j.f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']))
        -- a stored 'priority' whose latest reply is not priority-grade
        or j.f_bucket = 'priority'
        -- a parked nurture re-opened by a later actionable reply
        or (j.f_bucket = 'follow_up' and j.f_reopening_reply)
      ) as p_new_replies,
    -- 9 UNCLEAR (non-alerting): the same unanswered reply when its latest
    -- intent is NOT actionable (unclear, who_is_this, language_switch, a bare
    -- "No" awaiting its clarifier, an unread emoji, no intent at all).
    -- Under All, counted, never a badge / push; not part of in_active.
    j.f_actionable and not j.p_priority and not j.f_needs_review and not j.f_reply_resolved and j.f_unanswered
      and not j.f_new_reply_intent
      and (j.f_bucket <> all (array['priority','needs_review','waiting','cold','follow_up']) or j.f_bucket = 'priority')
      as p_unclear,
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
    p_hot_lead as f_hot_lead,
    -- appended (9)
    f_new_reply_intent,
    p_unclear as in_unclear
from k;

create or replace view public.v_inbox_bucket_counts as
SELECT count(*) FILTER (WHERE in_priority) AS priority,
    count(*) FILTER (WHERE in_new_replies) AS new_replies,
    count(*) FILTER (WHERE in_needs_review) AS needs_review,
    count(*) FILTER (WHERE in_follow_up) AS follow_up,
    count(*) FILTER (WHERE in_waiting) AS waiting,
    count(*) FILTER (WHERE in_cold) AS cold,
    count(*) FILTER (WHERE in_dead) AS dead,
    count(*) FILTER (WHERE in_suppressed) AS suppressed,
    count(*) FILTER (WHERE in_archived) AS archived,
    count(*) FILTER (WHERE in_snoozed) AS snoozed,
    count(*) FILTER (WHERE in_all_messages) AS all_messages,
    count(*) FILTER (WHERE in_all) AS "all",
    count(*) FILTER (WHERE in_unlinked) AS unlinked,
    count(*) FILTER (WHERE in_active) AS active,
    count(*) FILTER (WHERE ((NOT COALESCE(is_read, false)) AND in_all)) AS unread,
    count(*) FILTER (WHERE ((f_disposition = 'not_interested'::text) AND in_all)) AS not_interested,
    count(*) FILTER (WHERE (f_disposition = 'wrong_person'::text)) AS wrong_person,
    count(*) FILTER (WHERE (f_disposition = 'wrong_number'::text)) AS wrong_number,
    count(*) FILTER (WHERE in_scheduled) AS scheduled,
    -- appended (9): the non-alerting Unclear lane
    count(*) FILTER (WHERE in_unclear) AS unclear
   FROM v_inbox_thread_state_buckets;

commit;

-- Verify after apply (read-only):
--   select count(*) filter (where in_new_replies) as new_replies,
--          count(*) filter (where in_unclear) as unclear,
--          count(*) filter (where in_priority) as priority,
--          count(*) filter (where in_new_replies and not f_new_reply_intent) as must_be_zero_1,
--          count(*) filter (where in_new_replies and in_unclear) as must_be_zero_2,
--          count(*) filter (where in_priority and not f_priority_intent) as must_be_zero_3
--     from public.v_inbox_thread_state_buckets;
--   select priority, new_replies, unclear from public.v_inbox_bucket_counts;
