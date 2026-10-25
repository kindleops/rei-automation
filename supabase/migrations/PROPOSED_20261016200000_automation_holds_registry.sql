-- PROPOSED (NOT APPLIED) 2026-10-16. P0 containment: the authoritative automation hold registry.
-- (a) of three. (b) PROPOSED_hartford_hold.sql and (c) PROPOSED_maxwell_hold.sql depend on it.
-- Rollback: PROPOSED_automation_holds_registry_rollback.sql
--
-- WHAT THIS CREATES
--   public.automation_holds          append-only hold registry. A hold is RELEASED by one audited UPDATE
--                                    (released_at / released_by / release_reason), never deleted.
--   public.automation_hold_events    append-only audit: hold_set, hold_released, override_used,
--                                    advancement_blocked, acceptance_routed_to_human_review.
--   public.automation_hold_for(...)  STABLE, SECURITY INVOKER lookup (no writes): the active holds that
--                                    cover an action. A hold covers an action when ANY of its non-null
--                                    scope keys equals the action's key and the capability is blocked.
--   BEFORE triggers that RAISE (SQLSTATE P0001, message 'AUTOMATION_HOLD: ...') when an active hold covers:
--     seller_offers             INSERT, or UPDATE of status / acceptance / price / supersede columns
--                               (status -> accepted = offer_acceptance; anything else = offer_write)
--     closing_cases             INSERT                                            (closing_case_create)
--     acquisition_opportunities stage rank increase, status -> won, accepted_offer_id set  (stage_advance /
--                               offer_acceptance); INSERT above stage rank 1
--     send_queue                INSERT / UPDATE OF queue_status into a sendable status
--                               (outbound_send; manual_send for metadata.manual_operator_send rows)
--
-- OVERRIDE (documented, audited, explicit). Either:
--   (1) transaction-local settings, set by the operator path in the same transaction:
--         select set_config('lc.automation_hold_override_ref',    '<approval ref>', true),
--                set_config('lc.automation_hold_override_reason', '<reason>',       true),
--                set_config('lc.automation_hold_override_actor',  '<operator id>',  true);
--       All three are required. is_local=true: they die with the transaction.
--   (2) send_queue only: a MANUAL operator row (metadata.manual_operator_send = true) carrying
--       metadata.automation_hold_override = {approval_ref, reason, operator_id}.
--   Every override use appends an override_used row to automation_hold_events.
--
-- CONCURRENCY. The trigger functions are VOLATILE plpgsql, so the hold lookup takes a fresh snapshot
-- after the row lock is held. seller_offers / closing_cases triggers first take FOR KEY SHARE on the parent
-- acquisition_opportunities row; send_queue takes FOR KEY SHARE on inbox_thread_state(thread_key). The hold
-- files (b)/(c) take FOR UPDATE on those same rows before inserting the hold, so an in-flight writer and a
-- hold insert always serialize: whichever commits first, the other sees it (writer -> hold precondition
-- refuses; hold -> writer's trigger raises).
--
-- Own transaction; every precondition and postcondition RAISEs, so any failed assertion aborts the commit.
-- SPLIT (G1, 2026-10-25): this file is the REGISTRY CORE (tables, append-only enforcement, audit, the lookup,
-- privileges, RLS) and installs NO trigger on a live table. The four live-table guards are
-- PROPOSED_20261016200100_automation_hold_guards.sql, applied right after this file wherever holds are enforced.
-- Until they are installed no hold can be created (aa_automation_holds_require_guards). Core + guards = the
-- previous single file, behaviour for behaviour.
begin;

-- ── preconditions ───────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.automation_holds') is not null then raise exception 'precondition: public.automation_holds already exists'; end if;
  if to_regclass('public.automation_hold_events') is not null then raise exception 'precondition: public.automation_hold_events already exists'; end if;
  if to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null then raise exception 'precondition: automation_hold_for already exists'; end if;
  if to_regclass('public.seller_offers') is null or to_regclass('public.closing_cases') is null
     or to_regclass('public.acquisition_opportunities') is null or to_regclass('public.send_queue') is null
     or to_regclass('public.inbox_thread_state') is null then
    raise exception 'precondition: a protected table is missing';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'precondition: roles anon / authenticated / service_role must exist';
  end if;
  if to_regprocedure('public.is_ops_operator()') is null then raise exception 'precondition: public.is_ops_operator() missing (RLS policy pattern)'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'inbox_thread_state' and indexdef ilike 'CREATE UNIQUE INDEX%(thread_key)') then
    raise exception 'precondition: inbox_thread_state.thread_key must be unique (lock target)';
  end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname like 'aa_automation_hold_%') then
    raise exception 'precondition: automation hold triggers already exist';
  end if;
