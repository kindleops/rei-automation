// 8.5.15 — persistent shadow runtime (conversation.decide) proofs that need no database:
// idempotency per inbound message VERSION, the runtime gate on the hook, the per-job
// budget pre-check (hold, never a refused DB reserve), per-call deadlines, fail-closed
// model / auth unavailability, bounded context retrieval (no full-thread reprocessing),
// and the event-driven ops.health_check heartbeat. Every model is a local fake ($0).
// The PostgreSQL-backed proofs are in agent-runtime-conversation-pg.test.mjs (CI: agent-s3-persistence.yml runs agent-*.test.mjs on PG 17).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  scheduleConversationAiShadow, conversationDecideInput, conversationDecideEventKey, inboundVersionOf, decodeRef, CONVERSATION_DECIDE_KIND,
} from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { createConversationDecideHandler, runtimeJobTracker, ROUTINE_REPLY_RESERVE_USD } from '../../src/lib/ai/conversation-decide-handler.js'
import { runConversationAiShadowForInbound } from '../../src/lib/ai/conversation-ai-shadow-wiring.js'
import { createConversationModelClient, MIN_CALL_MS } from '../../src/lib/domain/conversation-ai/model-client.js'
import { CONTEXT_LIMITS } from '../../src/lib/domain/conversation-ai/context-loader.js'
import { createAnthropicProvider } from '../../src/lib/ai/anthropic-provider.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { evaluateHealthSnapshot, opsHealthCheckHandler, EVENT_DRIVEN_HEARTBEATS } from '../../src/lib/agent/runtime/handlers/ops-health-check.js'

const OP = '7b0c1e6c-2c4f-4bb1-9d2a-5f4bb6f0e001'
const ON = { AI_CONVERSATION_SHADOW_ENABLED: 'true' }
const GATE_OPEN = async () => ({ enabled: true, reason: null })
const flush = () => new Promise((r) => setImmediate(r))
const armedStore = (research = { enabled: false }) => createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research })

import { fakeSupabase, SID, NOW, threadTables, fakeProvider, routineDecision, semanticOk } from '../helpers/conversation-ai-runtime-fakes.mjs'

/** A job-like tracker context (what runtime-tick hands the handler), recording reserve/settle. */
function jobCtx({ cap = ROUTINE_REPLY_RESERVE_USD, remaining = 20_000 } = {}) {
  const ledger = []
  const ac = new AbortController()
  return {
    ledger,
    ac,
    job: { budget_cap_usd: cap },
    remainingMs: () => remaining,
    signal: ac.signal,
    async reserve(model, usd) { ledger.push({ op: 'reserve', model, usd }); return `r${ledger.length}` },
    async settle(id, usd) { ledger.push({ op: usd == null ? 'release' : 'settle', id, usd }) },
  }
}

