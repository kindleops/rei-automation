ALTER TABLE public.deal_thread_state 
ADD COLUMN IF NOT EXISTS universal_status text,
ADD COLUMN IF NOT EXISTS universal_stage text,
ADD COLUMN IF NOT EXISTS inbox_bucket text,
ADD COLUMN IF NOT EXISTS latest_message_direction text,
ADD COLUMN IF NOT EXISTS latest_message_body text,
ADD COLUMN IF NOT EXISTS latest_message_at timestamptz,
ADD COLUMN IF NOT EXISTS reply_intent text,
ADD COLUMN IF NOT EXISTS lead_temperature text,
ADD COLUMN IF NOT EXISTS suppression_status text,
ADD COLUMN IF NOT EXISTS opt_out boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS wrong_number boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS not_interested boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false;

-- Populate from existing aliases
UPDATE public.deal_thread_state
SET 
  latest_message_direction = direction,
  latest_message_body = last_message_body,
  latest_message_at = last_message_at,
  universal_status = inbox_status,
  universal_stage = conversation_stage,
  inbox_bucket = inbox_category;

-- Classify if state fields are still null (or bucket is null)
UPDATE public.deal_thread_state
SET 
  universal_status = 'awaiting_response',
  universal_stage = 'awaiting_response',
  inbox_bucket = 'cold'
WHERE latest_message_direction = 'outbound' 
  AND (inbox_bucket IS NULL OR universal_status IS NULL);

UPDATE public.deal_thread_state
SET 
  universal_status = 'seller_replied',
  universal_stage = 'seller_replied',
  inbox_bucket = 'new_replies'
WHERE latest_message_direction = 'inbound' 
  AND (inbox_bucket IS NULL OR universal_status IS NULL)
  AND latest_message_body NOT ILIKE '%stop%' 
  AND latest_message_body NOT ILIKE '%remove%' 
  AND latest_message_body NOT ILIKE '%unsubscribe%'
  AND latest_message_body NOT ILIKE '%no%'
  AND latest_message_body NOT ILIKE '%not interested%';

UPDATE public.deal_thread_state
SET 
  universal_status = 'suppressed',
  universal_stage = 'suppressed',
  inbox_bucket = 'suppressed',
  opt_out = true,
  suppression_status = 'active'
WHERE latest_message_direction = 'inbound' 
  AND (inbox_bucket IS NULL OR universal_status IS NULL)
  AND (latest_message_body ILIKE '%stop%' 
       OR latest_message_body ILIKE '%remove%' 
       OR latest_message_body ILIKE '%unsubscribe%');

UPDATE public.deal_thread_state
SET 
  universal_status = 'dead',
  universal_stage = 'dead',
  inbox_bucket = 'cold',
  not_interested = true
WHERE latest_message_direction = 'inbound' 
  AND (inbox_bucket IS NULL OR universal_status IS NULL)
  AND (latest_message_body ILIKE '%no%' 
       OR latest_message_body ILIKE '%not interested%'
       OR latest_message_body ILIKE '%not for sale%');

UPDATE public.deal_thread_state
SET 
  universal_status = 'active_conversation',
  universal_stage = 'interest_probe',
  inbox_bucket = 'priority'
WHERE latest_message_direction = 'inbound' 
  AND (inbox_bucket IS NULL OR universal_status IS NULL)
  AND (latest_message_body ILIKE '%why%' 
       OR latest_message_body ILIKE '%who%' 
       OR latest_message_body ILIKE '%how much%'
       OR latest_message_body ILIKE '%price%'
       OR latest_message_body ILIKE '%offer%');

-- Recreate view
CREATE OR REPLACE VIEW public.v_universal_inbox_threads AS
SELECT
  thread_key,
  master_owner_id,
  property_id,
  best_phone,
  unread_count,
  inbox_bucket,
  universal_status,
  universal_stage,
  latest_message_direction,
  latest_message_body,
  latest_message_at,
  reply_intent,
  lead_temperature,
  suppression_status,
  opt_out,
  wrong_number,
  not_interested,
  needs_review,
  created_at,
  updated_at,
  -- expose legacy aliases just in case
  inbox_bucket as inbox_category,
  universal_status as inbox_status,
  universal_stage as conversation_stage,
  latest_message_direction as direction,
  latest_message_body as last_message_body,
  latest_message_at as last_message_at
FROM public.deal_thread_state;