end $$;

-- ── registry ────────────────────────────────────────────────────────────────
create table public.automation_holds (
  id                   uuid primary key default gen_random_uuid(),
  hold_key             text not null,
  hold_type            text not null,
  thread_key           text,
  inbox_thread_id      uuid,
  property_id          text,
  opportunity_id       uuid,
  master_owner_id      text,
  blocked_capabilities text[] not null default array['offer_acceptance','offer_write','closing_case_create','stage_advance',
                         'auto_reply','ai_action','follow_up','campaign','workflow','outbound_send','recovery','manual_send']::text[],
  reason               text not null,
  set_by               text not null,
  set_at               timestamptz not null default now(),
  approval_ref         text not null,
  released_at          timestamptz,
  released_by          text,
  release_reason       text,
  metadata             jsonb not null default '{}'::jsonb,
  constraint automation_holds_type_check check (hold_type in ('operator_hold', 'permanent_exclusion')),
  constraint automation_holds_scope_present check (num_nonnulls(thread_key, inbox_thread_id, property_id, opportunity_id, master_owner_id) >= 1),
  constraint automation_holds_capabilities_known check (
    cardinality(blocked_capabilities) >= 1 and blocked_capabilities <@ array['offer_acceptance','offer_write','closing_case_create',
      'stage_advance','auto_reply','ai_action','follow_up','campaign','workflow','outbound_send','recovery','manual_send']::text[]),
  constraint automation_holds_text_present check (btrim(hold_key) <> '' and btrim(reason) <> '' and btrim(set_by) <> '' and btrim(approval_ref) <> ''),
  constraint automation_holds_release_complete check (
    (released_at is null and released_by is null and release_reason is null)
    or (released_at is not null and btrim(coalesce(released_by, '')) <> '' and btrim(coalesce(release_reason, '')) <> ''))
);
comment on table public.automation_holds is
  'P0 2026-10-16. Authoritative internal automation holds. Append-only: release is an audited UPDATE of released_at/released_by/release_reason; DELETE and TRUNCATE are refused. A hold is NOT an external offer withdrawal.';

create unique index uq_automation_holds_active_key on public.automation_holds (hold_key) where released_at is null;
create index ix_automation_holds_active_thread   on public.automation_holds (thread_key)      where released_at is null and thread_key is not null;
create index ix_automation_holds_active_inbox    on public.automation_holds (inbox_thread_id) where released_at is null and inbox_thread_id is not null;
create index ix_automation_holds_active_property on public.automation_holds (property_id)     where released_at is null and property_id is not null;
create index ix_automation_holds_active_opp      on public.automation_holds (opportunity_id)  where released_at is null and opportunity_id is not null;
create index ix_automation_holds_active_owner    on public.automation_holds (master_owner_id) where released_at is null and master_owner_id is not null;

create table public.automation_hold_events (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),
  event_type      text not null,
  capability      text,
  hold_ids        uuid[] not null default '{}'::uuid[],
  thread_key      text,
  inbox_thread_id uuid,
  property_id     text,
  opportunity_id  uuid,
  master_owner_id text,
  actor           text not null default 'automation',
  approval_ref    text,
  evidence        jsonb not null default '{}'::jsonb,
  constraint automation_hold_events_type_check check (event_type in
    ('hold_set', 'hold_released', 'override_used', 'advancement_blocked', 'acceptance_routed_to_human_review'))
);
comment on table public.automation_hold_events is 'P0 2026-10-16. Append-only audit of automation holds, overrides and refused advancement.';
create index ix_automation_hold_events_opp    on public.automation_hold_events (opportunity_id, occurred_at desc) where opportunity_id is not null;
create index ix_automation_hold_events_thread on public.automation_hold_events (thread_key, occurred_at desc)     where thread_key is not null;

