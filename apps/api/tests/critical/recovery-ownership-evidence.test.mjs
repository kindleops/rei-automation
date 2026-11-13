// 8.5.21-b owner fix (2026-10-16): ownership is confirmed ONLY by real evidence (an explicit yes, or a
// seller statement that implies ownership) — never by pipeline stage rank (`closed` ranked above
// `offer_interest`, so every dead deal read "confirmed"). A bare "No" to OUR ownership question is a
// property-scoped denial (canonical ledger). Recovery skips denials and routes RECENT genuine disinterest
// to the 30-day nurture intent (the 8.5.21-a follow-up pipeline executes); older replies are historical
// recovery needing an owner-approved scope.
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConversationFacts, verifyContactPermission } from '../../src/lib/agent/operations/conversation-facts.js'
import { classifyRecoveryCandidate } from '../../src/lib/agent/operations/recovery-classifier.js'
import { ownershipEvidenceFromThread, nurtureIntentFor, NURTURE_INTENT_CONTRACT } from '../../src/lib/agent/operations/ownership-evidence.js'
import { buildNotInterestedCorrectionPlan } from '../../src/lib/agent/operations/dead-deal-correction.js'
import { createRecoverySweepHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { RECOVERY_SWEEP_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { conv, waiting, uuid, T0, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const closedNo = (o = {}) => waiting({ opportunity_id: uuid(), opp_stage: 'closed', opp_status: 'dead', seller_stage: 'closed', opp_stage_entered_at: at(T0 - 10 * D), opp_last_activity_at: at(T0 - 10 * D), last_meaningful_intent: 'not_interested', inbound_intents: ['not_interested'], last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D), ...o })
const facts = (r) => normalizeConversationFacts(r)

test('stage rank never confirms ownership: a closed deal with only "not interested" is UNVERIFIED (8.5.20 said confirmed)', () => {
  const p = verifyContactPermission(facts(closedNo()))
  assert.equal(p.ownership, 'unverified')
  assert.equal(verifyContactPermission(facts(conv({ seller_stage: 'offer', inbound_intents: ['acknowledgement'] }))).ownership, 'unverified', 'a late stage alone proves nothing')
})

test('implied ownership: an explicit yes or a seller statement that implies ownership confirms it', () => {
  for (const i of ['ownership_confirmed', 'asking_price_provided', 'condition_disclosed', 'asks_offer', 'seller_interested']) {
    assert.equal(verifyContactPermission(facts(conv({ inbound_intents: [i] }))).ownership, 'confirmed', i)
  }
  assert.equal(verifyContactPermission(facts(conv({ inbound_intents: ['not_interested'], ownership_evidence: 'confirmed' }))).ownership, 'confirmed', 'the canonical ledger may confirm')
})

test('canonical ledger: a bare "No" to OUR ownership question is a denial; the same "No" to the interest question is disinterest', () => {
  const ownQ = [{ id: 'o1', direction: 'outbound', message_body: 'Hi, is this the owner of the house on Example St?', created_at: at(T0 - 3 * D) }, { id: 'i1', direction: 'inbound', message_body: 'No', created_at: at(T0 - 2 * D), detected_intent: 'not_interested' }]
  assert.equal(ownershipEvidenceFromThread(ownQ).ownership, 'denied')
  const intQ = [{ id: 'o1', direction: 'outbound', message_body: 'Thanks for confirming. Would you consider selling it?', created_at: at(T0 - 3 * D) }, { id: 'i1', direction: 'inbound', message_body: 'No', created_at: at(T0 - 2 * D), detected_intent: 'not_interested' }]
  const e = ownershipEvidenceFromThread(intQ)
  assert.notEqual(e.ownership, 'denied')
  assert.equal(e.source, 'canonical_ledger')
})

test('denial → closed: an ownership "No" on a dead deal is a property-scoped denial — recovery skips it, the dead-deal plan excludes it, no nurture', () => {
  const f = facts(closedNo({ ownership_evidence: 'denied' }))
  const c = classifyRecoveryCandidate(f, { now: T0 })
  assert.equal(c.class, 'wrong_owner_or_number')
  assert.ok(c.permission.blocks.includes('ownership_denied'))
  assert.equal(nurtureIntentFor(f, c, { now: T0 }).reason, 'ownership_denied_or_wrong_number_property_scoped')
  const plan = buildNotInterestedCorrectionPlan([f], { now: T0 })
  assert.deepEqual([plan.count, plan.skipped.ownership_denied_property_scoped], [0, 1])
})

test('closed after GENUINE disinterest: stays in the PROPOSED plan (nurture), ownership unverified; a RECENT one builds the nurture intent, an old one needs the historical scope', () => {
  const recent = facts(closedNo({ last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D) }))
  const c = classifyRecoveryCandidate(recent, { now: T0 })
  assert.equal(c.class, 'previously_closed')
  const plan = buildNotInterestedCorrectionPlan([recent], { now: T0 })
  assert.deepEqual([plan.count, plan.entries[0].ownership, plan.entries[0].after.opportunity_status], [1, 'unverified', 'nurture'])
  const ni = nurtureIntentFor(recent, c, { now: T0 })
  assert.equal(ni.intent.contract, NURTURE_INTENT_CONTRACT)
  assert.equal(ni.intent.due_at, at(T0 - 2 * D + 30 * D))
  assert.equal(ni.intent.sends, 0)
  const old = facts(closedNo({ last_inbound_at: at(T0 - 40 * D), last_meaningful_at: at(T0 - 40 * D) }))
  assert.equal(nurtureIntentFor(old, classifyRecoveryCandidate(old, { now: T0 }), { now: T0 }).reason, 'historical_requires_owner_scope')
  const stopped = facts(closedNo({ any_opt_out: true }))
  assert.equal(nurtureIntentFor(stopped, classifyRecoveryCandidate(stopped, { now: T0 }), { now: T0 }).reason, 'suppressed')
})

test('recovery.sweep: ledger evidence wired ⇒ denials skipped; recent disinterest → nurture intent enqueued to the follow-up pipeline (A executes); nothing sent', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [RECOVERY_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const denied = closedNo({ conversation_id: uuid(), cursor_at: '2026-10-15 01:00:00.000001+00' })
  const genuine = closedNo({ conversation_id: uuid(), cursor_at: '2026-10-15 01:00:00.000002+00' })
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const intents = []
  const handler = createRecoverySweepHandler({ source: createOperationsMemorySource({ conversations: [denied, genuine] }), store, now: () => t, linkage: { ownershipEvidenceFor: async (f) => ({ ownership: f.conversation_id === denied.conversation_id ? 'denied' : null }), enqueueFollowupIntent: async (i) => { intents.push(i); return { ok: true } } } })
  await runtime.enqueue({ kind: RECOVERY_SWEEP_KIND, idempotency_key: 'e'.repeat(64), input: {}, requested_by: OP })
  await runRuntimeTick({ store: runtime, handlers: { [RECOVERY_SWEEP_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t })
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.deepEqual(intents.map((i) => i.conversation_id), [genuine.conversation_id])
  assert.equal(job.result.nurture_intents.enqueued, 1)
  assert.equal(job.result.nurture_intents.skipped.ownership_denied_or_wrong_number_property_scoped, 1)
  assert.equal(job.result.by_class.wrong_owner_or_number, 1)
  assert.equal(job.result.sends, 0)
})
