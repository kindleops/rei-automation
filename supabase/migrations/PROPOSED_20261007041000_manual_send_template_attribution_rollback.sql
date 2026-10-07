-- ROLLBACK for PROPOSED_20261007041000_manual_send_template_attribution.sql
begin;
set local lock_timeout = '5s';
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
    COALESCE((m.metadata ->> 'template_id'::text), (q.metadata ->> 'template_id'::text), q.template_id, 'unknown'::text) AS template_key,
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
delete from public.sms_templates where template_id = 'manual_inbox' and metadata->>'pseudo_template' = 'true';
commit;
