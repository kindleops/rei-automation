-- =============================================================================
-- PROPOSED_20261101120000_record_sync.sql — agntei ↔ LeadCommand bidirectional record sync (link 10)
-- STATUS: PROPOSED. Nothing is applied or activated by this file existing. Tested on disposable PostgreSQL 17 only.
-- Requires links #26–#28 (the gateway), 6 (lead_annotations) and 9 (lead_events, lead_assignments).
-- =============================================================================
-- LeadCommand stays the canonical system of record. This link gives every synchronized field of a lead a VERSION and
-- an AUDITED CHANGE HISTORY, whoever changes it (LeadCommand's own screens and jobs, its registry, or agntei through
-- the Action Gateway), and publishes each change on the lead event feed IN THE SAME TRANSACTION as the change itself.
--
--   1. New canonical columns (LeadCommand had no home for them):
--        inbox_thread_state.conversation_stage            the seller-conversation stage (agntei's playbook stage),
--                                                         separate from the pipeline stage (lifecycle_stage, S1–S10)
--        acquisition_opportunities.property_market_status  active / off_market / listed / pending / sold / unknown,
--                                     .property_status_verified  a verified value is protected from unverified writes
--                                     .agreement_status / agreement_ref / agreement_environment
--                                     .archived_at / archive_reason (if the lead-visibility link has not added them)
--   2. lc_sync.field_versions  one row per (entity, id, field): the current version, when, by whom, from which system,
--                              and whether a person's edit or a verified fact protects it.
--      lc_sync.record_changes  append-only: source system, actor (kind and id), via (the agent principal), intent,
--                              timestamp, previous and new value, evidence, reason, version.
--   3. Capture triggers on inbox_thread_state, acquisition_opportunities, action_gateway.lead_assignments,
--      action_gateway.lead_annotations and seller_offers. A writer that does not say who it is (LeadCommand's screens,
--      its registry, its jobs) is attributed from the row's own *_source / updated_by columns. Each change appends a
--      `record_changed` event (field, version, coded old/new values, source, actor class; never free text, contact
--      values or message text: agent.payload_is_clean) — transactionally, so a committed change always has its event.
--   4. public.action_gateway_dw_record_change(uuid,uuid): the ONE lease-bound domain write of `apply_record_change`.
--      Optimistic concurrency per FIELD (expected_version; separate dimensions never conflict with each other),
--      protection of manual edits and verified facts against stale automated writes, the agent rules (no stage
--      regression without a person; contract and later stages only on a signed production agreement), reversible
--      archival that takes the lead out of active work (open follow-ups closed) and is restored from its own history.
--   5. Definer reads: public.action_gateway_record_state(uuid), public.action_gateway_record_history(uuid,integer).
--   6. Registry rows (#27): apply_record_change is a standing T2 action with basis 'reversible' (every change is
--      versioned and revertible from its history; nothing here reaches a seller).
-- Privileges: lc_action_gateway executes the three functions; nothing else changes.
-- Rollback: PROPOSED_20261101120000_record_sync_rollback.sql.

set local lock_timeout = '5s';
set local statement_timeout = '300s';

do $$
begin
  if to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then raise exception 'precondition: link #26 (action_gateway) is not applied'; end if;
  if to_regclass('action_gateway.extensions') is null then raise exception 'precondition: link #27 (the extension registry) is not applied'; end if;
  if to_regclass('action_gateway.lead_annotations') is null then raise exception 'precondition: link 6 (lead_annotations) is not applied'; end if;
  if to_regclass('action_gateway.lead_events') is null or to_regprocedure('public.lc_lead_event_append(text,text,text,uuid,jsonb,timestamptz)') is null then raise exception 'precondition: link 9 (lead_events) is not applied'; end if;
  if to_regnamespace('lc_sync') is not null then raise exception 'precondition: this link is already applied'; end if;
end $$;

create schema lc_sync;
revoke all on schema lc_sync from public, anon, authenticated;

-- ───────────────────────────────────────────── 1. canonical columns ──
alter table public.inbox_thread_state add column if not exists conversation_stage text;
alter table public.inbox_thread_state add constraint inbox_thread_state_conversation_stage_code check (conversation_stage is null or conversation_stage ~ '^[a-z][a-z_]{1,39}$');
alter table public.acquisition_opportunities
  add column if not exists property_market_status text,
  add column if not exists property_status_verified boolean not null default false,
  add column if not exists agreement_status text,
  add column if not exists agreement_ref text,
  add column if not exists agreement_environment text,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;
alter table public.acquisition_opportunities add constraint acquisition_opportunities_property_market_status_code
  check (property_market_status is null or property_market_status in ('active', 'off_market', 'listed', 'pending', 'sold', 'unknown'));
alter table public.acquisition_opportunities add constraint acquisition_opportunities_agreement_status_code
  check (agreement_status is null or agreement_status in ('draft', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired'));
alter table public.acquisition_opportunities add constraint acquisition_opportunities_agreement_ref_shape check (agreement_ref is null or agreement_ref ~ '^[A-Za-z0-9_.:-]{1,120}$');
alter table public.acquisition_opportunities add constraint acquisition_opportunities_agreement_environment_code check (agreement_environment is null or agreement_environment in ('production', 'demo', 'simulated'));

-- ───────────────────────────────────────────── 2. versions and the change history ──
create table lc_sync.field_versions (
  entity text not null check (entity in ('thread', 'opportunity')),
  entity_id uuid not null,
  field text not null check (field ~ '^[a-z][a-z_]{1,39}$'),
  version bigint not null check (version >= 1),
  value jsonb,
  changed_at timestamptz not null,
  source text not null check (source in ('leadcommand', 'agntei', 'system')),
  actor_kind text not null check (actor_kind in ('person', 'agent', 'system')),
  actor_id text,
  protected text check (protected is null or protected in ('manual', 'verified')),
  change_id uuid not null,
  primary key (entity, entity_id, field)
);
create table lc_sync.record_changes (
  change_id uuid primary key,
  entity text not null check (entity in ('thread', 'opportunity')),
  entity_id uuid not null,
  thread_id uuid,
  thread_key text,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  version bigint not null,
  source text not null,
  actor_kind text not null,
  actor_id text,
  via text,
  intent_id uuid,
  evidence jsonb,
  reason text,
  created_at timestamptz not null default clock_timestamp()
);
create index record_changes_thread on lc_sync.record_changes (thread_id, created_at desc);
create index record_changes_entity on lc_sync.record_changes (entity, entity_id, field, version desc);
create function lc_sync.record_changes_immutable() returns trigger language plpgsql set search_path = pg_catalog as $fn$
begin raise exception using errcode = 'P0001', message = 'lc_sync.record_changes is append-only'; end $fn$;
create trigger record_changes_append_only before update or delete on lc_sync.record_changes for each row execute function lc_sync.record_changes_immutable();
create trigger record_changes_no_truncate before truncate on lc_sync.record_changes for each statement execute function lc_sync.record_changes_immutable();
revoke all on all tables in schema lc_sync from public, anon, authenticated, service_role;

-- the lead event feed carries record changes too (the kind check is widened; the rollback restores it)
create table lc_sync.restore (key text primary key, value text not null);
do $$
declare c record;
begin
  select conname, pg_get_constraintdef(oid) as def into c from pg_constraint
   where conrelid = 'action_gateway.lead_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%lead_transferred%' limit 1;
  if c.conname is null then raise exception 'precondition: the lead_events kind check is not where link 9 put it'; end if;
  insert into lc_sync.restore (key, value) values ('lead_events_kind_check_name', c.conname), ('lead_events_kind_check_def', c.def);
  execute format('alter table action_gateway.lead_events drop constraint %I', c.conname);
  execute format('alter table action_gateway.lead_events add constraint %I check (kind in (''inbound_message'', ''lead_state_changed'', ''delivery_changed'', ''opt_out'', ''lead_transferred'', ''record_changed''))', c.conname);
end $$;

-- ───────────────────────────────────────────── 3. capture ──
/** An identifier safe to publish (agent ids, operator handles); anything else (an email address, free text) is withheld. */
create function lc_sync.safe_id(v text) returns text language sql immutable set search_path = pg_catalog as $fn$
  select case when v ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' and v !~ '@' then v else null end
$fn$;
/** Who made a change no context named: from the row's own *_source column for that field. */
create function lc_sync.actor_kind_of(p_source text) returns text language sql immutable set search_path = pg_catalog as $fn$
  select case lower(coalesce(p_source, ''))
    when 'manual' then 'person' when 'operator' then 'person' when 'human' then 'person'
    when 'ai' then 'agent' when 'agent' then 'agent'
    else 'system' end
$fn$;
/** A value is published on the feed only when it is a code, a number, a boolean or a time — never free text. */
create function lc_sync.publishable(p_field text, p_value jsonb) returns jsonb language sql immutable set search_path = pg_catalog as $fn$
  select case when p_value is null or jsonb_typeof(p_value) in ('number', 'boolean', 'null') then p_value
              when jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[A-Za-z0-9_.:+-]{1,40}$' then p_value
              else null end
$fn$;

/** Record one field change: bump its version, append the history row and the lead event (same transaction). */
create function lc_sync.record(p_entity text, p_entity_id uuid, p_thread_id uuid, p_thread_key text, p_field text, p_old jsonb, p_new jsonb, p_row_source text, p_row_actor text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  ctx jsonb; v_source text; v_kind text; v_actor text; v_via text; v_intent uuid; v_evidence jsonb; v_reason text; v_prot text;
  v_ver bigint; v_id uuid := gen_random_uuid(); v_now timestamptz := clock_timestamp();
begin
  -- nothing changed (an insert with no value, or the same value again): no version, no history, no event
  if p_old is not distinct from p_new or (p_old is null and (p_new is null or jsonb_typeof(p_new) = 'null')) then return null; end if;
  begin ctx := nullif(current_setting('lc_sync.ctx', true), '')::jsonb; exception when others then ctx := null; end;
  if ctx is not null and (ctx ->> 'thread_id') is not distinct from p_thread_id::text then
    v_source := coalesce(ctx ->> 'source', 'agntei'); v_kind := coalesce(ctx ->> 'actor_kind', 'agent'); v_actor := ctx ->> 'actor_id';
    v_via := ctx ->> 'via'; v_intent := nullif(ctx ->> 'intent_id', '')::uuid; v_evidence := ctx -> 'evidence'; v_reason := ctx ->> 'reason';
  else
    v_source := 'leadcommand'; v_kind := lc_sync.actor_kind_of(p_row_source); v_actor := p_row_actor; v_via := null; v_intent := null; v_evidence := null; v_reason := null;
  end if;
  -- a person's edit is protected from stale automated writes; a verified fact from unverified ones
  v_prot := case when v_kind = 'person' then 'manual'
                 when p_field = 'property_status' and coalesce((ctx -> 'evidence' ->> 'verified')::boolean, false) then 'verified'
                 else null end;
  insert into lc_sync.field_versions as f (entity, entity_id, field, version, value, changed_at, source, actor_kind, actor_id, protected, change_id)
  values (p_entity, p_entity_id, p_field, 1, p_new, v_now, v_source, v_kind, v_actor, v_prot, v_id)
  on conflict (entity, entity_id, field) do update
     set version = f.version + 1, value = excluded.value, changed_at = excluded.changed_at, source = excluded.source,
         actor_kind = excluded.actor_kind, actor_id = excluded.actor_id, protected = excluded.protected, change_id = excluded.change_id
  returning version into v_ver;
  insert into lc_sync.record_changes (change_id, entity, entity_id, thread_id, thread_key, field, old_value, new_value, version, source, actor_kind, actor_id, via, intent_id, evidence, reason, created_at)
  values (v_id, p_entity, p_entity_id, p_thread_id, p_thread_key, p_field, p_old, p_new, v_ver, v_source, v_kind, v_actor, v_via, v_intent, v_evidence, v_reason, v_now);
  if p_thread_id is not null or p_thread_key is not null then
    perform public.lc_lead_event_append('record_changed', v_id::text, p_thread_key, p_thread_id,
      jsonb_strip_nulls(jsonb_build_object('entity', p_entity, 'field', p_field, 'version', v_ver,
        'from', lc_sync.publishable(p_field, p_old), 'to', lc_sync.publishable(p_field, p_new),
        'has_value', p_new is not null and jsonb_typeof(p_new) <> 'null',
        'source', v_source, 'actor_kind', v_kind, 'actor_id', lc_sync.safe_id(v_actor), 'via', lc_sync.safe_id(v_via),
        'protected', v_prot, 'change_id', v_id::text)), v_now);
  end if;
  return v_id;
end
$fn$;

create function lc_sync.capture_thread() returns trigger language plpgsql security definer set search_path = pg_catalog as $fn$
declare o public.inbox_thread_state; ins boolean := tg_op = 'INSERT';
begin
  if ins then o := null; else o := old; end if;
  if ins or new.conversation_stage is distinct from o.conversation_stage then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'conversation_stage', to_jsonb(o.conversation_stage), to_jsonb(new.conversation_stage), new.stage_source, new.updated_by); end if;
  if ins or new.lifecycle_stage is distinct from o.lifecycle_stage then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'pipeline_stage', to_jsonb(o.lifecycle_stage), to_jsonb(new.lifecycle_stage), new.stage_source, new.updated_by); end if;
  if ins or new.lead_temperature is distinct from o.lead_temperature then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'temperature', to_jsonb(o.lead_temperature), to_jsonb(new.lead_temperature), new.temperature_source, new.updated_by); end if;
  if ins or new.operational_status is distinct from o.operational_status then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'status', to_jsonb(o.operational_status), to_jsonb(new.operational_status), new.status_source, new.updated_by); end if;
  if ins or new.disposition is distinct from o.disposition then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'disposition', to_jsonb(o.disposition), to_jsonb(new.disposition), new.disposition_source, new.updated_by); end if;
  if ins or coalesce(new.is_archived, false) is distinct from coalesce(o.is_archived, false) then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'archived', to_jsonb(coalesce(o.is_archived, false)), to_jsonb(coalesce(new.is_archived, false)), null, new.updated_by); end if;
  if ins or new.follow_up_at is distinct from o.follow_up_at then
    perform lc_sync.record('thread', new.id, new.id, new.thread_key, 'follow_up_at', to_jsonb(o.follow_up_at), to_jsonb(new.follow_up_at), null, new.updated_by); end if;
  return null;
