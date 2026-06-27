-- Universal lead state columns on inbox_thread_state + per-operator preferences + audit trail

alter table public.inbox_thread_state
  add column if not exists lifecycle_stage text,
  add column if not exists operational_status text,
  add column if not exists disposition text,
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
  add column if not exists is_starred boolean not null default false,
  add column if not exists legacy_stage text,
  add column if not exists legacy_status text,
  add column if not exists temperature_confidence numeric,
  add column if not exists temperature_reason text;

create index if not exists idx_inbox_thread_state_lifecycle_stage
  on public.inbox_thread_state (lifecycle_stage);

create index if not exists idx_inbox_thread_state_operational_status
  on public.inbox_thread_state (operational_status);

create index if not exists idx_inbox_thread_state_disposition
  on public.inbox_thread_state (disposition);

create index if not exists idx_inbox_thread_state_contactability
  on public.inbox_thread_state (contactability_status);

create index if not exists idx_inbox_thread_state_snoozed_until
  on public.inbox_thread_state (snoozed_until)
  where snoozed_until is not null;

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

-- Safe backfill: preserve legacy values in legacy_* columns, derive canonical where possible
update public.inbox_thread_state
set
  legacy_stage = coalesce(legacy_stage, seller_stage, stage),
  legacy_status = coalesce(legacy_status, conversation_status, status);

update public.inbox_thread_state
set lifecycle_stage = case lower(coalesce(seller_stage, stage, ''))
  when 's1_ownership' then 'ownership_confirmation'
  when 's2_interest' then 'offer_interest'
  when 's3_pricing' then 'asking_price'
  when 's4_condition' then 'property_condition'
  when 's5_offer' then 'offer'
  when 's6_negotiation' then 'offer'
  when 's7_follow_up' then 'offer_interest'
  when 's8_closing' then 'formal_contract'
  when 'ownership_check' then 'ownership_confirmation'
  when 'interest_probe' then 'offer_interest'
  when 'price_discovery' then 'asking_price'
  when 'condition_details' then 'property_condition'
  when 'offer_reveal' then 'offer'
  when 'negotiation' then 'offer'
  when 'contract_path' then 'formal_contract'
  when 'contract_sent' then 'formal_contract'
  when 'under_contract' then 'under_contract'
  when 'closing' then 'prepared_to_close'
  when 'closed' then 'closed'
  when 'ownership_confirmation' then 'ownership_confirmation'
  when 'offer_interest' then 'offer_interest'
  when 'asking_price' then 'asking_price'
  when 'property_condition' then 'property_condition'
  when 'offer' then 'offer'
  when 'formal_contract' then 'formal_contract'
  when 'disposition' then 'disposition'
  when 'prepared_to_close' then 'prepared_to_close'
  else coalesce(lifecycle_stage, 'ownership_confirmation')
end
where lifecycle_stage is null;

update public.inbox_thread_state
set operational_status = case lower(coalesce(conversation_status, status, ''))
  when 'waiting' then 'waiting_on_seller'
  when 'follow_up' then 'follow_up_due'
  when 'offer_sent' then 'waiting_on_seller'
  when 'contract_sent' then 'waiting_on_seller'
  when 'under_contract' then 'active_communication'
  when 'closed' then 'paused'
  when 'new_reply' then 'new_reply'
  when 'active_communication' then 'active_communication'
  when 'needs_review' then 'needs_review'
  when 'snoozed' then 'snoozed'
  when 'paused' then 'paused'
  when 'scheduled' then 'scheduled'
  when 'waiting_on_seller' then 'waiting_on_seller'
  when 'follow_up_due' then 'follow_up_due'
  when 'not_contacted' then 'not_contacted'
  else coalesce(operational_status, 'not_contacted')
end
where operational_status is null;

update public.inbox_thread_state
set lead_temperature = case lower(coalesce(temperature, lead_temperature, ''))
  when 'dead' then 'cold'
  when 'warming' then 'warm'
  when 'engaged' then 'warm'
  when 'unknown' then 'unscored'
  when 'cold' then 'cold'
  when 'warm' then 'warm'
  when 'hot' then 'hot'
  when 'unscored' then 'unscored'
  else coalesce(lead_temperature, 'unscored')
end
where lead_temperature is null or lead_temperature = '';

update public.inbox_thread_state
set disposition = case
  when wrong_number = true then 'wrong_number'
  when not_interested = true then 'not_interested'
  else coalesce(disposition, 'none')
end
where disposition is null;

update public.inbox_thread_state
set contactability_status = case
  when opt_out = true or is_suppressed = true then 'opted_out'
  else coalesce(contactability_status, 'contactable')
end
where contactability_status is null;