// ── 1. idempotency per inbound message VERSION ─────────────────────────────
test('version: same id + same body (repeat webhook, parallel) → ONE job; edited body and an explicit reprocess are distinct jobs; input stays clean', async () => {
  const store = armedStore()
  const opts = { env: ON, getStore: async () => store, gate: GATE_OPEN }
  for (let i = 0; i < 3; i += 1) scheduleConversationAiShadow({ providerMessageSid: 'SM123abc', messageBody: 'No thanks', deterministic: { intent: 'not_interested' } }, opts)
  scheduleConversationAiShadow({ providerMessageSid: 'SM123abc', messageBody: '  No thanks  ' }, opts) // whitespace-only drift = same version
  scheduleConversationAiShadow({ providerMessageSid: 'SM123abc', messageBody: 'No thanks, maybe next year' }, opts) // edited body
  scheduleConversationAiShadow({ providerMessageSid: 'SM123abc', messageBody: 'No thanks', revision: 1 }, opts) // operator reprocess
  for (let i = 0; i < 6; i += 1) await flush()
  const claimed = (await store.claim({ worker: 'w', limit: 5, kinds: [CONVERSATION_DECIDE_KIND] })).claimed
  // max_concurrency 1: one claim at a time — count all queued instead
  const all = [...store._state.jobs.values()].filter((j) => j.kind === CONVERSATION_DECIDE_KIND)
  assert.equal(all.length, 3, 'three versions → three jobs')
  assert.equal(claimed.length, 1, 'kind max_concurrency 1 bounds the claim')
  const versions = new Set(all.map((j) => j.input.inbound_version))
  assert.equal(versions.size, 3)
  for (const j of all) {
    assert.ok(!/[0-9]/.test(JSON.stringify(j.input)), 'no digits in job input')
    assert.equal(decodeRef(j.input.inbound_ref), 'SM123abc')
  }
  assert.equal(inboundVersionOf('SM1', 'a'), inboundVersionOf('SM1', ' a '))
  assert.notEqual(inboundVersionOf('SM1', 'a'), inboundVersionOf('SM2', 'a'), 'salted by the message id')
  assert.match(inboundVersionOf('SM1', 'call me at 214 555 0147'), /^[a-p]{16}$/)
  assert.equal(conversationDecideEventKey('SM1', null), 'SM1', 'no body known ⇒ the 8.5.14 key (message id)')
  assert.equal(conversationDecideInput({ providerMessageSid: 'SM1', revision: 2 }).inbound_revision, 'dc')
})

test('hook gate: shadow env on but the R2 runtime gate closed ⇒ nothing is enqueued (a job no tick would claim is never created)', async () => {
  const store = armedStore()
  const logs = []
  let pending = null
  const r = scheduleConversationAiShadow({ providerMessageSid: 'SMx', messageBody: 'hi' }, { env: ON, getStore: async () => store, log: (e) => logs.push(e), defer: (fn) => { pending = fn() } })
  assert.equal(r.scheduled, true)
  await pending // the real runtime gate (AGENT_ENABLED / AGENT_RUNTIME_ENABLED unset here)
  assert.equal(store._state.jobs.size, 0)
  assert.deepEqual(logs.map((l) => l.code), ['AGENT_RUNTIME_ENABLED_OFF'])
})

