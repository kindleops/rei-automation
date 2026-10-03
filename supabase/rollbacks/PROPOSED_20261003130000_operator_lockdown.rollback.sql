-- =============================================================================
-- Rollback for supabase/migrations/PROPOSED_20261003130000_operator_lockdown.sql
--
-- Run as ONE transaction:
--   psql "$SUPABASE_DB_URL" -X -1 -v ON_ERROR_STOP=1 -f supabase/rollbacks/PROPOSED_20261003130000_operator_lockdown.rollback.sql
-- There is no BEGIN/COMMIT in this file, so the pretest can \ir it inside its own
-- transaction.
--
-- It is exact. It replays ops_lockdown.snapshot, which the migration wrote before it
-- changed anything (function ACLs cover public, private and comp_private):
--   9 map RPC definitions, 13 view definitions, 72 policies, RLS flags, and every
--   relation/function ACL entry for anon, authenticated, PUBLIC and service_role.
-- Then it drops the helpers and the snapshot schema. Do NOT roll back
-- operator_read_policies first: the restored policies do not depend on it, but the
-- order matters for is_ops_operator().
-- =============================================================================

set local lock_timeout = '5s';

do $$
declare
  r record;
  roles_sql text;
  g text;
  priv text;
  had boolean;
begin
  if to_regclass('ops_lockdown.snapshot') is null
     or not exists (select 1 from ops_lockdown.snapshot where migration = '20261003130000') then
    raise exception 'operator_lockdown rollback: no snapshot found; nothing to roll back';
  end if;

  -- 1. Map RPC bodies (removes the injected gate).
  for r in select object, payload from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'func_def' loop
    execute r.payload ->> 'def';
  end loop;

  -- 2. View definitions (removes the _ops_gate wrapper).
  for r in select object, payload from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'view_def' loop
    execute format('create or replace view public.%I as %s', r.object, r.payload ->> 'def');
  end loop;

  -- 3. Policies: drop what the migration created, recreate what it dropped.
  for r in select object from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'created_policy' loop
    execute format('drop policy if exists %I on public.%I',
                   split_part(r.object, '.', 2), split_part(r.object, '.', 1));
  end loop;
  for r in select payload p from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'policy' order by id loop
    select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ')
      into roles_sql from jsonb_array_elements_text(r.p -> 'roles') x;
    execute format('create policy %I on public.%I as %s for %s to %s %s %s',
      r.p ->> 'name', r.p ->> 'table', r.p ->> 'permissive', r.p ->> 'cmd', roles_sql,
      case when r.p ->> 'qual' is not null then 'using (' || (r.p ->> 'qual') || ')' else '' end,
      case when r.p ->> 'with_check' is not null then 'with check (' || (r.p ->> 'with_check') || ')' else '' end);
  end loop;

  -- 4. RLS back off where it was off.
  for r in select object from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'rls_enabled' loop
    execute format('alter table public.%I disable row level security', r.object);
  end loop;

  -- 5. Relation ACLs for anon / authenticated / PUBLIC, privilege by privilege.
  for r in select object, payload from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'rel_acl' loop
    continue when to_regclass(r.object) is null;
    -- Only relations whose ACL actually changed.
    continue when (select c.relacl::text[] from pg_class c where c.oid = to_regclass(r.object))
                  is not distinct from (select array_agg(x) from jsonb_array_elements_text(r.payload -> 'acl') x);
    foreach g in array array['anon', 'authenticated', 'public'] loop
      foreach priv in array case when r.payload ->> 'relkind' = 'S'
                                 then array['USAGE','SELECT','UPDATE']
                                 else array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] end loop
        select exists (
          select 1 from aclexplode((select array_agg(x::aclitem) from jsonb_array_elements_text(r.payload -> 'acl') x)) a
          where a.privilege_type = priv
            and a.grantee = case when g = 'public' then 0::oid else g::regrole::oid end
        ) into had;
        execute format('%s %s on %s %s %s %s',
          case when had then 'grant' else 'revoke' end, priv,
          case when r.payload ->> 'relkind' = 'S' then 'sequence' else 'table' end,
          r.object, case when had then 'to' else 'from' end, g);
      end loop;
    end loop;
  end loop;

  -- 6. Function EXECUTE for anon / authenticated / PUBLIC / service_role.
  for r in select object, payload from ops_lockdown.snapshot
           where migration = '20261003130000' and kind = 'func_acl' loop
    continue when to_regprocedure(r.object) is null;
    continue when (select p.proacl::text[] from pg_proc p where p.oid = to_regprocedure(r.object))
                  is not distinct from (case when jsonb_typeof(r.payload -> 'acl') = 'array' then
                    (select array_agg(x) from jsonb_array_elements_text(r.payload -> 'acl') x) end);
    foreach g in array array['anon', 'authenticated', 'public', 'service_role', 'comp_ingest'] loop
      if jsonb_typeof(r.payload -> 'acl') is distinct from 'array' then
        -- NULL proacl = default = EXECUTE to PUBLIC (+ owner).
        had := (g = 'public');
      else
        select exists (
          select 1 from aclexplode((select array_agg(x::aclitem) from jsonb_array_elements_text(r.payload -> 'acl') x)) a
          where a.privilege_type = 'EXECUTE'
            and a.grantee = case when g = 'public' then 0::oid else g::regrole::oid end
        ) into had;
      end if;
      execute format('%s execute on function %s %s %s',
        case when had then 'grant' else 'revoke' end, r.object,
        case when had then 'to' else 'from' end, g);
    end loop;
  end loop;
end
$$;

-- 7. Default privileges back to the Supabase defaults measured before the migration.
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant all on sequences to anon;
alter default privileges for role postgres in schema public grant truncate on tables to authenticated;

-- 8. Helpers and snapshot. Nothing references the helpers once 1 and 2 have run.
drop function if exists public.assert_ops_read_allowed();
drop function if exists public.ops_read_allowed();
drop schema if exists ops_lockdown cascade;
