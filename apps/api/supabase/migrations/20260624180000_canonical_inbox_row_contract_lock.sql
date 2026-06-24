-- =============================================================================
-- canonical_inbox_row_contract_lock
-- Enriched canonical_inbox_threads + aligned canonical_inbox_counts for fast,
-- complete inbox list rows without client-side reconstruction.
-- Uses production inbox_thread_state columns (stage, last_intent, is_read, etc.)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_its_bucket_latest_message
  ON public.inbox_thread_state (inbox_bucket, latest_message_at DESC NULLS LAST, thread_key DESC);

CREATE INDEX IF NOT EXISTS idx_its_is_read_false
  ON public.inbox_thread_state (is_read)
  WHERE is_read = false;

DROP VIEW IF EXISTS public.v_inbox_thread_counts_live_v2 CASCADE;
DROP VIEW IF EXISTS public.canonical_inbox_counts CASCADE;
DROP VIEW IF EXISTS public.canonical_inbox_threads CASCADE;

CREATE OR REPLACE VIEW public.canonical_inbox_threads
WITH (security_invoker = true)
AS
SELECT
  ts.id AS id,
  ts.thread_key,
  ts.thread_key AS canonical_thread_key,
  ts.master_owner_id,
  ts.property_id,
  ts.prospect_id,
  ts.canonical_e164,
  ts.seller_phone,
  ts.seller_phone AS display_phone,
  ts.canonical_e164 AS best_phone,

  COALESCE(
    ts.inbox_bucket,
    CASE
      WHEN ts.is_suppressed = true THEN 'suppressed'
      WHEN lower(COALESCE(ts.disposition, '')) IN ('wrong_number', 'wrong_person') THEN 'dead'
      WHEN lower(COALESCE(ts.disposition, '')) = 'not_interested' THEN 'dead'
      WHEN ts.latest_direction = 'inbound' THEN 'new_replies'
      ELSE 'cold'
    END
  ) AS inbox_bucket,
  ts.inbox_bucket AS inbox_category,
  ts.last_intent AS detected_intent,
  ts.last_intent AS reply_intent,
  CASE
    WHEN ts.is_hot_lead = true OR ts.is_urgent = true THEN 'hot'
    ELSE NULL
  END AS lead_temperature,
  lower(COALESCE(ts.disposition, '')) = 'wrong_number' AS wrong_number,
  ts.is_suppressed AS opt_out,
  lower(COALESCE(ts.disposition, '')) = 'not_interested' AS not_interested,
  (ts.manual_override = true OR COALESCE(ts.confidence, 1) < 0.5) AS needs_review,
  CASE WHEN ts.is_suppressed = true THEN 'suppressed' ELSE NULL END AS suppression_status,

  ts.is_read,
  ts.is_pinned,
  ts.is_archived,
  ts.is_suppressed,
  ts.is_starred,
  CASE WHEN ts.is_read = false THEN 1 ELSE 0 END AS unread_count,
  ts.archived_at,
  ts.last_read_at AS read_at,

  ts.latest_message_body,
  ts.latest_message_at,
  ts.latest_direction AS latest_message_direction,
  ts.latest_event_type,
  ts.message_count,
  ts.inbound_count,
  ts.outbound_count,
  ts.last_inbound_at,
  ts.last_outbound_at,
  ts.latest_message_event_id,

  ts.latest_delivery_status AS delivery_status,
  ts.latest_delivery_status,
  ts.latest_delivery_status AS latest_provider_delivery_status,
  ts.automation_status AS queue_status,

  ts.status AS conversation_status,
  ts.stage AS seller_stage,
  ts.stage AS conversation_stage,
  ts.stage AS acquisition_stage,
  NULL::text AS temperature,
  ts.automation_state AS autopilot_mode,
  ts.manual_override AS manual_review,
  ts.agent_id AS assigned_user,
  ts.follow_up_at,

  ts.created_at,
  ts.updated_at,
  ts.confidence AS classification_confidence,
  ts.priority,
  NULL::text AS risk,
  ts.reason_codes AS flags,
  ts.our_number AS sender_number,
  ts.latest_reply_template_id AS template_id,
  NULL::text AS campaign_id,

  p.property_address_full,
  p.property_address_city,
  p.property_address_state AS property_state,
  p.property_address_zip AS property_zip,
  COALESCE(p.market, ts.market) AS market,
  p.property_type,
  p.total_bedrooms AS beds,
  p.total_baths AS baths,
  p.building_square_feet AS sqft,
  COALESCE(p.year_built, p.effective_year_built) AS year_built,
  p.estimated_value,
  p.equity_amount,
  p.equity_percent,
  COALESCE(
    NULLIF(p.final_acquisition_score, 0),
    NULLIF(mo.priority_score, 0)
  ) AS final_acquisition_score,
  mo.priority_score,
  mo.display_name AS owner_name,
  COALESCE(mo.display_name, pr.full_name, pr.first_name) AS seller_display_name,
  pr.full_name AS prospect_name,
  pr.first_name AS prospect_first_name,
  COALESCE(pr.likely_renting, false) AS likely_renter,

  CASE
    WHEN lower(COALESCE(ts.disposition, '')) = 'wrong_number'
      OR lower(COALESCE(ts.last_intent, '')) = 'wrong_number' THEN 'wrong_number'
    WHEN lower(COALESCE(ts.disposition, '')) = 'wrong_person'
      OR lower(COALESCE(ts.last_intent, '')) = 'wrong_person' THEN 'wrong_person'
    WHEN lower(COALESCE(ts.last_intent, '')) IN ('renter', 'renter_occupant', 'occupant')
      OR COALESCE(pr.likely_renting, false) = true THEN 'renter_occupant'
    WHEN lower(COALESCE(ts.last_intent, '')) = 'ownership_confirmed'
      OR lower(COALESCE(ts.stage, '')) = 'ownership_confirmed' THEN 'confirmed_owner'
    WHEN ts.master_owner_id IS NOT NULL AND ts.property_id IS NOT NULL THEN 'probable_owner'
    WHEN ts.master_owner_id IS NOT NULL OR ts.prospect_id IS NOT NULL THEN 'owner_related_contact'
    ELSE 'unknown'
  END AS contact_identity_class,

  p.latitude,
  p.longitude

