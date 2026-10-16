// 8.5.16 — R3 AI conversation execution module: OFF by default, one allowlisted path
// into the EXISTING send_queue insertion function, every existing guard at send time.
//
// NO-SEND EXECUTION PROOF: the full path runs with a FAKE queue insert (the real
// insertSupabaseSendQueueRow normalisation, its DB write replaced by an in-memory
// table that applies the live trigger mirror), the REAL reservation ledger (memory
// backend under NODE_ENV=test), the REAL eligibility bridge / send-time contact guard
// / template authority / AI row gate in dry run, and the REAL queue runner with an
// injected transport that records (and fails the test on) any provider call.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { executeAiConversationReply, draftHash, R3_EXECUTOR_WIRED } from '../../src/lib/ai/conversation-ai-r3-executor.js'
import { insertSupabaseSendQueueRow, normalizeSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { __resetIdempotencyLedgerTestDeps, beginIdempotentProcessing } from '../../src/lib/domain/events/idempotency-ledger.js'
import { dryRunEligibility } from '../../src/lib/domain/conversation-ai/eligibility-bridge.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { DEFAULT_AI_SEND_POLICY, isOwnerHandledThread, OWNER_HANDLED_THREAD_SHA256, normalizeSendPolicy, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, templateDeferVerdict } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { evaluateSendTimeContactGuard } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { evaluateTemplateAuthority } from '../../src/lib/domain/templates/template-authority.js'
import { evaluateAiConversationRowGate, cancelPendingAiConversationRows } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { evaluateTemplateCoexistence } from '../../src/lib/domain/seller-flow/ai-conversation-coexistence.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { applyBlockRepeatAskingPrice, MIRROR } from '../helpers/block-repeat-asking-price-mirror.mjs'
import { sha256Hex, sealedThreadRef, sealedRef, isVerifiedAiGeneratedRow, AI_GENERATED_MESSAGES_TABLE } from '../../src/lib/domain/messages/ai-generated-message.js'
import { makeSendQueueRowsSupabase } from '../helpers/queue-run-test-harness.js'
import { loadRunnableSendQueueRows } from '../../src/lib/supabase/sms-engine.js'

// fictional 555-01xx numbers only
const SELLER = '+15555550101'
const OURS = '+15555550199'
const TK = SELLER
const NOW = '2026-10-14T17:00:00.000Z' // 12:00 America/Chicago — inside 08–21
const NIGHT = '2026-10-15T04:30:00.000Z' // 23:30 America/Chicago
const at = (min, base = NOW) => new Date(Date.parse(base) - min * 60_000).toISOString()

const msg = (id, dir, body, minAgo, extra = {}) => ({ id, direction: dir, body, at: at(minAgo), thread_key: TK, seller_phone: SELLER, property_id: 'p1', ...extra })

function world({ thread, queueRows = [], language = 'en', guardFacts = {}, properties = [{ property_id: 'p1', property_type: 'sfr', state: 'TX', city: 'Dallas' }], offers = [], tk = TK, seller = SELLER } = {}) {
  const inbounds = thread.filter((m) => m.direction === 'inbound')
  const latest = inbounds[inbounds.length - 1]
  return {
    guardFacts,
    state: {
      input: { now: NOW, inbound: { id: latest.id, body: latest.body, at: latest.at, thread_key: tk, from_phone: seller, property_id: 'p1' }, thread, properties, offers, followups: [], names: { full_names: [], first_name: null }, language },
      queueRows, timezone: 'America/Chicago', geography: { state: 'TX', zip: '75201' }, language, seller_phone: seller, our_phone: OURS, property_id: 'p1', prospect_id: 'pr1', master_owner_id: null, market_id: null, campaign_id: null,
    },
  }
}

// in-memory stand-in for public.ai_generated_messages: append-only, one per inbound / queue
// key, body hash enforced (the DB CHECKs + triggers are proven on a disposable PG17 by
// scripts/db/run-migration-test.mjs --id message_origin_ai_generated_messages)
export function makeRecords() {
  const byKey = new Map()
  const events = []
  return {
    byKey, events,
    insert: async (rec) => {
      if (byKey.has(rec.queue_key) || [...byKey.values()].some((r) => r.inbound_message_id === rec.inbound_message_id)) return { ok: false, reason: 'ai_generated_record_exists' }
      if (rec.body_sha256 !== sha256Hex(rec.message_body) || rec.message_origin !== 'ai_generated' || /[\u2013\u2014]/.test(rec.message_body)) return { ok: false, reason: 'ai_generated_record_insert_failed' }
      const stored = Object.freeze({ id: crypto.randomUUID(), ...structuredClone(rec) })
      byKey.set(rec.queue_key, stored)
      return { ok: true, id: stored.id, queue_key: rec.queue_key }
    },
    load: async (queueKey) => ({ found: byKey.has(queueKey), read_failed: false, record: byKey.get(queueKey) || null }),
    event: async (e) => { events.push(Object.freeze({ ...e })); return { ok: true } },
    update: () => { throw new Error('ai_generated_messages is append-only: UPDATE refused') },
  }
}

function makeTable() {
  const rows = []
  const inserts = []
  const records = makeRecords()
  return {
    rows, inserts, records,
    // the REAL insertion function; only its DB write is replaced (deps.insertSupabaseSendQueueRow)
    insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, {
      now: NOW,
      insertSupabaseSendQueueRow: (insert_payload) => {
        if (rows.some((r) => r.queue_key === insert_payload.queue_key)) return { ok: false, reason: 'duplicate_queue_key' }
        const stored = applyBlockRepeatAskingPrice({ ...insert_payload, id: crypto.randomUUID() }, rows)
        rows.push(stored)
        inserts.push(stored)
        return { ok: true, queue_row_id: stored.id, item_id: stored.id, raw: stored }
      },
    }),
  }
}

