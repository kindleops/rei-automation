-- migration: resolve_missing_property_ids
-- description: Use owner and prospect property link arrays to hydrate missing property data.

BEGIN;

DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_command_center_v CASCADE;
DROP VIEW IF EXISTS public.inbox_threads_hydrated CASCADE;

CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
WITH base AS (
  SELECT
    nt.thread_key,
    nt.latest_message_at,
    nt.latest_direction,
    nt.latest_message_body,
    nt.market,
    nt.message_count,
    nt.inbound_count,
    nt.outbound_count,
    nt.pending_queue_count,
    nt.last_inbound_at,
    nt.last_outbound_at,
    nt.ui_intent,
    nt.priority_bucket,
    nt.status,
    nt.stage,
    nt.show_in_priority_inbox,
    nt.event_property_address,
    nt.event_seller_display_name,
    COALESCE(ts.automation_status, ts.automation_state, 'active') as automation_status,
    ts.follow_up_at,
    ts.agent_id,
    ts.persona_id,
    COALESCE(ts.is_starred, false) as is_starred, 
    COALESCE(ts.is_suppressed, false) as is_suppressed,
    COALESCE(ts.is_read, nt.is_read) as is_read,
    COALESCE(ts.is_pinned, nt.is_pinned) as is_pinned,
    COALESCE(ts.is_archived, nt.is_archived) as is_archived,
    COALESCE(ts.is_hot_lead, nt.is_hot_lead) as is_hot_lead,
    COALESCE(
      NULLIF(ts.canonical_e164, ''),
      NULLIF(ts.seller_phone, ''),
      (regexp_match(nt.thread_key, 'phone:(.+)'))[1]
    ) as best_phone,
    COALESCE(NULLIF(nt.master_owner_id, ''), NULLIF(ts.master_owner_id, '')) as final_master_owner_id,
    COALESCE(NULLIF(nt.prospect_id, ''), NULLIF(ts.prospect_id, '')) as final_prospect_id,
    COALESCE(NULLIF(nt.property_id, ''), NULLIF(ts.property_id, '')) as final_property_id
  FROM public.nexus_inbox_threads_v nt
  LEFT JOIN public.inbox_thread_state ts ON ts.thread_key = nt.thread_key
),
phone_links AS (
  SELECT DISTINCT ON (b.thread_key)
    b.thread_key,
    ph.master_owner_id as ph_master_owner_id,
    ph.primary_prospect_id as ph_prospect_id
  FROM base b
  JOIN public.phones ph ON ph.canonical_e164 = b.best_phone
  WHERE b.best_phone IS NOT NULL AND b.best_phone != ''
  ORDER BY b.thread_key, ph.created_at DESC
),
prospect_links AS (
  SELECT DISTINCT ON (b.thread_key)
    b.thread_key,
    pr.prospect_id as pr_prospect_id,
    pr.master_owner_id as pr_master_owner_id
  FROM base b
  JOIN public.prospects pr ON pr.best_phone = b.best_phone
  WHERE b.best_phone IS NOT NULL AND b.best_phone != ''
  ORDER BY b.thread_key, pr.created_at DESC
),
resolved_identities AS (
  SELECT
    b.thread_key,
    COALESCE(b.final_prospect_id, pl.ph_prospect_id, prl.pr_prospect_id) as res_prospect_id,
    COALESCE(b.final_master_owner_id, pl.ph_master_owner_id, prl.pr_master_owner_id) as res_master_owner_id,
    b.final_property_id as res_property_id
  FROM base b
  LEFT JOIN phone_links pl ON pl.thread_key = b.thread_key
  LEFT JOIN prospect_links prl ON prl.thread_key = b.thread_key
),
property_resolution AS (
  SELECT
    ri.thread_key,
    ri.res_prospect_id,
    ri.res_master_owner_id,
    COALESCE(
      ri.res_property_id,
      -- Fallback 1: First property from owner's list
      (SELECT p_id FROM jsonb_array_elements_text(mo.joined_property_ids_json) p_id LIMIT 1),
      -- Fallback 2: First property from prospect's list
      (SELECT p_id FROM jsonb_array_elements_text(pr.linked_property_ids_json) p_id LIMIT 1)
    ) as resolved_property_id
  FROM resolved_identities ri
  LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = ri.res_master_owner_id
  LEFT JOIN public.prospects pr ON pr.prospect_id::text = ri.res_prospect_id
)
SELECT
  b.thread_key,
  b.latest_message_at,
  b.latest_direction,
  b.latest_message_body,
  b.market,
  b.message_count,
  b.inbound_count,
  b.outbound_count,
  b.pending_queue_count,
  b.last_inbound_at,
  b.last_outbound_at,
  b.ui_intent,
  b.priority_bucket,
  b.status,
  b.stage,
  b.show_in_priority_inbox,
  b.is_archived,
  b.is_read,
  b.is_pinned,
  b.is_hot_lead,
  b.automation_status,
  b.follow_up_at,
  b.agent_id,
  b.persona_id,
  b.is_starred,
  b.is_suppressed,
  b.best_phone as seller_phone,
  b.best_phone,
  b.event_property_address,
  b.event_seller_display_name,
  pr.res_master_owner_id as master_owner_id,
  pr.res_prospect_id as prospect_id,
  pr.resolved_property_id as property_id,
  p.property_address_full, 
  p.property_type, 
  p.estimated_value, 
  p.cash_offer,
  p.final_acquisition_score, 
  p.structured_motivation_score as priority_score,
  p.property_address_city as city, 
  p.property_address_state as state, 
  p.property_address_zip as zip,
  mo.best_language, 
  mo.priority_score as owner_priority_score,
  mo.display_name as owner_display_name,
  prs.full_name as prospect_full_name, 
  prs.first_name as prospect_first_name
