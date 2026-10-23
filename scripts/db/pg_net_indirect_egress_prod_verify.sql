-- READ-ONLY production verification of the INDIRECT / transitive egress surface (docs/SUPABASE-PG-NET-POSTURE.md §9a).
-- NOT EXECUTED by any tool. The owner runs it with a ROLE-ENFORCED read-only credential (never one derived from an
-- env file), never inside a migration session, BEFORE authorizing the lc_mcp_reader / lc_action_gateway applies.
--
-- WHY grantee PUBLIC: both roles are NOLOGIN NOINHERIT and members of nothing, so the ONLY grants they inherit are
-- PUBLIC's. Everything PUBLIC can reach, the new roles can too. This query computes, for the PUBLIC pseudo-role, the
-- SAME findings public.lc_reachable_egress_indirect(oid) computes for the role — the floor that exists even before the
-- roles do. (After an authorized apply, re-run the role's own self-check / boot probe; see §9 step 7.)
--
-- EXPECTED: zero rows, except possibly the pg_net platform's OWN helpers in schema net (which the pinned exception
-- covers and which this query already excludes as roots). ANY other row is a real indirect-egress path the owner must
-- remediate (revoke the PUBLIC grant, drop the wrapper / trigger / webhook, lock the schema) before go-live. In
-- particular a `dynamic_sql_function:` row (e.g. a PUBLIC-executable raw-SQL helper such as public.run_sql) or an
-- `egress_trigger:` row (a Supabase Database Webhook / pg_net trigger) is a blocker.

with recursive
nl as (select chr(10) c),
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
select 'indirect_egress_function' kind, p.oid::regprocedure::text detail
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
select 'dynamic_sql_function', p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
 where n.nspname not in ('pg_catalog','information_schema','net') and l.lanname in ('sql','plpgsql') and p.prokind in ('f','p')
   and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
   and has_schema_privilege('public', n.oid, 'USAGE') and has_function_privilege('public', p.oid, 'EXECUTE')
   and regexp_replace(p.prosrc, '--[^'||(select c from nl)||']*', '', 'g') ~* '\mexecute[[:space:]]'
union all
-- (3) triggers (incl. Supabase Database Webhooks supabase_functions.http_request / pg_net triggers) on a
--     PUBLIC-writable table whose function reaches egress
select 'egress_trigger', t.tgrelid::regclass::text || ':' || t.tgname || ' -> ' || t.tgfoid::regprocedure::text
  from pg_trigger t
 where not t.tgisinternal and t.tgfoid in (select oid from bad)
   and has_schema_privilege('public', (select c.relnamespace from pg_class c where c.oid = t.tgrelid), 'USAGE')
   and (has_table_privilege('public', t.tgrelid, 'INSERT') or has_table_privilege('public', t.tgrelid, 'UPDATE')
        or has_table_privilege('public', t.tgrelid, 'DELETE') or has_table_privilege('public', t.tgrelid, 'TRUNCATE'))
union all
-- (4) event triggers whose function reaches egress
select 'event_trigger_egress', 'event:' || et.evtname || ' -> ' || et.evtfoid::regprocedure::text
  from pg_event_trigger et where et.evtfoid in (select oid from bad)
union all
-- (5) pg_cron reachable by PUBLIC
select 'cron_schema_access', 'usage' where to_regnamespace('cron') is not null and has_schema_privilege('public', 'cron', 'USAGE')
union all
select 'cron_schema_access', 'cron.job' where to_regclass('cron.job') is not null
   and (has_table_privilege('public','cron.job','SELECT') or has_table_privilege('public','cron.job','INSERT')
        or has_table_privilege('public','cron.job','UPDATE') or has_table_privilege('public','cron.job','DELETE'))
union all
-- (6) owner-rights (security_invoker=false) views PUBLIC can SELECT that depend on an egress function
select 'egress_definer_view', format('%I.%I', n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'v' and coalesce(array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1)', false) = false
   and has_schema_privilege('public', n.oid, 'USAGE') and has_table_privilege('public', c.oid, 'SELECT')
   and exists (select 1 from pg_depend d where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass
                and d.refobjid in (select oid from bad) and d.objid in (select oid from pg_rewrite where ev_class = c.oid))
order by 1, 2;

-- NOTE on memberships: a new NOLOGIN NOINHERIT role is a member of nothing, so pg_execute_server_program /
-- pg_read_server_files / pg_write_server_files cannot reach it. After creation, the role self-check verifies this
-- (dangerous_role_membership). Nothing to check here against PUBLIC.
