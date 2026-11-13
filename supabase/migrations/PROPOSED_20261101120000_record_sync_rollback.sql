-- =============================================================================
-- ROLLBACK of PROPOSED_20261101120000_record_sync.sql (link 10)
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply. Tested on disposable PostgreSQL 17 only.
-- =============================================================================
-- REFUSES (nothing is dropped) while:
--   * any apply_record_change / apply_person_record_change intent is pending;
--   * any record_changed event is on the lead feed (the feed is append-only evidence; the kind check cannot be narrowed
--     under it): after use, switch the sync off by revoking its grants instead (born OFF without them).
-- Then deletes this link's registry rows, drops the capture triggers, the domain write, the reads and the lc_sync schema
-- (versions and history: export them first if they matter) and restores link 9's lead_events kind check verbatim.
-- The canonical columns it added STAY when any row holds a value (business data); empty ones are dropped.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare c_name text; c_def text;
begin
  if to_regnamespace('lc_sync') is null then raise exception 'rollback precondition: the record sync link is not applied'; end if;
  if exists (select 1 from action_gateway.action_intents where action in ('apply_record_change', 'apply_person_record_change') and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: record-change intents are still pending; drain them first';
  end if;
  if exists (select 1 from action_gateway.lead_events where kind = 'record_changed') then
    raise exception 'rollback precondition: record_changed events exist on the lead feed (append-only evidence); revoke the records.* grants instead';
  end if;
  select value into c_name from lc_sync.restore where key = 'lead_events_kind_check_name';
  select value into c_def from lc_sync.restore where key = 'lead_events_kind_check_def';
  if c_name is null or c_def is null then raise exception 'rollback precondition: the restore rows are missing'; end if;
  execute format('alter table action_gateway.lead_events drop constraint %I', c_name);
  execute format('alter table action_gateway.lead_events add constraint %I %s', c_name, c_def);
end $$;

delete from action_gateway.extensions where link = 'PROPOSED_20261101120000_record_sync';

drop trigger lc_sync_capture_insert on public.inbox_thread_state;
drop trigger lc_sync_capture_update on public.inbox_thread_state;
drop trigger lc_sync_capture_insert on public.acquisition_opportunities;
drop trigger lc_sync_capture_update on public.acquisition_opportunities;
drop trigger lc_sync_capture_assignment on action_gateway.lead_assignments;
drop trigger lc_sync_capture_annotation on action_gateway.lead_annotations;
drop trigger if exists lc_sync_capture_offer on public.seller_offers;
drop function public.action_gateway_dw_record_change(uuid, uuid);
drop function public.action_gateway_record_state(uuid);
drop function public.action_gateway_record_history(uuid, integer);
drop schema lc_sync cascade;

do $$
begin
  if not exists (select 1 from public.inbox_thread_state where conversation_stage is not null) then
    alter table public.inbox_thread_state drop constraint inbox_thread_state_conversation_stage_code;
    alter table public.inbox_thread_state drop column conversation_stage;
  end if;
  if not exists (select 1 from public.acquisition_opportunities where property_market_status is not null or agreement_status is not null or agreement_ref is not null) then
    alter table public.acquisition_opportunities drop constraint acquisition_opportunities_property_market_status_code, drop constraint acquisition_opportunities_agreement_status_code,
      drop constraint acquisition_opportunities_agreement_ref_shape, drop constraint acquisition_opportunities_agreement_environment_code,
      drop column property_market_status, drop column property_status_verified, drop column agreement_status, drop column agreement_ref, drop column agreement_environment;
  end if;
end $$;

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'rollback postcondition: the self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
end $$;

notify pgrst, 'reload schema';
