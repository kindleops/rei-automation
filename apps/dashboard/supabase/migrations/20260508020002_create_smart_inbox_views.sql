-- Smart Inbox Views table for Arc-style left rail navigation
create table if not exists public.smart_inbox_views (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text,
  color text,
  sort_order integer not null default 0,
  filter_json jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.smart_inbox_views enable row level security;

-- RLS Policies
do 10160
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'smart_inbox_views'
      and policyname = 'smart_inbox_views_select'
  ) then
    create policy smart_inbox_views_select
      on public.smart_inbox_views
      for select
      using (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'smart_inbox_views'
      and policyname = 'smart_inbox_views_insert'
  ) then
    create policy smart_inbox_views_insert
      on public.smart_inbox_views
      for insert
      with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'smart_inbox_views'
      and policyname = 'smart_inbox_views_update'
  ) then
    create policy smart_inbox_views_update
      on public.smart_inbox_views
      for update
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'smart_inbox_views'
      and policyname = 'smart_inbox_views_delete'
  ) then
    create policy smart_inbox_views_delete
      on public.smart_inbox_views
      for delete
      using (true);
  end if;
end 10160;

-- Insert System Views
insert into public.smart_inbox_views (name, icon, color, sort_order, filter_json, is_system, is_pinned)
values
  ('Hot Leads', 'flame', '#ef4444', 10, '{"priority": "urgent"}', true, true),
  ('Needs Response', 'reply', '#f59e0b', 20, '{"stage": "needs_response"}', true, true),
  ('Asking Price Given', 'tag', '#10b981', 30, '{"detected_intent": "price_anchor"}', true, false),
  ('Offer Ready', 'document-text', '#3b82f6', 40, '{"stage": "needs_offer"}', true, false),
  ('Contract Ready', 'document-check', '#8b5cf6', 50, '{"stage": "interested"}', true, false),
  ('Follow-Up Today', 'calendar', '#ec4899', 60, '{"follow_up": "today"}', true, false),
  ('Auto Paused', 'pause', '#6b7280', 70, '{"status": "paused"}', true, false),
  ('Opt-Out / DNC', 'stop', '#ef4444', 80, '{"stage": "dnc_opt_out"}', true, false),
  ('Wrong Number', 'user-minus', '#6b7280', 90, '{"stage": "wrong_number"}', true, false),
  ('Archived', 'archive', '#6b7280', 100, '{"status": "archived"}', true, false)
on conflict do nothing;