function switches(over = {}) {
  const v = { [AI_SEND_KILL_SWITCH_KEY]: 'true', [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: [TK] } }), ...over }
  const reads = []
  return { values: v, reads, readSwitch: async (key) => { reads.push(key); return v[key] ?? null } }
}

function deps({ w, table = makeTable(), sw = switches(), now = NOW, loadState = null } = {}) {
  return {
    table, sw,
    d: {
      now,
      readSwitch: sw.readSwitch,
      loadState: loadState || (async () => structuredClone(w.state)),
      // the EXISTING bridge: real send-time contact guard + real recipient-local window, dry run
      eligibility: ({ row, state }) => dryRunEligibility({ row, facts: w.guardFacts, timezone: state.timezone, geography: state.geography, now }),
      insertQueueRow: table.insertQueueRow,
      insertRecord: table.records.insert,
      recordEvent: table.records.event,
      cancelPending: async () => { throw new Error('cancelPending must not run for a reply') },
    },
  }
}

const S1_THREAD = () => [
  msg('o1', 'outbound', 'Hi, do you still own the house on Elm St?', 30, { use_case: 'ownership_check' }),
  msg('i1', 'inbound', 'Yes I still own it', 5),
]
const interestDecision = (over = {}) => makeDecision({
  intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true,
  proposed_message: 'Thanks for confirming. Would you consider selling it?', confidence: 0.95, source_message_ids: ['i1'],
  facts_extracted: [{ fact: 'ownership', value: 'confirmed', source_message_id: 'i1', confidence: 0.95 }],
  stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['i1'], rationale: 'ownership confirmed' }, ...over,
})
const sw_on = (policy = { enabled: true, scope: { thread_keys: [TK] } }) => async (k) => (k === AI_SEND_KILL_SWITCH_KEY ? 'true' : k === AI_SEND_POLICY_KEY ? JSON.stringify(policy) : null)
const candidate = (decision = interestDecision(), over = {}) => ({
  decision, draft_text: decision.proposed_message, validation: { status: 'validated_draft' }, decision_id: 'conv-ai:v1:i1', model: 'claude-haiku-5-5',
  inbound: { id: 'i1', provider_message_sid: 'SMfixture', thread_key: TK }, ...over,
})

test.beforeEach(() => __resetIdempotencyLedgerTestDeps())

// ── defaults ────────────────────────────────────────────────────────────────
test('defaults: everything OFF — no switch, no policy, executor unwired, template never defers', async () => {
  assert.equal(R3_EXECUTOR_WIRED, false)
  assert.equal(DEFAULT_AI_SEND_POLICY.enabled, false)
  assert.deepEqual(DEFAULT_AI_SEND_POLICY.scope.thread_keys, [])
  const w = world({ thread: S1_THREAD() })
  const { d, table } = deps({ w, sw: { readSwitch: async () => null } })
  const r = await executeAiConversationReply(candidate(), d)
  assert.equal(r.status, 'refused')
  assert.deepEqual(r.reasons, ['kill_switch_off'])
  assert.equal(table.inserts.length, 0)
  let reads = 0
  const c = await evaluateTemplateCoexistence({ inbound_message_event_id: 'i1', thread_key: TK, getSystemValue: async () => { reads += 1; return 'true' } })
  assert.deepEqual(c, { defer: false, reason: 'r3_executor_not_wired' })
  assert.equal(reads, 0, 'the template path reads nothing while R3 is unwired')
  // switch on but policy absent ⇒ still refused
  const sw = switches({ [AI_SEND_POLICY_KEY]: null })
  const r2 = await executeAiConversationReply(candidate(), deps({ w, sw }).d)
  assert.deepEqual(r2.reasons, ['ai_send_policy_disabled'])
})

test('policy: limits clamp to the owner limits; malformed policy is the safe default; empty scope = nothing', () => {
  const p = normalizeSendPolicy(JSON.stringify({ enabled: true, limits: { max_per_day_global: 500, max_per_seller_per_day: 9 }, hours: { start_local_hour: 0, end_local_hour: 24 }, languages: ['es'], min_confidence: 0.1 }))
  assert.equal(p.limits.max_per_day_global, 25)
  assert.equal(p.limits.max_per_seller_per_day, 1)
  assert.deepEqual(p.hours, { start_local_hour: 8, end_local_hour: 21 })
  assert.deepEqual(p.languages, ['en'])
  assert.equal(p.min_confidence, 0.85)
  assert.equal(normalizeSendPolicy('{not json').enabled, false)
  assert.equal(normalizeSendPolicy({ enabled: 'true' }).enabled, false, 'a truthy string never enables')
  assert.equal(templateDeferVerdict({ executorWired: true, killSwitchOn: true, policy: p, inScope: false }).defer, false)
})

