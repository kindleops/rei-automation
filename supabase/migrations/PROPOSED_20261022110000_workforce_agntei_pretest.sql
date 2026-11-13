-- PROPOSED ONLY — PRETEST for PROPOSED_20261022110000_workforce_agntei.sql (Workforce × Agntei). Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_agntei
-- Read-only prerequisite checks (the migration repeats them and RAISES).
-- Expected last notice: "pretest(workforce_agntei): prerequisites OK".
\set ON_ERROR_STOP on
begin;
do $$
declare problems text[] := '{}';
begin
  if to_regnamespace('workforce') is null or to_regprocedure('workforce.assignment_claim(uuid,text,integer,integer,timestamp with time zone)') is null
     or to_regprocedure('workforce.employee_upsert(uuid,jsonb,uuid)') is null or to_regprocedure('workforce.assignment_resume_job(uuid,text,text,text,jsonb,jsonb)') is null then
    problems := problems || 'the Workforce foundation (PROPOSED_20261022100000_workforce_foundation) is not applied'::text;
  end if;
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.self_check(name)') is null or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null
     or to_regprocedure('action_gateway.grant_note_failure(uuid,text)') is null or to_regprocedure('action_gateway.grant_suspend(uuid,text)') is null then
    problems := problems || 'link #26 (PROPOSED_20261019160000_action_gateway) is not applied'::text;
  end if;
  if to_regclass('action_gateway.extensions') is null then problems := problems || 'link #27 (the extension registry, PROPOSED_20261020100000_action_gateway_t2) is not applied'::text; end if;
  if to_regprocedure('agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)') is null then problems := problems || 'agent.runtime_enqueue is missing'::text; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'manual_override') then
    problems := problems || 'public.inbox_thread_state.manual_override is missing'::text;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'workforce' and table_name = 'employee' and column_name = 'origin') then
    problems := problems || 'this migration is already applied'::text;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = to_regclass('workforce.employee') and conname = 'employee_status_check') then
    problems := problems || 'workforce.employee.employee_status_check is not the foundation''s'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest(workforce_agntei): %', array_to_string(problems, '; '); end if;
  raise notice 'pretest(workforce_agntei): prerequisites OK';
end
$$;
rollback;