FROM base b
JOIN property_resolution pr ON pr.thread_key = b.thread_key
LEFT JOIN public.properties p ON p.property_id::text = pr.resolved_property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = pr.res_master_owner_id
LEFT JOIN public.prospects prs ON prs.prospect_id::text = pr.res_prospect_id;

CREATE OR REPLACE VIEW public.inbox_command_center_v AS
SELECT
  h.*,
  h.ui_intent as detected_intent,
  h.stage as queue_stage,
  h.automation_status as automation_state,
  h.latest_message_at as last_message_iso,
  h.latest_message_body as preview,
  COALESCE(
    NULLIF(h.prospect_full_name, ''),
    NULLIF(h.owner_display_name, ''),
    NULLIF(h.event_seller_display_name, ''),
    NULLIF(h.seller_phone, ''),
    h.thread_key
  ) as display_name,
  COALESCE(
    NULLIF(h.property_address_full, ''),
    NULLIF(h.event_property_address, ''),
    'Unknown Property'
  ) as display_address,
  CASE
    WHEN h.is_hot_lead THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent IN ('potential_interest', 'asking_price_provided') THEN 'hot_leads'
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' OR h.is_suppressed THEN 'dnc_opt_out'
    WHEN h.automation_status = 'running' OR h.automation_status = 'autonomous' THEN 'automated'
    WHEN h.latest_direction = 'inbound' AND (h.stage = 'needs_response' OR NOT h.is_read) THEN 'new_inbound'
    WHEN h.pending_queue_count > 0 THEN 'outbound_active'
    WHEN h.latest_direction = 'outbound' AND h.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    WHEN h.show_in_priority_inbox AND h.ui_intent = 'unclear' THEN 'needs_review'
    WHEN h.stage = 'needs_review' THEN 'needs_review'
    ELSE 'cold_no_response'
  END as inbox_category
FROM public.inbox_threads_hydrated h;

CREATE OR REPLACE VIEW public.inbox_category_counts AS
SELECT
  inbox_category as category,
  count(*) as count
FROM public.inbox_command_center_v
GROUP BY 1;

GRANT SELECT ON public.inbox_command_center_v TO anon;
GRANT SELECT ON public.inbox_threads_hydrated TO anon;
GRANT SELECT ON public.inbox_category_counts TO anon;

COMMIT;
