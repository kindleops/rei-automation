// rc-8.5.21 part A, Phases 2 + 6 + 11 — the WHOLE in-process chain, end to end, per scenario:
//   persisted inbound rows → routeInboundToTurn (the conversation.decide route) → the durable turn
//   (memory mirror of the SQL contract) → runDueTurn at the due time → the CANONICAL decider
//   (decideAndCompose, caller 'turn', real context loader, real ledger, real eligibility bridge)
//   → the R3 turn dispatcher (real executor, fresh-state re-validation, real reservations) →
//   the real queue insertion function (its DB write captured).
// The provider is a local fake: no network, $0. The PG version of the main path is in
// conversation-ai-8521-e2e-pg.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { routeInboundToTurn, createCanonicalTurnDecider, aiSendAuthorizedFor } from '../../src/lib/ai/conversation-turn-wiring.js'
import { createR3TurnDispatcher } from '../../src/lib/ai/conversation-turn-dispatch.js'
import { createMemoryTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { runDueTurn, handleConversationEvent, decodeTurnJobInput } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { decideAndCompose, CANONICAL_VERSIONS } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'
import { completeIdempotentProcessing } from '../../src/lib/domain/events/idempotency-ledger.js'
import { insertSupabaseSendQueueRow, shouldRunSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { resetMemoryIdempotencyLedger } from '../helpers/memory-idempotency-ledger.mjs'
import { makeAiRecords } from '../helpers/canonical-record.mjs'
import { fakeSupabase, fakeProvider } from '../helpers/conversation-ai-runtime-fakes.mjs'
import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY } from '../../src/lib/domain/conversation-ai/send-policy.js'

const SELLER = '+13125550101' // Chicago area code (fictional 555 line)
const OURS = '+13125550199'
const TK = SELLER
const ENV = { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }
const T0 = Date.parse('2026-10-14T17:00:00.000Z') // 12:00 CT
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const ON = { [AI_SEND_KILL_SWITCH_KEY]: 'true', [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: [TK] } }) }

function ev(id, direction, body, ms, extra = {}) {
  const out = direction === 'outbound'
  return { id, provider_message_sid: `SM${id}`, direction, thread_key: TK, from_phone_number: out ? OURS : SELLER, to_phone_number: out ? SELLER : OURS, message_body: body, event_timestamp: iso(ms), received_at: null, created_at: iso(ms), property_id: 'p1', prospect_id: 'pr1', detected_intent: null, language: 'en', queue_id: null, ...extra }
}

