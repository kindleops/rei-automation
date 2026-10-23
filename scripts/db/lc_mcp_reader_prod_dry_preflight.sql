-- READ-ONLY DRY PREFLIGHT of PROPOSED_20261019150000_lc_mcp_reader.sql (release/lc-mcp-reader-1) for PRODUCTION.
-- NOT EXECUTED by any tool. The owner runs it with a ROLE-ENFORCED read-only credential (never one derived from an env
-- file), outside any migration session. It creates nothing, writes nothing, needs no TEMP, and is ONE SELECT statement.
--
-- WHAT IT PREDICTS: the outcome of the migration's apply, i.e. of its prerequisite block (section 1) and of
-- public.lc_mcp_reader_self_check(rels, fns, 'lc_mcp_reader') run at the end of the apply. lc_mcp_reader does not exist
-- yet, so every rule is computed for what the role WILL hold: it is NOLOGIN NOINHERIT and a member of no role, so it
-- inherits exactly PUBLIC's grants, PLUS the migration's planned grants (USAGE on public, SELECT on the 20 inventory
-- relations, EXECUTE on the 2 existing RPCs; the 7 lc_mcp_* functions it creates are judged by the migration tests and
-- reach no egress). The pg_net platform exception, the pinned platform allowlists and the corrected cron rule are
-- replicated pin for pin.
--
-- OUTPUT: section | item | verdict.  verdict:
--   BLOCKER     the apply would REFUSE on this (the self-check finding or the prerequisite error is named in item)
--   excepted:*  excepted by the pinned pg_net exception / a pinned platform allowlist (reported, never silent)
--   info        informational (also reported by the self-check, never a finding)
--   ok          a prerequisite that holds
--   BOOT_BLOCKER  not an apply blocker: the MCP server's boot exposure probe would refuse to start (fix before step 6)
-- The LAST row is `verdict | apply_would_pass | true/false`, with the number of BLOCKER rows.

with recursive
nl as (select chr(10) c),
admin as (select (select oid from pg_roles where rolname = 'supabase_admin') oid),
inv(name, optional) as (values
  ('acquisition_opportunities', false), ('campaign_target_graph', false), ('campaign_targets', false), ('campaigns', false),
  ('census_geo_metrics', true), ('eg_buyer_index', false), ('eg_property_facts', false), ('emails', false),
  ('inbox_thread_state', false), ('master_owners', false), ('mi_geo_period_rollup', false), ('mi_rollup_builds', false),
  ('mv_map_market_sales', false), ('phones', false), ('preforeclosure_status_v2', false), ('probate_status', false),
  ('properties', false), ('property_acquisition_scores', false), ('prospects', false), ('sms_suppression_list', false)),
