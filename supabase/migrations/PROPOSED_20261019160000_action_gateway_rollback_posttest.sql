-- POSTTEST of the rollback of PROPOSED_20261019160000_action_gateway.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. Together with the runner's fingerprint comparison, it proves the
-- rollback removed exactly the migration's objects and left every neighbour alone.
begin;
do $$
declare problems text[] := '{}';
begin
  if exists (select 1 from pg_roles where rolname = 'lc_action_gateway') then problems := problems || 'role lc_action_gateway still exists'::text; end if;
  if to_regnamespace('action_gateway') is not null then problems := problems || 'schema action_gateway still exists'::text; end if;
  if exists (select 1 from pg_policy where polname = 'lc_action_gateway_select') then problems := problems || 'a lc_action_gateway_select policy remains'::text; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'action\_gateway\_%') then problems := problems || 'an action_gateway_* function remains'::text; end if;
  -- the ops_work_item CHECKs are #24's again
  if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_scope_check')) ~ 'agent''' then
    problems := problems || 'ops_work_item scope CHECK still admits agent'::text;
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'agent.ops_work_item'::regclass and conname = 'ops_work_item_kind_check')) ~ 'agent_task' then
    problems := problems || 'ops_work_item kind CHECK still admits agent_task'::text;
  end if;
  if agent.ops_scope_of_kind('conversation.turn') is distinct from 'conversation' then problems := problems || 'the #24 scope map changed'::text; end if;
  -- untouched neighbours
  if to_regprocedure('agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)') is null
     or to_regprocedure('agent.capability_approval_insert(jsonb)') is null or to_regclass('public.automation_holds') is null then
    problems := problems || 'a domain object the gateway wrapped was dropped'::text;
  end if;
  if not has_function_privilege('agent_api', 'agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)', 'EXECUTE') then
    problems := problems || 'agent_api lost EXECUTE on agent.runtime_enqueue'::text;
  end if;
  if not pg_has_role('authenticator', 'authenticated', 'SET') or not pg_has_role('authenticator', 'service_role', 'SET') then problems := problems || 'authenticator lost an existing membership'::text; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.system_control'::regclass) then problems := problems || 'system_control lost row level security'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only the migration''s objects are gone';
end $$;
rollback;