FROM public.inbox_thread_state ts
LEFT JOIN public.properties p ON p.property_id = ts.property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id = ts.master_owner_id
LEFT JOIN public.prospects pr ON pr.prospect_id = ts.prospect_id
WHERE ts.is_archived IS DISTINCT FROM true;

GRANT SELECT ON public.canonical_inbox_threads TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW public.canonical_inbox_counts
WITH (security_invoker = true)
AS
SELECT
  COUNT(*) AS all,
  COUNT(*) AS all_messages,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority') AS priority,
  COUNT(*) FILTER (WHERE inbox_bucket IN ('priority', 'needs_review')) AS needs_attention,
  COUNT(*) FILTER (
    WHERE lower(COALESCE(seller_stage, acquisition_stage, '')) IN (
      'qualified', 'ownership_confirmed', 'seller_interested', 'asking_price_provided'
    )
    OR lower(COALESCE(detected_intent, '')) IN (
      'seller_interested', 'qualified_lead', 'ownership_confirmed', 'asking_price_provided'
    )
  ) AS qualified,
  COUNT(*) FILTER (
    WHERE lower(COALESCE(seller_stage, acquisition_stage, '')) IN ('offer', 'offer_sent', 'negotiating', 'offer_requested')
      OR lower(COALESCE(detected_intent, '')) IN ('offer_requested', 'asks_offer', 'wants_offer')
  ) AS offers,
  COUNT(*) FILTER (
    WHERE lower(COALESCE(seller_stage, acquisition_stage, '')) IN ('contract', 'under_contract', 'contract_sent')
  ) AS contracts,
  COUNT(*) FILTER (
    WHERE lower(COALESCE(seller_stage, acquisition_stage, '')) IN ('closing', 'close', 'title', 'escrow')
  ) AS closing,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies') AS new_replies,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS needs_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up') AS follow_up,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold') AS cold,
  COUNT(*) FILTER (WHERE inbox_bucket = 'dead') AS dead,
  COUNT(*) FILTER (WHERE not_interested = true OR lower(COALESCE(detected_intent, '')) = 'not_interested') AS not_interested,
  COUNT(*) FILTER (WHERE contact_identity_class = 'wrong_person') AS wrong_person,
  COUNT(*) FILTER (WHERE contact_identity_class = 'wrong_number' OR wrong_number = true) AS wrong_number,
  COUNT(*) FILTER (WHERE contact_identity_class = 'renter_occupant') AS renter_occupant,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed' OR opt_out = true) AS suppressed,
  COUNT(*) FILTER (WHERE opt_out = true OR inbox_bucket = 'suppressed') AS opt_out,
  COUNT(*) FILTER (WHERE inbox_bucket IS NULL) AS unclassified,
  COUNT(*) FILTER (WHERE unread_count > 0) AS unread,
  COUNT(*) FILTER (WHERE inbox_bucket IN ('priority', 'new_replies', 'needs_review', 'follow_up')) AS active,
  COUNT(*) FILTER (
    WHERE inbox_bucket = 'waiting'
      OR (latest_message_direction = 'outbound' AND inbox_bucket NOT IN ('dead', 'suppressed'))
  ) AS waiting,
  COUNT(*) FILTER (WHERE property_id IS NULL) AS unlinked,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS automated,
  COUNT(*) FILTER (WHERE inbox_bucket = 'priority') AS hot_leads,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies') AS new_inbound,
  COUNT(*) FILTER (WHERE inbox_bucket = 'new_replies') AS needs_reply,
  COUNT(*) FILTER (WHERE inbox_bucket = 'needs_review') AS manual_review,
  COUNT(*) FILTER (WHERE inbox_bucket = 'follow_up') AS outbound_active,
  COUNT(*) FILTER (WHERE inbox_bucket = 'cold') AS cold_no_response,
  COUNT(*) FILTER (WHERE inbox_bucket = 'suppressed') AS dnc_opt_out,
  COUNT(*) FILTER (
    WHERE inbox_bucket = 'waiting'
      OR (latest_message_direction = 'outbound' AND inbox_bucket NOT IN ('dead', 'suppressed'))
  ) AS waiting_on_seller
FROM public.canonical_inbox_threads;

GRANT SELECT ON public.canonical_inbox_counts TO anon, authenticated, service_role;

CREATE VIEW public.v_inbox_thread_counts_live_v2
WITH (security_invoker = true)
AS
SELECT * FROM public.canonical_inbox_counts;

GRANT SELECT ON public.v_inbox_thread_counts_live_v2 TO anon, authenticated, service_role;