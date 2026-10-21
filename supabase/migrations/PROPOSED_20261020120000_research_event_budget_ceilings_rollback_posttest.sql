-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql:
-- runs AFTER the runner applied the rollback file; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id research_event_budget_ceilings
-- Expected last notice: "rollback_posttest(research_event_budget_ceilings): production event budget restored".
\set ON_ERROR_STOP on
begin;
do $$
declare r jsonb; v_cap numeric;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'runtime_limits' and column_name = 'event_budget_ceilings') then raise exception 'assert: column dropped'; end if;
  if to_regprocedure('agent.runtime_event_budget_ceiling(text)') is not null then raise exception 'assert: ceiling function dropped'; end if;
  update agent.runtime_limits set kind_limits = kind_limits || jsonb_build_object('property.research', jsonb_build_object('armed_by', gen_random_uuid()::text, 'enabled', false, 'max_concurrency', 1, 'event_budget_cap_usd', 0.30)) where id = 1;
  r := agent.runtime_enqueue_event('property.research', 'rbposttest-prop-1', '{}'::jsonb, 120);
  select budget_cap_usd into v_cap from agent.research_job where job_id = r ->> 'job_id';
  if v_cap <> 0 then raise exception 'assert: rollback restores the production event budget 0, got %', v_cap; end if;
  raise notice 'rollback_posttest(research_event_budget_ceilings): production event budget restored';
end $$;
rollback;
