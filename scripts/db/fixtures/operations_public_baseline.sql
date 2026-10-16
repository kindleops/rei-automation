-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. The production public tables that the 8.5.20 part C operations
-- read model (PROPOSED_20261016140000_operations_action_center.sql) reads, with the columns it
-- reads, types as in production (information_schema, read-only, 2026-10-15). No data, no FKs.
-- agent_api gets NO grant on any of them: the agent.ops_* SECURITY DEFINER functions are the
-- only path (same rule as the runtime fixture of ops_health_snapshot).
-- Applied by scripts/db/run-migration-test.mjs (and the PG tests) as setup; never against Supabase.
create extension if not exists pgcrypto;
-- Composable with the other public fixtures (scripts/db/fixtures/send_queue_live_baseline.sql,
-- the runtime fixture): when one of them created send_queue / message_events first, the
-- create-if-not-exists below is a no-op, so the columns the operations read functions read
-- are added right after each create (before its indexes) (no-op when already present). Needed by the rc_8_5_20_release_chain entry.

create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());

create table if not exists public.inbox_thread_state (
  id uuid primary key default gen_random_uuid(), thread_key text unique, canonical_e164 text, master_owner_id text, prospect_id text, property_id text,
  market text, stage text, status text, priority text, is_archived boolean default false, is_read boolean default false, archived_at timestamptz,
  is_suppressed boolean default false, last_intent text, next_action text, inbound_count integer, outbound_count integer,
  latest_direction text, latest_message_at timestamptz, last_inbound_at timestamptz, last_outbound_at timestamptz,
  is_hot_lead boolean default false, follow_up_at timestamptz, inbox_bucket text, disposition text, next_action_at timestamptz,
  manual_override boolean default false, operational_status text, lead_temperature text, seller_stage text, contactability_status text,
  snoozed_until timestamptz, archive_reason text, created_at timestamptz default now(), updated_at timestamptz default now());
create index if not exists idx_inbox_thread_state_updated on public.inbox_thread_state (updated_at desc);

create table if not exists public.message_events (
  id uuid primary key default gen_random_uuid(), message_event_key text, direction text, event_type text, thread_key text,
  detected_intent text, is_opt_out boolean, language text, delivery_status text, provider_delivery_status text, is_final_failure boolean,
  auto_reply_status text, event_timestamp timestamptz, received_at timestamptz, sent_at timestamptz, delivered_at timestamptz,
  created_at timestamptz default now());
alter table public.message_events add column if not exists message_event_key text;
alter table public.message_events add column if not exists direction text;
alter table public.message_events add column if not exists event_type text;
alter table public.message_events add column if not exists thread_key text;
alter table public.message_events add column if not exists detected_intent text;
alter table public.message_events add column if not exists is_opt_out boolean;
alter table public.message_events add column if not exists language text;
alter table public.message_events add column if not exists delivery_status text;
alter table public.message_events add column if not exists provider_delivery_status text;
alter table public.message_events add column if not exists is_final_failure boolean;
alter table public.message_events add column if not exists auto_reply_status text;
alter table public.message_events add column if not exists event_timestamp timestamptz;
alter table public.message_events add column if not exists received_at timestamptz;
alter table public.message_events add column if not exists sent_at timestamptz;
alter table public.message_events add column if not exists delivered_at timestamptz;
alter table public.message_events add column if not exists created_at timestamptz default now();
create index if not exists idx_message_events_thread_event_ts on public.message_events (thread_key, event_timestamp);

