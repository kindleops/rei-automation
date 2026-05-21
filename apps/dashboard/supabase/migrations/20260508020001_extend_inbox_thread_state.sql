-- Extend inbox_thread_state with additional tracking columns
alter table public.inbox_thread_state
  add column if not exists automation_status text default 'active',
  add column if not exists follow_up_at timestamptz,
  add column if not exists agent_id text,
  add column if not exists persona_id text,
  add column if not exists is_hot_lead boolean not null default false;

-- Update status check to include possible new values if needed
alter table public.inbox_thread_state drop constraint if exists inbox_thread_state_status_check;
alter table public.inbox_thread_state add constraint inbox_thread_state_status_check check (status in (
  'open', 'unread', 'read', 'pending', 'queued', 'sent',
  'scheduled', 'failed', 'archived', 'suppressed', 'closed', 'paused'
));

-- Update stage check
alter table public.inbox_thread_state drop constraint if exists inbox_thread_state_stage_check;
alter table public.inbox_thread_state add constraint inbox_thread_state_stage_check check (stage in (
  'new_reply', 'needs_response', 'ai_draft_ready', 'queued_reply',
  'sent_waiting', 'interested', 'needs_offer', 'needs_call',
  'nurture', 'not_interested', 'wrong_number', 'dnc_opt_out',
  'archived', 'closed_converted', 'follow_up_today'
));
