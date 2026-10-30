// Blind v9 run 3 (agntau docs/acquisitions-certification/blind-v9/run-3) graded four compliant agent texts as refused by
// LeadCommand. Two were ledger false readings, fixed here by class:
//  Y15 — the one allowed ownership re-ask inside an identity answer was not recognized when the identity answer is the
//        disclosed-AI form ("I'm Nova, an AI assistant with Reivesti Home Buyers").
//  Y20 — an owner's "not interested in lowball offers" was read as a decline to sell (nurture); it is a price objection.
// The other two stay refused by design (Y11: a text commenting on the seller's children is a fair-housing reference;
// Y22: "check who owns the house" reads as a third-party owner ask) and are addressed in the writer's rules instead.
// The negative cases pin that nothing here re-opens a decline, an opt-out, a second re-ask or a fair-housing reference.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalLedger, declinesSelling, LOWBALL_OBJECTION_RE } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (body, messages) => validateAgentText(body, { companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const ownQ = (name, street, at = ago(900)) => ({ id: 'o1', direction: 'outbound', body: `Hi ${name}, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on ${street}?`, at })
const ledgerReasons = (r) => r.reasons.filter((x) => x.startsWith('ledger:'))

const Y15_TEXT = "Sorry for the confusion, Dolores. I'm Nova, an AI assistant with Reivesti Home Buyers. I'm reaching out about the house on Juniper Hill Rd to find out whether you own it and might ever think about selling. Are you the owner?"

test('Y15: the ownership question may be re-asked once inside the disclosed-AI identity answer', () => {
  for (const q of ['What is this about?', 'who is this?', 'Who are you with?']) {
    const r = v(Y15_TEXT, [ownQ('Dolores', 'Juniper Hill Rd'), { id: 'i1', direction: 'inbound', body: q, at: ago(35) }])
    assert.deepEqual(ledgerReasons(r), [], `${q}: ${JSON.stringify(r.reasons)}`)
  }
  const named = v("I'm Nova, with Reivesti Home Buyers. Do you still own the house on Juniper Hill Rd?", [ownQ('Dolores', 'Juniper Hill Rd'), { id: 'i1', direction: 'inbound', body: 'who is this?', at: ago(35) }])
  assert.deepEqual(ledgerReasons(named), [], JSON.stringify(named.reasons))
})

test('Y15 limits: no re-ask without an identity question, never twice, never after an answer', () => {
  const noIdentityQ = v(Y15_TEXT, [ownQ('Dolores', 'Juniper Hill Rd'), { id: 'i1', direction: 'inbound', body: 'hmm', at: ago(35) }])
  assert.ok(noIdentityQ.reasons.includes('ledger:already_asked:ownership'), JSON.stringify(noIdentityQ.reasons))
  const twice = v(Y15_TEXT, [ownQ('Dolores', 'Juniper Hill Rd', ago(2000)), { id: 'i0', direction: 'inbound', body: 'who is this?', at: ago(1900) },
    { id: 'o2', direction: 'outbound', body: "I'm Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Juniper Hill Rd?", at: ago(1800) },
    { id: 'i1', direction: 'inbound', body: 'What is this about?', at: ago(35) }])
  assert.ok(twice.reasons.includes('ledger:already_asked:ownership'), JSON.stringify(twice.reasons))
  const answered = v(Y15_TEXT, [ownQ('Dolores', 'Juniper Hill Rd'), { id: 'i1', direction: 'inbound', body: 'yes its mine, who is this?', at: ago(35) }])
  assert.ok(answered.reasons.includes('ledger:already_answered:ownership'), JSON.stringify(answered.reasons))
  const notIdentity = v('Sorry for the confusion, Dolores. Are you the owner of the house on Juniper Hill Rd?', [ownQ('Dolores', 'Juniper Hill Rd'), { id: 'i1', direction: 'inbound', body: 'What is this about?', at: ago(35) }])
  assert.ok(notIdentity.reasons.includes('ledger:already_asked:ownership'), 'a re-ask that does not answer the identity question stays refused')
})

