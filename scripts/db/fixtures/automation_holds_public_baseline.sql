-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. The production public surface that the P0 hold registry
-- (PROPOSED_20261016200000_automation_holds_registry.sql, rc-8.5.20-holds = hotfix/automation-holds)
-- guards: the five protected tables with the columns its preconditions, BEFORE triggers ("UPDATE OF"
-- lists) and guard functions read, the unique inbox_thread_state(thread_key) lock target, and
-- public.is_ops_operator() (the RLS policy pattern). Column names / types as read from production
-- (information_schema, read-only, 2026-10-16, P0 holds package). No data, no FKs.
-- Composable with scripts/db/fixtures/send_queue_live_baseline.sql and operations_public_baseline.sql:
-- when one of them created a table first, the create-if-not-exists is a no-op and the columns the
-- registry needs are added (no-op when already present).
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
create extension if not exists pgcrypto;

create or replace function public.is_ops_operator() returns boolean language sql stable as $f$ select coalesce(current_setting('lc.test_is_ops_operator', true), '') = 'true' $f$;

create table if not exists public.inbox_thread_state (id uuid primary key default gen_random_uuid(), thread_key text unique);
alter table public.inbox_thread_state add column if not exists property_id text;
alter table public.inbox_thread_state add column if not exists master_owner_id text;
alter table public.inbox_thread_state add column if not exists automation_state text;
alter table public.inbox_thread_state add column if not exists manual_override boolean;
alter table public.inbox_thread_state add column if not exists paused_reason text;
alter table public.inbox_thread_state add column if not exists metadata jsonb;
alter table public.inbox_thread_state add column if not exists updated_by text;

create table if not exists public.acquisition_opportunities (id uuid primary key default gen_random_uuid());
alter table public.acquisition_opportunities add column if not exists master_owner_id text;
alter table public.acquisition_opportunities add column if not exists primary_property_id text;
alter table public.acquisition_opportunities add column if not exists primary_thread_key text;
alter table public.acquisition_opportunities add column if not exists acquisition_stage text;
alter table public.acquisition_opportunities add column if not exists opportunity_status text;
alter table public.acquisition_opportunities add column if not exists automation_state text;
alter table public.acquisition_opportunities add column if not exists next_action text;
alter table public.acquisition_opportunities add column if not exists blocker text;
alter table public.acquisition_opportunities add column if not exists metadata jsonb;
alter table public.acquisition_opportunities add column if not exists active_offer_id text;
alter table public.acquisition_opportunities add column if not exists accepted_offer_id text;
alter table public.acquisition_opportunities add column if not exists updated_at timestamptz;

create table if not exists public.seller_offers (id uuid primary key default gen_random_uuid(), offer_id text unique);
alter table public.seller_offers add column if not exists opportunity_id uuid;
alter table public.seller_offers add column if not exists property_id text;
alter table public.seller_offers add column if not exists thread_key text;
alter table public.seller_offers add column if not exists master_owner_id text;
alter table public.seller_offers add column if not exists offer_version integer;
alter table public.seller_offers add column if not exists offer_type text;
alter table public.seller_offers add column if not exists direction text;
alter table public.seller_offers add column if not exists purchase_price numeric;
alter table public.seller_offers add column if not exists authorized_ceiling numeric;
alter table public.seller_offers add column if not exists status text;
alter table public.seller_offers add column if not exists accepted_at timestamptz;
alter table public.seller_offers add column if not exists acceptance_event_id text;
alter table public.seller_offers add column if not exists accepted_price numeric;
alter table public.seller_offers add column if not exists superseded_at timestamptz;
alter table public.seller_offers add column if not exists superseded_by_offer_id text;
alter table public.seller_offers add column if not exists terms_hash text;
alter table public.seller_offers add column if not exists metadata jsonb;

create table if not exists public.closing_cases (id uuid primary key default gen_random_uuid());
alter table public.closing_cases add column if not exists closing_case_id text;
alter table public.closing_cases add column if not exists opportunity_id uuid;
alter table public.closing_cases add column if not exists property_id text;
alter table public.closing_cases add column if not exists master_owner_id text;
alter table public.closing_cases add column if not exists thread_key text;
alter table public.closing_cases add column if not exists offer_id text;

create table if not exists public.send_queue (id uuid primary key default gen_random_uuid(), queue_key text, queue_status text, message_body text, to_phone_number varchar(20));
alter table public.send_queue add column if not exists thread_key text;
alter table public.send_queue add column if not exists property_id text;
alter table public.send_queue add column if not exists master_owner_id text;
alter table public.send_queue add column if not exists paused_reason text;
alter table public.send_queue add column if not exists metadata jsonb;
