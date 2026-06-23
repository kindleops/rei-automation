-- Restore live inbox v2 primary views as lightweight compatibility adapters.
--
-- Source of truth: public.v_inbox_enriched is the active canonical inbox row
-- source in production. The previous live-v2 draft rebuilt threads from
-- message_events and context joins, which is heavier than cockpit initial boot
-- needs. These views keep the primary API names stable while reusing the
-- canonical inbox source and one shared bucket/status resolver.

DROP VIEW IF EXISTS public.v_inbox_thread_counts_live_v2;
DROP VIEW IF EXISTS public.v_inbox_threads_live_v2;

ALTER TABLE public.message_events
  ADD COLUMN IF NOT EXISTS provider_delivery_status text,
  ADD COLUMN IF NOT EXISTS raw_carrier_status text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS error_message text;

ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_reason text,
  ADD COLUMN IF NOT EXISTS guard_reason text,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS paused_reason text;

CREATE INDEX IF NOT EXISTS idx_message_events_thread_outbound_latest
  ON public.message_events (
    thread_key,
    (coalesce(event_timestamp, sent_at, delivered_at, created_at)) DESC,
    created_at DESC,
    id DESC
  )
  WHERE thread_key IS NOT NULL
    AND lower(coalesce(direction, '')) LIKE 'out%';

CREATE INDEX IF NOT EXISTS idx_send_queue_thread_latest
  ON public.send_queue (
    thread_key,
    (coalesce(updated_at, delivered_at, sent_at, scheduled_for_utc, scheduled_for, created_at)) DESC,
    created_at DESC,
    id DESC
  )
  WHERE thread_key IS NOT NULL;

