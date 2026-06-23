-- 1. Create property_universe_state table
CREATE TABLE IF NOT EXISTS public.property_universe_state (
    property_id text PRIMARY KEY,
    property_address_full text,
    market text,
    owner_id text,
    master_owner_id text,
    latitude numeric,
    longitude numeric,
    ai_score numeric,
    property_type text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- Backfill property_universe_state from properties
INSERT INTO public.property_universe_state (
    property_id, property_address_full, market, owner_id, master_owner_id,
    latitude, longitude, ai_score, property_type
)
SELECT 
    property_id, property_address_full, market, owner_id, master_owner_id,
    latitude, longitude, ai_score, property_type
FROM public.properties
ON CONFLICT (property_id) DO NOTHING;


-- 2. Create deal_thread_state table
CREATE TABLE IF NOT EXISTS public.deal_thread_state (
    thread_key text PRIMARY KEY,
    master_owner_id text,
    property_id text,
    last_message_at timestamp with time zone,
    last_message_body text,
    direction text,
    inbox_status text,
    inbox_category text,
    conversation_stage text,
    unread_count integer DEFAULT 0,
    best_phone text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- Backfill deal_thread_state from message_events
INSERT INTO public.deal_thread_state (
    thread_key, master_owner_id, property_id,
    last_message_at, last_message_body, direction,
    conversation_stage, best_phone
)
SELECT 
    thread_key,
    MAX(master_owner_id) as master_owner_id,
    MAX(property_id) as property_id,
    MAX(event_timestamp) as last_message_at,
    MAX(message_body) as last_message_body,
    MAX(direction) as direction,
    MAX(current_stage) as conversation_stage,
    MAX(from_phone_number) as best_phone
FROM public.message_events
WHERE thread_key IS NOT NULL
GROUP BY thread_key
ON CONFLICT (thread_key) DO NOTHING;


-- 3. Create v_universal_inbox_threads view
CREATE OR REPLACE VIEW public.v_universal_inbox_threads AS
SELECT 
    d.thread_key,
    d.master_owner_id,
    d.property_id,
    d.last_message_at,
    d.last_message_body,
    d.direction,
    d.inbox_category,
    d.inbox_status,
    d.conversation_stage,
    d.unread_count,
    d.best_phone,
    o.display_name AS owner_name,
    p.property_address_full AS property_address,
    p.market
FROM public.deal_thread_state d
LEFT JOIN public.master_owners o ON d.master_owner_id = o.master_owner_id
LEFT JOIN public.property_universe_state p ON d.property_id = p.property_id;


-- 4. Create v_map_property_pins view
CREATE OR REPLACE VIEW public.v_map_property_pins AS
SELECT 
    d.thread_key,
    p.property_id,
    p.latitude,
    p.longitude,
    p.property_address_full AS property_address,
    o.display_name AS owner_name,
    d.last_message_body,
    d.inbox_status,
    d.conversation_stage
FROM public.deal_thread_state d
JOIN public.property_universe_state p ON d.property_id = p.property_id
LEFT JOIN public.master_owners o ON d.master_owner_id = o.master_owner_id
WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL;