const Y20 = (body, intent) => [ownQ('Stanley', 'Gatling Rd', ago(4000)), { id: 'i1', direction: 'inbound', body, at: ago(160), ...(intent ? { intent } : {}) }]
const Y20_TEXT = 'Thanks for confirming, Stanley. Understood, no pressure. What price do you have in mind for the house?'

test('Y20: an owner\'s "not interested in lowball offers" is a price objection, not a decline to sell', () => {
  for (const body of ['Yeah I own it but not interested in lowball offers. I know what its worth', 'yes mine. not interested in low ball offers', 'I own it, not taking any lowball offers', 'Its mine. Not entertaining cheap offers']) {
    for (const intent of [null, 'not_interested']) {
      const l = buildCanonicalLedger({ messages: Y20(body, intent), now: NOW })
      assert.equal(l.facts.seller_interest?.value, 'conditional', `${body} / ${intent}`)
      assert.notEqual(l.stage.stage, 'nurture', `${body} / ${intent}`)
      assert.ok(l.objections.some((o) => o.kind === 'lowball_objection'), `${body}: the objection is recorded`)
      assert.deepEqual(ledgerReasons(v(Y20_TEXT, Y20(body, intent))), [], `${body} / ${intent}`)
    }
  }
})

test('Y20 limits: any other decline in the message still counts; a plain decline is unchanged; STOP is still a STOP', () => {
  for (const body of ['I own it but not interested in lowball offers, not selling', 'Not interested. No lowball offers', 'not interested in selling', 'not interested in any offers', 'no thanks, not interested in lowball offers', 'I own it. Not looking to sell, and not interested in lowball offers']) {
    const l = buildCanonicalLedger({ messages: Y20(body), now: NOW })
    assert.equal(l.facts.seller_interest?.value, 'not_interested', body)
    assert.equal(l.stage.stage, 'nurture', body)
    assert.ok(declinesSelling(body), body)
  }
  const stop = buildCanonicalLedger({ messages: Y20('not interested in lowball offers. STOP'), now: NOW })
  assert.equal(stop.facts.opt_out?.value, 'stop_requested')
  assert.ok(v(Y20_TEXT, Y20('not interested in lowball offers. STOP')).reasons.includes('ledger:stop_requested_no_message'))
  assert.equal(LOWBALL_OBJECTION_RE.test('not interested in offers'), false, 'no qualifier, no objection')
})

test('Y11 and Y22 stay refused by design; the neutral forms pass', () => {
  const y11 = [ownQ('Bianca', 'Fennimore St', ago(4320)), { id: 'i1', direction: 'inbound', body: 'yes thats my house', at: ago(4300) },
    { id: 'o2', direction: 'outbound', body: 'Thanks for confirming! Have you given any thought to selling, or a rough timeline?', at: ago(4295) },
    { id: 'i2', direction: 'inbound', body: 'not until after schools out for the kids. dont want to move them mid year', at: ago(200) }]
  assert.ok(v('That makes sense, Bianca. Keeping the kids settled in the school year matters. When would be a good time to check back?', y11).reasons.includes('content:protected_class_reference'))
  assert.deepEqual(v('That makes sense, thanks for telling me, Bianca. Waiting until the school year is over sounds reasonable. When would be a good time to check back?', y11).reasons, [])
  const y22 = [ownQ('Ollie', 'Partridge Ln', ago(300)), { id: 'i1', direction: 'inbound', body: 'is this a scam?', at: ago(5) }]
  assert.ok(v("Fair to ask, Ollie. I'm Nova, an AI assistant with Reivesti Home Buyers. I only wanted to check who owns the house on Partridge Ln.", y22).reasons.includes('non_owner:asks_about_third_party_owner'))
  assert.deepEqual(ledgerReasons(v("Fair to ask, Ollie. I'm Nova, an AI assistant with Reivesti Home Buyers, not a person. I'm checking whether you still own the house on Partridge Ln. Do you?", y22)), [])
})
