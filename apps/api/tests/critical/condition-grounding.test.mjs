// Owner 2026-10-30: an agent's text may state a property condition only from evidence. Seller-reported conditions may be
// acknowledged; independently verified findings may be stated as found; underwriting estimates are never a seller-facing
// fact (only framed as an estimate, under negotiation authority). Questions, conditionals and statements about houses in
// general stay free, so ordinary conversation is not refused. Every family in both directions: roofs, foundations,
// plumbing, electrical, HVAC, water damage, pests and the property's general condition. The blind v12 T06/T07 ownership
// answer forms are at the end. Nothing here changes opt-out, suppression, ownership enforcement or sending limits.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { conditionGroundingReasons, conditionEvidenceOf } from '../../src/lib/domain/conversation-ai/condition-grounding.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const ownQ = { id: 'o1', direction: 'outbound', body: 'Hi Dana, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Elm St?', at: ago(3000) }
const thread = (seller) => [ownQ, ...(seller ? [{ id: 'i1', direction: 'inbound', body: seller, at: ago(200) }] : [])]
const g = (text, seller, o = {}) => conditionGroundingReasons(text, { thread: thread(seller), ...o })
const v = (text, seller, o = {}) => validateAgentText(text, { companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages: thread(seller), ...o })

const FAMILIES = [
  // [family, an invented assertion, a question about it, what a seller says, an acknowledgement of what they said]
  ['roof', 'Sounds like the roof needs repairs.', 'Does the roof need any repairs?', 'yes mine, the roof leaks when it rains', 'Sorry to hear about the roof.'],
  ['foundation', 'The foundation looks like it is settling.', 'Any issues with the foundation?', 'still mine. foundation has a crack in it', 'Got it, thanks. That foundation crack sounds stressful.'],
  ['plumbing', 'The plumbing is probably outdated by now.', 'How is the plumbing holding up?', 'yes. plumbing is old, pipes keep leaking', 'Sorry the plumbing has been a headache.'],
  ['electrical', 'Your electrical panel needs replacing.', 'Is the electrical in decent shape?', 'yeah. the wiring is original from 1962', 'Makes sense that the wiring is a worry.'],
  ['hvac', 'The AC unit is probably shot by now.', 'Is the AC working okay?', 'yes, the furnace died last winter', 'Sorry to hear the furnace died.'],
  ['water_damage', 'Sorry to hear about the leak in the basement.', 'Has there been any water in the basement?', 'its mine. basement floods every time it storms', 'Sorry to hear about the flooding.'],
  ['pests', 'Sorry about the termites.', 'Any termite issues I should know about?', 'yes mine. we had termites last year', 'Sorry to hear about the termites.'],
  ['general', 'Sounds like the house is in great shape.', 'What shape is the house in?', 'yes mine. fully remodeled last year', 'Sounds like the house is in great shape.'],
]

for (const [family, invented, question, seller, ack] of FAMILIES) {
  test(`${family}: an invented assertion is refused; a question and the seller's own report are not`, () => {
    assert.deepEqual(g(invented, 'yes it is mine'), [`condition:unsupported_assertion:${family}`], invented)
    assert.deepEqual(g(question, 'yes it is mine'), [], question)
    assert.deepEqual(g(ack, seller), [], `${ack} after "${seller}"`)
    assert.ok(conditionEvidenceOf({ thread: thread(seller) })[family].has('seller_reported'), seller)
  })
}

test('ordinary conversation stays free: general statements, conditionals, empathy, no condition at all', () => {
  for (const text of [
    'Older homes often need electrical updates.', 'A lot of houses around here need roof work at some point.',
    'If the house needs work, that is fine to mention.', 'Let me know whether the roof has any issues.',
    'Thanks Harold. A big yard can be a lot to keep up with. What are you thinking of doing with the house?',
    'That makes sense. What are your plans for the house?', 'Totally understand. Do you have a timeframe in mind?',
    'Thanks for telling me, a new roof is never cheap.',
  ]) assert.deepEqual(g(text, 'yes mine'), [], text)
  // the seller's own words, acknowledged in Nova's own voice (her personality is not a template)
  assert.deepEqual(g('Got it, foundation and plumbing both. That foundation work can be a big job. Do you have a timeframe in mind?', 'needs a LOT of work, foundation and plumbing both'), [])
  assert.deepEqual(g('Sorry to hear about the flooding and the porch.', 'Basement floods every time it storms and the porch is rotted'), [])
  assert.deepEqual(g('Totally understand, and the kitchen and deck sound like great updates.', 'we just gutted the kitchen and put in a new deck'), [])
})

