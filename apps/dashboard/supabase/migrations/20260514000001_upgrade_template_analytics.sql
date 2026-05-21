-- Add template selection metadata to send_queue
ALTER TABLE public.send_queue 
ADD COLUMN IF NOT EXISTS selected_template_score numeric,
ADD COLUMN IF NOT EXISTS selected_template_recommendation text,
ADD COLUMN IF NOT EXISTS template_selection_reason text,
ADD COLUMN IF NOT EXISTS template_selection_bucket text;

-- Refine the RPC to include sample-size-aware recommendations and more details
CREATE OR REPLACE FUNCTION public.get_ownership_check_template_stats_v2(
  start_date timestamptz DEFAULT NULL,
  end_date timestamptz DEFAULT NULL,
  p_market_id text DEFAULT NULL,
  p_agent_id text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_min_sent integer DEFAULT 0,
  p_recommendation text DEFAULT NULL,
  p_risk_level text DEFAULT NULL
)
RETURNS TABLE (
  template_id text,
  template_name text,
  use_case_slug text,
  stage_code text,
  language text,
  tone text,
  deal_strategy text,
  is_first_touch boolean,
  is_follow_up boolean,
  template_text text,
  active boolean,
  total_queued bigint,
  total_sent bigint,
  total_delivered bigint,
  total_failed bigint,
  total_reply_count bigint,
  unique_seller_replies bigint,
  positive_interest_count bigint,
  ownership_confirmed_count bigint,
  opt_out_count bigint,
  wrong_number_count bigint,
  hostile_or_legal_count bigint,
  stage_advanced_count bigint,
  offers_created_count bigint,
  contracts_created_count bigint,
  closed_won_count bigint,
  estimated_revenue numeric,
  overall_score numeric,
  recommendation text,
  risk_level text,
  delivery_rate numeric,
  reply_rate numeric,
  positive_interest_rate numeric,
  opt_out_rate numeric,
  hostile_rate numeric,
  top_markets jsonb,
  agent_performance jsonb,
  sample_inbound jsonb
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH base_templates AS (
    SELECT 
      t.template_id::text,
      t.name AS template_name,
      t.use_case_slug,
      t.stage_code,
      t.language,
      t.agent_style AS tone,
      t.deal_strategy,
      t.is_first_touch,
      t.is_follow_up,
      COALESCE(t.template_text, t.body) AS template_text,
      t.active
    FROM public.sms_templates t
    WHERE (t.use_case_slug = 'ownership_check' OR (t.metadata->>'use_case' = 'ownership_check'))
      AND (p_language IS NULL OR t.language = p_language)
  ),
  enriched_messages AS (
    SELECT
      m.id AS message_event_id,
      m.thread_key,
      m.direction,
      COALESCE(m.event_timestamp, m.created_at) AS event_timestamp,
      m.detected_intent,
      m.is_opt_out,
      m.current_stage,
      COALESCE(m.template_id, (m.metadata->>'template_id')::text) AS msg_template_id,
      q.template_id AS queue_template_id,
      COALESCE(q.status, q.queue_status) AS delivery_status,
      COALESCE(m.market_id, q.market_id) AS market_id,
      COALESCE(m.sms_agent_id, q.sms_agent_id, q.selected_agent_id) AS sms_agent_id,
      m.seller_phone,
      m.prospect_id,
      m.property_id,
      m.message_body
    FROM public.message_events m
    LEFT JOIN public.send_queue q ON m.queue_id = q.id OR m.queue_id::text = q.queue_id
    WHERE (start_date IS NULL OR COALESCE(m.event_timestamp, m.created_at) >= start_date)
      AND (end_date IS NULL OR COALESCE(m.event_timestamp, m.created_at) <= end_date)
      AND (p_market_id IS NULL OR COALESCE(m.market_id, q.market_id) = p_market_id)
      AND (p_agent_id IS NULL OR COALESCE(m.sms_agent_id, q.sms_agent_id, q.selected_agent_id) = p_agent_id)
  ),
  attributed_messages AS (
    SELECT
      *,
      CASE 
        WHEN direction = 'outbound' THEN COALESCE(msg_template_id, queue_template_id)
        ELSE first_value(COALESCE(msg_template_id, queue_template_id)) OVER (
          PARTITION BY thread_key, grp 
          ORDER BY event_timestamp
        )
      END AS attributed_template_id,
      lead(current_stage) OVER (
        PARTITION BY thread_key 
        ORDER BY event_timestamp
      ) AS next_stage
    FROM (
      SELECT *,
        COUNT(CASE WHEN direction = 'outbound' THEN 1 END) OVER (
          PARTITION BY thread_key 
          ORDER BY event_timestamp
        ) AS grp
      FROM enriched_messages
    ) sub
  ),
  template_metrics AS (
    SELECT
      attributed_template_id AS template_id,
      COUNT(*) FILTER (WHERE direction = 'outbound') AS total_queued,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status != 'failed') AS total_sent,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND (delivery_status = 'delivered' OR delivery_status = 'sent')) AS total_delivered,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status = 'failed') AS total_failed,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS total_inbound_replies,
      COUNT(DISTINCT seller_phone) FILTER (WHERE direction = 'inbound') AS unique_seller_replies,
      COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'seller_interested') AS positive_interest_count,
      COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'ownership_confirmed') AS ownership_confirmed_count,
      COUNT(*) FILTER (WHERE direction = 'inbound' AND (is_opt_out OR detected_intent = 'opt_out')) AS stop_count,
      COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'wrong_number') AS wrong_number_count,
      COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = 'hostile' OR detected_intent = 'angry' OR detected_intent = 'not_interested_hostile')) AS hostile_or_legal_count,
      COUNT(DISTINCT thread_key) FILTER (WHERE next_stage IS NOT NULL AND next_stage != current_stage AND next_stage != 'dead' AND next_stage != 'suppressed') AS stage_advanced_count,
      -- Market performance aggregation
      jsonb_object_agg(market_id, market_count) FILTER (WHERE market_id IS NOT NULL) as markets_json,
      -- Sample inbounds
      jsonb_agg(jsonb_build_object('body', message_body, 'intent', detected_intent)) FILTER (WHERE direction = 'inbound') as samples_json
    FROM (
      SELECT 
        attributed_template_id, 
        direction, 
        delivery_status, 
        detected_intent, 
        is_opt_out, 
        thread_key, 
        current_stage, 
        next_stage, 
        seller_phone,
        market_id,
        message_body,
        COUNT(*) OVER (PARTITION BY attributed_template_id, market_id) as market_count
      FROM attributed_messages
    ) sub2
    WHERE attributed_template_id IS NOT NULL
    GROUP BY attributed_template_id
  ),
  funnel_metrics AS (
    SELECT
      t.attributed_template_id AS template_id,
      COUNT(DISTINCT o.offer_id) AS offers_created_count,
      COUNT(DISTINCT c.contract_id) AS contracts_created_count,
      COUNT(DISTINCT cl.closing_id) FILTER (WHERE cl.status = 'closed_won') AS closed_won_count,
      SUM(CASE WHEN cl.status = 'closed_won' THEN 5000 ELSE 0 END) AS estimated_revenue
    FROM attributed_messages t
    LEFT JOIN public.offers o ON t.prospect_id = o.prospect_id OR t.property_id = o.property_id
    LEFT JOIN public.contracts c ON o.offer_id = c.offer_id
    LEFT JOIN public.closings cl ON c.contract_id = cl.contract_id
    WHERE t.direction = 'outbound'
    GROUP BY t.attributed_template_id
  ),
  final_calc AS (
    SELECT
      bt.*,
      COALESCE(tm.total_queued, 0) AS total_queued,
      COALESCE(tm.total_sent, 0) AS total_sent,
      COALESCE(tm.total_delivered, 0) AS total_delivered,
      COALESCE(tm.total_failed, 0) AS total_failed,
      COALESCE(tm.total_inbound_replies, 0) AS total_reply_count,
      COALESCE(tm.unique_seller_replies, 0) AS unique_seller_replies,
      COALESCE(tm.positive_interest_count, 0) AS positive_interest_count,
      COALESCE(tm.ownership_confirmed_count, 0) AS ownership_confirmed_count,
      COALESCE(tm.stop_count, 0) AS opt_out_count,
      COALESCE(tm.wrong_number_count, 0) AS wrong_number_count,
      COALESCE(tm.hostile_or_legal_count, 0) AS hostile_or_legal_count,
      COALESCE(tm.stage_advanced_count, 0) AS stage_advanced_count,
      COALESCE(fm.offers_created_count, 0) AS offers_created_count,
      COALESCE(fm.contracts_created_count, 0) AS contracts_created_count,
      COALESCE(fm.closed_won_count, 0) AS closed_won_count,
      COALESCE(fm.estimated_revenue, 0)::numeric AS estimated_revenue,
      CASE WHEN COALESCE(tm.total_sent, 0) > 0 THEN (tm.total_delivered::numeric / tm.total_sent) * 100 ELSE 0 END AS delivery_rate,
      CASE WHEN COALESCE(tm.total_delivered, 0) > 0 THEN (tm.unique_seller_replies::numeric / tm.total_delivered) * 100 ELSE 0 END AS reply_rate,
      CASE WHEN COALESCE(tm.unique_seller_replies, 0) > 0 THEN (tm.positive_interest_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS positive_interest_rate,
      CASE WHEN COALESCE(tm.total_delivered, 0) > 0 THEN (tm.stop_count::numeric / tm.total_delivered) * 100 ELSE 0 END AS opt_out_rate,
      CASE WHEN COALESCE(tm.total_delivered, 0) > 0 THEN (tm.hostile_or_legal_count::numeric / tm.total_delivered) * 100 ELSE 0 END AS hostile_rate,
      COALESCE(tm.markets_json, '{}'::jsonb) as top_markets,
      '{}'::jsonb as agent_performance, -- placeholder
      COALESCE(tm.samples_json, '[]'::jsonb) as sample_inbound
    FROM base_templates bt
    LEFT JOIN template_metrics tm ON bt.template_id = tm.template_id
    LEFT JOIN funnel_metrics fm ON bt.template_id = fm.template_id
  ),
  with_scores AS (
    SELECT
      *,
      (
        (delivery_rate * 0.15) +
        (reply_rate * 0.20) +
        (positive_interest_rate * 0.25) +
        (CASE WHEN unique_seller_replies > 0 THEN (stage_advanced_count::numeric / unique_seller_replies) * 100 ELSE 0 END * 0.20) +
        ((100 - LEAST(100, opt_out_rate * 500)) * 0.15)
      )::numeric AS overall_score
    FROM final_calc
  )
  SELECT
    *,
    CASE 
      WHEN opt_out_rate > 8 OR hostile_rate > 2 THEN 'PAUSE'
      WHEN opt_out_rate > 5 OR hostile_rate > 1 THEN 'RISKY'
      WHEN total_sent < 25 THEN 'LOW_DATA'
      WHEN overall_score > 75 AND opt_out_rate < 3 AND hostile_rate < 1 THEN 'SCALE'
      WHEN overall_score > 40 THEN 'TESTING'
      ELSE 'WATCHLIST'
    END AS recommendation,
    CASE
      WHEN opt_out_rate > 5 OR hostile_rate > 1 THEN 'HIGH'
      WHEN opt_out_rate > 3 OR hostile_rate > 0.5 THEN 'MEDIUM'
      ELSE 'LOW'
    END AS risk_level
  FROM with_scores
  WHERE (total_sent >= p_min_sent)
    AND (p_recommendation IS NULL OR (CASE 
      WHEN opt_out_rate > 8 OR hostile_rate > 2 THEN 'PAUSE'
      WHEN opt_out_rate > 5 OR hostile_rate > 1 THEN 'RISKY'
      WHEN total_sent < 25 THEN 'LOW_DATA'
      WHEN overall_score > 75 AND opt_out_rate < 3 AND hostile_rate < 1 THEN 'SCALE'
      WHEN overall_score > 40 THEN 'TESTING'
      ELSE 'WATCHLIST'
    END) = p_recommendation)
    AND (p_risk_level IS NULL OR (CASE
      WHEN opt_out_rate > 5 OR hostile_rate > 1 THEN 'HIGH'
      WHEN opt_out_rate > 3 OR hostile_rate > 0.5 THEN 'MEDIUM'
      ELSE 'LOW'
    END) = p_risk_level)
  ORDER BY overall_score DESC;
END;
$$;
