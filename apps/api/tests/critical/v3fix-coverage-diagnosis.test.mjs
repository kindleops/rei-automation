// rc-8.5.21 v3 — SAFE-REPLY COVERAGE DIAGNOSIS (v3: 18/53). A deterministic corpus written from the five
// cause descriptions (never from the blind cases). Each scenario names its cause and whether the loss is a
// GENUINE defect (fixed here, asserted to reply / route correctly) or a CORRECT hold (asserted to stay held:
// coverage is never bought with safety). Run against the pre-fix head the genuine-defect scenarios fail;
// that is the count reported in the release notes.
//   drafts rejected twice  · ambiguity holds · turns closed with no reply · R3 holds · insufficient context
import test from 'node:test'
import assert from 'node:assert/strict'

import { ledgerFromContextInput, buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { identityStatementReasons } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { canonicalRoutineScope } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'

const T = (min) => new Date(Date.parse('2026-10-19T16:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min, use_case = null) => ({ id, direction: 'outbound', body, at: T(min), use_case, property_id: 'p7' })
const inb = (id, body, min) => ({ id, direction: 'inbound', body, at: T(min), property_id: 'p7' })
const OWN = [out('o1', 'Hi, this is Jon. Do you still own 18 Birch Ct?', 300, 'ownership_check'), inb('i1', 'yes', 290), out('o2', 'Would you consider selling it?', 280, 'consider_selling'), inb('i2', 'maybe', 270), out('o3', 'What price would you be looking for?', 200, 'seller_asking_price')]
function decide(thread, members = null) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const memberIds = members || []
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: 'p7' }, thread: thread.filter((m) => m !== last), properties: [{ property_id: 'p7', address: '18 Birch Ct' }], language: 'English', turn_member_ids: memberIds }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  return { ledger, plan: decideActions({ ledger, inboundText: last.body, inboundId: last.id, eligibility: { blocked: false }, language: 'English', propertyCount: 1, thread: input.thread, inbound: input.inbound, memberIds }) }
}
const replies = (p) => p.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY || a.type === ACTIONS.DETERMINISTIC_REPLY)

// ── 1. ambiguity holds: a burst decided on its latest fragment only (GENUINE) ──
const BURSTS = [
  [inb('b1', 'probably around 230k', 12), inb('b2', 'for the house', 11), inb('b3', 'just so you know', 10)],
  [inb('b1', 'I would take 199,000', 12), inb('b2', 'firm-ish', 11), inb('b3', 'lol', 10)],
  [inb('b1', 'it is vacant right now and I want 210k', 12), inb('b2', 'thanks', 11), inb('b3', 'jon', 10)],
]
for (const [i, burst] of BURSTS.entries()) {
  test(`coverage/ambiguity #${i + 1} (genuine): a burst whose price is in an EARLIER fragment replies when safe`, () => {
    const r = decide([...OWN, ...burst], burst.map((m) => m.id))
    assert.notEqual(r.plan.reasons[0], 'ambiguous', JSON.stringify(r.plan))
    assert.ok(replies(r.plan), JSON.stringify(r.plan))
  })
}
test('coverage/ambiguity (correct hold): a single unreadable fragment with nothing recognised stays the ambiguous hold', () => {
  const r = decide([...OWN, inb('x1', 'hmm idk what to tell u', 10)])
  assert.ok(!replies(r.plan))
})

// ── 2. drafts rejected twice: a truthful identity answer to a question asked in an EARLIER fragment (GENUINE) ──
const IDENTITY = [
  ['is this a bot', 'or a real person', "I'm a real person, Jon, a local buyer."],
  ['are you an AI?', 'just curious', "No, I'm Jon, a real person. I buy houses locally."],
]
for (const [i, [q1, q2, draft]] of IDENTITY.entries()) {
  test(`coverage/rejected-draft #${i + 1} (genuine): the truthful automation answer is not rejected when the question was in an earlier fragment`, () => {
    const L = buildCanonicalLedger({ messages: [...OWN, inb('q1', q1, 12), inb('q2', q2, 10)] })
    assert.ok(!identityStatementReasons(draft, L).includes('identity:automation_statement_not_asked'), JSON.stringify(identityStatementReasons(draft, L)))
  })
}
test('coverage/rejected-draft (correct rejection): an automation statement nobody asked about is still rejected', () => {
  const L = buildCanonicalLedger({ messages: [...OWN, inb('q1', 'how much are we talking', 10)] })
  assert.ok(identityStatementReasons("I'm not a bot, just a local buyer.", L).includes('identity:automation_statement_not_asked'))
})

