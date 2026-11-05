// Blind v10 run 1 (agntau docs/acquisitions-certification/blind-v10/run-1): the independent grader judged eight agent
// texts compliant that LeadCommand refused, which left seven required replies unanswered. Fixed by class:
//  W15, W16 — "What's this regarding exactly?" and "who's asking?" are identity questions (the one re-ask applies)
//  W04      — an affirmative opening sentence answering our ownership question ("Correct. Inherited it from my aunt…")
//  W32      — "We do still own it."
//  W37      — a tentative plan to sell ("maybe selling in the fall") is conditional interest a re-engagement may cite
//  W39, W40 — a no-reply follow-up may repeat the question the seller never answered (LeadCommand's own follow-up
//             templates do), at most twice more, never the asking price, and only while the seller has sent nothing
//  W49      — "reply STOP and I won't text again" is true (STOP suppresses); an unconditional promise is still refused
// Each class carries negative cases: nothing here reads a non-owner, a sale, a decline or a STOP as anything else.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'
import { ownershipEvidenceItems } from '../../src/lib/domain/queue/ownership-recontact-guard.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (body, messages, purpose = null) => validateAgentText(body, { purpose, companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const ownQ = (at = ago(3000), id = 'o1') => ({ id, direction: 'outbound', body: 'Hi Gene, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Wren Ct?', at })
const reply = (body, at = ago(200), id = 'i1') => ({ id, direction: 'inbound', body, at })
const ownership = (body) => buildCanonicalLedger({ messages: [ownQ(), reply(body)], now: NOW }).facts.ownership
const interest = (body) => buildCanonicalLedger({ messages: [ownQ(), reply(body)], now: NOW }).facts.seller_interest
const ledgerOrClaim = (r) => r.reasons.filter((x) => /^ledger:|^property:|^claim:/.test(x))

test('W15, W16: "what\'s this regarding" and "who\'s asking" are identity questions; the one re-ask is allowed', () => {
  for (const q of ["What's this regarding exactly?", 'whats this in regards to', "who's asking?", 'who is asking? is reivesti a company or a person']) {
    const r = v("I'm Nova, an AI assistant with Reivesti Home Buyers, a company. Do you still own the house on Wren Ct?", [ownQ(), reply(q)])
    assert.deepEqual(ledgerOrClaim(r), [], `${q}: ${JSON.stringify(r.reasons)}`)
  }
  const r = v('Do you still own the house on Wren Ct?', [ownQ(), reply("What's this regarding exactly?")])
  assert.ok(r.reasons.includes('ledger:already_asked:ownership'), 'a bare re-ask that does not answer the identity question stays refused')
})

test('W04, W32: an affirmative answer to our ownership question is the seller\'s ownership claim', () => {
  for (const body of ['Correct. Inherited it from my aunt back in 2019, its been sitting empty since', 'Yep, been renting it out for years', 'Yes. Roof is old though', "That's right, why do you ask", 'We do still own it. Im retiring in the spring', 'I do own it, yes']) {
    const f = ownership(body)
    assert.equal(f?.value, 'confirmed', body)
    assert.match(f.origin, /^seller_|^extractor|^ledger|stated|answer/, `${body}: ${f.origin}`)
  }
  assert.deepEqual(ledgerOrClaim(v('Thanks for confirming, Gene. What are your plans for the house now?', [ownQ(), reply('Correct. Inherited it from my aunt back in 2019')])), [])
  const items = ownershipEvidenceItems({ messages: [{ ...ownQ(), property_id: 'p1' }, { ...reply('Correct. Inherited it from my aunt'), property_id: null }], properties: [{ property_id: 'p1', address: '9 Wren Ct' }] })
  assert.deepEqual(items.map((i) => [i.state, i.basis]), [['confirmed', 'affirmative_answer_to_ownership_question']])
})

test('W04 limits: a sale, a former or another owner, a representative or a question back is never read as confirmation', () => {
  for (const body of ['Yes, but my mom owns it now', 'Yes. Used to, sold it in 2021', 'Correct? who is this', 'Yeah it was mine, not anymore', "Yes, I'm her son, she's in a home now", 'Yes it belongs to my brother', 'yes we sold it last spring']) {
    assert.notEqual(ownership(body)?.value, 'confirmed', body)
  }
  assert.equal(ownership('Yes? who is this')?.value ?? null, null)
  const noQuestion = buildCanonicalLedger({ messages: [{ id: 'o1', direction: 'outbound', body: 'Hi Gene, this is Nova with Reivesti Home Buyers.', at: ago(3000) }, reply('Correct. Inherited it')], now: NOW }).facts.ownership
  assert.notEqual(noQuestion?.value, 'confirmed', 'only against OUR ownership question')
  assert.notEqual(ownership('We do not own it')?.value, 'confirmed')
})

