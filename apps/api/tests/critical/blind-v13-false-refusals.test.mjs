// Blind v13 run 1 (agntau docs/acquisitions-certification/blind-v13/run-1): four compliant agent texts refused, fixed by class:
//  S10, S21, S38 — "You mentioned …" whose topic is none of the ledger's five (ownership, price, condition keywords,
//                  timeline, interest) was refused outright. It is now accepted only when grounded in the seller's OWN words:
//                  one seller clause holds ≥ 60% of its content words (≥ 2), with the same polarity.
//  S14           — after the seller described one part of the house, a question about OTHER parts is a new question.
// Negative cases: invented attributions, flipped polarity, and re-asking what the seller already described stay refused.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateAgentText, attributionGroundedInSellerWords } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const ownQ = { id: 'o1', direction: 'outbound', body: 'Hi Silas, this is Nova, an AI assistant with Reivesti Home Buyers. Is the house on Teal Ct still yours?', at: ago(90000) }
const thread = (...seller) => [ownQ, ...seller.map((b, i) => ({ id: `i${i + 1}`, direction: 'inbound', body: b, at: ago(80000 - i * 10) }))]
const v = (text, messages, purpose = null) => validateAgentText(text, { purpose, companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const attribution = (r) => r.reasons.filter((x) => /attribution/.test(x))

test('S10, S21, S38: an attribution that repeats the seller\'s own words is accepted', () => {
  const cases = [
    ['You mentioned the basement takes water and the sump pump is junk.', 'Yeah. Basement takes water every heavy rain and the sump pump is junk. Not sure I want to deal with fixing it'],
    ["You mentioned you'd probably list it when the time comes.", "I do but when the time comes I'll probably just list it with an agent tbh"],
    ['You mentioned the right situation might change that.', 'Zero hurry honestly. If the right situation came along id think about it but im not sitting here waiting'],
  ]
  for (const [text, seller] of cases) {
    assert.equal(attributionGroundedInSellerWords(text, thread(seller)), true, text)
    assert.deepEqual(attribution(v(`Hi Silas, Nova with Reivesti Home Buyers again. ${text} What are your plans for the house these days?`, thread(seller), 'reengage')), [], text)
  }
})

test('S10, S21, S38 limits: an invented attribution, a flipped polarity, or words the seller never used stay refused', () => {
  const seller = 'Yeah. Basement takes water every heavy rain and the sump pump is junk.'
  for (const text of [
    'You mentioned the kitchen was just remodeled.', // the seller never said it
    'You mentioned you are ready to move quickly.', // nothing like it
    "You mentioned the basement doesn't take water.", // the seller said the opposite
    'You mentioned the garage door is broken.',
  ]) {
    assert.equal(attributionGroundedInSellerWords(text, thread(seller)), false, text)
    assert.ok(v(`Hi Silas, Nova again. ${text} What are your plans for the house?`, thread(seller), 'reengage').reasons.some((r) => /attribution|unsupported_claim/.test(r)), text)
  }
  assert.equal(attributionGroundedInSellerWords('You mentioned you want to sell soon.', thread("I don't want to sell soon")), false, 'a negation on one side only is never grounded')
  assert.equal(attributionGroundedInSellerWords('You mentioned the roof.', thread('the roof leaks')), false, 'one content word is too little to ground')
})

test('S14: after the seller described the furnace, a question about the roof, plumbing and foundation is a new question', () => {
  const t = [{ id: 'o1', direction: 'outbound', body: 'Thanks Ezra. What has you thinking about moving? And how is the house holding up?', at: ago(3000) },
    { id: 'i1', direction: 'inbound', body: 'Hoping to be out by end of Feb. Furnace is on its last legs and I am not doing another winter in that house after this one', at: ago(200) }]
  const ok = v('Thanks, Ezra. Getting out by end of Feb makes sense with the furnace in that shape. Besides the furnace, how are the roof, plumbing and foundation?', t)
  assert.deepEqual(ok.reasons.filter((r) => /already_answered:condition/.test(r)), [], JSON.stringify(ok.reasons))
  const again = v('Thanks, Ezra. What condition is the furnace in?', t)
  assert.ok(again.reasons.includes('ledger:already_answered:condition'), 're-asking what the seller already described stays refused')
})
