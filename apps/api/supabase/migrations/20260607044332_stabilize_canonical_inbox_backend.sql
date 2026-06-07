-- ============================================================================
-- Canonical inbox backend stabilization.
-- ============================================================================
-- Cold is a deterministic subset of Waiting:
--   inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
-- This makes the API predicate selective without a category-only full scan.
--
-- Delivery is hydrated for the visible page from message_events in the API.
-- Keeping the global latest-outbound DISTINCT ON join out of this view avoids
-- rescanning the delivery table for every filtered inbox request.
--
-- "no inbound after the last outbound" = last_inbound_at IS NULL
--                                        OR last_inbound_at < last_outbound_at
-- ============================================================================

DROP VIEW IF EXISTS public.canonical_inbox_counts;
DROP VIEW IF EXISTS public.canonical_inbox_threads;

CREATE VIEW public.canonical_inbox_threads
WITH (security_invoker = true) AS
WITH suppressed_phones AS (
  SELECT DISTINCT phone FROM (
    SELECT phone_e164  AS phone FROM public.sms_suppression_list WHERE is_active = true AND phone_e164  IS NOT NULL
    UNION
    SELECT phone_number AS phone FROM public.sms_suppression_list WHERE is_active = true AND phone_number IS NOT NULL
  ) s
)
SELECT
  t.canonical_thread_key, t.thread_key, t.id, t.thread_row_number, t.latest_message_source,
  t.latest_message_event_id, t.property_id, t.master_owner_id, t.prospect_id, t.selected_property_id,
  t.thread_property_id, t.thread_master_owner_id, t.thread_prospect_id, t.canonical_e164, t.seller_phone,
  t.best_phone, t.phone, t.display_phone, t.our_number, t.latest_message_at, t.latest_activity_at,
  t.last_message_at, t.latest_message_body, t.latest_message_direction, t.direction, t.delivery_status,
  t.provider_delivery_status, t.latest_delivery_status, t.latest_provider_delivery_status, t.latest_delivered_at,
  t.latest_failed_at, t.latest_failure_reason, t.last_outbound_at, t.last_inbound_at, t.auto_reply_status,
  t.current_stage, t.detected_intent, t.universal_status, t.universal_stage, t.conversation_stage,
  t.owner_name, t.seller_first_name, t.seller_display_name, t.property_address_full, t.property_address_city,
  t.property_state, t.property_zip, t.property_county_name, t.market, t.latitude, t.longitude,
  t.property_type, t.property_class, t.estimated_value, t.estimated_arv, t.equity_percent, t.cash_offer,
  t.final_acquisition_score, t.priority_score, t.lead_temperature, t.reply_intent, t.message_count,
  t.inbound_count, t.outbound_count, t.unread_count, t.opt_out, t.wrong_number, t.not_interested,
  t.needs_review, t.queue_status, t.suppression_status, t.suppression_type, t.suppression_until,
  t.touch_count, t.last_touch_at, t.selected_property_reason, t.duplicate_property_count,
  t.enrichment_match_strategy, t.property_data, t.master_owner_data, t.prospect_data, t.phone_data,
  t.email_data, t.thread_state_data, t.campaign_data, t.queue_data, t.suppression_data, t.valuation_data,
  t.buyer_match_data, t.latest_message_event_data, t.created_at, t.updated_at, t.preview,
  CASE
    WHEN COALESCE(t.wrong_number, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('wrong_number','wrong_person','deceased','hostile','hostile_or_legal','legal_threat')
      THEN 'dead'
    WHEN COALESCE(t.opt_out, false)
         OR COALESCE(t.is_suppressed, false)
         OR lower(COALESCE(t.suppression_status, '')) = 'suppressed'
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) = 'opt_out'
         OR sp.phone IS NOT NULL
      THEN 'dnc_opt_out'
    WHEN COALESCE(t.is_hot_lead, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('seller_interested','qualified_lead','asking_price_provided','asks_offer','wants_offer',
             'offer_requested','contract_ready','price_anchor','ownership_confirmed','needs_call',
             'callback_requested','latent_interest','need_more_money','send_offer_first')
      THEN 'hot_leads'
    WHEN lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('unclear','property_correction','who_is_this','is_tenant','is_realtor','reaction_only')
      THEN 'needs_review'
    WHEN lower(COALESCE(t.latest_message_direction, '')) LIKE 'in%'
         AND t.latest_message_at >= now() - interval '14 days'
      THEN 'new_inbound'
    WHEN COALESCE(t.not_interested, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('not_interested','negative','not_for_sale','need_time')
      THEN 'outbound_active'
    WHEN t.last_outbound_at IS NOT NULL
         AND t.last_outbound_at >= now() - interval '24 hours'
         AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at)
      THEN 'waiting_on_seller'
    WHEN t.last_inbound_at IS NOT NULL
         AND (t.last_outbound_at IS NULL OR t.last_inbound_at >= t.last_outbound_at)
      THEN 'outbound_active'
    ELSE 'cold_no_response'
  END AS inbox_category,
  t.display_status, t.stage, t.show_in_priority_inbox, t.is_suppressed, t.is_read, t.is_starred, t.is_pinned,
  t.is_archived, t.is_hot_lead, t.event_seller_display_name, t.owner_display_name, t.display_name,
  t.display_address, t.display_market, t.filter_property_type, t.follow_up_at, t.pending_queue_count,
  CASE
    WHEN COALESCE(t.wrong_number, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('wrong_number','wrong_person','deceased','hostile','hostile_or_legal','legal_threat')
      THEN 'dead'
    WHEN COALESCE(t.opt_out, false)
         OR COALESCE(t.is_suppressed, false)
         OR lower(COALESCE(t.suppression_status, '')) = 'suppressed'
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) = 'opt_out'
         OR sp.phone IS NOT NULL
      THEN 'suppressed'
    WHEN COALESCE(t.is_hot_lead, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('seller_interested','qualified_lead','asking_price_provided','asks_offer','wants_offer',
             'offer_requested','contract_ready','price_anchor','ownership_confirmed','needs_call',
             'callback_requested','latent_interest','need_more_money','send_offer_first')
      THEN 'priority'
    WHEN lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN
            ('unclear','property_correction','who_is_this','is_tenant','is_realtor','reaction_only')
      THEN 'needs_review'
    WHEN lower(COALESCE(t.latest_message_direction, '')) LIKE 'in%'
         AND t.latest_message_at >= now() - interval '14 days'
      THEN 'new_replies'
    -- soft-negative nurture stays follow_up regardless of outbound recency
    WHEN COALESCE(t.not_interested, false)
         OR lower(COALESCE(t.detected_intent, t.reply_intent, '')) IN ('not_interested','negative','not_for_sale','need_time')
      THEN 'follow_up'
    -- WAITING includes the cold/no-response subset. inbox_category separates
    -- fresh waiting rows from cold rows without introducing another bucket.
    WHEN t.last_outbound_at IS NOT NULL
         AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at)
      THEN 'waiting'
    -- replied after our last outbound (older than the 14d new_replies window) -> follow_up
    WHEN t.last_inbound_at IS NOT NULL
         AND (t.last_outbound_at IS NULL OR t.last_inbound_at >= t.last_outbound_at)
      THEN 'follow_up'
    -- Never-contacted rows are also cold/no-response members of Waiting.
    ELSE 'waiting'
  END AS inbox_bucket
FROM public.v_inbox_threads_live_v2 t
LEFT JOIN suppressed_phones sp ON sp.phone = t.canonical_e164;

COMMENT ON VIEW public.canonical_inbox_threads IS
  'Canonical inbox row source. Cold is the waiting/cold_no_response subset. Delivery is hydrated per visible page by the API.';

CREATE VIEW public.canonical_inbox_counts
WITH (security_invoker = true) AS
SELECT
  count(*) AS "all",
  count(*) AS all_messages,
  count(*) FILTER (WHERE inbox_bucket = 'priority')     AS priority,
  count(*) FILTER (WHERE inbox_bucket = 'priority')     AS hot_leads,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')  AS new_replies,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')  AS new_inbound,
  count(*) FILTER (WHERE inbox_bucket = 'new_replies')  AS needs_reply,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review') AS needs_review,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review') AS manual_review,
  count(*) FILTER (WHERE inbox_bucket = 'needs_review') AS automated,
  count(*) FILTER (WHERE inbox_bucket = 'follow_up')    AS follow_up,
  count(*) FILTER (WHERE inbox_bucket = 'follow_up')    AS outbound_active,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response') AS cold,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response') AS cold_no_response,
  count(*) FILTER (WHERE inbox_bucket = 'dead')         AS dead,
  count(*) FILTER (WHERE inbox_bucket = 'suppressed')   AS suppressed,
  count(*) FILTER (WHERE inbox_bucket = 'suppressed')   AS dnc_opt_out,
  -- WAITING bucket counts
  count(*) FILTER (WHERE inbox_bucket = 'waiting')      AS waiting,
  count(*) FILTER (WHERE inbox_bucket = 'waiting')      AS waiting_on_seller,
  count(*) FILTER (WHERE inbox_bucket IN ('priority','new_replies','needs_review','follow_up','waiting')) AS active,
  count(*) FILTER (WHERE property_id IS NULL)           AS unlinked,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
                    AND COALESCE(last_outbound_at, latest_message_at) < now() - interval '24 hours') AS cold_24h,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
                    AND COALESCE(last_outbound_at, latest_message_at) < now() - interval '3 days') AS cold_3d,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
                    AND COALESCE(last_outbound_at, latest_message_at) < now() - interval '7 days') AS cold_7d,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
                    AND COALESCE(last_outbound_at, latest_message_at) < now() - interval '14 days') AS cold_14d,
  count(*) FILTER (WHERE inbox_bucket = 'waiting' AND inbox_category = 'cold_no_response'
                    AND COALESCE(last_outbound_at, latest_message_at) < now() - interval '30 days') AS cold_30d
FROM public.canonical_inbox_threads;

COMMENT ON VIEW public.canonical_inbox_counts IS
  'Canonical count source. Cold uses the same waiting/cold_no_response predicate as the live API.';
