-- Ownership Check Template Analytics
-- Provides a comprehensive breakdown of template performance for the 'ownership_check' use case.

CREATE OR REPLACE VIEW public.ownership_check_template_kpis AS
WITH base_templates AS (
  SELECT 
    t.template_id,
    t.name AS template_name,
    t.use_case_slug,
    t.stage_code,
    t.language,
    t.agent_style AS tone,
    t.deal_strategy,
    t.is_first_touch,
    t.is_follow_up,
    COALESCE(t.template_text, t.body) AS template_text,
    t.active,
    t.created_at,
    t.updated_at,
    t.metadata
  FROM public.sms_templates t
  WHERE t.use_case_slug = 'ownership_check' 
     OR (t.metadata->>'use_case' = 'ownership_check')
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
    q.failure_code,
    q.failure_reason,
    COALESCE(m.market_id, q.market_id) AS market_id,
    COALESCE(m.sms_agent_id, q.sms_agent_id, q.selected_agent_id) AS sms_agent_id,
    m.seller_phone,
    m.prospect_id,
    m.property_id
  FROM public.message_events m
  LEFT JOIN public.send_queue q ON m.queue_id = q.id OR m.queue_id::text = q.queue_id
),
attributed_messages AS (
  SELECT
    *,
    -- Attribute template_id to inbound messages
    CASE 
      WHEN direction = 'outbound' THEN COALESCE(msg_template_id, queue_template_id)
      ELSE first_value(COALESCE(msg_template_id, queue_template_id)) OVER (
        PARTITION BY thread_key, grp 
        ORDER BY event_timestamp
      )
    END AS attributed_template_id,
    -- For stage progression
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
    
    -- Send Volume Metrics
    COUNT(*) FILTER (WHERE direction = 'outbound') AS total_queued,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status != 'failed') AS total_sent,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND (delivery_status = 'delivered' OR delivery_status = 'sent')) AS total_delivered,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status = 'failed') AS total_failed,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND (delivery_status = 'pending' OR delivery_status = 'queued')) AS total_pending,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status = 'paused') AS total_paused,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status = 'suppressed') AS total_suppressed,
    COUNT(*) FILTER (WHERE direction = 'outbound' AND delivery_status = 'cancelled') AS total_cancelled,
    
    MIN(event_timestamp) FILTER (WHERE direction = 'outbound') AS first_sent_at,
    MAX(event_timestamp) FILTER (WHERE direction = 'outbound') AS last_sent_at,
    
    -- Reply Metrics
    COUNT(*) FILTER (WHERE direction = 'inbound') AS total_inbound_replies,
    COUNT(DISTINCT seller_phone) FILTER (WHERE direction = 'inbound') AS unique_seller_replies,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND event_timestamp - event_timestamp < interval '24 hours') AS same_day_reply_count,
    
    -- Intent Metrics
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'seller_interested') AS positive_interest_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'info_request') AS info_request_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'price_question') AS price_question_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'condition_question') AS condition_question_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'ownership_confirmed') AS ownership_confirmed_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = 'not_interested' OR detected_intent = 'not_interested_polite')) AS not_interested_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'wrong_number') AS wrong_number_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (is_opt_out OR detected_intent = 'opt_out')) AS stop_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND (detected_intent = 'hostile' OR detected_intent = 'angry' OR detected_intent = 'not_interested_hostile')) AS hostile_or_legal_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'unclear') AS unclear_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'listed_realtor') AS listed_or_unavailable_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'tenant_occupancy') AS tenant_or_occupancy_count,
    COUNT(*) FILTER (WHERE direction = 'inbound' AND detected_intent = 'already_sold') AS already_sold_count,
    
    -- Stage Progression Metrics
    COUNT(DISTINCT thread_key) FILTER (WHERE direction = 'inbound' AND detected_intent = 'ownership_confirmed') AS ownership_confirmed_threads,
    COUNT(DISTINCT thread_key) FILTER (WHERE next_stage IS NOT NULL AND next_stage != current_stage AND next_stage != 'dead' AND next_stage != 'suppressed') AS stage_advanced_count,
    COUNT(DISTINCT thread_key) FILTER (WHERE next_stage = 'dead') AS dead_after_template_count,
    COUNT(DISTINCT thread_key) FILTER (WHERE next_stage = 'suppressed') AS suppressed_after_template_count,

    -- Market/Agent placeholders
    mode() WITHIN GROUP (ORDER BY market_id) AS top_performing_market_id,
    mode() WITHIN GROUP (ORDER BY sms_agent_id) AS top_performing_agent_id

  FROM attributed_messages
  WHERE attributed_template_id IS NOT NULL
  GROUP BY attributed_template_id
),
funnel_metrics AS (
  SELECT
    t.attributed_template_id AS template_id,
    COUNT(DISTINCT o.offer_id) AS offers_created_count,
    COUNT(DISTINCT c.contract_id) AS contracts_created_count,
    COUNT(DISTINCT cl.closing_id) FILTER (WHERE cl.status = 'closed_won') AS closed_won_count,
    SUM(CASE WHEN cl.status = 'closed_won' THEN 5000 ELSE 0 END) AS estimated_revenue_generated
  FROM attributed_messages t
  LEFT JOIN public.offers o ON t.prospect_id = o.prospect_id OR t.property_id = o.property_id
  LEFT JOIN public.contracts c ON o.offer_id = c.offer_id
  LEFT JOIN public.closings cl ON c.contract_id = cl.contract_id
  WHERE t.direction = 'outbound'
  GROUP BY t.attributed_template_id
)
SELECT
  bt.*,
  tm.total_queued,
  tm.total_sent,
  tm.total_delivered,
  tm.total_failed,
  tm.total_pending,
  tm.total_paused,
  tm.total_suppressed,
  tm.total_cancelled,
  tm.first_sent_at,
  tm.last_sent_at,
  tm.total_inbound_replies,
  tm.unique_seller_replies,
  tm.same_day_reply_count,
  
  -- Delivery Metrics
  CASE WHEN tm.total_sent > 0 THEN (tm.total_delivered::numeric / tm.total_sent) * 100 ELSE 0 END AS delivery_rate,
  CASE WHEN tm.total_sent > 0 THEN (tm.total_failed::numeric / tm.total_sent) * 100 ELSE 0 END AS failure_rate,
  
  -- Reply Metrics
  CASE WHEN tm.total_delivered > 0 THEN (tm.unique_seller_replies::numeric / tm.total_delivered) * 100 ELSE 0 END AS reply_rate,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.same_day_reply_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS same_day_reply_rate,
  
  -- Intent Metrics
  tm.positive_interest_count,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.positive_interest_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS positive_interest_rate,
  tm.ownership_confirmed_count,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.ownership_confirmed_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS ownership_confirmed_rate,
  tm.stop_count AS opt_out_count,
  CASE WHEN tm.total_delivered > 0 THEN (tm.stop_count::numeric / tm.total_delivered) * 100 ELSE 0 END AS opt_out_rate,
  tm.wrong_number_count,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.wrong_number_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS wrong_number_rate,
  tm.hostile_or_legal_count,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.hostile_or_legal_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS hostile_or_legal_rate,
  tm.info_request_count,
  tm.price_question_count,
  tm.condition_question_count,
  tm.unclear_count,
  tm.listed_or_unavailable_count,
  tm.tenant_or_occupancy_count,
  tm.already_sold_count,
  
  -- Stage Progression Metrics
  tm.stage_advanced_count,
  CASE WHEN tm.unique_seller_replies > 0 THEN (tm.stage_advanced_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END AS stage_advanced_rate,
  tm.dead_after_template_count,
  tm.suppressed_after_template_count,
  
  -- Funnel Metrics
  fm.offers_created_count,
  fm.contracts_created_count,
  fm.closed_won_count,
  fm.estimated_revenue_generated,
  
  -- Top Performers
  tm.top_performing_market_id,
  tm.top_performing_agent_id,
  
  -- Quality Scoring
  (
    (CASE WHEN tm.total_sent > 0 THEN (tm.total_delivered::numeric / tm.total_sent) * 100 ELSE 0 END * 0.15) +
    (CASE WHEN tm.total_delivered > 0 THEN (tm.unique_seller_replies::numeric / tm.total_delivered) * 100 ELSE 0 END * 0.20) +
    (CASE WHEN tm.unique_seller_replies > 0 THEN (tm.positive_interest_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END * 0.25) +
    (CASE WHEN tm.unique_seller_replies > 0 THEN (tm.stage_advanced_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END * 0.20) +
    ((100 - LEAST(100, CASE WHEN tm.total_delivered > 0 THEN (tm.stop_count::numeric / tm.total_delivered) * 500 ELSE 0 END)) * 0.15) +
    (CASE WHEN tm.total_delivered > 0 THEN (LEAST(100, (fm.estimated_revenue_generated::numeric / tm.total_delivered) / 100)) * 100 ELSE 0 END * 0.05)
  ) AS overall_template_score

FROM base_templates bt
LEFT JOIN template_metrics tm ON bt.template_id = tm.template_id
LEFT JOIN funnel_metrics fm ON bt.template_id = fm.template_id;


-- RPC for filtered analytics
CREATE OR REPLACE FUNCTION public.get_ownership_check_template_stats(
  start_date timestamptz DEFAULT NULL,
  end_date timestamptz DEFAULT NULL,
  p_market_id text DEFAULT NULL,
  p_agent_id text DEFAULT NULL,
  p_language text DEFAULT NULL,
  p_min_sent integer DEFAULT 0
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
  overall_score numeric
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
      m.property_id
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
      COUNT(DISTINCT thread_key) FILTER (WHERE next_stage IS NOT NULL AND next_stage != current_stage AND next_stage != 'dead' AND next_stage != 'suppressed') AS stage_advanced_count
    FROM attributed_messages
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
  )
  SELECT
    bt.template_id,
    bt.template_name,
    bt.use_case_slug,
    bt.stage_code,
    bt.language,
    bt.tone,
    bt.deal_strategy,
    bt.is_first_touch,
    bt.is_follow_up,
    bt.template_text,
    bt.active,
    COALESCE(tm.total_queued, 0),
    COALESCE(tm.total_sent, 0),
    COALESCE(tm.total_delivered, 0),
    COALESCE(tm.total_failed, 0),
    COALESCE(tm.total_inbound_replies, 0),
    COALESCE(tm.unique_seller_replies, 0),
    COALESCE(tm.positive_interest_count, 0),
    COALESCE(tm.ownership_confirmed_count, 0),
    COALESCE(tm.stop_count, 0),
    COALESCE(tm.wrong_number_count, 0),
    COALESCE(tm.hostile_or_legal_count, 0),
    COALESCE(tm.stage_advanced_count, 0),
    COALESCE(fm.offers_created_count, 0),
    COALESCE(fm.contracts_created_count, 0),
    COALESCE(fm.closed_won_count, 0),
    COALESCE(fm.estimated_revenue, 0)::numeric,
    (
      (CASE WHEN COALESCE(tm.total_sent, 0) > 0 THEN (tm.total_delivered::numeric / tm.total_sent) * 100 ELSE 0 END * 0.15) +
      (CASE WHEN COALESCE(tm.total_delivered, 0) > 0 THEN (tm.unique_seller_replies::numeric / tm.total_delivered) * 100 ELSE 0 END * 0.20) +
      (CASE WHEN COALESCE(tm.unique_seller_replies, 0) > 0 THEN (tm.positive_interest_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END * 0.25) +
      (CASE WHEN COALESCE(tm.unique_seller_replies, 0) > 0 THEN (tm.stage_advanced_count::numeric / tm.unique_seller_replies) * 100 ELSE 0 END * 0.20) +
      ((100 - LEAST(100, CASE WHEN COALESCE(tm.total_delivered, 0) > 0 THEN (tm.stop_count::numeric / tm.total_delivered) * 500 ELSE 0 END)) * 0.15)
    )::numeric AS overall_score
  FROM base_templates bt
  LEFT JOIN template_metrics tm ON bt.template_id = tm.template_id
  LEFT JOIN funnel_metrics fm ON bt.template_id = fm.template_id
  WHERE (COALESCE(tm.total_sent, 0) >= p_min_sent)
  ORDER BY overall_score DESC;
END;
$$;
