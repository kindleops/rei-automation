// Owner 2026-10-30 ("fix the seller-fact extraction problem before the canary"): conversational ownership confirmations
// and dated / seasonal timelines are recognized in their conversation and property context, kept as the seller's CLAIM
// (never verified ownership), resolved only from the message's own timestamp to a month or season (never a day, never
// an urgency), with ambiguity kept — and nothing here weakens opt-out, suppression or identity enforcement.
// Positive cases come from blind v8 (Z15, Z30, Z53) and real-model e2e-9 ("this winter"); negative cases pin the limits.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalLedger, OWN_ANSWER_STILL_RE } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { sellerTimelineMentions, resolveTimeReference, timeReferencesIn } from '../../src/lib/domain/conversation-ai/time-references.js'
import { staleSellerTimeReasons } from '../../src/lib/domain/conversation-ai/writer-safety.js'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { DEFAULT_AGENT_TEXT_POLICY } from '../../src/lib/domain/outreach/agent-text.js'
import { ownershipEvidenceItems } from '../../src/lib/domain/queue/ownership-recontact-guard.js'
import { extractSellerFacts } from '../../src/lib/domain/seller-flow/extract-seller-facts.js'

const NOW = '2026-10-30T18:00:00.000Z'
const ago = (h) => new Date(Date.parse(NOW) - h * 3600e3).toISOString()
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const v = (body, messages) => validateAgentText(body, { companyIdentity: CI, now: NOW, policy: { ...DEFAULT_AGENT_TEXT_POLICY }, authorEmployee: 'nova', messages })
const OWN_Q = { id: 'o1', direction: 'outbound', body: 'Hi Frank, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Larkspur Ter?', at: ago(50) }
const thread = (reply, { question = OWN_Q, at = ago(1) } = {}) => [...(question ? [question] : []), { id: 'i1', direction: 'inbound', body: reply, at }]
const own = (reply, o) => buildCanonicalLedger({ messages: thread(reply, o), now: NOW }).facts.ownership
const tl = (reply, o) => buildCanonicalLedger({ messages: thread(reply, o), now: NOW }).facts.timeline

test('ownership: casual "still" answers to OUR ownership question are the seller\'s claim', () => {
  for (const reply of ['Yes still mine. I see you say AI. Does a real person ever read what I write back?', 'Still own it. Got renters in there tho and they are late EVERY month.', 'yep still ours', 'Still have it, why', 'yes its still mine', 'yep thats us', "it's ours, why"]) {
    const f = own(reply)
    assert.equal(f?.value, 'confirmed', reply)
    assert.equal(f.basis, 'stated', reply)
    assert.match(f.origin, /^seller_/, `${reply}: recorded as the seller's claim, not verified ownership`)
  }
})

test('ownership: the limits (no question asked, a question back, a third party, a denial or sale)', () => {
  assert.equal(own('still mine', { question: null })?.value ?? null, null, 'a free-standing "still mine" with no ownership question asked is not read as an answer')
  for (const reply of ['still mine?', 'Still own it? who is this', 'My mom still owns it', 'not still mine', 'Still had it till last year', 'my brother still has it']) {
    assert.notEqual(own(reply)?.value, 'confirmed', reply)
    assert.equal(OWN_ANSWER_STILL_RE.test(reply), false, reply)
  }
  assert.equal(own('Still own it until Friday, we sold it, closing this week')?.value, 'former_owner', 'a sale in the same message wins (deny/former rules run first)')
  assert.equal(own('That is not mine, wrong number')?.value, 'denied')
})

test('ownership: the per-property recontact guard reads the same answer for THIS property', () => {
  const messages = [{ ...OWN_Q, property_id: 'p1' }, { id: 'i1', direction: 'inbound', body: 'Yes still mine', at: ago(1), property_id: null }]
  const items = ownershipEvidenceItems({ messages, properties: [{ property_id: 'p1', address: '12 Larkspur Ter' }] })
  assert.deepEqual(items.map((i) => [i.property, i.state, i.basis]), [['p1', 'confirmed', 'still_owns_to_ownership_question']])
})

