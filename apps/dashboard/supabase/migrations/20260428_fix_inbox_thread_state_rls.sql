-- Repair browser-accessible RLS/grants for Inbox thread-state writes.
-- Required because the frontend uses the anon/authenticated Supabase client.

alter table public.inbox_thread_state enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.inbox_thread_state to anon, authenticated;

drop policy if exists inbox_thread_state_select on public.inbox_thread_state;
drop policy if exists inbox_thread_state_insert on public.inbox_thread_state;
drop policy if exists inbox_thread_state_update on public.inbox_thread_state;

create policy inbox_thread_state_select
  on public.inbox_thread_state
  for select
  to anon, authenticated
  using (true);

create policy inbox_thread_state_insert
  on public.inbox_thread_state
  for insert
  to anon, authenticated
  with check (true);

create policy inbox_thread_state_update
  on public.inbox_thread_state
  for update
  to anon, authenticated
  using (true)
  with check (true);