inv_rel as (select c.oid from inv join pg_class c on c.oid = to_regclass(format('public.%I', inv.name))),
rpc(sig) as (values ('public.campaign_entity_contact_review_flags(text[])'), ('public.entity_graph_property_records(text)')),
rpc_oid as (select to_regprocedure(sig) oid from rpc where to_regprocedure(sig) is not null),
-- the role's planned reach: PUBLIC's grants + the migration's grants
r_usage as (select n.oid from pg_namespace n where has_schema_privilege('public', n.oid, 'USAGE') or n.nspname = 'public'),
-- ================================================ the pg_net platform exception (supabase_pg_net_default_acl.v1) ====
fp(k) as (values
  ('schema|net|PUBLIC|USAGE'),
  ('schema|net|postgres|USAGE'),
  ('schema|net|anon|USAGE'),
  ('schema|net|authenticated|USAGE'),
  ('schema|net|service_role|USAGE'),
  ('schema|net|supabase_functions_admin|USAGE'),
  ('table|net.http_request_queue|PUBLIC|SELECT'),
  ('table|net.http_request_queue|PUBLIC|INSERT'),
  ('table|net.http_request_queue|PUBLIC|UPDATE'),
  ('table|net.http_request_queue|PUBLIC|DELETE'),
  ('table|net.http_request_queue|PUBLIC|TRUNCATE'),
  ('table|net.http_request_queue|PUBLIC|REFERENCES'),
  ('table|net.http_request_queue|PUBLIC|TRIGGER'),
  ('table|net.http_request_queue|PUBLIC|MAINTAIN'),
  ('table|net._http_response|PUBLIC|SELECT'),
  ('table|net._http_response|PUBLIC|INSERT'),
  ('table|net._http_response|PUBLIC|UPDATE'),
  ('table|net._http_response|PUBLIC|DELETE'),
  ('table|net._http_response|PUBLIC|TRUNCATE'),
  ('table|net._http_response|PUBLIC|REFERENCES'),
  ('table|net._http_response|PUBLIC|TRIGGER'),
  ('table|net._http_response|PUBLIC|MAINTAIN'),
  ('sequence|net.http_request_queue_id_seq|PUBLIC|USAGE'),
  ('sequence|net.http_request_queue_id_seq|PUBLIC|SELECT'),
  ('sequence|net.http_request_queue_id_seq|PUBLIC|UPDATE'),
  ('function|net.http_get|PUBLIC|EXECUTE'),
  ('function|net.http_post|PUBLIC|EXECUTE'),
  ('function|net.http_delete|PUBLIC|EXECUTE'),
  ('function|net.http_get|postgres|EXECUTE'),
  ('function|net.http_get|anon|EXECUTE'),
  ('function|net.http_get|authenticated|EXECUTE'),
  ('function|net.http_get|service_role|EXECUTE'),
  ('function|net.http_get|supabase_functions_admin|EXECUTE'),
  ('function|net.http_post|postgres|EXECUTE'),
  ('function|net.http_post|anon|EXECUTE'),
  ('function|net.http_post|authenticated|EXECUTE'),
  ('function|net.http_post|service_role|EXECUTE'),
  ('function|net.http_post|supabase_functions_admin|EXECUTE'),
  ('function|net.http_delete|postgres|EXECUTE'),
  ('function|net.http_delete|anon|EXECUTE'),
  ('function|net.http_delete|authenticated|EXECUTE'),
  ('function|net.http_delete|service_role|EXECUTE'),
  ('function|net.http_delete|supabase_functions_admin|EXECUTE'),
  ('function|net._await_response|PUBLIC|EXECUTE'),
  ('function|net._urlencode_string|PUBLIC|EXECUTE'),
  ('function|net._encode_url_with_params_array|PUBLIC|EXECUTE'),
  ('function|net._http_collect_response|PUBLIC|EXECUTE'),
  ('function|net.http_collect_response|PUBLIC|EXECUTE'),
  ('function|net.worker_restart|PUBLIC|EXECUTE'),
  ('function|net.wait_until_running|PUBLIC|EXECUTE'),
  ('function|net.wake|PUBLIC|EXECUTE'),
  ('function|net.check_worker_is_up|PUBLIC|EXECUTE'),
  ('type|*|PUBLIC|USAGE')),
