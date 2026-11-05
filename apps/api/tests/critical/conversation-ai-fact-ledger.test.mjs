// 8.5.16 — CANONICAL FACT + QUESTION LEDGER (pure, derived from real events).
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalLedger, validateProposedMessage, ledgerSummary, ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { validateDraft } from '../../src/lib/domain/conversation-ai/validator.js'
import { buildConversationContext } from '../../src/lib/domain/conversation-ai/context-builder.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'

const T0 = Date.parse('2026-10-14T15:00:00Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const out = (id, min, body, use_case = null) => ({ id, direction: 'outbound', body, at: at(min), use_case })
const inb = (id, min, body, intent = null) => ({ id, direction: 'inbound', body, at: at(min), intent })

test('example 1: "I\'d sell for $175K but the roof needs work" = interest + asking price + condition; none re-asked', () => {
  const L = buildCanonicalLedger({ messages: [
    out('o1', 0, 'Hi, do you still own the house on Elm?', 'ownership_check'),
    inb('i1', 5, 'Yes I still own it'),
    out('o2', 10, 'Would you consider an offer on it?', 'consider_selling'),
    inb('i2', 20, "I'd sell for $175K but the roof needs work"),
  ] })
  assert.equal(L.facts.ownership.value, 'confirmed')
  assert.deepEqual(L.facts.ownership.source_message_ids, ['i1'])
  assert.equal(L.facts.asking_price.value.amount, 175000)
  assert.deepEqual(L.facts.asking_price.source_message_ids, ['i2'])
  assert.ok(L.facts.condition.source_message_ids.includes('i2'))
  assert.equal(L.facts.seller_interest.value, 'interested')
  assert.ok(L.facts.seller_interest.source_message_ids.includes('i2'))
  for (const k of ['interest', 'asking_price', 'condition']) assert.equal(L.questions[k].answered, true, k)
  assert.equal(L.stage.stage, 'S5_offer', 'price + condition on record: the offer is a human step')
  assert.equal(L.next_missing, null)
  for (const text of ['How much would you want for it?', 'What kind of repairs does it need?', 'Would you consider selling it?']) {
    const v = validateProposedMessage(L, { text })
    assert.equal(v.ok, false, text)
  }
  assert.ok(validateProposedMessage(L, { kind: 'asking_price' }).reasons.includes('already_answered:asking_price'))
  assert.ok(validateProposedMessage(L, { kind: 'condition' }).reasons.includes('already_answered:condition'))
  assert.ok(validateProposedMessage(L, { kind: 'interest' }).reasons.includes('already_answered:interest'))
})

test('example 2: "What\'s your offer?" is an offer request — no asking price inferred, no amount', () => {
  const L = buildCanonicalLedger({ messages: [
    out('o1', 0, 'Do you still own the property?', 'ownership_check'),
    inb('i1', 3, 'yes'),
    out('o2', 6, 'Would you be open to an offer?', 'consider_selling'),
    inb('i2', 9, "What's your offer?"),
  ] })
  assert.deepEqual(L.offer_requests, ['i2'])
  assert.equal(L.facts.asking_price, undefined, 'no asking price is inferred from an offer request')
  assert.equal(L.questions.asking_price.answered, false)
  assert.equal(L.facts.seller_interest.value, 'interested')
  assert.equal(L.existing_offers.length, 0, 'no offer fabricated')
  assert.ok(!JSON.stringify(L).match(/"amount":\s*[1-9]/), 'no amount anywhere in the ledger')
  assert.equal(L.stage.stage, 'S3_asking_price')
  assert.equal(L.follow_up.eligible, false)
  assert.equal(L.follow_up.reason, 'offer_requested_needs_human')
  assert.ok(validateProposedMessage(L, { text: 'Our offer is $120,000, does that work?' }).reasons.includes('offer_question_is_human'))
})

test('offer request AFTER we asked the price: the price question is deflected and never re-asked', () => {
  const L = buildCanonicalLedger({ messages: [
    out('o1', 0, 'What price would you want for it?', 'seller_asking_price'),
    inb('i1', 4, 'You tell me, what would you offer?'),
  ] })
  assert.equal(L.questions.asking_price.deflected, true)
  assert.deepEqual(L.questions.asking_price.deflected_by, ['i1'])
  const v = validateProposedMessage(L, { text: 'What number did you have in mind?' })
  assert.ok(v.reasons.includes('already_asked:asking_price'))
  assert.ok(v.reasons.includes('asking_price_deflected_never_reask'))
  // rc-8.5.21 v3 (S1–S5 BINDING + owner rule 10-18): price withheld after ONE ask ⇒ research → a gated offer
  // recommendation (S5, human) — never a condition question before the price
  assert.equal(L.stage.stage, 'S5_offer')
  assert.equal(L.next_missing, null)
  assert.equal(validateProposedMessage(L, { text: "How's the condition of the property?" }).ok, false)
})

test('rc-8.5.21 v3: an UNANSWERED price ask never advances the flow to condition (asked is not answered)', () => {
  const L = buildCanonicalLedger({ messages: [
    out('o1', 0, 'Still own it?', 'ownership_check'), inb('i1', 2, 'yes I own it'),
    out('o2', 3, 'Open to selling?', 'consider_selling'), inb('i2', 5, 'maybe'),
    out('o3', 6, 'What price would you want for it?', 'seller_asking_price'), inb('i3', 8, 'ok'),
  ] })
  assert.notEqual(L.stage.stage, 'S4_condition')
  assert.equal(L.next_missing, 'asking_price')
  const v = validateProposedMessage(L, { text: "How's the condition of the property?" })
  assert.equal(v.ok, false, 'condition before the price is a skipped stage')
  assert.ok(v.reasons.some((r) => r.startsWith('skips_stage')), v.reasons.join(','))
  assert.ok(validateProposedMessage(L, { text: 'What price would you want?' }).reasons.includes('already_asked:asking_price'), 'and the price is never re-asked')
  // the seller raised condition THEMSELVES: the condition fact is on record, the price is still next
  const C = buildCanonicalLedger({ messages: [
    out('o1', 0, 'Still own it?', 'ownership_check'), inb('i1', 2, 'yes, it needs a new roof though'),
  ] })
  assert.notEqual(C.next_missing, 'condition')
})

test('already-asked: a queued (not yet sent) price question counts as asked', () => {
  const L = buildCanonicalLedger({
    messages: [out('o1', 0, 'Still own it?', 'ownership_check'), inb('i1', 2, 'yes I own it'), out('o2', 3, 'Open to selling?', 'consider_selling'), inb('i2', 5, 'maybe, depends on price')],
    queueRows: [{ id: 'q9', use_case_template: 'seller_asking_price', queue_status: 'queued', created_at: at(6) }, { id: 'q10', use_case_template: 'condition_probe', queue_status: 'cancelled', created_at: at(6) }],
  })
  assert.equal(L.questions.asking_price.asked_count, 1)
  assert.deepEqual(L.questions.asking_price.asked_message_ids, ['queue:q9'])
  assert.equal(L.questions.condition.asked_count, 0, 'a cancelled row was never asked')
  assert.ok(validateProposedMessage(L, { kind: 'asking_price' }).reasons.includes('already_asked:asking_price'))
})

test('evidence-based stages, backwards and skipped questions', () => {
  const s1 = buildCanonicalLedger({ messages: [out('o1', 0, 'Hi, is this the owner of 12 Oak?', 'ownership_check')] })
  assert.equal(s1.stage.stage, 'S1_ownership')
  assert.ok(validateProposedMessage(s1, { kind: 'asking_price' }).reasons.includes('skips_stage:asking_price'))
  const s2 = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you still own it?', 'ownership_check'), inb('i1', 1, "yes that's my house")] })
  assert.equal(s2.stage.stage, 'S2_interest')
  assert.deepEqual(s2.stage.evidence_message_ids, ['i1'])
  assert.equal(s2.next_missing, 'interest')
  assert.ok(validateProposedMessage(s2, { kind: 'ownership' }).reasons.some((r) => r.startsWith('already_answered') || r.startsWith('backwards')))
  assert.equal(validateProposedMessage(s2, { text: 'Would you consider selling it?' }).ok, true)
})

test('ownership denial, former owner and representative are distinct, each with source ids', () => {
  const denied = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you own 5 Pine?', 'ownership_check'), inb('i1', 1, 'wrong number')] })
  assert.equal(denied.facts.ownership.value, 'denied')
  assert.equal(denied.stage.stage, 'closed')
  assert.equal(denied.follow_up.eligible, false)
  assert.ok(validateProposedMessage(denied, { kind: 'interest' }).reasons.includes('stage_closed_no_stage_question'))
  const former = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you own 5 Pine?', 'ownership_check'), inb('i1', 1, 'We already sold it last year')] })
  assert.equal(former.facts.ownership.value, 'former_owner')
  const rep = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you own 5 Pine?', 'ownership_check'), inb('i1', 1, "I'm his daughter, I handle it for him")] })
  assert.equal(rep.facts.ownership.value, 'representative')
  assert.deepEqual(rep.facts.representative.source_message_ids, ['i1'])
  assert.equal(rep.stage.stage, 'S2_interest')
})

test('not interested ⇒ nurture (never suppressed); requests and objections tracked with ids', () => {
  const L = buildCanonicalLedger({ messages: [out('o1', 0, 'Would you consider selling?', 'consider_selling'), inb('i1', 1, 'who is this? not interested')] })
  assert.equal(L.facts.seller_interest.value, 'not_interested')
  assert.equal(L.stage.stage, 'nurture')
  assert.deepEqual(L.requests, [{ kind: 'identity', source_message_id: 'i1' }])
  const o = buildCanonicalLedger({ messages: [inb('i1', 1, 'that is a lowball, call me')] })
  assert.deepEqual(o.objections.map((x) => x.kind), ['price_objection'])
  assert.deepEqual(o.requests.map((x) => x.kind), ['callback'])
})

test('correction: the latest seller statement wins with provenance; existing offers are records only', () => {
  const L = buildCanonicalLedger({
    messages: [out('o1', 0, 'What price?', 'seller_asking_price'), inb('i1', 1, 'around 200 thousand'), inb('i2', 5, 'actually $185,000')],
    offers: [{ id: 'off1', amount: 150000, status: 'active', created_at: at(10), source_table: 'seller_offers' }],
  })
  assert.equal(L.facts.asking_price.value.amount, 185000)
  assert.deepEqual(L.facts.asking_price.source_message_ids, ['i1', 'i2'])
  assert.deepEqual(L.existing_offers.map((o) => o.id), ['off1'])
  assert.equal(L.stage.stage, 'S5_offer')
  const s = ledgerSummary(L)
  assert.equal(s.facts.asking_price.value, 'stated', 'summary never carries the amount')
})

test('identity repeat: answering "who is this?" may re-ask the open S1/S2 question ONCE, never the price', () => {
  const L = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you still own the house on Elm?', 'ownership_check'), inb('i1', 1, 'who is this?')] })
  assert.equal(validateProposedMessage(L, { text: "I'm a local buyer. Do you still own the house on Elm?", inboundIntent: 'who_is_this' }).ok, true)
  assert.ok(validateProposedMessage(L, { text: 'Do you still own the house on Elm?' }).reasons.includes('already_asked:ownership'))
})

test('validator wiring: validateDraft adds ledger reasons when a ledger is supplied', async () => {
  const thread = [
    { ...out('o1', 0, 'Would you consider selling?', 'consider_selling'), thread_key: 'tk', seller_phone: '+15550000001' },
    { ...inb('i1', 1, "I'd sell for $175K but the roof needs work"), thread_key: 'tk', seller_phone: '+15550000001' },
  ]
  const input = { inbound: { id: 'i1', body: thread[1].body, at: thread[1].at, thread_key: 'tk', from_phone: '+15550000001' }, thread, now: at(2) }
  const context = buildConversationContext(input)
  const factLedger = ledgerFromContextInput(input)
  const decision = makeDecision({ intent: 'price_and_condition', seller_interest: 'interested', outcome: 'REPLY_CANDIDATE', next_objective: 'get_condition', response_needed: true, proposed_message: 'Got it. What repairs does it need?', confidence: 0.95, source_message_ids: ['i1'] })
  const v = await validateDraft({ decision, context, inboundText: thread[1].body, eligibility: { blocked: false, reasons: [], outside_window: false }, factLedger })
  assert.ok(v.reasons.includes('ledger:already_answered:condition'), JSON.stringify(v.reasons))
  const without = await validateDraft({ decision, context, inboundText: thread[1].body, eligibility: { blocked: false, reasons: [], outside_window: false } })
  assert.ok(!without.reasons.some((r) => r.startsWith('ledger:')))
})

// ── OWNER DECISIONS 2026-10-14 (permanent) ─────────────────────────────────
test('owner 10-14: "No" to ownership = denial (property-scoped stop, no nurture); "No" to selling = 30-day nurture', () => {
  const own = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you still own 9 Birch?', 'ownership_check'), inb('i1', 1, 'No')] })
  assert.equal(own.facts.ownership.value, 'denied')
  assert.equal(own.facts.seller_interest, undefined, 'a "No" to ownership is not read as disinterest')
  assert.equal(own.stage.stage, 'closed')
  assert.deepEqual(own.follow_up, { eligible: false, reason: 'ownership_denied_or_former_no_nurture' })
  const sell = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you still own 9 Birch?', 'ownership_check'), inb('i1', 1, 'yes'), out('o2', 2, 'Would you consider selling it?', 'consider_selling'), inb('i2', 3, 'No'), out('o3', 4, 'Understood, thanks.', 'nurture_not_interested')] })
  assert.equal(sell.facts.ownership.value, 'confirmed')
  assert.equal(sell.facts.seller_interest.value, 'not_interested')
  assert.equal(sell.stage.stage, 'nurture')
  assert.equal(sell.follow_up.eligible, true)
  assert.equal(sell.follow_up.reason, 'nurture_30_day')
  for (const t of ['not selling', 'not interested']) {
    const L = buildCanonicalLedger({ messages: [out('o1', 0, 'Would you consider selling it?', 'consider_selling'), inb('i1', 1, t)] })
    assert.equal(L.stage.stage, 'nurture', t)
  }
})

test('owner 10-14: explicit STOP or any stop request (incl. glued "…STOP 🛑") = suppression; nothing is asked or followed up', () => {
  for (const t of ['STOP', 'yes i own it STOP🛑', 'not interestedSTOP', 'please remove me from your list', "don't text me again"]) {
    const L = buildCanonicalLedger({ messages: [out('o1', 0, 'Do you still own it?', 'ownership_check'), inb('i1', 1, t)] })
    assert.equal(L.facts.opt_out?.value, 'stop_requested', t)
    assert.equal(L.stage.stage, 'closed', t)
    assert.deepEqual(L.follow_up, { eligible: false, reason: 'stop_requested_suppression' }, t)
    assert.ok(validateProposedMessage(L, { text: 'Would you consider selling?' }).reasons.includes('stop_requested_no_message'), t)
  }
})
