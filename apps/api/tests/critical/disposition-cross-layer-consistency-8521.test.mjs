// rc-8.5.21 FINAL directive, phase 5 — CROSS-LAYER DISPOSITION CONSISTENCY. The same seller reply, in the same
// conversation, means the SAME thing to every layer:
//   classifier   buildConversationContext (our question(s) before the reply) → classify (heuristic)
//   ledger       the AI fact ledger + per-property ownership facts + the deterministic pre-check
//   scheduler    resolveFollowUpPlan / followUpKindFor + the lifecycle's property × contact block
//   dispatcher   the send-time contact guard over the thread's own messages
// Locked owner rules: a bare "No" to an identifiable ownership question is a PROPERTY DENIAL; "No thanks" /
// "Not interested" to it is declined_unverified (no nurture); "Not interested" to the SELLING question is
// the 30-day nurture; "My husband wants to keep it" is a nurture; one "No" after ownership questions about
// several properties is a THREAD HOLD; STOP is contact-wide suppression; a call request is a callback task,
// never an opt-out; "Are you a realtor?" is a question; an offer request before a price is asked once, then
// researched, never priced; Spanish is preserved; Creole is held. Pure (no I/O).
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConversationContext } from '../../src/lib/domain/classification/build-conversation-context.js'
import { classify } from '../../src/lib/domain/classification/classify.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { attributeInbounds } from '../../src/lib/domain/conversation-ai/property-facts.js'
import { propertyOwnershipFacts } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { languageEnabledFor } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { resolveFollowUpPlan } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'
import { followUpKindFor, propertyContactBlock } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { evaluateSendTimeContactGuard, SEND_TIME_GUARD_REASONS as R } from '../../src/lib/domain/queue/send-time-contact-guard.js'

