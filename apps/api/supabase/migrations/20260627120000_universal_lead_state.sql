-- Universal lead state columns on inbox_thread_state + per-operator preferences + audit trail
-- Production-safe: uses stage/status (not seller_stage/conversation_status), additive only.

alter table public.inbox_thread_state
  add column if not exists lifecycle_stage text,
  add column if not exists operational_status text,
  add column if not exists lead_temperature text,
  add column if not exists temperature text,
  add column if not exists seller_stage text,
  add column if not exists conversation_status text,
  add column if not exists contactability_status text default 'contactable',
  add column if not exists stage_source text,
  add column if not exists status_source text,
  add column if not exists temperature_source text,
  add column if not exists disposition_source text,
  add column if not exists contactability_source text,
  add column if not exists manual_stage_lock boolean not null default false,
  add column if not exists manual_temperature_lock boolean not null default false,
  add column if not exists snoozed_until timestamptz,
  add column if not exists snooze_reason text,
  add column if not exists archive_scope text,
  add column if not exists archive_reason text,
  add column if not exists paused_reason text,
  add column if not exists updated_by text,
  add column if not exists legacy_stage text,
  add column if not exists legacy_status text,
  add column if not exists temperature_confidence numeric,
  add column if not exists temperature_reason text;

-- disposition may already exist on production
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'disposition'
  ) then
    alter table public.inbox_thread_state add column disposition text;
  end if;
end $$;

create index if not exists idx_inbox_thread_state_lifecycle_stage
  on public.inbox_thread_state (lifecycle_stage);

create index if not exists idx_inbox_thread_state_operational_status
  on public.inbox_thread_state (operational_status);

create index if not exists idx_inbox_thread_state_lead_temperature
  on public.inbox_thread_state (lead_temperature);

create index if not exists idx_inbox_thread_state_disposition
  on public.inbox_thread_state (disposition);

create index if not exists idx_inbox_thread_state_contactability
  on public.inbox_thread_state (contactability_status);

create index if not exists idx_inbox_thread_state_snoozed_until
  on public.inbox_thread_state (snoozed_until)
  where snoozed_until is not null;

create index if not exists idx_inbox_thread_state_archive_scope
  on public.inbox_thread_state (archive_scope)
  where archive_scope is not null;

create table if not exists public.operator_entity_preferences (
  user_id text not null,
  entity_type text not null check (entity_type in ('thread', 'property', 'opportunity')),
  entity_id text not null,
  is_starred boolean not null default false,
  is_pinned boolean not null default false,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index if not exists idx_operator_entity_preferences_starred
  on public.operator_entity_preferences (user_id, is_starred)
  where is_starred = true;

create index if not exists idx_operator_entity_preferences_pinned
  on public.operator_entity_preferences (user_id, is_pinned)
  where is_pinned = true;

create table if not exists public.universal_lead_state_events (
  id uuid primary key default gen_random_uuid(),
  thread_key text not null,
  property_id text,
  field_name text not null,
  previous_value text,
  new_value text,
  operator_id text,
  source_view text,
  reason text,
  change_source text not null default 'manual',
  executed_next_action boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_universal_lead_state_events_thread
  on public.universal_lead_state_events (thread_key, created_at desc);

create index if not exists idx_universal_lead_state_events_property
  on public.universal_lead_state_events (property_id, created_at desc)
  where property_id is not null;

-- RLS for new tables (mirror inbox_thread_state permissive policies)
alter table public.operator_entity_preferences enable row level security;
alter table public.universal_lead_state_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'operator_entity_preferences' and policyname = 'anon_manage_operator_entity_preferences') then
    create policy anon_manage_operator_entity_preferences on public.operator_entity_preferences for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'operator_entity_preferences' and policyname = 'authenticated_manage_operator_entity_preferences') then
    create policy authenticated_manage_operator_entity_preferences on public.operator_entity_preferences for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'operator_entity_preferences' and policyname = 'service_role_manage_operator_entity_preferences') then
    create policy service_role_manage_operator_entity_preferences on public.operator_entity_preferences for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'universal_lead_state_events' and policyname = 'anon_manage_universal_lead_state_events') then
    create policy anon_manage_universal_lead_state_events on public.universal_lead_state_events for all to anon using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'universal_lead_state_events' and policyname = 'authenticated_manage_universal_lead_state_events') then
    create policy authenticated_manage_universal_lead_state_events on public.universal_lead_state_events for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'universal_lead_state_events' and policyname = 'service_role_manage_universal_lead_state_events') then
    create policy service_role_manage_universal_lead_state_events on public.universal_lead_state_events for all to service_role using (true) with check (true);
  end if;