-- ── append-only enforcement ─────────────────────────────────────────────────
create function public.automation_holds_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception using errcode = 'P0001', message = format('AUTOMATION_HOLD_APPEND_ONLY: %s on %s is refused; release a hold instead', tg_op, tg_table_name);
  end if;
  if tg_table_name = 'automation_hold_events' then
    raise exception using errcode = 'P0001', message = 'AUTOMATION_HOLD_APPEND_ONLY: automation_hold_events rows are immutable';
  end if;
  -- automation_holds UPDATE: only a one-time release of an active hold.
  if old.released_at is not null then
    raise exception using errcode = 'P0001', message = format('AUTOMATION_HOLD_APPEND_ONLY: hold %s is already released', old.id);
  end if;
  if new.released_at is null then
    raise exception using errcode = 'P0001', message = 'AUTOMATION_HOLD_APPEND_ONLY: the only permitted update is a release';
  end if;
  if (to_jsonb(new) - array['released_at', 'released_by', 'release_reason']) is distinct from (to_jsonb(old) - array['released_at', 'released_by', 'release_reason']) then
    raise exception using errcode = 'P0001', message = 'AUTOMATION_HOLD_APPEND_ONLY: a release may change only released_at / released_by / release_reason';
  end if;
  return new;
end $fn$;

create function public.automation_holds_audit() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  insert into public.automation_hold_events (event_type, hold_ids, thread_key, inbox_thread_id, property_id, opportunity_id, master_owner_id, actor, approval_ref, evidence)
  values (case when tg_op = 'INSERT' then 'hold_set' else 'hold_released' end, array[new.id], new.thread_key, new.inbox_thread_id,
          new.property_id, new.opportunity_id, new.master_owner_id,
          case when tg_op = 'INSERT' then new.set_by else new.released_by end, new.approval_ref,
          jsonb_build_object('hold_key', new.hold_key, 'hold_type', new.hold_type, 'reason', new.reason,
                             'release_reason', new.release_reason, 'blocked_capabilities', to_jsonb(new.blocked_capabilities)));
  return null;
end $fn$;

create trigger aa_automation_holds_append_only before update or delete on public.automation_holds
  for each row execute function public.automation_holds_append_only();
create trigger aa_automation_holds_no_truncate before truncate on public.automation_holds
  for each statement execute function public.automation_holds_append_only();
create trigger zz_automation_holds_audit after insert or update on public.automation_holds
  for each row execute function public.automation_holds_audit();
create trigger aa_automation_hold_events_append_only before update or delete on public.automation_hold_events
  for each row execute function public.automation_holds_append_only();
create trigger aa_automation_hold_events_no_truncate before truncate on public.automation_hold_events
  for each statement execute function public.automation_holds_append_only();

-- ── lookup (STABLE, invoker, no writes) ─────────────────────────────────────
create function public.automation_hold_for(
  p_thread_key text default null, p_inbox_thread_id uuid default null, p_property_id text default null,
  p_opportunity_id uuid default null, p_master_owner_id text default null, p_capability text default null)
returns setof public.automation_holds
language sql stable security invoker set search_path = public, pg_temp as $fn$
  select h.*
    from public.automation_holds h
   where h.released_at is null
     and (p_capability is null or p_capability = any (h.blocked_capabilities))
     and (   (p_thread_key      is not null and h.thread_key      = p_thread_key)
          or (p_inbox_thread_id is not null and h.inbox_thread_id = p_inbox_thread_id)
          or (p_property_id     is not null and h.property_id     = p_property_id)
          or (p_opportunity_id  is not null and h.opportunity_id  = p_opportunity_id)
          or (p_master_owner_id is not null and h.master_owner_id = p_master_owner_id))
   order by h.set_at, h.id
$fn$;
comment on function public.automation_hold_for(text,uuid,text,uuid,text,text) is
  'P0 2026-10-16. Active automation holds covering an action (any non-null scope key matches; capability blocked). STABLE, invoker, read-only.';

