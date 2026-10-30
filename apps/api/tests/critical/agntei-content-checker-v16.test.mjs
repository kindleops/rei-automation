// Blind v16 (PI-LC-2): three generic false-refusal classes of the agent-text content checker, fixed by class, each with
// its unsafe counterpart still refused (owner: "Preserve all existing safety protections… Do not optimize by weakening
// suppression, inventing seller facts or allowing unauthorized sends"). Synthetic conversations only.
//  1. ledger:unsupported_attribution refused ACCURATE citations of the seller's words: the support match was literal
//     (case, "jan" for January, "it" for the house, "moving" for "move"). Both sides are now normalized the same way
//     against the seller's inbound messages only; time, number and urgency words must be the seller's own.
//  2. "Thanks for confirming you own …" after OUR ownership question answered "Yes mine" / "yep I am": those short
//     affirmative answers were not read as an answer to the ownership question at all.
//  3. ledger:already_asked:<topic> refused a different, specific question on a topic we asked about, the seller never
//     answered, and the seller's LATEST message raises itself.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateAgentText, attributionGroundedInSellerWords } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (text, messages, purpose = null) => validateAgentText(text, { purpose, companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const thread = (...pairs) => pairs.map(([d, b], i) => ({ id: `m${i}`, direction: d === 'o' ? 'outbound' : 'inbound', body: b, at: ago(10000 - i * 100) }))
const OWNED = [['o', 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Are you still the owner of the house on Teal Ct?'], ['i', 'yes']]
const attribution = (r) => r.reasons.filter((x) => /attribution|unsupported_claim/.test(x))

test('1: an accurate citation of the seller\'s own words is accepted (case, month abbreviations, it / the house, inflection)', () => {
  const cases = [
    ['by march hopefully', 'Thanks. You mentioned March. What has you thinking about moving?', 'What is your timeline?'],
    ['maybe, were moving in jan', "Got it. You mentioned you're moving in January. How is the house holding up?", 'Would you consider selling?'],
    ['but otherwise its solid, we keep it up', 'Thanks. You mentioned you keep the house up. Do you have a price in mind?', 'How is the house holding up?'],
    ['We moved out in Sept and its been empty', 'Thanks. You mentioned you moved out in September. Is anyone living there now?', 'Would you consider selling?'],
  ]
  for (const [seller, text, q] of cases) {
    const t = thread(...OWNED, ['o', q], ['i', seller])
    assert.equal(attributionGroundedInSellerWords(text, t), true, text)
    assert.deepEqual(attribution(v(text, t)), [], `${text} → ${v(text, t).reasons}`)
  }
})

test('1 limits: an attribution the seller never made, a different month or urgency, a flipped polarity, or our own words stay refused', () => {
  const seller = thread(...OWNED, ['o', 'How is the house holding up?'], ['i', 'maybe, were moving in jan. but otherwise its solid, we keep it up'])
  for (const text of [
    'You mentioned the roof leaks. When are you hoping to move?', // no seller message mentions a roof or a leak
    'You mentioned you want to sell fast. What timeline works for you?', // the seller never said it
    "You mentioned you're moving in March. Is that still the plan?", // the seller said January
  ]) {
    assert.equal(attributionGroundedInSellerWords(text, seller), false, text)
    assert.ok(attribution(v(text, seller)).length, `${text} → ${v(text, seller).reasons}`)
  }
  // "soon" is not the seller's word: never grounded by their words (the ledger's own timeline fact judges the text itself)
  assert.equal(attributionGroundedInSellerWords("You mentioned you're moving soon.", seller), false)
  // a price the seller never named: refused (attribution and money)
  const priced = v('You mentioned $150k. Is that still your number?', seller)
  assert.ok(priced.reasons.some((r) => /attribution/.test(r)) && priced.reasons.some((r) => /^money:/.test(r)), String(priced.reasons))
  // the opposite of what the seller said
  const neg = thread(...OWNED, ['o', 'How is the house holding up?'], ['i', "honestly we don't keep it up much"])
  assert.equal(attributionGroundedInSellerWords('You mentioned you keep the house up.', neg), false)
  // sourced only from OUR outbound: never the seller's words
  const ours = thread(...OWNED, ['o', 'A lot of folks we talk to are moving in March. Any plans like that?'], ['i', 'ok'])
  assert.equal(attributionGroundedInSellerWords('You mentioned March.', ours), false)
  assert.ok(attribution(v('Thanks. You mentioned March. What has you thinking about moving?', ours)).length)
  // one content word that is not a time word is still too little to ground (blind v13 limit, unchanged)
  assert.equal(attributionGroundedInSellerWords('You mentioned the roof.', thread(['i', 'the roof leaks'])), false)
})

const ACK = 'Thanks for confirming you own the house. Would you ever consider selling it?'
const ownershipReasons = (r) => r.reasons.filter((x) => /unsupported_claim:ownership|unsupported_confirmation_claim/.test(x))

test('2: "Yes mine" / "yep I am" answering our ownership question supports "Thanks for confirming you own …"', () => {
  for (const q of ['Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Are you the owner?', 'Are you the homeowner?', 'Is this the owner of 123 Main St?', 'Hi, this is Nova with Reivesti Home Buyers. Are you the owner of the house on Teal Ct?']) {
    for (const a of ['Yes mine', 'yes mine period who is this', 'yep I am', 'I am the owner', 'Yes I am, who is this?', 'Ours']) {
      const t = thread(['o', q], ['i', a])
      assert.equal(buildCanonicalLedger({ messages: t, now: NOW }).facts.ownership?.value, 'confirmed', `${q} → ${a}`)
      assert.deepEqual(ownershipReasons(v(ACK, t)), [], `${q} → ${a}: ${v(ACK, t).reasons}`)
    }
  }
})

test('2 limits: a denial, a third-party or former owner, another question, or no ownership question keeps the acknowledgement refused', () => {
  const q = 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Are you the owner of the house on Teal Ct?'
  for (const a of ['no', 'not me', 'my mom owns it', 'used to be', 'sold it', 'yes mine was sold last year', 'I am not', 'mine?', 'I am the tenant', "yes I'm his son"]) {
    const t = thread(['o', q], ['i', a])
    assert.notEqual(buildCanonicalLedger({ messages: t, now: NOW }).facts.ownership?.value, 'confirmed', a)
    assert.equal(v(ACK, t).ok, false, a)
    assert.ok(v(ACK, t).reasons.some((r) => /unsupported_claim:ownership|unsupported_confirmation_claim|not_owner|non_owner/.test(r)), `${a}: ${v(ACK, t).reasons}`)
  }
  // the answer is to a DIFFERENT question: our last question was not about ownership
  for (const t of [
    thread(['o', 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you have a price in mind for the house on Teal Ct?'], ['i', 'Yes mine']),
    thread(['o', q], ['o', 'Also, how is the house holding up?'], ['i', 'yep I am']),
    thread(['o', 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Would you consider selling the house on Teal Ct?'], ['i', 'yep I am']),
  ]) {
    assert.notEqual(buildCanonicalLedger({ messages: t, now: NOW }).facts.ownership?.value, 'confirmed')
    assert.ok(ownershipReasons(v(ACK, t)).length, String(v(ACK, t).reasons))
  }
})

const COND_Q = "Thanks! How would you describe the house's condition?"
const asked = (r) => r.reasons.filter((x) => /already_asked|already_answered/.test(x))

test('3: a different, specific question on a topic the seller\'s latest message raises is not a re-ask', () => {
  const t = thread(...OWNED, ['o', COND_Q], ['o', 'Just checking in, any thoughts?'], ['i', 'what kind of shape does it need to be in for you guys to be interested'])
  assert.deepEqual(asked(v('Good question. Does the roof need any work?', t)), [])
  const tenants = thread(...OWNED, ['o', 'Is anyone living in the house right now?'], ['i', 'would you buy it with the tenants still in it'])
  assert.deepEqual(asked(v('Good question. How long is the current lease?', tenants)), [])
})

test('3 limits: no new seller mention, the same question again, an answered topic, the price, or an old mention stay refused', () => {
  // the seller has NOT raised the topic again: repeating an unanswered question is pressure
  const quiet = thread(...OWNED, ['o', COND_Q], ['i', 'ok thanks'])
  assert.ok(v('Does the roof need any work?', quiet).reasons.includes('ledger:already_asked:condition'))
  // the seller raised it, but the question is the earlier one again
  const raised = thread(...OWNED, ['o', COND_Q], ['i', 'what kind of shape does it need to be in for you guys to be interested'])
  assert.ok(v("How would you describe the house's condition?", raised).reasons.includes('ledger:already_asked:condition'))
  // the seller already answered the topic
  const answered = thread(...OWNED, ['o', COND_Q], ['i', 'roof is 2 years old and it needs nothing really'], ['i', 'what shape does it need to be in'])
  assert.ok(asked(v('Does the roof need any work?', answered)).length, String(v('Does the roof need any work?', answered).reasons))
  // the mention is not the seller's latest word: we already replied to it
  const stale = thread(...OWNED, ['o', COND_Q], ['i', 'what kind of shape does it need to be in'], ['o', 'Thanks, we look at houses in all kinds of shape.'])
  assert.ok(v('Does the roof need any work?', stale).reasons.includes('ledger:already_asked:condition'))
  // never the asking price
  const price = thread(...OWNED, ['o', 'Do you have a price in mind?'], ['i', 'what kind of price are you guys thinking'])
  assert.ok(asked(v('What number would make it worth it for you?', price)).length || v('What number would make it worth it for you?', price).reasons.some((r) => /asking_price/.test(r)))
})