test('W37: a tentative plan to sell is conditional interest; a re-engagement may cite it', () => {
  for (const body of ['yes I own it, maybe selling in the fall once my son moves out', 'mine. might sell next year', 'its mine, thinking about selling eventually']) assert.equal(interest(body)?.value, 'conditional', body)
  const thread = [ownQ(ago(250000)), reply('yes I own it, maybe selling in the fall once my son moves out', ago(249800)), { id: 'o2', direction: 'outbound', body: "Thanks Leona, that's helpful. Is there anything about the house that needs work?", at: ago(249790) }]
  const r = v("Hi Leona, Nova with Reivesti Home Buyers again. You mentioned you might sell in the fall. Is that still something you're thinking about for the house on Wren Ct?", thread, 'reengage')
  assert.deepEqual(r.reasons.filter((x) => /attribution/.test(x)), [], JSON.stringify(r.reasons))
})

test('W37 limits: a decline in the same message wins; "might not sell" is not interest', () => {
  for (const body of ['maybe selling someday but not selling now, not interested', 'I might not sell at all', 'not selling, maybe never']) assert.notEqual(interest(body)?.value, 'conditional', body)
  assert.equal(interest('no thanks, maybe selling in a few years')?.value, 'not_interested')
})

const FOLLOW = 'Hi Margo, Nova with Reivesti Home Buyers again. Just checking in. Are you still the owner of the house on Wren Ct?'
test('W39, W40: a no-reply follow-up may repeat the unanswered ownership question, twice more at most', () => {
  assert.deepEqual(ledgerOrClaim(v(FOLLOW, [ownQ(ago(9000))], 'followup')), [])
  const second = [ownQ(ago(9000)), { id: 'o2', direction: 'outbound', body: 'Following up on Wren Ct. Are you still the owner?', at: ago(5000) }]
  assert.deepEqual(ledgerOrClaim(v(FOLLOW, second, 'followup')), [])
  const third = [...second, { id: 'o3', direction: 'outbound', body: 'Checking back on Wren Ct. Do you still own it?', at: ago(3000) }]
  assert.ok(v(FOLLOW, third, 'followup').reasons.includes('ledger:already_asked:ownership'), 'never a fourth ask')
})

test('W39, W40 limits: never once the seller replied, never as a reply, never the asking price', () => {
  assert.ok(v(FOLLOW, [ownQ(ago(9000)), reply('hmm', ago(8000))], 'followup').reasons.includes('ledger:already_asked:ownership'), 'the seller wrote back: a follow-up is not a re-ask')
  assert.ok(v(FOLLOW, [ownQ(ago(9000))], 'reply').reasons.includes('ledger:already_asked:ownership'))
  const priceAsked = [ownQ(ago(9000)), reply('yes mine', ago(8900)), { id: 'o2', direction: 'outbound', body: 'Thanks. Is it something you would sell?', at: ago(8800) }, reply('maybe', ago(8700)), { id: 'o3', direction: 'outbound', body: 'What price do you have in mind for it?', at: ago(8600) }]
  assert.ok(v('Just checking back. What price do you have in mind for the house?', priceAsked, 'followup').reasons.some((x) => /already_asked:asking_price/.test(x)))
  const stop = v(FOLLOW, [ownQ(ago(9000)), reply('STOP', ago(8000))], 'followup')
  assert.ok(stop.reasons.includes('inbound:opt_out') || stop.code === 'STOP_REQUESTED', JSON.stringify(stop.reasons))
})

test('W49: a no-further-contact promise conditioned on STOP is true; an unconditional one is still refused', () => {
  const t = [ownQ(), reply("Are you a real person? I'm 81 and my grandson says not to trust these texts")]
  for (const s of ["If you'd rather not hear from me, just reply STOP and I won't text again.", 'Reply STOP and we will not message you again.', "If you reply STOP, I won't contact you again."]) {
    const r = v(`Fair question. I'm Nova, an AI assistant with Reivesti Home Buyers, not a person. ${s}`, t)
    assert.deepEqual(r.reasons.filter((x) => /no_further_contact|no_contact/.test(x)), [], `${s}: ${JSON.stringify(r.reasons)}`)
  }
  for (const s of ["I won't text you again.", "No worries, you won't hear from me again.", "Reply STOP anytime. Either way I won't bother you again."]) {
    const r = v(`Fair question. I'm Nova, an AI assistant with Reivesti Home Buyers, not a person. ${s}`, t)
    assert.ok(r.reasons.includes('claim:no_further_contact_while_nurture_scheduled'), `${s}: ${JSON.stringify(r.reasons)}`)
  }
})
