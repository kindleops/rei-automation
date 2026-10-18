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
import { spawnSync } from 'node:child_process'
import { API_DIR } from '../pg/agent-pg-harness.mjs'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { e2eDb, seed, harness, sel, SELLER, OURS } from '../helpers/conversation-e2e-pg.mjs'
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

test('E2E PG (blind-eval D2, REAL SIGKILL): the worker is killed between the provenance record and the queue insert ⇒ the turn is NOT dispatched; the retried job finishes the enqueue — ONE row with the record\'s exact text', { skip }, async () => {
  const env = await e2eDb()
  const net = trapFetch()
  try {
    const ids = await seed(env.pool)
    const h = harness(env)
    await h.route()
    await h.makeDue()
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/r3-sigkill-child.mjs', env.db.url, env.db.apiUrl],
      { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(0, 800)}`)
    assert.match(child.stdout, /KILL_AT_QUEUE_INSERT/)
    const recs = await sel(env.pool, `select id, message_body from public.ai_generated_messages`)
    assert.equal(recs.length, 1, 'the record was committed before the kill')
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0, 'the queue row was not')
    const t0 = (await sel(env.pool, `select dispatch_state, result->>'send_status' s from public.conversation_reply_turns`))[0]
    assert.deepEqual([t0.dispatch_state, t0.s], ['in_flight', 'dispatch_pending'], 'a killed dispatch is never recorded as dispatched')
    // the dead process renews nothing: its runtime lease and its dispatch lease expire (DB clock)
    await env.pool.query(`update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where state in ('claimed','running')`)
    await env.pool.query(`update public.conversation_reply_turns set dispatch_lease_until = clock_timestamp() - interval '1 second'`)
    await h.tick() // the reaper moves the dead attempt to retrying
    await h.makeDue()
    const t = await h.tick()
    assert.equal(t.jobs?.[0]?.outcome, 'completed', JSON.stringify(t))
    const rows = await sel(env.pool, `select queue_key, message_body, metadata->>'ai_message_id' rid, max_retries from public.send_queue where message_origin = 'ai_generated'`)
    assert.equal(rows.length, 1, 'exactly ONE queued reply')
    assert.deepEqual([rows[0].queue_key, rows[0].message_body, rows[0].rid, rows[0].max_retries], [`ai_conversation:${ids.i1}`, recs[0].message_body, recs[0].id, 1])
    assert.equal((await sel(env.pool, `select count(*)::int n from public.ai_generated_messages`))[0].n, 1, 'no second record')
    const t1 = (await sel(env.pool, `select dispatch_state, dispatch_attempts from public.conversation_reply_turns`))[0]
    assert.deepEqual([t1.dispatch_state, t1.dispatch_attempts], ['dispatched', 2])
    assert.deepEqual((await sel(env.pool, `select scope, status from public.idempotency_ledger order by scope`)).map((x) => [x.scope, x.status]),
      [['ai_conv_global_day', 'completed'], ['ai_conv_seller_day', 'completed'], ['inbound_reply', 'completed']])
    assert.equal(net.hits.length, 0)
  } finally { net.restore(); await env.db.drop() }
})

test('E2E PG (blind-eval D3): an R3 hold is recorded as held (not dispatched) and the job raises the operator item under its lease', { skip }, async () => {
  const env = await e2eDb()
  try {
    // the thread is outside the AI send scope ⇒ R3 holds (thread_not_in_ai_scope)
    await seed(env.pool, { switches: { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [SELLER] } }) } })
    const items = []
    const h = harness(env, {
      operatorItems: { syncWorkItems: async (a) => { items.push(a); return { ok: true, inserted: 1 } } },
      dispatchWrap: (d) => async (x) => { await env.pool.query(`update public.system_control set value = $1 where key = 'ai_conversation_send_policy'`, [JSON.stringify({ enabled: true, scope: { thread_keys: ['+19995550000'] } })]); return d(x) },
    })
    await h.route()
    await h.makeDue()
    const t = await h.tick()
    assert.equal(t.jobs?.[0]?.outcome, 'completed', JSON.stringify(t))
    const turn = (await sel(env.pool, `select turn_id, dispatch_state, result->>'send_status' s, result->'dispatch_detail' d from public.conversation_reply_turns`))[0]
    assert.deepEqual([turn.dispatch_state, turn.s], ['held', 'held'])
    assert.ok(turn.d.reasons.includes('thread_not_in_ai_scope'), JSON.stringify(turn.d))
    assert.equal(items.length, 1)
    assert.ok(items[0].job_id && items[0].token, 'written under the job lease')
    assert.deepEqual([items[0].items[0].dedupe_key, items[0].items[0].kind, items[0].items[0].subject_id], [`conversation:turn_held:${turn.turn_id}`, 'escalation', turn.turn_id])
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
  } finally { await env.db.drop() }
})
