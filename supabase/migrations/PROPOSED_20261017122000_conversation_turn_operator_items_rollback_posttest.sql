-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261017122000_conversation_turn_operator_items_rollback.sql. Read-only.
\set ON_ERROR_STOP on

do $$
begin
  if agent.ops_scope_of_kind('conversation.turn') is not null or agent.ops_scope_of_kind('ops.supervisor') is distinct from 'supervisor' then
    raise exception 'rollback posttest(conversation_turn_operator_items): scope map not restored';
  end if;
  if position('conversation' in pg_get_constraintdef((select oid from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_scope_check'))) > 0 then
    raise exception 'rollback posttest(conversation_turn_operator_items): scope check not restored';
  end if;
  raise notice 'rollback posttest(conversation_turn_operator_items): all assertions OK';
end $$;
