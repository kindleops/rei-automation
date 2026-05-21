-- migration: fix_automation_and_outbound_buckets
-- description: Refine inbox_category mapping to correctly capture automated and outbound active threads.

BEGIN;

-- 1. RE-SYNC HYDRATED VIEW (Ensure automation_status is robust)
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

-- 2. RE-SYNC COMMAND CENTER VIEW (Refined Category Logic)
CREATE OR REPLACE VIEW public.inbox_command_center_v AS
SELECT
  h.*,
  h.ui_intent as detected_intent,
  h.stage as queue_stage,
  h.automation_status as automation_state,
  h.latest_message_at as last_message_iso,
  h.latest_message_body as preview,
  CASE
    -- Priority / Leads
    WHEN h.is_hot_lead THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent IN ('potential_interest', 'asking_price_provided') THEN 'hot_leads'
    
    -- Needs Review (Classification uncertain or operator flagged)
    WHEN h.show_in_priority_inbox AND h.ui_intent = 'unclear' THEN 'needs_review'
    WHEN h.stage = 'needs_review' THEN 'needs_review'
    
    -- DNC / Opt Out
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' OR h.is_suppressed THEN 'dnc_opt_out'
    
    -- New Inbound
    WHEN h.latest_direction = 'inbound' AND (h.stage = 'needs_response' OR NOT h.is_read) THEN 'new_inbound'
    
    -- Outbound Active (Actually has something in queue OR is waiting for reply)
    WHEN h.pending_queue_count > 0 THEN 'outbound_active'
    WHEN h.latest_direction = 'outbound' AND h.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    
    -- Automated (Explicitly running automation)
    WHEN h.automation_status = 'running' OR h.automation_status = 'autonomous' THEN 'automated'
    
    -- Fallback
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
