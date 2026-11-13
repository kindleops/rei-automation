-- READ-ONLY production verification of the INDIRECT / transitive egress surface (docs/SUPABASE-PG-NET-POSTURE.md §9a).
-- NOT EXECUTED by any tool. The owner runs it with a ROLE-ENFORCED read-only credential (never one derived from an
-- env file), never inside a migration session, BEFORE authorizing the lc_mcp_reader / lc_action_gateway applies.
--
-- WHY grantee PUBLIC: both roles are NOLOGIN NOINHERIT and members of nothing, so the ONLY grants they inherit are
-- PUBLIC's. Everything PUBLIC can reach, the new roles can too. This query computes, for the PUBLIC pseudo-role, the
-- SAME findings public.lc_reachable_egress_indirect(oid) computes for the role — the floor that exists even before the
-- roles do. (After an authorized apply, re-run the role's own self-check / boot probe; see §9 step 7.)
--
-- OUTPUT: kind | detail | allowlisted_by. A row whose allowlisted_by is NULL is a BLOCKER (the role self-check would
-- refuse the apply). A row with allowlisted_by set is excepted by one of the two PINNED platform allowlists of
-- public.lc_egress_platform_allowlists() (docs/SUPABASE-PG-NET-POSTURE.md §4b), replicated here pin for pin:
--   supabase_postgis_dynamic_sql.v1           the exact PostGIS 3.3.7 dynamic-SQL management functions;
--   supabase_pg_net_access_event_trigger.v1   issue_pg_net_access -> extensions.grant_pg_net_access().
-- When an allowlist's pins do NOT all hold, its objects come back with allowlisted_by NULL and an extra
-- `allowlist_not_applied` row names every failed pin.
--
-- EXPECTED (production 2026-10-23): only allowlisted rows (13 dynamic_sql_function rows for PostGIS, 1
-- event_trigger_egress row), zero blockers. ANY NULL-allowlisted row is a real indirect-egress path the owner must
-- remediate (revoke the PUBLIC grant, drop the wrapper / trigger / webhook, lock the schema) before go-live. In
-- particular a non-PostGIS `dynamic_sql_function:` row (e.g. a PUBLIC-executable raw-SQL helper such as
-- public.run_sql) or an `egress_trigger:` row (a Supabase Database Webhook / pg_net trigger) is a blocker.
--
-- cron: a cron object is reachable only through USAGE on schema cron (the rule every check uses: a privilege counts
-- when the role can also USE the schema). PUBLIC's SELECT on cron.job without that USAGE is therefore not a path and is
-- not reported; USAGE on cron is a blocker, reported with every cron.job / cron.* grant it would make usable.

with recursive
nl as (select chr(10) c),
admin as (select (select oid from pg_roles where rolname = 'supabase_admin') oid),
-- ---- supabase_postgis_dynamic_sql.v1 (pins identical to public.lc_egress_platform_allowlists) ----
pg_ext as (select e.oid, e.extversion, e.extowner, e.extnamespace from pg_extension e where e.extname = 'postgis'),
pg_sig(sig) as (values
  ('public.addgeometrycolumn(character varying,character varying,character varying,character varying,integer,character varying,integer,boolean)'),
  ('public.addgeometrycolumn(character varying,character varying,character varying,integer,character varying,integer,boolean)'),
  ('public.addgeometrycolumn(character varying,character varying,integer,character varying,integer,boolean)'),
  ('public.checkauth(text,text,text)'), ('public.checkauth(text,text)'),
  ('public.disablelongtransactions()'), ('public.enablelongtransactions()'),
  ('public.dropgeometrycolumn(character varying,character varying,character varying,character varying)'),
  ('public.dropgeometrycolumn(character varying,character varying,character varying)'),
  ('public.dropgeometrycolumn(character varying,character varying)'),
  ('public.dropgeometrytable(character varying,character varying,character varying)'),
  ('public.dropgeometrytable(character varying,character varying)'), ('public.dropgeometrytable(character varying)'),
  ('public.lockrow(text,text,text,text,timestamp without time zone)'), ('public.lockrow(text,text,text,text)'),
  ('public.lockrow(text,text,text)'), ('public.lockrow(text,text,text,timestamp without time zone)'),
  ('public.populate_geometry_columns(boolean)'), ('public.populate_geometry_columns(oid,boolean)'),
  ('public.postgis_extensions_upgrade()'),
  ('public.st_findextent(text,text,text)'), ('public.st_findextent(text,text)'),
  ('public.unlockrows(text)'),
  ('public.updategeometrysrid(character varying,character varying,character varying,character varying,integer)'),
  ('public.updategeometrysrid(character varying,character varying,character varying,integer)'),
  ('public.updategeometrysrid(character varying,character varying,integer)')),
pg_fn as (select s.sig, p.oid, p.proowner, p.prosecdef, p.prokind, p.pronamespace, p.proacl
            from pg_sig s join pg_proc p on p.oid = to_regprocedure(s.sig)),
pg_reason(r) as (
  select 'owner_role_supabase_admin_missing' from admin where oid is null and exists (select 1 from pg_ext)
  union all select 'extension_version:' || extversion from pg_ext where extversion is distinct from '3.3.7'
  union all select 'extension_owner:' || pg_get_userbyid(extowner) from pg_ext where extowner is distinct from (select oid from admin)
  union all select 'extension_schema:' || extnamespace::regnamespace::text from pg_ext where extnamespace is distinct from 'public'::regnamespace::oid
  union all select 'not_extension_member:' || f.sig from pg_fn f where not exists (select 1 from pg_depend d, pg_ext e
              where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.objsubid = 0 and d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid and d.deptype = 'e')
  union all select 'owner:' || f.sig || ':' || pg_get_userbyid(f.proowner) from pg_fn f where f.proowner is distinct from (select oid from admin)
  union all select 'security_definer:' || f.sig from pg_fn f where f.prosecdef
  union all select 'not_a_function:' || f.sig from pg_fn f where f.prokind <> 'f'
  union all select 'schema:' || f.sig from pg_fn f where f.pronamespace is distinct from (select extnamespace from pg_ext)
  union all select 'acl:' || f.sig || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type
    from pg_fn f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
   where not (a.grantee = f.proowner and a.grantor = f.proowner)
     and (a.grantor is distinct from (select oid from admin) or a.is_grantable or a.privilege_type <> 'EXECUTE'
          or not ((case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) = any (array['PUBLIC','postgres','anon','authenticated','service_role'])))
),
pg_allowed as (select f.oid from pg_fn f where exists (select 1 from pg_ext) and not exists (select 1 from pg_reason)),
-- ---- supabase_pg_net_access_event_trigger.v1 ----
et_pin as (select et.oid, et.evtevent, et.evttags, et.evtowner, et.evtfoid, p.proowner, p.prosecdef, l.lanname, p.prorettype
             from pg_event_trigger et left join pg_proc p on p.oid = et.evtfoid left join pg_language l on l.oid = p.prolang
            where et.evtname = 'issue_pg_net_access'),
et_reason(r) as (
  select 'owner_role_supabase_admin_missing' from admin where oid is null and exists (select 1 from et_pin)
  union all select 'event:' || evtevent from et_pin where evtevent is distinct from 'ddl_command_end'
  union all select 'tags:' || coalesce(array_to_string(evttags, ','), 'ALL') from et_pin where evttags is distinct from array['CREATE EXTENSION']::text[]
  union all select 'owner:' || pg_get_userbyid(evtowner) from et_pin where evtowner is distinct from (select oid from admin)
  union all select 'function:' || evtfoid::regprocedure::text from et_pin where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.oid = et_pin.evtfoid and n.nspname = 'extensions' and p.proname = 'grant_pg_net_access' and p.pronargs = 0)
  union all select 'function_owner:' || pg_get_userbyid(proowner) from et_pin where proowner is distinct from (select oid from admin)
  union all select 'function_security_definer' from et_pin where prosecdef
  union all select 'function_language:' || lanname from et_pin where lanname is distinct from 'plpgsql'
  union all select 'function_not_event_trigger' from et_pin where prorettype is distinct from 'pg_catalog.event_trigger'::regtype::oid
),
et_allowed as (select oid from et_pin where not exists (select 1 from et_reason)),
procs as (
  select p.oid, p.proname, p.pronamespace, p.prorettype, l.lanname, l.lanpltrusted,
         regexp_replace(p.prosrc, '--[^'||(select c from nl)||']*', '', 'g') src
    from pg_proc p join pg_language l on l.oid = p.prolang join pg_namespace pn on pn.oid = p.pronamespace
   where p.prokind in ('f','p') and pn.nspname not in ('pg_catalog','information_schema') and pn.nspname !~ '^pg_(toast|temp)'
),
leaf as (
  select pr.oid from procs pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'net'
      or exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                  where d.classid = 'pg_proc'::regclass and d.objid = pr.oid and d.refclassid = 'pg_extension'::regclass
                    and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
      or pr.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
      or (not pr.lanpltrusted and pr.lanname not in ('c','internal'))
      or (pr.lanname in ('sql','plpgsql') and pr.src ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)[[:space:]]*\(')
),
bad(oid) as (
  select oid from leaf
  union
  select caller.oid
    from bad b join procs callee on callee.oid = b.oid
    join procs caller on caller.lanname in ('sql','plpgsql') and caller.oid <> b.oid
         and length(callee.proname) > 2 and position(callee.proname in caller.src) > 0
         and caller.src ~* ('\m' || callee.proname || '[[:space:]]*\(')
)
-- (1) PUBLIC-executable functions reaching egress INDIRECTLY (own body is not a direct leaf)
select 'indirect_egress_function' kind, p.oid::regprocedure::text detail, null::text allowlisted_by
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog','information_schema','net') and p.prokind in ('f','p')
   and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
   and has_schema_privilege('public', n.oid, 'USAGE') and has_function_privilege('public', p.oid, 'EXECUTE')
   and p.oid in (select oid from bad) and p.oid not in (select oid from leaf)
   and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                      and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
union all
-- (2) PUBLIC-executable dynamic-SQL (plpgsql EXECUTE) functions (can reach net.* via PUBLIC's pg_net grants)
select 'dynamic_sql_function', p.oid::regprocedure::text,
       case when p.oid in (select oid from pg_allowed) then 'supabase_postgis_dynamic_sql.v1' end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
 where n.nspname not in ('pg_catalog','information_schema','net') and l.lanname in ('sql','plpgsql') and p.prokind in ('f','p')
   and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
   and has_schema_privilege('public', n.oid, 'USAGE') and has_function_privilege('public', p.oid, 'EXECUTE')
   and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                      and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
   and regexp_replace(p.prosrc, '--[^'||(select c from nl)||']*', '', 'g') ~* '\mexecute[[:space:]]'
union all
-- (3) triggers (incl. Supabase Database Webhooks supabase_functions.http_request / pg_net triggers) on a
--     PUBLIC-writable table whose function reaches egress
select 'egress_trigger', t.tgrelid::regclass::text || ':' || t.tgname || ' -> ' || t.tgfoid::regprocedure::text, null
  from pg_trigger t
 where not t.tgisinternal and t.tgfoid in (select oid from bad)
   and has_schema_privilege('public', (select c.relnamespace from pg_class c where c.oid = t.tgrelid), 'USAGE')
   and (has_table_privilege('public', t.tgrelid, 'INSERT') or has_table_privilege('public', t.tgrelid, 'UPDATE')
        or has_table_privilege('public', t.tgrelid, 'DELETE') or has_table_privilege('public', t.tgrelid, 'TRUNCATE'))
union all
-- (4) event triggers whose function reaches egress
select 'event_trigger_egress', 'event:' || et.evtname || ' -> ' || et.evtfoid::regprocedure::text,
       case when et.oid in (select oid from et_allowed) then 'supabase_pg_net_access_event_trigger.v1' end
  from pg_event_trigger et where et.evtfoid in (select oid from bad)
union all
-- (5) pg_cron reachable by PUBLIC: only through USAGE on schema cron (then also every cron.job / cron.* grant it makes usable)
select 'cron_schema_access', 'usage', null where to_regnamespace('cron') is not null and has_schema_privilege('public', 'cron', 'USAGE')
union all
select 'cron_schema_access', 'cron.job', null where to_regnamespace('cron') is not null and has_schema_privilege('public', 'cron', 'USAGE')
   and to_regclass('cron.job') is not null
   and (has_table_privilege('public','cron.job','SELECT') or has_table_privilege('public','cron.job','INSERT')
        or has_table_privilege('public','cron.job','UPDATE') or has_table_privilege('public','cron.job','DELETE'))
union all
select 'cron_schema_access', 'execute:' || p.oid::regprocedure::text, null
  from pg_proc p where to_regnamespace('cron') is not null and has_schema_privilege('public', 'cron', 'USAGE')
   and p.pronamespace = to_regnamespace('cron') and has_function_privilege('public', p.oid, 'EXECUTE')
union all
-- (6) owner-rights (security_invoker=false) views PUBLIC can SELECT that depend on an egress function
select 'egress_definer_view', format('%I.%I', n.nspname, c.relname), null
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1)', false) = false
   and has_schema_privilege('public', n.oid, 'USAGE') and has_table_privilege('public', c.oid, 'SELECT')
   and exists (select 1 from pg_depend d where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass
                and d.refobjid in (select oid from bad) and d.objid in (select oid from pg_rewrite where ev_class = c.oid))
union all
-- (7) an allowlist whose pins do not all hold: every failed pin (its objects above then carry allowlisted_by NULL)
select 'allowlist_not_applied', 'supabase_postgis_dynamic_sql.v1:' || r, null from pg_reason
union all
select 'allowlist_not_applied', 'supabase_pg_net_access_event_trigger.v1:' || r, null from et_reason
order by 1, 2;

-- NOTE on memberships: a new NOLOGIN NOINHERIT role is a member of nothing, so pg_execute_server_program /
-- pg_read_server_files / pg_write_server_files cannot reach it. After creation, the role self-check verifies this
-- (dangerous_role_membership). Nothing to check here against PUBLIC.