// ── 2. the wiring order: version → existing record → bounded thread read ──
test('context retrieval: bounded (≤ 40 events of a 500-message thread, ≤ 60 queue rows); a duplicate / stale-version job reads ONE row and never the thread', async () => {
  const t = threadTables({ events: 500 })
  for (let i = 0; i < 200; i += 1) t.send_queue.push({ id: `q${i}`, thread_key: 'tk1', use_case_template: 'ownership_check', queue_status: 'sent', scheduled_for_utc: null, created_at: new Date(Date.parse(NOW) - i * 60_000).toISOString() })
  const shadowRows = new Map()
  const sb = fakeSupabase(t, { shadowStoreRows: shadowRows })
  const provider = fakeProvider((p) => (p.tools[0].name === 'record_conversation_decision' && p.max_tokens === 200 ? semanticOk : routineDecision()))
  const ctx = jobCtx()
  const version = inboundVersionOf(SID, t.message_events.at(-1).message_body)
  const r = await runConversationAiShadowForInbound({ providerMessageSid: SID, inboundVersion: version, env: ON, supabase: sb, provider, tracker: runtimeJobTracker(ctx), remainingMs: ctx.remainingMs, signal: ctx.signal })
  assert.equal(r.code, 'SHADOW_RECORDED', JSON.stringify(r).slice(0, 400))
  const evRead = sb.log.reads.filter((x) => x.table === 'message_events')
  assert.deepEqual(evRead.slice(0, 2).map((x) => x.limit), [1, CONTEXT_LIMITS.events], 'one inbound row, then ≤ 40 thread rows')
  assert.ok(evRead[1].n <= 40)
  // every read is LIMITed (the remaining message_events read is the EXISTING send-time contact guard, dry run, ≤ 200)
  assert.ok(sb.log.reads.every((x) => x.limit != null && x.limit <= 200), JSON.stringify(sb.log.reads))
  assert.ok(sb.log.reads.filter((x) => x.table === 'send_queue').every((x) => x.n <= 200))
  assert.ok(sb.log.rowsServed < 500 + 200, `rows served ${sb.log.rowsServed} of a ${t.message_events.length + t.send_queue.length}-row thread`)
  assert.equal(r.record.inbound_version, version)
  assert.equal(r.record.send_status, 'not_sent_shadow')
  assert.deepEqual(sb.log.writes.map((w) => w.table), ['conversation_ai_shadow_decisions'], 'the ONLY write is the shadow row')

  // the same version again (retry / duplicate job): one inbound read + one record read, no thread, no model
  const callsBefore = provider.calls.length
  const sb2 = fakeSupabase(t, { shadowStoreRows: shadowRows })
  const again = await runConversationAiShadowForInbound({ providerMessageSid: SID, inboundVersion: version, env: ON, supabase: sb2, provider, tracker: runtimeJobTracker(jobCtx()) })
  assert.equal(again.code, 'DUPLICATE_INBOUND')
  assert.deepEqual(sb2.log.reads.map((x) => x.table), ['conversation_ai_reply_policy', 'message_events', 'conversation_ai_shadow_decisions'])
  assert.equal(provider.calls.length, callsBefore)

  // an explicit reprocess (revision 1) of a decided message: distinct job, the stored decision stands (one row per inbound id)
  const sb3 = fakeSupabase(t, { shadowStoreRows: shadowRows })
  const rep = await runConversationAiShadowForInbound({ providerMessageSid: SID, inboundVersion: inboundVersionOf(SID, t.message_events.at(-1).message_body, 1), inboundRevision: 1, env: ON, supabase: sb3, provider, tracker: runtimeJobTracker(jobCtx()) })
  assert.equal(rep.code, 'PRIOR_VERSION_RECORDED')
  assert.equal(sb3.log.reads.filter((x) => x.table === 'message_events').length, 1)

  // a job enqueued for a body the store no longer holds: refused before any record / thread read
  const sb4 = fakeSupabase(threadTables({ body: 'What would you offer me for it?' }), { shadowStoreRows: new Map() })
  const stale = await runConversationAiShadowForInbound({ providerMessageSid: SID, inboundVersion: inboundVersionOf(SID, 'an older body'), env: ON, supabase: sb4, provider, tracker: runtimeJobTracker(jobCtx()) })
  assert.equal(stale.code, 'INBOUND_VERSION_MISMATCH')
  assert.deepEqual(sb4.log.reads.map((x) => x.table), ['conversation_ai_reply_policy', 'message_events'])
  assert.equal(provider.calls.length, callsBefore)
})

