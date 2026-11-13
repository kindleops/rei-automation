// rc-8.5.21 blind-eval fixes S1 (multi-property attribution) and S2 (fabricated identity), written
// from the DESCRIBED behaviour (new addresses and phrasings, never the held-out case texts).
import test from 'node:test'
import assert from 'node:assert/strict'

import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { attributeInbounds, addressKeysIn } from '../../src/lib/domain/conversation-ai/property-facts.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { validateOutbound, propertyMentionReasons, identityStatementReasons } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { evaluateOwnershipRecontact } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { buildComposePrompt } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { matchAutomationRule } from '../../src/lib/domain/automation/automation-rules.js'

const T = (min) => new Date(Date.parse('2026-10-18T16:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min, property_id) => ({ id, direction: 'outbound', body, at: T(min), property_id })
const inb = (id, body, min, property_id) => ({ id, direction: 'inbound', body, at: T(min), property_id })
const PROPS = [{ property_id: 'pA', address: '4410 Juniper Dr' }, { property_id: 'pB', address: '2235 Willow Ct' }]

function world(thread, { resolutions = [], properties = PROPS } = {}) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: last.property_id }, thread: thread.filter((m) => m !== last), properties, contact_property_resolutions: resolutions }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  return { input, ledger }
}

// the multi-property thread: A denied, then B confirmed (the inbound rows carry B, the latest property)
const MULTI = [
  out('o1', 'Hi Rosa, this is Helen. Are you still the owner of 4410 Juniper Dr?', 60, 'pA'),
  inb('i1', 'Not mine', 50, 'pB'),
  out('o2', 'Hi Rosa, this is Helen. Just checking, do you own 2235 Willow Ct?', 30, 'pB'),
  inb('i2', 'Yes that one is mine', 2, 'pB'),
]

test('S1: per-property facts — the denial is on A, the confirmation on B (one attribution rule)', () => {
  const { ledger } = world(MULTI)
  const po = ledger.property.ownership
  assert.equal(po.by_property.pA.state, 'denied', JSON.stringify(po.by_property))
  assert.equal(po.by_property.pB.state, 'confirmed')
  assert.equal(po.thread_hold, false)
  assert.deepEqual(addressKeysIn('thanks, 4410 Juniper Dr it is'), ['4410 juniper', 'street:juniper'])
})

test('S1: the shared validator HARD-blocks naming the denied property and the false "thanks for confirming"', () => {
  const { ledger } = world(MULTI)
  const bad = validateOutbound('Rosa, thanks for confirming 4410 Juniper Dr is yours. Would you ever consider selling it?', { ledger, objective: 'interest', category: 'next_missing_fact' })
  assert.ok(bad.content_reasons.includes('property:names_denied_property'), JSON.stringify(bad.content_reasons))
  assert.ok(bad.content_reasons.includes('property:unsupported_confirmation_claim'))
  // the confirmed property may be named (no property reason)
  assert.deepEqual(propertyMentionReasons('Rosa, thanks for confirming 2235 Willow Ct is yours. Would you ever consider selling it?', ledger, { questionKind: 'interest' }), [])
  // the street name alone is a mention too
  assert.ok(propertyMentionReasons('How is the Juniper Dr place these days?', ledger).includes('property:names_denied_property'))
})

test('S1: a denial already PERSISTED in contact_property_resolution blocks naming that property (the guard checks the row, the validator the text)', () => {
  const thread = [out('o2', 'Hi Rosa, this is Helen. Do you own 2235 Willow Ct?', 30, 'pB'), inb('i2', 'Yes I own it', 2, 'pB')]
  const { ledger } = world(thread, { resolutions: [{ property_id: 'pA', contact_property_role: 'not_owner', rejected_at: T(600), suppression_scope: 'contact_property_pair' }] })
  assert.equal(ledger.property.ownership.by_property.pA.state, 'denied')
  assert.ok(propertyMentionReasons('Thanks. Is 4410 Juniper Dr still yours too?', ledger, { questionKind: 'ownership' }).includes('property:names_denied_property'))
  // a recorded polite decline (ownership UNVERIFIED) blocks too
  const d = world(thread, { resolutions: [{ property_id: 'pA', contact_property_role: 'ownership_declined_unverified', rejected_at: null, updated_at: T(600) }] })
  assert.ok(propertyMentionReasons('Would you sell 4410 Juniper Dr?', d.ledger, { questionKind: 'interest' }).includes('property:names_declined_unverified_property'))
})

