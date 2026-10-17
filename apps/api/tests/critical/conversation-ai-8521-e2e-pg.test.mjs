// rc-8.5.21 part A, Phase 11 — END TO END on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it):
//   persisted inbound (public.message_events) → routeInboundToTurn (the conversation.decide route)
//   → public.conversation_reply_turns + the agent runtime job (agent.runtime_enqueue_event_at)
//   → runRuntimeTick claims conversation.turn → the CANONICAL decider (decideAndCompose, real
//   loaders over real SQL) → finalize reserves public.idempotency_ledger → the R3 dispatcher →
//   public.ai_generated_messages (append-only, CHECKs) → public.send_queue (the live baseline's
//   triggers + guard_send_queue_message_origin) → the AI row gate → the REAL queue runner with a
//   SIMULATED provider; global fetch is trapped: touching any live transport FAILS the test.
// Applied: S3 + research RO + runtime + kind-limits + decide budget + reply turns + shadow +
// message origin migrations, the live send_queue baseline. Model calls are local fakes ($0).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from '../helpers/pg-supabase.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createPgTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { CONVERSATION_TURN_KIND } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'
import { routeInboundToTurn, createCanonicalTurnDecider } from '../../src/lib/ai/conversation-turn-wiring.js'
import { createR3TurnDispatcher } from '../../src/lib/ai/conversation-turn-dispatch.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { CANONICAL_VERSIONS } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'
import { insertSupabaseSendQueueRow, normalizeSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { evaluateAiConversationRowGate, loadNewerInboundsForRow } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { lookupAiGeneratedMessageByQueueKey, recordAiRowProviderOutcome } from '../../src/lib/domain/messages/ai-generated-message.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { createMemoryS11Store } from '../helpers/s11-memory-store.mjs'

const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const FIX = (f) => path.join(REPO_DIR, 'scripts/db/fixtures', f)
const SELLER = '+13125550101'
const OURS = '+13125550199'
const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }
const SWITCHES = { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) }

