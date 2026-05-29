-- 1. Create Enums
CREATE TYPE universal_status_enum AS ENUM (
  'new', 'not_contacted', 'queued', 'scheduled', 'outbound_sent',
  'awaiting_response', 'seller_replied', 'needs_review', 'hot_lead',
  'active_conversation', 'follow_up_due', 'negotiating', 'underwriting',
  'offer_needed', 'offer_sent', 'contract_requested', 'contract_sent',
  'closing', 'dead', 'suppressed'
);

CREATE TYPE universal_stage_enum AS ENUM (
  'not_contacted', 'ownership_check', 'awaiting_response', 'seller_replied',
  'interest_probe', 'price_discovery', 'condition_details', 'underwriting_needed',
  'offer_pending', 'offer_sent', 'negotiation', 'contract_requested',
  'contract_sent', 'closing', 'dead', 'suppressed'
);

CREATE TYPE inbox_bucket_enum AS ENUM (
  'priority', 'new_replies', 'needs_review', 'follow_up',
  'cold', 'suppressed', 'all_messages', 'unlinked'
);

-- 2. Create Deal Thread State Table
CREATE TABLE public.deal_thread_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key text UNIQUE NOT NULL,
  canonical_e164 text,
  phone_id text,
  master_owner_id text,
  property_id text,
  prospect_id text,
  campaign_id uuid,
  campaign_target_id uuid,
  queue_row_id text,
  latest_message_event_id text,
  latest_message_body text,
  latest_message_direction text,
  latest_message_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  owner_name text,
  seller_first_name text,
  property_address_full text,
  property_city text,
  property_state text,
  property_zip text,
  county text,
  market text,
  asset_class text,
  property_type text,
  property_class text,
  estimated_value numeric,
  equity_amount numeric,
  equity_percent numeric,
  cash_offer numeric,
  estimated_repair_cost numeric,
  final_acquisition_score numeric,
  motivation_score numeric,
  universal_status text,
  universal_stage text,
  inbox_bucket text,
  reply_intent text,
  normalized_intent text,
  language text,
  lead_temperature text,
  priority text,
  next_action text,
  follow_up_due_at timestamptz,
  automation_status text,
  suppression_status text,
  suppression_type text,
  opt_out boolean DEFAULT false,
  wrong_number boolean DEFAULT false,
  not_interested boolean DEFAULT false,
  needs_review boolean DEFAULT false,
  hydration_status text,
  missing_owner boolean DEFAULT false,
  missing_property boolean DEFAULT false,
  missing_campaign_target boolean DEFAULT false,
  confidence_score numeric,
  manually_overridden boolean DEFAULT false,
  manual_override_reason text,
  updated_by text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 3. Create Property Universe State Table
CREATE TABLE public.property_universe_state (
  property_id text PRIMARY KEY,
  master_owner_id text,
  owner_name text,
  seller_first_name text,
  property_address_full text,
  city text,
  state text,
  zip text,
  county text,
  market text,
  latitude numeric,
  longitude numeric,
  asset_class text,
  property_type text,
  property_class text,
  beds integer,
  baths numeric,
  sqft numeric,
  units integer,
  year_built integer,
  estimated_value numeric,
  equity_amount numeric,
  equity_percent numeric,
  cash_offer numeric,
  estimated_repair_cost numeric,
  final_acquisition_score numeric,
  motivation_score numeric,
  property_tags text[],
  best_phone_id text,
  canonical_e164 text,
  sms_eligible boolean DEFAULT true,
  contactability_score numeric,
  campaign_eligibility_status text,
  latest_thread_key text,
  latest_message_at timestamptz,
  last_contacted_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  is_contacted boolean DEFAULT false,
  is_contactable boolean DEFAULT true,
  is_suppressed boolean DEFAULT false,
  suppression_type text,
  property_pipeline_status text,
  map_status text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 4. Create Audit Table
CREATE TABLE public.deal_thread_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key text,
  previous_status text,
  new_status text,
  previous_stage text,
  new_stage text,
  event_type text,
  event_source text,
  reason text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- 5. Create Sync Function
CREATE OR REPLACE FUNCTION public.sync_deal_thread_state_from_events()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Stub function to be implemented or expanded based on application needs
  -- Actual sync logic can be quite complex, handled here or via backend job
  -- For now we implement the basic structure.

  -- Example: Insert or update threads based on latest events
  -- Real implementation will join message_events, send_queue, suppression lists, etc.
  RAISE NOTICE 'sync_deal_thread_state_from_events called';
END;
$$;

-- 6. Canonical Views

-- View 1: Inbox Threads
CREATE OR REPLACE VIEW public.v_universal_inbox_threads AS
SELECT * FROM public.deal_thread_state;

-- View 2: Pipeline Deal Threads
CREATE OR REPLACE VIEW public.v_pipeline_deal_threads AS
SELECT * FROM public.deal_thread_state;

-- View 3: Campaign Thread Status
CREATE OR REPLACE VIEW public.v_campaign_thread_status AS
SELECT * FROM public.deal_thread_state;

-- View 4: Map Thread Pins
CREATE OR REPLACE VIEW public.v_map_thread_pins AS
SELECT * FROM public.deal_thread_state;

-- View 5: Command Thread Detail
CREATE OR REPLACE VIEW public.v_command_thread_detail AS
SELECT * FROM public.deal_thread_state;

-- View 6: Property Universe
CREATE OR REPLACE VIEW public.v_property_universe AS
SELECT * FROM public.property_universe_state;

-- View 7: Map Property Pins
CREATE OR REPLACE VIEW public.v_map_property_pins AS
SELECT * FROM public.property_universe_state;

-- View 8: Campaign Eligible Properties
CREATE OR REPLACE VIEW public.v_campaign_eligible_properties AS
SELECT * FROM public.property_universe_state
WHERE is_contactable = true AND is_suppressed = false;
