-- PROPOSED ONLY — PRETEST for PROPOSED_20261013161000_conversation_decide_event_budget.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite check. The apply → assert half is ..._posttest.sql and the post-rollback
-- check is ..._rollback_posttest.sql (rc-8.5.15.1: a fixture never includes another file).
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_decide_event_budget
\set ON_ERROR_STOP on
do $$
begin
  if to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null then
    raise exception 'pretest: the R2 runtime (PROPOSED_20261012140000_intel_runtime.sql) must be applied first';
  end if;
  raise notice 'pretest(conversation_decide_event_budget): prerequisites OK';
end $$;