function world({ messages, queue = [], threadState = { thread_key: TK, our_number: OURS }, switches = ON, suppressions = [], properties = null, text = 'Good to know. Would you consider an offer on it?', judgment = null, capUsd = 0.05 } = {}) {
  const tables = {
    message_events: messages,
    send_queue: [{ id: 'q0', thread_key: TK, queue_status: 'sent', use_case_template: 'ownership_check', created_at: iso(T0 - 90 * MIN), agent_name: 'Helen', from_phone_number: OURS, message_body: 'Hi Dana, this is Helen. Do you still own the house on Oak St?', metadata: {} }, ...queue],
    seller_offers: [],
    properties: properties || [{ property_id: 'p1', property_type: 'SFR', property_address_city: 'Chicago', property_address_state: 'IL', property_address_zip: '60601', timezone: null, owner_1_name: 'Dana Q', property_address: '12 Oak St' }],
    prospects: [{ prospect_id: 'pr1', first_name: 'Dana', full_name: 'Dana Q', timezone: null }],
    inbox_thread_state: threadState ? [threadState] : [],
    conversation_ai_reply_policy: [{ id: 1, shadow_enabled: true, kill_switch_engaged: false, enabled: false }],
    sms_suppression_list: suppressions,
    automation_suppressions: [],
    phones: [],
  }
  const shadowRows = new Map()
  const sb = fakeSupabase(tables, { shadowStoreRows: shadowRows })
  let nowMs = T0
  const clock = { set: (ms) => { nowMs = ms }, now: () => nowMs, iso: () => iso(nowMs) }
  const store = createMemoryTurnStore({ now: () => nowMs })
  const jobs = []
  const runtimeStore = { enqueueEventAt: async (o) => { const dup = jobs.some((j) => j.event_key === o.event_key); if (!dup) jobs.push(o); return { ok: true, deduped: dup } } }
  const readSwitch = async (k) => switches[k] ?? null
  const provider = fakeProvider((p) => {
    if (p.tools[0].input_schema?.properties?.message) return { message: typeof text === 'function' ? text(p) : text }
    const latest = [...tables.message_events].filter((m) => m.direction === 'inbound').pop()
    return judgment ? judgment(latest) : makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'R1 TEXT NEVER SENT. Would you sell?', confidence: 0.93, source_message_ids: [latest.id], facts_extracted: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [latest.id], rationale: 'x' } })
  })
  const queueRows = []
  const records = makeAiRecords()
  const reservations = {
    verifyTurnHold: async ({ keys, token }) => keys.every((k) => store.reservations.get(k)?.status === 'processing' && store.reservations.get(k)?.token === token),
    complete: async (a) => {
      if (a.scope === 'inbound_reply' && store.reservations.has(a.key)) { store.reservations.get(a.key).status = 'completed'; store.reservations.get(a.key).outcome = a.metadata?.outcome; return { ok: true } }
      return completeIdempotentProcessing(a)
    },
  }
  const r3deps = {
    now: () => clock.iso(), readSwitch, reservations, insertRecord: (rec) => records.insert(rec), lookupRecord: records.load,
    lookupQueueRow: async (k) => { const row = queueRows.find((r) => r.queue_key === k); return { found: Boolean(row), read_failed: false, row: row || null } }, recordEvent: records.event,
    insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, { now: clock.iso(), insertSupabaseSendQueueRow: (row) => { if (queueRows.some((r) => r.queue_key === row.queue_key)) return { ok: false, reason: 'duplicate_queue_key' }; const stored = { ...row, id: crypto.randomUUID() }; queueRows.push(stored); return { ok: true, queue_row_id: stored.id, raw: stored } } }),
    cancelPending: async () => ({ ok: true, cancelled_count: 0 }),
  }
  const decider = (over = {}) => createCanonicalTurnDecider({ supabase: sb, env: ENV, tracker: createSpendTracker({ capUsd }), provider, readSwitch, now: () => clock.iso(), ...over })
  const dispatcher = (wrap = null) => {
    const d = createR3TurnDispatcher({ supabase: sb, jobId: 'job-1', deps: r3deps })
    return wrap ? wrap(d) : d
  }
  // rc-8.5.21 v4: a routed stop / possible stop / denial's protective effects (written by the runtime handler;
  // recorded here — the fake Supabase refuses writes)
  const effects = []
  const effectsDeps = { writers: {
    suppress: async (x) => { effects.push({ kind: 'opt_out', phone: x.phone }); return { ok: true } },
    precautionary: async (x) => { effects.push({ kind: 'precautionary_no_contact', phone: x.phone }); return { ok: true, held: true } },
    ownership: async (_sb, x) => { effects.push({ kind: 'property_denial', property_id: x.property_id, outcome: x.outcome }); return { ok: true } },
  } }
  const route = (sid, deterministic = null) => routeInboundToTurn({ providerMessageSid: sid, env: ENV, supabase: sb, runtimeStore, turnStore: store, now: clock.iso(), deterministic })
  /** run the latest job for its turn at (or after) its due time */
  const runLatest = async ({ decide = decider(), dispatch = dispatcher(), at = null } = {}) => {
    const job = jobs[jobs.length - 1]
    const ref = decodeTurnJobInput(job.input)
    clock.set(Math.max(clock.now(), Date.parse(at || job.not_before) + 1000))
    return runDueTurn({ ...ref, store, worker: 'w1', decideTurn: decide, dispatch, enqueueAt: (o) => runtimeStore.enqueueEventAt(o) })
  }
  return { tables, sb, clock, store, jobs, runtimeStore, provider, queueRows, records, decider, dispatcher, route, runLatest, shadowRows, readSwitch, effects, effectsDeps }
}