// ── the NO-SEND EXECUTION PROOF ─────────────────────────────────────────────
test('E2E no-send proof: an eligible routine reply passes R3 and is enqueued through the real insertion function; existing guards run at send time', async () => {
  const w = world({ thread: S1_THREAD() })
  const { d, table } = deps({ w })
  const r = await executeAiConversationReply(candidate(), d)
  assert.equal(r.status, 'enqueued', JSON.stringify(r))
  assert.equal(r.category, 'next_missing_fact')
  assert.equal(table.inserts.length, 1)
  const row = table.inserts[0]
  assert.equal(row.source, 'ai_conversation')
  assert.equal(row.metadata.source, 'ai_conversation')
  assert.equal(row.metadata.model, 'claude-haiku-5-5')
  assert.equal(row.metadata.decision_id, 'conv-ai:v1:i1')
  assert.equal(row.metadata.draft_hash, draftHash('Thanks for confirming. Would you consider selling it?'))
  assert.equal(row.queue_status, 'queued')
  assert.equal(row.use_case_template, 'ai_consider_selling')
  assert.equal(row.queue_key, 'ai_conversation:i1')
  assert.equal(row.inbound_message_id, 'i1')
  assert.equal(row.timezone, 'America/Chicago')
  // ORIGIN ai_generated: not a template, no template id of any kind
  assert.equal(row.message_origin, 'ai_generated')
  assert.equal(row.metadata.message_origin, 'ai_generated')
  assert.equal(row.template_id ?? null, null)
  assert.equal(row.selected_template_id ?? null, null)
  assert.equal(row.template_key ?? null, null)
  assert.ok(!JSON.stringify(row).includes('ai-msg:'), 'no template masquerade anywhere on the row')
  assert.equal(row.template_source, 'ai_generated')
  assert.equal(row.max_retries, 0, 'no automatic retry of AI text')
  assert.equal(r.ai_message_id, row.metadata.ai_message_id)
  assert.equal(row.metadata.ai_message_body_sha256, sha256Hex(row.message_body))
  assert.equal(row.metadata.no_direct_provider_send, true)
  assert.equal(row.metadata.automation_provenance?.source_surface, 'ai_conversation')
  assert.equal(row.metadata.automation_provenance?.message_origin, 'ai_generated')
  const rec = table.records.byKey.get(row.queue_key)
  assert.ok(Object.isFrozen(rec))
  assert.equal(rec.id, row.metadata.ai_message_id)
  assert.equal(rec.message_origin, 'ai_generated')
  assert.equal(rec.message_body, row.message_body)
  assert.equal(rec.body_sha256, sha256Hex(rec.message_body))
  assert.equal(rec.idempotency_key, 'inbound_reply:i1')
  assert.equal(rec.inbound_message_id, 'i1')
  assert.equal(rec.thread_ref, sealedThreadRef(TK))
  assert.equal(rec.recipient_ref, sealedRef('ph', SELLER))
  assert.equal(rec.sender_ref, sealedRef('ph', OURS))
  assert.equal(rec.property_ref, sealedRef('pr', 'p1'))
  assert.equal(rec.contact_ref, sealedRef('ct', 'pr1'))
  assert.ok(!JSON.stringify(rec).includes(SELLER.slice(-10)) && !JSON.stringify(rec).includes(OURS.slice(-10)), 'no phone number in the record')
  assert.equal(rec.decision_id, 'conv-ai:v1:i1')
  assert.equal(rec.decision_outcome, 'AI_GENERATED_REPLY')
  assert.equal(rec.model, 'claude-haiku-5-5')
  assert.equal(rec.playbook_version, 'playbook.v2')
  assert.equal(rec.prompt_version, 'compose.v2')
  assert.equal(rec.context_version, 'conv-ai.context.v1')
  assert.equal(rec.validation.status, 'validated')
  assert.match(rec.ledger_snapshot_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual([rec.authorization_scope.scope_match, rec.authorization_scope.category], ['thread_keys', 'next_missing_fact'])
  assert.match(rec.authorization_scope.policy_hash, /^[0-9a-f]{64}$/)
  assert.equal(rec.approval_state, 'policy_authorized')
  assert.equal(rec.generated_at, NOW)
  assert.throws(() => table.records.update(rec.id, { message_body: 'x' }), /append-only/)
  assert.deepEqual(table.records.events.map((e) => [e.eventType, e.aiMessageId]), [['queued', rec.id]])

  // ── send time, dry run, with the REAL guard functions ──
  const gate = await evaluateAiConversationRowGate(row, { readSwitch: d.readSwitch, loadRecord: table.records.load, loadNewerInbounds: async () => ({ read_failed: false, rows: [] }), now: NOW })
  assert.deepEqual([gate.applies, gate.action], [true, 'proceed'], JSON.stringify(gate))
  assert.equal(evaluateSendTimeContactGuard(row, {}, { now: NOW }).blocked, false)
  const aiClient = (record) => ({ from: (t) => ({ select: () => ({ eq: () => ({ limit: async () => (t === AI_GENERATED_MESSAGES_TABLE ? { data: record ? [record] : [] } : { data: [] }) }) }) }) })
  const ta = await evaluateTemplateAuthority({ queue_row: row, supabase: aiClient(rec) })
  assert.deepEqual([ta.allowed, ta.reason, ta.template_id, ta.message_origin], [true, 'ai_generated_message', null, 'ai_generated'], JSON.stringify(ta))
  const tampered = await evaluateTemplateAuthority({ queue_row: { ...row, message_body: 'Thanks. What is your lowest price?' }, supabase: aiClient(rec) })
  assert.deepEqual([tampered.allowed, tampered.detail], [false, 'ai_generated_body_mismatch'])
  assert.equal((await evaluateTemplateAuthority({ queue_row: row, supabase: aiClient(null) })).detail, 'ai_generated_record_not_found')
  const tplClient = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [{ id: 't1', template_id: 't1', template_body: 'Hi, would you sell?' }] }) }) }) }) }
  const laundered = await evaluateTemplateAuthority({ queue_row: { ...row, template_id: 't1', selected_template_id: 't1' }, supabase: tplClient })
  assert.deepEqual([laundered.allowed, laundered.detail], [false, 'ai_generated_must_not_carry_template_id'])
})

