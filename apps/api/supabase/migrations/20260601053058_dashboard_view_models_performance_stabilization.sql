-- Dashboard data sync and performance stabilization.
--
-- These views provide stable, UI-shaped read models on top of the existing
-- canonical inbox/deal-context sources. They intentionally avoid another large
-- client-side hydration path: each dashboard surface can read a narrow prepared
-- shape and share the same IDs across thread, property, prospect, owner, phone,
-- message, and deal-intelligence records.

CREATE OR REPLACE VIEW public.inbox_threads_view
WITH (security_invoker = true) AS
SELECT
  t.*,
  t.thread_key AS dashboard_thread_id,
  t.thread_key AS canonical_id,
  t.property_id AS dashboard_property_id,
  t.prospect_id AS dashboard_prospect_id,
  t.master_owner_id AS dashboard_owner_id,
  t.canonical_e164 AS dashboard_phone_id,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.thread_key,
    'threadKey', t.thread_key,
    'propertyId', t.property_id,
    'prospectId', t.prospect_id,
    'ownerId', t.master_owner_id,
    'phoneId', t.canonical_e164,
    'latestMessageAt', t.latest_message_at,
    'latestMessageBody', t.latest_message_body,
    'latestDirection', t.latest_message_direction,
    'inboxBucket', t.inbox_bucket,
    'status', t.universal_status,
    'stage', t.universal_stage,
    'queueStatus', t.queue_status,
    'unreadCount', t.unread_count,
    'messageCount', t.message_count
  )) AS thread_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.property_id,
    'address', t.property_address_full,
    'market', t.market,
    'latitude', t.latitude,
    'longitude', t.longitude,
    'propertyType', t.property_type,
    'estimatedValue', t.estimated_value,
    'cashOffer', t.cash_offer,
    'finalAcquisitionScore', t.final_acquisition_score
  )) AS property_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.master_owner_id,
    'name', t.owner_name,
    'displayName', t.seller_display_name,
    'priorityScore', t.priority_score
  )) AS owner_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.prospect_id,
    'name', t.seller_display_name,
    'firstName', t.seller_first_name,
    'bestPhone', t.best_phone
  )) AS prospect_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.canonical_e164,
    'canonicalE164', t.canonical_e164,
    'sellerPhone', t.seller_phone,
    'displayPhone', t.display_phone,
    'ourNumber', t.our_number
  )) AS phone_entity,
  jsonb_strip_nulls(jsonb_build_object(
    'id', t.property_id,
    'threadKey', t.thread_key,
    'propertyId', t.property_id,
    'temperature', t.lead_temperature,
    'replyIntent', t.reply_intent,
    'priorityScore', t.priority_score,
    'finalAcquisitionScore', t.final_acquisition_score,
    'estimatedValue', t.estimated_value,
    'estimatedArv', t.estimated_arv,
    'cashOffer', t.cash_offer,
    'buyerMatch', t.buyer_match_data,
    'valuation', t.valuation_data
  )) AS deal_intel_entity
FROM public.v_inbox_threads_live_v2 t;

CREATE OR REPLACE VIEW public.conversation_detail_view
WITH (security_invoker = true) AS
SELECT
  COALESCE(
    NULLIF(me.thread_key, ''),
    CASE
      WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.from_phone_number, '')
      ELSE NULLIF(me.to_phone_number, '')
    END,
    NULLIF(me.to_phone_number, ''),
    NULLIF(me.from_phone_number, '')
  ) AS thread_key,
  me.id::text AS message_id,
  me.message_event_key,
  me.provider_message_sid,
  me.direction,
  CASE
    WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN 'inbound'
    WHEN lower(COALESCE(me.direction, '')) LIKE 'out%' THEN 'outbound'
    ELSE 'unknown'
  END AS normalized_direction,
  me.message_body,
  COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.delivered_at, me.created_at) AS timeline_at,
  me.created_at,
  me.sent_at,
  me.received_at,
  me.delivered_at,
  me.failed_at,
  me.delivery_status,
  me.provider_delivery_status,
  me.raw_carrier_status,
  me.error_message,
  me.from_phone_number,
  me.to_phone_number,
  CASE
    WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN me.from_phone_number
    ELSE me.to_phone_number
  END AS canonical_e164,
  me.phone_number_id,
  me.prospect_id,
  me.property_id,
  me.master_owner_id,
  me.textgrid_number_id,
  me.sms_agent_id,
  me.queue_id,
  me.template_id,
  me.market_id,
  me.stage_before,
  me.stage_after,
  me.metadata,
  jsonb_strip_nulls(jsonb_build_object(
    'id', me.id,
    'threadKey', COALESCE(NULLIF(me.thread_key, ''), CASE WHEN lower(COALESCE(me.direction, '')) LIKE 'in%' THEN NULLIF(me.from_phone_number, '') ELSE NULLIF(me.to_phone_number, '') END),
    'direction', me.direction,
    'body', me.message_body,
    'timelineAt', COALESCE(me.event_timestamp, me.received_at, me.sent_at, me.delivered_at, me.created_at),
    'deliveryStatus', COALESCE(me.delivery_status, me.provider_delivery_status, me.raw_carrier_status),
    'fromNumber', me.from_phone_number,
    'toNumber', me.to_phone_number,
    'propertyId', me.property_id,
    'prospectId', me.prospect_id,
    'ownerId', me.master_owner_id,
    'phoneId', me.phone_number_id,
    'queueId', me.queue_id
  )) AS message_entity
