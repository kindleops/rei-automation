-- migration: create_seller_work_items_v
-- description: Universal seller/work item feed including uncontacted leads.
-- This view provides a unified entry point for Inbox, Pipeline, and List views.

BEGIN;

DROP VIEW IF EXISTS public.v_seller_work_items CASCADE;

CREATE OR REPLACE VIEW public.v_seller_work_items AS
WITH latest_thread AS (
  SELECT DISTINCT ON (property_id)
    property_id,
    thread_key,
    stage,
    status,
    priority,
    is_read,
    is_pinned,
    is_starred,
    is_urgent,
    is_hot_lead,
    is_suppressed,
    last_intent,
    next_action,
    automation_state,
    latest_message_body,
    latest_message_at,
    latest_direction,
    last_inbound_at,
    last_outbound_at,
    pending_queue_count,
    agent_id,
    persona_id,
    follow_up_at,
    master_owner_id,
    prospect_id,
    canonical_e164
  FROM public.inbox_thread_state
  WHERE property_id IS NOT NULL
  ORDER BY property_id, latest_message_at DESC NULLS LAST, updated_at DESC NULLS LAST
),
latest_queue AS (
  SELECT DISTINCT ON (property_id)
    property_id,
    id as queue_id,
    queue_status,
    scheduled_for,
    sent_at,
    delivered_at,
    failed_reason
  FROM public.send_queue
  WHERE property_id IS NOT NULL
  ORDER BY property_id, created_at DESC
),
latest_msg AS (
  SELECT DISTINCT ON (property_id)
    property_id,
    id as message_id,
    direction,
    message_body,
    delivery_status,
    event_timestamp,
    is_opt_out
  FROM public.message_events
  WHERE property_id IS NOT NULL
  ORDER BY property_id, event_timestamp DESC NULLS LAST, created_at DESC NULLS LAST
),
best_prospect AS (
  SELECT DISTINCT ON (master_owner_id)
    master_owner_id,
    prospect_id,
    full_name,
    first_name,
    best_phone,
    sms_eligible
  FROM public.prospects
  ORDER BY master_owner_id, contact_score_final DESC NULLS LAST, created_at DESC
)
SELECT
  p.property_id,
  p.master_owner_id,
  COALESCE(lt.thread_key, 'property:' || p.property_id) as thread_key,
  
  -- Flags
  (lt.thread_key IS NOT NULL) as has_conversation,
  (lq.queue_id IS NOT NULL) as has_queue,
  (lm.message_id IS NOT NULL) as has_message_event,
  (lm.message_id IS NULL AND lq.queue_id IS NULL AND lt.thread_key IS NULL) as is_uncontacted,
  
  -- Core Status/Stage
  COALESCE(NULLIF(lt.status, ''), 'not_contacted') as status,
  COALESCE(NULLIF(lt.stage, ''), 'not_contacted') as stage,
  
  -- Seller State (Semantic)
  CASE
    WHEN COALESCE(lt.is_suppressed, false) OR COALESCE(lm.is_opt_out, false) THEN 'blocked'
    WHEN lq.failed_reason IS NOT NULL THEN 'issue'
    WHEN lt.latest_direction = 'inbound' AND COALESCE(lt.is_read, false) = false THEN 'new_reply'
    WHEN COALESCE(lt.is_hot_lead, false) OR COALESCE(lt.is_urgent, false) THEN 'hot'
    WHEN lt.last_intent IN ('seller_interested', 'positive_interest', 'interested', 'asking_price_provided') THEN 'positive_intent'
    WHEN lt.stage IN ('negotiating', 'underwriting', 'offer_sent', 'price_discovery', 'condition_details') THEN 'negotiating'
    WHEN lm.message_id IS NOT NULL OR lq.sent_at IS NOT NULL THEN 'contacted'
    ELSE 'not_contacted'
  END as seller_state,

  -- Execution State
  CASE
    WHEN lq.queue_status IN ('sending', 'processing') THEN 'active'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') AND COALESCE(lq.scheduled_for, now()) <= now() THEN 'ready'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') AND lq.scheduled_for > now() THEN 'scheduled'
    WHEN lq.queue_status = 'sent' THEN 'sent'
    WHEN lq.queue_status = 'delivered' THEN 'delivered'
    WHEN lq.queue_status IN ('failed', 'error', 'blocked', 'cancelled') THEN 'issue'
    ELSE 'none'
  END as execution_state,

  -- Inbox Category
  CASE
    WHEN lt.thread_key IS NULL AND lq.queue_id IS NULL THEN 'not_contacted'
    WHEN COALESCE(lt.is_hot_lead, false) THEN 'hot_leads'
    WHEN COALESCE(lt.is_suppressed, false) OR COALESCE(lm.is_opt_out, false) THEN 'dnc_opt_out'
    WHEN lt.automation_state = 'active' THEN 'automated'
    WHEN lt.latest_direction = 'inbound' AND (lt.stage = 'needs_response' OR NOT COALESCE(lt.is_read, false)) THEN 'new_inbound'
    WHEN lq.queue_status IN ('queued', 'pending', 'approved') THEN 'outbound_active'
    WHEN lt.latest_direction = 'outbound' AND lt.stage IN ('sent_waiting', 'waiting') THEN 'outbound_active'
    ELSE 'cold_no_response'
  END as inbox_category,

  -- Integration Fields
  lt.latest_message_at,
  lt.latest_direction,
  lt.latest_message_body,
  lt.last_inbound_at,
  lt.last_outbound_at,
  COALESCE(lt.pending_queue_count, 0) as pending_queue_count,
  lt.follow_up_at,
  lt.agent_id,
  lt.persona_id,
  COALESCE(lt.is_starred, false) as is_starred,
  COALESCE(lt.is_pinned, false) as is_pinned,
  COALESCE(lt.is_read, true) as is_read,
  COALESCE(lt.is_hot_lead, false) as is_hot_lead,
  COALESCE(lt.is_suppressed, false) as is_suppressed,

  -- Property/Owner Context
  p.property_address_full,
  p.property_type,
  p.estimated_value,
  p.cash_offer,
  p.final_acquisition_score,
  p.structured_motivation_score as priority_score,
  p.property_address_city as city,
  p.property_address_state as state,
  p.property_address_zip as zip,
  p.latitude,
  p.longitude,
  mo.display_name as owner_display_name,
  mo.priority_tier as owner_priority_tier,
  mo.portfolio_total_value,
  mo.property_count as owner_property_count,
  
  -- Prospect Context
  COALESCE(lt.prospect_id, bp.prospect_id) as prospect_id,
  COALESCE(bp.full_name, mo.display_name) as prospect_full_name,
  COALESCE(lt.canonical_e164, bp.best_phone) as prospect_best_phone,
  COALESCE(bp.sms_eligible, false) as sms_eligible,

  -- Display Helpers
  COALESCE(
    NULLIF(lt.latest_message_body, ''),
    NULLIF(bp.full_name, ''), 
    NULLIF(mo.display_name, ''), 
    'Lead: ' || p.property_id
  ) as display_name,
  COALESCE(NULLIF(p.property_address_full, ''), 'Unknown Property') as display_address,
  COALESCE(NULLIF(lt.canonical_e164, ''), NULLIF(bp.best_phone, ''), 'No Phone') as display_phone,
  COALESCE(p.market, 'Unknown') as display_market

FROM public.properties p
LEFT JOIN latest_thread lt ON lt.property_id = p.property_id
LEFT JOIN latest_queue lq ON lq.property_id = p.property_id
LEFT JOIN latest_msg lm ON lm.property_id = p.property_id
LEFT JOIN public.master_owners mo ON mo.master_owner_id = p.master_owner_id
LEFT JOIN best_prospect bp ON bp.master_owner_id = p.master_owner_id;

-- Grant permissions
GRANT SELECT ON public.v_seller_work_items TO anon;
GRANT SELECT ON public.v_seller_work_items TO authenticated;

COMMIT;
