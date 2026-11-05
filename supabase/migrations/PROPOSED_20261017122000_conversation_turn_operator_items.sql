-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- rc-8.5.21 (blind-eval D3): an AI reply that R3 HELD (category not enabled, excluded scope,
-- validator / guard refusal, cap, hold registry) became a silent "dispatched" turn with no operator
-- item. The turn now records the hold as dispatch_state 'held' (PROPOSED_20261017121000) and the
-- conversation.turn job raises ONE durable operator work item per held turn:
--   agent.ops_work_item scope 'conversation', kind 'escalation', dedupe 'conversation:turn_held:<turn>',
--   through the EXISTING lease-bound writer agent.ops_work_item_sync (the scope of a job is
--   agent.ops_scope_of_kind(kind); 'conversation.turn' → 'conversation').
-- Nothing here can send, queue or schedule. Codes / counts only (agent.payload_is_clean).
-- ORDER: after PROPOSED_20261016140000_operations_action_center.sql.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261017122000_conversation_turn_operator_items.sql
-- Rollback: PROPOSED_20261017122000_conversation_turn_operator_items_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('agent.ops_work_item') is null or to_regprocedure('agent.ops_scope_of_kind(text)') is null then
    raise exception 'precondition: operations_action_center (PROPOSED_20261016140000) is not applied';
  end if;
  if agent.ops_scope_of_kind('conversation.turn') is not null then raise exception 'precondition: already applied'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_scope_check') then
    raise exception 'precondition: ops_work_item_scope_check missing';
  end if;
end $$;

alter table agent.ops_work_item drop constraint ops_work_item_scope_check;
alter table agent.ops_work_item add constraint ops_work_item_scope_check check (scope in ('recovery', 'action_center', 'pipeline', 'supervisor', 'conversation'));

create or replace function agent.ops_scope_of_kind(p_kind text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case p_kind when 'recovery.sweep' then 'recovery' when 'inbox.action_center' then 'action_center'
                     when 'pipeline.reconcile' then 'pipeline' when 'ops.supervisor' then 'supervisor'
                     when 'conversation.turn' then 'conversation' else null end
$$;
revoke all on function agent.ops_scope_of_kind(text) from public, anon, authenticated;

do $$
begin
  if agent.ops_scope_of_kind('conversation.turn') is distinct from 'conversation' or agent.ops_scope_of_kind('ops.supervisor') is distinct from 'supervisor' then
    raise exception 'postcondition: scope map';
  end if;
end $$;
commit;
