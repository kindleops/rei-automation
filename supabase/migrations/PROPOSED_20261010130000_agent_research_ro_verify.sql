-- PROPOSED ONLY — READ-ONLY verification after applying
--   PROPOSED_20261010120000_agent_s3_persistence.sql  and
--   PROPOSED_20261010130000_agent_research_ro.sql
-- Every row must say ok = true. Safe to run any time (selects only).
with t as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c where c.relnamespace = 'agent'::regnamespace and c.relkind = 'r'
)
select 'agent tables = 18 (13 S3 + public_execute_revoked + 4 research)' as check, (select count(*) from t) = 18 as ok, (select count(*) from t)::text as detail
union all select 'every agent table: RLS enabled + forced', (select bool_and(relrowsecurity and relforcerowsecurity) from t), (select string_agg(relname, ',') from t where not (relrowsecurity and relforcerowsecurity))
union all select 'store_head = (0,0) or advanced by runs', (select count(*) = 1 from agent.store_head), null
union all select 'LeadCommand org row present', exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001'), null
union all select 'runtime_limits.max_active_research_jobs = 2', (select max_active_research_jobs = 2 from agent.runtime_limits), null
union all select 'payload_is_clean refuses a phone', agent.payload_is_clean('{"x":"612-555-0147"}') = false, null
union all select 'S3 triggers present (5)', (select count(*) = 5 from pg_trigger where not tgisinternal and tgname in ('run_event_guard_ins','run_event_guard_mut','run_event_no_truncate','run_research_slot_guard','finding_actor_guard')), null
union all select 'research triggers present (6)', (select count(*) = 6 from pg_trigger where not tgisinternal and tgname in ('spend_ledger_guard_ins','spend_ledger_guard_upd','research_audit_guard_ins','research_audit_guard_mut','research_run_guard_mut','research_limits_guard_mut')), null
union all select 'actor columns NOT NULL (run_event, finding)', (select count(*) = 2 from information_schema.columns where table_schema = 'agent' and column_name = 'actor_user_id' and table_name in ('run_event','finding') and is_nullable = 'NO'), null
union all select 'CHECK run_operator_named + research_run_operator_named', (select count(*) = 2 from pg_constraint where conname in ('run_operator_named','research_run_operator_named')), null
union all select 'research_limits: spend OFF until the owner flips it', (select enabled = false from agent.research_limits), (select format('enabled=%s day=%s cycle=%s run=%s esc_calls=%s esc_usd=%s', enabled, day_usd, cycle_usd, run_usd, escalation_calls_per_run, escalation_usd_per_run) from agent.research_limits)
union all select 'research_limits ceilings: day ≤ 10, cycle ≤ 150, run ≤ 2.50, ≤ 2 escalations, ≤ $2', (select day_usd <= 10 and cycle_usd <= 150 and run_usd <= 2.5 and escalation_calls_per_run <= 2 and escalation_usd_per_run <= 2 from agent.research_limits), null
union all select 'anon: no USAGE on schema agent', not has_schema_privilege('anon', 'agent', 'USAGE'), null
union all select 'anon / authenticated: no privilege on research tables or the ledger', not exists (
    select 1 from unnest(array['anon','authenticated']) r, unnest(array['agent.research_limits','agent.research_run','agent.research_audit','agent.spend_ledger']) tb, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
    where has_table_privilege(r, tb, p)), null
union all select 'agent_api role: NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB', (select not (rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb) from pg_roles where rolname = 'agent_api'), null
union all select 'agent_api owns nothing', not exists (select 1 from pg_class where relowner = (select oid from pg_roles where rolname = 'agent_api')), null
union all select 'agent_api: no DELETE anywhere in agent', not exists (select 1 from t where has_table_privilege('agent_api', 'agent.' || t.relname, 'DELETE')), null
union all select 'agent_api: cannot UPDATE research_limits / research_audit', not has_table_privilege('agent_api', 'agent.research_limits', 'UPDATE') and not has_table_privilege('agent_api', 'agent.research_audit', 'UPDATE'), null
union all select 'no agent function executable by PUBLIC / anon', not exists (select 1 from pg_proc p where p.pronamespace = 'agent'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE'))), null
union all select 'authenticated may execute only can_read_org', (select coalesce(string_agg(p.proname, ','), '') = 'can_read_org' from pg_proc p where p.pronamespace = 'agent'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE')), (select string_agg(p.proname, ',') from pg_proc p where p.pronamespace = 'agent'::regnamespace and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
union all select 'pg_graphql not installed (agent cannot be exposed through GraphQL)', not exists (select 1 from pg_extension where extname = 'pg_graphql'), null
union all select 'idempotency_ledger: agent_api scoped policy present', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'idempotency_ledger' and policyname = 'idempotency_ledger_agent_api_scope'), null
union all select 'no research spend recorded yet', (select count(*) = 0 from agent.spend_ledger), (select count(*)::text from agent.spend_ledger);
-- MANUAL (cannot be read through SQL): Supabase dashboard → Settings → API → Exposed schemas
-- must NOT contain "agent" (default: public, graphql_public).
