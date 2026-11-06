// The migration chain the agntei Action Gateway service runs on, in apply order, as the disposable-PostgreSQL proof
// applies it (traced from tests/critical/action-gateway-service-principal-pg.test.mjs on PostgreSQL 17).
// kind: 'migration' = a production migration (owner applies it, in this order, each with its own approval);
//       'baseline'  = a TEST stand-in for relations production already has (never applied to production);
//       'pretest'   = the read-only check run right before its migration.
export const CHAIN = [
  { kind: 'baseline', file: 'apps/api/tests/pg/supabase-shim.sql' },
  { kind: 'migration', file: 'apps/api/supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql' },
  { kind: 'pretest', file: 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence_pretest.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql' },
  { kind: 'pretest', file: 'supabase/migrations/PROPOSED_20261010130000_agent_research_ro_pretest.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261010130000_agent_research_ro.sql' },
  { kind: 'baseline', file: 'scripts/db/fixtures/send_queue_live_baseline.sql' },
  { kind: 'baseline', file: 'scripts/db/fixtures/operations_public_baseline.sql' },
  { kind: 'baseline', file: 'scripts/db/fixtures/automation_holds_public_baseline.sql' },
  { kind: 'baseline', file: 'scripts/db/fixtures/legacy_conversation_turns_baseline.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261012140000_intel_runtime.sql' },
  // payload_clean_opaque_ids replaces one function body and requires only agent_s3_persistence (its header). Production
  // (read-only review 2026-11-06) carries agent_research_ro and intel_runtime without it, so it follows them here.
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261019120000_payload_clean_opaque_ids.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261013161000_conversation_decide_event_budget.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261013160000_conversation_ai_shadow.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261014120000_persistent_missions.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261016140000_operations_action_center.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261017122000_conversation_turn_operator_items.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261016200000_automation_holds_registry.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261016120000_conversation_reply_turns.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261015130000_message_origin_ai_generated_messages.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261015190000_negotiation_authority.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261016161000_negotiation_send_authorization.sql' },
  { kind: 'baseline', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_baseline.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261017120000_followup_intent_lifecycle.sql' },
  { kind: 'baseline', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql' },
  { kind: 'baseline', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t34_baseline.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261019160000_action_gateway.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261020100000_action_gateway_t2.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261027120000_action_gateway_ohg.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261028100000_action_gateway_standing_reply.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261029090000_ai_generated_outbound.sql' },
  { kind: 'baseline', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_agent_message_baseline.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261029100000_action_gateway_agent_message.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261101120000_record_sync.sql' },
  { kind: 'baseline', file: 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_service_principals_baseline.sql' },
  { kind: 'migration', file: 'supabase/migrations/PROPOSED_20261105120000_action_gateway_service_principals.sql' },
]

// The catalog fingerprint: every object a migration can add, with a body hash for functions. Read-only.
export const SNAPSHOT_SQL = `
select 'table' as kind, n.nspname||'.'||c.relname as name, c.relkind::text as detail from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','v','m','p') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
union all select 'column', table_schema||'.'||table_name||'.'||column_name, data_type from information_schema.columns where table_schema not in ('pg_catalog','information_schema')
union all select 'function', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
union all select 'schema', nspname, '' from pg_namespace where nspname not like 'pg_%' and nspname<>'information_schema'
union all select 'policy', schemaname||'.'||tablename||'.'||policyname, cmd from pg_policies
union all select 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, '' from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal
union all select 'index', schemaname||'.'||indexname, '' from pg_indexes where schemaname not in ('pg_catalog')
union all select 'role', rolname, '' from pg_roles where rolname not like 'pg_%'`
