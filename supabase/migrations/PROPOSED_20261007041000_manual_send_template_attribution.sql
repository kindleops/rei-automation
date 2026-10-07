-- PROPOSED — NOT APPLIED. OWNER APPROVAL REQUIRED.
--
-- MANUAL INBOX SEND ATTRIBUTION (no-response follow-up work, 2026-10-06).
-- Finding: every operator Inbox send carries template_id NULL (177/177 manual_reply
-- rows in the last 30 days, template_source = 'manual_composer'). In
-- template_performance_kpis_v they fall into template_key = 'unknown' together
-- with every other unattributable send (7d: 74 sends / 45 replies), so the
-- owner's own copy has no row in the template metrics and pollutes 'unknown'.
--
-- Change (additive, read-model only; no send path, no existing row changes):
--   1. one pseudo-template row 'manual_inbox' (INACTIVE, never selectable:
--      is_active = false, safe_for_auto_reply = false, reply_mode = 'manual') so
--      the KPI join has a name ("Manual Inbox send");
--   2. message_attribution_events_v.template_key: an outbound queue row that is
--      an operator manual send and has no template id maps to 'manual_inbox'
--      instead of 'unknown'. Every other expression and column is unchanged
--      (CREATE OR REPLACE keeps the column list and grants).
-- Rollback: PROPOSED_20261007041000_manual_send_template_attribution_rollback.sql
-- Follow-up (not in this file): split 'manual_inbox' by message class (S2
-- question / price question / offer / other) once the owner wants it.

begin;
set local lock_timeout = '5s';

insert into public.sms_templates (
  use_case, template_id, template_name, language, agent_persona, template_body,
  variables, is_active, safe_for_auto_reply, reply_mode, identity_contact_mode,
  property_type_scope, stage_code, stage_label, is_first_touch, is_follow_up,
  fallback_rank, quarantine_state, metadata
)
select 'manual_reply', 'manual_inbox', 'Manual Inbox send (operator-typed, attribution only)', 'English', null,
       '[operator-typed message — attribution bucket, never sent as a template]',
       '{}'::jsonb, false, false, 'manual', 'neutral',
       'Any Residential', 'manual_reply', 'Manual Inbox', false, false,
       99, 'active',
       jsonb_build_object('authored_by', 'manual_send_attribution_2026_10_06',
                          'pseudo_template', true,
                          'never_selectable', true)
where not exists (select 1 from public.sms_templates where template_id = 'manual_inbox');

create or replace view public.message_attribution_events_v as
SELECT m.id AS message_event_id,
    q.id AS queue_row_id,
    m.thread_key,
    m.direction,
    COALESCE(m.event_timestamp, m.created_at) AS event_timestamp,
    m.message_body,
    m.detected_intent,
    m.is_opt_out,
    m.delivery_status,
    m.provider_delivery_status,
    m.failure_reason,
    COALESCE((m.metadata ->> 'template_id'::text), (q.metadata ->> 'template_id'::text), q.template_id,
        CASE WHEN m.direction = 'outbound'::text AND (q.use_case_template = 'manual_reply'::text OR q.message_type = 'manual_reply'::text OR (q.metadata ->> 'template_source'::text) = 'manual_composer'::text)
             THEN 'manual_inbox'::text END,
        'unknown'::text) AS template_key,
    (m.metadata ->> 'template_id'::text) AS message_event_template_id,
    q.template_id AS queue_template_id,
    COALESCE(q.textgrid_number_id, (m.from_phone_number)::text, 'unknown'::text) AS textgrid_number_key,
    q.textgrid_number_id,
    m.from_phone_number,
    m.to_phone_number,
    COALESCE(m.market, q.market, 'unknown'::text) AS market,
    q.market_id,
    q.language,
    q.current_stage,
    q.stage_before,
    q.stage_after,
    q.touch_number,
    q.sms_agent_id,
        CASE
            WHEN (q.id IS NOT NULL) THEN 'queue'::text
            ELSE 'direct'::text
        END AS source,
    (m.direction = 'inbound'::text) AS is_inbound,
    (m.direction = 'outbound'::text) AS is_outbound,
    ((m.direction = 'inbound'::text) AND (m.detected_intent = ANY (ARRAY['seller_interested'::text, 'asking_price_provided'::text, 'asks_offer'::text, 'ownership_confirmed'::text, 'condition_disclosed'::text, 'needs_call'::text, 'needs_email'::text]))) AS is_positive_reply,
    ((m.direction = 'inbound'::text) AND (m.is_opt_out OR (m.detected_intent = 'opt_out'::text))) AS is_opt_out_reply
   FROM (message_events m
     LEFT JOIN send_queue q ON (((m.queue_id = q.id) OR ((m.queue_id)::text = q.queue_id))));

commit;

-- POSTCHECK (read-only):
--   select template_key, sends, replies_attributed from public.template_performance_kpis_v
--    where time_window = '7d' and template_key in ('manual_inbox', 'unknown');
