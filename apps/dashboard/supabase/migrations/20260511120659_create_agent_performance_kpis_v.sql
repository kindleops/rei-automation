CREATE OR REPLACE VIEW public.agent_performance_kpis_v AS
WITH enriched_messages AS (
  SELECT
    m.id AS message_event_id,
    m.thread_key,
    m.direction,
    COALESCE(m.event_timestamp, m.created_at) AS event_timestamp,
    m.detected_intent,
    m.is_opt_out,
    m.current_stage,
    -- Attribution extraction (priority order)
    CASE WHEN m.direction = 'outbound' THEN
      COALESCE(
        NULLIF(m.sms_agent_id, ''),
        NULLIF(m.metadata->>'sms_agent_id', ''),
        NULLIF(q.sms_agent_id, ''),
        NULLIF(q.selected_agent_id, ''),
        NULLIF(q.metadata->>'sms_agent_id', ''),
        NULLIF(t.metadata->>'agent_style_fit', ''),
        NULLIF(t.agent_persona, ''),
        'unknown'
      )
    END AS out_agent_id,
    CASE WHEN m.direction = 'outbound' THEN COALESCE(NULLIF(t.agent_persona, ''), 'unknown') END AS out_persona,
    CASE WHEN m.direction = 'outbound' THEN COALESCE(NULLIF(t.metadata->>'agent_tone', ''), 'neutral') END AS out_tone,
    CASE WHEN m.direction = 'outbound' THEN COALESCE(NULLIF(m.language, ''), NULLIF(q.language, ''), NULLIF(t.language, ''), 'english') END AS out_language,
    CASE WHEN m.direction = 'outbound' THEN COALESCE(NULLIF(t.deal_strategy, ''), 'general') END AS out_strategy,
    CASE WHEN m.direction = 'outbound' THEN COALESCE(NULLIF(m.metadata->>'agent_name', ''), NULLIF(q.metadata->>'agent_name', ''), 'Unknown Agent') END AS out_agent_name
  FROM message_events m
  LEFT JOIN send_queue q ON m.queue_id = q.id OR m.queue_id::text = q.queue_id
  LEFT JOIN sms_templates t ON t.template_id = COALESCE(m.template_id, q.template_id)
),
attributed AS (
  SELECT
    *,
    COALESCE(out_agent_id, first_value(out_agent_id) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'unknown') AS sms_agent_id,
    COALESCE(out_persona, first_value(out_persona) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'unknown') AS persona,
    COALESCE(out_tone, first_value(out_tone) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'neutral') AS tone,
    COALESCE(out_language, first_value(out_language) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'english') AS language,
    COALESCE(out_strategy, first_value(out_strategy) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'general') AS strategy,
    COALESCE(out_agent_name, first_value(out_agent_name) OVER (PARTITION BY thread_key, grp ORDER BY event_timestamp), 'Unknown Agent') AS agent_name,
    LAG(event_timestamp) OVER (PARTITION BY thread_key ORDER BY event_timestamp) AS prev_timestamp,
    LAG(direction) OVER (PARTITION BY thread_key ORDER BY event_timestamp) AS prev_direction
  FROM (
    SELECT *,
      COUNT(out_agent_id) OVER (PARTITION BY thread_key ORDER BY event_timestamp) AS grp
    FROM enriched_messages
  ) sub
),
daily_aggregates AS (
  SELECT
    sms_agent_id,
    agent_name,
    persona,
    tone,
    language,
    strategy,
    date_trunc('day', event_timestamp)::date AS time_window,
    
    COUNT(*) FILTER (WHERE direction = 'outbound') AS sends,
    COUNT(*) FILTER (WHERE direction = 'inbound') AS replies,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = ANY(ARRAY['seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'condition_disclosed', 'qualified_lead', 'needs_call', 'needs_email']))) AS positive_replies,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (is_opt_out OR detected_intent = 'opt_out')) AS opt_outs,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'wrong_number') AS wrong_numbers,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = 'hostile' OR detected_intent = 'angry' OR detected_intent = 'not_interested_hostile')) AS hostile_replies,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'asking_price_provided') AS asking_price_replies,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'ownership_confirmed') AS ownership_confirmed,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = 'qualified_lead' OR current_stage = 'qualified')) AS qualified_leads,
    
    AVG(EXTRACT(EPOCH FROM (event_timestamp - prev_timestamp))/3600.0) FILTER (WHERE direction = 'inbound' AND prev_direction = 'outbound') AS avg_response_hours
  FROM attributed
  GROUP BY sms_agent_id, agent_name, persona, tone, language, strategy, date_trunc('day', event_timestamp)::date
)
SELECT
  *,
  -- Rates
  CASE WHEN sends > 0 THEN (replies::numeric / sends) * 100 ELSE 0 END AS reply_rate_pct,
  CASE WHEN sends > 0 THEN (positive_replies::numeric / sends) * 100 ELSE 0 END AS positive_rate_pct,
  CASE WHEN sends > 0 THEN (opt_outs::numeric / sends) * 100 ELSE 0 END AS opt_out_rate_pct,
  CASE WHEN sends > 0 THEN (wrong_numbers::numeric / sends) * 100 ELSE 0 END AS wrong_number_rate_pct,
  CASE WHEN sends > 0 THEN (qualified_leads::numeric / sends) * 100 ELSE 0 END AS qualification_rate_pct,
  CASE WHEN sends > 0 THEN (positive_replies::numeric / sends) * 100 ELSE 0 END AS stage_advance_rate_pct,
  
  -- Auto-Optimization Infrastructure
  1.0 AS current_volume_weight,
  CASE 
    WHEN sends > 50 AND (positive_replies::numeric / sends) > 0.05 THEN 1.5
    WHEN sends > 50 AND (opt_outs::numeric / sends) > 0.05 THEN 0.5
    ELSE 1.0 
  END AS recommended_volume_weight,
  
  CASE 
    WHEN sends > 50 AND (positive_replies::numeric / sends) > 0.05 THEN 'scale_up'
    WHEN sends > 50 AND (opt_outs::numeric / sends) > 0.05 THEN 'scale_down'
    ELSE 'maintain' 
  END AS recommended_status,
  
  (sends > 100 AND (opt_outs::numeric / sends) > 0.08) AS auto_pause_candidate,
  
  CASE 
    WHEN sends < 25 THEN 'low_data'
    WHEN sends < 100 THEN 'learning'
    ELSE 'high_confidence'
  END AS confidence_bucket
FROM daily_aggregates;

-- Expose to the Data API
GRANT SELECT ON public.agent_performance_kpis_v TO anon, authenticated;

-- Attribution Metrics View
CREATE OR REPLACE VIEW public.agent_attribution_metrics_v AS
WITH counts AS (
  SELECT 
    COUNT(*) as total_events,
    COUNT(*) FILTER (WHERE sms_agent_id != 'unknown' AND sms_agent_id IS NOT NULL) AS attributed_events
  FROM public.agent_performance_kpis_v
)
SELECT 
  total_events,
  attributed_events,
  total_events - attributed_events AS unknown_events,
  CASE WHEN total_events > 0 THEN (attributed_events::numeric / total_events) * 100 ELSE 0 END AS attribution_coverage_pct,
  CASE WHEN total_events > 0 THEN ((total_events - attributed_events)::numeric / total_events) * 100 ELSE 0 END AS unknown_agent_pct,
  CASE WHEN total_events > 1000 THEN 'high' WHEN total_events > 100 THEN 'medium' ELSE 'low' END AS agent_attribution_confidence
FROM counts;

GRANT SELECT ON public.agent_attribution_metrics_v TO anon, authenticated;