pgnet as (select e.oid, e.extowner, e.extversion from pg_extension e where e.extname = 'pg_net'),
net_obj as (
  select 'pg_namespace'::regclass cls, n.oid, 'schema'::text kind, 'net'::text name, n.nspowner own, n.nspacl acl, 'n'::"char" dk from pg_namespace n where n.nspname = 'net'
  union all select 'pg_class'::regclass, c.oid, case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized_view' when 'f' then 'foreign_table' else 'table' end,
                   'net.' || c.relname, c.relowner, c.relacl, case c.relkind when 'S' then 's' else 'r' end::"char"
              from pg_class c where c.relnamespace = to_regnamespace('net') and c.relkind in ('r','p','v','m','f','S')
  union all select 'pg_proc'::regclass, p.oid, 'function', 'net.' || p.proname, p.proowner, p.proacl, 'f'::"char" from pg_proc p where p.pronamespace = to_regnamespace('net')
  union all select 'pg_type'::regclass, t.oid, 'type', 'net.' || t.typname, t.typowner, t.typacl, 'T'::"char" from pg_type t where t.typnamespace = to_regnamespace('net')
  union all select 'pg_operator'::regclass, o.oid, 'operator', 'net.' || o.oprname, o.oprowner, null::aclitem[], null::"char" from pg_operator o where o.oprnamespace = to_regnamespace('net')
  union all select 'pg_collation'::regclass, o.oid, 'collation', 'net.' || o.collname, o.collowner, null, null from pg_collation o where o.collnamespace = to_regnamespace('net')
  union all select 'pg_conversion'::regclass, o.oid, 'conversion', 'net.' || o.conname, o.conowner, null, null from pg_conversion o where o.connamespace = to_regnamespace('net')
  union all select 'pg_opclass'::regclass, o.oid, 'operator_class', 'net.' || o.opcname, o.opcowner, null, null from pg_opclass o where o.opcnamespace = to_regnamespace('net')
  union all select 'pg_opfamily'::regclass, o.oid, 'operator_family', 'net.' || o.opfname, o.opfowner, null, null from pg_opfamily o where o.opfnamespace = to_regnamespace('net')
  union all select 'pg_ts_config'::regclass, o.oid, 'text_search_configuration', 'net.' || o.cfgname, o.cfgowner, null, null from pg_ts_config o where o.cfgnamespace = to_regnamespace('net')
  union all select 'pg_ts_dict'::regclass, o.oid, 'text_search_dictionary', 'net.' || o.dictname, o.dictowner, null, null from pg_ts_dict o where o.dictnamespace = to_regnamespace('net')
  union all select 'pg_statistic_ext'::regclass, o.oid, 'statistics', 'net.' || o.stxname, o.stxowner, null, null from pg_statistic_ext o where o.stxnamespace = to_regnamespace('net')),
net_acl as (
  select o.kind, o.name, a.grantor, a.is_grantable, o.kind || '|' || o.name || '|' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || '|' || a.privilege_type k,
         o.kind || '|' || case when o.kind = 'type' then '*' else o.name end || '|' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || '|' || a.privilege_type kfp
    from net_obj o cross join lateral aclexplode(coalesce(o.acl, acldefault(o.dk, o.own))) a
   where o.dk is not null and not (a.grantee = o.own and a.grantor = o.own)),
pe_reason(r) as (
  select 'owner_role_supabase_admin_missing' from admin where oid is null and to_regnamespace('net') is not null
  union all select 'extension_pg_net_missing' where to_regnamespace('net') is not null and not exists (select 1 from pgnet)
  union all select 'extension_owner:' || pg_get_userbyid(extowner) from pgnet where extowner is distinct from (select oid from admin)
  union all select 'owner:' || o.kind || ':' || o.name || ':' || pg_get_userbyid(o.own) from net_obj o where o.own is distinct from (select oid from admin)
  union all select 'not_extension_member:' || o.kind || ':' || o.name from net_obj o
   where not exists (select 1 from pg_depend d, pgnet e where d.classid = o.cls and d.objid = o.oid and d.objsubid = 0
                       and d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid and d.deptype = 'e')
  union all select 'acl_grantor:' || k || ':' || pg_get_userbyid(grantor) from net_acl where grantor is distinct from (select oid from admin)
  union all select 'acl_grant_option:' || k from net_acl where is_grantable
  union all select 'acl_outside_fingerprint:' || k from net_acl where kfp not in (select k from fp)
  union all select 'acl_outside_fingerprint:column|net.' || c.relname || '.' || a.attname from pg_class c join pg_attribute a on a.attrelid = c.oid
   where c.relnamespace = to_regnamespace('net') and a.attacl is not null and not a.attisdropped),
pe_applied as (select to_regnamespace('net') is not null and not exists (select 1 from pe_reason) ok),
pe_rel as (select o.oid from net_obj o where o.kind in ('table', 'sequence') and (select ok from pe_applied)),
pe_fn as (select o.oid from net_obj o where o.kind = 'function' and (select ok from pe_applied)),
auth_schemas as (
  select lower(btrim(item, ' "')) s from pg_db_role_setting drs cross join lateral unnest(drs.setconfig) c
         cross join lateral unnest(string_to_array(substr(c, length('pgrst.db_schemas=') + 1), ',')) item
   where drs.setrole = (select oid from pg_roles where rolname = 'authenticator')
     and drs.setdatabase in (0, (select oid from pg_database where datname = current_database())) and c like 'pgrst.db\_schemas=%'),
