-- Migration: create_inbox_activity_events
-- Date: 2026-05-21
-- Purpose: Create the missing inbox_activity_events table for tracking thread activity history.

CREATE TABLE IF NOT EXISTS public.inbox_activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    actor TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    undo_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast querying by thread
CREATE INDEX IF NOT EXISTS idx_inbox_activity_events_thread_key ON public.inbox_activity_events(thread_key);
CREATE INDEX IF NOT EXISTS idx_inbox_activity_events_created_at ON public.inbox_activity_events(created_at DESC);

-- Enable RLS
ALTER TABLE public.inbox_activity_events ENABLE ROW LEVEL SECURITY;

-- Service role bypass
CREATE POLICY "Service role can perform all operations on inbox_activity_events"
    ON public.inbox_activity_events
    FOR ALL
    USING (auth.jwt() ->> 'role' = 'service_role');

-- Add standard authenticated policy (assuming UI needs to read)
CREATE POLICY "Authenticated users can read inbox_activity_events"
    ON public.inbox_activity_events
    FOR SELECT
    TO authenticated
    USING (true);
