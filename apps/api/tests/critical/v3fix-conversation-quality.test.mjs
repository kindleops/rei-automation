// rc-8.5.21 v3 fix pass — CONVERSATION QUALITY with no safety loosening. Written from the defect
// descriptions (v3-defect-queue.md), never from the blind cases (new addresses / phrasings).
//   S1–S5     condition is never asked before the price unless the seller gave the price or raised
//             condition themselves (seen 3× in v3)
//   memory    a previously supplied asking price is remembered (a bare "250" answering our price question)
//   context   acceptance ("No, I'm good with the amount you proposed"), counteroffer, callback, disinterest
//   authority before any agreement action the offer, property and authority are verified; never automatic
//   burst     a burst consolidated into one turn still replies when safe (RT-11 / RT-05)
import test from 'node:test'
import assert from 'node:assert/strict'

import { classify } from '../../src/lib/domain/classification/classify.js'
import { ledgerFromContextInput, buildCanonicalLedger, validateProposedMessage } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { identityStatementReasons } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { acceptsOurProposal } from '../../src/lib/domain/conversation-ai/acceptance.js'
import { applyS3DeflectionRule } from '../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js'
import { evaluateAutonomousAcceptance, ACCEPTANCE_REVIEW_REASONS } from '../../src/lib/domain/holds/automation-hold.js'
import { __setEnqueueContactRestrictionsResolverForTests } from '../../src/lib/domain/queue/enqueue-contact-restrictions.js'

const T = (min) => new Date(Date.parse('2026-10-19T16:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min, use_case = null) => ({ id, direction: 'outbound', body, at: T(min), use_case, property_id: 'p9' })
const inb = (id, body, min, intent = null) => ({ id, direction: 'inbound', body, at: T(min), intent, property_id: 'p9' })
const PROPS = [{ property_id: 'p9', address: '77 Larch Ave' }]
function decide(thread, { memberIds = [], judgment = null } = {}) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: 'p9' }, thread: thread.filter((m) => m !== last), properties: PROPS, language: 'English', turn_member_ids: memberIds }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const plan = decideActions({ ledger, inboundText: last.body, inboundId: last.id, eligibility: { blocked: false }, judgment, language: 'English', propertyCount: 1, thread: input.thread, inbound: input.inbound, memberIds })
  return { ledger, plan, types: plan.actions.map((a) => a.type), reason: plan.reasons[0] }
}
const asksCondition = (plan) => plan.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY && a.objective === 'condition')
const OWN = [out('o1', 'Hi, this is Mara. Do you still own 77 Larch Ave?', 300, 'ownership_check'), inb('i1', 'yes I do', 290), out('o2', 'Would you consider an offer on it?', 280, 'consider_selling'), inb('i2', 'maybe', 270)]

test('S1–S5: an offer request before any price asks for THEIR number once — never condition first', () => {
  const r = decide([...OWN, inb('i3', 'what would you pay for it?', 10)], { judgment: { outcome: 'REPLY_CANDIDATE', intent: 'asks_offer', confidence: 0.9 } })
  assert.equal(r.reason, 'offer_request_ask_number_once', JSON.stringify(r.plan))
  assert.ok(!asksCondition(r.plan))
})

test('S1–S5: price asked once and withheld ("you tell me") ⇒ research → gated offer recommendation, never condition', () => {
  const r = decide([...OWN, out('o3', 'What price would you be looking for?', 200, 'seller_asking_price'), inb('i3', 'you tell me, what would you offer', 10)])
  assert.ok(r.types.includes(ACTIONS.PREPARE_OFFER) || r.types.includes(ACTIONS.ESCALATE_TO_OPERATOR), JSON.stringify(r.plan))
  assert.ok(!asksCondition(r.plan))
  assert.notEqual(r.ledger.next_missing, 'condition')
})