test('S1: the writer names only CONFIRMED properties (the ownership question is the one exception); an unknown address is blocked', () => {
  const thread = [out('o1', 'Hi, is this Rosa? Do you own 2235 Willow Ct?', 30, 'pB'), inb('i1', 'who is this?', 2, 'pB')]
  const { ledger } = world(thread)
  assert.deepEqual(propertyMentionReasons('I am Helen, a local buyer. Do you own 2235 Willow Ct?', ledger, { questionKind: 'ownership' }), [])
  assert.ok(propertyMentionReasons('Would you consider selling 2235 Willow Ct?', ledger, { questionKind: 'interest' }).includes('property:names_unconfirmed_property'))
  assert.ok(propertyMentionReasons('Do you also own 77 Cedar Ave?', ledger, { questionKind: 'ownership' }).includes('property:names_unknown_address'))
})

test('S1 (owner 10-17): ONE bare "No" to ownership questions about TWO properties ⇒ a thread HOLD, never a denial of the latest', () => {
  const thread = [
    out('o1', 'Hi Sam, this is Greg. Are you still the owner of 4410 Juniper Dr?', 40, 'pA'),
    out('o2', 'Also, do you own 2235 Willow Ct?', 30, 'pB'),
    inb('i1', 'No', 2, 'pB'),
  ]
  const att = attributeInbounds({ messages: thread, questionKindOf }).get('i1')
  assert.deepEqual([att.property, att.ambiguous, att.basis], ['', true, 'several_open_ownership_questions'])
  const { ledger, input } = world(thread)
  assert.equal(ledger.property.ownership.thread_hold, true)
  assert.notEqual(ledger.property.ownership.by_property.pB?.state, 'denied', 'the latest property is NOT denied')
  const plan = decideActions({ ledger, inboundText: 'No', inboundId: 'i1', deterministic: null, eligibility: { blocked: false }, judgment: null, language: 'en', propertyCount: 2, thread: input.thread, inbound: input.inbound })
  assert.deepEqual(plan.actions.map((a) => [a.type, a.reason]), [[ACTIONS.HOLD, 'ownership_denial_property_unresolved']])
  // the send-time guard holds the thread for either property
  for (const p of ['pA', 'pB']) {
    const g = evaluateOwnershipRecontact({ property_id: p, metadata: {} }, thread.map((m) => ({ ...m, message_body: m.body })))
    assert.deepEqual([g.blocked, g.hold, g.reason], [true, true, 'ownership_denial_property_unresolved'], `${p}: ${JSON.stringify(g)}`)
  }
})

test('S1: a reply that NAMES one property answers that property even when the row carries another', () => {
  const thread = [out('o1', 'Do you still own 4410 Juniper Dr?', 40, 'pA'), out('o2', 'Would you consider selling 2235 Willow Ct?', 30, 'pB'), inb('i1', 'I dont own 4410 Juniper Dr', 2, 'pB')]
  const { ledger } = world(thread)
  assert.equal(ledger.property.ownership.by_property.pA.state, 'denied')
  assert.notEqual(ledger.property.ownership.by_property.pB?.state, 'denied')
  const g = evaluateOwnershipRecontact({ property_id: 'pB', metadata: {} }, thread.map((m) => ({ ...m, message_body: m.body })))
  assert.equal(g.blocked, false, JSON.stringify(g))
  const gA = evaluateOwnershipRecontact({ property_id: 'pA', metadata: {} }, thread.map((m) => ({ ...m, message_body: m.body })))
  assert.equal(gA.reason, 'property_ownership_denied_no_recontact')
})

test('S1: the compose prompt tells the writer which property it may name', () => {
  const { ledger } = world(MULTI)
  const p = buildComposePrompt({ ledger, inboundText: 'Yes that one is mine', category: 'next_missing_fact', objective: 'interest', tone: 'neutral' })
  assert.match(p.user, /confirmed \(you may name it\): 2235 Willow Ct/)
  assert.match(p.user, /NEVER mention or ask about: 4410 Juniper Dr/)
})

