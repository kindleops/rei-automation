
BEGIN;

DROP VIEW IF EXISTS public.performance_outliers_v CASCADE;
DROP VIEW IF EXISTS public.template_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.number_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.market_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.property_type_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.seller_signal_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.property_signal_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.owner_type_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.stage_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.touch_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.language_performance_kpis_v CASCADE;
DROP VIEW IF EXISTS public.performance_attributed_replies_v CASCADE;
DROP VIEW IF EXISTS public.performance_message_events_v CASCADE;

CREATE OR REPLACE VIEW public.performance_message_events_v AS
WITH me AS (
  SELECT * FROM public.message_events
),
sq AS (
  SELECT * FROM public.send_queue
),
icc AS (
  SELECT * FROM public.inbox_command_center_v
)
SELECT
  me.id as message_event_id,
  COALESCE(me.queue_id, me.metadata->>'queue_id') as queue_row_id,
  COALESCE(me.metadata->>'thread_key', sq.thread_key, 'phone:' || me.canonical_e164) as thread_key,
  me.direction,
  me.event_timestamp as event_at,
  me.message_body,
  COALESCE(me.metadata->>'detected_intent', sq.detected_intent, icc.detected_intent) as detected_intent,
  me.is_opt_out,
  me.delivery_status,
  me.provider_delivery_status,
  me.failure_reason,
  CASE
    WHEN me.delivery_status IN ('failed', 'undelivered') THEN
      COALESCE(
        (me.metadata->>'failure_bucket'),
        CASE
          WHEN me.failure_reason ILIKE '%carrier%' THEN 'carrier_filter'
          WHEN me.failure_reason ILIKE '%dnc%' OR me.failure_reason ILIKE '%opt%' THEN 'dnc_block'
          WHEN me.failure_reason ILIKE '%invalid%' OR me.failure_reason ILIKE '%format%' THEN 'invalid_number'
          ELSE 'unknown_failure'
        END
      )
    ELSE NULL
  END as failure_bucket,
  
  -- template_key priority
  COALESCE(
    me.metadata->>'template_id',
    me.metadata->>'selected_template_id',
    sq.template_id,
    sq.selected_template_id,
    sq.use_case_template,
    sq.template_source,
    'unknown'
  ) as template_key,
  
  COALESCE(me.metadata->>'template_id', sq.template_id) as template_id,
  COALESCE(me.metadata->>'selected_template_id', sq.selected_template_id) as selected_template_id,
  sq.use_case_template,
  sq.template_source,
  
  -- number_key priority
  COALESCE(
    me.textgrid_number_id,
    me.metadata->>'textgrid_number_id',
    sq.textgrid_number_id,
    me.from_phone_number,
    sq.from_phone_number,
    sq.textgrid_number,
    'unknown'
  ) as textgrid_number_key,
  
  COALESCE(me.textgrid_number_id, me.metadata->>'textgrid_number_id', sq.textgrid_number_id) as textgrid_number_id,
  me.from_phone_number,
  me.to_phone_number,
  
  -- market priority
  COALESCE(
    me.market,
    me.metadata->>'market',
    sq.market,
    icc.market,
    'unknown'
  ) as market,
  COALESCE(me.market_id, sq.market_id) as market_id,
  
  COALESCE(me.metadata->>'language', sq.language, icc.best_language, 'en') as language,
  
  COALESCE(me.property_id, sq.property_id, icc.property_id::text) as property_id,
  COALESCE(me.master_owner_id, sq.master_owner_id, icc.master_owner_id::text) as master_owner_id,
  COALESCE(me.prospect_id, sq.prospect_id, icc.prospect_id::text) as prospect_id,
  
  COALESCE(sq.property_type, icc.property_type, 'unknown') as property_type,
  COALESCE(sq.owner_type, icc.owner_type_guess, 'unknown') as owner_type,
  
  COALESCE(me.metadata->>'seller_signal', icc.seller_tags_text, icc.detected_intent) as seller_signal,
  icc.property_flags_text as property_signals_text,
  icc.property_flags_json,
  icc.podio_tags,
  
  COALESCE(me.metadata->>'current_stage', sq.current_stage, icc.stage) as current_stage,
  COALESCE(me.metadata->>'stage_before', sq.stage_before) as stage_before,
  COALESCE(me.metadata->>'stage_after', sq.stage_after) as stage_after,
  
  COALESCE((me.metadata->>'touch_number')::int, sq.touch_number) as touch_number,
  COALESCE(me.metadata->>'sms_agent_id', sq.sms_agent_id) as sms_agent_id,
  COALESCE(me.source_app, sq.source) as source,
  
  me.created_at

FROM me
LEFT JOIN sq ON (sq.id::text = me.queue_id OR sq.queue_id = me.queue_id OR sq.id::text = me.metadata->>'queue_id')
LEFT JOIN icc ON icc.thread_key = COALESCE(me.metadata->>'thread_key', sq.thread_key, 'phone:' || me.canonical_e164);

