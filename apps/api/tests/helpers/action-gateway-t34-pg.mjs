// Disposable-PostgreSQL world for the Action Gateway T3 / T4 proofs (queue_authorized_reply, prepare / submit /
// execute offers, record_seller_counteroffer, R4, R5, D6). AGENT_PG_TEST_DB_URL must name a LOCAL scratch server.
//
// One brand-new database per world: the Action Gateway world (#26, #27 and their prerequisites), the R3 / turn world
// (reply turns, message origin + ai_generated_messages, the dispatch lease), the negotiation authority + send
// authorization tables, the T3 / T4 baseline and the PROPOSED T3 / T4 link. Connections:
//   owner   postgres (seeds; also stands in for LeadCommand's backend client in the execution handlers)
//   gw      AS lc_action_gateway + lc_org (the MCP's only data path)
//   api     agent_api (the human decide path)
// The provider is SIMULATED: any fetch or TextGrid credential read fails the test.
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

import { freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { MIG, FIX, GATEWAY_MIGRATION, GATEWAY_BASELINE, ORG, OWNER, OPERATOR, OURS } from './action-gateway-pg.mjs'

export const T34_MIGRATION = MIG('PROPOSED_20261020110000_action_gateway_t34.sql')
export const T34_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t34_baseline.sql')
export const T2_MIGRATION = MIG('PROPOSED_20261020100000_action_gateway_t2.sql')
export const T2_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql')

// the same fixtures as tests/helpers/action-gateway-pg.mjs (kept identical; not exported there)
const RUNTIME_PUBLIC_FIXTURE = `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`
const CONVERSATION_FIXTURE = `
  alter table public.message_events add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean,
    add column if not exists event_timestamp timestamptz, add column if not exists received_at timestamptz;
  alter table public.send_queue add column if not exists use_case_template text, add column if not exists agent_name text, add column if not exists scheduled_for_utc timestamptz,
    add column if not exists from_phone_number text, add column if not exists sent_at timestamptz;
  create table if not exists public.deal_thread_state (thread_key text primary key, universal_status text, inbox_bucket text, universal_stage text, opt_out boolean);`

const BOOTSTRAP_LOCK = 0x4c43_4147 // 'LCAG' — the SAME cluster-wide lock as action-gateway-pg.mjs (roles are cluster-global)
async function underBootstrapLock(fn) {
  const admin = new pg.Client({ connectionString: process.env.AGENT_PG_TEST_DB_URL })
  await admin.connect()
  try {
    await admin.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK])
    return await fn()
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK]).catch(() => {})
    await admin.end().catch(() => {})
  }
}

export async function t34Db({ applyT34 = true } = {}) {
  return underBootstrapLock(async () => {
    const db = await freshDb()
    try {
      const run = (f) => runSqlFile(db.pool, f)
      const tx = (f) => applyInTransaction(db.pool, f)
      await run(SQL.researchPretest); await run(SQL.research)
      await run(FIX('send_queue_live_baseline.sql'))
      await db.pool.query(RUNTIME_PUBLIC_FIXTURE)
      await run(FIX('operations_public_baseline.sql'))
      await run(FIX('automation_holds_public_baseline.sql'))
      await run(FIX('legacy_conversation_turns_baseline.sql'))
      await tx(SQL.runtime)
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
      await db.pool.query(CONVERSATION_FIXTURE)
      await run(MIG('PROPOSED_20261017120000_followup_intent_lifecycle.sql'))
      await run(T2_BASELINE)
      await run(T34_BASELINE)
      await tx(GATEWAY_MIGRATION)
      await tx(T2_MIGRATION) // link #27: the extension registry this link adds rows to
      if (applyT34) await tx(T34_MIGRATION)
      const owner = db.trackPool(isoPool(db.url, 8))
      return { db, owner, url: db.url, sb: pgSupabase(owner) }
    } catch (e) {
      await db.drop().catch(() => {})
      throw e
    }
  })
}

export { ORG, OWNER, OPERATOR, OURS, crypto }
