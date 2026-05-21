-- Add routing columns to send_queue for better observability and control
ALTER TABLE public.send_queue 
ADD COLUMN IF NOT EXISTS routing_tier integer,
ADD COLUMN IF NOT EXISTS routing_reason text,
ADD COLUMN IF NOT EXISTS routing_allowed boolean DEFAULT true;

-- Ensure guard_reason exists (it was found earlier but let's be safe)
ALTER TABLE public.send_queue 
ADD COLUMN IF NOT EXISTS guard_reason text;