test('S1–S5: an UNANSWERED price question never advances to condition (asked ≠ answered); the price is never re-asked', () => {
  const L = buildCanonicalLedger({ messages: [...OWN, out('o3', 'What price would you be looking for?', 200, 'seller_asking_price'), inb('i3', 'ok', 10)] })
  assert.equal(L.next_missing, 'asking_price')
  assert.ok(!validateProposedMessage(L, { text: 'How is the condition of the house?' }).ok)
  assert.ok(validateProposedMessage(L, { text: 'What price would you want?' }).reasons.includes('already_asked:asking_price'))
})

test('S1–S5: condition IS next once the seller gave the price; a seller who raised condition themselves keeps it as a fact', () => {
  const r = decide([...OWN, out('o3', 'What price would you be looking for?', 200, 'seller_asking_price'), inb('i3', 'I want 240k for it', 10)])
  assert.equal(r.ledger.next_missing, 'condition')
  const C = buildCanonicalLedger({ messages: [...OWN, inb('i3', 'it needs a new roof and some plumbing work', 10)] })
  assert.ok(C.facts.condition)
  assert.notEqual(C.next_missing, 'condition', 'the condition the seller raised is not asked again')
})

test('S1–S5 (template path): a second offer request after our S3 ask is a person (gated offer), never the S4 condition question', () => {
  const ask = { should_queue_reply: true, route_hint: 'seller_asking_price', required_template_use_case: 'seller_asking_price', allowed_template_stages: ['seller_asking_price'] }
  const out1 = applyS3DeflectionRule(ask, { classification: { primary_intent: 'asks_offer' }, s3_already_asked: true })
  assert.equal(out1.should_queue_reply, false)
  assert.equal(out1.should_mark_human_review, true)
  assert.notEqual(out1.required_template_use_case, 'condition_probe')
})

test('memory: a bare "250" answering OUR price question is a stated $250,000 asking price — remembered, never re-asked', () => {
  const L = buildCanonicalLedger({ messages: [...OWN, out('o3', 'What price would you want for it?', 200, 'seller_asking_price'), inb('i3', '250', 190), out('o4', 'Thanks. Is it occupied right now?', 100), inb('i4', 'vacant', 10)] })
  assert.equal(L.facts.asking_price?.value?.amount, 250000)
  assert.ok(validateProposedMessage(L, { text: 'What price would you take?' }).reasons.some((r) => /already_(?:answered|asked):asking_price/.test(r)))
  // a bare number with NO price question before it stays ambiguous (never a guessed price)
  const N = buildCanonicalLedger({ messages: [...OWN, inb('i3', '250', 10)] })
  assert.equal(N.facts.asking_price?.value?.amount ?? null, null)
})

const OFFER = [...OWN, out('o3', 'What price would you be looking for?', 200, 'seller_asking_price'), inb('i3', 'make me an offer', 190), out('o4', 'Based on the condition we could do $182,000 cash, any questions?', 100)]

test('context: "No, I\'m good with the amount you proposed" after OUR number is an ACCEPTANCE — a person verifies the offer, property and authority; never the disinterest close', async () => {
  const r = decide([...OFFER, inb('i4', "No, I'm good with the amount you proposed", 10)])
  assert.equal(r.reason, 'seller_accepted_proposal_verify', JSON.stringify(r.plan))
  const esc = r.plan.actions.find((a) => a.type === ACTIONS.ESCALATE_TO_OPERATOR)
  assert.deepEqual(esc.evidence.verify, ['actual_offer', 'property', 'authority'])
  assert.equal(esc.evidence.contract, 'never_automatic')
  assert.ok(!r.types.includes(ACTIONS.SCHEDULE_FOLLOWUP), 'never the 30-day nurture')
  const c = await classify("No, I'm good with the amount you proposed", null, { heuristicOnly: true })
  assert.notEqual(c.primary_intent, 'not_interested')
  assert.equal(c.automation_decision.human_review_required, true)
  assert.equal(c.automation_decision.auto_reply_allowed, false)
  // without our proposal on the thread it is not an acceptance; "I'm good" alone stays a decline
  assert.equal(acceptsOurProposal("No, I'm good with the amount you proposed", { weProposed: false }), false)
  assert.equal((await classify("No I'm good", null, { heuristicOnly: true })).primary_intent, 'not_interested')
  assert.equal(acceptsOurProposal("I'm not good with the amount you proposed"), false)
  assert.equal(acceptsOurProposal('that number is too low'), false)
})