create function public.automation_hold_stage_rank(p_stage text) returns int
language sql immutable set search_path = public, pg_temp as $fn$
  select case lower(coalesce(p_stage, ''))
    when 'ownership_confirmation' then 1
    when 'offer_interest' then 2 when 'interest_qualification' then 2
    when 'asking_price' then 3 when 'price_discovery' then 3
    when 'property_condition' then 4 when 'underwriting' then 4
    when 'offer' then 5 when 'decision_and_offer' then 5
    when 'formal_contract' then 6 when 'contract_to_close' then 6
    when 'disposition' then 7 when 'under_contract' then 8 when 'prepared_to_close' then 9 when 'closed' then 10
    else 0 end
$fn$;

-- Raise unless no active hold covers the action, or a complete override is present (then audit it).
create function public.automation_hold_assert_clear(
  p_table text, p_capability text, p_thread_key text, p_inbox_thread_id uuid, p_property_id text,
  p_opportunity_id uuid, p_master_owner_id text, p_row_override jsonb default null)
returns void
language plpgsql volatile set search_path = public, pg_temp as $fn$
declare
  v_ids uuid[];
  v_ref text; v_why text; v_who text;
  v_via text := 'transaction_setting';
begin
  -- Same predicate as automation_hold_for, inlined: a plpgsql call into the (non-inlinable, SET search_path)
  -- SQL function cost ~620 µs per row on the disposable bench; inline it is a plain partial-index probe.
  -- Parity is asserted by the posttest (T13) for every capability and scope key.
  select coalesce(array_agg(h.id order by h.set_at, h.id), '{}'::uuid[]) into v_ids
    from public.automation_holds h
   where h.released_at is null
     and (p_capability is null or p_capability = any (h.blocked_capabilities))
     and (   (p_thread_key      is not null and h.thread_key      = p_thread_key)
          or (p_inbox_thread_id is not null and h.inbox_thread_id = p_inbox_thread_id)
          or (p_property_id     is not null and h.property_id     = p_property_id)
          or (p_opportunity_id  is not null and h.opportunity_id  = p_opportunity_id)
          or (p_master_owner_id is not null and h.master_owner_id = p_master_owner_id));
  if cardinality(v_ids) = 0 then return; end if;
  -- override settings are read only when a hold actually covers the row (hot path stays cheap)
  v_ref := nullif(btrim(coalesce(current_setting('lc.automation_hold_override_ref', true), '')), '');
  v_why := nullif(btrim(coalesce(current_setting('lc.automation_hold_override_reason', true), '')), '');
  v_who := nullif(btrim(coalesce(current_setting('lc.automation_hold_override_actor', true), '')), '');
  if (v_ref is null or v_why is null or v_who is null) and p_row_override is not null then
    v_ref := nullif(btrim(coalesce(p_row_override->>'approval_ref', '')), '');
    v_why := nullif(btrim(coalesce(p_row_override->>'reason', '')), '');
    v_who := nullif(btrim(coalesce(p_row_override->>'operator_id', '')), '');
    v_via := 'row_metadata';
  end if;
  if v_ref is null or v_why is null or v_who is null then
    raise exception using errcode = 'P0001',
      message = format('AUTOMATION_HOLD: %s on %s is blocked by hold(s) %s', p_capability, p_table, array_to_string(v_ids, ',')),
      hint = 'Release the hold (audited UPDATE of automation_holds) or use the operator override (lc.automation_hold_override_ref/_reason/_actor).';
  end if;
  insert into public.automation_hold_events (event_type, capability, hold_ids, thread_key, inbox_thread_id, property_id, opportunity_id, master_owner_id, actor, approval_ref, evidence)
  values ('override_used', p_capability, v_ids, p_thread_key, p_inbox_thread_id, p_property_id, p_opportunity_id, p_master_owner_id, v_who, v_ref,
          jsonb_build_object('table', p_table, 'reason', v_why, 'via', v_via));
end $fn$;