// ── 3. spend: $0.01 per routine reply; hold (NEEDS_REVIEW) when it does not fit ──
test('spend: a routine reply (Haiku decision + semantic check) fits the $0.01 job reserve; the Sonnet escalation does not ⇒ not attempted, recorded NEEDS_REVIEW hold, no draft', async () => {
  // routine
  const t = threadTables()
  const ctx = jobCtx()
  const provider = fakeProvider((p) => (p.max_tokens === 200 ? semanticOk : routineDecision()))
  const r = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(t, { shadowStoreRows: new Map() }), provider, tracker: runtimeJobTracker(ctx), remainingMs: ctx.remainingMs, signal: ctx.signal })
  assert.equal(r.record.decision.outcome, 'REPLY_CANDIDATE')
  const reserves = ctx.ledger.filter((x) => x.op === 'reserve')
  assert.equal(reserves.length, 2, 'decision + semantic check')
  assert.ok(reserves.every((x) => x.usd > 0 && x.usd <= ROUTINE_REPLY_RESERVE_USD), JSON.stringify(reserves))
  assert.ok(reserves[0].usd + reserves[1].usd <= ROUTINE_REPLY_RESERVE_USD, 'both worst cases together fit $0.01')

  // escalation: a Haiku reply candidate flags complex_negotiation (8.5.15: Sonnet only
  // for a candidate); Sonnet's worst case (≈ $0.07) cannot fit what is left of $0.01
  const ctx2 = jobCtx()
  const p2 = fakeProvider(() => routineDecision({ escalation_required: true, escalation_reason: 'complex_negotiation' }))
  const r2 = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(threadTables(), { shadowStoreRows: new Map() }), provider: p2, tracker: runtimeJobTracker(ctx2), remainingMs: ctx2.remainingMs, signal: ctx2.signal })
  assert.equal(r2.code, 'SHADOW_RECORDED')
  assert.equal(r2.record.decision.outcome, 'NEEDS_REVIEW')
  assert.equal(r2.record.draft, null)
  assert.equal(p2.calls.length, 1, 'Sonnet was never called')
  assert.ok(p2.calls.every((c) => c.model === 'claude-haiku-5-5'))
  assert.equal(ctx2.ledger.filter((x) => x.op === 'reserve').length, 1, 'no reservation for the refused escalation')
  assert.match(JSON.stringify(r2.record), /JOB_BUDGET_INSUFFICIENT/)

  // cap 0 (event budget not armed): the DB guard decides ⇒ the job stop propagates (budget_blocked), no record
  const t3 = jobCtx({ cap: 0 })
  t3.reserve = async () => { const { RuntimeStop } = await import('../../src/lib/agent/runtime/runtime-tick.js'); throw new RuntimeStop('budget_blocked') }
  const rows3 = new Map()
  await assert.rejects(runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(threadTables(), { shadowStoreRows: rows3 }), provider: fakeProvider(routineDecision()), tracker: runtimeJobTracker(t3) }), (e) => e.abortJob === true)
  assert.equal(rows3.size, 0)
})

test('tracker: pre-check counts settled actuals and open reservations of THIS attempt; never reserves past the cap', async () => {
  const ctx = jobCtx({ cap: 0.01 })
  const tr = runtimeJobTracker(ctx)
  const a = await tr.reserve(0.004, 'claude-haiku-5-5')
  await assert.rejects(tr.reserve(0.007, 'claude-haiku-5-5'), (e) => e.code === 'JOB_BUDGET_INSUFFICIENT' && e.abortJob !== true)
  await tr.settle(a, 0.001, { input_tokens: 1, output_tokens: 1 })
  const b = await tr.reserve(0.007, 'claude-haiku-5-5') // 0.001 committed + 0.007 ≤ 0.01
  await tr.abandon(b) // died after reserve: the worst case is committed
  await assert.rejects(tr.reserve(0.003, 'claude-haiku-5-5'), (e) => e.code === 'JOB_BUDGET_INSUFFICIENT')
  assert.deepEqual(tr.snapshot(), { cap: 0.01, committed: 0.008, open: 0 })
  assert.equal(ctx.ledger.filter((x) => x.op === 'reserve').length, 2)
})

