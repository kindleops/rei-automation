-- Drop constraints to allow new values
ALTER TABLE public.inbox_thread_state DROP CONSTRAINT IF EXISTS inbox_thread_state_status_check;
ALTER TABLE public.inbox_thread_state DROP CONSTRAINT IF EXISTS inbox_thread_state_stage_check;

-- Add new columns if they do not exist
ALTER TABLE public.inbox_thread_state
  ADD COLUMN IF NOT EXISTS last_intent text,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS pending_queue_count int default 0,
  ADD COLUMN IF NOT EXISTS failed_queue_count int default 0;
