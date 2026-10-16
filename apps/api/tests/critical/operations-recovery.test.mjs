// 8.5.20 part C — historical opportunity recovery: the classifier (every class, the
// suppressed / wrong-number / ownership-denial / closed exclusions, permission before
// "eligible", approved-program scope) and the NO-SEND guarantee (static + runtime).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConversationFacts } from '../../src/lib/agent/operations/conversation-facts.js'
import { classifyRecoveryCandidate, detectRecoverySignals, recoveryPriority, RECOVERY_CLASSES } from '../../src/lib/agent/operations/recovery-classifier.js'
import { createRecoverySweepHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { RECOVERY_SWEEP_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { conv, waiting, uuid, T0, H, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const cls = (row, o = {}) => classifyRecoveryCandidate(normalizeConversationFacts(row), { now: T0, ...o })

test('classes: exactly the seven, one per candidate', () => {
  assert.deepEqual(RECOVERY_CLASSES, ['research_worthy', 'eligible_for_approved_followup', 'needs_human_review', 'currently_unworkable', 'suppressed', 'wrong_owner_or_number', 'previously_closed'])
})

test('suppressed: opt-out, suppression list, do-not-contact and the thread flag all exclude — before any signal is weighed', () => {
  const interested = { inbound_intents: ['seller_interested', 'asks_offer'], last_meaningful_intent: 'asks_offer' }
  for (const o of [{ any_opt_out: true }, { suppression_listed: true }, { contactability_status: 'opted_out' }, { contactability_status: 'do_not_contact' }, { is_suppressed: true }, { disposition: 'suppressed' }, { inbound_intents: ['seller_interested', 'opt_out'] }]) {
    const c = cls(waiting({ ...interested, ...o }))
    assert.equal(c.class, 'suppressed', JSON.stringify(o))
    assert.equal(c.permission.permitted, false)
  }
})

test('wrong owner or number: wrong number (intent / disposition / invalid number) and a PROPERTY-SCOPED ownership denial', () => {
  for (const o of [{ inbound_intents: ['wrong_number'] }, { disposition: 'wrong_person' }, { contactability_status: 'invalid_number' }, { inbound_intents: ['property_specific_non_owner'] }, { inbound_intents: ['sold_property'] }, { inbound_intents: ['tenant_respondent'] }]) {
    const c = cls(waiting({ ...o, last_meaningful_intent: o.inbound_intents?.[0] || 'unclear' }))
    assert.equal(c.class, 'wrong_owner_or_number', JSON.stringify(o))
  }
  // a stop request outranks a wrong number: suppression
  assert.equal(cls(waiting({ inbound_intents: ['wrong_number', 'opt_out'] })).class, 'suppressed')
})

test('previously closed: a dead deal stays closed on a "not interested"; a meaningful reply after the close reopens the evaluation', () => {
  const closed = { opportunity_id: uuid(), opp_stage: 'closed', opp_status: 'dead', opp_stage_entered_at: at(T0 - 10 * D), opp_last_activity_at: at(T0 - 10 * D) }
  const c1 = cls(conv({ ...closed, last_inbound_at: at(T0 - 20 * D), last_meaningful_at: at(T0 - 20 * D) }))
  assert.equal(c1.class, 'previously_closed')
  const c2 = cls(waiting({ ...closed, last_meaningful_intent: 'not_interested', inbound_intents: ['not_interested'], last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D) }))
  assert.equal(c2.class, 'previously_closed', 'a "no" after the close does not reopen it')
  assert.ok(c2.reasons.includes('closed_after_not_interested_policy_says_30_day_follow_up'))
  const c3 = cls(waiting({ ...closed, last_meaningful_intent: 'asks_offer', inbound_intents: ['asks_offer'], last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D), last_outbound_at: at(T0 - 11 * D) }))
  assert.equal(c3.class, 'needs_human_review')
  assert.ok(c3.reasons.includes('reopened_by_seller_after_close'))
})

test('needs human review: the seller is waiting on us; a failed reply says whether the provider accepted it (never re-send automatically)', () => {
  const c = cls(waiting({ inbound_intents: ['ownership_confirmed', 'asks_offer'], last_meaningful_intent: 'asks_offer', last_inbound_at: at(T0 - 3 * H), last_meaningful_at: at(T0 - 3 * H) }))
  assert.equal(c.class, 'needs_human_review')
  assert.deepEqual(c.reasons, ['offer_request_unanswered'])
  const f1 = cls(conv({ outbound_after_inbound: 1, delivered_after_inbound: 0, failed_after_inbound: 1 }))
  assert.equal(f1.class, 'needs_human_review')
  assert.deepEqual(f1.reasons, ['reply_failed_after_provider_accepted_never_resend_automatically'])
  const f2 = cls(conv({ outbound_after_inbound: 0, delivered_after_inbound: 0, failed_internal_after_inbound: 1 }))
  assert.deepEqual(f2.reasons, ['reply_failed_before_provider'])
  for (const [o, r] of [[{ inbound_intents: ['hostile_or_legal'] }, 'hostile_or_legal_language'], [{ inbound_intents: ['executor_heir_respondent'] }, 'third_party_respondent'], [{ last_inbound_language: 'italian' }, 'language_without_approved_copy']]) {
    assert.deepEqual(cls(conv(o)).reasons, [r])
  }
  // an unknown language is unknown, not "unsupported"
  assert.notDeepEqual(cls(conv({ last_inbound_language: null })).reasons, ['language_without_approved_copy'])
})

test('"No" to selling is a 30-day follow-up, never an unanswered message: inside the window → unworkable; after it → only an APPROVED program makes it eligible', () => {
  const ni = (days) => waiting({ inbound_intents: ['ownership_confirmed', 'not_interested'], last_meaningful_intent: 'not_interested', last_inbound_intent: 'not_interested', last_inbound_at: at(T0 - days * D), last_meaningful_at: at(T0 - days * D), last_outbound_at: at(T0 - days * D - H) })
  assert.deepEqual([cls(ni(5)).class, cls(ni(5)).reasons], ['currently_unworkable', ['inside_not_interested_nurture_window']])
  const later = cls(ni(40))
  assert.equal(later.class, 'needs_human_review')
  assert.deepEqual(later.reasons, ['no_approved_reengagement_scope'])
  assert.equal(later.program, 'not_interested_30d_nurture')
  const ok = cls(ni(40), { approved_programs: ['not_interested_30d_nurture'] })
  assert.equal(ok.class, 'eligible_for_approved_followup')
  assert.equal(ok.permission.permitted, true)
  assert.equal(ok.permission.ownership, 'confirmed')
})

test('eligible requires verified permission AND ownership: an approved program never overrides a block or an unverified owner', () => {
  const base = { inbound_intents: ['not_interested'], last_meaningful_intent: 'not_interested', last_inbound_at: at(T0 - 40 * D), last_meaningful_at: at(T0 - 40 * D), last_outbound_at: at(T0 - 41 * D), seller_stage: 'ownership_confirmation' }
  const unverified = cls(waiting(base), { approved_programs: ['not_interested_30d_nurture'] })
  assert.equal(unverified.class, 'needs_human_review')
  assert.deepEqual(unverified.reasons, ['ownership_unverified'])
  for (const block of [{ suppression_listed: true }, { contactability_status: 'do_not_text' }, { disposition: 'wrong_number' }]) {
    const c = cls(waiting({ ...base, inbound_intents: ['ownership_confirmed', 'not_interested'], ...block }), { approved_programs: ['not_interested_30d_nurture'] })
    assert.notEqual(c.class, 'eligible_for_approved_followup', JSON.stringify(block))
  }
  // an expired follow-up date inside an active cadence enrollment: eligible only with that program approved
  const enrolled = conv({ followups_active: 1, followup_next_at: at(T0 - 2 * D), follow_up_at: at(T0 - 2 * D), last_outbound_at: at(T0 - 5 * D), last_inbound_at: at(T0 - 6 * D), last_meaningful_at: at(T0 - 6 * D) })
  assert.equal(cls(enrolled).class, 'needs_human_review')
  assert.equal(cls(enrolled, { approved_programs: ['enrolled_followup_cadence'] }).class, 'eligible_for_approved_followup')
})

test('research worthy: viable history we spoke last on — previous interest, abandoned negotiation, old price, new evidence (8.5.19 economics)', () => {
  const r = cls(conv({ last_outbound_at: at(T0 - 20 * D), last_inbound_at: at(T0 - 21 * D), last_meaningful_at: at(T0 - 21 * D), inbound_intents: ['asking_price_provided'], last_meaningful_intent: 'asking_price_provided', opportunity_id: uuid(), opp_stage: 'asking_price', opp_status: 'active', opp_asking_price: '150000', opp_last_activity_at: at(T0 - 20 * D) }))
  assert.equal(r.class, 'research_worthy')
  assert.ok(r.reasons.includes('abandoned_negotiation'))
  const det = detectRecoverySignals(normalizeConversationFacts(conv({ inbound_intents: [], last_meaningful_intent: 'unclear', last_inbound_at: at(T0 - 40 * D), last_meaningful_at: at(T0 - 40 * D), last_outbound_at: at(T0 - 39 * D), opportunity_id: uuid(), opp_stage: 'offer_interest', opp_status: 'nurture', opp_asking_price: 150000, pas_id: uuid(), pas_computed_at: at(T0 - D), investor_ceiling_high: 170000 })), { now: T0 })
  assert.ok(det.some((d) => d.code === 'material_new_evidence' && d.ask_within_buyer_ceiling))
  const pass = cls(conv({ last_outbound_at: at(T0 - 20 * D), inbound_intents: ['seller_interested'] }), { economics: { class: 'PASS' } })
  assert.deepEqual([pass.class, pass.reasons], ['currently_unworkable', ['economics_pass']])
  const hot = cls(conv({ last_outbound_at: at(T0 - 20 * D), inbound_intents: [], last_meaningful_intent: 'unclear' }), { economics: { class: 'HOT' } })
  assert.equal(hot.class, 'research_worthy')
  assert.ok(recoveryPriority(hot) >= 25)
})

test('currently unworkable: no recovery signal', () => {
  const c = cls(conv({ inbound_intents: ['acknowledgement'], last_meaningful_intent: null, last_meaningful_id: null, last_inbound_intent: 'acknowledgement' }))
  assert.equal(c.class, 'currently_unworkable')
})

test('evidence refs are ids only (no phone, no body)', () => {
  const c = cls(waiting({ opportunity_id: uuid(), opp_stage: 'asking_price', opp_status: 'active', pas_id: uuid() }))
  for (const r of c.evidence_refs) assert.match(r.record_id, /^[0-9a-f-]{36}$/)
  assert.equal(c.property_ref.startsWith('pid_'), true)
})

// ── the no-send guarantee ───────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const OPS_DIR = path.resolve(here, '../../src/lib/agent/operations')

test('NO-SEND (static): the operations module imports no send / queue / provider path and its SQL never writes', () => {
  const files = fs.readdirSync(OPS_DIR).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 10)
  const forbidden = /from ['"][^'"]*(queue|textgrid|send-now|sendNow|outbound|sms|twilio|provider|brevo|email|campaign-launch|launch|messaging)[^'"]*['"]/i
  for (const f of files) {
    const src = fs.readFileSync(path.join(OPS_DIR, f), 'utf8')
    const imports = src.split('\n').filter((l) => /^\s*import\b|^export .* from /.test(l))
    for (const l of imports) assert.doesNotMatch(l, forbidden, `${f}: ${l}`)
    assert.doesNotMatch(src, /\binvoke\(\{\s*capability_id:\s*'(inbox\.prepare_reply|campaigns\.)/, `${f} prepares no message and no campaign`)
  }
  // the recovery sweep has no capability plane at all; only pipeline.reconcile invokes one capability
  const h = fs.readFileSync(path.join(OPS_DIR, 'operations-handlers.js'), 'utf8')
  assert.deepEqual([...new Set([...h.matchAll(/capability_id:\s*'([a-z_.]+)'/g)].map((m) => m[1]))], ['pipeline.propose_stage_change'])
  const sql = fs.readFileSync(path.join(OPS_DIR, 'operations-sql.js'), 'utf8')
  assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public\.|delete\s+from|truncate|alter\s+table|create\s+table)\b/i)
})

test('NO-SEND (runtime): a scheduled recovery.sweep reads, classifies, records findings + review items, advances the watermark — and sends, queues, invokes nothing', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [RECOVERY_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const rows = [
    waiting({ inbound_intents: ['asks_offer'], last_meaningful_intent: 'asks_offer', cursor_at: '2026-10-15 01:00:00.000001+00' }),
    conv({ any_opt_out: true, cursor_at: '2026-10-15 01:00:00.000002+00' }),
    conv({ last_outbound_at: at(T0 - 20 * D), inbound_intents: ['seller_interested'], cursor_at: '2026-10-15 01:00:00.000003+00' }),
  ]
  const source = createOperationsMemorySource({ conversations: rows })
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const handler = createRecoverySweepHandler({ source, store, now: () => t })
  await runtime.upsertSchedule({ name: 'recovery-sweep', kind: RECOVERY_SWEEP_KIND, interval_seconds: 21600, created_by: OP, input: { batch_limit: 2, approved_programs: [] }, enabled: true, next_run_at: at(t - 1000) })
  const tick = () => runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: handler }, workerId: 'w1', budgetMs: 20_000, now: () => t })
  await tick()
  const jobs = [...runtime._state.jobs.values()].filter((j) => j.kind === RECOVERY_SWEEP_KIND)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].state, 'completed', JSON.stringify(jobs[0].last_error))
  assert.equal(jobs[0].result.scanned, 2, 'bounded by batch_limit')
  assert.equal(jobs[0].result.sends, 0)
  const sched = [...runtime._state.schedules.values()][0]
  assert.equal(sched.watermark.after_at, rows[1].cursor_at, 'the cursor is the raw text (microseconds)')
  assert.equal(sched.watermark.pass_done_at, null)
  // the second slot continues after the cursor and finishes the pass
  t += 21600_000 + 1000
  await tick()
  const j2 = [...runtime._state.jobs.values()].filter((j) => j.kind === RECOVERY_SWEEP_KIND).find((j) => j.job_id !== jobs[0].job_id)
  assert.equal(j2.result.scanned, 1)
  assert.equal(j2.result.pass_done, true)
  const findings = [...runtime._state.findings.values()]
  assert.ok(findings.some((f) => f.finding_type === 'recovery.candidate' && f.value.class === 'needs_human_review'))
  assert.ok(findings.some((f) => f.finding_type === 'recovery.candidate' && f.value.class === 'research_worthy'))
  assert.ok(!findings.some((f) => f.finding_type === 'recovery.candidate' && f.value.class === 'suppressed'), 'suppressed conversations become counts, never review items')
  const items = [...store._items.values()]
  assert.deepEqual(items.map((i) => i.kind).sort(), ['recovery_research', 'recovery_review'])
  assert.ok(items.every((i) => i.dedupe_key.startsWith('recovery:conv:')))
  // only reads and agent-schema writes happened
  assert.deepEqual([...new Set(source.calls)], ['conversationFacts'])
  assert.deepEqual([...new Set(store.writes.map((w) => w.fn))], ['syncWorkItems'], 'no action-state write, nothing outside schema agent')
  assert.ok(!runtime._state.ledger.length, 'no model reserve: $0')
})

