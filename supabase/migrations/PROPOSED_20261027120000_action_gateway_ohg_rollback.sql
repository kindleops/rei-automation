-- =============================================================================
-- ROLLBACK of PROPOSED_20261027120000_action_gateway_ohg.sql
-- STATUS: PROPOSED. Run only with the owner's approval, like the apply.
-- Tested on disposable PostgreSQL 17 only: the runner proves apply → rollback restores the pre-apply catalog
-- fingerprint exactly (#28's receipts CHECK included, restored verbatim from action_gateway.ohg_restore).
-- =============================================================================
-- REFUSES (nothing is dropped) while:
--   * any OHG intent is pending (received / awaiting_approval / authorized / executing);
--   * any OHG receipt is still open (requested / executing): LeadCommand's worker / an operator finishes it;
--   * any receipt of the two handed-off actions exists at all (the widened CHECK cannot be narrowed under them;
--     the receipts are evidence of lead-state changes: export them first).
-- Then deletes this link's rows of #27's extension registry, drops exactly what the apply created and restores
-- #28's receipts action CHECK. Business rows (the lead-state changes the worker applied through the canonical
-- registry, their history) STAY. The annotation ledger is dropped WITH its rows: export it first if it matters.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare c_name text; c_def text;
begin
  if to_regclass('action_gateway.lead_annotations') is null or to_regclass('action_gateway.ohg_restore') is null then raise exception 'rollback precondition: the ohg link is not applied'; end if;
  if exists (select 1 from action_gateway.action_intents where action in ('set_lead_temperature', 'update_lead_status', 'record_conversation_note', 'record_seller_statement')
              and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback precondition: OHG intents are still pending; drain them first';
  end if;
  if exists (select 1 from action_gateway.seller_action_receipts where action in ('set_lead_temperature', 'update_lead_status') and state in ('requested', 'executing', 'enqueued')) then
    raise exception 'rollback precondition: OHG receipts are still open; finish them first';
  end if;
  if exists (select 1 from action_gateway.seller_action_receipts where action in ('set_lead_temperature', 'update_lead_status')) then
    raise exception 'rollback precondition: receipts of handed-off lead-state actions exist (evidence); export and delete them first';
  end if;
  select value into c_name from action_gateway.ohg_restore where key = 'receipts_action_check_name';
  select value into c_def from action_gateway.ohg_restore where key = 'receipts_action_check_def';
  if c_name is null or c_def is null then raise exception 'rollback precondition: the restore rows are missing'; end if;
  execute format('alter table action_gateway.seller_action_receipts drop constraint %I', c_name);
  execute format('alter table action_gateway.seller_action_receipts add constraint %I %s', c_name, c_def);
end $$;

delete from action_gateway.extensions where link = 'PROPOSED_20261027120000_action_gateway_ohg';

drop function public.action_gateway_dw_ohg(uuid, uuid);
drop function public.action_gateway_reply_status(uuid, integer);
drop function public.action_gateway_annotations(uuid, integer);
drop table action_gateway.lead_annotations;
drop function action_gateway.lead_annotations_immutable();
drop table action_gateway.ohg_restore;

do $$
begin
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then
    raise exception 'rollback postcondition: the self-check is not ok: %', action_gateway.self_check('lc_action_gateway') -> 'findings';
  end if;
end $$;

notify pgrst, 'reload schema';