-- ── no hold without enforcement (G1 split, 2026-10-25) ─────────────────────────
-- The live-table guards (send_queue, seller_offers, closing_cases, acquisition_opportunities) are a SEPARATE link,
-- PROPOSED_20261016200100_automation_hold_guards.sql. Until ALL FOUR are installed and enabled, no hold may be
-- created: a hold that nothing enforces would be a false assurance. The registry, its audit, the lookup and the
-- privileges are complete without them (the lookup simply finds no hold).
create function public.automation_holds_require_guards() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in
       ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases', 'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')) <> 4 then
    raise exception using errcode = 'P0001', message = 'HOLD_ENFORCEMENT_NOT_INSTALLED: a hold cannot be created until the live-table guards (PROPOSED_20261016200100_automation_hold_guards) are installed';
  end if;
  return new;
end
$$;
create trigger aa_automation_holds_require_guards before insert on public.automation_holds
  for each row execute function public.automation_holds_require_guards();

-- ── privileges + RLS (same pattern as seller_offers / acquisition_opportunities) ─
alter table public.automation_holds enable row level security;
alter table public.automation_hold_events enable row level security;
revoke all on public.automation_holds, public.automation_hold_events from public, anon, authenticated, service_role;
grant select, insert, update on public.automation_holds to service_role;
grant select, insert on public.automation_hold_events to service_role;
grant select on public.automation_holds, public.automation_hold_events to authenticated;
create policy ops_operator_read on public.automation_holds for select to authenticated using ((select public.is_ops_operator()));
create policy ops_operator_read on public.automation_hold_events for select to authenticated using ((select public.is_ops_operator()));

revoke all on function public.automation_hold_for(text,uuid,text,uuid,text,text) from public, anon;
grant execute on function public.automation_hold_for(text,uuid,text,uuid,text,text) to authenticated, service_role;
revoke all on function public.automation_hold_stage_rank(text) from public, anon;
grant execute on function public.automation_hold_stage_rank(text) to authenticated, service_role;
revoke all on function public.automation_hold_assert_clear(text,text,text,uuid,text,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.automation_hold_assert_clear(text,text,text,uuid,text,uuid,text,jsonb) to service_role;
revoke all on function public.automation_holds_append_only(), public.automation_holds_audit(), public.automation_holds_require_guards() from public, anon, authenticated;

-- ── postconditions ─────────────────────────────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from pg_trigger where not tgisinternal and tgname in
    ('aa_automation_holds_append_only', 'aa_automation_holds_no_truncate', 'zz_automation_holds_audit', 'aa_automation_holds_require_guards',
     'aa_automation_hold_events_append_only', 'aa_automation_hold_events_no_truncate') and tgenabled = 'O';
  if n <> 6 then raise exception 'postcondition: expected 6 enabled registry triggers, found %', n; end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname in ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases',
             'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')) then
    raise exception 'postcondition: the live-table guards belong to PROPOSED_20261016200100_automation_hold_guards';
  end if;
  if (select count(*) from public.automation_holds) <> 0 or (select count(*) from public.automation_hold_events) <> 0 then
    raise exception 'postcondition: the registry must start empty';
  end if;
  if exists (select 1 from public.automation_hold_for('x', null, 'x', null, 'x', null)) then raise exception 'postcondition: lookup on an empty registry returned a hold'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.automation_holds'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.automation_hold_events'::regclass) then
    raise exception 'postcondition: RLS not enabled';
  end if;
  if has_table_privilege('anon', 'public.automation_holds', 'select') or has_table_privilege('authenticated', 'public.automation_holds', 'insert')
     or has_table_privilege('service_role', 'public.automation_holds', 'delete') or has_table_privilege('service_role', 'public.automation_hold_events', 'update') then
    raise exception 'postcondition: privileges are wider than designed';
  end if;
  if (select provolatile from pg_proc where oid = 'public.automation_hold_for(text,uuid,text,uuid,text,text)'::regprocedure) <> 's'
     or (select prosecdef from pg_proc where oid = 'public.automation_hold_for(text,uuid,text,uuid,text,text)'::regprocedure) then
    raise exception 'postcondition: automation_hold_for must be STABLE and SECURITY INVOKER';
  end if;
end $$;
commit;