test('recovery.sweep: a candidate that becomes suppressed auto-resolves its open review item; an operator dismissal stands', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [RECOVERY_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const id = uuid()
  const rows = [waiting({ conversation_id: id, inbound_intents: ['asks_offer'], last_meaningful_intent: 'asks_offer' })]
  const source = createOperationsMemorySource({ conversations: rows })
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const handler = createRecoverySweepHandler({ source, store, now: () => t })
  const run = async (key) => { await runtime.enqueue({ kind: RECOVERY_SWEEP_KIND, idempotency_key: key.repeat(64), input: {}, requested_by: OP }); await runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t }) }
  await run('a')
  assert.equal(store._items.get(`recovery:conv:${id}`).state, 'open')
  rows[0].any_opt_out = true
  t += H
  await run('b')
  assert.equal(store._items.get(`recovery:conv:${id}`).state, 'resolved')
  assert.equal(store._items.get(`recovery:conv:${id}`).resolved_by, 'auto:condition_cleared')
  // the opt-out is lifted in the data (test only): the condition recurs → the auto-resolved item reopens
  rows[0].any_opt_out = false
  t += H
  await run('c')
  const item = store._items.get(`recovery:conv:${id}`)
  assert.equal(item.state, 'open')
  // an operator dismisses it: a later sweep that still sees the condition does not reopen it
  assert.equal((await store.decideWorkItem({ work_item_id: item.work_item_id, by: OP, action: 'dismiss' })).ok, true)
  t += H
  await run('d')
  assert.equal(store._items.get(`recovery:conv:${id}`).state, 'dismissed')
})
