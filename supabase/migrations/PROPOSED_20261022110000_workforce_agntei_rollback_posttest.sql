-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261022110000_workforce_agntei.sql (Workforce × Agntei).
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "rollback_posttest(workforce_agntei): ALL OK".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'workforce' and column_name in ('employment_type', 'origin', 'external_agent_id', 'execution_mode', 'availability')) then
    raise exception 'assert: the identity / mode columns are gone';
  end if;
  if to_regclass('workforce.budget') is not null then raise exception 'assert: workforce.budget is gone'; end if;
  if to_regprocedure('public.action_gateway_dw_workforce(uuid,uuid)') is not null or to_regprocedure('public.action_gateway_workforce_read(text,text,jsonb)') is not null
     or to_regprocedure('workforce.employee_bind_principal(uuid,text,text,uuid)') is not null then
    raise exception 'assert: the gateway writer / reader and the bind function are gone';
  end if;
  if exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei') then raise exception 'assert: no registry row of this link survives'; end if;
  if to_regprocedure('workforce.assignment_claim(uuid,text,integer,integer,timestamp with time zone)') is null or to_regprocedure('action_gateway.self_check(name)') is null then
    raise exception 'assert: the foundation and #26 are untouched';
  end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then raise exception 'assert: the gateway self-check is ok'; end if;
  raise notice 'rollback_posttest(workforce_agntei): ALL OK';
end
$$;
rollback;
