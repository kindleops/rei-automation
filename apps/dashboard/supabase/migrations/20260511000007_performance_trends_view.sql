CREATE OR REPLACE VIEW public.performance_trends_v AS
WITH o AS (
  SELECT 
    DATE(event_at) as trend_date,
    COUNT(message_event_id) as sends,
    COUNT(message_event_id) FILTER (WHERE delivery_status IN ('delivered', 'read')) as delivered,
    COUNT(message_event_id) FILTER (WHERE delivery_status IN ('failed', 'undelivered')) as failed
  FROM public.performance_message_events_v
  WHERE direction = 'outbound'
  GROUP BY DATE(event_at)
),
r AS (
  SELECT 
    DATE(inbound_at) as trend_date,
    COUNT(inbound_message_event_id) as inbound_replies,
    COUNT(inbound_message_event_id) FILTER (WHERE is_positive_reply) as positive_replies,
    COUNT(inbound_message_event_id) FILTER (WHERE is_opt_out_reply) as opt_outs
  FROM public.performance_attributed_replies_v
  GROUP BY DATE(inbound_at)
)
SELECT 
  COALESCE(o.trend_date, r.trend_date) as trend_date,
  COALESCE(o.sends, 0) as sends,
  COALESCE(o.delivered, 0) as delivered,
  COALESCE(o.failed, 0) as failed,
  COALESCE(r.inbound_replies, 0) as inbound_replies,
  COALESCE(r.positive_replies, 0) as positive_replies,
  COALESCE(r.opt_outs, 0) as opt_outs
FROM o
FULL OUTER JOIN r ON o.trend_date = r.trend_date;