test('a cost is a claim of its own: refused unless the seller raised it or an estimate is authorized', () => {
  assert.deepEqual(g('Fixing the roof will be expensive.', 'roof leaks'), ['condition:unsupported_cost_claim:roof'])
  assert.deepEqual(g('Sounds like the roof will be expensive to fix.', 'the roof leaks and fixing it will cost a fortune'), [])
})

test('the three kinds of evidence stay distinct', () => {
  const roof = (source) => [{ family: 'roof', source }]
  // a verified finding may be stated as found; a seller's report may not be dressed up as one
  assert.deepEqual(g('The inspection showed the roof needs replacing.', 'yes', { evidence: roof('verified_finding') }), [])
  assert.deepEqual(g('The inspection showed the roof needs replacing.', 'roof is old'), ['condition:verification_claim_without_finding:roof'])
  assert.deepEqual(g('Our records show the roof needs work.', 'yes'), ['condition:verification_claim_without_finding:roof'])
  // an underwriting estimate is never stated as fact; framed as an estimate only under negotiation authority
  assert.deepEqual(g('The roof needs replacing.', 'yes', { evidence: roof('underwriting_estimate') }), ['condition:estimate_stated_as_fact:roof'])
  assert.deepEqual(g('Our estimate has the roof needing replacement.', 'yes', { evidence: roof('underwriting_estimate') }), ['condition:estimate_without_authority:roof'])
  assert.deepEqual(g('Our estimate has the roof needing replacement.', 'yes', { evidence: roof('underwriting_estimate'), moneyAuthority: { ceiling: 200000 } }), [])
  // authorized seller-reported evidence from another channel (a call note) grounds an acknowledgement too
  assert.deepEqual(g('Sorry to hear about the leak.', 'yes', { evidence: [{ family: 'water_damage', source: 'seller_reported' }] }), [])
  assert.deepEqual(g('Sorry to hear about the roof leak.', 'yes', { evidence: [{ family: 'water_damage', source: 'seller_reported' }] }), ['condition:unsupported_assertion:roof'], 'each family named needs its own evidence')
})

test('through validateAgentText: an invented condition is refused, the seller-grounded reply passes, the rest is unchanged', () => {
  assert.ok(v('Totally understand. Sounds like the roof needs repairs. Mind if I check back in a few months?', 'Nah, staying put for a good while').reasons.includes('condition:unsupported_assertion:roof'))
  assert.deepEqual(v('Thanks for confirming, Dana. Sorry to hear about the roof. Do you have a timeframe in mind?', 'yes still mine, the roof leaks when it rains').reasons.filter((r) => r.startsWith('condition:')), [])
  const stop = v('Sorry to hear about the roof.', 'roof leaks. STOP')
  assert.ok(stop.reasons.includes('inbound:opt_out'), 'a STOP is still a STOP')
})

test('blind v12 T06, T07: "It\'s in my name yes" and "Yes ma\'am still mine" answer our ownership question', () => {
  const own = (body) => buildCanonicalLedger({ messages: thread(body), now: NOW }).facts.ownership?.value ?? null
  assert.equal(own("It's in my name yes. My son and his kids live there right now"), 'confirmed')
  assert.equal(own("Yes ma'am still mine. Retired last spring"), 'confirmed')
  assert.equal(own('Yes sir.'), 'confirmed')
  assert.notEqual(own("It's in my mom's name"), 'confirmed')
  assert.notEqual(own("Yes ma'am? who is this"), 'confirmed')
  assert.deepEqual(v('Thanks for confirming, Dana. What are your plans for the house at the moment?', "It's in my name yes. My son and his kids live there right now").reasons.filter((r) => /confirm|ownership|non_owner/.test(r)), [])
})
