-- migration: align_inbound_visibility
-- description: Add all_inbound bucket support and refine hot_leads/needs_review intents.

BEGIN;

DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_command_center_v CASCADE;

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
    -- 1. HOT LEADS
    WHEN h.is_hot_lead THEN 'hot_leads'
    WHEN h.show_in_priority_inbox AND h.ui_intent IN (
      'seller_interested', 'asking_price_provided', 'asks_offer', 
      'ownership_confirmed', 'needs_call', 'needs_email', 'potential_interest'
    ) THEN 'hot_leads'
    
    -- 2. SUPPRESSION
    WHEN h.ui_intent IN ('opt_out', 'wrong_number', 'hostile_or_legal') OR h.status = 'suppressed' OR h.is_suppressed THEN 'dnc_opt_out'
    
    -- 3. AUTOMATED
    WHEN h.automation_status = 'running' OR h.automation_status = 'autonomous' THEN 'automated'
    
    -- 4. NEW INBOUND
    WHEN h.latest_direction = 'inbound' AND (h.stage = 'needs_response' OR NOT h.is_read) THEN 'new_inbound'
    
    -- 5. OUTBOUND ACTIVE
    WHEN h.pending_queue_count > 0 THEN 'outbound_active'
    WHEN h.latest_direction = 'outbound' AND h.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    
    -- 6. NEEDS REVIEW
    WHEN h.show_in_priority_inbox AND h.ui_intent IN ('unclear', 'who_is_this', 'ambiguous') THEN 'needs_review'
    WHEN h.stage = 'needs_review' THEN 'needs_review'
    
    -- 7. FALLBACK
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
GRANT SELECT ON public.inbox_category_counts TO anon;

COMMIT;
