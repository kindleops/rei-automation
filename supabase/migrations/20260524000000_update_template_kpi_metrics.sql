BEGIN;

-- Update template_performance_kpis_v to include new rate and diagnostic fields
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
  w.time_window,
  
  -- Existing stats
  COUNT(o.message_event_id) as sends,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('failed', 'undelivered')) as failed,
  COUNT(r.inbound_message_event_id) as inbound_replies,
  
  -- New requested fields
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_out_count,
  COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) as delivered_outbound_count,
  CASE WHEN COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read')) > 0 
       THEN ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply)::numeric / COUNT(o.message_event_id) FILTER (WHERE o.delivery_status IN ('delivered', 'read'))) * 100, 2)
       ELSE NULL END as opt_out_rate_percent,

  COUNT(r.inbound_message_event_id) as inbound_classified_count,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_inbound_count,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_negative_reply) as negative_inbound_count,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent NOT IN ('positive', 'negative', 'opt_out')) as neutral_inbound_count,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.detected_reply_intent IS NULL) as unclear_inbound_count,

  CASE WHEN COUNT(r.inbound_message_event_id) > 0 
       THEN ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply)::numeric / COUNT(r.inbound_message_event_id)) * 100, 2)
       ELSE NULL END as positive_rate_percent,
  CASE WHEN COUNT(r.inbound_message_event_id) > 0 
       THEN ROUND((COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_negative_reply)::numeric / COUNT(r.inbound_message_event_id)) * 100, 2)
       ELSE NULL END as negative_rate_percent,
       
  -- Metric Status
  CASE WHEN COUNT(r.inbound_message_event_id) = 0 THEN 'missing_source' ELSE 'ok' END as metric_status,

  -- Existing fields
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_positive_reply) as positive_replies,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_opt_out_reply) as opt_outs,
  COUNT(r.inbound_message_event_id) FILTER (WHERE r.is_wrong_number_reply) as wrong_numbers,
  
  COUNT(o.message_event_id) as sample_size,
  
  -- Confidence/Label
  CASE 
    WHEN COUNT(o.message_event_id) < 10 THEN 'insufficient_data'
    WHEN COUNT(o.message_event_id) BETWEEN 10 AND 29 THEN 'low_confidence'
    WHEN COUNT(o.message_event_id) BETWEEN 30 AND 99 THEN 'medium_confidence'
    ELSE 'high_confidence'
  END as confidence_bucket,
  
  CASE
    WHEN COUNT(o.message_event_id) >= 30 AND (COUNT(r.inbound_message_event_id)::numeric/COUNT(o.message_event_id)) >= 0.08 THEN 'winner'
    ELSE 'stable'
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

COMMIT;
