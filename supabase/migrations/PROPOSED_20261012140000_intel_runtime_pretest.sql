-- PROPOSED ONLY — PRETEST for PROPOSED_20261012140000_intel_runtime.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite checks. The apply → assert → ROLLBACK half moved to
-- PROPOSED_20261012140000_intel_runtime_posttest.sql (rc-8.5.15.1: a fixture never includes
-- another file). Run both through the migration test runner on a disposable database:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id intel_runtime
-- Expected last notice: "pretest(intel_runtime): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('agent.research_job') is null or to_regclass('agent.finding') is null or to_regclass('agent.runtime_limits') is null then
    raise exception 'pretest(intel_runtime): the S3 schema (PROPOSED_20261010120000_agent_s3_persistence) must be applied first';
  end if;
  if to_regclass('agent.spend_ledger') is null or to_regclass('agent.research_limits') is null then
    raise exception 'pretest(intel_runtime): the research schema (PROPOSED_20261010130000_agent_research_ro) must be applied first';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'kind')
     or to_regclass('agent.job_event') is not null or to_regclass('agent.runtime_schedule') is not null or to_regclass('agent.runtime_heartbeat') is not null then
    raise exception 'pretest(intel_runtime): runtime objects already exist — a previous apply is present; reconcile first';
  end if;
  if to_regclass('public.system_control') is null or to_regclass('public.send_queue') is null then
    raise exception 'pretest(intel_runtime): public.system_control / public.send_queue missing (ops_health_snapshot reads them)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'agent_api' and not (rolsuper or rolbypassrls)) then
    raise exception 'pretest(intel_runtime): role agent_api missing or privileged';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'pretest(intel_runtime): applying role % must have BYPASSRLS', current_user;
  end if;
  if current_user is distinct from (select pg_get_userbyid(relowner) from pg_class where oid = 'agent.research_job'::regclass) then
    raise exception 'pretest(intel_runtime): apply as the owner of agent.research_job (the SECURITY DEFINER write path depends on it)';
  end if;
  if exists (select 1 from agent.research_job where state not in ('draft','queued','running','paused','synthesizing','completed','completed_partial','budget_exhausted','cancelled','failed','expired')) then
    raise exception 'pretest(intel_runtime): research_job holds a state outside the S3 set';
  end if;
  raise notice 'pretest(intel_runtime): prerequisites OK';
end
$$;
