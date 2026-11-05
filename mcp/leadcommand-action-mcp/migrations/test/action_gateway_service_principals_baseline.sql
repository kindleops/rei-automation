-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Setup for PROPOSED_20261105120000_action_gateway_service_principals.sql: the production
-- public.campaigns columns the campaign-draft writer and the read-back use (apps/api/supabase/migrations/
-- 20260531000015_campaign_automation_foundation.sql names / types), public.campaign_filters and public.campaign_events
-- (same file). Composable with the chain fixtures: create-if-not-exists, then add-column-if-not-exists. Never against Supabase.
create table if not exists public.campaigns (id uuid primary key default gen_random_uuid(), name text, status text);
alter table public.campaigns add column if not exists description text, add column if not exists objective text,
  add column if not exists candidate_source text default 'v_feeder_candidates_fast', add column if not exists market text, add column if not exists state text,
  add column if not exists daily_cap integer, add column if not exists total_cap integer,
  add column if not exists auto_queue_enabled boolean default false, add column if not exists auto_send_enabled boolean default false,
  add column if not exists auto_reply_mode text default 'disabled', add column if not exists emergency_stop_at timestamptz,
  add column if not exists metadata jsonb default '{}'::jsonb, add column if not exists created_at timestamptz default now(), add column if not exists updated_at timestamptz default now();
create table if not exists public.campaign_filters (
  id uuid primary key default gen_random_uuid(), campaign_id uuid references public.campaigns(id) on delete cascade, filter_type text, field text not null,
  operator text not null, value jsonb default 'null'::jsonb, label text, created_at timestamptz default now());
create table if not exists public.campaign_events (
  id uuid primary key default gen_random_uuid(), campaign_id uuid references public.campaigns(id) on delete cascade, run_id uuid, target_id uuid,
  send_window_id uuid, queue_row_id uuid, event_type text not null, severity text default 'info', title text, description text,
  metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
revoke all on public.campaign_filters, public.campaign_events from public;
