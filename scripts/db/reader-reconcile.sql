-- LeadCommand reader links 1–5: READ-ONLY inventory of what production already holds, for reconciliation with the
-- reviewed files (scripts/db/reader-reconcile.mjs compares it with the inventory of a disposable database where those
-- files were applied). It reads catalog metadata only: names, attributes, ACLs, policy names, definition hashes, the
-- migration history's names. No table row is read, no secret, nothing is written.
--
-- Run it in a read-only session (psql: PGOPTIONS='-c default_transaction_read_only=on'; or any read-only SQL tool).
-- It returns ONE row with ONE jsonb value; save that value as a .json file.
with
fn_names(n) as (values
  -- link 1
  ('lc_mcp_reader_self_check'),('lc_mcp_operator_role'),('lc_mcp_ops_finding'),('lc_mcp_ops_research_valuation_snapshot'),
  ('lc_mcp_action_center'),('lc_mcp_thread_hold_status'),('lc_mcp_followup_intent_health'),
  ('lc_reachable_egress_indirect'),('lc_egress_platform_allowlists'),
  -- link 1 grants EXECUTE on these two existing reads
  ('campaign_entity_contact_review_flags'),('entity_graph_property_records'),
  -- links 2 and 5
  ('lc_mcp_lead_conversation'),('lc_mcp_conversation_worklist'),('lc_mcp_pipeline_counts'),('lc_mcp_conversation_signals'),
  -- link 3
  ('lc_mcp_corpus_census'),('lc_mcp_lead_screen'),
  -- link 4
  ('lc_mcp_thread_followups'),('lc_mcp_thread_execution_log'),('lc_mcp_thread_offers'),('lc_mcp_thread_contact_eligibility'),
  ('lc_mcp_operator_tasks')),
fns as (
  select p.oid::regprocedure::text as signature, p.proname as name,
         md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')) as def_md5,
         p.prosecdef as security_definer, p.provolatile as volatility, pg_get_userbyid(p.proowner) as owner,
         coalesce(p.proacl::text, '(default)') as acl,
         has_function_privilege('lc_mcp_reader', p.oid, 'EXECUTE') as reader_can_execute,
         coalesce(array_to_string(p.proconfig, ','), '') as config
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in (select n from fn_names)),
role as (
  select r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
         (select coalesce(jsonb_agg(m.rolname order by m.rolname), '[]') from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid) as member_of,
         (select coalesce(jsonb_agg(m.rolname order by m.rolname), '[]') from pg_auth_members a join pg_roles m on m.oid = a.member where a.roleid = r.oid) as members,
         (select coalesce(jsonb_agg(c order by c), '[]') from pg_db_role_setting s, unnest(s.setconfig) c where s.setrole = r.oid) as settings,
         shobj_description(r.oid, 'pg_authid') as comment
  from pg_roles r where r.rolname = 'lc_mcp_reader'),
tbl as (
  select c.relname, c.relkind::text as kind, c.relrowsecurity as rls,
         string_agg(distinct g.privilege_type, ',' order by g.privilege_type) as reader_privileges,
         bool_or(pol.polname is not null) as reader_policy
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name join pg_namespace s on s.oid = c.relnamespace and s.nspname = g.table_schema
  left join pg_policy pol on pol.polrelid = c.oid and pol.polname = 'lc_mcp_reader_select'
  where g.grantee = 'lc_mcp_reader'
  group by c.relname, c.relkind, c.relrowsecurity),
pols as (
  select c.relname, pol.polcmd::text as cmd, pol.polpermissive as permissive,
         (select coalesce(jsonb_agg(pg_get_userbyid(x) order by 1), '[]') from unnest(pol.polroles) x) as roles,
         pg_get_expr(pol.polqual, pol.polrelid) as using_expr
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where pol.polname = 'lc_mcp_reader_select' or (select oid from pg_roles where rolname = 'lc_mcp_reader') = any(pol.polroles)),
owned as (
  select c.relname from pg_class c where c.relowner = (select oid from pg_roles where rolname = 'lc_mcp_reader')),
mig as (
  select coalesce(jsonb_agg(jsonb_build_object('version', m.version, 'name', m.name) order by m.version), '[]') as rows
  from supabase_migrations.schema_migrations m
  where m.name ilike '%lc_mcp%' or m.name ilike '%reader%' or m.version in ('20261019150000','20261026120000','20261026150000','20261027130000','20261030120000'))
select jsonb_build_object(
  'inventory_version', 1,
  'taken_at', now(),
  'server_version', current_setting('server_version'),
  'database', current_database(),
  'role', (select to_jsonb(role) from role),
  'functions', (select coalesce(jsonb_agg(to_jsonb(fns) order by signature), '[]') from fns),
  'reader_table_privileges', (select coalesce(jsonb_agg(to_jsonb(tbl) order by relname), '[]') from tbl),
  'reader_policies', (select coalesce(jsonb_agg(to_jsonb(pols) order by relname), '[]') from pols),
  'objects_owned_by_reader', (select coalesce(jsonb_agg(relname order by relname), '[]') from owned),
  'migration_history', (select rows from mig),
  'reader_usage_on_public', has_schema_privilege('lc_mcp_reader', 'public', 'USAGE'),
  'reader_create_on_public', has_schema_privilege('lc_mcp_reader', 'public', 'CREATE')
) as reader_inventory;
