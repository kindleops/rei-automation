CREATE INDEX IF NOT EXISTS idx_message_events_canonical_thread_key_live_v2
  ON public.message_events (
    (
      COALESCE(
        NULLIF(thread_key, ''),
        NULLIF(to_phone_number, ''),
        NULLIF(from_phone_number, ''),
        NULLIF(canonical_e164, '')
      )
    ),
    (COALESCE(event_timestamp, received_at, sent_at, delivered_at, created_at)) DESC,
    created_at DESC
  );

DROP VIEW IF EXISTS public.v_inbox_thread_counts_live_v2;
DROP VIEW IF EXISTS public.v_inbox_threads_live_v2;

CREATE OR REPLACE VIEW public.v_inbox_threads_live_v2
WITH (security_invoker = true) AS
WITH base_events AS (
  SELECT
    me.*,
    COALESCE(
      NULLIF(me.thread_key, ''),
      NULLIF(me.to_phone_number, ''),
      NULLIF(me.from_phone_number, ''),
      NULLIF(me.canonical_e164, '')
    ) AS canonical_thread_key,
    COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.delivered_at, me.created_at) AS message_at,
    CASE
      WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN 'inbound'
      WHEN LOWER(COALESCE(me.direction, '')) LIKE 'out%' THEN 'outbound'
      ELSE LOWER(NULLIF(me.direction, ''))
    END AS normalized_direction,
    COALESCE(
      NULLIF(me.canonical_e164, ''),
      NULLIF(me.seller_phone, ''),
      CASE
        WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.from_phone_number, '')
        ELSE NULLIF(me.to_phone_number, '')
      END,
      CASE
        WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.to_phone_number, '')
        ELSE NULLIF(me.from_phone_number, '')
      END
    ) AS resolved_canonical_e164,
    CASE
      WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.from_phone_number, '')
      ELSE NULLIF(me.to_phone_number, '')
    END AS counterparty_phone,
    CASE
      WHEN LOWER(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.to_phone_number, '')
      ELSE NULLIF(me.from_phone_number, '')
    END AS participant_our_number,
    COALESCE(
      NULLIF(me.stage_after, ''),
      NULLIF(me.current_stage, ''),
      NULLIF(me.metadata->>'stage_after', ''),
      NULLIF(me.metadata->>'current_stage', '')
    ) AS resolved_current_stage,
    COALESCE(
      NULLIF(me.detected_intent, ''),
      NULLIF(me.metadata->>'detected_intent', '')
    ) AS resolved_detected_intent,
    COALESCE(
      NULLIF(me.auto_reply_status, ''),
      NULLIF(me.metadata->>'auto_reply_status', '')
    ) AS resolved_auto_reply_status,
    COALESCE(
      NULLIF(me.priority, ''),
      NULLIF(me.metadata->>'priority', '')
    ) AS resolved_priority,
    COALESCE(
      NULLIF(me.risk, ''),
      NULLIF(me.metadata->>'risk', '')
    ) AS resolved_risk,
    COALESCE(
      NULLIF(me.delivery_status, ''),
      NULLIF(me.raw_carrier_status, ''),
      NULLIF(me.provider_delivery_status, '')
    ) AS resolved_delivery_status,
    COALESCE(
      NULLIF(me.provider_delivery_status, ''),
      NULLIF(me.delivery_status, ''),
      NULLIF(me.raw_carrier_status, '')
    ) AS resolved_provider_delivery_status,
    CASE
      WHEN COALESCE(me.is_opt_out, false) THEN true
      WHEN LOWER(COALESCE(me.detected_intent, me.metadata->>'detected_intent', '')) IN ('opt_out', 'stop', 'unsubscribe', 'dnc', 'do_not_contact') THEN true
      WHEN LOWER(COALESCE(me.metadata->>'is_opt_out', 'false')) IN ('true', 't', '1', 'yes') THEN true
      ELSE false
    END AS inferred_opt_out,
    CASE
      WHEN LOWER(COALESCE(me.detected_intent, me.metadata->>'detected_intent', '')) IN ('wrong_number', 'wrong_person', 'deceased') THEN true
      WHEN LOWER(COALESCE(me.metadata->>'is_wrong_number', 'false')) IN ('true', 't', '1', 'yes') THEN true
      ELSE false
    END AS inferred_wrong_number,
    CASE
      WHEN LOWER(COALESCE(me.detected_intent, me.metadata->>'detected_intent', '')) IN ('not_interested', 'negative', 'hostile', 'hostile_or_legal') THEN true
      WHEN LOWER(COALESCE(me.metadata->>'is_not_interested', 'false')) IN ('true', 't', '1', 'yes') THEN true
      ELSE false
    END AS inferred_not_interested,
    CASE
      WHEN LOWER(COALESCE(me.risk, '')) IN ('review', 'high', 'manual_review') THEN true
      WHEN LOWER(COALESCE(me.safety_status, '')) IN ('review', 'manual_review', 'blocked') THEN true
      WHEN LOWER(COALESCE(me.metadata->>'needs_review', 'false')) IN ('true', 't', '1', 'yes') THEN true
      WHEN COALESCE(me.classification_confidence, 1) < 0.50 THEN true
      ELSE false
    END AS inferred_needs_review,
    CASE
      WHEN LOWER(COALESCE(me.detected_intent, me.metadata->>'detected_intent', '')) IN (
        'seller_interested',
        'qualified_lead',
        'asking_price_provided',
        'asks_offer',
        'wants_offer',
        'offer_requested',
        'contract_ready',
        'price_anchor',
        'ownership_confirmed'
      ) THEN true
      WHEN LOWER(COALESCE(me.priority, me.metadata->>'priority', '')) IN ('high', 'urgent') THEN true
      WHEN LOWER(COALESCE(me.metadata->>'is_hot_lead', 'false')) IN ('true', 't', '1', 'yes') THEN true
      ELSE false
    END AS inferred_priority
  FROM public.message_events me
  WHERE COALESCE(
    NULLIF(me.thread_key, ''),
    NULLIF(me.to_phone_number, ''),
    NULLIF(me.from_phone_number, ''),
    NULLIF(me.canonical_e164, '')
  ) IS NOT NULL
),
ranked_events AS (
  SELECT
    be.*,
    ROW_NUMBER() OVER (
      PARTITION BY be.canonical_thread_key
      ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC
    ) AS thread_row_number
  FROM base_events be
),
thread_rollups AS (
  SELECT
    be.canonical_thread_key,
    COUNT(*)::integer AS message_count,
    COUNT(*) FILTER (WHERE be.normalized_direction = 'inbound')::integer AS inbound_count,
    COUNT(*) FILTER (WHERE be.normalized_direction = 'outbound')::integer AS outbound_count,
    MIN(be.message_at) AS first_message_at,
    MAX(be.message_at) FILTER (WHERE be.normalized_direction = 'inbound') AS last_inbound_at,
    MAX(be.message_at) FILTER (WHERE be.normalized_direction = 'outbound') AS last_outbound_at,
    COUNT(DISTINCT be.property_id) FILTER (WHERE NULLIF(be.property_id, '') IS NOT NULL)::integer AS event_property_count,
    (
      ARRAY_AGG(be.property_id ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.property_id, '') IS NOT NULL)
    )[1] AS recent_property_id,
    (
      ARRAY_AGG(be.master_owner_id ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.master_owner_id, '') IS NOT NULL)
    )[1] AS recent_master_owner_id,
    (
      ARRAY_AGG(be.prospect_id ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.prospect_id, '') IS NOT NULL)
    )[1] AS recent_prospect_id,
    (
      ARRAY_AGG(be.resolved_canonical_e164 ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.resolved_canonical_e164, '') IS NOT NULL)
    )[1] AS recent_canonical_e164,
    (
      ARRAY_AGG(be.counterparty_phone ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.counterparty_phone, '') IS NOT NULL)
    )[1] AS recent_counterparty_phone,
    (
      ARRAY_AGG(be.participant_our_number ORDER BY be.message_at DESC NULLS LAST, be.created_at DESC NULLS LAST, be.id DESC)
      FILTER (WHERE NULLIF(be.participant_our_number, '') IS NOT NULL)
    )[1] AS recent_our_number,
    BOOL_OR(be.inferred_opt_out) AS any_opt_out,
    BOOL_OR(be.inferred_wrong_number) AS any_wrong_number,
    BOOL_OR(be.inferred_not_interested) AS any_not_interested,
    BOOL_OR(be.inferred_needs_review) AS any_needs_review,
    BOOL_OR(be.inferred_priority) AS any_priority
  FROM base_events be
  GROUP BY be.canonical_thread_key
),
latest_events AS (
  SELECT re.*
  FROM ranked_events re
  WHERE re.thread_row_number = 1
),
resolved_threads AS (
  SELECT
    le.canonical_thread_key,
    le.id AS latest_message_event_id,
    le.message_at AS latest_message_at,
    le.message_body AS latest_message_body,
    le.normalized_direction AS latest_message_direction,
    le.resolved_delivery_status AS delivery_status,
    le.resolved_provider_delivery_status AS provider_delivery_status,
    le.resolved_auto_reply_status AS auto_reply_status,
    le.resolved_current_stage AS current_stage,
    le.resolved_detected_intent AS detected_intent,
    le.property_id AS latest_event_property_id,
    COALESCE(le.property_id, tr.recent_property_id) AS thread_property_id,
    COALESCE(le.master_owner_id, tr.recent_master_owner_id) AS thread_master_owner_id,
    COALESCE(le.prospect_id, tr.recent_prospect_id) AS thread_prospect_id,
    COALESCE(
      le.resolved_canonical_e164,
      tr.recent_canonical_e164,
      tr.recent_counterparty_phone,
      le.canonical_thread_key
    ) AS canonical_e164,
    COALESCE(
      le.counterparty_phone,
      tr.recent_counterparty_phone,
      le.resolved_canonical_e164,
      le.canonical_thread_key
    ) AS seller_phone,
    COALESCE(le.participant_our_number, tr.recent_our_number) AS our_number,
    tr.message_count,
    tr.inbound_count,
    tr.outbound_count,
    tr.first_message_at,
    tr.last_inbound_at,
    tr.last_outbound_at,
    tr.event_property_count AS duplicate_property_count,
    le.inferred_opt_out OR tr.any_opt_out AS opt_out,
    le.inferred_wrong_number OR tr.any_wrong_number AS wrong_number,
    le.inferred_not_interested OR tr.any_not_interested AS not_interested,
    le.inferred_needs_review OR tr.any_needs_review AS needs_review,
    le.inferred_priority OR tr.any_priority AS priority_signal,
    TO_JSONB(le) AS raw_latest_message_event_data
  FROM latest_events le
  JOIN thread_rollups tr
    ON tr.canonical_thread_key = le.canonical_thread_key
),
selected_context AS (
  SELECT
    rt.*,
    COALESCE(ctx.property_id, rt.thread_property_id) AS selected_property_id,
    COALESCE(ctx.master_owner_id, rt.thread_master_owner_id) AS selected_master_owner_id,
    COALESCE(ctx.prospect_id, rt.thread_prospect_id) AS selected_prospect_id,
    GREATEST(rt.duplicate_property_count, COALESCE(ctx_stats.property_candidate_count, 0)) AS duplicate_property_count_live,
    ctx.owner_name AS context_owner_name,
    ctx.seller_first_name AS context_seller_first_name,
    ctx.property_address_full AS context_property_address_full,
    ctx.property_address_city AS context_property_address_city,
    ctx.property_state AS context_property_state,
    ctx.property_zip AS context_property_zip,
    ctx.property_county_name AS context_property_county_name,
    ctx.market AS context_market,
    ctx.latitude AS context_latitude,
    ctx.longitude AS context_longitude,
    ctx.property_type AS context_property_type,
    ctx.property_class AS context_property_class,
    ctx.estimated_value AS context_estimated_value,
    ctx.estimated_arv AS context_estimated_arv,
    ctx.equity_percent AS context_equity_percent,
    ctx.cash_offer AS context_cash_offer,
    ctx.final_acquisition_score AS context_final_acquisition_score,
    ctx.priority_score AS context_priority_score,
    ctx.universal_status AS context_universal_status,
    ctx.universal_stage AS context_universal_stage,
    ctx.inbox_bucket AS context_inbox_bucket,
    ctx.queue_status AS context_queue_status,
    ctx.suppression_status AS context_suppression_status,
    ctx.suppression_type AS context_suppression_type,
    ctx.property_data,
    ctx.master_owner_data,
    ctx.prospect_data,
    ctx.phone_data,
    ctx.email_data,
    ctx.thread_state_data,
    ctx.campaign_data,
    ctx.queue_data,
    ctx.suppression_data,
    ctx.valuation_data,
    ctx.buyer_match_data,
    ctx.latest_message_event_data,
    COALESCE(ctx.selected_property_reason, CASE
      WHEN rt.latest_event_property_id IS NOT NULL THEN 'latest_event_property_id'
      WHEN rt.thread_property_id IS NOT NULL THEN 'most_recent_thread_property'
      ELSE 'no_property_match'
    END) AS selected_property_reason,
    COALESCE(ctx.enrichment_match_strategy, CASE
      WHEN rt.thread_property_id IS NOT NULL THEN 'direct_thread_property'
      ELSE 'no_enrichment_match'
    END) AS enrichment_match_strategy
  FROM resolved_threads rt
  LEFT JOIN LATERAL (
    SELECT
      COUNT(DISTINCT dci.property_id)::integer AS property_candidate_count
    FROM public.deal_context_index dci
    WHERE dci.property_id IS NOT NULL
      AND (
        (rt.thread_master_owner_id IS NOT NULL AND dci.master_owner_id = rt.thread_master_owner_id)
        OR (rt.canonical_e164 IS NOT NULL AND dci.canonical_e164 = rt.canonical_e164)
      )
  ) ctx_stats ON true
  LEFT JOIN LATERAL (
    SELECT
      dci.*,
      CASE
        WHEN rt.latest_event_property_id IS NOT NULL AND dci.property_id = rt.latest_event_property_id THEN 'latest_event_property_id'
        WHEN rt.latest_event_property_id IS NULL AND rt.thread_property_id IS NOT NULL AND dci.property_id = rt.thread_property_id THEN 'most_recent_thread_property'
        WHEN rt.thread_master_owner_id IS NOT NULL AND dci.master_owner_id = rt.thread_master_owner_id THEN 'highest_final_acquisition_score_property'
        WHEN rt.canonical_e164 IS NOT NULL AND dci.canonical_e164 = rt.canonical_e164 THEN 'highest_final_acquisition_score_property'
        ELSE 'first_property_fallback'
      END AS selected_property_reason,
      CASE
        WHEN rt.latest_event_property_id IS NOT NULL AND dci.property_id = rt.latest_event_property_id THEN 'deal_context_index.property_id'
        WHEN rt.thread_property_id IS NOT NULL AND dci.property_id = rt.thread_property_id THEN 'deal_context_index.recent_property'
        WHEN rt.thread_master_owner_id IS NOT NULL AND dci.master_owner_id = rt.thread_master_owner_id THEN 'deal_context_index.master_owner_id'
        WHEN rt.canonical_e164 IS NOT NULL AND dci.canonical_e164 = rt.canonical_e164 THEN 'deal_context_index.canonical_e164'
        ELSE 'deal_context_index.fallback'
      END AS enrichment_match_strategy
    FROM public.deal_context_index dci
    WHERE dci.property_id IS NOT NULL
      AND (
        (rt.latest_event_property_id IS NOT NULL AND dci.property_id = rt.latest_event_property_id)
        OR (rt.thread_property_id IS NOT NULL AND dci.property_id = rt.thread_property_id)
        OR (rt.thread_master_owner_id IS NOT NULL AND dci.master_owner_id = rt.thread_master_owner_id)
        OR (rt.canonical_e164 IS NOT NULL AND dci.canonical_e164 = rt.canonical_e164)
      )
    ORDER BY
      CASE
        WHEN rt.latest_event_property_id IS NOT NULL AND dci.property_id = rt.latest_event_property_id THEN 1
        WHEN rt.latest_event_property_id IS NULL AND rt.thread_property_id IS NOT NULL AND dci.property_id = rt.thread_property_id THEN 2
        WHEN rt.thread_master_owner_id IS NOT NULL AND dci.master_owner_id = rt.thread_master_owner_id THEN 3
        WHEN rt.canonical_e164 IS NOT NULL AND dci.canonical_e164 = rt.canonical_e164 THEN 4
        ELSE 5
      END,
      COALESCE(dci.final_acquisition_score, -1) DESC NULLS LAST,
      COALESCE(dci.latest_message_at, dci.updated_at, dci.created_at) DESC NULLS LAST,
      dci.property_id ASC
    LIMIT 1
  ) ctx ON true
)
SELECT
  sc.canonical_thread_key,
  sc.canonical_thread_key AS thread_key,
  sc.canonical_thread_key AS id,
  1::integer AS thread_row_number,
  'message_events'::text AS latest_message_source,
  sc.latest_message_event_id::text AS latest_message_event_id,
  COALESCE(sc.selected_property_id, sc.thread_property_id) AS property_id,
  COALESCE(sc.selected_master_owner_id, sc.thread_master_owner_id) AS master_owner_id,
  COALESCE(sc.selected_prospect_id, sc.thread_prospect_id) AS prospect_id,
  sc.selected_property_id,
  sc.thread_property_id,
  sc.thread_master_owner_id,
  sc.thread_prospect_id,
  COALESCE(sc.canonical_e164, pr.best_phone) AS canonical_e164,
  COALESCE(sc.seller_phone, sc.canonical_e164, pr.best_phone) AS seller_phone,
  COALESCE(sc.canonical_e164, sc.seller_phone, pr.best_phone) AS best_phone,
  COALESCE(sc.canonical_e164, sc.seller_phone, pr.best_phone) AS phone,
  COALESCE(sc.canonical_e164, sc.seller_phone, pr.best_phone) AS display_phone,
  sc.our_number,
  sc.latest_message_at,
  sc.latest_message_at AS latest_activity_at,
  sc.latest_message_at AS last_message_at,
  sc.latest_message_body,
  sc.latest_message_direction,
  sc.latest_message_direction AS direction,
  sc.delivery_status,
  sc.provider_delivery_status,
  sc.last_outbound_at,
  sc.last_inbound_at,
  COALESCE(sc.auto_reply_status, sc.context_queue_status) AS auto_reply_status,
  COALESCE(sc.current_stage, sc.context_universal_stage, 'ownership_check') AS current_stage,
  COALESCE(sc.detected_intent, sc.latest_message_event_data->>'detected_intent') AS detected_intent,
  CASE
    WHEN COALESCE(cos.suppression_until > NOW(), false)
      OR COALESCE(sc.context_suppression_status, '') = 'suppressed'
      OR sc.opt_out THEN 'suppressed'
    WHEN sc.wrong_number OR sc.not_interested THEN 'dead'
    WHEN sc.needs_review THEN 'needs_review'
    WHEN sc.priority_signal AND sc.latest_message_direction = 'inbound' THEN 'priority'
    WHEN sc.latest_message_direction = 'inbound' THEN 'new_replies'
    WHEN sc.last_inbound_at IS NOT NULL THEN 'follow_up'
    ELSE 'cold'
  END AS inbox_bucket,
  CASE
    WHEN COALESCE(cos.suppression_until > NOW(), false)
      OR COALESCE(sc.context_suppression_status, '') = 'suppressed'
      OR sc.opt_out THEN 'suppressed'
    WHEN sc.wrong_number OR sc.not_interested THEN 'dead'
    WHEN sc.latest_message_direction = 'inbound' THEN 'seller_replied'
    WHEN sc.last_outbound_at IS NOT NULL THEN 'awaiting_response'
    ELSE 'active'
  END AS universal_status,
  COALESCE(sc.current_stage, sc.context_universal_stage, 'ownership_check') AS universal_stage,
  COALESCE(sc.current_stage, sc.context_universal_stage, 'ownership_check') AS conversation_stage,
  COALESCE(
    sc.context_owner_name,
    mo.display_name,
    pr.full_name,
    sc.latest_message_event_data->>'seller_display_name',
    sc.master_owner_data->>'display_name'
  ) AS owner_name,
  COALESCE(
    sc.context_seller_first_name,
    pr.first_name,
    SPLIT_PART(COALESCE(pr.full_name, mo.display_name, sc.context_owner_name, ''), ' ', 1),
    NULL
  ) AS seller_first_name,
  COALESCE(
    sc.latest_message_event_data->>'seller_display_name',
    pr.full_name,
    mo.display_name,
    sc.context_owner_name
  ) AS seller_display_name,
  COALESCE(
    sc.context_property_address_full,
    p.property_address_full,
    p.property_address,
    sc.property_data->>'property_address_full',
    sc.latest_message_event_data->>'property_address'
  ) AS property_address_full,
  COALESCE(
    sc.context_property_address_city,
    p.property_address_city,
    sc.property_data->>'property_address_city'
  ) AS property_address_city,
  COALESCE(
    sc.context_property_state,
    p.property_state,
    p.property_address_state,
    sc.property_data->>'property_state'
  ) AS property_state,
  COALESCE(
    sc.context_property_zip,
    p.property_zip,
    p.property_address_zip,
    sc.property_data->>'property_zip'
  ) AS property_zip,
  COALESCE(
    sc.context_property_county_name,
    p.property_county_name,
    p.property_address_county_name,
    sc.property_data->>'property_county_name'
  ) AS property_county_name,
  COALESCE(
    sc.context_market,
    p.market,
    mo.routing_market,
    pr.primary_market,
    sc.latest_message_event_data->>'market'
  ) AS market,
  COALESCE(sc.context_latitude, p.latitude) AS latitude,
  COALESCE(sc.context_longitude, p.longitude) AS longitude,
  COALESCE(sc.context_property_type, p.property_type, sc.property_data->>'property_type') AS property_type,
  COALESCE(sc.context_property_class, p.property_class, sc.property_data->>'property_class') AS property_class,
  COALESCE(sc.context_estimated_value, p.estimated_value) AS estimated_value,
  COALESCE(sc.context_estimated_arv, NULLIF(sc.valuation_data->'property_valuation_snapshot'->>'estimated_arv', '')::numeric) AS estimated_arv,
  COALESCE(sc.context_equity_percent, p.equity_percent) AS equity_percent,
  COALESCE(sc.context_cash_offer, p.cash_offer) AS cash_offer,
  COALESCE(sc.context_final_acquisition_score, p.final_acquisition_score) AS final_acquisition_score,
  COALESCE(sc.context_priority_score, mo.priority_score, pr.master_owner_priority_score) AS priority_score,
  CASE
    WHEN sc.priority_signal THEN 'hot'
    WHEN sc.latest_message_direction = 'inbound' THEN 'warm'
    WHEN sc.last_inbound_at IS NOT NULL THEN 'neutral'
    ELSE 'cold'
  END AS lead_temperature,
  COALESCE(sc.detected_intent, sc.latest_message_event_data->>'detected_intent') AS reply_intent,
  sc.message_count,
  sc.inbound_count,
  sc.outbound_count,
  CASE
    WHEN sc.latest_message_direction = 'inbound'
      AND NOT sc.opt_out
      AND NOT sc.wrong_number
      AND NOT sc.not_interested THEN 1
    ELSE 0
  END AS unread_count,
  sc.opt_out,
  sc.wrong_number,
  sc.not_interested,
  sc.needs_review,
  COALESCE(sc.context_queue_status, sc.queue_data->>'queue_status') AS queue_status,
  CASE
    WHEN COALESCE(cos.suppression_until > NOW(), false)
      OR COALESCE(sc.context_suppression_status, '') = 'suppressed'
      OR sc.opt_out THEN 'suppressed'
    ELSE NULL
  END AS suppression_status,
  COALESCE(sc.context_suppression_type, cos.suppression_reason) AS suppression_type,
  cos.suppression_until,
  cos.touch_count,
  cos.last_touch_at,
  sc.selected_property_reason,
  sc.duplicate_property_count_live AS duplicate_property_count,
  sc.enrichment_match_strategy,
  COALESCE(sc.property_data, TO_JSONB(p)) AS property_data,
  COALESCE(sc.master_owner_data, TO_JSONB(mo)) AS master_owner_data,
  COALESCE(sc.prospect_data, TO_JSONB(pr)) AS prospect_data,
  sc.phone_data,
  sc.email_data,
  sc.thread_state_data,
  sc.campaign_data,
  sc.queue_data,
  COALESCE(sc.suppression_data, TO_JSONB(cos)) AS suppression_data,
  sc.valuation_data,
  sc.buyer_match_data,
  COALESCE(sc.latest_message_event_data, sc.raw_latest_message_event_data) AS latest_message_event_data,
  sc.first_message_at AS created_at,
  GREATEST(
    sc.latest_message_at,
    COALESCE(p.updated_at, p.created_at, sc.latest_message_at),
    COALESCE(mo.updated_at, mo.created_at, sc.latest_message_at),
    COALESCE(pr.updated_at, pr.created_at, sc.latest_message_at),
    COALESCE(cos.updated_at, cos.created_at, sc.latest_message_at)
  ) AS updated_at
