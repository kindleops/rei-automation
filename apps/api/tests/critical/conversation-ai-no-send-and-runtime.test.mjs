// Conversation Engine 2.0 — NO SEND PATH (static + runtime) and the live-shadow runtime hook.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { importClosure, listFiles, chainTo, SRC } from '../helpers/import-graph.mjs'
import { scheduleConversationAiShadow, conversationDecideInput, decodeRef, CONVERSATION_DECIDE_KIND } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { createConversationDecideHandler, conversationRuntimeHandlers, runtimeJobTracker } from '../../src/lib/ai/conversation-decide-handler.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createConversationModelClient } from '../../src/lib/domain/conversation-ai/model-client.js'

// Every module that can transmit a message or write a send row (audit 2026-10-13 §"forbidden").
const FORBIDDEN = [
  'lib/providers/textgrid.js', 'lib/verification/live-textgrid.js', 'lib/providers/email.js', 'lib/providers/gmail.js',
  'lib/supabase/sms-engine.js', 'lib/domain/queue/canonical-queue-writer.js', 'lib/flows/queue-outbound-message.js',
  'lib/automation/queueAutoReply.js', 'lib/domain/seller-flow/maybe-queue-seller-stage-reply.js',
  'lib/domain/seller-flow/seller-followup-scheduler.js', 'lib/domain/seller-flow/delivery-triggered-followup.js',
  'lib/discord/inbound-autopilot-queue.js', 'lib/email/queue-email.js',
  'lib/domain/queue/process-send-queue.js', 'lib/domain/queue/run-send-queue.js', 'lib/domain/queue/retry-send-queue.js', 'lib/domain/queue/block-send-at-compliance.js',
  'lib/domain/inbox/send-now-service.js', 'lib/domain/outbound/send-now-request.js', 'app/api/dev/force-send/route.js', 'lib/domain/buyers/send-buyer-blast.js',
  'lib/domain/seller-flow/apply-inbound-automation-decision.js', 'lib/domain/seller-flow/process-seller-inbound-message.js', 'lib/flows/handle-textgrid-inbound.js',
].map((p) => path.join(SRC, p))
const SEND_NAME_RE = /(send[-_]?now|send[-_]queue|sms-engine|textgrid|queue-writer|queueAutoReply|enqueue[A-Z]|force-send|buyer-blast)/i

function assertNoSend(entries, label, { allowExternal = [] } = {}) {
  const g = importClosure(entries)
  for (const f of FORBIDDEN) assert.ok(!g.files.has(f), `${label} reaches ${path.relative(SRC, f)} via ${chainTo(f, g.parents).join(' <- ')}`)
  for (const f of g.files) assert.ok(!SEND_NAME_RE.test(path.relative(SRC, f)), `${label} reaches a send-named module ${chainTo(f, g.parents).join(' <- ')}`)
  const ext = [...g.externals].filter((e) => !e.startsWith('node:') && !allowExternal.includes(e))
  return { g, ext }
}

test('static: NO import path from lib/domain/conversation-ai to any send function, transport, or queue writer', () => {
  const entries = listFiles(path.join(SRC, 'lib/domain/conversation-ai'))
  assert.ok(entries.length >= 15)
  const { g, ext } = assertNoSend(entries, 'conversation-ai', { allowExternal: ['axios'] })
  // the only third-party module in the closure is axios, via the (dead) Podio schema helpers that
  // extract-seller-facts → stage6 → state-machine import for constants; no provider SDK, no HTTP client of ours
  assert.deepEqual(ext, [])
  assert.ok(![...g.externals].some((e) => /anthropic|openai|textgrid|twilio|brevo|nodemailer/i.test(e)))
  assert.ok(![...g.files].some((f) => /lib\/providers\/(?!podio\.js)/.test(f)), 'no provider other than the dead Podio schema module')
})

test('static: the hook, the decision modules and the wiring reach no send function either', () => {
  // rc-8.5.21: every module that DECIDES (the canonical runtime, its input loader, the shadow wiring,
  // the turn decider, the review-draft service) reaches no send function; only the turn dispatcher does
  for (const f of ['lib/ai/conversation-ai-shadow-hook.js']) assertNoSend([path.join(SRC, f)], f)
  for (const f of ['lib/ai/conversation-ai-shadow-wiring.js', 'lib/ai/conversation-turn-wiring.js', 'lib/ai/conversation-canonical-inputs.js', 'lib/ai/conversation-ai-draft-service.js']) {
    assertNoSend([path.join(SRC, f)], f, { allowExternal: ['@anthropic-ai/sdk', 'axios', '@supabase/supabase-js'] })
  }
})

