-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. Setup for the Action Gateway migration tests
-- (supabase/migrations/PROPOSED_20261019160000_action_gateway.sql): the production public surface the
-- gateway's read inventory names and that the disposable chain fixtures do not already carry, plus
-- the production posture the apply requires:
--   * public.system_control has ROW LEVEL SECURITY enabled (production: operator lockdown
--     20261003130000). The gateway's key-allowlist policy is only meaningful with RLS on;
--   * the read-inventory tables the canonical conversation loaders select (prod-shaped subsets;
--     column names as read by context-loader.js / conversation-canonical-inputs.js /
--     send-time-contact-guard.js).
-- Composable with the chain fixtures: create-if-not-exists, then add-column-if-not-exists.
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
create extension if not exists pgcrypto;

create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
alter table public.system_control enable row level security;

create table if not exists public.properties (property_id text primary key);
alter table public.properties add column if not exists property_type text, add column if not exists property_address_city text,
  add column if not exists property_address_state text, add column if not exists property_address_zip text, add column if not exists timezone text,
  add column if not exists owner_1_name text, add column if not exists owner_2_name text, add column if not exists owner_name text,
  add column if not exists property_address text, add column if not exists property_address_full text, add column if not exists owner_address_state text,
  add column if not exists property_class text, add column if not exists units_count integer, add column if not exists market text;
create table if not exists public.prospects (prospect_id text primary key);
alter table public.prospects add column if not exists first_name text, add column if not exists full_name text, add column if not exists timezone text;
create table if not exists public.phones (phone_id text);
alter table public.phones add column if not exists canonical_e164 text, add column if not exists phone text, add column if not exists phone_raw text,
  add column if not exists phone_contact_status text, add column if not exists wrong_number_at timestamptz, add column if not exists primary_prospect_id text,
  add column if not exists canonical_prospect_id text, add column if not exists activity_status text;
create table if not exists public.contact_property_resolution (id uuid primary key default gen_random_uuid(), property_id text not null, contact_phone_e164 text not null,
  contact_property_role text, rejected_at timestamptz, rejection_reason text, suppression_scope text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique (property_id, contact_phone_e164));
create table if not exists public.automation_suppressions (id uuid primary key default gen_random_uuid(), phone_e164 text, status text, suppression_type text, suppression_reason text, expires_at timestamptz);
create table if not exists public.sms_suppression_list (id uuid primary key default gen_random_uuid());
alter table public.sms_suppression_list add column if not exists phone_e164 text, add column if not exists phone_number text, add column if not exists sender_phone_e164 text,
  add column if not exists is_active boolean, add column if not exists suppression_type text, add column if not exists suppression_reason text;
create table if not exists public.campaigns (id uuid primary key default gen_random_uuid(), name text, status text);
create table if not exists public.seller_offers (id uuid primary key default gen_random_uuid());
alter table public.seller_offers add column if not exists thread_key text, add column if not exists property_id text, add column if not exists purchase_price numeric,
  add column if not exists status text, add column if not exists created_at timestamptz default now();

alter table public.message_events add column if not exists provider_message_sid text, add column if not exists from_phone_number text,
  add column if not exists to_phone_number text, add column if not exists property_id text, add column if not exists prospect_id text,
  add column if not exists message_body text, add column if not exists queue_id text;
alter table public.inbox_thread_state add column if not exists canonical_e164 text, add column if not exists our_number text,
  add column if not exists lifecycle_stage text, add column if not exists contactability_status text, add column if not exists is_suppressed boolean,
  add column if not exists disposition text, add column if not exists last_intent text, add column if not exists stage text, add column if not exists market text;
alter table public.acquisition_opportunities add column if not exists market text;
