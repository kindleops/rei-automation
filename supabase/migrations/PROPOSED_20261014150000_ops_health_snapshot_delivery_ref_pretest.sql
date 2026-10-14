-- PROPOSED ONLY — PRETEST. Changes NOTHING (BEGIN … ROLLBACK).
-- Expected last notice: "pretest(ops_health_snapshot_delivery_ref): ALL OK (rolled back)".
\set ON_ERROR_STOP on
do $$
begin
  if to_regprocedure('agent.ops_health_snapshot(integer,integer)') is null then
    raise exception 'pretest: the R2 runtime (PROPOSED_20261012140000_intel_runtime.sql) must be applied first';
  end if;
end $$;
begin;
set local statement_timeout = '10s';
\ir PROPOSED_20261014150000_ops_health_snapshot_delivery_ref.sql
do $$
declare r jsonb; acl text;
begin
  r := agent.ops_health_snapshot(15, 10);
  if not (r ? 'deliveries') or not (r -> 'deliveries' ? 'last_delivered_at') then raise exception 'assert: deliveries.last_delivered_at present (%)', r; end if;
  if not (r ? 'keys') or not (r ? 'queue') or not (r ? 'at') then raise exception 'assert: existing fields kept'; end if;
  select coalesce(array_to_string(proacl, ','), '') into acl from pg_proc where oid = 'agent.ops_health_snapshot(integer,integer)'::regprocedure;
  if acl !~ 'agent_api=X' then raise exception 'assert: agent_api keeps EXECUTE (%)', acl; end if;
  if acl ~ '(^|,)=X' or acl ~ 'anon=X' or acl ~ 'authenticated=X' then raise exception 'assert: no PUBLIC/anon/authenticated EXECUTE (%)', acl; end if;
  if not (select prosecdef from pg_proc where oid = 'agent.ops_health_snapshot(integer,integer)'::regprocedure) then raise exception 'assert: still SECURITY DEFINER'; end if;
  raise notice 'pretest(ops_health_snapshot_delivery_ref): ALL OK (rolled back)';
end $$;
rollback;