// ── 4. timeouts ────────────────────────────────────────────────────────────
test('deadline: with < 3 s of job time left no call starts (no reservation) ⇒ JOB_DEADLINE job stop; a hung provider is cut at the job remaining time and recorded as a hold', async () => {
  const provider = fakeProvider(routineDecision())
  const ledger = []
  const tracker = { async reserve(w) { ledger.push(w); return { worst: w } }, async settle() {}, async abandon() {}, async release() {} }
  const mc = createConversationModelClient({ provider, tracker, env: {}, remainingMs: () => MIN_CALL_MS })
  await assert.rejects(mc.decide({ system: 's', user: 'u', inputSchema: { type: 'object' } }), (e) => e.code === 'JOB_DEADLINE' && e.abortJob === true)
  assert.equal(ledger.length, 0)
  assert.equal(provider.calls.length, 0)

  // a hung provider: the call timeout is min(45 s, remaining − 1 s) = 3.2 s here
  const hung = fakeProvider((p, n, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'PROVIDER_ABORTED', billed: 'unknown' })))))
  const ctx = jobCtx({ remaining: 4_200 })
  const t0 = Date.now()
  const r = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(threadTables(), { shadowStoreRows: new Map() }), provider: hung, tracker: runtimeJobTracker(ctx), remainingMs: () => 4_200 - (Date.now() - t0), signal: ctx.signal })
  assert.ok(Date.now() - t0 < 4_200, 'cut before the job deadline')
  assert.equal(r.record.decision.outcome, 'NEEDS_REVIEW')
  assert.deepEqual(ctx.ledger.map((x) => x.op), ['reserve', 'settle'], 'the died call settles its worst case (never released on a guess)')
})

test('deadline: the tick abandons an over-running conversation.decide job (retry), and the abandoned attempt can never write a record', async () => {
  const store = createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research: { enabled: true, day_usd: 1, run_usd: 0.05 } })
  await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: SID, input: conversationDecideInput({ providerMessageSid: SID }) })
  const rows = new Map()
  let release
  const gate = new Promise((r) => { release = r })
  const run = async (args) => {
    await gate // hangs past the tick budget
    return runConversationAiShadowForInbound({ ...args, supabase: fakeSupabase(threadTables(), { shadowStoreRows: rows }), provider: fakeProvider(routineDecision()) })
  }
  const s = await runRuntimeTick({ store, handlers: { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ run, env: ON }) }, workerId: 'w1', budgetMs: 4_500, minClaimMs: 100 })
  assert.equal(s.jobs[0].outcome, 'retry')
  assert.equal([...store._state.jobs.values()][0].state, 'retrying')
  release()
  for (let i = 0; i < 20; i += 1) await flush()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(rows.size, 0, 'the late attempt wrote nothing')
})

// ── 5. fail closed on model / auth unavailability ──────────────────────────
test('fail closed: no provider key (auth unavailable) ⇒ no model, no spend, NEEDS_REVIEW hold; provider 401 ⇒ reservation released, NEEDS_REVIEW; 5xx ⇒ worst case settled, NEEDS_REVIEW; never a draft', async () => {
  const noKey = createAnthropicProvider({ env: {} })
  const ctx = jobCtx()
  const r = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(threadTables(), { shadowStoreRows: new Map() }), provider: noKey, tracker: runtimeJobTracker(ctx), remainingMs: ctx.remainingMs, signal: ctx.signal })
  assert.equal(r.record.decision.outcome, 'NEEDS_REVIEW')
  assert.equal(r.record.draft, null)
  assert.equal(ctx.ledger.length, 0, 'nothing reserved')
  assert.equal(r.record.cost.total_usd, 0)

  for (const [err, ops] of [[Object.assign(new Error('401'), { code: 'PROVIDER_AUTH', billed: 'no' }), ['reserve', 'release']], [Object.assign(new Error('529'), { code: 'PROVIDER_OVERLOADED', billed: 'unknown' }), ['reserve', 'settle']]]) {
    const c = jobCtx()
    const out = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: fakeSupabase(threadTables(), { shadowStoreRows: new Map() }), provider: fakeProvider(err), tracker: runtimeJobTracker(c), remainingMs: c.remainingMs, signal: c.signal })
    assert.equal(out.record.decision.outcome, 'NEEDS_REVIEW', err.code)
    assert.equal(out.record.draft, null)
    assert.equal(out.record.send_status, 'not_sent_shadow')
    assert.deepEqual(c.ledger.map((x) => x.op), ops, err.code)
  }

  // the shadow store unreadable ⇒ the job fails before any model call (never "no record yet")
  const broken = fakeSupabase(threadTables())
  const origFrom = broken.from
  broken.from = (tbl) => (tbl === 'conversation_ai_shadow_decisions' ? { select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }) }) } : origFrom(tbl))
  const p = fakeProvider(routineDecision())
  await assert.rejects(runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: broken, provider: p, tracker: runtimeJobTracker(jobCtx()) }), (e) => e.code === 'SHADOW_READ_FAILED')
  assert.equal(p.calls.length, 0)

  // the policy row unreadable / shadow off ⇒ the gate refuses before any read of the thread
  const off = fakeSupabase({ ...threadTables(), conversation_ai_reply_policy: [] })
  const g = await runConversationAiShadowForInbound({ providerMessageSid: SID, env: ON, supabase: off, provider: p, tracker: runtimeJobTracker(jobCtx()) })
  assert.equal(g.ran, false)
  assert.deepEqual(off.log.reads.map((x) => x.table), ['conversation_ai_reply_policy'])
})

