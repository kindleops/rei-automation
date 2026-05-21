-- Durable mutable thread state for Inbox actions.
-- message_events remains immutable event log and should not be edited for thread workflow state.

create table if not exists public.inbox_thread_state (
  id uuid primary key default gen_random_uuid(),
  thread_key text not null,
  master_owner_id text,
  prospect_id text,
  property_id text,
  seller_phone text,
  canonical_e164 text,
  our_number text,
  market text,
  stage text not null default 'needs_response',
  status text not null default 'open',
  priority text not null default 'normal',
  is_urgent boolean not null default false,
  is_archived boolean not null default false,
  is_read boolean not null default false,
  is_pinned boolean not null default false,
  last_read_at timestamptz,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbox_thread_state_thread_key_unique unique (thread_key),
  constraint inbox_thread_state_priority_check check (priority in ('urgent', 'high', 'normal', 'low')),
  constraint inbox_thread_state_status_check check (status in (
    'open', 'unread', 'read', 'pending', 'queued', 'sent',
    'scheduled', 'failed', 'archived', 'suppressed', 'closed'
  )),
  constraint inbox_thread_state_stage_check check (stage in (
    'new_reply', 'needs_response', 'ai_draft_ready', 'queued_reply',
    'sent_waiting', 'interested', 'needs_offer', 'needs_call',
    'nurture', 'not_interested', 'wrong_number', 'dnc_opt_out',
    'archived', 'closed_converted'
  ))
);

create index if not exists idx_inbox_thread_state_owner
  on public.inbox_thread_state (master_owner_id);

create index if not exists idx_inbox_thread_state_property
  on public.inbox_thread_state (property_id);

create index if not exists idx_inbox_thread_state_canonical_e164
  on public.inbox_thread_state (canonical_e164);

create index if not exists idx_inbox_thread_state_status_archived
  on public.inbox_thread_state (status, is_archived);

create index if not exists idx_inbox_thread_state_stage
  on public.inbox_thread_state (stage);

create index if not exists idx_inbox_thread_state_priority
  on public.inbox_thread_state (priority, is_urgent);

create index if not exists idx_inbox_thread_state_updated_at
  on public.inbox_thread_state (updated_at desc);

create or replace function public.set_inbox_thread_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_inbox_thread_state_updated_at on public.inbox_thread_state;
create trigger trg_inbox_thread_state_updated_at
before update on public.inbox_thread_state
for each row
execute function public.set_inbox_thread_state_updated_at();

alter table public.inbox_thread_state enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'inbox_thread_state'
      and policyname = 'inbox_thread_state_select'
  ) then
    create policy inbox_thread_state_select
      on public.inbox_thread_state
      for select
      using (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'inbox_thread_state'
      and policyname = 'inbox_thread_state_insert'
  ) then
    create policy inbox_thread_state_insert
      on public.inbox_thread_state
      for insert
      with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'inbox_thread_state'
      and policyname = 'inbox_thread_state_update'
  ) then
    create policy inbox_thread_state_update
      on public.inbox_thread_state
      for update
      using (true)
      with check (true);
  end if;
end $$;
