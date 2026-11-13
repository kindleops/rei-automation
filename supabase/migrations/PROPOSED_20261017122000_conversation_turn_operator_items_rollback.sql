-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261017122000_conversation_turn_operator_items.sql.
-- Restores agent.ops_scope_of_kind and the scope CHECK exactly. REFUSES while any 'conversation'
-- work item exists (an operator resolves / exports them first: rollback never deletes operator items).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
  if agent.ops_scope_of_kind('conversation.turn') is null then raise exception 'rollback precondition: not applied'; end if;
  if exists (select 1 from agent.ops_work_item where scope = 'conversation') then
    raise exception 'rollback precondition: conversation-scope operator items exist';
  end if;
end $$;
create or replace function agent.ops_scope_of_kind(p_kind text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case p_kind when 'recovery.sweep' then 'recovery' when 'inbox.action_center' then 'action_center'
                     when 'pipeline.reconcile' then 'pipeline' when 'ops.supervisor' then 'supervisor' else null end
$$;
revoke all on function agent.ops_scope_of_kind(text) from public, anon, authenticated;
alter table agent.ops_work_item drop constraint ops_work_item_scope_check;
alter table agent.ops_work_item add constraint ops_work_item_scope_check check (scope in ('recovery', 'action_center', 'pipeline', 'supervisor'));
commit;
