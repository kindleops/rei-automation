-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016140000_operations_action_center.sql (8.5.20 part C).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback_posttest(operations_action_center): ALL OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regclass('agent.conversation_action_state') is not null or to_regclass('agent.ops_work_item') is not null or to_regclass('agent.v_action_center_queue') is not null then
    raise exception 'assert: rollback dropped the tables and the view';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'agent' and p.proname like 'ops\_%' and p.proname <> 'ops_health_snapshot') then
    raise exception 'assert: rollback dropped every ops_* function (ops_health_snapshot stays)';
  end if;
  if to_regclass('public.inbox_thread_state') is null then raise exception 'assert: public untouched'; end if;
  raise notice 'rollback_posttest(operations_action_center): ALL OK';
end
$$;
rollback;
