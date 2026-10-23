-- DISPOSABLE TEST FIXTURE (apps/api/tests/critical/action-gateway-pg-net-posture-pg.test.mjs), never production.
-- The read-only credential privilege self-check (public.lc_mcp_reader_self_check, #25) EXACTLY as it was before the Supabase pg_net platform exception (commit 9361a4a0),
-- renamed *_strict_reference. The posture test runs it next to the current function and asserts that, whenever
-- the exception does NOT apply (wrong owner / grantor / ACL / a non-extension object / no pg_net at all), the
-- current function reports EXACTLY the same findings: the exception never weakens the strict rule silently.
-- Body copied verbatim (only the function name differs); see docs/SUPABASE-PG-NET-POSTURE.md.

create or replace function public.lc_mcp_reader_self_check_strict_reference(p_relations text[], p_functions text[], p_role name default current_user)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $fn$
declare
  r oid;
  ver int := current_setting('server_version_num')::int;
  tbl_write text := 'DELETE,TRUNCATE,TRIGGER' || case when current_setting('server_version_num')::int >= 170000 then ',MAINTAIN' else '' end;
  allow_oids oid[];
  rep jsonb;
  findings text[] := '{}';
  x jsonb;
begin
  select oid into r from pg_roles where rolname = p_role;
  if r is null then
    return jsonb_build_object('version', 1, 'role', p_role, 'exists', false, 'ok', false, 'findings', jsonb_build_array('role_missing'));
  end if;
  select coalesce(array_agg(to_regprocedure(s)), '{}') into allow_oids from unnest(p_functions) s where to_regprocedure(s) is not null;

  rep := jsonb_build_object(
    'version', 1,
    'role', p_role,
    'exists', true,
    'current_user', current_user::text,
    'session_user', session_user::text,
    'server_version_num', ver,
    'attributes', (select jsonb_build_object('superuser', rolsuper, 'bypassrls', rolbypassrls, 'createrole', rolcreaterole, 'createdb', rolcreatedb,
                     'replication', rolreplication, 'canlogin', rolcanlogin, 'inherit', rolinherit) from pg_roles where oid = r),
    'member_of', coalesce((select jsonb_agg(g.rolname::text order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r), '[]'::jsonb),
    'granted_to', coalesce((select jsonb_agg(g.rolname::text order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.member where m.roleid = r), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(jsonb_build_object(
          'name', q.name,
          'exists', c.oid is not null,
          'kind', c.relkind,
          'select', c.oid is not null and has_table_privilege(r, c.oid, 'SELECT'),
          'rls', coalesce(c.relrowsecurity, false),
          'permissive_policy', c.oid is not null and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive and p.polcmd in ('r', '*') and (r = any(p.polroles) or 0::oid = any(p.polroles))),
          'restrictive_policy', c.oid is not null and exists (select 1 from pg_policy p where p.polrelid = c.oid and not p.polpermissive and p.polcmd in ('r', '*') and (r = any(p.polroles) or 0::oid = any(p.polroles))),
          'invoker_view', c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ','), '') ~* '(^|,)security_invoker=(true|on|yes|1)(,|$)')
        order by q.name)
      from unnest(p_relations) q(name) left join pg_class c on c.oid = to_regclass(format('public.%I', q.name))), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(jsonb_build_object(
          'signature', q.sig,
          'exists', p.oid is not null,
          'executable', p.oid is not null and has_function_privilege(r, p.oid, 'EXECUTE'),
          'volatility', p.provolatile,
          'security_definer', p.prosecdef,
          'language', l.lanname,
          'search_path_pinned', p.oid is not null and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%'))
        order by q.sig)
      from unnest(p_functions) q(sig) left join pg_proc p on p.oid = to_regprocedure(q.sig) left join pg_language l on l.oid = p.prolang), '[]'::jsonb),
    -- a privilege counts when it is exercisable: the role can also USE the schema
    'write_privileges', coalesce((
      select jsonb_agg(z.n order by z.n) from (
        select format('%I.%I', n.nspname, c.relname) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f')
           and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
           and has_schema_privilege(r, n.oid, 'USAGE')
           -- CASE: the planner may evaluate predicates in any order; privilege functions run only on the kinds above
           and case when c.relkind in ('r', 'p', 'v', 'm', 'f') then has_table_privilege(r, c.oid, tbl_write) or has_any_column_privilege(r, c.oid, 'INSERT,UPDATE,REFERENCES') else false end
         order by 1 limit 50) z), '[]'::jsonb),
    'sequence_privileges', coalesce((
      select jsonb_agg(z.n order by z.n) from (
        select format('%I.%I', n.nspname, c.relname) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
           and has_schema_privilege(r, n.oid, 'USAGE') and case when c.relkind = 'S' then has_sequence_privilege(r, c.oid, 'USAGE,UPDATE') else false end
         order by 1 limit 50) z), '[]'::jsonb),
    'schema_create', coalesce((select jsonb_agg(n.nspname::text order by n.nspname) from pg_namespace n
                                where n.nspname !~ '^pg_(toast|temp)' and has_schema_privilege(r, n.oid, 'CREATE')), '[]'::jsonb),
    'database_create', has_database_privilege(r, current_database(), 'CREATE'),
    'database_temp', has_database_privilege(r, current_database(), 'TEMP'),
    'reachable_definer_functions', coalesce((
      select jsonb_agg(z.s order by z.s) from (
        select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.prosecdef and p.prokind in ('f', 'p')
           and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
           and n.nspname not in ('pg_catalog', 'information_schema')
           and has_schema_privilege(r, n.oid, 'USAGE') and case when p.prosecdef then has_function_privilege(r, p.oid, 'EXECUTE') else false end
           and not (p.oid = any(allow_oids))
           and not (p.proname = 'st_estimatedextent' and p.provolatile in ('s', 'i'))
         order by 1 limit 50) z), '[]'::jsonb),
    -- network egress the role can reach: members of the pg_net / http / dblink / postgres_fdw extensions,
    -- untrusted-language functions, and any reachable sql / plpgsql function whose body calls them (a wrapper).
    -- Read-only is not enough: an egress function could ship rows off the database.
    'reachable_egress_functions', coalesce((
      select jsonb_agg(z.s order by z.s) from (
        select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
         where p.prokind in ('f', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
           and has_schema_privilege(r, n.oid, 'USAGE') and has_function_privilege(r, p.oid, 'EXECUTE')
           and not (p.oid = any(allow_oids))
           and (exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                         where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_catalog.pg_extension'::regclass
                           and d.deptype = 'e' and e.extname in ('pg_net', 'http', 'dblink', 'postgres_fdw'))
                -- by name too: pg_net lives in schema net (owned by supabase_admin, PUBLIC-executable in
                -- production per the 2026-10-16 role audit); http / dblink functions however installed
                or n.nspname = 'net'
                or p.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
                or (not l.lanpltrusted and l.lanname not in ('c', 'internal'))
                -- wrappers: a reachable sql / plpgsql body calling an egress or a PUBLIC side-effect function
                or (l.lanname in ('sql', 'plpgsql') and p.prosrc ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)\s*\('))
         order by 1 limit 50) z), '[]'::jsonb),
    -- SELECT outside the inventory in a PostgREST-exposed schema (public, graphql_public): a finding.
    -- An owner-rights view here would read its base tables past RLS. PostGIS metadata is excepted.
    'exposed_select_outside_inventory', coalesce((
      select jsonb_agg(z.n order by z.n) from (
        select format('%I.%I', n.nspname, c.relname) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname in ('public', 'graphql_public')
           and has_schema_privilege(r, n.oid, 'USAGE') and case when c.relkind in ('r', 'p', 'v', 'm', 'f') then has_table_privilege(r, c.oid, 'SELECT') else false end
           and not (n.nspname = 'public' and c.relname = any(p_relations))
           and c.relname not in ('spatial_ref_sys', 'geometry_columns', 'geography_columns', 'raster_columns', 'raster_overviews')
         order by 1 limit 50) z), '[]'::jsonb),
    -- informational (reads only): SELECT the role holds outside the inventory in ANY schema it can use, e.g. through PUBLIC
    'select_outside_inventory', coalesce((
      select jsonb_agg(z.n order by z.n) from (
        select format('%I.%I', n.nspname, c.relname) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f')
           and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
           and has_schema_privilege(r, n.oid, 'USAGE') and case when c.relkind in ('r', 'p', 'v', 'm', 'f') then has_table_privilege(r, c.oid, 'SELECT') else false end
           and not (n.nspname = 'public' and c.relname = any(p_relations))
         order by 1 limit 50) z), '[]'::jsonb),
    'generated_at', now()
  );

  -- findings: the SAME rules the server evaluates independently (data/credential.mjs#evaluateSelfCheck)
  if (rep->'attributes'->>'superuser')::boolean then findings := findings || 'attr_superuser'::text; end if;
  if (rep->'attributes'->>'bypassrls')::boolean then findings := findings || 'attr_bypassrls'::text; end if;
  if (rep->'attributes'->>'createrole')::boolean then findings := findings || 'attr_createrole'::text; end if;
  if (rep->'attributes'->>'createdb')::boolean then findings := findings || 'attr_createdb'::text; end if;
  if (rep->'attributes'->>'replication')::boolean then findings := findings || 'attr_replication'::text; end if;
  if (rep->'attributes'->>'canlogin')::boolean then findings := findings || 'attr_canlogin'::text; end if;
  if jsonb_array_length(rep->'member_of') > 0 then findings := findings || ('member_of:' || (rep->>'member_of')); end if;
  if jsonb_array_length(rep->'write_privileges') > 0 then findings := findings || ('write_privileges:' || (rep->>'write_privileges')); end if;
  if jsonb_array_length(rep->'sequence_privileges') > 0 then findings := findings || ('sequence_privileges:' || (rep->>'sequence_privileges')); end if;
  if jsonb_array_length(rep->'schema_create') > 0 then findings := findings || ('schema_create:' || (rep->>'schema_create')); end if;
  if (rep->>'database_create')::boolean then findings := findings || 'database_create'::text; end if;
  if jsonb_array_length(rep->'reachable_definer_functions') > 0 then findings := findings || ('reachable_definer_functions:' || (rep->>'reachable_definer_functions')); end if;
  if jsonb_array_length(rep->'reachable_egress_functions') > 0 then findings := findings || ('reachable_egress_functions:' || (rep->>'reachable_egress_functions')); end if;
  if jsonb_array_length(rep->'exposed_select_outside_inventory') > 0 then findings := findings || ('exposed_select_outside_inventory:' || (rep->>'exposed_select_outside_inventory')); end if;
  for x in select * from jsonb_array_elements(rep->'relations') loop
    if (x->>'exists')::boolean then
      if not (x->>'select')::boolean then findings := findings || ('no_select:' || (x->>'name')); end if;
      if (x->>'rls')::boolean and not (x->>'permissive_policy')::boolean then findings := findings || ('rls_without_policy:' || (x->>'name')); end if;
      if (x->>'restrictive_policy')::boolean then findings := findings || ('restrictive_policy:' || (x->>'name')); end if;
      if (x->>'invoker_view')::boolean then findings := findings || ('invoker_view:' || (x->>'name')); end if;
    end if;
  end loop;
  for x in select * from jsonb_array_elements(rep->'functions') loop
    if not (x->>'exists')::boolean then findings := findings || ('function_missing:' || (x->>'signature'));
    else
      if not (x->>'executable')::boolean then findings := findings || ('no_execute:' || (x->>'signature')); end if;
      if x->>'volatility' = 'v' then findings := findings || ('volatile_function:' || (x->>'signature')); end if;
      -- search_path_pinned is reported, not a finding: the role holds CREATE nowhere, so it cannot plant objects
    end if;
  end loop;
  -- mirror of the current function's transitive-reachability findings (so a 'not applied' pg_net exception reports the SAME indirect findings)
  findings := findings || public.lc_reachable_egress_indirect(r);
  return rep || jsonb_build_object('findings', to_jsonb(findings), 'ok', coalesce(array_length(findings, 1), 0) = 0);
end
$fn$;
