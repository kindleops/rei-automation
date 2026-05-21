-- FIX INBOX TRUTH LAYER (V2)
-- Corrects classifier regex, ensures is_hot_lead availability, and fixes null message bodies.

-- 1. CLASSIFIER FIX
CREATE OR REPLACE FUNCTION public.nexus_inbox_priority_classify(
  latest_direction       text,
  latest_message_body    text,
  pending_queue_count    bigint DEFAULT 0,
  is_archived            boolean DEFAULT false,
  is_suppressed          boolean DEFAULT false,
  has_opt_out            boolean DEFAULT false
)
RETURNS TABLE (
  ui_intent             text,
  priority_bucket       text,
  show_in_priority_inbox boolean
)
LANGUAGE sql
STABLE
AS $$
WITH normalized AS (
  SELECT
    LOWER(TRIM(REGEXP_REPLACE(COALESCE(latest_message_body, ''), '[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]+', ' ', 'g'))) as body_norm,
    (' ' || LOWER(TRIM(REGEXP_REPLACE(COALESCE(latest_message_body, ''), '[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ]+', ' ', 'g'))) || ' ') as body_pad
),
classify AS (
  SELECT
    CASE
      -- 1. Non-inbound
      WHEN LOWER(COALESCE(latest_direction, '')) IS DISTINCT FROM 'inbound' THEN 'outbound_waiting'
      
      -- 2. Opt Out
      WHEN COALESCE(has_opt_out, false) OR body_pad LIKE '% stop %' OR body_pad LIKE '% remove %' OR body_pad LIKE '% unsubscribe %' THEN 'opt_out'
        
      -- 3. Wrong Number
      WHEN body_pad LIKE '% wrong number %' OR body_pad LIKE '% wrong person %' OR body_pad LIKE '% not the owner %' THEN 'wrong_number'
        
      -- 4. Not Interested
      WHEN body_norm IN ('no', 'nope', 'nah') OR body_pad LIKE '% not interested %' OR body_pad LIKE '% not for sale %' THEN 'not_interested'
      
      -- 5. Tenant Occupancy
      WHEN body_pad LIKE '% tenant %' OR body_pad LIKE '% rented %' OR body_pad LIKE '% lease %' THEN 'tenant_occupancy'
      
      -- 6. Condition Disclosed
      WHEN body_pad LIKE '% needs work %' OR body_pad LIKE '% fixer %' OR body_pad LIKE '% bad shape %' OR body_pad LIKE '% roof %' THEN 'condition_disclosed'

      -- 7. Asks Offer
      WHEN body_pad LIKE '% make me an offer %' OR body_pad LIKE '% your offer %' OR body_pad LIKE '% what you pay %' THEN 'asks_offer'

      -- 8. Asking Price (Improved Regex)
      WHEN latest_message_body ~* '(\$?\d{1,3}([.,]\d{3})+( |$))|(\d+ *(k|m|million))|(\d{6,8})' THEN 'asking_price_provided'

      -- 9. Ownership Confirmed
      WHEN body_pad LIKE '% i own it %' OR body_pad LIKE '% it is mine %' OR body_pad LIKE '% yes it is %' THEN 'ownership_confirmed'
        
      -- 10. Needs Call
      WHEN body_pad LIKE '% call me %' OR body_pad LIKE '% give me a call %' OR body_pad LIKE '% phone number %' THEN 'needs_call'

      -- 11. Needs Email
      WHEN body_pad LIKE '% email me %' OR body_pad LIKE '% send email %' OR body_pad LIKE '% what is your email %' THEN 'needs_email'

      -- 12. Who Is This
      WHEN body_pad LIKE '% who is this %' OR body_pad LIKE '% who are you %' OR body_pad LIKE '% what company %' THEN 'who_is_this'

      -- 13. Seller Interested
      WHEN body_norm IN ('yes', 'si', 'ok', 'okay') 
        OR body_pad LIKE '% interested in selling %' 
        OR body_pad LIKE '% i am interested %' THEN 'seller_interested'
        
      -- Fallback
      ELSE 'unclear'
    END as ui_intent
  FROM normalized
)
SELECT
  c.ui_intent,
  CASE
    WHEN c.ui_intent = 'outbound_waiting' THEN (CASE WHEN pending_queue_count > 0 THEN 'queued' ELSE 'normal' END)
    WHEN c.ui_intent IN ('opt_out') THEN 'suppressed'
    WHEN c.ui_intent IN ('wrong_number', 'not_interested', 'tenant_occupancy') THEN 'hidden'
    ELSE 'priority'
  END as priority_bucket,
  (
    NOT is_archived AND NOT is_suppressed AND NOT has_opt_out 
    AND LOWER(latest_direction) = 'inbound'
    AND c.ui_intent NOT IN ('opt_out', 'wrong_number', 'not_interested')
  ) as show_in_priority_inbox
FROM classify c;
$$;

-- 2. REBUILD VIEWS WITH MISSING COLUMNS
ALTER TABLE public.inbox_thread_state ADD COLUMN IF NOT EXISTS is_hot_lead boolean NOT NULL DEFAULT false;
ALTER TABLE public.inbox_thread_state ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;
ALTER TABLE public.inbox_thread_state ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE public.inbox_thread_state ADD COLUMN IF NOT EXISTS persona_id text;
ALTER TABLE public.inbox_thread_state ADD COLUMN IF NOT EXISTS automation_status text;

DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_threads_hydrated CASCADE;
DROP VIEW IF EXISTS public.nexus_inbox_threads_v CASCADE;

CREATE OR REPLACE VIEW public.nexus_inbox_threads_v AS
WITH message_base AS (
  SELECT
    me.id, COALESCE(me.event_timestamp, me.created_at) as message_ts, me.direction,
    COALESCE(me.message_body, '') as message_body, me.delivery_status, me.is_opt_out, me.master_owner_id,
    me.prospect_id, me.property_id, me.market, me.thread_key
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
  COALESCE(ts.status = 'suppressed', false), 
  COALESCE(l.is_opt_out, false)
) c;

CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
SELECT
  nt.*, 
  COALESCE(ts.automation_status, ts.automation_state) as automation_status,
  ts.follow_up_at, ts.agent_id, ts.persona_id,
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

CREATE OR REPLACE VIEW public.inbox_category_counts AS
SELECT
  CASE
    WHEN is_hot_lead OR show_in_priority_inbox THEN 'hot_leads'
    WHEN stage = 'needs_response' THEN 'needs_response'
    WHEN ui_intent = 'asking_price_provided' THEN 'asking_price'
    WHEN status = 'archived' THEN 'archived'
    ELSE 'other'
  END as category,
  count(*) as count
FROM public.inbox_threads_hydrated
GROUP BY 1;
