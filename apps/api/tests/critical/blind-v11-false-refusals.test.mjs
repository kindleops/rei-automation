// Blind v11 run 1 (agntau docs/acquisitions-certification/blind-v11/run-1): five compliant agent texts refused, fixed by
// class, each with negative cases:
//  U05, U19 — an affirmative answer to our ownership question followed by a question of the seller's own ("I do. And
//             you want to know that because...?", "Yeah. Do yall buy houses that need work?") is still the answer
//  U17      — "Who is reivesti exactly, like an actual company…" is an identity question (the one re-ask applies)
//  U23      — "What makes yall any different from the rest of them" asks about the company
//  U46      — "we just gutted the kitchen and put in a new deck" discloses condition a reply may acknowledge
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (body, messages, purpose = null) => validateAgentText(body, { purpose, companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const ownQ = { id: 'o1', direction: 'outbound', body: 'Hi Lenore, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Heron Way?', at: ago(3000) }
const reply = (body) => ({ id: 'i1', direction: 'inbound', body, at: ago(200) })
const own = (body) => buildCanonicalLedger({ messages: [ownQ, reply(body)], now: NOW }).facts.ownership?.value ?? null
const gateReasons = (r) => r.reasons.filter((x) => /^ledger:|^property:|^identity:|^claim:/.test(x))

test('U05, U19: an affirmative answer stays an answer when the seller adds a question of their own', () => {
  for (const body of ['I do. And you want to know that because...?', 'Yeah. Do yall buy houses that need a lot of work? Basement floods every time it storms', 'Yes, why?']) assert.equal(own(body), 'confirmed', body)
  assert.deepEqual(gateReasons(v('Fair question, Lenore. Thanks for confirming. What are your plans for the house?', [ownQ, reply('I do. And you want to know that because...?')])), [])
})

test('U05 limits: an affirmative asked back, or a "yes" about someone else, is not an answer', () => {
  for (const body of ['Yes?', 'Correct? who is this', 'Yeah? who wants to know', 'Yes, my mom owns it, why?', 'I do? no I sold it']) assert.notEqual(own(body), 'confirmed', body)
})

test('U17: "who is <company> exactly" and "an actual company" are identity questions', () => {
  const t = [ownQ, reply('Who is reivesti exactly, like an actual company or some guy flipping houses out of his truck')]
  assert.deepEqual(gateReasons(v("Fair question. I'm Nova, an AI assistant with Reivesti Home Buyers, not a person. Are you still the owner of the house on Heron Way?", t)), [])
  const notIdentity = v('Are you still the owner of the house on Heron Way?', t)
  assert.ok(notIdentity.reasons.includes('ledger:already_asked:ownership'), 'a bare re-ask that answers nothing stays refused')
  const owner = buildCanonicalLedger({ messages: [ownQ, reply('who is the owner exactly? not me')], now: NOW })
  assert.equal(owner.requests.some((r) => r.kind === 'identity'), false, '"who is the owner exactly" is not a question about us')
})

test('U23: "what makes yall any different" asks about the company; an unasked company statement is still refused', () => {
  const asked = [ownQ, reply('I get like 20 of these a week. What makes yall any different from the rest of them')]
  const body = "That's fair, Philippa. I'm an AI assistant, so I can't speak for how other companies work, and I won't claim we're better. Is the house on Heron Way still yours?"
  assert.deepEqual(gateReasons(v(body, asked)).filter((x) => x.startsWith('identity:')), [])
  const unasked = v(body, [ownQ, reply('maybe')])
  assert.ok(unasked.reasons.includes('identity:company_statement_not_asked'), JSON.stringify(unasked.reasons))
})

test('U46: renovations are condition the seller disclosed; an invented condition is still refused', () => {
  const t = [ownQ, reply('Nah we just gutted the kitchen and put in a new deck, staying put for a good while')]
  assert.deepEqual(gateReasons(v('Totally understand, thanks for letting me know, and the kitchen and deck sound like great updates. Mind if I check back in a few months?', t)), [])
  const invented = v('Totally understand, thanks for letting me know, and the kitchen and deck sound like great updates. Mind if I check back in a few months?', [ownQ, reply('Nah, staying put for a good while')])
  assert.ok(invented.reasons.includes('ledger:unsupported_claim:condition'), JSON.stringify(invented.reasons))
})
