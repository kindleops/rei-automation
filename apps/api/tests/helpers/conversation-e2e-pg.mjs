// Shared world for the rc-8.5.21 end-to-end PG tests (conversation-ai-8521-e2e-pg.test.mjs and the
// real-SIGKILL child process tests/helpers/r3-sigkill-child.mjs). DISPOSABLE PostgreSQL only.
import path from 'node:path'
import crypto from 'node:crypto'

import { freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createPgTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'
import { routeInboundToTurn, createCanonicalTurnDecider } from '../../src/lib/ai/conversation-turn-wiring.js'
import { createR3TurnDispatcher } from '../../src/lib/ai/conversation-turn-dispatch.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { insertSupabaseSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { fakeProvider } from './conversation-ai-runtime-fakes.mjs'

export const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
export const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
export const FIX = (f) => path.join(REPO_DIR, 'scripts/db/fixtures', f)
export const SELLER = '+13125550101'
export const OURS = '+13125550199'
export const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }
export const SWITCHES = { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) }

// the public read surface the canonical loaders select (prod-shaped subset; message_events and
// send_queue come from the live baseline fixture)
export const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  alter table public.message_events add column if not exists provider_message_sid text, add column if not exists from_phone_number text,
    add column if not exists to_phone_number text, add column if not exists property_id text, add column if not exists prospect_id text,
    add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean;
  create table if not exists public.seller_offers (id uuid primary key default gen_random_uuid(), thread_key text, property_id text, purchase_price numeric, status text, created_at timestamptz default now());
  create table if not exists public.properties (property_id text primary key, property_type text, property_address_city text, property_address_state text, property_address_zip text, timezone text,
    owner_1_name text, owner_2_name text, owner_name text, property_address text, property_address_full text, owner_address_state text, property_class text, units_count integer);
  create table if not exists public.prospects (prospect_id text primary key, first_name text, full_name text, timezone text);
  create table if not exists public.inbox_thread_state (thread_key text primary key, canonical_e164 text, property_id text, is_suppressed boolean, disposition text, last_intent text, stage text, lifecycle_stage text, contactability_status text, our_number text, status text, metadata jsonb, last_inbound_at timestamptz);
  create table if not exists public.sms_suppression_list (id uuid primary key default gen_random_uuid(), suppression_reason text, phone_e164 text, phone_number text, sender_phone_e164 text, is_active boolean, suppression_type text);
  create table if not exists public.automation_suppressions (id uuid primary key default gen_random_uuid(), phone_e164 text, status text, suppression_type text, suppression_reason text, expires_at timestamptz);
  create table if not exists public.deal_thread_state (thread_key text primary key, universal_status text, inbox_bucket text, universal_stage text, opt_out boolean);
  create table if not exists public.phones (phone_id text, canonical_e164 text, phone text, phone_raw text, phone_contact_status text, wrong_number_at timestamptz, primary_prospect_id text, canonical_prospect_id text, activity_status text);
  -- rc-8.5.21: the send-time contact guard reads the property-scoped resolution store (recontact guard)
  create table if not exists public.contact_property_resolution (id uuid primary key default gen_random_uuid(), property_id text not null, contact_phone_e164 text not null,
    contact_property_role text, rejected_at timestamptz, rejection_reason text, suppression_scope text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique (property_id, contact_phone_e164));
  revoke all on public.system_control, public.send_queue from agent_api;`

export async function e2eDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await runSqlFile(db.pool, FIX('send_queue_live_baseline.sql'))
  await db.pool.query(PUBLIC_FIXTURE)
  await runSqlFile(db.pool, FIX('legacy_conversation_turns_baseline.sql'))
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013160000_conversation_ai_shadow.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261015130000_message_origin_ai_generated_messages.sql'))
  // rc-8.5.21 owner directive: the dispatch lease + the one-ai-row-per-turn send_queue backstop
  await applyInTransaction(db.pool, MIG('PROPOSED_20261017121000_conversation_reply_turn_dispatch_lease.sql'))
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  await db.pool.query(`insert into public.conversation_ai_reply_policy (id, shadow_enabled, kill_switch_engaged, enabled) values (1, true, false, false)
                       on conflict (id) do update set shadow_enabled = true, kill_switch_engaged = false`)
  const pool = db.trackPool(isoPool(db.url, 6))
  return { db, pool, sb: pgSupabase(pool) }
}
export const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

export async function seed(pool, { inboundBody = 'Yes I still own it', minutesAgo = 2, switches = SWITCHES } = {}) {
  const ids = { o1: crypto.randomUUID(), i1: crypto.randomUUID() }
  await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
                    values ($1, 'SMo1', 'outbound', $3::text, $4::text, $5::text, 'Hi Dana, this is Helen. Do you still own the house on Oak St?', now() - interval '90 minutes', now() - interval '90 minutes', 'p1', 'pr1', 'en'),
                           ($2, 'SMi1', 'inbound', $3::text, $5::text, $4::text, $6::text, now() - make_interval(mins => $7::int), now() - make_interval(mins => $7::int), 'p1', 'pr1', 'en')`,
  [ids.o1, ids.i1, SELLER, OURS, SELLER, inboundBody, minutesAgo])
  await pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, created_at, sent_at, metadata)
                    values ('seed:o1', 'sent', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', $1::text, $2::text, $1::text, 'ownership_check', 'Helen', now() - interval '90 minutes', now() - interval '90 minutes', '{}'::jsonb)`, [SELLER, OURS])
  await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, owner_1_name, property_address) values ('p1', 'SFR', 'Chicago', 'IL', '60601', 'Dana Q', '12 Oak St')`)
  await pool.query(`insert into public.prospects (prospect_id, first_name, full_name) values ('pr1', 'Dana', 'Dana Q')`)
  await pool.query(`insert into public.inbox_thread_state (thread_key, our_number) values ($1, $2)`, [SELLER, OURS])
  for (const [k, v] of Object.entries(switches)) await pool.query(`insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v])
  return ids
}

