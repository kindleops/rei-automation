-- Migration to add missing UI state columns to inbox_thread_state
alter table public.inbox_thread_state
add column if not exists is_starred boolean not null default false,
add column if not exists is_hidden boolean not null default false,
add column if not exists is_suppressed boolean not null default false,
add column if not exists hidden_at timestamptz,
add column if not exists suppressed_at timestamptz,
add column if not exists last_state_action text,
add column if not exists last_state_action_at timestamptz,
add column if not exists last_state_action_by text,
add column if not exists previous_state jsonb;

create index if not exists idx_inbox_thread_state_is_starred on public.inbox_thread_state (is_starred);
create index if not exists idx_inbox_thread_state_is_pinned on public.inbox_thread_state (is_pinned);
create index if not exists idx_inbox_thread_state_is_hidden on public.inbox_thread_state (is_hidden);
create index if not exists idx_inbox_thread_state_is_suppressed on public.inbox_thread_state (is_suppressed);