test('runtime: a model call never happens without a reservation; fetch is never touched by the engine', async () => {
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('no network') }
  try {
    const provider = { async listModels() { return [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' }] }, async createMessage() { throw new Error('must not be called') } }
    const tracker = { async reserve() { throw Object.assign(new Error('JOB_STOP'), { abortJob: true, code: 'JOB_STOP' }) }, async settle() {}, async abandon() {} }
    const mc = createConversationModelClient({ provider, tracker, env: {} })
    await assert.rejects(() => mc.decide({ system: 's', user: 'u', inputSchema: { type: 'object' } }), (e) => e.abortJob === true)
    assert.equal(fetches, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── live shadow hook → R2 runtime ─────────────────────────────────────────
const OP = '7b0c1e6c-2c4f-4bb1-9d2a-5f4bb6f0e001'
const ON = { AI_CONVERSATION_SHADOW_ENABLED: 'true' }
const armedStore = (research = { enabled: false }) => createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research })
const flush = () => new Promise((r) => setImmediate(r))

test('hook: off by default — nothing scheduled, nothing imported, nothing enqueued', () => {
  let deferred = 0
  const r = scheduleConversationAiShadow({ providerMessageSid: 'SMabc' }, { env: {}, defer: () => { deferred += 1 } })
  assert.equal(r.code, 'SHADOW_ENV_OFF')
  assert.equal(deferred, 0)
  assert.deepEqual(conversationRuntimeHandlers({}), {}, 'the tick never registers the kind while the env gate is off')
})

test('hook: duplicate inbound (repeat webhook, parallel) → ONE conversation.decide job', async () => {
  const store = armedStore()
  const opts = { env: ON, getStore: async () => store, gate: async () => ({ enabled: true, reason: null }) }
  for (let i = 0; i < 3; i += 1) scheduleConversationAiShadow({ providerMessageSid: 'SM123abc', deterministic: { intent: 'asks_offer' } }, opts)
  await flush(); await flush(); await flush()
  const st = await store.status?.()
  const second = await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: 'SM123abc', input: {} })
  assert.equal(second.deduped, true, 'the event key (inbound message id) dedupes')
  const claimed = await store.claim({ worker: 'w', limit: 5, kinds: [CONVERSATION_DECIDE_KIND] })
  assert.equal(claimed.claimed.length, 1, JSON.stringify(st || {}))
  assert.equal(decodeRef(claimed.claimed[0].input.inbound_ref), 'SM123abc')
})

test('hook: job input is clean (no digits, no text) and a different inbound is a different job', async () => {
  const inp = conversationDecideInput({ providerMessageSid: 'SM6125550147', deterministic: { intent: 'asks_offer', compliance_flag: 'x y' } })
  assert.ok(!/[0-9]/.test(JSON.stringify(inp)), JSON.stringify(inp))
  assert.equal(inp.compliance_flag, null)
  const store = armedStore()
  const a = await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: 'SM1', input: {} })
  const b = await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: 'SM2', input: {} })
  assert.notEqual(a.job_id, b.job_id)
  const unarmed = createRuntimeMemoryStore({ limits: { runtime_enabled: true } })
  assert.equal((await unarmed.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: 'SM1', input: {} })).reason, 'kind_not_armed')
})