const OWN_Q = (ms) => ev('o1', 'outbound', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', ms)

test.beforeEach(() => resetMemoryIdempotencyLedger())

test('main path: persisted inbound → route → durable turn → canonical decision at due → R3 → ONE queued ai_generated row (+ immutable record, shadow record, reservation consumed)', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  const routed = await w.route('SMi1')
  assert.equal(routed.code, 'TURN_OPENED', JSON.stringify(routed))
  assert.equal(w.jobs.length, 1)
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DISPATCHED', JSON.stringify(r))
  assert.equal(r.dispatch, 'enqueued', JSON.stringify(r))
  assert.equal(w.queueRows.length, 1)
  const row = w.queueRows[0]
  assert.deepEqual([row.message_origin, row.source, row.queue_key, row.message_body], ['ai_generated', 'ai_conversation', 'ai_conversation:i1', 'Good to know. Would you consider an offer on it?'])
  assert.equal(row.agent_name, 'Helen')
  assert.equal(row.from_phone_number, OURS)
  assert.equal(row.metadata.writer_version, CANONICAL_VERSIONS.writer)
  assert.deepEqual(row.metadata.recipient_zones, ['America/Chicago'])
  assert.equal(row.metadata.conversational_reply.in_session, true)
  const rec = w.records.byKey.get('ai_conversation:i1')
  assert.equal(rec.audit_refs.writer_version, CANONICAL_VERSIONS.writer)
  assert.equal(rec.audit_refs.decision_caller, 'turn')
  assert.equal(w.store.reservations.get('i1').status, 'completed')
  assert.equal(w.shadowRows.size, 1, 'the decision is recorded')
  assert.ok(!JSON.stringify(row).includes('R1 TEXT'), 'the R1 proposed_message never reaches the queue')
})

test('OFF by default: switches absent ⇒ the decision is recorded, NOTHING is reserved or queued (the template engine keeps the inbound)', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], switches: {} })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW', JSON.stringify(r))
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.size, 0)
  assert.equal(w.shadowRows.size, 1)
  assert.deepEqual(await aiSendAuthorizedFor({ threadKey: TK, readSwitch: async () => null }), { ok: false, reason: 'kill_switch_off' })
})

test('repeated webhook: the same inbound routed 3x ⇒ ONE turn, ONE job, ONE reply', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  const rs = [await w.route('SMi1'), await w.route('SMi1'), await w.route('SMi1')]
  assert.deepEqual(rs.map((r) => r.code), ['TURN_OPENED', 'TURN_EVENT_DEDUPED', 'TURN_EVENT_DEDUPED'])
  assert.equal(w.jobs.length, 1)
  await w.runLatest()
  assert.equal(w.queueRows.length, 1)
})

test('multiple inbounds before the due time ⇒ ONE consolidated turn (v2), the v1 job is superseded, ONE reply reserving BOTH members', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes', T0 - 3 * MIN)]
  const w = world({ messages: msgs })
  await w.route('SMi1')
  msgs.push(ev('i2', 'inbound', 'I still own it, why', T0 - 2 * MIN))
  const r2 = await w.route('SMi2')
  assert.equal(r2.code, 'TURN_EXTENDED')
  const v1 = decodeTurnJobInput(w.jobs[0].input)
  w.clock.set(Date.parse(w.jobs[1].not_before) + 1000)
  const stale = await runDueTurn({ ...v1, store: w.store, worker: 'w0', decideTurn: w.decider(), dispatch: w.dispatcher() })
  assert.equal(stale.code, 'TURN_SUPERSEDED')
  const r = await w.runLatest({ text: undefined })
  assert.equal(r.dispatch, 'enqueued', JSON.stringify(r))
  assert.equal(w.queueRows.length, 1)
  assert.equal(w.queueRows[0].inbound_message_id, 'i2')
  assert.deepEqual([w.store.reservations.get('i1')?.status, w.store.reservations.get('i2')?.status], ['completed', 'completed'])
})

test('two racing workers on the same due turn ⇒ one claim, one decision, ONE queued reply', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  const ref = decodeTurnJobInput(w.jobs[0].input)
  w.clock.set(Date.parse(w.jobs[0].not_before) + 1000)
  const settled = await Promise.allSettled([1, 2].map((n) => runDueTurn({ ...ref, store: w.store, worker: `w${n}`, decideTurn: w.decider(), dispatch: w.dispatcher() })))
  const codes = settled.map((x) => (x.status === 'fulfilled' ? x.value.code : x.reason.code))
  assert.deepEqual(codes.sort(), ['DEFERRED_LIVE_CLAIM', 'TURN_DISPATCHED'], JSON.stringify(codes))
  assert.equal(w.queueRows.length, 1)
})