CREATE OR REPLACE VIEW public.performance_attributed_replies_v AS
WITH outbound AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
inbound AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'inbound'
)
SELECT
  o.message_event_id as outbound_message_event_id,
  o.event_at as outbound_at,
  i.message_event_id as inbound_message_event_id,
  i.event_at as inbound_at,
  EXTRACT(EPOCH FROM (i.event_at - o.event_at)) / 3600.0 as response_hours,
  o.thread_key,
  o.template_key,
  o.textgrid_number_key,
  o.market,
  o.property_type,
  o.owner_type,
  o.language,
  o.touch_number,
  o.current_stage,
  i.detected_intent as detected_reply_intent,
  
  (i.detected_intent IN ('seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'condition_disclosed', 'needs_call', 'needs_email')) as is_positive_reply,
  (i.is_opt_out OR i.detected_intent = 'opt_out') as is_opt_out_reply,
  (i.detected_intent = 'wrong_number') as is_wrong_number_reply,
  (i.detected_intent IN ('opt_out', 'not_interested', 'wrong_number', 'hostile_or_legal', 'tenant_occupancy', 'listed_or_unavailable')) as is_negative_reply

FROM outbound o
LEFT JOIN LATERAL (
  SELECT *
  FROM inbound i
  WHERE i.thread_key = o.thread_key
    AND i.event_at > o.event_at
    AND i.event_at <= o.event_at + interval '14 days'
  ORDER BY i.event_at ASC
  LIMIT 1
) i ON true;

CREATE OR REPLACE VIEW public.template_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.template_key,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.template_key, w.time_window;

CREATE OR REPLACE VIEW public.number_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.textgrid_number_key,
  w.time_window
  , MAX(o.from_phone_number) as from_phone_number, MAX(o.market) as market,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.textgrid_number_key, w.time_window;

CREATE OR REPLACE VIEW public.market_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.market,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.market, w.time_window;

CREATE OR REPLACE VIEW public.property_type_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.property_type,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.property_type, w.time_window;

CREATE OR REPLACE VIEW public.seller_signal_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.seller_signal,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.seller_signal, w.time_window;

CREATE OR REPLACE VIEW public.property_signal_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.podio_tags,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.podio_tags, w.time_window;

CREATE OR REPLACE VIEW public.owner_type_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.owner_type,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.owner_type, w.time_window;

CREATE OR REPLACE VIEW public.stage_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.current_stage,
  w.time_window
  , MAX(o.stage_before) as stage_before, MAX(o.stage_after) as stage_after,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.current_stage, w.time_window;

CREATE OR REPLACE VIEW public.touch_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.touch_number,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.touch_number, w.time_window;

CREATE OR REPLACE VIEW public.language_performance_kpis_v AS
WITH windows AS (
  SELECT unnest(ARRAY['today', '24h', '7d', '30d', 'all_time']) as time_window
),
o AS (
  SELECT * FROM public.performance_message_events_v WHERE direction = 'outbound'
),
r AS (
  SELECT * FROM public.performance_attributed_replies_v
)
SELECT
  o.language,
  w.time_window
  ,
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  
  COUNT(r.inbound_message_event_id) as inbound_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested') as not_interested,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'hostile_or_legal') as hostile_or_legal,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'asking_price_provided') as asking_price_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'ownership_confirmed') as ownership_confirmed_replies,
  
  AVG(r.response_hours) as avg_response_hours,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.response_hours) as median_response_hours,
  
  ROUND((COUNT(r.inbound_message_event_id)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as reply_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as positive_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as opt_out_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply)::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as wrong_number_rate_pct,
  ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent = 'not_interested')::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as not_interested_rate_pct,
  
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as delivery_rate_pct,
  ROUND((COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric / NULLIF(COUNT(o.message_event_id), 0)) * 100, 2) as failure_rate_pct,
  
  COUNT(o.message_event_id) as sample_size,
  
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric/COUNT(o.message_event_id)) >= 0.10 AND (COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) <= 0.025 AND (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) <= 0.15 THEN 'winner'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.05 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.25) THEN 'pause_candidate'
    WHEN COUNT(o.message_event_id) >= 30 AND ((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric/COUNT(o.message_event_id)) >= 0.04 OR (COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered'))::numeric/COUNT(o.message_event_id)) >= 0.20) THEN 'risky'
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.05 THEN 'stable'
    WHEN COUNT(o.message_event_id) >= 10 THEN 'watch'
    ELSE 'insufficient_data'
  END as performance_label

FROM o
LEFT JOIN r ON r.outbound_message_event_id = o.message_event_id
CROSS JOIN windows w
WHERE 
  CASE w.time_window
    WHEN 'today' THEN o.event_at >= CURRENT_DATE
    WHEN '24h' THEN o.event_at >= NOW() - INTERVAL '24 hours'
    WHEN '7d' THEN o.event_at >= NOW() - INTERVAL '7 days'
    WHEN '30d' THEN o.event_at >= NOW() - INTERVAL '30 days'
    WHEN 'all_time' THEN true
  END
GROUP BY o.language, w.time_window;

CREATE OR REPLACE VIEW public.performance_outliers_v AS
SELECT 
  'best_template' as outlier_type,
  template_key as key,
  positive_rate_pct as score,
  performance_label
FROM public.template_performance_kpis_v
WHERE time_window = '7d' AND performance_label = 'winner'
ORDER BY positive_rate_pct DESC LIMIT 1

UNION ALL

SELECT 
  'riskiest_template' as outlier_type,
  template_key as key,
  opt_out_rate_pct as score,
  performance_label
FROM public.template_performance_kpis_v
WHERE time_window = '7d' AND performance_label IN ('risky', 'pause_candidate')
ORDER BY opt_out_rate_pct DESC LIMIT 1

UNION ALL

SELECT 
  'best_market' as outlier_type,
  market as key,
  positive_rate_pct as score,
  performance_label
FROM public.market_performance_kpis_v
WHERE time_window = '7d' AND sample_size >= 30
ORDER BY positive_rate_pct DESC LIMIT 1;

COMMIT;