end $fn$;
create trigger lc_sync_capture_insert after insert on public.inbox_thread_state for each row execute function lc_sync.capture_thread();
create trigger lc_sync_capture_update after update on public.inbox_thread_state for each row
  when (old.conversation_stage is distinct from new.conversation_stage or old.lifecycle_stage is distinct from new.lifecycle_stage
     or old.lead_temperature is distinct from new.lead_temperature or old.operational_status is distinct from new.operational_status
     or old.disposition is distinct from new.disposition or old.is_archived is distinct from new.is_archived or old.follow_up_at is distinct from new.follow_up_at)
  execute function lc_sync.capture_thread();

create function lc_sync.capture_opportunity() returns trigger language plpgsql security definer set search_path = pg_catalog as $fn$
declare o public.acquisition_opportunities; ins boolean := tg_op = 'INSERT'; v_tid uuid;
begin
  if ins then o := null; else o := old; end if;
  select t.id into v_tid from public.inbox_thread_state t where t.thread_key = new.primary_thread_key order by t.id limit 1;
  if ins or new.acquisition_stage is distinct from o.acquisition_stage then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'deal_stage', to_jsonb(o.acquisition_stage), to_jsonb(new.acquisition_stage), null, null); end if;
  if ins or new.opportunity_status is distinct from o.opportunity_status then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'opportunity_status', to_jsonb(o.opportunity_status), to_jsonb(new.opportunity_status), null, null); end if;
  if ins or new.property_market_status is distinct from o.property_market_status or new.property_status_verified is distinct from o.property_status_verified then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'property_status', to_jsonb(o.property_market_status), to_jsonb(new.property_market_status), null, null); end if;
  if ins or new.agreement_status is distinct from o.agreement_status then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'agreement_status', to_jsonb(o.agreement_status), to_jsonb(new.agreement_status), null, null); end if;
  if ins or new.assigned_operator is distinct from o.assigned_operator then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'assigned_operator', to_jsonb(o.assigned_operator), to_jsonb(new.assigned_operator), null, null); end if;
  if ins or new.next_action_due is distinct from o.next_action_due then
    perform lc_sync.record('opportunity', new.id, v_tid, new.primary_thread_key, 'next_action_due', to_jsonb(o.next_action_due), to_jsonb(new.next_action_due), null, null); end if;
  return null;
