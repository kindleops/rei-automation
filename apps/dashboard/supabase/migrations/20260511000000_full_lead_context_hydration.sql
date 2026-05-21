-- migration: full_lead_context_hydration
-- description: Deep hydration view ensuring fallbacks for missing IDs via phones and prospects.

BEGIN;

DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_command_center_v CASCADE;
DROP VIEW IF EXISTS public.inbox_threads_hydrated CASCADE;
DROP VIEW IF EXISTS public.nexus_inbox_threads_v CASCADE;

CREATE OR REPLACE VIEW public.nexus_inbox_threads_v AS
WITH message_base AS (
  SELECT
    me.id, COALESCE(me.event_timestamp, me.created_at) as message_ts, me.direction,
    COALESCE(me.message_body, '') as message_body, me.delivery_status, me.is_opt_out, me.master_owner_id,
    me.prospect_id, me.property_id, me.market, me.thread_key,
    me.property_address, me.seller_display_name
  FROM public.deduped_message_events me
),
thread_rollup AS (
  SELECT
    thread_key, count(*) as message_count,
    count(*) filter (where direction = 'inbound') as inbound_count,
    count(*) filter (where direction = 'outbound') as outbound_count,
    count(*) filter (where direction = 'outbound' AND delivery_status IN ('queued', 'pending', 'scheduled')) as pending_queue_count,
    max(message_ts) as latest_message_at,
    max(message_ts) filter (where direction = 'inbound') as last_inbound_at,
    max(message_ts) filter (where direction = 'outbound') as last_outbound_at
  FROM message_base GROUP BY thread_key
),
latest_msg AS (
  SELECT DISTINCT ON (thread_key) * FROM message_base ORDER BY thread_key, message_ts DESC, id DESC
)
SELECT
  l.thread_key, tr.latest_message_at, l.direction as latest_direction,
  l.message_body as latest_message_body, l.master_owner_id, l.prospect_id, l.property_id,
  COALESCE(l.market, 'unknown') as market, tr.message_count, tr.inbound_count, tr.outbound_count,
  tr.pending_queue_count, tr.last_inbound_at, tr.last_outbound_at,
  l.property_address as event_property_address, l.seller_display_name as event_seller_display_name,
  c.ui_intent, c.priority_bucket,
  COALESCE(NULLIF(ts.status, ''), 'open') as status,
  COALESCE(NULLIF(ts.stage, ''), 'needs_response') as stage,
  c.show_in_priority_inbox,
  COALESCE(ts.is_archived, false) as is_archived,
  COALESCE(ts.is_read, false) as is_read,
  COALESCE(ts.is_pinned, false) as is_pinned,
  COALESCE(ts.is_hot_lead, false) as is_hot_lead
FROM latest_msg l
JOIN thread_rollup tr ON tr.thread_key = l.thread_key
LEFT JOIN public.inbox_thread_state ts ON ts.thread_key = l.thread_key
CROSS JOIN LATERAL public.nexus_inbox_priority_classify(
  l.direction, l.message_body, tr.pending_queue_count,
  COALESCE(ts.is_archived, false),
  COALESCE(ts.is_suppressed, false),
  COALESCE(l.is_opt_out, false)
) c;

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
resolved_ids AS (
  SELECT
    b.thread_key,
    COALESCE(
      b.final_prospect_id,
      pl.ph_prospect_id,
      prl.pr_prospect_id
    ) as resolved_prospect_id,
    COALESCE(
      b.final_master_owner_id,
      pl.ph_master_owner_id,
      prl.pr_master_owner_id
    ) as resolved_master_owner_id,
    b.final_property_id as resolved_property_id
  FROM base b
  LEFT JOIN phone_links pl ON pl.thread_key = b.thread_key
  LEFT JOIN prospect_links prl ON prl.thread_key = b.thread_key
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
  -- Export the resolved IDs so downstream views/UI don't see nulls
  r.resolved_master_owner_id as master_owner_id,
  r.resolved_prospect_id as prospect_id,
  r.resolved_property_id as property_id,
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
  pr.full_name as prospect_full_name, 
  pr.first_name as prospect_first_name
FROM base b
JOIN resolved_ids r ON r.thread_key = b.thread_key
LEFT JOIN public.properties p ON p.property_id::text = r.resolved_property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = r.resolved_master_owner_id
LEFT JOIN public.prospects pr ON pr.prospect_id::text = r.resolved_prospect_id;

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

GRANT SELECT ON public.nexus_inbox_threads_v TO anon;
GRANT SELECT ON public.inbox_command_center_v TO anon;
GRANT SELECT ON public.inbox_threads_hydrated TO anon;
GRANT SELECT ON public.inbox_category_counts TO anon;

COMMIT;