test('worker crash after finalize: the retried job RESUMES the dispatch with the same reservation token (no second reservation, no duplicate)', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  let crashed = false
  const crashing = w.dispatcher((d) => async (x) => { if (!crashed) { crashed = true; throw new Error('WORKER_DIED') } return d(x) })
  await assert.rejects(() => w.runLatest({ dispatch: crashing }), /WORKER_DIED/)
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.get('i1').status, 'processing', 'the turn still holds the inbound')
  const retry = await w.runLatest({ dispatch: crashing })
  assert.deepEqual([retry.code, retry.dispatch, retry.resumed], ['TURN_DISPATCHED', 'enqueued', true], JSON.stringify(retry))
  assert.equal(w.queueRows.length, 1)
  const again = await w.runLatest({ dispatch: crashing })
  // rc-8.5.21 dispatch lease: the dispatch is recorded terminal, so a third attempt never reaches R3 at all
  assert.deepEqual([again.code, again.dispatch_state], ['TURN_ALREADY_DISPATCHED', 'dispatched'])
  assert.equal(w.queueRows.length, 1, 'a third attempt never duplicates')
})

test('a transient R3 failure throws for a runtime retry (bounded attempts → dead letter); nothing half-written', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  const flaky = async () => ({ status: 'retry', reasons: ['state_unavailable'] })
  await assert.rejects(() => w.runLatest({ dispatch: flaky }), (e) => e.code === 'TURN_DISPATCH_RETRY')
  assert.equal(w.queueRows.length, 0)
})

test('new inbound before dispatch: after the decision, before R3 ⇒ stale_inbound (re-decide), no insert; before the claim ⇒ the version moved (superseded)', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)]
  const w = world({ messages: msgs })
  await w.route('SMi1')
  const lateArrival = w.dispatcher((d) => async (x) => { msgs.push(ev('i2', 'inbound', 'actually what would you pay', w.clock.now() - 1000)); return d(x) })
  const r = await w.runLatest({ dispatch: lateArrival })
  assert.equal(r.dispatch, 'stale_inbound', JSON.stringify(r))
  assert.equal(w.queueRows.length, 0)
})

test('STOP during the delay: the open turn is cancelled immediately (no model, no delay) and the due job decides nothing', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 3 * MIN)]
  const w = world({ messages: msgs })
  await w.route('SMi1')
  msgs.push(ev('i2', 'inbound', 'STOP', T0 - 1 * MIN))
  const s = await w.route('SMi2')
  assert.equal(s.code, 'SUPPRESSED_NOW')
  // rc-8.5.21 v4 (S2): the canonical path RECORDS the stop (decision + the durable opt-out write)
  assert.equal(s.immediate?.terminal, 'SUPPRESS', JSON.stringify(s.immediate))
  const { applyCanonicalDecisionEffects } = await import('../../src/lib/ai/conversation-decision-effects.js')
  await applyCanonicalDecisionEffects({ supabase: w.sb, ...s.immediate.effects_input }, w.effectsDeps)
  assert.deepEqual(w.effects.map((e) => e.kind), ['opt_out'])
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_STATE_CANCELLED')
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.provider.calls.length, 0, 'no model call at all')
})

test('wrong sender: the thread moved numbers ⇒ R3 holds (continuity), the reservation is consumed for a person, nothing queued', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], threadState: { thread_key: TK, our_number: '+13125550177' } })
  await w.route('SMi1')
  const r = await w.runLatest({ text: undefined })
  assert.equal(r.dispatch, 'held', JSON.stringify(r))
  assert.ok(r.reasons.includes('continuity:sender_number_mismatch'), JSON.stringify(r.reasons))
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.get('i1').status, 'completed')
})

test('missing timezone (non-geographic number, no property geography) ⇒ the conservative window; the reply goes in session and is stamped "unknown"', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)].map((m) => ({ ...m, ...(m.direction === 'inbound' ? { from_phone_number: '+15555550101' } : { to_phone_number: '+15555550101' }), thread_key: TK }))
  const w = world({ messages: msgs, properties: [{ property_id: 'p1', property_type: 'SFR', property_address_state: null, property_address_zip: null, timezone: null }] })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.dispatch, 'enqueued', JSON.stringify(r))
  assert.equal(w.queueRows[0].metadata.recipient_zone_certainty, 'unknown')
  assert.equal(w.queueRows[0].metadata.recipient_zones.length, 5)
})

