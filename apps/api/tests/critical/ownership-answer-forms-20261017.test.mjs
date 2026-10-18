// OWNER DECISIONS LOCKED 2026-10-17 (round 2) — regression tests.
//   1. "Answer is no" (thread 0be8e4c6) — any direct no answering OUR ownership question, with an
//      unambiguous property — is the property-scoped ownership DENIAL: no 30-day nurture, no global
//      suppression. Without an established question, or without an identified property, it is a
//      contextual-review HOLD: never invented certainty.
//   2. A bare "Not interested" to the OWNERSHIP question is declined_unverified (no nurture; a property
//      × contact hold; no global suppression). "Not interested" to the SELLING question stays the
//      30-day nurture.
import test from 'node:test'
import assert from 'node:assert/strict'

import { isDirectNo, isBareNotInterested } from '../../src/lib/domain/classification/ownership-answer-forms.js'
import { bareNoAnswer } from '../../src/lib/domain/conversation-ai/answers.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { evaluateOwnershipRecontact, OWNERSHIP_DECLINED_REASON, OWNERSHIP_UNRESOLVED_REASON } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { replayReply } from '../helpers/reply-replay-harness.mjs'

const PHONE = '+15555550123'
const T0 = Date.parse('2026-09-01T15:00:00.000Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
const S1 = { message_type: 'sms', template_id: 'tpl-own', template_use_case: 'ownership_check', text: 'Hi Pat, this is Jake. Are you still the owner of 1 Main St?', sent_at: '2026-09-01T15:00:00Z', delivered_at: '2026-09-01T15:00:05Z' }
const S2 = { ...S1, template_id: 'tpl-s2', template_use_case: 'consider_selling', text: 'Would you consider an offer on 1 Main St if the number made sense?' }
const replay = (message, prior) => replayReply({ fixture_id: 'r2', seller_message: message, received_at: '2026-09-01T15:10:00Z', prior_question: prior }, { catalog: [] })
const ownQ = (id, min, property_id = 'p1') => ({ id, direction: 'outbound', message_body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', created_at: at(min), property_id })
const inb = (id, body, min) => ({ id, direction: 'inbound', message_body: body, created_at: at(min) })
const row = (property_id) => ({ to_phone_number: PHONE, thread_key: PHONE, property_id, use_case_template: 'follow_up', metadata: {} })

test('forms: direct no and bare not-interested are recognized narrowly', () => {
  for (const t of ['Answer is no', 'The answer is no.', 'No it is not', "No, it isn't", 'It is not']) assert.equal(isDirectNo(t), true, t)
  for (const t of ['answer is yes', 'yes it is', 'No idea', 'no']) assert.equal(isDirectNo(t), false, t)
  for (const t of ['Not interested', 'Not interested.', 'not interested thanks', 'No, not interested', "I'm not interested"]) assert.equal(isBareNotInterested(t), true, t)
  for (const t of ['not interested in selling', 'Yes, not interested', 'Not interested at this time', 'Interested']) assert.equal(isBareNotInterested(t), false, t)
})

test('decision 1: "Answer is no" to the ownership question is the property-scoped denial — no nurture, no suppression', async () => {
  for (const t of ['Answer is no', 'The answer is no.', 'No it is not']) {
    const r = await replay(t, S1)
    assert.equal(r.classification.primary_intent, 'property_specific_non_owner', t)
    assert.ok(r.classification.matched_rule_ids.includes('ctx_direct_no_after_ownership_check_ownership_unverified'), t)
    assert.equal(r.decision.follow_up_at ?? null, null, 'no 30-day nurture')
    assert.equal(r.decision.should_suppress_contact, false, 'no global suppression')
    assert.equal(r.decision.next_action, 'end_outreach_in_scope')
  }
})

test('decision 1: a direct no with NO established question is a contextual-review hold; to the SELLING question it is that decline', async () => {
  const none = await replay('Answer is no', null)
  assert.equal(none.classification.primary_intent, 'unclear')
  assert.ok(none.classification.matched_rule_ids.includes('direct_no_without_question_context'))
  assert.equal(none.decision.should_mark_human_review, true)
  assert.equal(none.decision.follow_up_at ?? null, null, 'never a nurture from an unknown question')
  assert.equal(none.decision.should_suppress_contact, false)
  const s2 = await replay('Answer is no', S2)
  assert.equal(s2.classification.primary_intent, 'not_interested', 'answers the selling question: the established selling decline')
})

test('decision 1: the property must be unambiguous — a property-less question makes it a THREAD hold, never every property', () => {
  const known = evaluateOwnershipRecontact(row('p1'), [ownQ('o1', 0, 'p1'), inb('i1', 'Answer is no', 5)])
  assert.deepEqual([known.blocked, known.reason, known.detail.scope], [true, 'property_ownership_denied_no_recontact', 'person_property'])
  assert.equal(evaluateOwnershipRecontact(row('p2'), [ownQ('o1', 0, 'p1'), inb('i1', 'Answer is no', 5)]).blocked, false)
  const loose = evaluateOwnershipRecontact(row('p2'), [ownQ('o1', 0, null), inb('i1', 'Answer is no', 5)])
  assert.deepEqual([loose.blocked, loose.hold, loose.reason], [true, true, OWNERSHIP_UNRESOLVED_REASON])
})

test('decision 2: a bare "Not interested" to the OWNERSHIP question is declined_unverified (no nurture, property hold); to the SELLING question it is the 30-day nurture', async () => {
  for (const t of ['Not interested', 'Not interested.', 'Not interested thanks']) {
    const r = await replay(t, S1)
    assert.equal(r.classification.primary_intent, 'ownership_declined_unverified', t)
    assert.ok(r.classification.matched_rule_ids.includes('ctx_not_interested_after_ownership_check_declined_unverified'), t)
    assert.equal(r.decision.follow_up_at ?? null, null, 'no nurture')
    assert.equal(r.decision.should_suppress_contact, false, 'no global suppression')
  }
  const sale = await replay('Not interested', S2)
  assert.equal(sale.classification.primary_intent, 'not_interested')
  assert.ok(sale.decision.follow_up_at || sale.decision.next_action === 'do_not_reply', 'the established 30-day nurture route')
  // sale words or a yes answer the SALE: unchanged
  assert.equal((await replay('not interested in selling', S1)).classification.primary_intent, 'not_interested')
  assert.equal((await replay('Yes, not interested in selling', S1)).classification.primary_intent, 'not_interested')
  const g = evaluateOwnershipRecontact(row('p1'), [ownQ('o1', 0, 'p1'), inb('i1', 'Not interested', 5)])
  assert.deepEqual([g.blocked, g.reason, g.detail.ownership], [true, OWNERSHIP_DECLINED_REASON, 'unverified'])
  assert.equal(evaluateOwnershipRecontact(row('p2'), [ownQ('o1', 0, 'p1'), inb('i1', 'Not interested', 5)]).blocked, false)
})

test('AI path: the shared matcher, the ledger and the pre-check read both forms the same way', () => {
  assert.deepEqual([bareNoAnswer('Answer is no').ownership_denial, bareNoAnswer('Not interested').ownership_declined], [true, true])
  assert.equal(bareNoAnswer('Not interested').ownership_denial, false)
  const msgs = (body) => [{ id: 'o1', direction: 'outbound', body: 'Hey Pat, this is Jake. Do you still own 1 Main St?', at: at(0) }, { id: 'i1', direction: 'inbound', body, at: at(5) }]
  assert.equal(buildCanonicalLedger({ messages: msgs('Answer is no'), now: at(6) }).facts.ownership.value, 'denied')
  assert.equal(buildCanonicalLedger({ messages: msgs('Not interested'), now: at(6) }).facts.ownership.value, 'declined_unverified')
  const pre = deterministicPrecheck({ text: 'Answer is no', inboundId: 'i1', deterministic: null, eligibility: null, lastQuestionKind: 'ownership' })
  assert.equal(pre.reason, 'ownership_denied')
  const preNi = deterministicPrecheck({ text: 'Not interested', inboundId: 'i1', deterministic: null, eligibility: null, lastQuestionKind: 'ownership' })
  assert.notEqual(preNi.reason, 'ownership_denied', 'declined is never a denial fact')
})