test('E2E: the real queue runner with an AI row — switch off cancels, night defers, on+in-window proceeds; transport never called', async () => {
  const w = world({ thread: S1_THREAD() })
  const { d, table } = deps({ w })
  await executeAiConversationReply(candidate(), d)
  const base = normalizeSendQueueRow({ ...table.inserts[0], queue_status: 'processing', is_locked: true, lock_token: 'lock-ai', created_at: NOW })
  const transport = []
  const runnerDeps = (over = {}) => {
    const updates = []
    const lock_updates = []
    return {
      updates, lock_updates,
      deps: {
        now: NOW, claimedLockToken: 'lock-ai',
        getSystemValue: async (k) => (k === 'queue_processor_mode' ? 'live' : k === 'queue_execution_mode' ? 'normal' : null),
        loadOutboundNumberByPhone: async (p) => ({ id: `fleet-${p}`, phone_number: p, status: 'active', health_state: 'unverified', daily_limit: 800, messages_sent_today: 0 }),
        loadCampaignStatus: async () => 'active',
        updateQueueRow: async (id, payload) => { updates.push({ id, payload }); return { ok: true, id, payload } },
        updateSendQueueRowWithLock: async (id, lock_token, payload) => { lock_updates.push({ id, payload }); return normalizeSendQueueRow({ id, ...payload }) },
        sendTextgridSMS: async () => { transport.push(1); throw new Error('TRANSPORT_MUST_NOT_BE_CALLED') },
        info: () => {}, warn: () => {},
        supabase: { from() { throw new Error('unexpected_supabase_access_in_test') } },
        loadAiGeneratedMessage: table.records.load,
        loadNewerInbounds: async () => ({ read_failed: false, rows: [] }),
        ...over,
      },
    }
  }
  // kill switch absent ⇒ cancelled
  const on_sw = sw_on()
  const off = runnerDeps({ readAiConversationSwitch: async () => null })
  const r1 = await processSendQueueItem(base, off.deps)
  assert.equal(r1.reason, 'ai_conversation_send_disabled', JSON.stringify(r1))
  assert.equal(off.updates[0].payload.queue_status, 'cancelled')
  assert.equal(off.updates[0].payload.paused_reason, 'ai_conversation_send_disabled')
  // switch on, 23:30 recipient-local ⇒ deferred (no in-session bypass for AI rows)
  const night = runnerDeps({ now: NIGHT, readAiConversationSwitch: on_sw })
  const r2 = await processSendQueueItem({ ...base }, night.deps)
  assert.equal(r2.reason, 'ai_conversation_outside_contact_window', JSON.stringify(r2))
  assert.equal(night.lock_updates[0].payload.queue_status, 'queued')
  // switch on, in window ⇒ the AI gate passes and the row continues into the existing guards;
  // provider-sid evidence stops it at the existing idempotency guard (proof: no provider call)
  const on = runnerDeps({ readAiConversationSwitch: on_sw })
  const r3 = await processSendQueueItem(normalizeSendQueueRow({ ...base, metadata: { ...base.metadata, provider_message_sid: 'SMevidence-ai' } }), on.deps)
  assert.ok(!String(r3.reason).startsWith('ai_conversation_'), JSON.stringify(r3))
  assert.equal(transport.length, 0, JSON.stringify(r3))
  // a non-AI row never touches the AI gate (no switch read)
  let switchReads = 0
  const tmpl = runnerDeps({ readAiConversationSwitch: async () => { switchReads += 1; return null } })
  const { message_origin: _drop, ...templateShaped } = base
  await processSendQueueItem(normalizeSendQueueRow({ ...templateShaped, source: 'auto_reply', template_source: 'sms_templates', metadata: { source: 'auto_reply', provider_message_sid: 'SMx' } }), tmpl.deps)
  assert.equal(switchReads, 0)
})

test('kill switch: blocks at enqueue, at the pre-insert re-read, and the sweep cancels pending AI rows', async () => {
  const w = world({ thread: S1_THREAD() })
  // flips off between the first read and the insert
  let n = 0
  const sw = { readSwitch: async (k) => (k === AI_SEND_KILL_SWITCH_KEY ? ((n += 1) === 1 ? 'true' : 'false') : JSON.stringify({ enabled: true, scope: { thread_keys: [TK] } })) }
  const { d, table } = deps({ w, sw })
  const r = await executeAiConversationReply(candidate(), d)
  assert.equal(r.status, 'held')
  assert.deepEqual(r.reasons, ['kill_switch_off_at_enqueue'])
  assert.equal(table.inserts.length, 0)
  for (const v of ['false', 'TRUE ', '1', 'yes', '', null]) {
    const x = await executeAiConversationReply(candidate(), deps({ w, sw: switches({ [AI_SEND_KILL_SWITCH_KEY]: v }) }).d)
    if (v === 'TRUE ') assert.notEqual(x.reasons[0], 'kill_switch_off') // 'true' trimmed, any case
    else assert.deepEqual(x.reasons, ['kill_switch_off'], String(v))
  }
  // sweep
  const updated = []
  const fake = { from: () => ({
    select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: [{ id: 'a1', metadata: {} }, { id: 'a2', metadata: { x: 1 } }] }) }) }) }),
    update: (p) => ({ eq: (_c, id) => ({ in: async () => { updated.push({ id, p }); return { error: null } } }) }),
  }) }
  const s = await cancelPendingAiConversationRows({ supabase: fake, now: NOW })
  assert.equal(s.cancelled, 2)
  assert.ok(updated.every((u) => u.p.queue_status === 'cancelled' && u.p.paused_reason === 'ai_conversation_send_disabled'))
})

// ── concurrency ─────────────────────────────────────────────────────────────
test('no double reply: the same inbound executed 6x in parallel ⇒ exactly ONE insert', async () => {
  const w = world({ thread: S1_THREAD() })
  const { d, table } = deps({ w })
  const rs = await Promise.all(Array.from({ length: 6 }, () => executeAiConversationReply(candidate(), d)))
  assert.equal(table.inserts.length, 1)
  assert.equal(rs.filter((r) => r.status === 'enqueued').length, 1)
  assert.ok(rs.filter((r) => r.status !== 'enqueued').every((r) => r.status === 'duplicate' || r.status === 'held'), JSON.stringify(rs.map((r) => r.reasons)))
})

