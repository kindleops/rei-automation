// rc-8.5.21 FINAL directive, phase 4 — ONE disposable database carrying BOTH automated sources of a seller
// thread: the follow-up execution lifecycle (holds registry + followup_intent_lifecycle over the live
// send_queue baseline) AND the AI conversation turn runtime (research + runtime + reply turns + shadow +
// message origin + the dispatch lease). Every fixture is the composable prod-shaped baseline the two
// single-source harnesses already use (followup-lifecycle-pg.mjs, conversation-e2e-pg.mjs), applied in the
// release-chain order. DISPOSABLE PostgreSQL only (agent-pg-harness refuses anything else).
import { freshDb, runSqlFile, applyInTransaction, SQL } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { LIFECYCLE_PUBLIC_FIXTURE, LIFECYCLE_MIGRATION, applyS11Ledger } from './followup-lifecycle-pg.mjs'
import { PUBLIC_FIXTURE as E2E_PUBLIC_FIXTURE, MIG, FIX, OP } from './conversation-e2e-pg.mjs'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'

export async function combinedDb({ s11 = true } = {}) {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await runSqlFile(db.pool, FIX('send_queue_live_baseline.sql'))
  await runSqlFile(db.pool, FIX('operations_public_baseline.sql'))
  await runSqlFile(db.pool, FIX('automation_holds_public_baseline.sql'))
  await db.pool.query(LIFECYCLE_PUBLIC_FIXTURE)
  await db.pool.query(E2E_PUBLIC_FIXTURE)
  await db.pool.query(`alter table public.inbox_thread_state add column if not exists canonical_e164 text, add column if not exists is_suppressed boolean, add column if not exists disposition text,
    add column if not exists last_intent text, add column if not exists stage text, add column if not exists contactability_status text, add column if not exists status text, add column if not exists last_inbound_at timestamptz`)
  // the AI loaders' property columns (the e2e fixture's properties shape) on the lifecycle's properties table
  await db.pool.query(`alter table public.properties add column if not exists owner_2_name text, add column if not exists asset_class text, add column if not exists asset_subclass text`)
  await runSqlFile(db.pool, FIX('legacy_conversation_turns_baseline.sql'))
  // release-chain order: the holds registry first, then the runtime chain, the lifecycle last
  await runSqlFile(db.pool, MIG('PROPOSED_20261016200000_automation_holds_registry.sql'))
  await runSqlFile(db.pool, MIG('PROPOSED_20261016200100_automation_hold_guards.sql'))
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013160000_conversation_ai_shadow.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql'))
  await runSqlFile(db.pool, LIFECYCLE_MIGRATION)
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  await db.pool.query(`insert into public.conversation_ai_reply_policy (id, shadow_enabled, kill_switch_engaged, enabled) values (1, true, false, false)
                       on conflict (id) do update set shadow_enabled = true, kill_switch_engaged = false`)
  await db.pool.query(`create table if not exists public.automation_events (id uuid primary key default gen_random_uuid(), event_type text, source text, conversation_thread_id text, payload jsonb, dedupe_key text, created_at timestamptz default now())`)
  const pool = db.trackPool(isoPool(db.url, 8))
  const env = { db, pool, sb: pgSupabase(pool) }
  if (s11) await applyS11Ledger(pool)
  return env
}

/**
 * The automation-hold test seam bound to THIS database's REAL registry (public.automation_hold_for over
 * the disposable DB): every caller — including the AI eligibility path, which does not thread a client —
 * reads the same registry rows the lifecycle and the queue triggers read. A read error is a hold (fail
 * closed), as in production.
 */
export function registryHoldResolver(sb) {
  return async (s, { capability = null } = {}) => {
    const { data, error } = await sb.rpc('automation_hold_for', {
      p_thread_key: s.thread_key || null, p_inbox_thread_id: s.inbox_thread_id || null, p_property_id: s.property_id || null,
      p_opportunity_id: s.opportunity_id || null, p_master_owner_id: s.master_owner_id || null, p_capability: capability,
    })
    if (error) return { held: true, fail_closed: true, holds: [], hold_ids: [], reason: 'automation_hold_lookup_failed' }
    const holds = (Array.isArray(data) ? data : data ? [data] : []).filter((h) => !h?.released_at)
    return holds.length ? { held: true, fail_closed: false, holds, hold_ids: holds.map((h) => h.id).filter(Boolean), reason: 'automation_hold' } : { held: false, fail_closed: false, holds: [], hold_ids: [], reason: null }
  }
}
