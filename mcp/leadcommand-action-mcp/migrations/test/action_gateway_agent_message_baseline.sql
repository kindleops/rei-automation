-- TEST BASELINE (disposable PostgreSQL only) for PROPOSED_20261029100000_action_gateway_agent_message.sql: the production
-- campaign / template relations the agent-message path reads, prod-shaped subsets (columns the campaign enqueue path,
-- the merge-field render and the definer reads use). Never applied to production (the real tables exist there).
create table if not exists public.campaign_targets (id uuid primary key default gen_random_uuid());
alter table public.campaign_targets add column if not exists campaign_id uuid, add column if not exists property_id text, add column if not exists master_owner_id text,
  add column if not exists prospect_id text, add column if not exists phone_id text, add column if not exists to_phone_number text, add column if not exists canonical_e164 text,
  add column if not exists market text, add column if not exists language text, add column if not exists timezone text, add column if not exists state text,
  add column if not exists property_address text, add column if not exists touch_number integer default 1, add column if not exists target_status text,
  add column if not exists routing_status text, add column if not exists identity_status text, add column if not exists suppression_status text,
  add column if not exists metadata jsonb default '{}'::jsonb, add column if not exists created_at timestamptz default now();

create table if not exists public.ownership_template_rotation_control (template_id text primary key);
alter table public.ownership_template_rotation_control add column if not exists rotation_status text, add column if not exists language text,
  add column if not exists daily_cap integer, add column if not exists traffic_weight numeric, add column if not exists block_reason text,
  add column if not exists last_40d_total_sent integer default 0;

create table if not exists public.master_owners (master_owner_id text primary key);
alter table public.master_owners add column if not exists agent_persona text;

alter table public.campaigns add column if not exists metadata jsonb default '{}'::jsonb, add column if not exists send_interval_seconds integer,
  add column if not exists contact_window_start text, add column if not exists contact_window_end text, add column if not exists agent_persona text;
alter table public.sms_templates add column if not exists template_name text;
alter table public.prospects add column if not exists likely_owner boolean, add column if not exists likely_renting boolean, add column if not exists matching_flags text,
  add column if not exists person_flags_text text;
alter table public.inbox_thread_state add column if not exists master_owner_id text, add column if not exists prospect_id text;
revoke all on public.campaign_targets, public.ownership_template_rotation_control, public.master_owners from anon, authenticated;
-- the campaign sender routing reads (enqueue-campaign-target-one.js#resolveSender)
alter table public.textgrid_numbers add column if not exists health_score numeric, add column if not exists cooling_until timestamptz;