test('no double reply: two parallel inbounds on one thread ⇒ ONE reply (stale re-decides; a racing view is stopped by the seller-day reservation)', async () => {
  const thread = [...S1_THREAD(), msg('i2', 'inbound', 'Yes thats my house', 3)]
  const w = world({ thread })
  const { d, table } = deps({ w })
  const dA = interestDecision()
  const dB = interestDecision({ source_message_ids: ['i2'], facts_extracted: [{ fact: 'ownership', value: 'confirmed', source_message_id: 'i2', confidence: 0.95 }], stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['i2'], rationale: 'ownership confirmed' } })
  const [a, b] = await Promise.all([
    executeAiConversationReply(candidate(dA), d),
    executeAiConversationReply(candidate(dB, { inbound: { id: 'i2', provider_message_sid: 'SM2', thread_key: TK }, decision_id: 'conv-ai:v1:i2' }), d),
  ])
  assert.equal(a.status, 'stale_inbound')
  assert.equal(a.action, 're_decide')
  assert.equal(a.latest_inbound_id, 'i2')
  assert.equal(b.status, 'enqueued', JSON.stringify(b))
  assert.equal(table.inserts.length, 1)

  // racing views: each loader read happened before the other inbound landed
  __resetIdempotencyLedgerTestDeps()
  const t2 = makeTable()
  const wA = world({ thread: S1_THREAD() })
  const wB = world({ thread: [S1_THREAD()[0], msg('i2', 'inbound', 'Yes thats my house', 3)] })
  const [x, y] = await Promise.all([
    executeAiConversationReply(candidate(dA), deps({ w: wA, table: t2 }).d),
    executeAiConversationReply(candidate(dB, { inbound: { id: 'i2', provider_message_sid: 'SM2', thread_key: TK }, decision_id: 'conv-ai:v1:i2' }), deps({ w: wB, table: t2 }).d),
  ])
  assert.equal(t2.inserts.length, 1, JSON.stringify([x, y].map((r) => [r.status, r.reasons])))
  assert.ok([x, y].some((r) => r.status === 'held' && r.reasons.includes('seller_daily_cap')), JSON.stringify([x, y].map((r) => [r.status, r.reasons])))
})

test('stale inbound: a second inbound before enqueue ⇒ re-decide (no insert, no reservation)', async () => {
  const thread = [...S1_THREAD(), msg('i2', 'inbound', 'actually what would you pay?', 1)]
  const w = world({ thread })
  const { d, table } = deps({ w })
  const r = await executeAiConversationReply(candidate(), d)
  assert.deepEqual([r.status, r.action, r.latest_inbound_id], ['stale_inbound', 're_decide', 'i2'])
  assert.equal(table.inserts.length, 0)
  const free = await beginIdempotentProcessing({ scope: 'inbound_reply', key: 'i1' })
  assert.equal(free.duplicate, false, 'the inbound was not reserved')
})

test('already answered / queued: an outbound after the inbound, or a queued reply row, holds', async () => {
  const w = world({ thread: [...S1_THREAD(), msg('o2', 'outbound', 'Thanks! Would you sell?', 1)] })
  const r = await executeAiConversationReply(candidate(), deps({ w }).d)
  assert.deepEqual(r.reasons, ['already_answered_by_outbound'])
  const w2 = world({ thread: S1_THREAD(), queueRows: [{ id: 'q1', queue_status: 'queued', use_case_template: 'consider_selling', created_at: at(2), inbound_message_id: 'i1' }] })
  const r2 = await executeAiConversationReply(candidate(), deps({ w: w2 }).d)
  assert.deepEqual(r2.reasons, ['reply_already_queued'])
  const w3 = world({ thread: S1_THREAD(), queueRows: [{ id: 'fu1', queue_status: 'scheduled', use_case_template: 's2_no_response_fu1', created_at: at(600) }, { id: 'old', queue_status: 'cancelled', use_case_template: 'consider_selling', created_at: at(700) }] })
  const r3 = await executeAiConversationReply(candidate(), deps({ w: w3 }).d)
  assert.deepEqual(r3.reasons, ['outbound_pending_on_thread'])
})