end $$;

grant all on public.operator_entity_preferences to anon, authenticated, service_role;
grant all on public.universal_lead_state_events to anon, authenticated, service_role;

-- Safe backfill: preserve legacy values, derive canonical where possible (no SMS, no lifecycle actions)
update public.inbox_thread_state
set
  legacy_stage = coalesce(nullif(legacy_stage, ''), nullif(stage, '')),
  legacy_status = coalesce(nullif(legacy_status, ''), nullif(status, ''))
where legacy_stage is null or legacy_status is null;

update public.inbox_thread_state
set lifecycle_stage = case lower(coalesce(nullif(stage, ''), ''))
  when 'ownership_check' then 'ownership_confirmation'
  when 'consider_selling' then 'offer_interest'
  when 'needs_response' then 'offer_interest'
  when 'price_discovery' then 'asking_price'
  when 'dead' then 'closed'
  when 's1' then 'ownership_confirmation'
  when 's2' then 'offer_interest'
  when 'ownership_confirmation' then 'ownership_confirmation'
  when 'offer_interest' then 'offer_interest'
  when 'asking_price' then 'asking_price'
  when 'property_condition' then 'property_condition'
  when 'offer' then 'offer'
  when 'formal_contract' then 'formal_contract'
  when 'under_contract' then 'under_contract'
  when 'disposition' then 'disposition'
  when 'prepared_to_close' then 'prepared_to_close'
  when 'closed' then 'closed'
  when 'waiting' then 'offer_interest'
  else null
end
where lifecycle_stage is null
  and manual_stage_lock = false;

-- Ambiguous empty stage -> needs_review operational status (lifecycle left null for reconciliation)
update public.inbox_thread_state
set operational_status = 'needs_review'
where lifecycle_stage is null
  and coalesce(stage, '') = ''
  and operational_status is null
  and manual_override = false;

update public.inbox_thread_state
set operational_status = case lower(coalesce(nullif(status, ''), ''))
  when 'read' then 'active_communication'
  when 'active' then 'active_communication'
  when 'waiting' then 'waiting_on_seller'
  when 'unread' then 'new_reply'
  when 'suppressed' then 'paused'
  when 'new_reply' then 'new_reply'
  when 'dead' then 'paused'
  when 'needs_review' then 'needs_review'
  when 'not_contacted' then 'not_contacted'
  when 'scheduled' then 'scheduled'
  when 'snoozed' then 'snoozed'
  when 'paused' then 'paused'
  when 'active_communication' then 'active_communication'
  when 'waiting_on_seller' then 'waiting_on_seller'
  when 'follow_up_due' then 'follow_up_due'
  else null
end
where operational_status is null
  and manual_override = false;

update public.inbox_thread_state
set lead_temperature = case
  when is_hot_lead = true then 'hot'
  when lower(coalesce(priority, '')) = 'urgent' then 'hot'
  when lower(coalesce(priority, '')) = 'high' then 'warm'
  when lower(coalesce(stage, '')) = 'dead' or lower(coalesce(status, '')) = 'dead' then 'cold'
  else 'unscored'
end,
temperature = case
  when is_hot_lead = true then 'hot'
  when lower(coalesce(priority, '')) = 'urgent' then 'hot'
  when lower(coalesce(priority, '')) = 'high' then 'warm'
  when lower(coalesce(stage, '')) = 'dead' or lower(coalesce(status, '')) = 'dead' then 'cold'
  else 'unscored'
end
where (lead_temperature is null or lead_temperature = '')
  and manual_temperature_lock = false;

update public.inbox_thread_state
set disposition = coalesce(nullif(disposition, ''), 'none')
where disposition is null;

update public.inbox_thread_state
set contactability_status = case
  when is_suppressed = true then 'opted_out'
  else coalesce(contactability_status, 'contactable')
end
where contactability_status is null or contactability_status = '';

-- Mirror canonical values into legacy-compatible columns for downstream readers
update public.inbox_thread_state
set
  seller_stage = coalesce(seller_stage, lifecycle_stage, stage),
  conversation_status = coalesce(conversation_status, operational_status, status)
where seller_stage is null or conversation_status is null;