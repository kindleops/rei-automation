-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261022100000_workforce_foundation.sql (Workforce Phase A).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback_posttest(workforce_foundation): ALL OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if to_regnamespace('workforce') is not null then raise exception 'assert: rollback dropped schema workforce'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'workforce') then raise exception 'assert: no workforce function survives'; end if;
  if exists (select 1 from agent.runtime_schedule where name = 'workforce-dispatch') then raise exception 'assert: the workforce-dispatch schedule is gone'; end if;
  if to_regclass('agent.research_job') is null or to_regprocedure('agent.payload_is_clean(jsonb)') is null or to_regprocedure('agent.can_read_org(uuid)') is null
     or to_regprocedure('agent.runtime_upsert_schedule(text,text,integer,text,jsonb,boolean,timestamptz,numeric)') is null then
    raise exception 'assert: schema agent is untouched';
  end if;
  if not exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001') then raise exception 'assert: the org row is untouched'; end if;
  raise notice 'rollback_posttest(workforce_foundation): ALL OK';
end
$$;
rollback;