// ── scope ───────────────────────────────────────────────────────────────────
test('held: out of scope, money, offers, Spanish, unknown language, multi-property, legal, negotiation', async () => {
  const run = async (w, c, sw) => executeAiConversationReply(c, deps({ w, sw }).d)
  // thread not in the policy allowlist
  const notScoped = await run(world({ thread: S1_THREAD() }), candidate(), switches({ [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: ['+15555550142'] } }) }))
  assert.deepEqual(notScoped.reasons, ['thread_not_in_ai_scope'])
  // money: the seller states a price; asking condition is the next fact but the turn carries money
  const priceThread = [msg('o1', 'outbound', 'Would you consider selling it?', 30, { use_case: 'consider_selling' }), msg('i1', 'inbound', "I'd sell for $175K", 5)]
  // 8.5.16 eval: a STATED price is not a money turn (owner flow S3 price → S4 condition); money is by INTENT
  const priced = await run(world({ thread: priceThread }), candidate(interestDecision({ intent: 'asking_price_provided', seller_interest: 'interested', next_objective: 'get_condition', proposed_message: "Got it. How's the condition of the property?", facts_extracted: [] })))
  assert.equal(priced.status, 'enqueued', JSON.stringify(priced.reasons))
  __resetIdempotencyLedgerTestDeps()
  // our own text with an amount is still a money turn
  const money = await run(world({ thread: priceThread }), candidate(interestDecision({ intent: 'asking_price_provided', seller_interest: 'interested', next_objective: 'get_condition', proposed_message: 'Got it, 175k. How is the condition?', facts_extracted: [] })))
  assert.equal(money.status, 'held')
  assert.ok(money.reasons.some((x) => /money|dollar/.test(x)), JSON.stringify(money.reasons))
  // offer request
  const offerThread = [msg('o1', 'outbound', 'Would you consider selling it?', 30, { use_case: 'consider_selling' }), msg('i1', 'inbound', "What's your offer?", 5)]
  const offer = await run(world({ thread: offerThread }), candidate(interestDecision({ intent: 'asks_offer', seller_interest: 'interested', next_objective: 'get_asking_price', proposed_message: 'Happy to. What price did you have in mind?', facts_extracted: [] })))
  assert.equal(offer.status, 'held')
  assert.ok(offer.reasons.includes('excluded_money_or_offer') && offer.reasons.includes('excluded_offer_on_thread'), JSON.stringify(offer.reasons))
  // Spanish
  const esThread = [msg('o1', 'outbound', '¿Todavía es el dueño de la casa?', 30, { use_case: 'ownership_check' }), msg('i1', 'inbound', 'Sí, soy el dueño', 5)]
  const es = await run(world({ thread: esThread, language: 'es' }), candidate(interestDecision({ proposed_message: 'Gracias. ¿Consideraría vender?' })))
  assert.equal(es.status, 'held')
  assert.ok(es.reasons.some((x) => x.startsWith('excluded_language') || x === 'style:non_english_characters'), JSON.stringify(es.reasons))
  // 8.5.16 eval: a missing language with ENGLISH text is English; non-English text with no language stays unknown
  const inferred = await run(world({ thread: S1_THREAD(), language: null }), candidate())
  assert.ok(!inferred.reasons.some((x) => x.startsWith('excluded_language')), JSON.stringify(inferred.reasons))
  __resetIdempotencyLedgerTestDeps()
  const unkThread = [S1_THREAD()[0], msg('i1', 'inbound', 'Ja, das gehört mir', 5)]
  const unk = await run(world({ thread: unkThread, language: null }), candidate())
  assert.ok(unk.reasons.includes('excluded_language:language_unknown'), JSON.stringify(unk.reasons))
  // multi-property
  const multi = await run(world({ thread: S1_THREAD(), properties: [{ property_id: 'p1', state: 'TX' }, { property_id: 'p2', state: 'TX' }] }), candidate())
  assert.ok(multi.reasons.includes('excluded_multi_property'), JSON.stringify(multi.reasons))
  // legal / contract
  const legalThread = [S1_THREAD()[0], msg('i1', 'inbound', 'Yes I own it, send me the contract', 5)]
  const legal = await run(world({ thread: legalThread }), candidate())
  assert.ok(legal.reasons.includes('excluded_legal_or_contract'), JSON.stringify(legal.reasons))
  // negotiation
  const negThread = [S1_THREAD()[0], msg('i1', 'inbound', 'Yes I own it, what is the best price you can do', 5)]
  const neg = await run(world({ thread: negThread }), candidate())
  assert.ok(neg.reasons.includes('excluded_negotiation'), JSON.stringify(neg.reasons))
})

test('routine categories: identity answer and the not-interested close (no question) are in scope; NO_RESPONSE enqueues nothing', async () => {
  const idThread = [msg('o1', 'outbound', 'Hi, do you still own the house on Elm St?', 30, { use_case: 'ownership_check' }), msg('i1', 'inbound', 'who is this?', 5)]
  const idDec = makeDecision({ intent: 'who_is_this', outcome: 'REPLY_CANDIDATE', next_objective: 'clarify_identity', response_needed: true, proposed_message: "I'm a local buyer reaching out about the house on Elm St. Do you still own it?", confidence: 0.95, source_message_ids: ['i1'] })
  const a = await executeAiConversationReply(candidate(idDec), deps({ w: world({ thread: idThread }) }).d)
  assert.equal(a.status, 'enqueued', JSON.stringify(a))
  assert.equal(a.category, 'identity_answer')
  __resetIdempotencyLedgerTestDeps()
  const niThread = [msg('o1', 'outbound', 'Would you consider selling it?', 30, { use_case: 'consider_selling' }), msg('i1', 'inbound', 'not interested', 5)]
  const niDec = makeDecision({ intent: 'not_interested', seller_interest: 'not_interested', outcome: 'REPLY_CANDIDATE', next_objective: 'acknowledge', response_needed: true, proposed_message: 'No problem, thanks for the quick reply.', confidence: 0.95, source_message_ids: ['i1'] })
  const t = makeTable()
  const b = await executeAiConversationReply(candidate(niDec), deps({ w: world({ thread: niThread }), table: t }).d)
  assert.equal(b.status, 'enqueued', JSON.stringify(b))
  assert.equal(b.category, 'not_interested_close')
  assert.equal(t.inserts[0].use_case_template, 'ai_not_interested_close')
  const asks = await executeAiConversationReply(candidate({ ...niDec, proposed_message: 'Understood. Would you sell later?' }), deps({ w: world({ thread: niThread }) }).d)
  assert.equal(asks.status, 'held')
  const nr = makeDecision({ intent: 'acknowledgement', outcome: 'NO_RESPONSE', next_objective: 'none', confidence: 1, source_message_ids: ['i1'] })
  const t3 = makeTable()
  const c = await executeAiConversationReply({ ...candidate(nr), draft_text: '' }, deps({ w: world({ thread: idThread }), table: t3 }).d)
  assert.equal(c.status, 'no_response')
  assert.equal(t3.inserts.length, 0)
})

