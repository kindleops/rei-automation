-- migration: add_starred_and_suppressed_to_views
-- description: Add is_starred and is_suppressed to hydrated inbox views and refine new_inbound category logic.

BEGIN;

-- 1. UPDATE HYDRATED VIEW
CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
SELECT
  nt.*, 
  COALESCE(ts.automation_status, ts.automation_state, 'active') as automation_status,
  ts.follow_up_at, ts.agent_id, ts.persona_id,
  ts.is_starred, ts.is_suppressed, ts.is_read, ts.is_pinned, ts.is_archived,
  p.property_address_full, p.property_type, p.estimated_value, p.cash_offer,
  p.final_acquisition_score, p.structured_motivation_score as priority_score,
  p.property_address_city as city, p.property_address_state as state, p.property_address_zip as zip,
  mo.best_language, mo.priority_score as owner_priority_score,
  pr.full_name as prospect_full_name, pr.first_name as prospect_first_name
FROM public.nexus_inbox_threads_v nt
LEFT JOIN public.inbox_thread_state ts ON ts.thread_key = nt.thread_key
LEFT JOIN public.properties p ON p.property_id::text = nt.property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id::text = nt.master_owner_id
LEFT JOIN public.prospects pr ON pr.prospect_id::text = nt.prospect_id;

-- 2. UPDATE COMMAND CENTER VIEW
CREATE OR REPLACE VIEW public.inbox_command_center_v AS
SELECT
  h.*,
  h.ui_intent as detected_intent,
  h.stage as queue_stage,
  h.automation_status as automation_state,
  h.latest_message_at as last_message_iso,
  h.latest_message_body as preview,
  CASE
    WHEN h.is_hot_lead THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent IN ('potential_interest', 'asking_price_provided') THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent = 'unclear' THEN 'needs_review'
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' OR h.is_suppressed THEN 'dnc_opt_out'
    WHEN h.latest_direction = 'inbound' AND (h.stage = 'needs_response' OR NOT h.is_read) THEN 'new_inbound'
    WHEN h.latest_direction = 'outbound' AND h.stage = 'sent_waiting' THEN 'outbound_active'
    WHEN h.automation_status IS NOT NULL AND h.automation_status != 'manual' AND h.automation_status != 'manual_control' THEN 'automated'
    ELSE 'cold_no_response'
  END as inbox_category
FROM public.inbox_threads_hydrated h;

-- 3. ALIGN CATEGORY COUNTS
DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;

CREATE OR REPLACE VIEW public.inbox_category_counts AS
SELECT
  inbox_category as category,
  count(*) as count
FROM public.inbox_command_center_v
GROUP BY 1;

-- 4. GRANT PERMISSIONS
GRANT SELECT ON public.inbox_command_center_v TO anon;
GRANT SELECT ON public.inbox_threads_hydrated TO anon;
GRANT SELECT ON public.inbox_category_counts TO anon;

COMMIT;