test('suppression conflict: an active suppression beats a fresh "yes I would sell" — no reply, no reservation, nothing queued', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it and I would sell', T0 - 1 * MIN)], suppressions: [{ phone_e164: SELLER, is_active: true, suppression_type: 'opt_out' }] })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW', JSON.stringify(r))
  assert.equal(r.outcome, 'suppress')
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.size, 0)
})

test('follow-up conflict: a scheduled follow-up on the thread ⇒ R3 holds (a person decides), nothing queued', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], queue: [{ id: 'fu1', thread_key: TK, queue_status: 'scheduled', use_case_template: 's2_no_response_fu1', created_at: iso(T0 - 600 * MIN), metadata: {} }] })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.dispatch, 'held', JSON.stringify(r))
  assert.ok(r.reasons.includes('outbound_pending_on_thread'))
  assert.equal(w.queueRows.length, 0)
})

test('duplicate price question: the price was already asked ⇒ the composition is rejected twice ⇒ HOLD, no dispatch', async () => {
  const msgs = [OWN_Q(T0 - 200 * MIN), ev('i0', 'inbound', 'yes', T0 - 190 * MIN), ev('o2', 'outbound', 'Would you consider selling it?', T0 - 180 * MIN), ev('i9', 'inbound', 'maybe', T0 - 170 * MIN), ev('o3', 'outbound', 'What price would you want for it?', T0 - 160 * MIN), ev('i1', 'inbound', 'hmm not sure yet, depends', T0 - 1 * MIN)]
  const w = world({ messages: msgs, text: 'No problem. What price would you want for it?' })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW', JSON.stringify(r))
  assert.equal(w.queueRows.length, 0)
})

test('budget exhaustion: the spend cap refuses the model ⇒ no text, an evidence-backed escalation (failed_tool), nothing reserved or queued', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], capUsd: 1e-9 })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW', JSON.stringify(r))
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.size, 0)
  const rec = [...w.shadowRows.values()][0].record
  assert.equal(rec.decision.terminal.type, 'ESCALATE_TO_OPERATOR')
  assert.equal(rec.decision.terminal.reason, 'failed_tool')
})

test('emergency stop: the decider never authorises a send (nothing reserved); R3 holds it too', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], switches: { ...ON, queue_emergency_stop_at: '2026-10-14T16:00:00Z' } })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW')
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.store.reservations.size, 0)
})

test('OWNER DECISION 2026-10-18: the FIRST offer request with no price asked is answered ONCE with the number question (no amount, no fabricated offer)', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i0', 'inbound', 'yes', T0 - 80 * MIN), ev('o2', 'outbound', 'Would you consider selling it?', T0 - 70 * MIN), ev('i1', 'inbound', 'Maybe. What would you pay for it?', T0 - 1 * MIN)]
  const w = world({ messages: msgs, text: 'Happy to look at it with you. Do you have a number in mind for it?', judgment: (latest) => makeDecision({ intent: 'asks_offer', seller_interest: 'interested', outcome: 'REPLY_CANDIDATE', next_objective: 'get_asking_price', response_needed: true, proposed_message: 'x', confidence: 0.93, source_message_ids: [latest.id], facts_extracted: [], stage_evidence: { stage: 'S3_asking_price', evidence_message_ids: [latest.id], rationale: 'offer request' } }) })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DISPATCHED', JSON.stringify(r) + JSON.stringify([...w.shadowRows.values()][0]?.record?.composition))
  assert.equal(w.queueRows.length, 1)
  assert.ok(!/[0-9$]/.test(w.queueRows[0].message_body), 'no amount in the text')
})

test('missing negotiation authority: an offer request AFTER we asked their price ⇒ research + PREPARE_OFFER → the stub authority escalates at the number (no price without an envelope); nothing queued', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i0', 'inbound', 'yes', T0 - 80 * MIN), ev('o2', 'outbound', 'Would you consider selling it?', T0 - 70 * MIN), ev('i2', 'inbound', 'maybe', T0 - 60 * MIN), ev('o3', 'outbound', 'Do you have a price in mind?', T0 - 50 * MIN), ev('i1', 'inbound', 'Not sure. What would you pay for it?', T0 - 1 * MIN)]
  const w = world({ messages: msgs })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DECIDED_SHADOW')
  const rec = [...w.shadowRows.values()][0].record
  assert.deepEqual([rec.decision.terminal.type, rec.decision.terminal.reason], ['ESCALATE_TO_OPERATOR', 'missing_negotiation_authority'])
  assert.equal(w.queueRows.length, 0)
})