// ── 3. turns closed with no reply ─────────────────────────────────────────
const QUOTE = [...OWN, inb('i3', 'make me an offer', 190), out('o4', 'We could do $176,000 cash for 18 Birch Ct, any questions?', 100)]
test('coverage/closed #1 (genuine): "No, I\'m good with the amount you proposed" is an acceptance for a person — never closed as disinterest', () => {
  const r = decide([...QUOTE, inb('a1', "No, I'm good with the amount you proposed", 10)])
  assert.equal(r.plan.reasons[0], 'seller_accepted_proposal_verify')
})
test('coverage/closed #2 (genuine): "call me" is an operator task, not a silent close / hold', () => {
  const r = decide([...OWN, inb('c1', 'give me a call this evening', 10)])
  assert.equal(r.plan.reasons[0], 'callback_request_operator_task')
})
test('coverage/closed (correct close): an acknowledgement after our last question gets no reply', () => {
  const r = decide([...OWN, inb('k1', 'ok', 10)])
  assert.ok(!replies(r.plan))
})

// ── 4. R3 holds: an offer request in an earlier fragment of THIS burst (GENUINE) ──
test('coverage/R3 #1 (genuine): asking their number once is in scope when the offer request was an earlier fragment of this burst', () => {
  const L = buildCanonicalLedger({ messages: [out('o1', 'Hi, this is Jon. Do you still own 18 Birch Ct?', 300, 'ownership_check'), inb('i1', 'yes', 290), inb('r1', 'what would you pay', 12), inb('r2', 'for it', 10)] })
  const record = { terminal: { type: ACTIONS.AI_GENERATED_REPLY }, reply: { category: 'next_missing_fact', objective: 'asking_price', text: 'Do you have a number in mind for it?' }, inbound_message_id: 'r2' }
  const scope = canonicalRoutineScope(record, { languageEnglish: true, policy: { categories: ['next_missing_fact'], min_confidence: 0.85 }, inboundText: 'for it', ledger: { ...L, next_missing: 'asking_price' }, thread: [], inbound: { id: 'r2', body: 'for it' } })
  assert.ok(!scope.reasons.includes('excluded_offer_on_thread'), JSON.stringify(scope.reasons))
})
test('coverage/R3 (correct hold): a LIVE quote on the thread stays out of routine scope', () => {
  const L = buildCanonicalLedger({ messages: QUOTE.concat([inb('z1', 'hmm', 10)]) })
  const record = { terminal: { type: ACTIONS.AI_GENERATED_REPLY }, reply: { category: 'clarification', objective: 'none', text: 'Any questions on it?' }, inbound_message_id: 'z1', judgment: { confidence: 0.9 } }
  const scope = canonicalRoutineScope(record, { languageEnglish: true, policy: { categories: ['clarification'], min_confidence: 0.85 }, ledger: L, inbound: { id: 'z1', body: 'hmm' } })
  assert.ok(scope.reasons.includes('excluded_live_negotiation'))
})

// ── 5. insufficient context: model-dependent (an unmapped / unevidenced model escalation). Not reproducible
//       without the model; the deterministic rule stays: a claim without evidence is insufficient_context.
test('coverage/insufficient-context (correct hold): a model escalation claiming several properties with no evidence stays insufficient_context', async () => {
  const { mapModelEscalation } = await import('../../src/lib/domain/conversation-ai/escalation-evidence.js')
  const e = mapModelEscalation({ escalation_required: true, escalation_reason: 'multiple_properties' }, { inboundText: 'yes', ledger: { requests: [] }, thread: [], inbound: { id: 'x' } })
  assert.equal(e.reason, 'insufficient_context')
})