FROM public.message_events me;

CREATE OR REPLACE VIEW public.deal_intelligence_view
WITH (security_invoker = true) AS
SELECT
  d.*,
  d.property_id AS dashboard_property_id,
  d.master_owner_id AS dashboard_owner_id,
  d.prospect_id AS dashboard_prospect_id,
  d.canonical_e164 AS dashboard_phone_id,
  jsonb_strip_nulls(jsonb_build_object(
    'id', d.property_id,
    'dealContextId', d.deal_context_id,
    'threadKey', d.thread_key,
    'propertyId', d.property_id,
    'ownerId', d.master_owner_id,
    'prospectId', d.prospect_id,
    'phoneId', d.canonical_e164,
    'sellerName', d.owner_name,
    'address', d.property_address_full,
    'market', d.market,
    'stage', d.universal_stage,
    'status', d.universal_status,
    'bucket', d.inbox_bucket,
    'temperature', d.thread_state_data->>'lead_temperature',
    'replyIntent', d.thread_state_data->>'reply_intent',
    'estimatedValue', d.estimated_value,
    'estimatedArv', d.estimated_arv,
    'equityPercent', d.equity_percent,
    'cashOffer', d.cash_offer,
    'buyerDemandScore', d.buyer_demand_score,
    'buyerMatchScore', d.buyer_match_score,
    'buyerMatchCount', d.buyer_match_count,
    'finalAcquisitionScore', d.final_acquisition_score,
    'priorityScore', d.priority_score,
    'valuation', d.valuation_data,
    'buyerMatch', d.buyer_match_data
  )) AS deal_intel_entity
FROM public.v_deal_context_cards d;

CREATE OR REPLACE VIEW public.pipeline_cards_view
WITH (security_invoker = true) AS
SELECT
  d.deal_context_id AS id,
  d.thread_key,
  d.property_id,
  d.master_owner_id AS owner_id,
  d.prospect_id,
  d.canonical_e164 AS phone_id,
  COALESCE(NULLIF(d.universal_stage, ''), NULLIF(d.inbox_bucket, ''), 'unclassified') AS stage,
  d.universal_status AS status,
  d.inbox_bucket,
  d.queue_status,
  d.owner_name AS seller_name,
  d.property_address_full AS property_address,
  d.market,
  d.property_type,
  d.latest_message_body,
  d.latest_message_at,
  d.priority_score,
  d.final_acquisition_score,
  d.estimated_value,
  d.cash_offer,
  d.thread_state_data->>'lead_temperature' AS lead_temperature,
  d.thread_state_data->>'reply_intent' AS reply_intent,
  d.updated_at,
  jsonb_strip_nulls(jsonb_build_object(
    'id', d.deal_context_id,
    'threadKey', d.thread_key,
    'stage', COALESCE(NULLIF(d.universal_stage, ''), NULLIF(d.inbox_bucket, ''), 'unclassified'),
    'status', d.universal_status,
    'sellerName', d.owner_name,
    'propertyAddress', d.property_address_full,
    'market', d.market,
    'estimatedValue', d.estimated_value,
    'cashOffer', d.cash_offer,
    'priorityScore', d.priority_score,
    'temperature', d.thread_state_data->>'lead_temperature'
  )) AS card
FROM public.v_deal_context_cards d;

CREATE OR REPLACE VIEW public.list_rows_view
WITH (security_invoker = true) AS
SELECT
  d.deal_context_id AS id,
  d.thread_key,
  d.property_id,
  d.master_owner_id AS owner_id,
  d.prospect_id,
  d.canonical_e164 AS phone_id,
  d.owner_name AS seller_name,
  d.property_address_full AS property_address,
  d.market,
  d.property_state,
  d.property_zip,
  d.property_type,
  d.universal_status AS status,
  d.universal_stage AS stage,
  d.inbox_bucket,
  d.queue_status,
  d.latest_message_body,
  d.latest_message_direction,
  d.latest_message_at,
  d.estimated_value,
  d.cash_offer,
  d.priority_score,
  d.final_acquisition_score,
  d.updated_at,
  jsonb_strip_nulls(jsonb_build_object(
    'id', d.deal_context_id,
    'threadKey', d.thread_key,
    'sellerName', d.owner_name,
    'propertyAddress', d.property_address_full,
    'market', d.market,
    'status', d.universal_status,
    'stage', d.universal_stage,
    'inboxBucket', d.inbox_bucket,
    'queueStatus', d.queue_status,
    'latestMessageAt', d.latest_message_at
  )) AS row
FROM public.v_deal_context_cards d;