CREATE OR REPLACE VIEW public.v_inbox_threads_live_v2
WITH (security_invoker = true) AS
WITH enriched AS (
  SELECT
    e.*,
    lower(coalesce(e.latest_direction, '')) AS _direction,
    lower(coalesce(e.inbox_category, '')) AS _category,
    lower(coalesce(e.ui_intent, e.detected_intent, '')) AS _intent,
    lower(coalesce(e.stage, '')) AS _stage,
    lower(coalesce(e.status, '')) AS _status
  FROM public.v_inbox_enriched e
  WHERE nullif(e.thread_key, '') IS NOT NULL
),
classified AS (
  SELECT
    e.*,
    CASE
      WHEN e._direction LIKE 'in%' THEN 'inbound'
      WHEN e._direction LIKE 'out%' THEN 'outbound'
      ELSE nullif(e.latest_direction, '')
    END AS resolved_latest_message_direction,
    (
      coalesce(e.is_suppressed, false)
      OR e._category IN ('dnc_opt_out', 'suppressed')
      OR e._intent IN ('opt_out', 'stop', 'unsubscribe', 'dnc', 'do_not_contact')
    ) AS resolved_opt_out,
    (
      e._intent IN ('wrong_number', 'wrong_person', 'deceased')
      OR e._status IN ('wrong_number')
      OR e._stage IN ('wrong_number')
    ) AS resolved_wrong_number,
    (
      e._intent IN ('not_interested', 'negative', 'hostile', 'hostile_or_legal')
      OR e._status IN ('not_interested')
      OR e._stage IN ('not_interested')
    ) AS resolved_not_interested,
    (
      e._category IN ('automated', 'needs_review', 'manual_review')
      OR e._status IN ('needs_review', 'review_required')
      OR e._stage IN ('needs_review', 'review_required')
      OR e._intent IN ('property_correction', 'unclear')
    ) AS resolved_needs_review,
    (
      e._category IN ('hot_leads', 'priority')
      OR coalesce(e.show_in_priority_inbox, false)
      OR coalesce(e.is_hot_lead, false)
      OR e._intent IN (
        'seller_interested',
        'qualified_lead',
        'asking_price_provided',
        'asks_offer',
        'wants_offer',
        'offer_requested',
        'contract_ready',
        'price_anchor',
        'ownership_confirmed',
        'needs_call',
        'callback_requested',
        'latent_interest'
      )
    ) AS resolved_priority
  FROM enriched e
),
bucketed AS (
  SELECT
    c.*,
    CASE
      WHEN c.resolved_opt_out THEN 'suppressed'
      WHEN c.resolved_wrong_number
        OR c.resolved_not_interested
        OR c._category IN ('dead', 'wrong_number')
        OR c._stage = 'dead'
      THEN 'dead'
      WHEN c._category = 'hot_leads' THEN 'priority'
      WHEN c._category = 'new_inbound' THEN 'new_replies'
      WHEN c._category = 'automated' THEN 'needs_review'
      WHEN c._category = 'outbound_active' THEN 'follow_up'
      WHEN c._category = 'cold_no_response' THEN 'cold'
      WHEN c.resolved_needs_review THEN 'needs_review'
      WHEN c.resolved_priority THEN 'priority'
      WHEN c.resolved_latest_message_direction = 'inbound' THEN 'new_replies'
      WHEN c._category IN ('outbound_active', 'follow_up', 'follow_up_due') THEN 'follow_up'
      WHEN c.last_inbound_at IS NOT NULL THEN 'follow_up'
      ELSE 'cold'
    END AS resolved_inbox_bucket
  FROM classified c
)
SELECT
  b.thread_key AS canonical_thread_key,
  b.thread_key,
  b.thread_key AS id,
  1::integer AS thread_row_number,
  'v_inbox_enriched'::text AS latest_message_source,
  NULL::text AS latest_message_event_id,
  coalesce(b.property_id, b.final_property_id) AS property_id,
  coalesce(b.master_owner_id, b.final_master_owner_id) AS master_owner_id,
  b.final_prospect_id AS prospect_id,
  coalesce(b.property_id, b.final_property_id) AS selected_property_id,
  coalesce(b.property_id, b.final_property_id) AS thread_property_id,
  coalesce(b.master_owner_id, b.final_master_owner_id) AS thread_master_owner_id,
  b.final_prospect_id AS thread_prospect_id,
  coalesce(b.best_phone, b.seller_phone, b.display_phone, b.thread_key) AS canonical_e164,
  coalesce(b.seller_phone, b.best_phone, b.display_phone, b.thread_key) AS seller_phone,
  coalesce(b.best_phone, b.seller_phone, b.display_phone, b.thread_key) AS best_phone,
  coalesce(b.best_phone, b.seller_phone, b.display_phone, b.thread_key) AS phone,
  coalesce(b.display_phone, b.best_phone, b.seller_phone, b.thread_key) AS display_phone,
  NULL::text AS our_number,
  b.latest_message_at,
  b.latest_message_at AS latest_activity_at,
  b.latest_message_at AS last_message_at,
  coalesce(b.latest_message_body, b.preview) AS latest_message_body,
  b.resolved_latest_message_direction AS latest_message_direction,
  b.resolved_latest_message_direction AS direction,
  NULL::text AS delivery_status,
  NULL::text AS provider_delivery_status,
  NULL::text AS latest_delivery_status,
  NULL::text AS latest_provider_delivery_status,
  NULL::timestamptz AS latest_delivered_at,
  NULL::timestamptz AS latest_failed_at,
  NULL::text AS latest_failure_reason,
  b.last_outbound_at,
  b.last_inbound_at,
  b.automation_status AS auto_reply_status,
  coalesce(nullif(b.stage, ''), 'ownership_check') AS current_stage,
  coalesce(nullif(b.detected_intent, ''), nullif(b.ui_intent, '')) AS detected_intent,
  b.resolved_inbox_bucket AS inbox_bucket,
  CASE
    WHEN b.resolved_inbox_bucket = 'suppressed' THEN 'suppressed'
    WHEN b.resolved_inbox_bucket = 'dead' THEN 'dead'
    WHEN b.resolved_inbox_bucket = 'needs_review' THEN 'needs_review'
    WHEN b.resolved_latest_message_direction = 'outbound' THEN 'awaiting_response'
    ELSE 'active'
  END AS universal_status,
  coalesce(nullif(b.stage, ''), 'ownership_check') AS universal_stage,
  coalesce(nullif(b.stage, ''), 'ownership_check') AS conversation_stage,
  coalesce(b.owner_display_name, b.display_name, b.event_seller_display_name) AS owner_name,
  split_part(coalesce(b.owner_display_name, b.display_name, b.event_seller_display_name, ''), ' ', 1) AS seller_first_name,
  coalesce(b.display_name, b.owner_display_name, b.event_seller_display_name) AS seller_display_name,
  coalesce(b.property_address_full, b.display_address, b.event_property_address) AS property_address_full,
  b.city AS property_address_city,
  b.state AS property_state,
  b.zip AS property_zip,
  NULL::text AS property_county_name,
  coalesce(b.display_market, b.market) AS market,
  b.latitude,
  b.longitude,
  coalesce(b.property_type, b.filter_property_type) AS property_type,
  NULL::text AS property_class,
  b.estimated_value,
  NULL::numeric AS estimated_arv,
  NULL::numeric AS equity_percent,
  b.cash_offer,
  b.final_acquisition_score,
  b.priority_score,
  CASE
    WHEN b.resolved_inbox_bucket = 'priority' THEN 'hot'
    WHEN b.resolved_latest_message_direction = 'inbound' THEN 'warm'
    WHEN b.last_inbound_at IS NOT NULL THEN 'neutral'
    ELSE 'cold'
  END AS lead_temperature,
  coalesce(nullif(b.detected_intent, ''), nullif(b.ui_intent, '')) AS reply_intent,
  coalesce(b.message_count, 0)::integer AS message_count,
  coalesce(b.inbound_count, 0)::integer AS inbound_count,
  coalesce(b.outbound_count, 0)::integer AS outbound_count,
  CASE
    WHEN b.resolved_latest_message_direction = 'inbound'
      AND coalesce(b.is_read, false) = false
      AND b.resolved_inbox_bucket NOT IN ('dead', 'suppressed')
    THEN 1
    ELSE 0
  END AS unread_count,
  b.resolved_opt_out AS opt_out,
  b.resolved_wrong_number AS wrong_number,
  b.resolved_not_interested AS not_interested,
  b.resolved_needs_review AS needs_review,
  b.automation_status AS queue_status,
  CASE WHEN b.resolved_inbox_bucket = 'suppressed' THEN 'suppressed' ELSE NULL::text END AS suppression_status,
  CASE WHEN b.resolved_inbox_bucket = 'suppressed' THEN coalesce(nullif(b.ui_intent, ''), 'suppressed') ELSE NULL::text END AS suppression_type,
  NULL::timestamptz AS suppression_until,
  NULL::integer AS touch_count,
  NULL::timestamptz AS last_touch_at,
  CASE
    WHEN b.property_id IS NOT NULL THEN 'v_inbox_enriched.property_id'
    WHEN b.final_property_id IS NOT NULL THEN 'v_inbox_enriched.final_property_id'
    ELSE 'no_property_match'
  END AS selected_property_reason,
  1::integer AS duplicate_property_count,
  'v_inbox_enriched'::text AS enrichment_match_strategy,
  jsonb_strip_nulls(jsonb_build_object(
    'property_id', coalesce(b.property_id, b.final_property_id),
    'property_address_full', coalesce(b.property_address_full, b.display_address, b.event_property_address),
    'market', coalesce(b.display_market, b.market),
    'property_type', coalesce(b.property_type, b.filter_property_type),
    'estimated_value', b.estimated_value,
    'cash_offer', b.cash_offer,
    'final_acquisition_score', b.final_acquisition_score
  )) AS property_data,
  jsonb_strip_nulls(jsonb_build_object(
    'master_owner_id', coalesce(b.master_owner_id, b.final_master_owner_id),
    'display_name', coalesce(b.owner_display_name, b.display_name, b.event_seller_display_name),
    'priority_score', b.owner_priority_score
  )) AS master_owner_data,
  jsonb_strip_nulls(jsonb_build_object(
    'prospect_id', b.final_prospect_id,
    'display_name', coalesce(b.prospect_full_name, b.display_name),
    'first_name', b.prospect_first_name,
    'best_phone', coalesce(b.prospect_best_phone, b.best_phone, b.seller_phone)
  )) AS prospect_data,
  jsonb_strip_nulls(jsonb_build_object(
    'best_phone', b.best_phone,
    'seller_phone', b.seller_phone,
    'display_phone', b.display_phone,
    'carrier', b.phone_carrier
  )) AS phone_data,
  NULL::jsonb AS email_data,
  jsonb_strip_nulls(jsonb_build_object(
    'is_read', b.is_read,
    'is_starred', b.is_starred,
    'is_pinned', b.is_pinned,
    'is_archived', b.is_archived,
    'follow_up_at', b.follow_up_at
  )) AS thread_state_data,
  NULL::jsonb AS campaign_data,
  jsonb_strip_nulls(jsonb_build_object(
    'pending_queue_count', b.pending_queue_count,
    'automation_status', b.automation_status,
    'queue_status', b.automation_status
  )) AS queue_data,
  CASE WHEN b.resolved_inbox_bucket = 'suppressed' THEN jsonb_build_object('status', 'suppressed') ELSE NULL::jsonb END AS suppression_data,
  NULL::jsonb AS valuation_data,
  NULL::jsonb AS buyer_match_data,
  jsonb_strip_nulls(jsonb_build_object(
    'thread_key', b.thread_key,
    'latest_message_at', b.latest_message_at,
    'latest_direction', b.latest_direction,
    'latest_message_body', coalesce(b.latest_message_body, b.preview),
    'detected_intent', coalesce(nullif(b.detected_intent, ''), nullif(b.ui_intent, '')),
    'latest_delivery_status', NULL::text,
    'latest_provider_delivery_status', NULL::text,
    'latest_delivered_at', NULL::timestamptz,
    'latest_failed_at', NULL::timestamptz,
    'latest_failure_reason', NULL::text
  )) AS latest_message_event_data,
  coalesce(b.latest_message_at, b.last_inbound_at, b.last_outbound_at) AS created_at,
  coalesce(b.latest_message_at, b.last_inbound_at, b.last_outbound_at) AS updated_at,
  b.preview,
  b.inbox_category,
  b.status AS display_status,
  b.stage,
  b.show_in_priority_inbox,
  b.is_suppressed,
  b.is_read,
  b.is_starred,
  b.is_pinned,
  b.is_archived,
  b.is_hot_lead,
  b.event_seller_display_name,
  b.owner_display_name,
  b.display_name,
  b.display_address,
  b.display_market,
  b.filter_property_type,
  b.follow_up_at,
  b.pending_queue_count