test('candidate must be a strictly valid decision with a validated draft', async () => {
  const w = world({ thread: S1_THREAD() })
  const bad = await executeAiConversationReply(candidate({ ...interestDecision(), extra_key: 1 }), deps({ w }).d)
  assert.equal(bad.status, 'refused')
  assert.ok(bad.reasons.includes('decision_invalid'))
  const notVal = await executeAiConversationReply(candidate(interestDecision(), { validation: { status: 'rejected_with_reasons' } }), deps({ w }).d)
  assert.deepEqual(notVal.reasons, ['draft_not_validated'])
  const foreign = await executeAiConversationReply(candidate(interestDecision({ source_message_ids: ['not-in-thread'] })), deps({ w }).d)
  assert.deepEqual(foreign.reasons, ['decision_ids_not_in_latest_context'])
})

// ── STOP / ownership denial ─────────────────────────────────────────────────
test('STOP between decision and send: blocked at enqueue (guard) and, when it lands after enqueue, at send time', async () => {
  const w = world({ thread: S1_THREAD(), guardFacts: { suppressions: [{ phone_e164: SELLER, is_active: true, suppression_type: 'opt_out' }] } })
  const r = await executeAiConversationReply(candidate(), deps({ w }).d)
  assert.equal(r.status, 'held')
  assert.ok(r.reasons.some((x) => x.startsWith('eligibility_blocked:sms_suppression')), JSON.stringify(r.reasons))
  // STOP after the decision but before enqueue arrives as a NEWER inbound ⇒ re-decide (the pre-check suppresses)
  const w2 = world({ thread: [...S1_THREAD(), msg('i2', 'inbound', 'STOP', 1)] })
  const r2 = await executeAiConversationReply(candidate(), deps({ w: w2 }).d)
  assert.equal(r2.status, 'stale_inbound')
  // STOP after enqueue: the row is in the queue; the existing send-time guard blocks it
  __resetIdempotencyLedgerTestDeps()
  const w3 = world({ thread: S1_THREAD() })
  const { d, table } = deps({ w: w3 })
  assert.equal((await executeAiConversationReply(candidate(), d)).status, 'enqueued')
  const v = evaluateSendTimeContactGuard(table.inserts[0], { suppressions: [{ phone_e164: SELLER, is_active: true }] }, { now: NOW })
  assert.equal(v.blocked, true)
  const v2 = evaluateSendTimeContactGuard(table.inserts[0], { inbound_replies: [{ from_phone_number: SELLER, detected_intent: 'opt_out', is_opt_out: true }] }, { now: NOW })
  assert.equal(v2.blocked, true)
})

test('ownership-denial / wrong-number holds are respected (thread state + ledger)', async () => {
  const w = world({ thread: S1_THREAD(), guardFacts: { threads: [{ thread_key: TK, last_intent: 'wrong_number' }] } })
  const r = await executeAiConversationReply(candidate(), deps({ w }).d)
  assert.equal(r.status, 'held')
  assert.ok(r.reasons.some((x) => x.startsWith('eligibility_blocked:')), JSON.stringify(r.reasons))
  const denied = [S1_THREAD()[0], msg('i1', 'inbound', 'wrong number, I do not own that', 5)]
  const dec = interestDecision({ intent: 'ownership_denied', facts_extracted: [{ fact: 'ownership', value: 'denied', source_message_id: 'i1', confidence: 0.95 }], proposed_message: 'Sorry about that. Would you consider selling it?' })
  const r2 = await executeAiConversationReply(candidate(dec), deps({ w: world({ thread: denied }) }).d)
  assert.equal(r2.status, 'held')
  assert.ok(r2.reasons.some((x) => x.includes('ownership_denied') || x.startsWith('ledger:')), JSON.stringify(r2.reasons))
})

// ── caps ────────────────────────────────────────────────────────────────────
test('caps: 1 per seller per day and the global daily cap (atomic reservations)', async () => {
  // seller cap: our AI reply went out today, the seller answered, a second AI reply the same day is held
  const sentToday = [...S1_THREAD(), msg('o2', 'outbound', 'Thanks for confirming. Would you consider selling it?', 4, { use_case: 'ai_consider_selling' }), msg('i2', 'inbound', 'maybe', 2)]
  await beginIdempotentProcessing({ scope: 'ai_conv_seller_day', key: `${sealedThreadRef(TK)}:2026-10-14` })
  const dec = makeDecision({ intent: 'conditional_interest', seller_interest: 'conditional', outcome: 'REPLY_CANDIDATE', next_objective: 'get_asking_price', response_needed: true, proposed_message: 'Fair enough. What price would you want for it?', confidence: 0.95, source_message_ids: ['i2'] })
  const r = await executeAiConversationReply(candidate(dec, { inbound: { id: 'i2', provider_message_sid: 'SM2', thread_key: TK } }), deps({ w: world({ thread: sentToday }) }).d)
  assert.equal(r.status, 'held')
  assert.deepEqual(r.reasons, ['seller_daily_cap'])
  // global: a policy that tightens the cap to 2 ⇒ the third seller is held
  __resetIdempotencyLedgerTestDeps()
  const sellers = ['+15555550111', '+15555550112', '+15555550113']
  const pol = JSON.stringify({ enabled: true, scope: { thread_keys: sellers }, limits: { max_per_day_global: 2 } })
  const table = makeTable()
  const results = []
  for (const [n, s] of sellers.entries()) {
    const iid = `i1-${n}`
    const th = [{ ...msg(`o1-${n}`, 'outbound', 'Hi, do you still own the house on Elm St?', 30, { use_case: 'ownership_check' }), thread_key: s, seller_phone: s }, { ...msg(iid, 'inbound', 'Yes I still own it', 5), thread_key: s, seller_phone: s }]
    const w = world({ thread: th, tk: s, seller: s })
    const dec = interestDecision({ source_message_ids: [iid], facts_extracted: [{ fact: 'ownership', value: 'confirmed', source_message_id: iid, confidence: 0.95 }], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [iid], rationale: 'ownership confirmed' } })
    results.push(await executeAiConversationReply(candidate(dec, { inbound: { id: iid, provider_message_sid: 'SM', thread_key: s } }), deps({ w, table, sw: switches({ [AI_SEND_POLICY_KEY]: pol }) }).d))
  }
  assert.deepEqual(results.map((x) => x.status), ['enqueued', 'enqueued', 'held'], JSON.stringify(results.map((x) => x.reasons)))
  assert.deepEqual(results[2].reasons, ['global_daily_cap'])
  assert.equal(table.inserts.length, 2)
})

