-- Minimum production-shaped prerequisites for the EMAIL-1 migration.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;

create table public.acquisition_opportunities (id uuid primary key default gen_random_uuid());

create table public.email_senders (
  id uuid primary key default gen_random_uuid(),
  sender_key text not null unique,
  from_email text not null unique,
  is_active boolean default true
);

create table public.email_queue (
  id uuid primary key default gen_random_uuid(),
  queue_key text not null unique,
  queue_status text not null,
  scheduled_for timestamptz,
  send_priority integer,
  is_locked boolean,
  locked_at timestamptz,
  lock_token text,
  retry_count integer,
  max_retries integer,
  next_retry_at timestamptz,
  to_email text not null,
  from_email text,
  subject text not null,
  email_body text not null,
  template_id text,
  provider_message_id text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_reason text,
  master_owner_id text,
  prospect_id text,
  property_id text,
  market_id text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.contact_outreach_state (
  id uuid primary key default gen_random_uuid(),
  podio_master_owner_id text,
  podio_prospect_id text,
  podio_property_id text,
  to_phone_number text,
  to_email text,
  current_campaign_key text,
  current_touch_number integer,
  current_stage text,
  last_sms_at timestamptz,
  last_email_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  next_allowed_sms_at timestamptz,
  next_allowed_email_at timestamptz,
  next_allowed_any_contact_at timestamptz,
  is_paused boolean,
  dnc boolean,
  pause_reason text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  first_outbound_at timestamptz,
  last_touch_at timestamptz,
  touch_count integer,
  last_queue_id uuid,
  last_message_event_id uuid,
  last_template_id text,
  last_agent_id text,
  last_market text,
  last_property_address text,
  last_property_type text,
  suppression_until timestamptz,
  suppression_reason text,
  canonical_e164 text,
  channel text
);
create unique index uq_contact_outreach_state_owner_phone
  on public.contact_outreach_state (podio_master_owner_id, to_phone_number);
