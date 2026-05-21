-- migration: secure_phase3_tables
-- description: Enables RLS and sets authenticated access policies for Phase 3 intelligence tables.

BEGIN;

-- 1. Enable RLS
ALTER TABLE public.ai_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_state_snapshots ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing policies if any
DROP POLICY IF EXISTS "Allow authenticated select on ai_decisions" ON public.ai_decisions;
DROP POLICY IF EXISTS "Allow authenticated select on negotiation_events" ON public.negotiation_events;
DROP POLICY IF EXISTS "Allow authenticated select on routing_decisions" ON public.routing_decisions;
DROP POLICY IF EXISTS "Allow authenticated select on seller_state_snapshots" ON public.seller_state_snapshots;

-- 3. Create SELECT policies for authenticated users
CREATE POLICY "Allow authenticated select on ai_decisions" 
ON public.ai_decisions FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Allow authenticated select on negotiation_events" 
ON public.negotiation_events FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Allow authenticated select on routing_decisions" 
ON public.routing_decisions FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Allow authenticated select on seller_state_snapshots" 
ON public.seller_state_snapshots FOR SELECT 
TO authenticated 
USING (true);

COMMIT;