// ── the repeat asking-price trigger ─────────────────────────────────────────
test('trigger mirror: the live predicate is parsed from the PROPOSED mirror migration', () => {
  assert.deepEqual(MIRROR.newStatuses, ['scheduled', 'queued', 'pending', 'approval'])
  assert.deepEqual(MIRROR.priorStatuses, ['sent', 'delivered', 'processing'])
  assert.equal(MIRROR.pattern, 'asking_price')
  assert.equal(MIRROR.paused, 'blocked_repeat_asking_price')
  assert.equal(MIRROR.trigger, 'INSERT OR UPDATE OF queue_status, use_case_template, scheduled_for_utc')
})

test('repeat price ask: the ledger holds it before insert; if a read race hides the prior ask, the trigger cancels it at insert', async () => {
  const thread = [
    msg('o1', 'outbound', 'Would you consider selling it?', 40, { use_case: 'consider_selling' }),
    msg('i0', 'inbound', 'maybe', 35),
    msg('o2', 'outbound', 'What price would you want for it?', 30, { use_case: 'seller_asking_price' }),
    msg('i1', 'inbound', 'hmm let me think', 5),
  ]
  const dec = makeDecision({ intent: 'need_time', seller_interest: 'conditional', outcome: 'REPLY_CANDIDATE', next_objective: 'get_asking_price', response_needed: true, proposed_message: 'No rush. What price would you want for it?', confidence: 0.95, source_message_ids: ['i1'] })
  const r = await executeAiConversationReply(candidate(dec), deps({ w: world({ thread }) }).d)
  assert.equal(r.status, 'held')
  assert.ok(r.reasons.includes('ledger:already_asked:asking_price'), JSON.stringify(r.reasons))
  // read race: the loader saw no price ask, but a price-ask row is being sent right now
  __resetIdempotencyLedgerTestDeps()
  const raceThread = [msg('o1', 'outbound', 'Would you consider selling it?', 40, { use_case: 'consider_selling' }), msg('i1', 'inbound', 'maybe', 5)]
  const table = makeTable()
  table.rows.push({ id: 'prior', thread_key: TK, queue_status: 'processing', use_case_template: 'seller_asking_price', queue_key: 'x' })
  const dec2 = makeDecision({ intent: 'conditional_interest', seller_interest: 'conditional', outcome: 'REPLY_CANDIDATE', next_objective: 'get_asking_price', response_needed: true, proposed_message: 'Fair enough. What price would you want for it?', confidence: 0.95, source_message_ids: ['i1'] })
  const r2 = await executeAiConversationReply(candidate(dec2), deps({ w: world({ thread: raceThread }), table }).d)
  assert.equal(r2.status, 'blocked_at_insert', JSON.stringify(r2))
  assert.deepEqual(r2.reasons, ['blocked_repeat_asking_price'])
  assert.equal(table.inserts[0].queue_status, 'cancelled')
  assert.equal(table.inserts[0].use_case_template, 'ai_seller_asking_price')
})

// ── template coexistence ────────────────────────────────────────────────────
test('coexistence: AI on + in scope ⇒ template defers; out of scope ⇒ template reserves the inbound and the AI stands down; AI first ⇒ template defers', async () => {
  const gsv = (v) => async (k) => v[k] ?? null
  const on = { [AI_SEND_KILL_SWITCH_KEY]: 'true', [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: [TK] } }) }
  assert.deepEqual(await evaluateTemplateCoexistence({ inbound_message_event_id: 'i1', thread_key: TK, getSystemValue: gsv(on), executorWired: true }), { defer: true, reason: 'deferred_to_ai_conversation' })
  assert.equal((await evaluateTemplateCoexistence({ inbound_message_event_id: 'i1', thread_key: TK, getSystemValue: gsv({}), executorWired: true })).defer, false)
  // out of scope: the template claims inbound_reply:i9; an AI run for i9 is then a duplicate
  const c = await evaluateTemplateCoexistence({ inbound_message_event_id: 'i9', thread_key: '+15555550177', getSystemValue: gsv(on), executorWired: true })
  assert.deepEqual(c, { defer: false, reason: 'template_reserved_inbound' })
  const again = await beginIdempotentProcessing({ scope: 'inbound_reply', key: 'i9' })
  assert.equal(again.duplicate, true)
  // AI reserved first ⇒ the template defers even for an out-of-scope view
  const w = world({ thread: S1_THREAD() })
  assert.equal((await executeAiConversationReply(candidate(), deps({ w }).d)).status, 'enqueued')
  const t = await evaluateTemplateCoexistence({ inbound_message_event_id: 'i1', thread_key: TK, getSystemValue: gsv({ ...on, [AI_SEND_POLICY_KEY]: JSON.stringify({ enabled: true, scope: { thread_keys: ['other'] } }) }), executorWired: true })
  assert.deepEqual(t, { defer: true, reason: 'inbound_reply_reserved_by_other_engine' })
})