test('ownership: "Thanks for confirming…" is accepted after a casual confirmation and refused without one', () => {
  const ok = v('Thanks for confirming, Frank. What has you thinking about selling?', thread('Yes still mine'))
  assert.deepEqual(ok.reasons.filter((r) => /ownership|confirmation/.test(r)), [], JSON.stringify(ok.reasons))
  const no = v('Thanks for confirming, Frank. What has you thinking about selling?', thread('who is this?'))
  assert.ok(no.reasons.some((r) => /unsupported_(?:claim:ownership|confirmation_claim)/.test(r)), JSON.stringify(no.reasons))
})

test('timeline: dated and seasonal statements are kept as the seller said them, with no urgency', () => {
  const cases = [
    ['Are you still interested? I might sell this winter if the price is fair.', 'season:winter', { from: '2026-12', to: '2027-02' }],
    ['By December', 'month:december', { from: '2026-12', to: '2026-12' }],
    ['In the spring maybe', 'season:spring', { from: '2027-03', to: '2027-05' }],
    ['probably sometime in March', 'month:march', { from: '2027-03', to: '2027-03' }],
    ['after school is out', 'school_year_end', null],
  ]
  for (const [reply, key, period] of cases) {
    const f = tl(reply)
    assert.ok(f, reply)
    assert.equal(f.basis, 'stated', reply)
    assert.equal(f.value.urgency, null, `${reply}: a stated timeline is never an urgency`)
    const ref = f.value.references.find((r) => r.key === key)
    assert.ok(ref, `${reply} → ${key}`)
    assert.deepEqual(ref.period, period, reply)
    if (ref.period) assert.doesNotMatch(JSON.stringify(ref.period), /-\d{2}-\d{2}/, 'never a day')
  }
})

test('timeline: never urgent in LeadCommand\'s own extractor either', () => {
  for (const t of ['I might sell this winter', 'By December', 'In the spring']) {
    const u = extractSellerFacts({ message: t }).facts?.timeline?.value?.urgency ?? null
    assert.ok(u === null || u === 'long_term', `${t}: ${u}`)
  }
})

test('timeline: resolution needs the message time; month edges need the time zone; ambiguity is kept', () => {
  assert.deepEqual(resolveTimeReference({ key: 'month:december', relation: 'by' }, { saidAt: null }), { period: null, ambiguous: false, basis: 'no_message_timestamp' })
  // 08:00 UTC on Nov 1 is still October in Honolulu but November in New York: without a zone the month is unknown
  assert.equal(resolveTimeReference({ key: 'month:october', relation: 'by' }, { saidAt: '2026-11-01T08:00:00Z' }).period, null)
  assert.deepEqual(resolveTimeReference({ key: 'month:october', relation: 'by' }, { saidAt: '2026-11-01T08:00:00Z', timeZone: 'Pacific/Honolulu' }).period, { from: '2026-10', to: '2026-10' })
  assert.deepEqual(resolveTimeReference({ key: 'month:october', relation: 'by' }, { saidAt: '2026-11-01T08:00:00Z', timeZone: 'America/New_York' }).period, { from: '2027-10', to: '2027-10' })
  assert.equal(resolveTimeReference({ key: 'month:december', relation: 'in', year: 2019 }, { saidAt: NOW }).past, true, 'a stated past year is not a timeline')
  const next = resolveTimeReference({ key: 'season:winter', relation: 'next' }, { saidAt: NOW })
  assert.equal(next.ambiguous, true, '"next winter" said in October: the coming winter or the one after')
  assert.deepEqual([next.period, next.alternatives], [{ from: '2026-12', to: '2027-02' }, [{ from: '2027-12', to: '2028-02' }]])
  assert.deepEqual(resolveTimeReference({ key: 'season:winter', relation: 'this' }, { saidAt: '2027-01-15T18:00:00Z' }).period, { from: '2026-12', to: '2027-02' }, 'in January "this winter" is the current one')
})

