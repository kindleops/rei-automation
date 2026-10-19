-- =============================================================================
-- LeadCommand MCP 1.0 live mode: a DATABASE-ROLE-ENFORCED read-only credential
-- STATUS: PROPOSED. NOT APPLIED. Owner approval required; applied on its own.
-- Test (disposable PostgreSQL 17 ONLY, never production):
--   node scripts/db/run-migration-test.mjs --pg-bin <pg17 bin dir> --id lc_mcp_reader
-- Rollback: PROPOSED_20261019150000_lc_mcp_reader_rollback.sql (drops exactly what this creates)
-- Design:   docs/LEADCOMMAND-MCP-1.0.md §4.2
-- =============================================================================
--
-- WHY: live mode used to read PostgREST with the SERVICE ROLE key. Writes were refused
-- only client-side; the credential itself could write everything and bypassed RLS.
-- This migration creates the credential's database identity. The owner then mints a
-- JWT whose role claim is lc_mcp_reader, signed with the project's JWT secret.
-- PostgREST verifies the token and runs SET ROLE lc_mcp_reader, so every request runs
-- with exactly these privileges.
--
-- WHAT IT CREATES
--   role lc_mcp_reader: NOLOGIN NOINHERIT. The defaults hold: no SUPERUSER, CREATEDB,
--     CREATEROLE, REPLICATION or BYPASSRLS. It is a member of NO role.
--     statement_timeout = 5s. PostgREST applies per-role settings on SET ROLE.
--     authenticator (PostgREST) is granted lc_mcp_reader, so PostgREST can switch to it.
--   USAGE on schema public. No CREATE on any schema.
--   SELECT on exactly the 20 relations below, no more. This is the code-derived read
--     inventory (mcp/leadcommand-mcp/src/data/inventory.mjs). A test pins the list.
--   Policy lc_mcp_reader_select (FOR SELECT TO lc_mcp_reader USING (true)) on every one
--     of them that is a table. Since the operator lockdown, RLS is on for every
--     postgres-owned public table. Without a policy the role would read ZERO rows: a
--     silent wrong answer, not a denial.
--   EXECUTE on 2 existing read RPCs (SECURITY DEFINER, STABLE) and 2 new ones:
--     public.lc_mcp_reader_self_check(text[], text[], name). SECURITY INVOKER, STABLE.
--       Privilege introspection of the CALLING role. The server's boot self-check and
--       the final block of this file both read it.
--     public.lc_mcp_operator_role(uuid, uuid). SECURITY DEFINER, STABLE, sql. It returns
--       the role of ONE agent.operator_membership row, so the role needs no privilege in
--       schema agent. It replaces the agent_api login, which can write agent.*.
--
-- WHAT MAKES THE APPLY ABORT (atomically: nothing is created):
--   * authenticator, a required relation, an allowlisted RPC or agent.operator_membership
--     is missing;
--   * an allowlisted RPC is VOLATILE;
--   * an inventory view is security_invoker (its base tables would need grants that are
--     not in the inventory);
--   * lc_mcp_reader already exists with any attribute other than NOLOGIN NOINHERIT;
--   * after the grants, ANY finding of lc_mcp_reader_self_check for lc_mcp_reader:
--       - a write privilege (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN,
--         table or column level) on any relation in a schema the role can use;
--       - sequence USAGE/UPDATE;
--       - CREATE on any schema or on the database;
--       - membership in any role;
--       - a reachable SECURITY DEFINER function outside the allowlist. PUBLIC gets EXECUTE
--         on every new function by default. The 10-03 lockdown revoked PUBLIC on the 31
--         functions it found, but did not change default privileges. A definer function
--         created since then without an explicit revoke would make this credential able
--         to write, so the apply refuses and names it. Exception: PostGIS
--         st_estimatedextent, when non-volatile. That is the same allowlist as
--         agent/runtime/pg-store.js;
--       - a reachable network-egress function: anything in schema net (pg_net), a member of
--         the pg_net / http / dblink / postgres_fdw extensions, an http* / dblink* function,
--         an untrusted-language function, or a sql / plpgsql wrapper calling one of them or a
--         PUBLIC side-effect function (lo_*, pg_notify, pg_logical_emit_message). Read-only
--         is not enough if rows can leave the database. PRODUCTION TODAY (role audit
--         2026-10-16): PUBLIC holds USAGE on schema net, EXECUTE on net.http_get / http_post /
--         http_delete and ALL on net.http_request_queue / net._http_response (pg_net 0.20.0,
--         owned by supabase_admin, so postgres cannot revoke them). THIS APPLY THEREFORE
--         REFUSES until the owner resolves pg_net: drop it (H1 of the separate
--         PROPOSED_public_execute_hardening.sql), or have Supabase revoke PUBLIC on schema
--         net. That is intended;
--       - SELECT outside the inventory in a PostgREST-exposed schema (public,
--         graphql_public), for example an owner-rights view that PUBLIC can read. It would
--         read its base tables past RLS. PostGIS metadata is excepted;
--       - a restrictive policy, or RLS without an applicable permissive policy, on an
--         inventory table (rows would be hidden silently);
--       - a required inventory SELECT or RPC EXECUTE that did not take effect.
--
-- NOT TOUCHED: every other role and every existing grant, policy and function ACL
--   (anon, authenticated, service_role and agent_api included); the PostgREST
--   configuration; the JWT secret. No row is read or written.
-- LOCKS: CREATE POLICY takes a brief ACCESS EXCLUSIVE lock on each inventory table.
--   lock_timeout 5s makes the apply fail fast and whole.

set local lock_timeout = '5s';

