-- PROPOSED ONLY — PRETEST for PROPOSED_20261014120000_persistent_missions.sql. Changes NOTHING.
--   psql "$DB" -v ON_ERROR_STOP=1 -v migration=supabase/migrations/PROPOSED_20261014120000_persistent_missions.sql \
--        -f supabase/migrations/PROPOSED_20261014120000_persistent_missions_pretest.sql
-- 1. read-only prerequisite checks; 2. BEGIN → applies the migration → asserts → ROLLBACK.
-- Expected last notice: "pretest(persistent_missions): ALL OK (rolled back)".
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise exception 'pretest(persistent_missions): the R2 runtime (PROPOSED_20261012140000_intel_runtime) must be applied first';
  end if;
  if to_regclass('agent.approval_request') is null then
    raise exception 'pretest(persistent_missions): the capability plane (PROPOSED_20261013120000_agent_capabilities) must be applied first';
  end if;
  if to_regclass('agent.research_job_requested_recent_idx') is not null or to_regclass('agent.finding_type_key_job_idx') is not null then
    raise exception 'pretest(persistent_missions): already applied';
  end if;
  raise notice 'pretest(persistent_missions): prerequisites OK';
end
$$;

begin;
\i :migration
do $$
declare op constant text := '11111111-1111-4111-8111-111111111111';
begin
  if not agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 3, 'armed_by', op))) then raise exception 'assert: max_concurrency 3 accepted'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 4, 'armed_by', op))) then raise exception 'assert: max_concurrency 4 refused'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('mission.research', jsonb_build_object('enabled', true, 'max_concurrency', 2))) then raise exception 'assert: enabled needs armed_by'; end if;
  if agent.runtime_kind_limits_valid(jsonb_build_object('research.quick', jsonb_build_object('enabled', false))) then raise exception 'assert: research.* is never a runtime kind'; end if;
  update agent.runtime_limits set kind_limits = jsonb_build_object('mission.research', jsonb_build_object('enabled', false, 'max_concurrency', 3, 'armed_by', op)) where id = 1;
  if to_regclass('agent.research_job_requested_recent_idx') is null or to_regclass('agent.finding_type_key_job_idx') is null then raise exception 'assert: indexes exist'; end if;
  if has_function_privilege('anon', 'agent.runtime_kind_limits_valid(jsonb)', 'execute') then raise exception 'assert: anon has no execute'; end if;
  raise notice 'pretest(persistent_missions): behaviour OK';
end
$$;
do $$ begin raise notice 'pretest(persistent_missions): ALL OK (rolled back)'; end $$;
rollback;