create table if not exists public.send_queue (
  id uuid primary key default gen_random_uuid(), queue_status text, scheduled_for timestamptz, scheduled_for_utc timestamptz, thread_key text,
  from_phone_number varchar(20), message_type text, campaign_id uuid, provider_message_id text, failed_reason text,
  sent_at timestamptz, delivered_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
alter table public.send_queue add column if not exists queue_status text;
alter table public.send_queue add column if not exists scheduled_for timestamptz;
alter table public.send_queue add column if not exists scheduled_for_utc timestamptz;
alter table public.send_queue add column if not exists thread_key text;
alter table public.send_queue add column if not exists from_phone_number varchar(20);
alter table public.send_queue add column if not exists message_type text;
alter table public.send_queue add column if not exists campaign_id uuid;
alter table public.send_queue add column if not exists provider_message_id text;
alter table public.send_queue add column if not exists failed_reason text;
alter table public.send_queue add column if not exists sent_at timestamptz;
alter table public.send_queue add column if not exists delivered_at timestamptz;
alter table public.send_queue add column if not exists created_at timestamptz default now();
alter table public.send_queue add column if not exists updated_at timestamptz default now();
create index if not exists idx_send_queue_thread_key on public.send_queue (thread_key);
create index if not exists idx_send_queue_delivered_at on public.send_queue (delivered_at desc) where delivered_at is not null;

create table if not exists public.sms_suppression_list (id uuid primary key default gen_random_uuid(), phone_e164 text, is_active boolean, created_at timestamptz default now());

create table if not exists public.acquisition_opportunities (
  id uuid primary key default gen_random_uuid(), dedupe_key text unique, primary_property_id text, primary_thread_key text,
  acquisition_stage text, opportunity_status text, priority text, temperature text, estimated_value numeric, arv numeric,
  asking_price numeric, current_offer numeric, assigned_operator text, next_action text, next_action_due timestamptz, blocker text,
  approval_state text, latest_intent text, market text, stage_entered_at timestamptz, last_activity_at timestamptz, last_contact_at timestamptz,
  promotion_reason text, created_at timestamptz default now(), updated_at timestamptz default now());
create index if not exists idx_acq_opportunities_thread on public.acquisition_opportunities (primary_thread_key);

create table if not exists public.acquisition_opportunity_history (
  id uuid primary key default gen_random_uuid(), opportunity_id uuid, event_type text, field_name text, previous_value text, new_value text,
  reason text, actor text, source text, created_at timestamptz default now());

create table if not exists public.seller_offers (
  id uuid primary key default gen_random_uuid(), offer_id text unique, opportunity_id uuid, thread_key text, purchase_price numeric,
  ade_snapshot_id text, authorized_ceiling numeric, valuation_mid numeric, status text, created_at timestamptz default now(),
  sent_at timestamptz, metadata jsonb, policy_version text);

create table if not exists public.closing_cases (
  id uuid primary key default gen_random_uuid(), opportunity_id uuid, closing_status text, contract_status text, confirmed_gross_revenue numeric,
  created_at timestamptz default now());

create table if not exists public.seller_followup_state (
  id uuid primary key default gen_random_uuid(), thread_key text, objective text, status text, next_follow_up_at timestamptz,
  resolved_at timestamptz, enrolled_at timestamptz, created_at timestamptz default now());

create table if not exists public.property_acquisition_scores (
  id uuid primary key default gen_random_uuid(), property_id text, valuation_mid numeric, investor_ceiling_mid numeric, investor_ceiling_high numeric,
  buyer_demand_score integer, recommended_cash_offer numeric, minimum_acceptable_offer numeric, computed_at timestamptz, created_at timestamptz default now());

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(), name text, status text, last_transition_from text, last_transition_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists public.textgrid_numbers (
  id uuid primary key default gen_random_uuid(), phone_number text, status text, health_state text, health_changed_at timestamptz,
  spam_flagged_at timestamptz, cooling_until timestamptz, created_at timestamptz default now());

revoke all on public.system_control, public.inbox_thread_state, public.message_events, public.send_queue, public.sms_suppression_list,
  public.acquisition_opportunities, public.acquisition_opportunity_history, public.seller_offers, public.closing_cases,
  public.seller_followup_state, public.property_acquisition_scores, public.campaigns, public.textgrid_numbers from agent_api;