FROM selected_context sc
LEFT JOIN public.properties p
  ON p.property_id = COALESCE(sc.selected_property_id, sc.thread_property_id)
LEFT JOIN public.master_owners mo
  ON mo.master_owner_id = COALESCE(sc.selected_master_owner_id, sc.thread_master_owner_id, p.master_owner_id)
LEFT JOIN LATERAL (
  SELECT prx.*
  FROM public.prospects prx
  WHERE
    (sc.selected_prospect_id IS NOT NULL AND prx.prospect_id = sc.selected_prospect_id)
    OR (sc.selected_master_owner_id IS NOT NULL AND prx.master_owner_id = sc.selected_master_owner_id)
    OR (sc.canonical_e164 IS NOT NULL AND prx.best_phone = sc.canonical_e164)
  ORDER BY
    CASE
      WHEN sc.selected_prospect_id IS NOT NULL AND prx.prospect_id = sc.selected_prospect_id THEN 1
      WHEN sc.selected_master_owner_id IS NOT NULL AND prx.master_owner_id = sc.selected_master_owner_id AND COALESCE(prx.is_primary_prospect, false) THEN 2
      WHEN sc.selected_master_owner_id IS NOT NULL AND prx.master_owner_id = sc.selected_master_owner_id THEN 3
      WHEN sc.canonical_e164 IS NOT NULL AND prx.best_phone = sc.canonical_e164 THEN 4
      ELSE 5
    END,
    prx.rank_position NULLS LAST,
    prx.phone_score_final DESC NULLS LAST,
    prx.contact_score_final DESC NULLS LAST,
    COALESCE(prx.updated_at, prx.created_at) DESC NULLS LAST
  LIMIT 1
) pr ON true
LEFT JOIN public.contact_outreach_state cos
  ON cos.podio_master_owner_id = COALESCE(sc.selected_master_owner_id, sc.thread_master_owner_id, p.master_owner_id)
  AND cos.to_phone_number = COALESCE(sc.canonical_e164, sc.seller_phone);

