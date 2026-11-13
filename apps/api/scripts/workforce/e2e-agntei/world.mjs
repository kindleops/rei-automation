// The disposable database of the milestone E2E: ONE database on the run's own PostgreSQL 17 cluster, with the REAL
// schema chain (the same files, in the same order, as the PG proofs: tests/helpers/action-gateway-t34-pg.mjs and
// tests/helpers/workforce-agntei-pg.mjs):
//   supabase shim (roles, auth.uid(); test only) → S3 persistence + opaque ids → research_ro → R2 intel_runtime (+ kind limits)
//   → capabilities, conversation-AI shadow, persistent missions, operations action center, holds registry, reply turns,
//   negotiation authority → the Action Gateway #26 → the follow-up lifecycle → #27 (T2) → #28 (T3/T4)
//   → workforce_foundation → the Workforce seed (psql, owner = the CEO user) → workforce_agntei.
// The *_baseline.sql files and the small public fixtures are the TEST stand-ins for production public tables the
// migrations read (labelled in the report).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'

const RUNTIME_PUBLIC_FIXTURE = `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`
const AUTOMATION_EVENTS_FIXTURE = `create table if not exists public.automation_events (id uuid primary key default gen_random_uuid(), event_type text, source text,
  conversation_thread_id text, payload jsonb, dedupe_key text, created_at timestamptz default now());`
const CONVERSATION_FIXTURE = `
  alter table public.message_events add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean,
    add column if not exists event_timestamp timestamptz, add column if not exists received_at timestamptz;
  alter table public.send_queue add column if not exists use_case_template text, add column if not exists agent_name text, add column if not exists scheduled_for_utc timestamptz,
    add column if not exists from_phone_number text, add column if not exists sent_at timestamptz;
  create table if not exists public.deal_thread_state (thread_key text primary key, universal_status text, inbox_bucket text, universal_stage text, opt_out boolean);`

/**
 * @param {{ adminUrl: string, ownerUserId: string, psqlBin?: string|null }} o
 * @returns the database name / URLs, the owner (postgres) pool, the agent_api pool, the applied file list
 */
export async function buildWorld({ adminUrl, ownerUserId, orgId, psqlBin = 'psql' }) {
  process.env.AGENT_PG_TEST_DB_URL = adminUrl // the harness reads it (and re-checks loopback) at import
  const harness = await import('../../../tests/pg/agent-pg-harness.mjs')
  const { MIG, FIX, GATEWAY_MIGRATION, GATEWAY_BASELINE } = await import('../../../tests/helpers/action-gateway-pg.mjs')
  const { isoPool } = await import('../../../tests/helpers/pg-supabase.mjs')
  const REPO = harness.REPO_DIR
  const applied = []
  const db = await harness.freshDb() // shim + durability + S3 + opaque ids
  applied.push('tests/pg/supabase-shim.sql', 'apps/api/supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql',
    'PROPOSED_20261010120000_agent_s3_persistence(_pretest).sql', 'PROPOSED_20261019120000_payload_clean_opaque_ids.sql')
  const rel = (f) => path.relative(REPO, f)
  const run = async (f) => { await harness.runSqlFile(db.pool, f); applied.push(rel(f)) }
  const tx = async (f) => { await harness.applyInTransaction(db.pool, f); applied.push(rel(f)) }
  const q = async (label, sql) => { await db.pool.query(sql); applied.push(label) }
  await run(harness.SQL.researchPretest); await run(harness.SQL.research)
  await run(FIX('send_queue_live_baseline.sql'))
  await q('(fixture) public.system_control + public.send_queue', RUNTIME_PUBLIC_FIXTURE)
  await run(FIX('operations_public_baseline.sql'))
  await run(FIX('automation_holds_public_baseline.sql'))
  await run(FIX('legacy_conversation_turns_baseline.sql'))
  await tx(harness.SQL.runtime)
  await tx(MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await tx(MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await tx(MIG('PROPOSED_20261013120000_agent_capabilities.sql'))
  await tx(MIG('PROPOSED_20261013160000_conversation_ai_shadow.sql'))
  await tx(MIG('PROPOSED_20261014120000_persistent_missions.sql'))
  await tx(MIG('PROPOSED_20261016140000_operations_action_center.sql'))
  await run(MIG('PROPOSED_20261017122000_conversation_turn_operator_items.sql'))
  await run(MIG('PROPOSED_20261016200000_automation_holds_registry.sql'))
  await tx(MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  await tx(MIG('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql'))
  await tx(MIG('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql'))
  await tx(MIG('PROPOSED_20261015190000_negotiation_authority.sql'))
  await tx(MIG('PROPOSED_20261016161000_negotiation_send_authorization.sql'))
  await run(GATEWAY_BASELINE)
  await q('(fixture) conversation read surface', CONVERSATION_FIXTURE)
  await q('(fixture) public.automation_events', AUTOMATION_EVENTS_FIXTURE)
  await run(MIG('PROPOSED_20261017120000_followup_intent_lifecycle.sql'))
  await run(path.join(REPO, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql'))
  await run(path.join(REPO, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t34_baseline.sql'))
  await tx(GATEWAY_MIGRATION) // #26
  await tx(MIG('PROPOSED_20261020100000_action_gateway_t2.sql')) // #27 (the extension registry)
  await tx(MIG('PROPOSED_20261020110000_action_gateway_t34.sql')) // #28
  await tx(harness.SQL.workforce)
  // the org's humans: the CEO user is the org owner (the membership sync's row), before the seed (it RAISES otherwise)
  await db.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'workforce-agntei-e2e') on conflict do nothing`, [orgId, ownerUserId])
  const seed = spawnSync(psqlBin, [db.url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `owner_id=${ownerUserId}`, '-f', harness.SQL.workforceSeed], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  if (seed.error || seed.status !== 0) throw new Error(`workforce seed failed: ${seed.error?.message || (seed.stderr || '').slice(0, 400)}`)
  applied.push(`${rel(harness.SQL.workforceSeed)} (psql, owner_id = the CEO user)`)
  await tx(MIG('PROPOSED_20261022110000_workforce_agntei.sql'))
  await db.pool.query('alter role agent_api login')
  const owner = db.trackPool(isoPool(db.url, 6))
  const api = db.trackPool(new pg.Pool({ connectionString: db.apiUrl, max: 6 }))
  return { db, name: db.name, url: db.url, apiUrl: db.apiUrl, owner, api, applied, harness }
}
