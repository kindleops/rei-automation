-- 1. Create the operator_thread_state table
CREATE TABLE IF NOT EXISTS public.operator_thread_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_key TEXT UNIQUE NOT NULL,
    canonical_e164 TEXT,
    master_owner_id TEXT,
    property_id TEXT,
    inbox_bucket TEXT,
    seller_stage TEXT,
    conversation_stage TEXT,
    lead_temperature TEXT,
    review_status TEXT,
    follow_up_status TEXT,
    follow_up_at TIMESTAMPTZ,
    assigned_operator TEXT,
    suppression_status TEXT,
    notes TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.operator_thread_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access" ON public.operator_thread_state FOR ALL USING (true);
CREATE POLICY "Allow authenticated read write" ON public.operator_thread_state FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. Create the v_operator_inbox_threads view
CREATE OR REPLACE VIEW public.v_operator_inbox_threads AS
WITH me_with_joins AS (
  SELECT 
    me.id AS message_event_id,
    me.thread_key AS me_thread_key,
    me.queue_id AS me_queue_id,
    me.provider_message_sid,
    me.to_phone_number,
    me.from_phone_number,
    me.direction,
    me.message_body,
    me.created_at AS message_created_at,
    me.event_type,
    me.property_id AS me_property_id,
    me.master_owner_id AS me_master_owner_id,
    me.phone_number_id AS me_phone_number_id,
    me.market_id AS me_market_id,
    me.metadata AS me_metadata,
    
    sq.thread_key AS sq_thread_key,
    sq.id AS sq_id,
    sq.property_id AS sq_property_id,
    sq.master_owner_id AS sq_master_owner_id,
    sq.phone_number_id AS sq_phone_number_id,
    sq.market_id AS sq_market_id,
    sq.queue_key,
    sq.queue_status,
    sq.type AS queue_type,
    sq.scheduled_for,
    sq.sent_at AS sq_sent_at,
    sq.delivered_at AS sq_delivered_at,
    NULL::TIMESTAMPTZ AS sq_failed_at,
    sq.current_stage AS thread_stage,
    sq.detected_intent AS last_intent,
    sq.ai_confidence AS classification_confidence,
    
    -- Hydration priority logic for phone
    LEAST(me.to_phone_number, me.from_phone_number) || ':' || GREATEST(me.to_phone_number, me.from_phone_number) AS phone_pair,
    
    p.property_id AS p_id,
    p.property_address_full AS p_address_full,
    p.property_address_city AS p_city,
    p.property_address_state AS p_state,
    p.property_address_zip AS p_zip,
    p.market AS p_market,
    
    mo.master_owner_id AS mo_id,
    mo.display_name AS mo_full_name,
    
    pr.prospect_id AS pr_id,
    pr.full_name AS pr_name,
    pr.first_name AS pr_first_name,
    
    ph.phone_id AS ph_id,
    ph.canonical_e164 AS ph_phone_number
  FROM public.message_events me
  LEFT JOIN public.send_queue sq ON me.queue_id = sq.id
  LEFT JOIN public.properties p ON p.property_id = COALESCE(me.property_id, sq.property_id)
  LEFT JOIN public.master_owners mo ON mo.master_owner_id = COALESCE(me.master_owner_id, sq.master_owner_id, p.master_owner_id)
  LEFT JOIN public.prospects pr ON pr.master_owner_id = COALESCE(me.master_owner_id, sq.master_owner_id, p.master_owner_id) OR pr.best_phone IN (me.to_phone_number, me.from_phone_number)
  LEFT JOIN public.phones ph ON ph.phone_id = COALESCE(me.phone_number_id, sq.phone_number_id)::TEXT OR ph.canonical_e164 IN (me.to_phone_number, me.from_phone_number)
),
resolved_threads AS (
  SELECT 
    *,
    COALESCE(
      me_thread_key,
      sq_thread_key,
      me_queue_id::TEXT,
      provider_message_sid,
      phone_pair,
      CONCAT(COALESCE(me_property_id, sq_property_id)::TEXT, ':', COALESCE(me_master_owner_id, sq_master_owner_id)::TEXT),
      message_event_id::TEXT
    ) AS resolved_thread_key
  FROM me_with_joins
),
thread_aggregates AS (
  SELECT 
    resolved_thread_key AS thread_key,
    MAX(message_created_at) AS latest_message_at,
    (array_agg(message_body ORDER BY message_created_at DESC))[1] AS latest_message_body,
    (array_agg(direction ORDER BY message_created_at DESC))[1] AS latest_direction,
    (array_agg(event_type ORDER BY message_created_at DESC))[1] AS latest_message_status,
    COUNT(*) AS message_count,
    COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound_count,
    COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound_count,
    COUNT(*) FILTER (WHERE event_type = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE event_type = 'delivered') AS delivered_count,
    COUNT(*) FILTER (WHERE event_type = 'sent') AS sent_count,
    (array_agg(message_created_at ORDER BY message_created_at DESC) FILTER (WHERE direction = 'inbound'))[1] AS latest_inbound_at,
    (array_agg(message_created_at ORDER BY message_created_at DESC) FILTER (WHERE direction = 'outbound'))[1] AS latest_outbound_at,
    
    COALESCE(MAX(me_property_id), MAX(sq_property_id), MAX(p_id)) AS resolved_property_id,
    COALESCE(MAX(me_master_owner_id), MAX(sq_master_owner_id), MAX(mo_id)) AS resolved_master_owner_id,
    
    MAX(to_phone_number) AS to_phone_number,
    MAX(from_phone_number) AS from_phone_number,
    
    CASE WHEN MAX(direction) = 'inbound' THEN MAX(from_phone_number) ELSE MAX(to_phone_number) END AS seller_phone,
    CASE WHEN MAX(direction) = 'outbound' THEN MAX(from_phone_number) ELSE MAX(to_phone_number) END AS selected_textgrid_number,
    
    -- computed state values
    MAX(thread_stage) AS thread_stage,
    MAX(last_intent) AS detected_intent,
    MAX(classification_confidence) AS ai_state,
    
    -- auto tags
    BOOL_OR(
        message_body ILIKE ANY(ARRAY['%stop%', '%unsubscribe%', '%wrong number%', '%wrong person%', '%do not text%', '%lawyer%', '%attorney%', '%legal%', '%harassment%', '%not interested%'])
        OR me_metadata->>'intent' IN ('stop', 'unsubscribe', 'dnc')
    ) AS is_suppressed_auto,
    BOOL_OR(me_metadata->>'intent' IN ('stop', 'unsubscribe', 'dnc') OR message_body ILIKE ANY(ARRAY['%stop%', '%unsubscribe%'])) AS opt_out_auto,
    BOOL_OR(message_body ILIKE ANY(ARRAY['%wrong number%', '%wrong person%'])) AS wrong_number_auto,
    BOOL_OR(message_body ILIKE ANY(ARRAY['%not interested%'])) AS not_interested_auto,
    BOOL_OR(
        message_body ILIKE ANY(ARRAY['%yes%', '%interested%', '%offer%', '%cash%', '%how much%', '%price%', '%asking price%', '%call me%', '%open to selling%', '%maybe%', '%depends%', '%what can you offer%'])
        OR me_metadata->>'intent' IN ('interested', 'hot_lead')
    ) AS positive_reply_auto,
    BOOL_OR(me_metadata->>'intent' = 'asking_price_provided') AS asking_price_detected_auto,
    BOOL_OR(me_metadata->>'intent' = 'ownership_confirmed') AS ownership_confirmed_auto,
    BOOL_OR(me_metadata->>'needs_review' = 'true' OR classification_confidence < 0.5) AS needs_review_auto,
    
    MAX(p_address_full) AS p_address_full,
    MAX(p_city) AS p_city,
    MAX(p_state) AS p_state,
    MAX(p_zip) AS p_zip,
    MAX(p_market) AS p_market,
    MAX(mo_full_name) AS mo_full_name,
    MAX(pr_name) AS pr_name,
    MAX(pr_first_name) AS pr_first_name
  FROM resolved_threads
  GROUP BY resolved_thread_key
)
SELECT 
  ta.thread_key,
  ta.seller_phone AS canonical_e164,
  ta.seller_phone,
  COALESCE(ta.mo_full_name, ta.pr_name, 'Unknown Seller') AS seller_name,
  COALESCE(ta.pr_first_name, split_part(ta.mo_full_name, ' ', 1)) AS seller_first_name,
  ta.mo_full_name AS owner_name,
  ta.resolved_master_owner_id AS master_owner_id,
  ta.resolved_property_id AS property_id,
  ta.p_address_full AS property_address_full,
  ta.p_city AS property_city,
  ta.p_state AS property_state,
  ta.p_zip AS property_zip,
  ta.p_market AS market,
  NULL AS timezone,
  NULL AS campaign_id,
  NULL AS campaign_name,
  NULL AS campaign_target_id,
  ta.latest_message_at,
  ta.latest_message_body,
  ta.latest_direction,
  ta.latest_message_status,
  ta.detected_intent AS latest_intent,
  ta.ai_state AS latest_classification,
  NULL AS latest_template_id,
  ta.from_phone_number,
  ta.to_phone_number,
  ta.selected_textgrid_number,
  
  -- Computed inbox_bucket
  COALESCE(ots.inbox_bucket, 
    CASE 
      WHEN ta.is_suppressed_auto OR ta.opt_out_auto OR ta.wrong_number_auto THEN 'suppressed'
      WHEN ta.positive_reply_auto OR ta.asking_price_detected_auto OR ta.detected_intent IN ('seller_interested', 'ownership_confirmed', 'asking_price_provided', 'condition_disclosed', 'property_interest') THEN 'priority'
      WHEN ta.latest_direction = 'inbound' AND ta.needs_review_auto THEN 'needs_review'
      WHEN ta.latest_direction = 'inbound' THEN 'new_replies'
      WHEN ta.latest_direction = 'outbound' AND ta.inbound_count = 0 THEN 'cold'
      ELSE 'all'
    END
  ) AS inbox_bucket,
  
  COALESCE(ots.lead_temperature, 
    CASE WHEN ta.positive_reply_auto THEN 'hot' WHEN ta.inbound_count > 0 THEN 'warm' ELSE 'cold' END
  ) AS lead_temperature,
  
  COALESCE(ots.seller_stage, ta.thread_stage, 'S1 Ownership Check') AS seller_stage,
  COALESCE(ots.conversation_stage, 'ownership_check') AS conversation_stage,
  COALESCE(ots.review_status, CASE WHEN ta.needs_review_auto THEN 'needs_review' ELSE 'reviewed' END) AS review_status,
  ots.follow_up_at,
  ots.suppression_status AS suppression_type,
  
  ta.is_suppressed_auto AS is_suppressed,
  ta.opt_out_auto AS opt_out,
  ta.wrong_number_auto AS wrong_number,
  ta.not_interested_auto AS not_interested,
  ta.needs_review_auto AS needs_review,
  ta.positive_reply_auto AS positive_reply,
  ta.asking_price_detected_auto AS asking_price_detected,
  ta.ownership_confirmed_auto AS ownership_confirmed,
  
  CASE WHEN ta.latest_direction = 'inbound' THEN 1 ELSE 0 END AS unread_count,
  ta.inbound_count,
  ta.outbound_count,
  ta.delivered_count,
  ta.failed_count,
  ta.latest_outbound_at AS last_outbound_at,
  ta.latest_inbound_at AS last_inbound_at,
  MIN(ta.latest_message_at) OVER (PARTITION BY ta.thread_key) AS created_at,
  MAX(ta.latest_message_at) OVER (PARTITION BY ta.thread_key) AS updated_at,
  ots.metadata AS metadata
FROM thread_aggregates ta
LEFT JOIN public.operator_thread_state ots ON ta.thread_key = ots.thread_key;

GRANT SELECT ON public.v_operator_inbox_threads TO authenticated, anon;
