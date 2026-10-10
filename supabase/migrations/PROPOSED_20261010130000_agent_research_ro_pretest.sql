-- PROPOSED ONLY — run BEFORE PROPOSED_20261010130000_agent_research_ro.sql, in the same session.
-- Read-only. Raises (aborting the apply) if a prerequisite is missing or the target exists.
do $$
begin
  if to_regclass('agent.run') is null or to_regclass('agent.org') is null then
    raise exception 'pretest(research): the S3 schema (PROPOSED_20261010120000_agent_s3_persistence) must be applied first';
  end if;
  if not exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001') then
    raise exception 'pretest(research): the LeadCommand org row is missing';
  end if;
  if to_regprocedure('agent.payload_is_clean(jsonb)') is null then
    raise exception 'pretest(research): agent.payload_is_clean(jsonb) missing';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'agent_api') then
    raise exception 'pretest(research): role agent_api missing (created by the S3 migration)';
  end if;
  if exists (select 1 from pg_roles where rolname = 'agent_api' and (rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb)) then
    raise exception 'pretest(research): agent_api must be NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB';
  end if;
  if to_regclass('agent.research_limits') is not null or to_regclass('agent.research_run') is not null
     or to_regclass('agent.research_audit') is not null or to_regclass('agent.spend_ledger') is not null then
    raise exception 'pretest(research): research tables already exist — a previous apply is present; reconcile first';
  end if;
  if to_regprocedure('gen_random_uuid()') is null then
    raise exception 'pretest(research): gen_random_uuid() missing';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'pretest(research): applying role % must have BYPASSRLS', current_user;
  end if;
  raise notice 'pretest(research): OK';
end
$$;
