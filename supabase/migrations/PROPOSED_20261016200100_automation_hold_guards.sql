-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- The LIVE-TABLE GUARDS of the automation hold registry (split from PROPOSED_20261016200000_automation_holds_registry
-- on 2026-10-25, unchanged): BEFORE triggers on public.send_queue (queue_status transitions), public.seller_offers,
-- public.closing_cases and public.acquisition_opportunities that refuse a write a hold blocks. They take key-share
-- locks and can raise in those live write paths, so they are a separate, separately approved link: required before
-- ANY hold can be created (the registry core refuses hold rows until all four exist) — i.e. before T2 set_thread_hold,
-- operator holds or the follow-up lifecycle; NOT required by the Action Gateway's T1 task tools.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261016200100_automation_hold_guards_pretest.sql
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261016200100_automation_hold_guards.sql
-- Rollback: PROPOSED_20261016200100_automation_hold_guards_rollback.sql (refused while any hold is active).
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.automation_holds') is null or to_regprocedure('public.automation_hold_assert_clear(text,text,text,uuid,text,uuid,text,jsonb)') is null
     or to_regprocedure('public.automation_hold_stage_rank(text)') is null then
    raise exception 'precondition: the registry core (PROPOSED_20261016200000_automation_holds_registry) is not applied';
  end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname in ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases',
             'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')) then
    raise exception 'precondition: already applied';
  end if;
  if to_regclass('public.seller_offers') is null or to_regclass('public.closing_cases') is null or to_regclass('public.acquisition_opportunities') is null
     or to_regclass('public.send_queue') is null or to_regclass('public.inbox_thread_state') is null then
    raise exception 'precondition: a protected table is missing';
  end if;
end $$;

-- ── table guards ────────────────────────────────────────────────────────────
create function public.automation_hold_guard_seller_offers() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
declare v_cap text;
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status and new.accepted_at is not distinct from old.accepted_at
     and new.acceptance_event_id is not distinct from old.acceptance_event_id and new.accepted_price is not distinct from old.accepted_price
     and new.purchase_price is not distinct from old.purchase_price and new.superseded_at is not distinct from old.superseded_at
     and new.superseded_by_offer_id is not distinct from old.superseded_by_offer_id then
    return new;
  end if;
  v_cap := case when new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') then 'offer_acceptance' else 'offer_write' end;
  if new.opportunity_id is not null then
    perform 1 from public.acquisition_opportunities o where o.id = new.opportunity_id for key share;
  end if;
  perform public.automation_hold_assert_clear('seller_offers', v_cap, new.thread_key, null, new.property_id, new.opportunity_id, new.master_owner_id, null);
  return new;
end $fn$;

create function public.automation_hold_guard_closing_cases() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if new.opportunity_id is not null then
    perform 1 from public.acquisition_opportunities o where o.id = new.opportunity_id for key share;
  end if;
  perform public.automation_hold_assert_clear('closing_cases', 'closing_case_create', new.thread_key, null, new.property_id, new.opportunity_id, new.master_owner_id, null);
  return new;
end $fn$;

create function public.automation_hold_guard_opportunities() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'INSERT' then
    if public.automation_hold_stage_rank(new.acquisition_stage) > 1 or new.opportunity_status = 'won' or new.accepted_offer_id is not null then
      perform public.automation_hold_assert_clear('acquisition_opportunities', 'stage_advance', new.primary_thread_key, null, new.primary_property_id, new.id, new.master_owner_id, null);
    end if;
    return new;
  end if;
  if public.automation_hold_stage_rank(new.acquisition_stage) > public.automation_hold_stage_rank(old.acquisition_stage)
     or (new.opportunity_status = 'won' and old.opportunity_status is distinct from 'won') then
    perform public.automation_hold_assert_clear('acquisition_opportunities', 'stage_advance', new.primary_thread_key, null, new.primary_property_id, new.id, new.master_owner_id, null);
  end if;
  if new.accepted_offer_id is not null and new.accepted_offer_id is distinct from old.accepted_offer_id then
    perform public.automation_hold_assert_clear('acquisition_opportunities', 'offer_acceptance', new.primary_thread_key, null, new.primary_property_id, new.id, new.master_owner_id, null);
  end if;
  return new;