FROM bucketed b;

CREATE OR REPLACE VIEW public.v_inbox_thread_counts_live_v2
WITH (security_invoker = true) AS
WITH enriched AS (
  SELECT
    e.*,
    lower(coalesce(e.latest_direction, '')) AS _direction,
    lower(coalesce(e.inbox_category, '')) AS _category,
    lower(coalesce(e.ui_intent, e.detected_intent, '')) AS _intent,
    lower(coalesce(e.stage, '')) AS _stage,
    lower(coalesce(e.status, '')) AS _status
  FROM public.v_inbox_enriched e
  WHERE nullif(e.thread_key, '') IS NOT NULL
),
classified AS (
  SELECT
    e.*,
    CASE
      WHEN e._direction LIKE 'in%' THEN 'inbound'
      WHEN e._direction LIKE 'out%' THEN 'outbound'
      ELSE nullif(e.latest_direction, '')
    END AS latest_message_direction,
    (
      coalesce(e.is_suppressed, false)
      OR e._category IN ('dnc_opt_out', 'suppressed')
      OR e._intent IN ('opt_out', 'stop', 'unsubscribe', 'dnc', 'do_not_contact')
    ) AS resolved_opt_out,
    (
      e._intent IN ('wrong_number', 'wrong_person', 'deceased')
      OR e._status IN ('wrong_number')
      OR e._stage IN ('wrong_number')
    ) AS resolved_wrong_number,
    (
      e._intent IN ('not_interested', 'negative', 'hostile', 'hostile_or_legal')
      OR e._status IN ('not_interested')
      OR e._stage IN ('not_interested')
    ) AS resolved_not_interested,
    (
      e._category IN ('automated', 'needs_review', 'manual_review')
      OR e._status IN ('needs_review', 'review_required')
      OR e._stage IN ('needs_review', 'review_required')
      OR e._intent IN ('property_correction', 'unclear')
    ) AS resolved_needs_review,
    (
      e._category IN ('hot_leads', 'priority')
      OR coalesce(e.show_in_priority_inbox, false)
      OR coalesce(e.is_hot_lead, false)
      OR e._intent IN (
        'seller_interested',
        'qualified_lead',
        'asking_price_provided',
        'asks_offer',
        'wants_offer',
        'offer_requested',
        'contract_ready',
        'price_anchor',
        'ownership_confirmed',
        'needs_call',
        'callback_requested',
        'latent_interest'
      )
    ) AS resolved_priority
  FROM enriched e
),
bucketed AS (
  SELECT
    c.latest_message_direction,
    coalesce(c.property_id, c.final_property_id) AS property_id,
    1::integer AS duplicate_property_count,
    CASE
      WHEN c.resolved_opt_out THEN 'suppressed'
      WHEN c.resolved_wrong_number
        OR c.resolved_not_interested
        OR c._category IN ('dead', 'wrong_number')
        OR c._stage = 'dead'
      THEN 'dead'
      WHEN c._category = 'hot_leads' THEN 'priority'
      WHEN c._category = 'new_inbound' THEN 'new_replies'
      WHEN c._category = 'automated' THEN 'needs_review'
      WHEN c._category = 'outbound_active' THEN 'follow_up'
      WHEN c._category = 'cold_no_response' THEN 'cold'
      WHEN c.resolved_needs_review THEN 'needs_review'
      WHEN c.resolved_priority THEN 'priority'
      WHEN c.latest_message_direction = 'inbound' THEN 'new_replies'
      WHEN c._category IN ('outbound_active', 'follow_up', 'follow_up_due') THEN 'follow_up'
      WHEN c.last_inbound_at IS NOT NULL THEN 'follow_up'
      ELSE 'cold'
    END AS inbox_bucket
  FROM classified c
)
SELECT
  COUNT(*)::bigint AS all,
  COUNT(*)::bigint AS all_messages,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority')::bigint AS priority,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority')::bigint AS hot_leads,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies')::bigint AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies')::bigint AS new_inbound,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies')::bigint AS needs_reply,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')::bigint AS needs_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')::bigint AS manual_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review')::bigint AS automated,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up')::bigint AS follow_up,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up')::bigint AS outbound_active,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold')::bigint AS cold,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold')::bigint AS cold_no_response,
  COUNT(*) FILTER (WHERE inbox_bucket = 'dead')::bigint AS dead,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed')::bigint AS suppressed,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed')::bigint AS dnc_opt_out,
  COUNT(*) FILTER (
    WHERE inbox_bucket IN ('priority', 'new_replies', 'needs_review', 'follow_up')
  )::bigint AS active,
  COUNT(*) FILTER (
    WHERE latest_message_direction = 'outbound'
      AND inbox_bucket NOT IN ('dead', 'suppressed')
  )::bigint AS waiting,
  COUNT(*) FILTER (
    WHERE latest_message_direction = 'outbound'
      AND inbox_bucket NOT IN ('dead', 'suppressed')
  )::bigint AS waiting_on_seller,
  COUNT(*) FILTER (WHERE property_id IS NULL)::bigint AS unlinked,
  COUNT(*) FILTER (WHERE duplicate_property_count > 1)::bigint AS duplicate_property_threads
FROM bucketed;

GRANT SELECT ON public.v_inbox_threads_live_v2 TO anon, authenticated, service_role;
GRANT SELECT ON public.v_inbox_thread_counts_live_v2 TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
