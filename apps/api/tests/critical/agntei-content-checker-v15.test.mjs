// Owner decision 2026-10-30 (blind v15): two legitimate seller answers were refused by the content checker.
//   Q11  a follow-up of ours crossed with the seller's reply ("yes i still own it, what do u want" → then our "just checking
//        whether my last text came through"). The reply could not be answered (not "the latest inbound") and an
//        acknowledgement of it was read as acknowledging a reply never received. Our own initiated touches (an agent's
//        follow-up / nurture / re-engagement / first touch, a template follow-up) do not answer the seller: the seller's
//        message stays the one to answer, and saying "thanks" for it is true. Any other outbound (an agent's answer, a
//        person's manual send, an outbound whose queue row is unknown) still answers it: the fail-safe reading.
//   Q39  "it's ours lol why", to a question that was not the ownership question, is the seller's ownership claim.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { agentTextPurposeVerdict, pendingSellerMessage } from '../../src/lib/domain/outreach/agent-text.js'
import { loadThreadHistory } from '../../src/lib/domain/outreach/agent-message.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { sellerWroteSinceOurLast, validateWriterSafety } from '../../src/lib/domain/conversation-ai/writer-safety.js'
import { OWN_CONFIRM_RE } from '../../src/lib/domain/conversation-ai/fact-ledger.js'

const NOW = '2026-10-30T15:00:00.000Z'
const ago = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString()
const COMPANY = { configured: true, name: 'Reivesti Home Buyers', persona_descriptor: 'AI assistant' }

const q11 = (followupKind) => [
  { id: 'm1', direction: 'outbound', body: 'Hi Pam, this is Nova, an AI assistant with Reivesti Home Buyers. Would you ever consider selling your place on Juniper Ridge?', at: ago(2900), non_answer: true },
  { id: 'm2', direction: 'inbound', body: 'yes i still own it, what do u want', at: ago(95) },
  { id: 'm3', direction: 'outbound', body: 'Hi Pam, just checking whether my last text came through. No pressure either way.', at: ago(31), ...(followupKind === 'non_answer' ? { non_answer: true } : {}) },
]
const Q11_TEXT = "Thanks for confirming, Pam. I'm Nova, an AI assistant with Reivesti Home Buyers. I'm just asking about the house on Juniper Ridge. What are your plans for it?"

test('Q11: a seller message followed only by our own follow-up is still the one to answer, and may be acknowledged', () => {
  const messages = q11('non_answer')
  assert.equal(pendingSellerMessage(messages)?.id, 'm2')
  const pv = agentTextPurposeVerdict({ purpose: 'qualification', inReplyTo: 'm2', messages, now: NOW })
  assert.equal(pv.ok, true, JSON.stringify(pv))
  assert.equal(pv.answers.id, 'm2')
  assert.equal(sellerWroteSinceOurLast(messages), true)
  const v = validateAgentText(Q11_TEXT, { purpose: 'qualification', messages, companyIdentity: COMPANY, authorEmployee: 'Nova', firstName: 'Pam', now: NOW })
  assert.ok(!v.reasons.includes('thread:acknowledges_reply_not_received_since_last_message'), JSON.stringify(v.reasons))
  // and no follow-up may go out while the seller's message waits
  const fu = agentTextPurposeVerdict({ purpose: 'followup', messages, now: NOW })
  assert.equal(fu.code, 'UNANSWERED_SELLER_MESSAGE')
})

test('Q11 the other way: when the outbound after the seller message is (or may be) an answer, nothing changes', () => {
  const messages = q11('answer') // unknown origin: counts as an answer
  assert.equal(pendingSellerMessage(messages), null)
  assert.equal(agentTextPurposeVerdict({ purpose: 'qualification', inReplyTo: 'm2', messages, now: NOW }).code, 'IN_REPLY_TO_NOT_LATEST_INBOUND')
  const ws = validateWriterSafety(Q11_TEXT, { thread: messages, companyIdentity: COMPANY })
  assert.ok(ws.reasons.includes('thread:acknowledges_reply_not_received_since_last_message'), JSON.stringify(ws.reasons))
  // a seller who never wrote cannot be thanked, even after our own touches only
  const onlyOurs = [{ id: 'a', direction: 'outbound', body: 'Hi', at: ago(100), non_answer: true }, { id: 'b', direction: 'outbound', body: 'Checking in', at: ago(10), non_answer: true }]
  assert.ok(validateWriterSafety('Thanks for getting back to me!', { thread: onlyOurs, companyIdentity: COMPANY }).reasons.includes('thread:acknowledges_reply_seller_never_sent'))
  // answering an OLDER inbound than the pending one is still refused
  const two = [...q11('non_answer'), { id: 'm4', direction: 'inbound', body: 'hello?', at: ago(5) }]
  assert.equal(agentTextPurposeVerdict({ purpose: 'reply', inReplyTo: 'm2', messages: two, now: NOW }).code, 'IN_REPLY_TO_NOT_LATEST_INBOUND')
})