-- ======================================================== the pinned platform allowlists (§4b) ====
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
          or not ((case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) = any (array['PUBLIC','postgres','anon','authenticated','service_role'])))),
pg_allowed as (select f.oid from pg_fn f where exists (select 1 from pg_ext) and not exists (select 1 from pg_reason)),
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
  union all select 'function_not_event_trigger' from et_pin where prorettype is distinct from 'pg_catalog.event_trigger'::regtype::oid),
et_allowed as (select oid from et_pin where not exists (select 1 from et_reason)),
-- ======================================================== the indirect-egress call graph (the synced helper) ====
procs as (
  select p.oid, p.proname, p.pronamespace, p.prorettype, l.lanname, l.lanpltrusted,
         regexp_replace(p.prosrc, '--[^'||(select c from nl)||']*', '', 'g') src
    from pg_proc p join pg_language l on l.oid = p.prolang join pg_namespace pn on pn.oid = p.pronamespace
   where p.prokind in ('f','p') and pn.nspname not in ('pg_catalog','information_schema') and pn.nspname !~ '^pg_(toast|temp)'),
leaf as (
  select pr.oid from procs pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'net'
      or exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                  where d.classid = 'pg_proc'::regclass and d.objid = pr.oid and d.refclassid = 'pg_extension'::regclass
                    and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
      or pr.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
      or (not pr.lanpltrusted and pr.lanname not in ('c','internal'))
      or (pr.lanname in ('sql','plpgsql') and pr.src ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)[[:space:]]*\(')),
bad(oid) as (
  select oid from leaf
  union
  select caller.oid
    from bad b join procs callee on callee.oid = b.oid
    join procs caller on caller.lanname in ('sql','plpgsql') and caller.oid <> b.oid
         and length(callee.proname) > 2 and position(callee.proname in caller.src) > 0
         and caller.src ~* ('\m' || callee.proname || '[[:space:]]*\(')),
-- functions the role will be able to execute: PUBLIC's + the 2 planned RPC grants, in a schema it can use
r_exec as (select p.oid from pg_proc p where p.pronamespace in (select oid from r_usage)
             and (has_function_privilege('public', p.oid, 'EXECUTE') or p.oid in (select oid from rpc_oid))),
-- relations the role will be able to SELECT
r_select as (select c.oid from pg_class c where c.relkind in ('r','p','v','m','f') and c.relnamespace in (select oid from r_usage)
               and (has_table_privilege('public', c.oid, 'SELECT') or c.oid in (select oid from inv_rel))),
pub as (select oid from pg_namespace where nspname = 'public'),
-- the MCP boot probe's GraphQL leg, for the role's privilege set (PUBLIC's; the migration grants nothing on GraphQL).
-- /graphql/v1 = PostgREST POST /rpc/graphql (Content-Profile graphql_public) AS the role. The probe accepts exactly two
-- GraphQL answers: "Unknown field" for net's tables (the resolver runs and does not reflect net), or PostgREST's 42501
-- (HTTP 403) "permission denied for schema graphql_public" / "permission denied for function graphql" (the role cannot
-- execute the resolver at all: no GraphQL, nothing to reflect) -> refused_no_graphql_access. Catalog lookups only.
gql as (
  select gp.oid gp, has_schema_privilege('public', gp.oid, 'USAGE') gp_usage,
         (select p.oid from pg_proc p where p.pronamespace = gp.oid and p.proname = 'graphql' and p.proargtypes = '25 25 3802 3802'::oidvector) rp,
         gi.oid gi, has_schema_privilege('public', gi.oid, 'USAGE') gi_usage,
         exists (select 1 from pg_proc p where p.pronamespace = gi.oid and p.proname = 'resolve' and not has_function_privilege('public', p.oid, 'EXECUTE')) gi_resolve_denied
    from (select to_regnamespace('graphql_public') oid) gp cross join (select to_regnamespace('graphql') oid) gi),
gql_case as (
  select case when gp is null then 'no_schema' when not gp_usage then 'no_usage' when rp is null then 'no_resolver'
              when not has_function_privilege('public', rp, 'EXECUTE') then 'no_execute'
              when gi is not null and (not gi_usage or gi_resolve_denied) then 'inner_denied' else 'runs' end k
    from gql),
res(section, item, verdict) as (
  -- ---------------------------------------------------------------- 1. prerequisites (section 1 of the file) ----
  select 'prerequisite', 'role authenticator', case when exists (select 1 from pg_roles where rolname = 'authenticator') then 'ok' else 'BLOCKER' end
  union all
  select 'prerequisite', 'relation public.' || inv.name || coalesce(' (' || c.relkind::text || ', owner ' || pg_get_userbyid(c.relowner) || ')', ' (absent)'),
         case when c.oid is null then case when inv.optional then 'info' else 'BLOCKER' end
              when c.relkind not in ('r','p','v','m','f') then 'BLOCKER'
              when c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ','), '') ~* '(^|,)security_invoker=(true|on|yes|1)(,|$)' then 'BLOCKER'
              -- GRANT SELECT / CREATE POLICY need the owner: the apply runs as postgres
              when pg_get_userbyid(c.relowner) <> 'postgres' then 'BLOCKER'
              else 'ok' end
    from inv left join pg_class c on c.oid = to_regclass(format('public.%I', inv.name))
  union all
  select 'prerequisite', 'agent.operator_membership(org_id, user_id, role)' || coalesce(' role type ' || (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
           where a.attrelid = (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relname = 'operator_membership') and a.attname = 'role' and not a.attisdropped), ''),
         case when (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relname = 'operator_membership') is null then 'BLOCKER'
              -- lc_mcp_operator_role is LANGUAGE sql: under check_function_bodies = on its CREATE parses these columns
              when (select count(*) from pg_attribute a where a.attrelid = (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relname = 'operator_membership') and not a.attisdropped
                      and a.attname in ('org_id', 'user_id', 'role')) <> 3 then 'BLOCKER'
              else 'ok' end
  union all
  select 'prerequisite', 'rpc ' || rpc.sig || coalesce(' (volatility ' || p.provolatile::text || ', definer ' || p.prosecdef::text || ', owner ' || pg_get_userbyid(p.proowner) || ')', ' (absent)'),
         case when p.oid is null or p.provolatile = 'v' or pg_get_userbyid(p.proowner) <> 'postgres' then 'BLOCKER' else 'ok' end
    from rpc left join pg_proc p on p.oid = to_regprocedure(rpc.sig)
  union all
  select 'prerequisite', 'role lc_mcp_reader ' || case when r.oid is null then 'absent (will be created NOLOGIN NOINHERIT)' else 'exists' end,
         case when r.oid is null then 'ok'
              when r.rolcanlogin or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls then 'BLOCKER'
              else 'info' end
    from (select 1) one left join pg_roles r on r.rolname = 'lc_mcp_reader'
  union all
  select 'prerequisite', 'check_function_bodies = ' || current_setting('check_function_bodies') || ' (the 5 operations functions are plpgsql: their sources are read at CALL time)', 'info'
  union all
  select 'prerequisite', 'server_version_num = ' || current_setting('server_version_num'), 'info'
  union all
  -- the opt-in operations sources: absent -> the MCP tool answers "unavailable" at call time, never a failed apply
  select 'optional_source', s.n || case when s.present then ' present' else ' ABSENT -> tool ' || s.tool || ' answers unavailable' end, 'info'
    from (values ('agent.finding', (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relname = 'finding') is not null, 'get_ops_supervisor_status'),
                 ('agent.ops_research_valuation_snapshot(timestamptz)', (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'agent' and p.proname = 'ops_research_valuation_snapshot' and p.pronargs = 1) is not null, 'get_ops_supervisor_status'),
                 ('agent.conversation_action_state', (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relname = 'conversation_action_state') is not null, 'search_action_center'),
                 ('public.automation_hold_for(text,uuid,text,uuid,text,text)', to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is not null, 'get_thread_hold_status'),
                 ('public.v_followup_intent_health', to_regclass('public.v_followup_intent_health') is not null, 'get_followup_intent_health'),
                 ('public.v_followup_intent_reasons', to_regclass('public.v_followup_intent_reasons') is not null, 'get_followup_intent_health')) s(n, present, tool)
  -- ------------------------------------------------------------------------- 2. the pg_net platform exception ----
  union all
  select 'platform_exception', 'supabase_pg_net_default_acl.v1 ' || case when (select ok from pe_applied) then 'applied'
           when to_regnamespace('net') is null then 'not present' else 'NOT applied' end,
         case when (select ok from pe_applied) or to_regnamespace('net') is null then 'info' else 'BLOCKER' end
  union all
  select 'platform_exception', 'reason ' || r, 'BLOCKER' from pe_reason
  union all
  select 'platform_exception', 'control b: pgrst.db_schemas ' || case when exists (select 1 from auth_schemas) then 'set in SQL' else 'unset in SQL (dashboard holds it; the boot probe proves it)' end, 'info'
  union all
  select 'platform_exception', 'control b: exposed schema ' || s, 'BLOCKER' from auth_schemas where s in ('net', 'extensions', 'cron') and (select ok from pe_applied)
  -- --------------------------------------------------------------------- 3. the self-check findings (as the role) ----
  union all
  select 'write_privileges', format('%I.%I', n.nspname, c.relname), 'BLOCKER'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)'
     and n.oid in (select oid from r_usage) and c.oid not in (select oid from pe_rel)
     and case when c.relkind in ('r','p','v','m','f') then has_table_privilege('public', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              or (current_setting('server_version_num')::int >= 170000 and has_table_privilege('public', c.oid, 'MAINTAIN'))
              or has_any_column_privilege('public', c.oid, 'INSERT,UPDATE,REFERENCES') else false end
  union all
  select 'write_privileges', format('%I.%I', n.nspname, c.relname) || ' (pg_net platform object)', 'excepted:supabase_pg_net_default_acl.v1'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid in (select oid from pe_rel)
  union all
  select 'sequence_privileges', format('%I.%I', n.nspname, c.relname), 'BLOCKER'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'S' and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp)'
     and n.oid in (select oid from r_usage) and c.oid not in (select oid from pe_rel)
     and case when c.relkind = 'S' then has_sequence_privilege('public', c.oid, 'USAGE,UPDATE') else false end
  union all
  select 'schema_create', n.nspname::text, 'BLOCKER' from pg_namespace n where n.nspname !~ '^pg_(toast|temp)' and has_schema_privilege('public', n.oid, 'CREATE')
  union all
  select 'database_create', current_database()::text, 'BLOCKER' where has_database_privilege('public', current_database(), 'CREATE')
  union all
  select 'database_temp', current_database()::text, 'info' where has_database_privilege('public', current_database(), 'TEMP')
  union all
  select 'reachable_definer_functions', p.oid::regprocedure::text,
         case when p.proname = 'st_estimatedextent' and p.provolatile in ('s','i') then 'info' else 'BLOCKER' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and p.prokind in ('f','p') and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     and n.nspname not in ('pg_catalog','information_schema') and p.oid in (select oid from r_exec) and p.oid not in (select oid from rpc_oid)
  union all
  select 'reachable_egress_functions', p.oid::regprocedure::text,
         case when p.oid in (select oid from pe_fn) then 'excepted:supabase_pg_net_default_acl.v1' else 'BLOCKER' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
   where p.prokind in ('f','p') and n.nspname not in ('pg_catalog','information_schema')
     and p.oid in (select oid from r_exec) and p.oid not in (select oid from rpc_oid)
     and (exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                   where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                     and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
          or n.nspname = 'net' or p.proname ~* '^(http|http_[a-z_]+|dblink[a-z_]*)$'
          or (not l.lanpltrusted and l.lanname not in ('c','internal'))
          or (l.lanname in ('sql','plpgsql') and p.prosrc ~* '\m(net\.http_[a-z_]+|http_(get|post|put|patch|delete|head|request)|dblink[a-z_]*|lo_(create|creat|from_bytea|put|import|export|unlink)|lowrite|pg_notify|pg_logical_emit_message)\s*\('))
  union all
  select 'exposed_select_outside_inventory', format('%I.%I', n.nspname, c.relname),
         case when n.nspname = 'public' and c.relname in ('spatial_ref_sys','geometry_columns','geography_columns','raster_columns','raster_overviews') then 'info' else 'BLOCKER' end
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid in (select oid from r_select) and n.nspname in ('public','graphql_public') and c.oid not in (select oid from inv_rel)
  union all
  select 'select_outside_inventory', count(*)::text || ' relation(s) PUBLIC can read outside the inventory (any schema the role can use; informational)', 'info'
    from r_select s join pg_class c on c.oid = s.oid where c.oid not in (select oid from inv_rel)
  union all
  select 'relations', 'public.' || c.relname || ': restrictive policy applying to PUBLIC', 'BLOCKER'
    from pg_class c join pg_policy p on p.polrelid = c.oid where c.oid in (select oid from inv_rel) and not p.polpermissive and p.polcmd in ('r','*') and 0::oid = any (p.polroles)
  -- ---------------------------------------------------------- 4. indirect egress (public.lc_reachable_egress_indirect) ----
  union all
  select 'indirect_egress_function', p.oid::regprocedure::text, 'BLOCKER'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog','information_schema','net') and p.prokind in ('f','p')
     and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     and p.oid in (select oid from r_exec) and p.oid in (select oid from bad) and p.oid not in (select oid from leaf)
     and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                        and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
  union all
  select 'dynamic_sql_function', p.oid::regprocedure::text,
         case when p.oid in (select oid from pg_allowed) then 'excepted:supabase_postgis_dynamic_sql.v1' else 'BLOCKER' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
   where n.nspname not in ('pg_catalog','information_schema','net') and l.lanname in ('sql','plpgsql') and p.prokind in ('f','p')
     and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     and p.oid in (select oid from r_exec)
     and not exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass
                        and d.deptype = 'e' and e.extname in ('pg_net','http','dblink','postgres_fdw'))
     and regexp_replace(p.prosrc, '--[^'||(select c from nl)||']*', '', 'g') ~* '\mexecute[[:space:]]'
  union all
  select 'egress_trigger', t.tgrelid::regclass::text || ':' || t.tgname || ' -> ' || t.tgfoid::regprocedure::text, 'BLOCKER'
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and t.tgfoid in (select oid from bad) and c.relnamespace in (select oid from r_usage)
     and (has_table_privilege('public', t.tgrelid, 'INSERT') or has_table_privilege('public', t.tgrelid, 'UPDATE')
          or has_table_privilege('public', t.tgrelid, 'DELETE') or has_table_privilege('public', t.tgrelid, 'TRUNCATE'))
  union all
  select 'event_trigger_egress', 'event:' || et.evtname || ' -> ' || et.evtfoid::regprocedure::text,
         case when et.oid in (select oid from et_allowed) then 'excepted:supabase_pg_net_access_event_trigger.v1' else 'BLOCKER' end
    from pg_event_trigger et where et.evtfoid in (select oid from bad)
  union all
  select 'cron_schema_access', 'usage on schema cron', 'BLOCKER' where to_regnamespace('cron') is not null and has_schema_privilege('public', to_regnamespace('cron'), 'USAGE')
  union all
  select 'cron_schema_access', 'cron.job ' || string_agg(pv, '+') || ' via PUBLIC without USAGE on cron (unreachable: not a finding)', 'info'
    from unnest(array['SELECT','INSERT','UPDATE','DELETE']) pv cross join (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'cron' and c.relname = 'job') j(oid)
   where j.oid is not null and not has_schema_privilege('public', to_regnamespace('cron'), 'USAGE') and has_table_privilege('public', j.oid, pv)
  having count(*) > 0
  union all
  select 'egress_definer_view', format('%I.%I', n.nspname, c.relname), 'BLOCKER'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1)', false) = false
     and c.oid in (select oid from r_select)
     and exists (select 1 from pg_depend d where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass
                  and d.refobjid in (select oid from bad) and d.objid in (select oid from pg_rewrite where ev_class = c.oid))
  -- ------------------------------------------------------- 4b. the MCP BOOT probe (not the apply; docs §9 step 5) ----
  union all
  select 'boot_probe', case k
           when 'no_usage' then 'graphql_public USAGE for PUBLIC = false: the reader cannot execute the GraphQL resolver; PostgREST answers 42501 "permission denied for schema graphql_public" (HTTP 403), which the boot probe accepts as refused_no_graphql_access (no GraphQL for the role, nothing to reflect). REST must still answer PGRST106'
           when 'no_execute' then 'graphql_public USAGE for PUBLIC = true, EXECUTE on graphql_public.graphql(text,text,jsonb,jsonb) = false: PostgREST answers 42501 "permission denied for function graphql" (HTTP 403), which the boot probe accepts as refused_no_graphql_access. REST must still answer PGRST106'
           when 'runs' then 'graphql_public USAGE + resolver EXECUTE for PUBLIC = true: the resolver runs AS the reader; the boot probe requires "Unknown field" for net''s tables (net stays off the reader''s search_path, control (d)) and refuses any other answer'
           when 'no_schema' then 'no schema graphql_public: /graphql/v1 has no resolver, the boot probe gets neither accepted GraphQL answer and REFUSES the start'
           when 'no_resolver' then 'graphql_public USAGE for PUBLIC = true but no graphql_public.graphql(text,text,jsonb,jsonb): PostgREST answers PGRST202, the boot probe REFUSES the start'
           else 'graphql_public USAGE + resolver EXECUTE for PUBLIC = true but PUBLIC cannot use pg_graphql''s schema graphql / graphql.resolve: the resolver RUNS as the reader and fails inside (42501 on schema graphql / function resolve), which the boot probe REFUSES'
         end, case when k in ('no_usage', 'no_execute', 'runs') then 'info' else 'BOOT_BLOCKER' end
    from gql_case
  -- ------------------------------------------------------------------------------ 5. the platform allowlists ----
  union all
  select 'platform_allowlist', 'supabase_postgis_dynamic_sql.v1 ' || case when not exists (select 1 from pg_ext) then 'not present'
           when exists (select 1 from pg_reason) then 'NOT applied' else 'applied (' || (select count(*) from pg_fn) || ' pinned signatures present)' end, 'info'
  union all
  select 'platform_allowlist', 'supabase_postgis_dynamic_sql.v1 pin failed: ' || r, 'info' from pg_reason
  union all
  select 'platform_allowlist', 'supabase_postgis_dynamic_sql.v1 pinned signature absent: ' || s.sig, 'info'
    from pg_sig s where exists (select 1 from pg_ext) and to_regprocedure(s.sig) is null
  union all
  select 'platform_allowlist', 'supabase_postgis_dynamic_sql.v1 unpinned overload of a pinned name (stays a finding if it runs EXECUTE): ' || p.oid::regprocedure::text, 'info'
    from pg_proc p where p.pronamespace = (select extnamespace from pg_ext)
     and p.proname in ('addgeometrycolumn','checkauth','disablelongtransactions','dropgeometrycolumn','dropgeometrytable','enablelongtransactions','lockrow',
                       'populate_geometry_columns','postgis_extensions_upgrade','st_findextent','unlockrows','updategeometrysrid')
     and p.oid not in (select oid from pg_fn)
  union all
  select 'platform_allowlist', 'supabase_pg_net_access_event_trigger.v1 ' || case when not exists (select 1 from et_pin) then 'not present'
           when exists (select 1 from et_reason) then 'NOT applied' else 'applied' end, 'info'
  union all
  select 'platform_allowlist', 'supabase_pg_net_access_event_trigger.v1 pin failed: ' || r, 'info' from et_reason
)
select section, item, verdict from (
  select section, item, verdict from res
  union all
  select 'verdict', 'apply_would_pass', (count(*) filter (where verdict = 'BLOCKER') = 0)::text || ' (' || count(*) filter (where verdict = 'BLOCKER') || ' BLOCKER rows)' from res) z
order by section = 'verdict', section, verdict, item;
