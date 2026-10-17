// rc-8.5.20 part A — integration review items (a) unified ledger, (b) one bare-No matcher,
// (c) interest / ownership question patterns audited against real outbound.
import test from 'node:test'
import assert from 'node:assert/strict'

import { bareNoAnswer, isBareNo, isBareOwnershipDenial } from '../../src/lib/domain/conversation-ai/answers.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { buildThreadLedger, factLedgerOf, factSummaryOf, isCanonicalLedger, threadLedgerFromRows } from '../../src/lib/domain/conversation-ai/ledger.js'
import { buildFactLedger } from '../../src/lib/domain/conversation-ai/facts.js'
import { buildConversationContext } from '../../src/lib/domain/conversation-ai/context-builder.js'
import { questionKindOf, interestQuestionGuard } from '../../src/lib/domain/conversation-ai/questions.js'
import { loadThreadFactLedger } from '../../src/lib/domain/negotiation/negotiation-service.js'
import { askFromLedger } from '../../src/lib/domain/opportunity-economics/economics-service.js'

const T0 = Date.parse('2026-10-15T15:00:00Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const out = (id, body, min, use_case = null) => ({ id, direction: 'outbound', body, at: at(min), use_case })
const inb = (id, body, min, intent = null) => ({ id, direction: 'inbound', body, at: at(min), intent })

// ── (b) one shared bare-No matcher ──────────────────────────────────────────
const BARE_NO_CASES = [
  // text, matched, ownership_denial
  ['No', true, true], ['Nope', true, true], ['nah', true, true], ['No!!!!!', true, true],
  ['Not really', true, true], ['no not really', true, true], ['Absolutely not', true, true], ['No sir', true, true],
  // rc-8.5.21 (owner P0 2026-10-16): polite / emoji negatives to OUR ownership question deny ownership too
  ['No thanks', true, true], ['No gracias Carlos!', true, true], ['No 🙂', true, true],
  ['No, I sold it', false, false], ['wrong number', false, false], ['STOP', false, false], ['No stop texting me', false, false], ['Yes', false, false],
]

test('(b) the shared matcher: bare negatives incl. "Not really"; polite and emoji replies are ownership denials too (rc-8.5.21); stop words never match', () => {
  for (const [text, matched, denial] of BARE_NO_CASES) {
    const r = bareNoAnswer(text, { names: ['Carlos'] })
    assert.equal(r.matched, matched, `matched: ${text}`)
    assert.equal(r.ownership_denial, denial, `denial: ${text}`)
    assert.equal(isBareNo(text, { names: ['Carlos'] }), matched)
    assert.equal(isBareOwnershipDenial(text, { names: ['Carlos'] }), denial)
  }
})

test('(b) the 8.5.15 pre-check and the 8.5.16 ledger now agree on every bare-No case after our ownership question', () => {
  for (const [text, , denial] of BARE_NO_CASES) {
    if (/stop/i.test(text)) continue // the stop path, not the bare-No path
    const pre = deterministicPrecheck({ text, inboundId: 'i1', lastQuestionKind: 'ownership' })
    const preDenied = pre.decided && pre.reason === 'ownership_denied'
    const ledger = buildCanonicalLedger({ messages: [out('o1', 'Hi, do you still own the house on Elm St?', 0, 'ownership_check'), inb('i1', text, 5)], now: at(6) })
    const ledgerDenied = ledger.facts.ownership?.value === 'denied'
    if (/sold|wrong/i.test(text)) { assert.equal(ledgerDenied || ledger.facts.ownership?.value === 'former_owner', true, text); continue }
    assert.equal(preDenied, denial, `precheck: ${text}`)
    assert.equal(ledgerDenied, denial, `ledger: ${text}`)
  }
})

test('(b) "Not really" to our INTEREST question is not-interested (30-day nurture), never an ownership denial', () => {
  const ledger = buildCanonicalLedger({ messages: [out('o1', 'Thanks for confirming. Would you consider a proposal for the property?', 0, 'consider_selling'), inb('i1', 'Not really', 5)], now: at(6) })
  assert.equal(ledger.facts.seller_interest.value, 'not_interested')
  assert.equal(ledger.facts.ownership, undefined)
  assert.equal(ledger.stage.stage, 'nurture')
  assert.equal(ledger.follow_up.eligible, false) // the seller spoke last: a reply decision is due first
})

// ── (a) one canonical ledger, every consumer ─────────────────────────────────
function thread() {
  return [
    out('o1', 'Hi Dana, this is Helen. Do you still own 12 Elm St?', 0, 'ownership_check'),
    inb('i1', 'yes I do', 3),
    out('o2', 'Thanks for confirming. Would you consider a proposal for the property?', 4, 'consider_selling'),
    inb('i2', "I'd sell for $175k but the roof needs work and there's a tenant", 9),
    inb('i3', 'Actually make it 160k', 12),
  ]
}

test('(a) the canonical ledger carries the facts.js view of the SAME facts (latest-wins price, rich condition, ownership, interest)', () => {
  const canonical = buildThreadLedger({ messages: thread(), now: at(13) })
  assert.ok(isCanonicalLedger(canonical))
  const view = factLedgerOf(canonical)
  assert.equal(view.asking_price.current.value.amount, 160000)
  assert.equal(view.asking_price.current.source_message_id, 'i3')
  assert.equal(view.asking_price.history.filter((h) => h.value?.amount).length, 2)
  assert.equal(view.ownership.current.value, 'confirmed')
  assert.equal(view.seller_interest.current.value, canonical.facts.seller_interest.value)
  // the extractor's richer condition value is kept for the same message
  assert.notDeepEqual(view.condition.current.value, { disclosed: true })
  assert.equal(view.condition.current.source_message_id, 'i2')
  const summary = factSummaryOf(canonical)
  for (const k of Object.keys(canonical.facts)) assert.ok(summary[k], `summary has ${k}`)
  // a facts.js ledger passes through the adapter unchanged
  const legacy = buildFactLedger({ inbound: [{ id: 'x', body: '$100k', at: at(1) }], now: at(2) })
  assert.equal(factLedgerOf(legacy), legacy)
  // the canonical object's own enumerable shape is unchanged
  assert.equal(Object.keys(canonical).includes('fact_ledger'), false)
})

test('(a) negotiation, economics and the R1 context read the facts the pipeline reads ("No" to ownership, a stop request)', async () => {
  const rows = [
    { id: 1, direction: 'outbound', message_body: 'Hi, this is Helen. Do you still own 12 Elm St?', event_timestamp: at(0), detected_intent: null },
    { id: 2, direction: 'inbound', message_body: 'Not really', event_timestamp: at(4), detected_intent: null },
  ]
  const supabase = {
    from: () => {
      const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, limit: async () => ({ data: rows, error: null }) }
      return q
    },
  }
  const neg = await loadThreadFactLedger({ supabase, thread_key: '+15550000000', now: new Date(at(5)) })
  assert.ok(isCanonicalLedger(neg.canonical))
  assert.equal(neg.ledger.ownership.current.value, 'denied', 'negotiation sees the ownership denial')
  assert.equal(neg.canonical.stage.stage, 'closed')
  assert.equal(neg.inbound_count, 1)
  const pipeline = threadLedgerFromRows(rows, { now: at(5) })
  assert.deepEqual(factSummaryOf(pipeline), factSummaryOf(neg.canonical))

  // economics: askFromLedger accepts the canonical ledger and the facts.js view alike
  const priced = buildThreadLedger({ messages: thread(), now: at(13) })
  assert.deepEqual(askFromLedger(priced), askFromLedger(factLedgerOf(priced)))
  assert.equal(askFromLedger(priced).ask.amount, 160000)

  // R1 context: the model's facts are the canonical ones
  const th = [
    { id: 'o1', direction: 'outbound', body: 'Do you still own 12 Elm St?', at: at(0), thread_key: 'tk', seller_phone: '+15550000000', use_case: 'ownership_check' },
    { id: 'i1', direction: 'inbound', body: 'Not really', at: at(4), thread_key: 'tk', seller_phone: '+15550000000' },
  ]
  const ctx = buildConversationContext({ inbound: { id: 'i1', body: 'Not really', at: at(4), thread_key: 'tk', from_phone: '+15550000000' }, thread: th, now: at(5) })
  assert.equal(ctx.model.facts.ownership.value, 'denied')
  assert.equal(ctx.stage.stage, 'closed')

  // a stop request is a fact every consumer sees
  const stop = threadLedgerFromRows([...rows.slice(0, 1), { id: 3, direction: 'inbound', message_body: 'please stop texting me', event_timestamp: at(6) }], { now: at(7) })
  assert.equal(factLedgerOf(stop).opt_out.current.value, 'stop_requested')
})