// ── 6. the R2 tick drives the handler end to end (memory store) ────────────
test('tick: hook → enqueue → tick → handler → shadow record; codes-only job result; a second tick finds nothing to do', async () => {
  const store = createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research: { enabled: true, day_usd: 10, run_usd: 2.5 } })
  const t = threadTables()
  scheduleConversationAiShadow({ providerMessageSid: SID, messageBody: t.message_events.at(-1).message_body, deterministic: { intent: 'asks_offer' } }, { env: ON, getStore: async () => store, gate: GATE_OPEN })
  for (let i = 0; i < 4; i += 1) await flush()
  // event jobs carry budget_cap_usd from kind_limits only in SQL (PROPOSED_20261013161000); the memory store keeps 0 ⇒ set the armed $0.01 here
  for (const j of store._state.jobs.values()) j.budget_cap_usd = ROUTINE_REPLY_RESERVE_USD
  const rows = new Map()
  const provider = fakeProvider((p) => (p.max_tokens === 200 ? semanticOk : routineDecision()))
  const run = (args) => runConversationAiShadowForInbound({ ...args, supabase: fakeSupabase(t, { shadowStoreRows: rows }), provider })
  const handlers = { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ run, env: ON }) }
  const s = await runRuntimeTick({ store, handlers, workerId: 'w1', budgetMs: 15_000 })
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  const job = [...store._state.jobs.values()][0]
  assert.equal(job.result.code, 'SHADOW_RECORDED')
  assert.equal(job.result.send_status, 'not_sent_shadow')
  assert.ok(!/[0-9]{3}/.test(JSON.stringify(job.result).replace(/"cost_usd":[0-9.e-]+/, '')), 'codes only')
  assert.equal(rows.size, 1)
  const s2 = await runRuntimeTick({ store, handlers, workerId: 'w1', budgetMs: 5_000 })
  assert.equal(s2.claimed, 0)
})

// ── 7. ops.health_check: event-driven heartbeat ────────────────────────────
const at = '2026-10-14T11:00:00.000Z' // 06:00 Central
const keysAt = (followup) => ({ queue_processor_heartbeat_at: '2026-10-14T10:59:30.000Z', campaign_feeder_heartbeat_at: '2026-10-14T10:56:00.000Z', followup_no_response_heartbeat_at: followup, seller_state_reconcile_heartbeat_at: '2026-10-14T10:56:00.000Z', webhook_delivery_recovery_last_at: '2026-10-14T10:56:00.000Z' })
const fu = (snapshot) => evaluateHealthSnapshot(snapshot).heartbeats.find((h) => h.key === 'followup_no_response_heartbeat_at')

