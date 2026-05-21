-- NEXUS INBOX TRUTH REBUILD (SCHEMA-SAFE VERSION)
-- Verified against production audit + user constraints.

-- 1. CLEAN SLATE: DROP DEPENDENT VIEWS
DROP VIEW IF EXISTS public.inbox_category_counts CASCADE;
DROP VIEW IF EXISTS public.inbox_threads_hydrated CASCADE;
DROP VIEW IF EXISTS public.inbox_chat_timeline_hydrated CASCADE;
DROP VIEW IF EXISTS public.nexus_inbox_threads_v CASCADE;
DROP VIEW IF EXISTS public.deduped_message_events CASCADE;

-- 2. EXTEND inbox_thread_state (ADD MISSING TRACKING)
ALTER TABLE public.inbox_thread_state
  ADD COLUMN IF NOT EXISTS automation_status text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_id text,
  ADD COLUMN IF NOT EXISTS persona_id text,
  ADD COLUMN IF NOT EXISTS is_hot_lead boolean NOT NULL DEFAULT false;

-- 3. SMART INBOX VIEWS (SYSTEM DEFAULTS)
CREATE TABLE IF NOT EXISTS public.smart_inbox_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  icon text,
  color text,
  sort_order integer NOT NULL DEFAULT 0,
  filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean NOT NULL DEFAULT false,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.smart_inbox_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS smart_inbox_views_select ON public.smart_inbox_views;
CREATE POLICY smart_inbox_views_select ON public.smart_inbox_views FOR SELECT USING (true);

INSERT INTO public.smart_inbox_views (name, icon, color, sort_order, filter_json, is_system, is_pinned)
VALUES
  ('Hot Leads', 'flame', '#ef4444', 10, '{"priority": "urgent"}', true, true),
  ('Needs Response', 'reply', '#f59e0b', 20, '{"stage": "needs_response"}', true, true),
  ('Asking Price Given', 'tag', '#10b981', 30, '{"detected_intent": "asking_price_provided"}', true, false),
  ('Interested', 'star', '#3b82f6', 40, '{"detected_intent": "seller_interested"}', true, false),
  ('Opt-Out / DNC', 'stop', '#ef4444', 80, '{"stage": "opt_out"}', true, false),
  ('Archived', 'archive', '#6b7280', 100, '{"status": "archived"}', true, false)
ON CONFLICT (name) DO UPDATE SET
  filter_json = EXCLUDED.filter_json,
  sort_order = EXCLUDED.sort_order;

-- 4. DEAL MARKER TAXONOMY
CREATE TABLE IF NOT EXISTS public.deal_marker_taxonomy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name text NOT NULL UNIQUE,
  priority integer NOT NULL DEFAULT 0,
  match_intent text,
  match_stage text,
  color text NOT NULL DEFAULT '#6b7280',
  shape text NOT NULL DEFAULT 'circle',
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_marker_taxonomy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_marker_taxonomy_select ON public.deal_marker_taxonomy;
CREATE POLICY deal_marker_taxonomy_select ON public.deal_marker_taxonomy FOR SELECT USING (true);

INSERT INTO public.deal_marker_taxonomy (rule_name, priority, match_intent, color, label, shape)
VALUES
  ('Hot Leads', 100, 'seller_interested', '#ef4444', 'HOT', 'star'),
  ('Price Point', 90, 'asking_price_provided', '#a855f7', 'PRICE', 'diamond'),
  ('Asks Offer', 85, 'asks_offer', '#3b82f6', 'OFFER', 'square'),
  ('Ownership Confirmed', 80, 'ownership_confirmed', '#10b981', 'OWN', 'circle'),
  ('Opt-Out', 60, 'opt_out', '#6b7280', 'DNC', 'cross'),
  ('Wrong Number', 50, 'wrong_number', '#9ca3af', 'WRONG', 'cross')
ON CONFLICT (rule_name) DO UPDATE SET
  priority = EXCLUDED.priority,
  color = EXCLUDED.color,
  label = EXCLUDED.label;

-- 5. COMPLETE INTENT CLASSIFIER (13 CATEGORIES)
CREATE OR REPLACE FUNCTION public.nexus_inbox_priority_classify(
  latest_direction       text,
  latest_message_body    text,
  pending_queue_count    integer DEFAULT 0,
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

      -- 8. Asking Price
      WHEN latest_message_body ~ '(^| )\$?\d{1,3}([.,]\d{3})+( |$)' 
        OR body_norm ~ '(^| )\d{6,8}( |$)' 
        OR body_norm ~ '\d+ *(k|m|million)' THEN 'asking_price_provided'

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

-- 6. DEDUPED MESSAGE EVENTS (EXPLICIT COLUMNS)
CREATE OR REPLACE VIEW public.deduped_message_events AS
WITH ranked_messages AS (
  SELECT 
    id, thread_key, direction, message_body, delivery_status, 
    is_opt_out, event_timestamp, created_at, master_owner_id, 
    prospect_id, property_id, market, queue_id,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(queue_id, id::text)
      ORDER BY
        CASE
          WHEN delivery_status IN ('delivered', 'sent') THEN 1
          WHEN delivery_status IN ('queued', 'pending', 'scheduled') THEN 2
          WHEN delivery_status = 'failed' THEN 3
          ELSE 4
        END,
        event_timestamp DESC
    ) as rn
  FROM public.message_events
)
SELECT 
  id, thread_key, direction, message_body, delivery_status, 
  is_opt_out, event_timestamp, created_at, master_owner_id, 
  prospect_id, property_id, market, queue_id
FROM ranked_messages WHERE rn = 1;

-- 7. NEXUS INBOX THREADS VIEW
CREATE OR REPLACE VIEW public.nexus_inbox_threads_v AS
WITH message_base AS (
  SELECT
    me.id, COALESCE(me.event_timestamp, me.created_at) as message_ts, me.direction,
    me.message_body, me.delivery_status, me.is_opt_out, me.master_owner_id,
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

-- 8. INBOX THREADS HYDRATED (VERIFIED COLUMNS ONLY)
CREATE OR REPLACE VIEW public.inbox_threads_hydrated AS
SELECT
  nt.*, ts.automation_status, ts.follow_up_at, ts.agent_id, ts.persona_id,
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

-- 9. INBOX CHAT TIMELINE HYDRATED (EXPLICIT COLUMNS)
CREATE OR REPLACE VIEW public.inbox_chat_timeline_hydrated AS
SELECT 
  id, event_timestamp, message_body, direction, delivery_status, thread_key
FROM public.deduped_message_events;

-- 10. INBOX CATEGORY COUNTS
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
