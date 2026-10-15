-- PROPOSED ONLY — PRETEST for PROPOSED_20261013120000_agent_capabilities.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite checks. The apply → assert → ROLLBACK half moved to
-- PROPOSED_20261013120000_agent_capabilities_posttest.sql (rc-8.5.15.1: a fixture never includes
-- another file). Run both through the migration test runner on a disposable database:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id agent_capabilities
-- Expected last notice: "pretest(agent_capabilities): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('agent.org') is null or to_regclass('agent.operator_membership') is null or to_regprocedure('agent.payload_is_clean(jsonb)') is null then
    raise exception 'pretest(agent_capabilities): the S3 schema (PROPOSED_20261010120000_agent_s3_persistence) must be applied first';
  end if;
  if to_regclass('agent.approval_request') is not null or to_regclass('agent.capability_audit') is not null then
    raise exception 'pretest(agent_capabilities): objects already exist — a previous apply is present; reconcile first';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'agent_api' and not (rolsuper or rolbypassrls)) then
    raise exception 'pretest(agent_capabilities): role agent_api missing or privileged';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'pretest(agent_capabilities): applying role % must have BYPASSRLS (the SECURITY DEFINER write path runs as the table owner)', current_user;
  end if;
  if not exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001') then
    raise exception 'pretest(agent_capabilities): the LeadCommand org row is missing';
  end if;
  raise notice 'pretest(agent_capabilities): prerequisites OK';
end
$$;