test('invalid offer range: an authority answer outside the contract (an AI money reply / an amount) escalates; it never becomes AI text', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i0', 'inbound', 'yes', T0 - 80 * MIN), ev('o2', 'outbound', 'Do you have a price in mind?', T0 - 70 * MIN), ev('i1', 'inbound', 'Sure, make me an offer', T0 - 1 * MIN)]
  const thread = msgs.map((m) => ({ id: m.id, direction: m.direction, body: m.message_body, at: m.created_at, thread_key: TK, seller_phone: SELLER, property_id: 'p1' }))
  const input = { now: iso(T0), inbound: { id: 'i1', body: 'Sure, make me an offer', at: msgs[3].created_at, thread_key: TK, from_phone: SELLER, property_id: 'p1' }, thread, properties: [{ property_id: 'p1', state: 'IL' }], offers: [], followups: [], names: { full_names: [], first_name: 'Dana' }, language: 'en' }
  const bad = { version: 'bad-authority', prepareOffer: async () => ({ action: 'AI_GENERATED_REPLY', amount: -5, text: 'I can pay $1' }), negotiateWithinAuthority: async () => ({ action: 'AI_GENERATED_REPLY' }) }
  const rec = await decideAndCompose({ input, eligibility: { blocked: false, reasons: [], timing: { lawful: true } }, negotiationAuthority: bad, caller: 'evaluation', now: iso(T0) })
  assert.deepEqual([rec.terminal.type, rec.terminal.reason], ['ESCALATE_TO_OPERATOR', 'missing_negotiation_authority'])
  assert.equal(rec.terminal.evidence.authority_reason, 'negotiation_result_outside_contract')
  assert.equal(rec.reply, null)
})

test('human intervention: an operator reply after the inbound ⇒ R3 holds (already answered); an operator take-over cancels the open turn', async () => {
  const msgs = [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 3 * MIN)]
  const w = world({ messages: msgs })
  await w.route('SMi1')
  const operator = w.dispatcher((d) => async (x) => { msgs.push(ev('o9', 'outbound', 'Hi Dana, Helen here, thanks!', w.clock.now() - 1000)); return d(x) })
  const r = await w.runLatest({ dispatch: operator })
  assert.equal(r.dispatch, 'held', JSON.stringify(r))
  assert.ok(r.reasons.includes('already_answered_by_outbound'))
  assert.equal(w.queueRows.length, 0)
  // take-over before the due time: the turn is cancelled, the due job decides nothing
  const w2 = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w2.route('SMi1')
  const c = await handleConversationEvent({ event: { kind: 'state_change', thread_key: TK, change: 'operator_took_over' }, store: w2.store, enqueueAt: w2.runtimeStore.enqueueEventAt, now: w2.clock.iso() })
  assert.equal(c.code, 'TURN_CLOSED_NO_REPLY')
  assert.equal((await w2.runLatest()).code, 'TURN_STATE_CANCELLED')
  assert.equal(w2.queueRows.length, 0)
})