end $fn$;
create trigger lc_sync_capture_insert after insert on public.acquisition_opportunities for each row execute function lc_sync.capture_opportunity();
create trigger lc_sync_capture_update after update on public.acquisition_opportunities for each row
  when (old.acquisition_stage is distinct from new.acquisition_stage or old.opportunity_status is distinct from new.opportunity_status
     or old.property_market_status is distinct from new.property_market_status or old.property_status_verified is distinct from new.property_status_verified
     or old.agreement_status is distinct from new.agreement_status or old.assigned_operator is distinct from new.assigned_operator or old.next_action_due is distinct from new.next_action_due)
  execute function lc_sync.capture_opportunity();

-- the agent holding a lead (link 9's lease): a new hold or a release is an assignment change of that thread
create function lc_sync.capture_assignment() returns trigger language plpgsql security definer set search_path = pg_catalog as $fn$
declare v_tk text;
begin
  if new.thread_id is null then return null; end if;
  select t.thread_key into v_tk from public.inbox_thread_state t where t.id = new.thread_id;
  if tg_op = 'INSERT' and new.released_at is null then
    perform lc_sync.record('thread', new.thread_id, new.thread_id, v_tk, 'assigned_agent', null, to_jsonb(new.agent_id), 'agent', new.agent_id);
  elsif tg_op = 'UPDATE' and old.released_at is null and new.released_at is not null then
    -- released: no holder now unless another open hold exists (a transfer inserts the new holder's row)
    if not exists (select 1 from action_gateway.lead_assignments a where a.lead_ref = new.lead_ref and a.org_id = new.org_id and a.released_at is null and a.assignment_id <> new.assignment_id) then
      perform lc_sync.record('thread', new.thread_id, new.thread_id, v_tk, 'assigned_agent', to_jsonb(new.agent_id), 'null'::jsonb, 'system', null);
    end if;
  end if;
  return null;
end $fn$;
create trigger lc_sync_capture_assignment after insert or update on action_gateway.lead_assignments for each row execute function lc_sync.capture_assignment();

-- notes and seller facts (append-only annotations): an event per entry, so the other side reads it at once
create function lc_sync.capture_annotation() returns trigger language plpgsql security definer set search_path = pg_catalog as $fn$
begin
  perform public.lc_lead_event_append('record_changed', 'ann_' || new.annotation_id::text, new.thread_key, new.thread_id,
    jsonb_strip_nulls(jsonb_build_object('entity', 'thread', 'field', 'annotation', 'item_id', new.annotation_id::text, 'kind', new.kind, 'class', new.class,
      'source', 'leadcommand', 'actor_kind', 'agent', 'actor_id', lc_sync.safe_id(new.agent_id))), new.created_at);
  return null;
end $fn$;
create trigger lc_sync_capture_annotation after insert on action_gateway.lead_annotations for each row execute function lc_sync.capture_annotation();

-- offers and counteroffers (seller_offers, versioned per opportunity): an event per new version or status change
create function lc_sync.capture_offer() returns trigger language plpgsql security definer set search_path = pg_catalog as $fn$
declare v_tid uuid;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  select t.id into v_tid from public.inbox_thread_state t where t.thread_key = new.thread_key order by t.id limit 1;
  perform public.lc_lead_event_append('record_changed', 'offer_' || new.id::text || '_' || coalesce(new.status, 'none'), new.thread_key, v_tid,
    jsonb_strip_nulls(jsonb_build_object('entity', 'opportunity', 'field', 'offer', 'item_id', new.id::text, 'offer_version', new.offer_version,
      'direction', new.direction, 'status', new.status, 'amount', new.purchase_price, 'source', 'leadcommand', 'actor_kind', 'system')), coalesce(new.updated_at, now()));
  return null;
end $fn$;
do $$ begin
  if to_regclass('public.seller_offers') is not null then
    create trigger lc_sync_capture_offer after insert or update on public.seller_offers for each row execute function lc_sync.capture_offer();
  end if;
end $$;

-- ───────────────────────────────────────────── 4. the domain write ──
/** The field → (entity, column) catalog. */
create function lc_sync.field_entity(p_field text) returns text language sql immutable set search_path = pg_catalog as $fn$
  select case when p_field in ('conversation_stage', 'pipeline_stage', 'temperature', 'status', 'disposition', 'archived', 'follow_up_at', 'assigned_agent') then 'thread'
              when p_field in ('deal_stage', 'opportunity_status', 'property_status', 'agreement_status', 'assigned_operator', 'next_action_due') then 'opportunity'
              else null end
$fn$;
create function lc_sync.stage_rank(p text) returns integer language sql immutable set search_path = pg_catalog as $fn$
  select array_position(array['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed'], p)
$fn$;

create function public.action_gateway_dw_record_change(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; v_auth action_gateway.action_authorizations%rowtype;
  t public.inbox_thread_state%rowtype; o public.acquisition_opportunities%rowtype;
  p jsonb; v_field text; v_entity text; v_eid uuid; v_val jsonb; v_expect bigint; f lc_sync.field_versions%rowtype; v_cur bigint;
  v_actor_kind text; v_actor_id text; v_ev jsonb; v_ev_src text; v_ev_at timestamptz; v_reason text; v_s text; v_prev jsonb;
  v_arch boolean; v_arch_reason text; v_disp text; v_opp_status text; v_out jsonb; v_lock boolean; v_a_intent uuid; v_a_at timestamptz;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['apply_record_change', 'apply_person_record_change']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  begin
    select * into v_auth from action_gateway.action_authorizations where intent_id = i.intent_id;
    if v_auth.authorization_id is null or (v_auth.grant_id is null and v_auth.approval_id is null) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'STANDING_GRANT_OR_APPROVAL_REQUIRED', '{}'::jsonb);
    end if;
    p := i.params;
    v_field := p ->> 'field'; v_entity := lc_sync.field_entity(v_field); v_val := p -> 'value';
    v_expect := nullif(p ->> 'expected_version', '')::bigint;
    -- who: a person only through apply_person_record_change (a capability granted to agntei's console credential alone,
    -- which names the person); anything else is the calling agent itself — a parameter never decides it
    v_actor_kind := case when i.action = 'apply_person_record_change' then 'person' else 'agent' end;
    v_actor_id := case when v_actor_kind = 'person' then p ->> 'edited_by' else i.agent_id end;
    v_ev := coalesce(p -> 'evidence', '{}'::jsonb); v_ev_src := v_ev ->> 'source';
    v_ev_at := case when (v_ev ->> 'at') ~ '^\d{4}-\d{2}-\d{2}' then (v_ev ->> 'at')::timestamptz else null end;
    v_reason := left(p ->> 'reason', 400);
    if v_entity is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'FIELD_NOT_SYNCHRONIZED', jsonb_build_object('field', v_field)); end if;
    if v_expect is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'EXPECTED_VERSION_REQUIRED', jsonb_build_object('field', v_field)); end if;
    if v_field = 'assigned_agent' then return action_gateway.finish_intent(i.intent_id, 'refused', 'USE_TRANSFER_LEAD', jsonb_build_object('field', v_field)); end if;
    -- a person's edit names its person (the console principal is agntei's, never an agent's own credential)
    if v_actor_kind = 'person' and coalesce(p ->> 'edited_by', '') !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$' then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'PERSON_ACTOR_REQUIRED', '{}'::jsonb);
    end if;

    select * into t from public.inbox_thread_state where id = (p ->> 'thread_id')::uuid for update;
    if t.id is null then return action_gateway.finish_intent(i.intent_id, 'failed', 'THREAD_NOT_FOUND', '{}'::jsonb); end if;
    select * into o from public.acquisition_opportunities where primary_thread_key = t.thread_key order by created_at limit 1 for update;
    if v_entity = 'opportunity' and o.id is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'NO_OPPORTUNITY', jsonb_build_object('field', v_field)); end if;
    v_eid := case when v_entity = 'thread' then t.id else o.id end;

    -- optimistic concurrency, per field: the version the writer saw must still be the current one
    select * into f from lc_sync.field_versions where entity = v_entity and entity_id = v_eid and field = v_field for update;
    v_cur := coalesce(f.version, 0);
    if v_expect <> v_cur then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'VERSION_CONFLICT', jsonb_build_object('field', v_field, 'expected_version', v_expect,
        'current', jsonb_build_object('version', v_cur, 'value', f.value, 'changed_at', f.changed_at, 'source', f.source, 'actor_kind', f.actor_kind, 'actor_id', f.actor_id, 'protected', f.protected)));
    end if;

    if v_actor_kind = 'agent' then
      -- an operator's lock in LeadCommand is final for automation
      v_lock := case when v_field in ('pipeline_stage', 'conversation_stage', 'status') then coalesce(t.manual_stage_lock, false)
                     when v_field = 'temperature' then coalesce(t.manual_temperature_lock, false) else false end;
      if v_lock then return action_gateway.finish_intent(i.intent_id, 'refused', 'PROTECTED_MANUAL_LOCK', jsonb_build_object('field', v_field)); end if;
      -- a person's edit stands against automated writes unless the agent's evidence is newer than that edit
      if f.protected = 'manual' and (v_ev_at is null or v_ev_at <= f.changed_at) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'PROTECTED_MANUAL', jsonb_build_object('field', v_field, 'protected_since', f.changed_at, 'by', f.actor_id));
      end if;
      -- an agent changes a pipeline field only on named evidence
      if v_field <> 'follow_up_at' and coalesce(v_ev_src, '') not in ('seller_message', 'underwriting', 'research', 'agreement', 'leadcommand_record', 'document', 'person') then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'EVIDENCE_REQUIRED', jsonb_build_object('field', v_field));
      end if;
    end if;
    if v_field = 'property_status' and f.protected = 'verified' and not coalesce((v_ev ->> 'verified')::boolean, false) then
      return action_gateway.finish_intent(i.intent_id, 'refused', 'PROTECTED_VERIFIED', jsonb_build_object('field', v_field));
    end if;

    perform set_config('lc_sync.ctx', jsonb_build_object('thread_id', t.id::text, 'source', 'agntei', 'actor_kind', v_actor_kind, 'actor_id', v_actor_id,
      'via', i.agent_id, 'intent_id', i.intent_id::text, 'evidence', v_ev, 'reason', v_reason)::text, true);

    if v_field in ('pipeline_stage', 'deal_stage') then
      v_s := v_val #>> '{}';
      if lc_sync.stage_rank(v_s) is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field)); end if;
      if v_actor_kind = 'agent' then
        if lc_sync.stage_rank(v_s) < coalesce(lc_sync.stage_rank(case when v_field = 'pipeline_stage' then t.lifecycle_stage else o.acquisition_stage end), 0) then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'STAGE_REGRESSION_REQUIRES_PERSON', jsonb_build_object('field', v_field));
        end if;
        if lc_sync.stage_rank(v_s) >= 6 and not (v_ev_src = 'agreement' and v_ev ->> 'agreement_status' = 'completed' and v_ev ->> 'environment' = 'production') then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'CONTRACT_STAGE_REQUIRES_SIGNED_AGREEMENT', jsonb_build_object('field', v_field, 'to', v_s));
        end if;
      end if;
      -- one pipeline: the thread's stage and its opportunity's stage move together (LeadCommand's projection rule)
      update public.inbox_thread_state set lifecycle_stage = v_s, seller_stage = v_s, stage_source = case when v_actor_kind = 'person' then 'manual' else 'ai' end,
             updated_by = v_actor_id, updated_at = now() where id = t.id;
      if o.id is not null then update public.acquisition_opportunities set acquisition_stage = v_s, stage_entered_at = now(), updated_at = now() where id = o.id; end if;
    elsif v_field = 'conversation_stage' then
      v_s := v_val #>> '{}';
      if v_s is null or v_s !~ '^[a-z][a-z_]{1,39}$' then return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field)); end if;
      update public.inbox_thread_state set conversation_stage = v_s, stage_source = case when v_actor_kind = 'person' then 'manual' else 'ai' end, updated_by = v_actor_id, updated_at = now() where id = t.id;
    elsif v_field = 'temperature' then
      v_s := v_val #>> '{}';
      if v_s not in ('unscored', 'cold', 'warm', 'hot') then return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field)); end if;
      update public.inbox_thread_state set lead_temperature = v_s, temperature = v_s, temperature_source = case when v_actor_kind = 'person' then 'manual' else 'ai' end,
             temperature_reason = left(v_reason, 240), updated_by = v_actor_id, updated_at = now() where id = t.id;
    elsif v_field = 'status' then
      v_s := v_val #>> '{}';
      if v_s not in ('not_contacted', 'scheduled', 'new_reply', 'active_communication', 'waiting_on_seller', 'follow_up_due', 'needs_review', 'snoozed', 'paused')
         or (v_actor_kind = 'agent' and v_s in ('not_contacted', 'scheduled', 'new_reply')) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.inbox_thread_state set operational_status = v_s, status_source = case when v_actor_kind = 'person' then 'manual' else 'ai' end, updated_by = v_actor_id, updated_at = now() where id = t.id;
    elsif v_field = 'disposition' then
      v_s := v_val #>> '{}';
      if v_s not in ('interested', 'not_interested', 'wrong_person', 'wrong_number', 'referred', 'sold', 'duplicate', 'unqualified', 'no_response', 'declined_unverified', 'none') then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.inbox_thread_state set disposition = v_s, disposition_source = case when v_actor_kind = 'person' then 'manual' else 'ai' end, updated_by = v_actor_id, updated_at = now() where id = t.id;
    elsif v_field = 'archived' then
      -- value: "archived:sold" | "archived:unavailable" | "archived:duplicate" | "archived:dead" | "archived:other" | "active"
      v_s := v_val #>> '{}';
      v_arch := case when v_s like 'archived:%' then true when v_s = 'active' then false else null end;
      v_arch_reason := case when v_arch then split_part(v_s, ':', 2) else null end;
      if v_arch is null or (v_arch and coalesce(v_arch_reason, '') not in ('sold', 'unavailable', 'duplicate', 'dead', 'other')) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      if v_arch = coalesce(t.is_archived, false) then return action_gateway.finish_intent(i.intent_id, 'refused', 'ALREADY_SET', jsonb_build_object('field', v_field)); end if;
      if v_arch then
        -- out of active work: the lead is archived (never deleted), its disposition says why, open follow-ups close
        v_disp := case v_arch_reason when 'sold' then 'sold' when 'duplicate' then 'duplicate' else t.disposition end;
        v_opp_status := case v_arch_reason when 'sold' then 'lost' when 'unavailable' then 'dead' when 'dead' then 'dead' else 'archived' end;
        update public.inbox_thread_state set is_archived = true, archived_at = now(), archive_scope = 'lead', archive_reason = left(v_arch_reason || coalesce(': ' || v_reason, ''), 240),
               disposition = v_disp, disposition_source = case when v_disp is distinct from t.disposition then (case when v_actor_kind = 'person' then 'manual' else 'ai' end) else disposition_source end,
               updated_by = v_actor_id, updated_at = now() where id = t.id;
        if o.id is not null then update public.acquisition_opportunities set opportunity_status = v_opp_status, archived_at = now(), archive_reason = left(v_arch_reason, 120), updated_at = now() where id = o.id; end if;
        if to_regprocedure('public.followup_intent_close_for_thread(jsonb)') is not null then
          perform public.followup_intent_close_for_thread(jsonb_build_object('thread_key', t.thread_key, 'reason', 'lead_archived:' || v_arch_reason, 'actor', 'lc_sync:' || coalesce(lc_sync.safe_id(v_actor_id), 'actor')));
        end if;
      else
        -- restored: the archive is undone from the lead's own history — the values the archive change itself replaced
        -- (the same intent when agntei archived it; the same moment when LeadCommand did)
        select c.intent_id, c.created_at into v_a_intent, v_a_at from lc_sync.record_changes c
         where c.entity = 'thread' and c.entity_id = t.id and c.field = 'archived' and c.new_value = 'true'::jsonb order by c.created_at desc limit 1;
        v_prev := null;
        select c.old_value into v_prev from lc_sync.record_changes c where c.entity = 'thread' and c.entity_id = t.id and c.field = 'disposition'
           and ((v_a_intent is not null and c.intent_id = v_a_intent) or (v_a_intent is null and c.created_at between v_a_at - interval '1 second' and v_a_at + interval '1 second'))
         order by c.created_at limit 1;
        update public.inbox_thread_state set is_archived = false, archived_at = null, archive_scope = null, archive_reason = null,
               disposition = case when v_prev is not null then v_prev #>> '{}' else disposition end, updated_by = v_actor_id, updated_at = now() where id = t.id;
        if o.id is not null then
          v_prev := null;
          select c.old_value into v_prev from lc_sync.record_changes c where c.entity = 'opportunity' and c.entity_id = o.id and c.field = 'opportunity_status'
             and ((v_a_intent is not null and c.intent_id = v_a_intent) or (v_a_intent is null and c.created_at between v_a_at - interval '1 second' and v_a_at + interval '1 second'))
           order by c.created_at limit 1;
          update public.acquisition_opportunities set opportunity_status = coalesce(v_prev #>> '{}', 'active'), archived_at = null, archive_reason = null, updated_at = now() where id = o.id;
        end if;
      end if;
    elsif v_field = 'follow_up_at' then
      if coalesce(v_val #>> '{}', '') <> '' and (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T' then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.inbox_thread_state set follow_up_at = nullif(v_val #>> '{}', '')::timestamptz,
             updated_by = v_actor_id, updated_at = now() where id = t.id;
    elsif v_field = 'opportunity_status' then
      v_s := v_val #>> '{}';
      if v_s not in ('active', 'waiting', 'paused', 'nurture', 'won', 'lost', 'dead', 'suppressed', 'archived') or (v_actor_kind = 'agent' and v_s in ('won', 'suppressed')) then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.acquisition_opportunities set opportunity_status = v_s, updated_at = now() where id = o.id;
    elsif v_field = 'property_status' then
      v_s := v_val #>> '{}';
      if v_s not in ('active', 'off_market', 'listed', 'pending', 'sold', 'unknown') then return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field)); end if;
      update public.acquisition_opportunities set property_market_status = v_s, property_status_verified = coalesce((v_ev ->> 'verified')::boolean, false), updated_at = now() where id = o.id;
    elsif v_field = 'agreement_status' then
      v_s := v_val #>> '{}';
      if v_s not in ('draft', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired') or coalesce(v_ev ->> 'environment', '') not in ('production', 'demo', 'simulated')
         or coalesce(v_ev ->> 'ref', '') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.acquisition_opportunities set agreement_status = v_s, agreement_ref = v_ev ->> 'ref', agreement_environment = v_ev ->> 'environment', updated_at = now() where id = o.id;
    elsif v_field = 'assigned_operator' then
      if v_actor_kind <> 'person' then return action_gateway.finish_intent(i.intent_id, 'refused', 'PERSON_ONLY_FIELD', jsonb_build_object('field', v_field)); end if;
      update public.acquisition_opportunities set assigned_operator = nullif(v_val #>> '{}', ''), updated_at = now() where id = o.id;
    elsif v_field = 'next_action_due' then
      if coalesce(v_val #>> '{}', '') <> '' and (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T' then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'VALUE_INVALID', jsonb_build_object('field', v_field));
      end if;
      update public.acquisition_opportunities set next_action_due = nullif(v_val #>> '{}', '')::timestamptz, updated_at = now() where id = o.id;
    end if;
    perform set_config('lc_sync.ctx', '', true);

    -- the new versions of every field this write changed (an archive changes several)
    select coalesce(jsonb_object_agg(fv.field, jsonb_build_object('version', fv.version, 'value', fv.value, 'changed_at', fv.changed_at)), '{}'::jsonb) into v_out
      from lc_sync.field_versions fv where fv.change_id in (select c.change_id from lc_sync.record_changes c where c.intent_id = i.intent_id);
    if v_out = '{}'::jsonb then return action_gateway.finish_intent(i.intent_id, 'refused', 'ALREADY_SET', jsonb_build_object('field', v_field)); end if;
    return action_gateway.finish_intent(i.intent_id, 'succeeded', 'RECORD_CHANGED', jsonb_build_object('field', v_field, 'thread_id', t.id, 'opportunity_id', o.id, 'fields', v_out));
  exception when others then
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;
comment on function public.action_gateway_dw_record_change(uuid, uuid) is 'agntei record sync (link 10): the lease-bound domain write of apply_record_change — per-field optimistic concurrency, protection of manual edits and verified facts, agent evidence rules, reversible archival. Reads its parameters from the authorized intent only.';

-- ───────────────────────────────────────────── 5. definer reads ──
/** A lead's synchronized record now: each field's value (from the canonical columns), version and provenance. */
create function public.action_gateway_record_state(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare t public.inbox_thread_state%rowtype; o public.acquisition_opportunities%rowtype; v_holder text; r jsonb := '{}'::jsonb; k text; v jsonb; ent text; eid uuid; f lc_sync.field_versions%rowtype;
begin
  select * into t from public.inbox_thread_state where id = p_thread_id;
  if t.id is null then return null; end if;
  select * into o from public.acquisition_opportunities where primary_thread_key = t.thread_key order by created_at limit 1;
  select a.agent_id into v_holder from action_gateway.lead_assignments a where a.thread_id = t.id and a.released_at is null and a.lease_until > now() order by a.assigned_at desc limit 1;
  for k, v in select * from jsonb_each(jsonb_build_object(
      'conversation_stage', to_jsonb(t.conversation_stage), 'pipeline_stage', to_jsonb(t.lifecycle_stage), 'temperature', to_jsonb(t.lead_temperature),
      'status', to_jsonb(t.operational_status), 'disposition', to_jsonb(t.disposition), 'archived', to_jsonb(coalesce(t.is_archived, false)),
      'follow_up_at', to_jsonb(t.follow_up_at), 'assigned_agent', to_jsonb(v_holder),
      'deal_stage', to_jsonb(o.acquisition_stage), 'opportunity_status', to_jsonb(o.opportunity_status), 'property_status', to_jsonb(o.property_market_status),
      'agreement_status', to_jsonb(o.agreement_status), 'assigned_operator', to_jsonb(o.assigned_operator), 'next_action_due', to_jsonb(o.next_action_due))) loop
    ent := lc_sync.field_entity(k); eid := case when ent = 'thread' then t.id else o.id end;
    if eid is null then continue; end if;
    select * into f from lc_sync.field_versions where entity = ent and entity_id = eid and field = k;
    r := r || jsonb_build_object(k, jsonb_strip_nulls(jsonb_build_object('value', v, 'version', coalesce(f.version, 0), 'changed_at', f.changed_at, 'source', f.source,
      'actor_kind', f.actor_kind, 'actor_id', f.actor_id, 'protected', f.protected,
      'locked', case when k in ('pipeline_stage', 'conversation_stage', 'status') then coalesce(t.manual_stage_lock, false) when k = 'temperature' then coalesce(t.manual_temperature_lock, false) else null end)));
  end loop;
  return jsonb_build_object('thread_id', t.id, 'opportunity_id', o.id, 'archive_reason', t.archive_reason, 'agreement_ref', o.agreement_ref,
    'agreement_environment', o.agreement_environment, 'property_status_verified', o.property_status_verified, 'fields', r, 'as_of', now());
end
$fn$;
create function public.action_gateway_record_history(p_thread_id uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select coalesce(jsonb_agg(to_jsonb(c) - 'thread_key' order by c.created_at desc), '[]'::jsonb)
    from (select change_id, entity, entity_id, field, old_value, new_value, version, source, actor_kind, actor_id, via, intent_id, evidence, reason, created_at
            from lc_sync.record_changes where thread_id = p_thread_id order by created_at desc limit greatest(1, least(coalesce(p_limit, 50), 500))) c
$fn$;

-- ───────────────────────────────────────────── 6. registry rows (#27) ──
insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_dw_record_change(uuid,uuid)', 'PROPOSED_20261101120000_record_sync', null),
  ('definer_function', 'public.action_gateway_record_state(uuid)', 'PROPOSED_20261101120000_record_sync', null),
  ('definer_function', 'public.action_gateway_record_history(uuid,integer)', 'PROPOSED_20261101120000_record_sync', null),
  ('standing_t2_action', 'apply_record_change', 'PROPOSED_20261101120000_record_sync', 'reversible'),
  ('standing_t2_action', 'apply_person_record_change', 'PROPOSED_20261101120000_record_sync', 'reversible'),
  ('domain_write_action', 'apply_record_change', 'PROPOSED_20261101120000_record_sync', null),
  ('domain_write_action', 'apply_person_record_change', 'PROPOSED_20261101120000_record_sync', null);

-- ───────────────────────────────────────────── 7. privileges ──
do $$
declare fn text;
begin
  foreach fn in array array['public.action_gateway_dw_record_change(uuid,uuid)', 'public.action_gateway_record_state(uuid)', 'public.action_gateway_record_history(uuid,integer)',
                            'lc_sync.record(text,uuid,uuid,text,text,jsonb,jsonb,text,text)', 'lc_sync.capture_thread()', 'lc_sync.capture_opportunity()', 'lc_sync.capture_assignment()',
                            'lc_sync.capture_annotation()', 'lc_sync.capture_offer()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then
    grant execute on function public.action_gateway_dw_record_change(uuid,uuid) to lc_action_gateway;
    grant execute on function public.action_gateway_record_state(uuid) to lc_action_gateway;
    grant execute on function public.action_gateway_record_history(uuid,integer) to lc_action_gateway;
  end if;
end $$;

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'postcondition: the self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
end $$;

notify pgrst, 'reload schema';
