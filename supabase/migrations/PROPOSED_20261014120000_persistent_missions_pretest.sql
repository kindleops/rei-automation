-- PROPOSED ONLY — PRETEST for PROPOSED_20261014120000_persistent_missions.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- rc-8.5.20: read-only prerequisite checks. The BEGIN → \i :migration → asserts → ROLLBACK half
-- moved to PROPOSED_20261014120000_persistent_missions_posttest.sql (a fixture never includes
-- another file — rc-8.5.15.1 linter). Run both through the migration test runner:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id persistent_missions
-- Expected last notice: "pretest(persistent_missions): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise exception 'pretest(persistent_missions): the R2 runtime (PROPOSED_20261012140000_intel_runtime) must be applied first';
  end if;
  if to_regclass('agent.approval_request') is null then
    raise exception 'pretest(persistent_missions): the capability plane (PROPOSED_20261013120000_agent_capabilities) must be applied first';
  end if;
  -- rc-8.5.20: this migration re-creates agent.runtime_kind_limits_valid with the 8.5.15
  -- event_budget_cap_usd rule; applying it before that fix would make the fix's later
  -- re-creation drop max_concurrency 3
  if (select prosrc from pg_proc where oid = 'agent.runtime_kind_limits_valid(jsonb)'::regprocedure) !~ 'event_budget_cap_usd' then
    raise exception 'pretest(persistent_missions): PROPOSED_20261014121000_runtime_kind_limits_event_budget must be applied first';
  end if;
  if to_regclass('agent.research_job_requested_recent_idx') is not null or to_regclass('agent.finding_type_key_job_idx') is not null then
    raise exception 'pretest(persistent_missions): already applied';
  end if;
  raise notice 'pretest(persistent_missions): prerequisites OK';
end
$$;