CREATE OR REPLACE VIEW public.map_markers_view
WITH (security_invoker = true) AS
SELECT
  d.deal_context_id AS id,
  d.thread_key,
  d.property_id,
  d.master_owner_id AS owner_id,
  d.prospect_id,
  d.canonical_e164 AS phone_id,
  d.owner_name AS seller_name,
  d.property_address_full AS property_address,
  d.market,
  d.property_state,
  d.latitude,
  d.longitude,
  d.inbox_bucket,
  d.universal_status AS status,
  d.universal_stage AS stage,
  d.priority_score,
  d.final_acquisition_score,
  d.latest_message_body,
  d.latest_message_at,
  jsonb_strip_nulls(jsonb_build_object(
    'id', d.deal_context_id,
    'threadKey', d.thread_key,
    'propertyId', d.property_id,
    'lat', d.latitude,
    'lng', d.longitude,
    'status', d.universal_status,
    'stage', d.universal_stage,
    'sellerName', d.owner_name,
    'propertyAddress', d.property_address_full,
    'market', d.market,
    'inboxBucket', d.inbox_bucket
  )) AS marker
FROM public.v_deal_context_cards d
WHERE d.latitude IS NOT NULL
  AND d.longitude IS NOT NULL;

CREATE OR REPLACE VIEW public.notification_feed_view
WITH (security_invoker = true) AS
SELECT
  n.id::text AS id,
  n.notification_key,
  n.notification_type AS kind,
  n.severity,
  n.title,
  n.message AS detail,
  n.recommended_action,
  n.campaign_key,
  n.status,
  n.metrics,
  NULL::timestamptz AS dispatched_at,
  NULL::timestamptz AS expires_at,
  n.created_at,
  n.updated_at,
  (n.status IN ('acknowledged', 'dispatched', 'expired')) AS read,
  jsonb_strip_nulls(jsonb_build_object(
    'id', n.id,
    'kind', n.notification_type,
    'severity', n.severity,
    'title', n.title,
    'detail', n.message,
    'status', n.status,
    'read', n.status IN ('acknowledged', 'dispatched', 'expired'),
    'actionLabel', n.recommended_action,
    'campaignKey', n.campaign_key,
    'timestampIso', n.created_at,
    'metrics', n.metrics
  )) AS notification
FROM public.ops_notifications n;

GRANT SELECT ON public.inbox_threads_view TO anon, authenticated, service_role;
GRANT SELECT ON public.conversation_detail_view TO anon, authenticated, service_role;
GRANT SELECT ON public.deal_intelligence_view TO anon, authenticated, service_role;
GRANT SELECT ON public.pipeline_cards_view TO anon, authenticated, service_role;
GRANT SELECT ON public.list_rows_view TO anon, authenticated, service_role;
GRANT SELECT ON public.map_markers_view TO anon, authenticated, service_role;
GRANT SELECT ON public.notification_feed_view TO anon, authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.message_events') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'thread_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_thread_id_created_at ON public.message_events (thread_id, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'thread_key') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_thread_key_created_at ON public.message_events (thread_key, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'prospect_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_prospect_id_created_at ON public.message_events (prospect_id, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'phone_number') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_phone_number_created_at ON public.message_events (phone_number, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'phone_number_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_phone_number_id_created_at ON public.message_events (phone_number_id, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'canonical_e164') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_canonical_e164_created_at ON public.message_events (canonical_e164, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'from_phone_number') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_from_phone_created_at ON public.message_events (from_phone_number, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'to_phone_number') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_to_phone_created_at ON public.message_events (to_phone_number, created_at DESC)';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_events' AND column_name = 'created_at') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_message_events_created_at_desc ON public.message_events (created_at DESC)';
    END IF;
  END IF;

  IF to_regclass('public.prospects') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_prospects_id ON public.prospects (id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'prospect_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_prospects_prospect_id ON public.prospects (prospect_id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'phone_number_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_prospects_phone_number_id ON public.prospects (phone_number_id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'property_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_prospects_property_id ON public.prospects (property_id)';
    END IF;
  END IF;

  IF to_regclass('public.properties') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_properties_id ON public.properties (id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'property_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_properties_property_id ON public.properties (property_id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'market_id') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_properties_market_id ON public.properties (market_id)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'latitude')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'longitude') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_properties_latitude_longitude ON public.properties (latitude, longitude)';
    END IF;
  END IF;

  IF to_regclass('public.pipeline') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pipeline' AND column_name = 'stage') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_pipeline_stage ON public.pipeline (stage)';
  END IF;

  IF to_regclass('public.followups') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'followups' AND column_name = 'due_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_followups_due_at ON public.followups (due_at)';
  END IF;

  IF to_regclass('public.follow_up_queue') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'follow_up_queue' AND column_name = 'scheduled_for') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_follow_up_queue_scheduled_for ON public.follow_up_queue (scheduled_for)';
  END IF;

  IF to_regclass('public.notifications') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_notifications_created_at ON public.notifications (created_at DESC)';
  END IF;

  IF to_regclass('public.ops_notifications') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ops_notifications' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_ops_notifications_created_at ON public.ops_notifications (created_at DESC)';
  END IF;

  IF to_regclass('public.campaigns') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dashboard_campaigns_id ON public.campaigns (id)';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