test('S2: no company-identity statement of ANY kind unless configured AND asked; automation only when directly asked', () => {
  const thread = [out('o1', 'Hey, this is Helen. Do you still own 2235 Willow Ct?', 60, 'pB'), inb('i1', 'Yes', 50, 'pB'), out('o2', 'Would you be open to a proposal on it?', 30, 'pB'), inb('i2', 'Yes maybe, tell me more', 2, 'pB')]
  const { ledger } = world(thread)
  const none = { configured: false }
  assert.ok(identityStatementReasons("I'm Helen, a local buyer. I don't represent a company. What price did you have in mind?", ledger, none).includes('identity:company_statement_without_configured_identity'))
  assert.ok(identityStatementReasons("I'm Greg, a local buyer, and I have no company name to share.", ledger, none).includes('identity:company_statement_without_configured_identity'))
  const acme = { configured: true, name: 'Juniper Home Partners', website: null }
  assert.ok(identityStatementReasons('I work with Juniper Home Partners, a local company.', ledger, acme).includes('identity:company_statement_not_asked'), 'configured but NOT asked')
  const asked = world([...thread.slice(0, 3), inb('i2', 'What company are you with?', 2, 'pB')])
  assert.deepEqual(identityStatementReasons('I work with Juniper Home Partners, a local company.', asked.ledger, acme), [])
  assert.ok(identityStatementReasons("Good question. I'm not a bot, just Helen.", ledger, none).includes('identity:automation_statement_not_asked'))
  const bot = world([...thread.slice(0, 3), inb('i2', 'Is this a bot?', 2, 'pB')])
  assert.deepEqual(identityStatementReasons('This number uses automation to reply, and Helen reads every message.', bot.ledger, none), [])
  assert.ok(identityStatementReasons('Mike is a colleague of mine on the same outreach. Do you own it?', ledger, none).includes('identity:unverifiable_colleague_claim'))
  // through the ONE shared validator
  const v = validateOutbound("I'm Helen, a local buyer here. I don't represent a company. What price did you have in mind?", { ledger, objective: 'asking_price', category: 'next_missing_fact' })
  assert.ok(v.content_reasons.includes('identity:company_statement_without_configured_identity'), JSON.stringify(v.content_reasons))
})

test('SYN-47: after a stated asking price the text never approves it ("Sounds good." reads as acceptance); the next stage question passes', () => {
  const thread = [out('o1', 'Do you own 2235 Willow Ct?', 90, 'pB'), inb('i1', 'yes', 80, 'pB'), out('o2', 'Would you consider selling it?', 60, 'pB'), inb('i2', 'sure', 50, 'pB'), out('o3', 'What price did you have in mind?', 30, 'pB'), inb('i3', 'I want 4 million for it', 2, 'pB')]
  const { ledger } = world(thread)
  assert.ok((ledger.facts.asking_price?.source_message_ids || []).includes('i3'), JSON.stringify(ledger.facts.asking_price))
  const bad = validateOutbound('Sounds good. Before I put anything together, what condition is the house in?', { ledger, objective: 'condition', category: 'next_missing_fact' })
  assert.ok(bad.content_reasons.includes('content:implies_acceptance_of_stated_price'), JSON.stringify(bad.content_reasons))
  const ok = validateOutbound('Thanks for sharing that number. What condition is the house in right now?', { ledger, objective: 'condition', category: 'next_missing_fact' })
  assert.ok(!ok.content_reasons.includes('content:implies_acceptance_of_stated_price'), JSON.stringify(ok.content_reasons))
})

test('SCONV-09: an owner who mentions a former TENANT is never a bad contact (the rule fires only for a tenant / non-owner respondent)', () => {
  const ev = (text, intent = null) => ({ event_type: 'inbound_message_received', payload: { message_body: text, classification: intent ? { primary_intent: intent } : {} } })
  const rule = { event_type: 'inbound_message_received', condition: { matcher: 'not_owner_or_tenant' } }
  assert.equal(matchAutomationRule(rule, ev('Yes I own it, bought it in 2018. The tenant left in August')).matched, false)
  assert.equal(matchAutomationRule(rule, ev('the tenant moved out', 'ownership_confirmed')).matched, false)
  assert.equal(matchAutomationRule(rule, ev("I'm the tenant here, not the owner")).matched, true)
  assert.equal(matchAutomationRule(rule, ev('I dont own that place')).matched, true)
})

test('reply-rate defects: a terms objection phrased "only if it does not involve creative financing" is conditional interest (the clarify reply), and "so what can you do?" is an offer request (named, not "ambiguous")', () => {
  const base = [out('o1', 'Do you own 2235 Willow Ct?', 90, 'pB'), inb('i1', 'yes', 80, 'pB'), out('o2', 'Would you consider selling it?', 60, 'pB')]
  const fin = world([...base, inb('i2', 'Only if it does not involve seller financing or monthly payments', 2, 'pB')])
  const p1 = decideActions({ ledger: fin.ledger, inboundText: fin.input.inbound.body, inboundId: 'i2', eligibility: { blocked: false }, language: 'en', propertyCount: 1, thread: fin.input.thread, inbound: fin.input.inbound })
  assert.equal(p1.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)?.category, 'conditional_interest_clarify', JSON.stringify(p1.actions))
  const off = world([...base, inb('i2', 'So what can you do?', 2, 'pB')])
  assert.ok(off.ledger.offer_requests.includes('i2'))
  const p2 = decideActions({ ledger: off.ledger, inboundText: 'So what can you do?', inboundId: 'i2', eligibility: { blocked: false }, language: 'en', propertyCount: 1, thread: off.input.thread, inbound: off.input.inbound })
  assert.ok(p2.actions.some((a) => a.type === ACTIONS.PREPARE_OFFER), JSON.stringify(p2.actions))
})