test('outside the window at dispatch (a late night due past the session) ⇒ R3 defers; the turn is reopened at the next permitted time (same function)', async () => {
  const night = Date.parse('2026-10-15T04:30:00.000Z') // 23:30 CT
  const msgs = [ev('o1', 'outbound', 'Hi Dana, this is Helen. Do you still own the house on Oak St?', night - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', night - 1 * MIN)]
  const w = world({ messages: msgs })
  w.clock.set(night)
  await w.route('SMi1')
  // the worker ran very late (outage): 50 minutes after the inbound, outside the session, 00:19 CT
  const r = await w.runLatest({ at: iso(night + 50 * MIN) })
  assert.equal(r.code, 'TURN_DEFERRED_TO_WINDOW', JSON.stringify(r))
  assert.equal(w.queueRows.length, 0)
  assert.equal(w.jobs.length, 2, 'a new job carries the deferred schedule')
  const local = new Date(Date.parse(w.jobs[1].not_before) - 5 * 3600_000).toISOString().slice(11, 16)
  assert.ok(local >= '08:00' && local < '21:00', local)
  assert.equal(w.store.reservations.size, 0, 'the reopen released the reservation')
})

// ── blind-eval canary blockers D1–D4 (rc-8.5.21), from the described behaviour ──

test('D1: an authorized AI reply row is dispatchable EXACTLY once — the runner pre-claim gate admits it (max_retries 1), a second attempt never', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  const r = await w.runLatest()
  assert.equal(r.code, 'TURN_DISPATCHED', JSON.stringify(r))
  const row = w.queueRows[0]
  assert.equal(row.max_retries, 1)
  const gate = shouldRunSendQueueRow({ ...row, queue_status: 'queued', retry_count: 0, scheduled_for: iso(T0 - 1000) }, iso(w.clock.now() + 1000))
  assert.notEqual(gate.reason, 'max_retries_reached', JSON.stringify(gate.reason))
  // after one attempt (any failure, incl. an ambiguous accept) the row is never claimable again
  const again = shouldRunSendQueueRow({ ...row, queue_status: 'queued', retry_count: 1, scheduled_for: iso(T0 - 1000) }, iso(w.clock.now() + 1000))
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'max_retries_reached')
})

test('D2: a crash BETWEEN the provenance record and the queue insert is finished by the retry — the record\'s exact text, ONE row, never a silent "dispatched"', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  // the first attempt's process dies right after the immutable record is written, before the queue
  // insert (in memory: the call never returns; the PG test does it with a real SIGKILL)
  let killed = false
  const realInsert = w.records.insert
  w.records.insert = async (rec) => { await realInsert(rec); killed = true; return new Promise(() => {}) }
  const job = w.jobs[0]
  const ref = decodeTurnJobInput(job.input)
  w.clock.set(Date.parse(job.not_before) + 1000)
  void runDueTurn({ ...ref, store: w.store, worker: 'w1', decideTurn: w.decider(), dispatch: w.dispatcher() })
  for (let i = 0; i < 50 && !killed; i += 1) await new Promise((res) => setTimeout(res, 10))
  w.records.insert = realInsert
  assert.ok(killed)
  assert.equal(w.records.byKey.size, 1, 'the record was written')
  assert.equal(w.queueRows.length, 0, 'the queue row was not')
  // the dead worker's dispatch lease expires (no live process renews it)
  w.clock.set(w.clock.now() + 181_000)
  const turn = [...w.store.turns.values()][0]
  assert.notEqual(turn.dispatch_state, 'dispatched', 'a lost reply is never recorded as dispatched')
  // the retried job finds the record WITHOUT a row and finishes the enqueue with the record's text
  const retry = await runDueTurn({ ...ref, store: w.store, worker: 'w1', decideTurn: w.decider(), dispatch: w.dispatcher() })
  assert.deepEqual([retry.code, retry.dispatch], ['TURN_DISPATCHED', 'enqueued'], JSON.stringify(retry))
  assert.equal(w.queueRows.length, 1)
  const rec = [...w.records.byKey.values()][0]
  assert.equal(w.queueRows[0].message_body, rec.message_body)
  assert.equal(w.queueRows[0].metadata.ai_message_id, rec.id)
  assert.equal(w.records.byKey.size, 1, 'no second record')
  assert.equal([...w.store.turns.values()][0].dispatch_state, 'dispatched')
  // and once the row exists, a further retry is already_enqueued (never a second row)
  const r3 = await w.dispatcher()({ turn_id: turn.turn_id, version: turn.version, claim: { token: turn.result.reservation_token, inbound_ids: ['i1'] }, decision: await w.decider()({ ok: true, token: turn.result.reservation_token, version: turn.version, thread_key: TK, inbound_ids: ['i1'], latest_inbound_id: 'i1', turn_id: turn.turn_id, resumed: true }) })
  assert.ok(['already_enqueued', 'held', 'duplicate'].includes(r3.status), JSON.stringify(r3))
  assert.equal(w.queueRows.length, 1)
})