test('runtime: spend off ⇒ the job is budget_blocked at its first model reservation (no record, no call)', async () => {
  const store = armedStore({ enabled: false })
  await store.enqueueEvent({ kind: CONVERSATION_DECIDE_KIND, event_key: 'SMbudget', input: conversationDecideInput({ providerMessageSid: 'SMbudget' }) })
  let modelCalls = 0
  const run = async ({ tracker }) => {
    await tracker.reserve(0.002, 'claude-haiku-5-5') // what the model client does before every call
    modelCalls += 1
    return { code: 'SHADOW_RECORDED' }
  }
  const handler = createConversationDecideHandler({ run, env: ON })
  const s = await runRuntimeTick({ store, handlers: { [CONVERSATION_DECIDE_KIND]: handler }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s.jobs.length, 1)
  assert.equal(s.jobs[0].outcome, 'budget_blocked', JSON.stringify(s.jobs[0]))
  assert.equal(modelCalls, 0)
})

test('runtime: with spend on, the handler reserves + settles on the job and returns codes only', async () => {
  const store = createRuntimeMemoryStore({ limits: { runtime_enabled: true, kind_limits: { [CONVERSATION_DECIDE_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } }, research: { enabled: true, day_usd: 1, run_usd: 0.05 } })
  // event jobs carry budget_cap_usd 0 until PROPOSED_20261013161000 is applied: use a manual enqueue with a cap here
  const { runtimeIdempotencyKey } = await import('../../src/lib/agent/runtime/job-runtime.js')
  await store.enqueue({ kind: CONVERSATION_DECIDE_KIND, idempotency_key: runtimeIdempotencyKey('t', 'SMspend'), input: conversationDecideInput({ providerMessageSid: 'SMspend' }), requested_by: OP, budget_cap_usd: 0.05 })
  const seen = []
  const run = async ({ providerMessageSid, tracker }) => {
    const tok = await tracker.reserve(0.002, 'claude-haiku-5-5')
    await tracker.settle(tok, 0.0007, { input_tokens: 1000, output_tokens: 100 })
    seen.push(providerMessageSid)
    return { code: 'SHADOW_RECORDED', record: { decision: { outcome: 'NO_RESPONSE' }, validation: { status: 'not_applicable' }, model: { path: 'haiku' }, cost: { total_usd: 0.0007 }, send_status: 'not_sent_shadow' } }
  }
  const s = await runRuntimeTick({ store, handlers: { [CONVERSATION_DECIDE_KIND]: createConversationDecideHandler({ run, env: ON }) }, workerId: 'w1', budgetMs: 10_000 })
  assert.equal(s.jobs[0].outcome, 'completed', JSON.stringify(s))
  assert.deepEqual(seen, ['SMspend'])
})

test('runtime tracker: an unbilled provider refusal releases; a died call settles the worst case', async () => {
  const settles = []
  const ctx = { reserve: async () => 'r1', settle: async (id, usd) => { settles.push([id, usd]) } }
  const t = runtimeJobTracker(ctx)
  const tok = await t.reserve(0.01, 'claude-haiku-5-5')
  await t.release(tok)
  await t.abandon(tok)
  assert.deepEqual(settles, [['r1', null], ['r1', 0.01]])
})

// ── R3: exactly ONE module may reach the queue insertion function (rc-8.5.21: wired via ONE dispatcher) ──
const R3_EXECUTOR = path.join(SRC, 'lib/ai/conversation-ai-r3-executor.js')
const R3_DISPATCHER = path.join(SRC, 'lib/ai/conversation-turn-dispatch.js')
const QUEUE_INSERT = path.join(SRC, 'lib/supabase/sms-engine.js')
const R3_DIRECT_IMPORTS = [
  'lib/supabase/sms-engine.js', 'lib/system-control.js', 'lib/domain/events/idempotency-ledger.js', 'lib/domain/queue/queue-control-safety.js', 'lib/domain/queue/reply-timing.js',
  'lib/domain/conversation-ai/context-builder.js', 'lib/domain/conversation-ai/eligibility-bridge.js', 'lib/domain/conversation-ai/fact-ledger.js',
  'lib/domain/conversation-ai/questions.js', 'lib/domain/conversation-ai/send-policy.js', 'lib/domain/conversation-ai/outbound-validator.js',
  'lib/domain/messages/ai-generated-message.js', 'lib/domain/queue/cancel-supabase-pending-outbound.js', 'lib/domain/conversation-ai/company-identity.js',
  'lib/domain/conversation-ai/playbook/v3/style-validator.js', 'lib/domain/conversation-ai/pipeline/outcomes.js', 'lib/domain/conversation-ai/runtime/canonical.js',
  'lib/domain/conversation-ai/persona-continuity.js', 'lib/ai/conversation-canonical-inputs.js', 'lib/domain/holds-port/automation-hold-port.js',
  // blind-eval S1: the per-property ownership facts (pure; the recontact guard's evidence)
  'lib/domain/conversation-ai/property-ownership.js',
  // rc-8.5.21 v4 (S2): the ONE combined stop reading (pure) — R3 never replies to a stop-like turn
  'lib/domain/conversation-ai/stop-reading.js',
  // rc-8.5.21 v4 (rt-sc-03): read-only attempt evidence — a stale seller-day holder is reclaimed only when it
  // provably never reached the provider
  'lib/domain/communications/queue-row-attempt-evidence.js',
].sort()

function directImports(file) {
  const g = importClosure([file])
  return [...g.parents.entries()].filter(([, parent]) => parent === file).map(([child]) => path.relative(SRC, child)).sort()
}

test('static R3: decision modules (conversation-ai/**, hook, shadow + turn wiring, inputs, draft service) never reach the R3 executor or the queue insertion function', () => {
  const deciders = [...listFiles(path.join(SRC, 'lib/domain/conversation-ai')), ...['lib/ai/conversation-ai-shadow-hook.js', 'lib/ai/conversation-ai-shadow-wiring.js', 'lib/ai/conversation-turn-wiring.js', 'lib/ai/conversation-canonical-inputs.js', 'lib/ai/conversation-ai-draft-service.js'].map((f) => path.join(SRC, f))]
  for (const entry of deciders) {
    const g = importClosure([entry])
    assert.ok(!g.files.has(R3_EXECUTOR), `${path.relative(SRC, entry)} reaches the R3 executor via ${chainTo(R3_EXECUTOR, g.parents).join(' <- ')}`)
    assert.ok(!g.files.has(QUEUE_INSERT), `${path.relative(SRC, entry)} reaches the queue insertion function via ${chainTo(QUEUE_INSERT, g.parents).join(' <- ')}`)
  }
  for (const f of ['fact-ledger.js', 'send-policy.js', 'runtime/canonical.js', 'outbound-validator.js']) assert.ok(deciders.includes(path.join(SRC, 'lib/domain/conversation-ai', f)))
  // the runtime handlers reach R3 ONLY through the turn handler → the ONE dispatcher module
  const g = importClosure([path.join(SRC, 'lib/ai/conversation-decide-handler.js')])
  assert.deepEqual(chainTo(R3_EXECUTOR, g.parents), ['lib/ai/conversation-decide-handler.js', 'lib/ai/conversation-turn-handler.js', 'lib/ai/conversation-turn-dispatch.js', 'lib/ai/conversation-ai-r3-executor.js'])
})

test('static R3: the executor is the ONLY allowlisted path — fixed direct imports, no transport, ONE importer (the turn dispatcher)', async () => {
  const fs = await import('node:fs')
  assert.deepEqual(directImports(R3_EXECUTOR), R3_DIRECT_IMPORTS)
  const g = importClosure([R3_EXECUTOR])
  assert.ok(g.files.has(QUEUE_INSERT), 'the executor reaches insertSupabaseSendQueueRow (sms-engine.js)')
  for (const f of FORBIDDEN) {
    if (f === QUEUE_INSERT) continue
    assert.ok(!directImports(R3_EXECUTOR).includes(path.relative(SRC, f)), `executor imports ${path.relative(SRC, f)} directly`)
  }
  const src = fs.readFileSync(R3_EXECUTOR, 'utf8').replace(/\/\/.*$/gm, '')
  assert.ok(!/sendTextgridSMS|textgrid|providers\/|fetch\(|axios/i.test(src), 'the executor names no provider / transport / HTTP client')
  assert.ok(/insertSupabaseSendQueueRow/.test(src))
  // wired through exactly ONE module
  const importers = listFiles(SRC).filter((f) => f !== R3_EXECUTOR && /conversation-ai-r3-executor/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')))
  assert.deepEqual(importers.map((f) => path.relative(SRC, f)), [path.relative(SRC, R3_DISPATCHER)])
  for (const f of ['lib/domain/queue/ai-conversation-row-gate.js', 'lib/domain/seller-flow/ai-conversation-coexistence.js']) {
    assert.ok(!importClosure([path.join(SRC, f)]).files.has(R3_EXECUTOR), f)
  }
})

test('runtime R3: the executor never touches fetch and never calls a provider (fake insert, real normalisation)', async () => {
  const { executeAiConversationReply } = await import('../../src/lib/ai/conversation-ai-r3-executor.js')
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; throw new Error('no network') }
  try {
    const on = { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: ['x'] } }) }
    const r = await executeAiConversationReply({ record: null, inbound: { id: 'i', thread_key: 'x' } }, { readSwitch: async (k) => on[k] ?? null })
    assert.equal(r.status, 'refused')
    assert.deepEqual(r.reasons, ['not_a_canonical_decision'])
    const off = await executeAiConversationReply({ record: null }, {})
    assert.equal(off.status, 'held')
    assert.deepEqual(off.reasons, ['kill_switch_off'], 'no Supabase config in test ⇒ the switch reads null ⇒ OFF')
    assert.equal(fetches, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})