test('health: the follow-up heartbeat is judged against the newest delivery — 8 h quiet overnight is fresh; a delivery 1 h after it is stale; no reference ⇒ unverified (no alarm < 24 h)', async () => {
  // last delivery 02:56Z, heartbeat stamped by that receipt, check at 11:00Z (8 h later): fresh, idle
  let h = fu({ at, keys: keysAt('2026-10-14T02:56:10.000Z'), deliveries: { last_delivered_at: '2026-10-14T02:56:05.000Z' } })
  assert.equal(h.status, 'fresh'); assert.equal(h.idle, true); assert.ok(h.age_seconds > 8 * 3600)
  // the throttle (60 s / process) and processing lag inside the 15-minute grace: fresh
  h = fu({ at, keys: keysAt('2026-10-14T10:40:00.000Z'), deliveries: { last_delivered_at: '2026-10-14T10:49:00.000Z' } })
  assert.equal(h.status, 'fresh')
  // deliveries kept landing for an hour after the last heartbeat: the leg is not running
  h = fu({ at, keys: keysAt('2026-10-14T09:50:00.000Z'), deliveries: { last_delivered_at: '2026-10-14T10:50:00.000Z' } })
  assert.equal(h.status, 'stale'); assert.equal(h.lag_seconds, 3600)
  // no delivery in 7 days: idle, fresh
  assert.equal(fu({ at, keys: keysAt('2026-10-10T02:00:00.000Z'), deliveries: { last_delivered_at: null } }).status, 'fresh')
  // the older snapshot function (no deliveries field): never fresh, never a false stale overnight
  assert.equal(fu({ at, keys: keysAt('2026-10-14T02:56:10.000Z') }).status, 'unverified')
  assert.equal(fu({ at, keys: keysAt('2026-10-13T02:56:10.000Z') }).status, 'stale', 'beyond the 24 h ceiling')
  // missing / unparseable keep their meaning
  assert.equal(fu({ at, keys: keysAt(undefined), deliveries: { last_delivered_at: null } }).status, 'missing')
  assert.equal(fu({ at, keys: keysAt('garbage'), deliveries: { last_delivered_at: null } }).status, 'unparseable')
  // cron lanes are unchanged: queue processor 2 h old is stale regardless of deliveries
  assert.equal(evaluateHealthSnapshot({ at, keys: { ...keysAt('2026-10-14T02:56:10.000Z'), queue_processor_heartbeat_at: '2026-10-14T09:00:00.000Z' }, deliveries: { last_delivered_at: null } }).heartbeats[0].status, 'stale')
  assert.deepEqual(Object.keys(EVENT_DRIVEN_HEARTBEATS), ['followup_no_response_heartbeat_at'])
})

test('health: overnight run end to end — no finding for the quiet follow-up leg; a stale one is a finding naming the lag', async () => {
  const run = async (snapshot) => {
    const findings = []
    const ctx = { job: { input: {} }, step: async () => ({ ok: true }), read: { healthSnapshot: async () => snapshot }, recordFinding: async (f) => { findings.push(f); return 'f' } }
    const out = await opsHealthCheckHandler.run(ctx)
    return { out, findings }
  }
  const quiet = await run({ at, keys: keysAt('2026-10-14T02:56:10.000Z'), queue: {}, deliveries: { last_delivered_at: '2026-10-14T02:56:05.000Z' } })
  assert.equal(quiet.out.result.healthy, true, JSON.stringify(quiet.findings))
  assert.equal(quiet.out.result.heartbeats.followup_no_response_heartbeat_at, 'fresh')
  const legacy = await run({ at, keys: keysAt('2026-10-14T02:56:10.000Z'), queue: {} })
  assert.equal(legacy.out.result.healthy, true)
  assert.equal(legacy.out.result.heartbeats.followup_no_response_heartbeat_at, 'unverified')
  const bad = await run({ at, keys: keysAt('2026-10-14T09:50:00.000Z'), queue: {}, deliveries: { last_delivered_at: '2026-10-14T10:50:00.000Z' } })
  assert.equal(bad.findings.length, 1)
  assert.equal(bad.findings[0].finding_type, 'ops.heartbeat_stale')
  assert.equal(bad.findings[0].value.lag_seconds, 3600)
  assert.equal(bad.findings[0].value.mode, 'event_driven')
})