// the public read surface the canonical loaders select (prod-shaped subset; message_events and
// send_queue come from the live baseline fixture)
const PUBLIC_FIXTURE = `
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

async function e2eDb() {
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
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 2, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP } })])
  await db.pool.query(`insert into public.conversation_ai_reply_policy (id, shadow_enabled, kill_switch_engaged, enabled) values (1, true, false, false)
                       on conflict (id) do update set shadow_enabled = true, kill_switch_engaged = false`)
  const pool = db.trackPool(isoPool(db.url, 6))
  return { db, pool, sb: pgSupabase(pool) }
}
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

async function seed(pool, { inboundBody = 'Yes I still own it', minutesAgo = 2, switches = SWITCHES } = {}) {
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

const provider = () => fakeProvider((p) => (p.tools[0].input_schema?.properties?.message ? { message: 'Good to know. Would you consider an offer on it?' }
  : makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'R1 TEXT NEVER SENT. Would you sell?', confidence: 0.93, source_message_ids: [], facts_extracted: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [], rationale: 'x' } })))

/** PG-backed reservations for the seller-day / global scopes (the turn holds inbound_reply itself). */
function pgReservations(pool) {
  return {
    async begin({ scope, key, summary = null, metadata = {} }) {
      const r = await pool.query(`insert into public.idempotency_ledger (scope, key, claim_token, status, summary, metadata) values ($1, $2, gen_random_uuid(), 'processing', $3, $4::jsonb) on conflict (scope, key) do nothing returning key`, [scope, key, summary, JSON.stringify(metadata)])
      return { ok: true, duplicate: r.rowCount === 0, record_item_id: `idempotency:${scope}:${key}`, scope, key }
    },
    async complete({ scope, key, metadata = {} }) { await pool.query(`update public.idempotency_ledger set status = 'completed', completed_at = now(), metadata = metadata || $3::jsonb where scope = $1 and key = $2`, [scope, key, JSON.stringify(metadata)]); return { ok: true } },
    async release({ scope, key, error = null }) { await pool.query(`update public.idempotency_ledger set status = 'failed', failed_at = now(), last_error = $3 where scope = $1 and key = $2`, [scope, key, error]); return { ok: true } },
  }
}

function harness({ db, pool, sb }, { dispatchWrap = null } = {}) {
  const store = createRuntimePgStore({ pool: db.api })
  const turnStore = createPgTurnStore(pool)
  const readSwitch = async (k) => (await sel(pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null
  const r3deps = {
    readSwitch, reservations: pgReservations(pool),
    insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, {
      insertSupabaseSendQueueRow: async (row) => {
        const r = await sb.from('send_queue').insert(row).select('id,queue_status,paused_reason,queue_key').single()
        if (r.error) return { ok: false, reason: r.error.message }
        return { ok: true, queue_row_id: r.data.id, raw: r.data }
      },
    }),
  }
  const dispatcher = createR3TurnDispatcher({ supabase: sb, jobId: 'e2e', deps: r3deps })
  const handler = createConversationTurnHandler({
    env: ENV, store: turnStore, supabase: sb, runtimeStore: store,
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

function trapFetch() {
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
  return { hits, restore: () => { globalThis.fetch = real } }
}

test('E2E PG: persisted inbound → real job → canonical writer → validator → scheduler → R3 → canonical queue → row gate → runner with a SIMULATED provider (live transport never touched)', { skip }, async () => {
  const env = await e2eDb()
  const net = trapFetch()
  try {
    const ids = await seed(env.pool)
    const h = harness(env)
    const routed = await h.route()
    assert.equal(routed.code, 'TURN_OPENED', JSON.stringify(routed))
    assert.ok(routed.plan.since_inbound_minutes >= 3 && routed.plan.since_inbound_minutes <= 40)
    const jobs = await sel(env.pool, `select job_id, state, next_attempt_at > now() future from agent.research_job where kind = $1`, [CONVERSATION_TURN_KIND])
    assert.deepEqual(jobs.map((j) => [j.state, j.future]), [['queued', true]], 'the job row IS the schedule')
    assert.equal((await h.tick()).claimed, 0, 'not claimable before its due time')
    await h.makeDue()
    const t = await h.tick()
    assert.equal(t.jobs?.[0]?.outcome, 'completed', JSON.stringify(t))
    // the canonical decision, recorded with its writer
    const shadow = await sel(env.pool, `select outcome, record->>'writer_version' w, draft_text from public.conversation_ai_shadow_decisions`)
    assert.deepEqual(shadow.map((s) => [s.outcome, s.w, s.draft_text]), [['REPLY_CANDIDATE', CANONICAL_VERSIONS.writer, 'Good to know. Would you consider an offer on it?']])
    // the turn reserved the inbound, R3 consumed it on enqueue
    assert.deepEqual(await sel(env.pool, `select key, status from public.idempotency_ledger where scope = 'inbound_reply'`), [{ key: ids.i1, status: 'completed' }])
    assert.equal((await sel(env.pool, `select state from public.conversation_reply_turns`))[0].state, 'decided')
    // the immutable record + the queue row (the origin trigger verified the body hash)
    const rec = (await sel(env.pool, `select id, queue_key, message_body, playbook_version, audit_refs from public.ai_generated_messages`))
    assert.equal(rec.length, 1)
    assert.equal(rec[0].audit_refs.writer_version, CANONICAL_VERSIONS.writer)
    assert.equal(rec[0].playbook_version, 'playbook.v3')
    const rows = await sel(env.pool, `select * from public.send_queue where message_origin = 'ai_generated'`)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual([row.queue_key, row.message_body, row.agent_name, row.from_phone_number, row.template_id], [`ai_conversation:${ids.i1}`, 'Good to know. Would you consider an offer on it?', 'Helen', OURS, null])
    assert.deepEqual(row.metadata.recipient_zones, ['America/Chicago'])
    assert.deepEqual((await sel(env.pool, `select event_type from public.ai_generated_message_events`)).map((x) => x.event_type), ['queued'])
    // dispatch time: the AI row gate over the real record / thread
    const gate = await evaluateAiConversationRowGate(row, { readSwitch: h.readSwitch, loadRecord: (k) => lookupAiGeneratedMessageByQueueKey(env.sb, k), loadNewerInbounds: (r) => loadNewerInboundsForRow(env.sb, r), now: new Date().toISOString(), propertyGeography: { state: 'IL', zip: '60601' } })
    assert.deepEqual([gate.action, gate.reason, gate.timing?.basis], ['proceed', 'ai_conversation_gate_open', 'in_session'], JSON.stringify(gate))
    // the REAL runner, a simulated provider; any live transport (fetch) fails the test
    const sent = []
    const updates = []
    const out = await processSendQueueItem(normalizeSendQueueRow({ ...row, queue_status: 'processing', is_locked: true, lock_token: 'lock-e2e' }), {
      now: new Date().toISOString(), claimedLockToken: 'lock-e2e',
      getSystemValue: async (k) => (k === 'queue_processor_mode' ? 'live' : k === 'queue_execution_mode' ? 'normal' : null),
      readAiConversationSwitch: h.readSwitch,
      loadAiGeneratedMessage: (k) => lookupAiGeneratedMessageByQueueKey(env.sb, k),
      loadNewerInbounds: (r) => loadNewerInboundsForRow(env.sb, r),
      loadOutboundNumberByPhone: async (p) => ({ id: `fleet-${p}`, phone_number: p, status: 'active', health_state: 'unverified', daily_limit: 800, messages_sent_today: 0 }),
      loadCampaignStatus: async () => 'active',
      updateQueueRow: async (id, payload) => { updates.push(payload); return { ok: true, id, payload } },
      updateSendQueueRowWithLock: async (id, lock_token, payload) => { updates.push(payload); return normalizeSendQueueRow({ ...row, id, ...payload }) },
      sendTextgridSMS: async (msg) => { sent.push(msg); return { ok: true, sid: `SMsim${sent.length}`, provider_message_id: `SMsim${sent.length}`, status: 'queued' } },
      recordAiRowProviderOutcome: (sb, r, o) => recordAiRowProviderOutcome(env.sb, r, o),
      // the §11 atomic-claim RPC (queue_verify_dispatch_authorization) belongs to the queue-claim
      // migrations, not to this chain: its verdict for a claimed row is stood in here
      verifyDispatchAuthorization: async () => ({ ok: true, reason: 'dispatch_authorized', claim_mode: 'e2e_claim_stand_in' }),
      // the §11 logical-communication ledger (its SQL proofs live with its own migration): the
      // SQL-semantics memory mirror, so the canonical dispatch seam runs for real
      store: createMemoryS11Store(),
      info: () => {}, warn: () => {},
      supabase: env.sb,
    })
    assert.equal(net.hits.length, 0, `live transport touched: ${net.hits.join(',')}`)
    assert.equal(sent.length, 1, `exactly one simulated provider send (${JSON.stringify(out).slice(0, 300)})`)
    const wire = JSON.stringify(sent[0])
    assert.ok(wire.includes('Good to know. Would you consider an offer on it?') && wire.includes(SELLER.slice(-10)) && wire.includes(OURS.slice(-10)), 'the exact validated text, to the seller, from the thread number')
    assert.equal(out.sent, true)
    assert.deepEqual((await sel(env.pool, `select event_type from public.ai_generated_message_events order by occurred_at`)).map((x) => x.event_type), ['queued', 'provider_accepted'])
    if (process.env.E2E_DEBUG) console.error("E2E_RUNNER", JSON.stringify({ sent: sent.length, reason: out.reason || null, ok: out.ok, sentx: out.sent }))
  } finally { net.restore(); await env.db.drop() }
})

test('E2E PG: repeated webhook (3x) and two racing workers ⇒ ONE turn, ONE decision, ONE queued reply', { skip }, async () => {
  const env = await e2eDb()
  const net = trapFetch()
  try {
    await seed(env.pool)
    const h = harness(env)
    const codes = [await h.route(), await h.route(), await h.route()].map((r) => r.code)
    assert.deepEqual(codes, ['TURN_OPENED', 'TURN_EVENT_DEDUPED', 'TURN_EVENT_DEDUPED'])
    await h.makeDue()
    // two workers race the same due job (separate pools / connections)
    const h2 = harness({ ...env, pool: env.db.trackPool(isoPool(env.db.url, 2)) })
    await Promise.all([h.tick('agent-runtime-tick'), h2.tick('agent-runtime-tick-2')])
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 1)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.ai_generated_messages`))[0].n, 1)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.conversation_ai_shadow_decisions`))[0].n, 1)
    assert.equal(net.hits.length, 0)
  } finally { net.restore(); await env.db.drop() }
})

test('E2E PG: worker crash after finalize ⇒ the job retries (bounded) and RESUMES with the same reservation; exactly one queued reply', { skip }, async () => {
  const env = await e2eDb()
  try {
    await seed(env.pool)
    let crashed = false
    const h = harness(env, { dispatchWrap: (d) => async (x) => { if (!crashed) { crashed = true; throw new Error('WORKER_DIED_AFTER_FINALIZE') } return d(x) } })
    await h.route()
    await h.makeDue()
    const t1 = await h.tick()
    assert.equal(t1.jobs?.[0]?.outcome, 'retry', JSON.stringify(t1))
    assert.equal((await sel(env.pool, `select state from public.conversation_reply_turns`))[0].state, 'decided')
    assert.equal((await sel(env.pool, `select status from public.idempotency_ledger where scope = 'inbound_reply'`))[0].status, 'processing')
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
    await h.makeDue()
    const t2 = await h.tick()
    assert.equal(t2.jobs?.[0]?.outcome, 'completed', JSON.stringify(t2))
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 1)
    assert.equal((await sel(env.pool, `select status from public.idempotency_ledger where scope = 'inbound_reply'`))[0].status, 'completed')
    const job = (await sel(env.pool, `select attempt attempts, max_attempts from agent.research_job where kind = $1`, [CONVERSATION_TURN_KIND]))[0]
    assert.ok(job.attempts <= job.max_attempts, JSON.stringify(job))
  } finally { await env.db.drop() }
})

test('E2E PG: STOP during the delay cancels the turn (no model); the kill switch absent ⇒ recorded, nothing reserved, nothing queued', { skip }, async () => {
  const env = await e2eDb()
  try {
    const ids = await seed(env.pool)
    const h = harness(env)
    await h.route()
    await env.pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, prospect_id, language)
                          values ($1, 'SMstop', 'inbound', $2::text, $2::text, $3::text, 'STOP', now() - interval '30 seconds', now() - interval '30 seconds', 'p1', 'pr1', 'en')`, [crypto.randomUUID(), SELLER, OURS])
    const s = await h.route('SMstop')
    assert.equal(s.code, 'SUPPRESSED_NOW')
    await h.makeDue()
    await h.tick()
    assert.equal((await sel(env.pool, `select state, close_reason from public.conversation_reply_turns`))[0].state, 'cancelled')
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
    assert.equal(ids.i1.length, 36)
  } finally { await env.db.drop() }
  // OFF: the same thread with the switches absent
  const off = await e2eDb()
  try {
    await seed(off.pool, { switches: {} })
    const h = harness(off)
    await h.route()
    await h.makeDue()
    await h.tick()
    assert.equal((await sel(off.pool, `select count(*)::int n from public.conversation_ai_shadow_decisions`))[0].n, 1)
    assert.equal((await sel(off.pool, `select count(*)::int n from public.idempotency_ledger where scope = 'inbound_reply'`))[0].n, 0)
    assert.equal((await sel(off.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
    assert.equal((await sel(off.pool, `select count(*)::int n from public.ai_generated_messages`))[0].n, 0)
  } finally { await off.db.drop() }
})