export const provider = () => fakeProvider((p) => (p.tools[0].input_schema?.properties?.message ? { message: 'Good to know. Would you consider an offer on it?' }
  : makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'R1 TEXT NEVER SENT. Would you sell?', confidence: 0.93, source_message_ids: [], facts_extracted: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [], rationale: 'x' } })))

/** PG-backed reservations for the seller-day / global scopes (the turn holds inbound_reply itself). */
export function pgReservations(pool) {
  return {
    async begin({ scope, key, summary = null, metadata = {} }) {
      const r = await pool.query(`insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata) values ($1, $2, gen_random_uuid(), 'processing', $3, $4::jsonb) on conflict (scope, key) do nothing returning key`, [scope, key, summary, JSON.stringify(metadata)])
      return { ok: true, duplicate: r.rowCount === 0, record_item_id: `idempotency:${scope}:${key}`, scope, key }
    },
    async complete({ scope, key, metadata = {} }) { await pool.query(`update public.idempotency_ledger set status = 'completed', completed_at = now(), metadata = metadata || $3::jsonb where scope = $1 and key = $2`, [scope, key, JSON.stringify(metadata)]); return { ok: true } },
    async release({ scope, key, error = null }) { await pool.query(`update public.idempotency_ledger set status = 'failed', failed_at = now(), last_error = $3 where scope = $1 and key = $2`, [scope, key, error]); return { ok: true } },
  }
}

export function harness({ db, pool, sb }, { dispatchWrap = null, beforeQueueInsert = null, operatorItems = null } = {}) {
  const store = createRuntimePgStore({ pool: db.api })
  const turnStore = createPgTurnStore(pool)
  const readSwitch = async (k) => (await sel(pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null
  const r3deps = {
    readSwitch, reservations: pgReservations(pool),
    insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, {
      insertSupabaseSendQueueRow: async (row) => {
        if (beforeQueueInsert) await beforeQueueInsert(row)
        const r = await sb.from('send_queue').insert(row).select('id,queue_status,paused_reason,queue_key').single()
        if (r.error) return { ok: false, reason: r.error.message }
        return { ok: true, queue_row_id: r.data.id, raw: r.data }
      },
    }),
  }
  const dispatcher = createR3TurnDispatcher({ supabase: sb, jobId: 'e2e', deps: r3deps })
  const handler = createConversationTurnHandler({
    env: ENV, store: turnStore, supabase: sb, runtimeStore: store,
    operatorItems: operatorItems || { syncWorkItems: async () => ({ ok: true, recorded: 'e2e_stand_in' }) },
    decide: createCanonicalTurnDecider({ supabase: sb, env: ENV, tracker: createSpendTracker({ capUsd: 0.05 }), provider: provider(), readSwitch }),
    dispatch: dispatchWrap ? dispatchWrap(dispatcher) : dispatcher,
  })
  const makeDue = async () => {
    await pool.query(`update public.conversation_reply_turns set due_at = clock_timestamp() - interval '1 second' where state = 'pending'`)
    await pool.query(`update agent.research_job set next_attempt_at = clock_timestamp() where kind = $1 and state in ('queued','retrying')`, [CONVERSATION_TURN_KIND])
  }
  const tick = (workerId = 'agent-runtime-tick') => runRuntimeTick({ store, handlers: { [CONVERSATION_TURN_KIND]: handler }, workerId, budgetMs: 20_000 })
  const route = (sid = 'SMi1') => routeInboundToTurn({ providerMessageSid: sid, env: ENV, supabase: sb, runtimeStore: store, turnStore })
  return { store, turnStore, readSwitch, route, makeDue, tick, handler, r3deps }
}

