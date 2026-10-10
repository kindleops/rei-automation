-- PROPOSED ONLY — rollback for PROPOSED_20261010120000_agent_s3_persistence.sql.
-- Refuses while any run is in flight (cancel or let them finish first). With
-- persisted runs it refuses unless the operator sets the explicit override:
--   psql "$DB" -v ON_ERROR_STOP=1 -c "set agent.rollback_discard_data = 'on'" -f ..._rollback.sql
-- (an export of agent.* should be taken first; see the release plan).
-- Rows written to public.idempotency_ledger under scope 'agent.tool' are
-- removed too; nothing else outside schema agent is touched.
begin;
do $$
declare n_active bigint; n_runs bigint;
begin
  if to_regclass('agent.run') is null then
    raise notice 'rollback: agent schema objects absent — nothing to do';
    return;
  end if;
  select count(*) filter (where ended_at is null), count(*) into n_active, n_runs from agent.run;
  if n_active > 0 then
    raise exception 'rollback refused: % run(s) still in flight', n_active;
  end if;
  if n_runs > 0 and coalesce(current_setting('agent.rollback_discard_data', true), 'off') <> 'on' then
    raise exception 'rollback refused: % persisted run(s); export then set agent.rollback_discard_data = on', n_runs;
  end if;
  -- L9: never let DROP … CASCADE remove something outside this migration
  if exists (
    select 1
      from pg_depend d
      join pg_namespace n on n.nspname = 'agent'
     where d.deptype in ('n', 'a')
       and (
         (d.refclassid = 'pg_class'::regclass and d.refobjid in (select oid from pg_class where relnamespace = n.oid)) or
         (d.refclassid = 'pg_proc'::regclass and d.refobjid in (select oid from pg_proc where pronamespace = n.oid)) or
         (d.refclassid = 'pg_type'::regclass and d.refobjid in (select oid from pg_type where typnamespace = n.oid))
       )
       and coalesce((pg_identify_object(d.classid, d.objid, d.objsubid)).schema, 'agent') <> 'agent'
       and (pg_identify_object(d.classid, d.objid, d.objsubid)).identity not like 'idempotency_ledger_agent_api_scope on public.idempotency_ledger'
  ) then
    raise exception 'rollback refused: objects outside schema agent depend on agent.* — resolve them first';
  end if;
end
$$;
-- restore PUBLIC EXECUTE on any definer function the migration narrowed
do $$ declare f record; begin
  if to_regclass('agent.public_execute_revoked') is not null then
    for f in select signature from agent.public_execute_revoked loop
      execute format('grant execute on function %s to public', f.signature);
    end loop;
  end if;
end $$;
delete from public.idempotency_ledger where scope = 'agent.tool';
drop policy if exists idempotency_ledger_agent_api_scope on public.idempotency_ledger;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'agent_api') then
    execute 'revoke all on public.idempotency_ledger from agent_api';
  end if;
end $$;
drop schema if exists agent cascade;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'agent_api') then
    execute 'drop owned by agent_api';     -- this database only
    begin
      execute 'drop role agent_api';
    exception when dependent_objects_still_exist then
      raise notice 'rollback: agent_api still holds privileges in another database of this cluster; role kept (no rights here)';
    end;
  end if;
end $$;
commit;