test('timeline: past contexts, names and other words are not a seller timeline', () => {
  assert.equal(sellerTimelineMentions('get back to me in the spring')[0]?.key, 'season:spring', '"get back to me in the spring" is a timeline')
  assert.equal(tl('back in December 2019 the roof was redone')?.value ?? null, null)
  for (const t of ['We bought it last winter', 'lived here since March', 'Hi Summer here', 'the roof could fall in', 'I may sell', 'we march on']) assert.deepEqual(sellerTimelineMentions(t), [], t)
  assert.equal(tl('We bought it last winter')?.value ?? null, null)
  assert.deepEqual(timeReferencesIn('the roof could fall in'), [], 'the shared stale-time reader is unchanged')
})

test('timeline: "thanks for letting me know about this winter" is accepted only when the seller said it', () => {
  const body = 'Yes, still interested, and thanks for letting me know about this winter, Dana. Do you have a price in mind that would make it worth it for you?'
  const said = v(body, thread('Are you still interested? I might sell this winter if the price is fair.'))
  assert.deepEqual(said.reasons.filter((r) => /timeline/.test(r)), [], JSON.stringify(said.reasons))
  const notSaid = v(body, thread('Are you still interested? Depends on the price.'))
  assert.ok(notSaid.reasons.some((r) => /unsupported_claim:timeline/.test(r)), JSON.stringify(notSaid.reasons))
})

test('re-engagement: recalling WHEN the seller asked to be contacted is allowed after it passed; other uses are not', () => {
  const old = [{ id: 'o1', direction: 'outbound', body: 'Hi Jerome, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Quarry Ridge Rd?', at: ago(7000) },
    { id: 'i1', direction: 'inbound', body: 'ya. roof leaks and the back porch is rotting. hit me up after the holidays', at: ago(6990) },
    { id: 'o2', direction: 'outbound', body: 'Will do, Jerome. Thanks for the info.', at: ago(6989) }]
  assert.deepEqual(staleSellerTimeReasons('Hi Jerome, Nova with Reivesti Home Buyers again. You mentioned checking back after the holidays. Would you ever think about selling?', { thread: old, now: NOW }), [])
  assert.ok(staleSellerTimeReasons('Are you still planning to sell after the holidays?', { thread: old, now: NOW }).includes('timing:seller_time_reference_passed'))
  const r = v('Hi Jerome, Nova with Reivesti Home Buyers again. You mentioned checking back after the holidays. Would you ever think about selling the house on Quarry Ridge Rd? No pressure either way.', old)
  assert.deepEqual(r.reasons.filter((x) => /attribution|timing/.test(x)), [], JSON.stringify(r.reasons))
})

test('nothing here weakens opt-out, suppression or identity enforcement', () => {
  const stop = v('Thanks for confirming. What has you thinking about selling?', thread('Still own it. Stop texting me'))
  assert.equal(stop.code, 'STOP_REQUESTED')
  assert.ok(buildCanonicalLedger({ messages: thread('Still own it. Stop texting me'), now: NOW }).facts.opt_out)
  const spanish = v('Thanks for confirming. What has you thinking about selling?', thread('Sí, todavía es mía. Pare por favor'))
  assert.equal(spanish.ok, false)
  const bot = v('Thanks for confirming. What has you thinking about selling?', thread('yes still mine. are you a bot?'))
  assert.ok(bot.reasons.includes('identity:automation_question_unanswered'), JSON.stringify(bot.reasons))
  const wrong = v('Thanks for confirming. What has you thinking about selling?', thread('wrong number, still mine is not a thing lol'))
  assert.equal(wrong.ok, false)
})