-- ------------------------------------------------ 1. prerequisites + role ----
do $$
declare
  -- lc-inventory:relations
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- lc-inventory:optional
  optional text[] := array['census_geo_metrics'];
  -- lc-inventory:existing-rpcs
  rpcs text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)'];
  t text; c record; f record; missing text[] := '{}'; bad text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise exception 'lc_mcp_reader: role authenticator (PostgREST) is missing; this is not a Supabase database';
  end if;
  foreach t in array rels loop
    select cl.oid, cl.relkind, coalesce(array_to_string(cl.reloptions, ','), '') opts into c
      from pg_class cl where cl.oid = to_regclass(format('public.%I', t));
    if c.oid is null then
      if not (t = any(optional)) then missing := missing || t; end if;
      continue;
    end if;
    if c.relkind not in ('r', 'p', 'v', 'm', 'f') then bad := bad || format('%s (relkind %s)', t, c.relkind); end if;
    if c.relkind = 'v' and c.opts ~* '(^|,)security_invoker=(true|on|yes|1)(,|$)' then bad := bad || format('%s (security_invoker view)', t); end if;
  end loop;
  if to_regclass('agent.operator_membership') is null then missing := missing || 'agent.operator_membership'::text; end if;
  foreach t in array rpcs loop
    select p.oid, p.provolatile into f from pg_proc p where p.oid = to_regprocedure(t);
    if f.oid is null then missing := missing || t;
    elsif f.provolatile = 'v' then bad := bad || format('%s (VOLATILE: not a read)', t);
    end if;
  end loop;
  if array_length(missing, 1) > 0 then raise exception 'lc_mcp_reader: missing prerequisite(s): %', array_to_string(missing, ', '); end if;
  if array_length(bad, 1) > 0 then raise exception 'lc_mcp_reader: refused prerequisite(s): %', array_to_string(bad, ', '); end if;

  if not exists (select 1 from pg_roles where rolname = 'lc_mcp_reader') then
    -- defaults: NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    create role lc_mcp_reader nologin noinherit;
  elsif exists (select 1 from pg_roles where rolname = 'lc_mcp_reader'
                 and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    raise exception 'lc_mcp_reader: the role already exists with privileged attributes; refusing to reuse it';
  end if;
end $$;

comment on role lc_mcp_reader is 'LeadCommand MCP live mode: read-only, PostgREST-only (JWT role claim). See supabase/migrations/PROPOSED_20261019150000_lc_mcp_reader.sql';
alter role lc_mcp_reader set statement_timeout = '5s';
grant lc_mcp_reader to authenticator;

-- --------------------------------------------- 2. the two MCP functions ----
create or replace function public.lc_mcp_reader_self_check(p_relations text[], p_functions text[], p_role name default current_user)
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
  return rep || jsonb_build_object('findings', to_jsonb(findings), 'ok', coalesce(array_length(findings, 1), 0) = 0);
end
$fn$;
comment on function public.lc_mcp_reader_self_check(text[], text[], name) is 'LeadCommand MCP: privilege introspection of the calling role (read-only, SECURITY INVOKER). Boot self-check of the lc_mcp_reader credential.';
revoke all on function public.lc_mcp_reader_self_check(text[], text[], name) from public, anon, authenticated, service_role;

create or replace function public.lc_mcp_operator_role(p_org_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select m.role from agent.operator_membership m where m.org_id = p_org_id and m.user_id = p_user_id limit 1
$fn$;
comment on function public.lc_mcp_operator_role(uuid, uuid) is 'LeadCommand MCP: the role of ONE operator membership row (read-only). Executable by lc_mcp_reader only.';
revoke all on function public.lc_mcp_operator_role(uuid, uuid) from public, anon, authenticated, service_role;

-- --------------------------------------------- 3. grants + policies + verification ----
do $$
declare
  -- lc-inventory:relations
  rels text[] := array['acquisition_opportunities','campaign_target_graph','campaign_targets','campaigns','census_geo_metrics','eg_buyer_index','eg_property_facts','emails','inbox_thread_state','master_owners','mi_geo_period_rollup','mi_rollup_builds','mv_map_market_sales','phones','preforeclosure_status_v2','probate_status','properties','property_acquisition_scores','prospects','sms_suppression_list'];
  -- lc-inventory:functions
  fns text[] := array['public.campaign_entity_contact_review_flags(text[])','public.entity_graph_property_records(text)','public.lc_mcp_operator_role(uuid,uuid)','public.lc_mcp_reader_self_check(text[],text[],name)'];
  t text; k "char"; rep jsonb;
begin
  grant usage on schema public to lc_mcp_reader;
  foreach t in array rels loop
    select relkind into k from pg_class where oid = to_regclass(format('public.%I', t));
    if k is null then raise notice 'lc_mcp_reader: optional relation % is absent; not granted', t; continue; end if;
    execute format('grant select on public.%I to lc_mcp_reader', t);
    if k in ('r', 'p') and not exists (select 1 from pg_policy where polrelid = to_regclass(format('public.%I', t)) and polname = 'lc_mcp_reader_select') then
      execute format('create policy lc_mcp_reader_select on public.%I as permissive for select to lc_mcp_reader using (true)', t);
    end if;
  end loop;
  foreach t in array fns loop
    execute format('grant execute on function %s to lc_mcp_reader', t);
  end loop;

  rep := public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader');
  if not (rep->>'ok')::boolean then
    raise exception 'lc_mcp_reader: refused, the credential would not be read-only / complete: %', rep->>'findings';
  end if;
  raise notice 'lc_mcp_reader: self-check ok (% relations, % functions)', jsonb_array_length(rep->'relations'), jsonb_array_length(rep->'functions');
end $$;

notify pgrst, 'reload schema';