// ── (c) question patterns audited against 30 days of real outbound ──────────
test('(c) audited outbound: negotiation questions are no longer read as an S2 interest ask; real interest / ownership asks still are', () => {
  // shapes of real sent rows (2026-09-15 … 2026-10-15; names / numbers replaced)
  const interest = [
    'Thanks for confirming. Would you consider a proposal for the property?',
    'Are you open to a proposal for the property?',
    'Yeah are you open to a cash offer?',
    'Hey Charles, are you open to selling the property?',
    'Just curious, would you be open to a sale?',
    'Jacob, circling back on 12 Shaw Blvd. If the numbers made sense, would you look at a proposal?',
    'Hey Linda, this is Andre circling back on 12 Sterling Forest Dr. Open to discussing options?',
    'Solo por curiosidad, estarias abierto a una propuesta sobre la propiedad?',
    "I'm a local investor here in the area. I reached out about your property. Would you be open to a proposal on it?",
  ]
  for (const b of interest) assert.equal(questionKindOf({ body: b }), 'interest', b)
  const notInterest = [
    'Are you open to doing a JV? I think I may have a buyer for this one.',
    'If we could come up a bit closer to your target, would you be open to a lease option?',
    'I hear you on price. If I can get close to a number that works for you, would you still consider it?',
    'Would you be open to seller financing terms?',
  ]
  for (const b of notInterest) assert.notEqual(questionKindOf({ body: b }), 'interest', b)
  assert.equal(interestQuestionGuard('Would you be open to a lease option or a sale?'), true) // names a sale
  const ownership = [
    'Hi Claudia, this is Alex. Just checking, do you own 12 Colfax Ave N?',
    'Hey Justin, hope all is well. This is Alex reaching out about 12 Maple Ave. Is this the correct number for the owner?',
    'Hey Daniel, this is Nathan. Is 12 E Beverly St yours?',
    'Hi Tom, my name is Alex. Came across 12 Burning Tree Ln, are you still the owner?',
    'Hola Rosario, soy Alex. Invierto en Fort Worth. Sigues siendo el dueno de 12 Lee Ave?',
    'Hi Kuveng, this is Michael. Quick question, do you still own the commercial property at 12 Webb Chapel Rd?',
  ]
  for (const b of ownership) assert.equal(questionKindOf({ body: b }), 'ownership', b)
  // operator questions that are neither ownership nor interest stay out of both
  for (const b of ['Hey Oscar, this is Greg following back up on 12 Vernon. Is it still available?', 'Are you currently under a listing agreement with an agent, or is that listing being cancelled?', 'Hi Gale, any update?']) {
    assert.ok(!['ownership', 'interest'].includes(questionKindOf({ body: b })), b)
  }
})