const PHONE = '+13125550111'
const OURS = '+13125550199'
const T0 = Date.parse('2026-10-20T15:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const PROPS = [{ property_id: 'p1', address: '12 Oak St' }, { property_id: 'p2', address: '456 Pine St' }]

/** our outbound question(s), then the seller's reply (the latest message) */
function thread(outs, reply) {
  const msgs = outs.map((o, i) => ({ id: `o${i}`, direction: 'outbound', body: o.body, message_body: o.body, at: iso(T0 - (outs.length - i) * 5 * 60_000), created_at: iso(T0 - (outs.length - i) * 5 * 60_000), property_id: o.property || 'p1', use_case: o.use_case || null }))
  msgs.push({ id: 'in1', direction: 'inbound', body: reply, message_body: reply, at: iso(T0), created_at: iso(T0), property_id: outs[outs.length - 1].property || 'p1' })
  return msgs
}

/** the classifier's context over the same outbound rows (send_queue shape, newest first) */
async function classifierContext(outs) {
  const rows = outs.map((o, i) => ({ id: `q${i}`, message_type: null, message_body: o.body, template_id: null, property_id: o.property || 'p1', provider_message_id: null,
    sent_at: iso(T0 - (outs.length - i) * 5 * 60_000), delivered_at: iso(T0 - (outs.length - i) * 5 * 60_000 + 5_000), queue_status: 'delivered' })).reverse()
  const make = (data) => { const b = { select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, limit: async () => ({ data, error: null }) }; return b }
  const supabase = { from: (t) => make(t === 'send_queue' ? rows : []) }
  return buildConversationContext({ thread_key: PHONE, inbound_received_at: iso(T0), supabase })
}

async function layers(outs, reply, { kind = 'not_interested_nurture' } = {}) {
  const msgs = thread(outs, reply)
  const ctx = await classifierContext(outs)
  const cls = await classify(reply, null, { heuristicOnly: true, conversation_context: ctx })
  const att = attributeInbounds({ messages: msgs, properties: PROPS, questionKindOf }).get('in1')
  const po = propertyOwnershipFacts({ messages: msgs, properties: PROPS, inboundId: 'in1', inboundPropertyId: 'p1' })
  const pre = deterministicPrecheck({ text: reply, inboundId: 'in1', deterministic: { intent: cls.primary_intent }, lastQuestionKind: att?.last_question_kind || null, ownershipAmbiguous: att?.ambiguous === true && !att?.clauses?.length })
  const plan = resolveFollowUpPlan(cls.primary_intent, { thread_key: PHONE })
  const block = propertyContactBlock({ property_id: 'p1', phone: PHONE, thread: { thread_key: PHONE, property_id: 'p1' }, resolutions: [], kind, messages: msgs })
  const guardFor = (pid) => evaluateSendTimeContactGuard({ to_phone_number: PHONE, thread_key: PHONE, from_phone_number: OURS, property_id: pid, use_case_template: 'follow_up', metadata: {} },
    { thread_messages: msgs, ...(cls.primary_intent === 'opt_out' ? { suppressions: [{ phone_e164: PHONE, is_active: true, suppression_type: 'opt_out' }] } : {}) }, { now: T0 + 60_000 })
  return { ctx, cls, att, po, pre, plan, block, guard1: guardFor('p1'), guard2: guardFor('p2') }
}

const OWN_Q = { body: 'Hi Dana, this is Helen. Do you still own 12 Oak St?', property: 'p1' }
const SELL_Q = { body: 'Thanks Dana. Would you consider selling 12 Oak St?', property: 'p1' }

test('a bare "No" to an identifiable ownership question ⇒ a PROPERTY DENIAL in every layer (that property only)', async () => {
  const L = await layers([OWN_Q], 'No')
  assert.equal(L.ctx.last_outbound_question_type, 'ownership')
  assert.ok(['property_specific_non_owner', 'ownership_denied'].includes(L.cls.primary_intent), `classifier ${L.cls.primary_intent}`)
  assert.deepEqual([L.att.property, L.att.ambiguous], ['p1', false])
  assert.equal(L.po.by_property.p1.state, 'denied')
  assert.equal(L.po.thread_hold, false)
  assert.deepEqual([L.pre.decided, L.pre.reason], [true, 'ownership_denied'])
  assert.deepEqual([L.block.blocked, L.block.state], [true, 'not_executable'])
  assert.match(L.block.reason, /property_denial/)
  assert.equal(L.guard1.blocked, true, 'the dispatcher refuses that property')
  assert.equal(L.guard2.blocked, false, 'never another property')
})

test('"No thanks" / "Not interested" to the ownership question ⇒ declined_unverified: no nurture, a property hold, never a denial or a suppression', async () => {
  for (const reply of ['No thanks', 'Not interested']) {
    const L = await layers([OWN_Q], reply)
    assert.equal(L.cls.primary_intent, 'ownership_declined_unverified', `${reply}: classifier ${L.cls.primary_intent}`)
    assert.notEqual(L.po.by_property.p1.state, 'denied', `${reply}: never recorded as a denial`)
    assert.equal(L.pre.decision?.outcome === 'SUPPRESS', false)
    assert.deepEqual([L.block.blocked, L.block.state], [true, 'held'], `${reply}: ${JSON.stringify(L.block)}`)
    assert.match(L.block.reason, /declined_unverified/)
    assert.equal(L.guard1.reason, R.OWNERSHIP_DECLINED_HOLD, `${reply}: dispatcher ${L.guard1.reason}`)
    assert.equal(L.guard2.blocked, false)
  }
})

test('"Not interested" to the SELLING question ⇒ the 30-day nurture in every layer (never suppressed, never a denial)', async () => {
  const L = await layers([OWN_Q, SELL_Q], 'Not interested')
  assert.equal(L.cls.primary_intent, 'not_interested')
  assert.equal(L.plan.suppressed, false)
  assert.equal(L.plan.followup_created, true)
  assert.equal(L.plan.nurture_days ?? L.plan.days ?? 30, 30)
  assert.equal(followUpKindFor('not_interested', {}), 'not_interested_nurture')
  assert.equal(L.block.blocked, false, JSON.stringify(L.block))
  assert.equal(L.guard1.blocked, false)
})

test('"My husband wants to keep it" ⇒ a nurture (a selling answer, to the selling OR the ownership question)', async () => {
  for (const outs of [[OWN_Q, SELL_Q], [OWN_Q]]) {
    const L = await layers(outs, 'My husband wants to keep it')
    assert.notEqual(L.cls.primary_intent, 'opt_out')
    assert.ok(!['property_specific_non_owner', 'ownership_denied', 'wrong_number'].includes(L.cls.primary_intent), `classifier ${L.cls.primary_intent}`)
    assert.equal(L.plan.suppressed, false)
    assert.equal(L.block.blocked, false, `${outs.length}: ${JSON.stringify(L.block)}`)
    assert.equal(L.guard1.blocked, false)
  }
})

test('an ambiguous multi-property "No" (one message naming both, or SEPARATE questions) ⇒ a THREAD HOLD in every layer', async () => {
  const intents = []
  for (const outs of [[{ body: 'Hi Dana, this is Helen. Do you still own 12 Oak St or 456 Pine St?', property: 'p1' }], [OWN_Q, { body: 'And how about 456 Pine St?', property: 'p2' }]]) {
    const L = await layers(outs, 'No')
    // the classifier reads the reply against an OWNERSHIP question in both shapes (the follow-up fragment
    // continues the question before it) and labels it identically
    assert.equal(L.ctx.last_outbound_question_type, 'ownership', JSON.stringify(L.ctx.last_outbound_use_case))
    intents.push(L.cls.primary_intent)
    assert.equal(L.att.ambiguous, true, JSON.stringify(L.att))
    assert.equal(L.att.property, '')
    assert.equal(L.po.thread_hold, true)
    assert.notEqual(L.po.by_property.p1?.state, 'denied', 'never a denial of either property')
    assert.notEqual(L.po.by_property.p2?.state, 'denied')
    assert.notEqual(L.pre.reason, 'ownership_denied', `pre-check ${L.pre.reason}`)
    assert.deepEqual([L.block.blocked, L.block.state, L.block.reason], [true, 'held', 'ownership_denial_property_unresolved'])
    assert.equal(L.guard1.reason, R.OWNERSHIP_UNRESOLVED_HOLD, `dispatcher ${L.guard1.reason}`)
    assert.equal(L.guard2.reason, R.OWNERSHIP_UNRESOLVED_HOLD, 'the hold is thread-wide')
  }
  assert.equal(intents[0], intents[1], `identical classification in both shapes: ${JSON.stringify(intents)}`)
})

test('STOP ⇒ contact-wide suppression in every layer', async () => {
  const L = await layers([OWN_Q], 'STOP')
  assert.equal(L.cls.primary_intent, 'opt_out')
  assert.equal(L.pre.decision.outcome, 'SUPPRESS')
  assert.equal(L.plan.suppressed, true)
  assert.equal(L.guard1.blocked, true)
  assert.equal(L.guard2.blocked, true, 'every property')
})

test('a call request ⇒ a callback task, never an opt-out', async () => {
  const L = await layers([OWN_Q, SELL_Q], 'Can you call me tomorrow afternoon?')
  assert.notEqual(L.cls.primary_intent, 'opt_out')
  assert.ok(/callback|call/.test(L.cls.primary_intent), `classifier ${L.cls.primary_intent}`)
  assert.notEqual(L.pre.decision?.outcome, 'SUPPRESS')
  assert.notEqual(L.plan.suppressed, true)
  assert.equal(L.guard1.blocked, false)
})

test('"Are you a realtor?" ⇒ a question (identity), never an ownership answer or an opt-out', async () => {
  const L = await layers([OWN_Q], 'Are you a realtor?')
  assert.ok(!['opt_out', 'property_specific_non_owner', 'ownership_denied', 'ownership_declined_unverified', 'not_interested'].includes(L.cls.primary_intent), `classifier ${L.cls.primary_intent}`)
  assert.equal(L.pre.decided, false)
  assert.notEqual(L.po.by_property.p1.state, 'denied')
  assert.equal(L.guard1.blocked, false)
})

test('an offer request before a price ⇒ asked ONCE for their number, then researched — never a price in the text', async () => {
  const L = await layers([OWN_Q], 'What would you offer for it?')
  assert.equal(L.cls.primary_intent, 'asks_offer')
  assert.notEqual(L.pre.decision?.outcome, 'SUPPRESS')
  // the text authority: an AI draft never states an amount
  const v = validateOutbound('We could do $95,000 cash for 12 Oak St.', { ledger: { last_message: { id: 'in1', direction: 'inbound' }, requests: [], facts: {} } })
  assert.ok(v.content_reasons.some((r) => /amount|money|price|content:/.test(r)), JSON.stringify(v.content_reasons))
})

test('Spanish is preserved (the reply language is Spanish, never an English fallback); Creole is held', async () => {
  const es = await layers([OWN_Q], 'No me interesa vender, gracias')
  assert.match(String(es.cls.language), /spanish/i)
  const le = languageEnabledFor({ language: es.cls.language, inboundText: 'No me interesa vender, gracias', languages: ['en', 'es'] })
  assert.deepEqual([le.language, le.enabled], ['es', true])
  const ht = 'Mwen pa vle vann kay la, mèsi'
  const cr = languageEnabledFor({ language: null, inboundText: ht, languages: ['en', 'es'] })
  assert.equal(cr.enabled, false, `Creole is not an enabled reply language: ${JSON.stringify(cr)}`)
  assert.notEqual(cr.language, 'en', 'never read as English')
})
