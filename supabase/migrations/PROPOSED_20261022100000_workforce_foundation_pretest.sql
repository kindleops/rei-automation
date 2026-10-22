-- PROPOSED ONLY — PRETEST for PROPOSED_20261022100000_workforce_foundation.sql (Workforce Phase A). Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_foundation
-- Read-only prerequisite checks (the migration repeats them and RAISES).
-- Expected last notice: "pretest(workforce_foundation): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regnamespace('agent') is null or to_regclass('agent.org') is null or to_regclass('agent.operator_membership') is null then
    raise exception 'pretest(workforce_foundation): the S3 schema (PROPOSED_20261010120000_agent_s3_persistence) must be applied first';
  end if;
  if to_regprocedure('agent.payload_is_clean(jsonb)') is null or to_regprocedure('agent.payload_string_violation(text,text,integer)') is null
     or to_regprocedure('agent.can_read_org(uuid)') is null then
    raise exception 'pretest(workforce_foundation): agent.payload_is_clean / agent.payload_string_violation(text, text, integer) / agent.can_read_org missing';
  end if;
  if to_regprocedure('agent.runtime_is_named_operator(text)') is null or to_regclass('agent.runtime_schedule') is null
     or to_regprocedure('agent.runtime_upsert_schedule(text,text,integer,text,jsonb,boolean,timestamptz,numeric)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise exception 'pretest(workforce_foundation): the R2 runtime (PROPOSED_20261012140000_intel_runtime) must be applied first';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'agent_api' and not (rolsuper or rolbypassrls)) then
    raise exception 'pretest(workforce_foundation): role agent_api missing or privileged';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') or not exists (select 1 from pg_roles where rolname = 'anon') or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'pretest(workforce_foundation): Supabase roles anon / authenticated / service_role missing';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'pretest(workforce_foundation): applying role % must have BYPASSRLS', current_user;
  end if;
  if not exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001') then
    raise exception 'pretest(workforce_foundation): the LeadCommand org row is missing';
  end if;
  if to_regnamespace('workforce') is not null then
    raise exception 'pretest(workforce_foundation): schema workforce already exists — a previous apply is present; reconcile first';
  end if;
  if exists (select 1 from agent.runtime_schedule where name = 'workforce-dispatch') then
    raise exception 'pretest(workforce_foundation): a workforce-dispatch schedule already exists';
  end if;
  raise notice 'pretest(workforce_foundation): prerequisites OK';
end
$$;