CREATE OR REPLACE VIEW public.v_inbox_thread_counts_live_v2
WITH (security_invoker = true) AS
SELECT
  COUNT(*)::bigint AS all,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority')::bigint AS priority,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies')::bigint AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')::bigint AS needs_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up')::bigint AS follow_up,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold')::bigint AS cold,
  COUNT(*) FILTER (WHERE inbox_bucket = 'dead')::bigint AS dead,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed')::bigint AS suppressed,
  COUNT(*) FILTER (
    WHERE inbox_bucket IN ('priority', 'new_replies', 'needs_review', 'follow_up')
  )::bigint AS active,
  COUNT(*) FILTER (
    WHERE latest_message_direction = 'outbound'
      AND inbox_bucket NOT IN ('dead', 'suppressed')
  )::bigint AS waiting,
  COUNT(*) FILTER (WHERE property_id IS NULL)::bigint AS unlinked,
  COUNT(*) FILTER (WHERE duplicate_property_count > 1)::bigint AS duplicate_property_threads
FROM public.v_inbox_threads_live_v2;

GRANT SELECT ON public.v_inbox_threads_live_v2 TO anon, authenticated, service_role;
GRANT SELECT ON public.v_inbox_thread_counts_live_v2 TO anon, authenticated, service_role;
