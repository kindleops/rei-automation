-- PROPOSED ONLY — PRETEST for PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- rc-8.5.20: a fixture never includes another file (rc-8.5.15.1 linter). The former
-- BEGIN → \ir intel_runtime → \ir fix → \ir conversation_decide_event_budget → asserts →
-- \ir rollbacks → ROLLBACK chain is split into this read-only pretest (prerequisites + the
-- defect reproduced), the posttest (…_posttest.sql) and the rollback posttest
-- (…_rollback_posttest.sql), run by the migration test runner:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id runtime_kind_limits_event_budget
-- Expected last notice: "pretest(runtime_kind_limits_event_budget): prerequisites OK, defect reproduced".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regprocedure('agent.runtime_enqueue_event(text,text,jsonb,integer)') is null
     or to_regprocedure('agent.runtime_kind_limits_valid(jsonb)') is null then
    raise exception 'pretest(runtime_kind_limits_event_budget): the R2 runtime (PROPOSED_20261012140000_intel_runtime.sql) must be applied first';
  end if;
  if not exists (select 1 from agent.runtime_limits where id = 1) then
    raise exception 'pretest(runtime_kind_limits_event_budget): agent.runtime_limits row 1 missing';
  end if;
  -- the defect, reproduced before the fix: the budget key is refused by the CHECK
  begin
    update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('conversation.decide',
      jsonb_build_object('enabled', false, 'max_concurrency', 1, 'armed_by', 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', 'event_budget_cap_usd', 0.01)) where id = 1;
    raise exception 'assert: before the fix the event_budget_cap_usd key must be refused (defect not reproduced)';
  exception when check_violation then null;
  end;
  raise notice 'pretest(runtime_kind_limits_event_budget): prerequisites OK, defect reproduced';
end $$;
rollback;