test('context: a counteroffer after our number is the negotiation authority (never a model reply); a callback is an operator task; disinterest keeps the 30-day nurture', () => {
  const counter = decide([...OFFER, inb('i4', 'too low, I would do 205k', 10)])
  assert.ok(counter.types.includes(ACTIONS.ESCALATE_TO_OPERATOR) || counter.types.includes(ACTIONS.NEGOTIATE_WITHIN_AUTHORITY), JSON.stringify(counter.plan))
  assert.ok(!counter.types.includes(ACTIONS.AI_GENERATED_REPLY))
  const cb = decide([...OWN, inb('i3', 'just call me tomorrow afternoon', 10)])
  assert.equal(cb.reason, 'callback_request_operator_task', JSON.stringify(cb.plan))
  const no = decide([...OWN, out('o3', 'Would you sell it this year?', 50, 'consider_selling'), inb('i3', 'not interested in selling', 10)])
  assert.ok(no.types.includes(ACTIONS.SCHEDULE_FOLLOWUP), JSON.stringify(no.plan))
})

test('authority: an autonomous acceptance is refused for a restricted contact / property × contact (deal transitions are a boundary)', async () => {
  const fake = {
    from: (t) => {
      const data = t === 'acquisition_opportunities' ? { id: 'op1', status: 'active', primary_thread_key: '+13125550901', primary_property_id: 'p9' } : t === 'seller_offers' ? { id: 'so1', property_id: 'p9', status: 'active', purchase_price: 180000, source: 'autopilot' } : null
      const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data, error: null }), then: (r) => r({ data: [], error: null }) }
      return q
    },
    rpc: async () => ({ data: [], error: null }),
  }
  __setEnqueueContactRestrictionsResolverForTests(async () => ({ refused: true, reason: 'enqueue_contact_restricted:property_do_not_contact', guard_reason: 'property_do_not_contact' }))
  try {
    const v = await evaluateAutonomousAcceptance({ opportunity_id: 'op1', thread_key: '+13125550901', property_id: 'p9', accepted_price: 180000, supabase: fake })
    assert.equal(v.allowed, false)
    assert.ok(v.reasons.includes(ACCEPTANCE_REVIEW_REASONS.CONTACT_RESTRICTED), JSON.stringify(v.reasons))
  } finally { __setEnqueueContactRestrictionsResolverForTests(null) }
})

test('burst (RT-11 / RT-05): a burst consolidated into one turn is decided on ALL its members — the price in an earlier fragment is this turn\'s fact, so the turn replies when safe instead of holding as ambiguous', () => {
  const thread = [...OWN, out('o3', 'What price would you be looking for?', 200, 'seller_asking_price'), inb('i3', 'I was thinking 240k', 12), inb('i4', 'for the house', 11), inb('i5', 'if that helps', 10)]
  const merged = decide(thread, { memberIds: ['i3', 'i4', 'i5'] })
  assert.notEqual(merged.reason, 'ambiguous', JSON.stringify(merged.plan))
  assert.ok(merged.types.includes(ACTIONS.AI_GENERATED_REPLY), JSON.stringify(merged.plan))
  // the same burst decided on the latest fragment alone (the defect) held it
  const latestOnly = decide(thread, { memberIds: [] })
  assert.equal(latestOnly.reason, 'ambiguous')
  // an identity question in an EARLIER fragment of the burst is still "asked" (the truthful answer is not rejected)
  const L = buildCanonicalLedger({ messages: [...OWN, inb('i3', 'who is this', 12), inb('i4', 'and what company', 10)] })
  assert.ok(!identityStatementReasons('This is Mara, a local buyer.', L).includes('identity:automation_statement_not_asked'))
  assert.deepEqual(L.open_inbound_ids, ['i2', 'i3', 'i4'], 'every seller message since our last text')
})
