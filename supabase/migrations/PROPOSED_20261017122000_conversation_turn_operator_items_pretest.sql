-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261017122000_conversation_turn_operator_items.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY: never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_turn_operator_items
-- Expected last notice: "pretest(conversation_turn_operator_items): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('agent.ops_work_item') is null or to_regprocedure('agent.ops_work_item_sync(text,uuid,jsonb,boolean)') is null then
    raise exception 'pretest(conversation_turn_operator_items): operations_action_center is not applied';
  end if;
  if agent.ops_scope_of_kind('conversation.turn') is not null then raise exception 'pretest(conversation_turn_operator_items): already applied'; end if;
  raise notice 'pretest(conversation_turn_operator_items): prerequisites OK';
end $$;