const fakeDb = (events, queue, { queueFails = false } = {}) => ({
  from(table) {
    const q = { _t: table, select() { return q }, eq() { return q }, order() { return q }, limit() { return Promise.resolve({ data: [...events].reverse(), error: null }) },
      in(_c, ids) { return Promise.resolve(queueFails ? { data: null, error: { message: 'denied' } } : { data: queue.filter((r) => ids.includes(r.id)), error: null }) } }
    return q
  },
})

test('thread history marks our initiated touches as non-answers from their queue rows; unknown or unreadable rows stay answers', async () => {
  const events = [
    { id: 'e1', direction: 'outbound', message_body: 'opener', created_at: ago(300), queue_id: 'q1' },
    { id: 'e2', direction: 'inbound', message_body: 'yes', created_at: ago(200), queue_id: null },
    { id: 'e3', direction: 'outbound', message_body: 'checking in', created_at: ago(100), queue_id: 'q2' },
    { id: 'e4', direction: 'outbound', message_body: 'a person wrote this', created_at: ago(50), queue_id: 'q3' },
    { id: 'e5', direction: 'outbound', message_body: 'no queue row', created_at: ago(40), queue_id: 'q9' },
  ]
  const queue = [
    { id: 'q1', message_origin: 'ai_generated', message_type: 'campaign_opener', metadata: { send_kind: 'agent_first_touch' } },
    { id: 'q2', message_origin: 'template', message_type: 'followup', metadata: {} },
    { id: 'q3', message_origin: 'operator_manual', message_type: 'manual', metadata: {} },
  ]
  const m = await loadThreadHistory(fakeDb(events, queue), '+15550001111')
  assert.deepEqual(m.map((x) => [x.id, x.non_answer === true]), [['e1', true], ['e2', false], ['e3', true], ['e4', false], ['e5', false]])
  const failing = await loadThreadHistory(fakeDb(events, queue, { queueFails: true }), '+15550001111')
  assert.ok(failing.every((x) => x.non_answer !== true), 'an unreadable queue never unlocks an answer')
})

const Q39_TEXT = "Thanks for confirming, Odette. I'm Nova, an AI assistant with Reivesti Home Buyers, and I'm just asking whether selling is something you'd ever consider. What are your plans for the house?"

test("Q39: \"it's ours lol why\" is the seller's ownership claim, so thanking them for confirming is supported", () => {
  const messages = [
    { id: 'n1', direction: 'outbound', body: 'Hi Odette, this is Nova, an AI assistant with Reivesti Home Buyers. Would you ever consider selling your place on Fairmount Ave?', at: ago(1800) },
    { id: 'n2', direction: 'inbound', body: "it's ours lol why", at: ago(14) },
  ]
  const v = validateAgentText(Q39_TEXT, { purpose: 'qualification', messages, companyIdentity: COMPANY, authorEmployee: 'Nova', firstName: 'Odette', now: NOW })
  assert.ok(!v.reasons.includes('property:unsupported_confirmation_claim'), JSON.stringify(v.reasons))
})

test('ownership possession phrases: claims and the lookalikes that are not', () => {
  for (const t of ["it's ours lol why", 'it is ours', "that's ours", "it's still ours", 'the house is ours', 'we own it', 'we still own it', "yes it's mine", "It's still mine, why?"]) {
    assert.ok(OWN_CONFIRM_RE.test(t), `claim: ${t}`)
  }
  // the bare "still mine" / "still ours" is an answer to OUR ownership question only (blind v8 owner rule), never free-standing
  for (const t of ["it's ours?", 'is it ours?', 'used to be ours', 'it was ours', "it's my mom's", 'we rent', 'my brother owns it', 'still mine', 'Still ours']) {
    assert.ok(!OWN_CONFIRM_RE.test(t), `not a claim: ${t}`)
  }
  // denials and former ownership are read before any claim (fact ledger order): these never confirm
  const deny = (body) => validateAgentText(Q39_TEXT, { purpose: 'qualification', messages: [{ id: 'x1', direction: 'outbound', body: 'Hi Odette, would you consider selling?', at: ago(100) }, { id: 'x2', direction: 'inbound', body, at: ago(5) }], companyIdentity: COMPANY, authorEmployee: 'Nova', firstName: 'Odette', now: NOW })
  for (const t of ["not ours", "it isn't ours", 'we sold it last year', 'not ours anymore']) {
    const v = deny(t)
    assert.equal(v.ok, false, `${t} → must not pass`)
  }
})