end $fn$;

create function public.automation_hold_guard_send_queue() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_md jsonb := coalesce(new.metadata, '{}'::jsonb);
  v_manual boolean := coalesce(v_md->>'manual_operator_send', '') = 'true';
  v_ovr jsonb := null;
begin
  if tg_op = 'UPDATE' and lower(coalesce(old.queue_status, '')) = lower(coalesce(new.queue_status, '')) then return new; end if;
  -- thread_key is the seller phone in this system; a row whose thread_key is null or differs from its
  -- destination is checked under BOTH keys (and locks both thread rows, when they exist).
  perform 1 from public.inbox_thread_state t
   where t.thread_key in (new.thread_key, new.to_phone_number::text) order by t.thread_key for key share;
  -- HOT PATH (every enqueue and every claim): one inline probe, taken AFTER the lock so it sees any hold
  -- committed by a transaction we waited on. Same predicate as automation_hold_for for this row's keys;
  -- only a covered row pays for the full check (override + audit + error). Parity: posttest T6/T7/T13/T14.
  if not exists (
    select 1 from public.automation_holds h
     where h.released_at is null
       and (case when v_manual then 'manual_send' else 'outbound_send' end) = any (h.blocked_capabilities)
       and (   (new.thread_key is not null and h.thread_key = new.thread_key)
            or (new.to_phone_number is not null and h.thread_key = new.to_phone_number::text)
            or (new.property_id is not null and h.property_id = new.property_id)
            or (new.master_owner_id is not null and h.master_owner_id = new.master_owner_id))) then
    return new;
  end if;
  if v_manual and jsonb_typeof(v_md->'automation_hold_override') = 'object' then
    v_ovr := v_md->'automation_hold_override';
  end if;
  perform public.automation_hold_assert_clear('send_queue', case when v_manual then 'manual_send' else 'outbound_send' end,
                                              coalesce(new.thread_key, new.to_phone_number::text), null, new.property_id, null, new.master_owner_id, v_ovr);
  if new.thread_key is not null and new.to_phone_number is not null and new.to_phone_number::text <> new.thread_key then
    perform public.automation_hold_assert_clear('send_queue', case when v_manual then 'manual_send' else 'outbound_send' end,
                                                new.to_phone_number::text, null, null, null, null, v_ovr);
  end if;
  return new;
end $fn$;

create trigger aa_automation_hold_seller_offers
  before insert or update of status, accepted_at, acceptance_event_id, accepted_price, purchase_price, superseded_at, superseded_by_offer_id
  on public.seller_offers for each row execute function public.automation_hold_guard_seller_offers();
create trigger aa_automation_hold_closing_cases
  before insert on public.closing_cases for each row execute function public.automation_hold_guard_closing_cases();
create trigger aa_automation_hold_opportunities
  before insert or update of acquisition_stage, opportunity_status, accepted_offer_id
  on public.acquisition_opportunities for each row execute function public.automation_hold_guard_opportunities();
create trigger aa_automation_hold_send_queue
  before insert or update of queue_status on public.send_queue for each row
  when (lower(coalesce(new.queue_status, '')) in ('queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending'))
  execute function public.automation_hold_guard_send_queue();

revoke all on function public.automation_hold_guard_seller_offers(), public.automation_hold_guard_closing_cases(),
  public.automation_hold_guard_opportunities(), public.automation_hold_guard_send_queue() from public, anon, authenticated;

do $$
declare n int;
begin
  select count(*) into n from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in
    ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases', 'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue');
  if n <> 4 then raise exception 'postcondition: expected 4 enabled live-table guards, found %', n; end if;
end $$;

commit;