test('D3: an R3 hold is recorded as HELD (never "dispatched") and raises ONE operator item; a failed item write retries, never a silent hold', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  const holding = async () => ({ status: 'held', reasons: ['category_not_enabled:clarification'] })
  const job = w.jobs[0]
  const ref = decodeTurnJobInput(job.input)
  w.clock.set(Date.parse(job.not_before) + 1000)
  // the operator-item writer fails first: the job retries (the lease is released), the hold is not recorded
  await assert.rejects(() => runDueTurn({ ...ref, store: w.store, worker: 'w1', decideTurn: w.decider(), dispatch: holding, raiseOperatorItem: async () => { throw new Error('ops store down') } }), (e) => e.code === 'TURN_HELD_OPERATOR_ITEM_FAILED')
  assert.equal([...w.store.turns.values()][0].dispatch_state, 'in_flight')
  const items = []
  const r = await runDueTurn({ ...ref, store: w.store, worker: 'w1', decideTurn: w.decider(), dispatch: holding, raiseOperatorItem: async (h) => { items.push(h); return { ok: true } } })
  assert.equal(r.code, 'TURN_DISPATCH_HELD', JSON.stringify(r))
  assert.equal(r.operator_item, true)
  assert.deepEqual(items.map((i) => [i.r3_status, i.reasons]), [['held', ['category_not_enabled:clarification']]])
  const t = [...w.store.turns.values()][0]
  assert.deepEqual([t.dispatch_state, t.result.send_status, t.dispatched_at ?? null], ['held', 'held', null])
  assert.equal(w.queueRows.length, 0)
  // the real R3 hold path through the dispatcher: same classification
  const w2 = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)], switches: { ...ON, [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: ['+19999999999'] } }) } })
  await w2.route('SMi1')
  const ref2 = decodeTurnJobInput(w2.jobs[0].input)
  w2.clock.set(Date.parse(w2.jobs[0].not_before) + 1000)
  const items2 = []
  const r2 = await runDueTurn({ ...ref2, store: w2.store, worker: 'w1', decideTurn: w2.decider(), dispatch: w2.dispatcher(), raiseOperatorItem: async (h) => { items2.push(h); return { ok: true } } })
  if (r2.code !== 'TURN_DECIDED_SHADOW') {
    assert.equal(r2.code, 'TURN_DISPATCH_HELD', JSON.stringify(r2))
    assert.equal(items2.length, 1)
  }
})

test('D4: a frozen worker holding the claim never orphans the turn — the other job is RESCHEDULED at the lease end (not completed) and decides once after expiry, without the sweep', async () => {
  const w = world({ messages: [OWN_Q(T0 - 90 * MIN), ev('i1', 'inbound', 'Yes I still own it', T0 - 1 * MIN)] })
  await w.route('SMi1')
  const ref = decodeTurnJobInput(w.jobs[0].input)
  w.clock.set(Date.parse(w.jobs[0].not_before) + 1000)
  // worker A claims and freezes (never returns)
  const a = await w.store.claim({ turn_id: ref.turn_id, version: ref.version, worker: 'A', lease_seconds: 180 })
  assert.ok(a.ok)
  // worker B (the reaped job's retry) under A's live claim: rescheduled at the lease end + jitter
  const e = await runDueTurn({ ...ref, store: w.store, worker: 'B', decideTurn: w.decider(), dispatch: w.dispatcher() }).catch((x) => x)
  assert.equal(e.code, 'DEFERRED_LIVE_CLAIM')
  assert.ok(e.retry_after_ms >= 179_000 && e.retry_after_ms <= 186_000, String(e.retry_after_ms))
  assert.equal(w.queueRows.length, 0)
  // after the claim lease expires the rescheduled job claims and decides ONCE
  w.clock.set(w.clock.now() + e.retry_after_ms)
  const r = await runDueTurn({ ...ref, store: w.store, worker: 'B', decideTurn: w.decider(), dispatch: w.dispatcher() })
  assert.equal(r.code, 'TURN_DISPATCHED', JSON.stringify(r))
  assert.equal(w.queueRows.length, 1)
  // A wakes and is fenced: its finalize is refused
  const late = await w.store.finalize({ turn_id: ref.turn_id, token: a.token, version: ref.version, outcome: 'reply:x', result: {}, reserve: true, reply_origin: 'ai_generated' })
  assert.equal(late.ok, false)
  assert.equal(w.queueRows.length, 1)
})
