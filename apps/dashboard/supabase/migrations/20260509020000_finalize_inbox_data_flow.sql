-- FINALIZE INBOX UI DATA FLOW (V2)
-- Refines inbox_category mapping for better frontend alignment.

-- 1. ENHANCED COMMAND CENTER VIEW
DROP VIEW IF EXISTS public.inbox_command_center_v CASCADE;

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
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' THEN 'dnc_opt_out'
    WHEN h.latest_direction = 'inbound' AND h.stage = 'needs_response' THEN 'new_inbound'
    WHEN h.latest_direction = 'outbound' AND h.stage = 'sent_waiting' THEN 'outbound_active'
    WHEN h.automation_status IS NOT NULL AND h.automation_status != 'manual' THEN 'automated'
    ELSE 'cold_no_response'
  END as inbox_category
FROM public.inbox_threads_hydrated h;

-- 2. ALIGN CATEGORY COUNTS
DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;

CREATE OR REPLACE VIEW public.inbox_category_counts AS
SELECT
  inbox_category as category,
  count(*) as count
FROM public.inbox_command_center_v
GROUP BY 1;

-- 3. GRANT PERMISSIONS
GRANT SELECT ON public.inbox_command_center_v TO anon;
GRANT SELECT ON public.inbox_category_counts TO anon;
