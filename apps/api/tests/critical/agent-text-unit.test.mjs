// queue_agent_text (link #32, owner architecture correction 2026-10-29: "Agntei owns the intelligence and conversation.
// LeadCommand owns messaging infrastructure and compliance enforcement. The carrier delivers the SMS."): the pure,
// model-free pieces — the deterministic validator, the purpose rules, the transport's shared content rules (and the real
// TextGrid client on a stubbed fetch), the agent-text row gate, the stand-down of LeadCommand's own engine on an
// agent-held lead, the carrier-verdict writer, the production receipt sweep, and that nothing on the agent path can
// construct a model client.
import '../helpers/critical-test-environment.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { agentTextPurposeVerdict, agentTextScopeVerdict, agentTextCapVerdict, DEFAULT_AGENT_TEXT_POLICY, AGENT_TEXT_PURPOSES } from '../../src/lib/domain/outreach/agent-text.js'
import { transportContentReasons, TEXTGRID_BLANK_GREETING_RE, TEXTGRID_UNRESOLVED_PLACEHOLDER_RE, RUNNER_BLANK_GREETING_GUARD_RE, RUNNER_BLANK_GREETING_INLINE_RE } from '../../src/lib/domain/messaging/transport-content-rules.js'
import { sendTextgridSMS } from '../../src/lib/providers/textgrid.js'
import { resetTextgridConfigCache } from '../../src/lib/config/textgrid-config.js'
import { evaluateAgentTextRowGate } from '../../src/lib/domain/queue/agent-text-row-gate.js'
import { evaluateAiConversationRowGate } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { buildAgentTextMessage, buildAiGeneratedMessage, sha256Hex } from '../../src/lib/domain/messages/ai-generated-message.js'
import { standDownDecider, AGENT_HELD_STAND_DOWN } from '../../src/lib/ai/agent-lead-stand-down.js'
import { createConversationDecideHandler } from '../../src/lib/ai/conversation-decide-handler.js'
import { recordAgentDeliveryVerdict } from '../../src/lib/domain/outreach/lead-events.js'
import { actionGatewayRuntimeMaintenance, __resetReceiptSweepThrottleForTests } from '../../src/lib/ai/action-gateway-execution.js'
import { validateSchema } from '../../src/lib/agent/tools/schema.js'
import { QUEUE_AGENT_TEXT_SPEC } from '../../src/lib/domain/action-gateway/actions/agent-text/index.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib')
const CI = normalizeCompanyIdentity({ name: 'Reivesti Home Buyers', human_review: false, persona_descriptor: null })
const NOW = '2026-10-29T18:00:00.000Z'
const ago = (h) => new Date(Date.parse(NOW) - h * 3600e3).toISOString()
const POLICY = { ...DEFAULT_AGENT_TEXT_POLICY }
const v = (body, o) => validateAgentText(body, { companyIdentity: CI, now: NOW, policy: POLICY, authorEmployee: 'nova', ...o })
const ROOF = [{ id: 'o1', direction: 'outbound', body: 'Hi Dana, this is Helen. Do you still own the house on Marigold Ln?', at: ago(50) },
  { id: 'i1', direction: 'inbound', body: 'Yes I still own it. The roof needs some work though, is that a problem for you?', at: ago(48) }]
const PRICE = [{ id: 'o1', direction: 'outbound', body: 'Hi Ray, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Cedar St?', at: ago(50) },
  { id: 'i1', direction: 'inbound', body: 'Yes. I would want 250k for it', at: ago(1) }]
const BOT = [{ id: 'o1', direction: 'outbound', body: 'Hi, do you still own the house?', at: ago(50) }, { id: 'i1', direction: 'inbound', body: 'Are you a bot or a real person?', at: ago(1) }]

test('validator: the agent\'s honest, ordinary texts pass — an AI-assistant first touch naming the configured company, an answer about the roof, an answer to a stated price, a question about other offers or the seller\'s own price', () => {
  for (const [body, o] of [
    ['Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Kapiolani Blvd?', { purpose: 'first_touch', messages: [] }],
    ['Thanks for letting me know about the roof, that is not a problem for us. When would you ideally want to sell?', { purpose: 'reply', messages: ROOF, authorEmployee: 'sterling' }],
    ['Thanks for telling me what you have in mind, I have noted it. What timeline would work best for you?', { purpose: 'reply', messages: PRICE }],
    ['I am an AI assistant with Reivesti Home Buyers, writing for Nova. Would you consider selling the house?', { purpose: 'reply', messages: BOT }],
    // asking about other offers, or saying plainly what cannot be done, implies nothing will follow
    ['Thanks for letting me know about the roof. Have you had any other offers on it yet?', { purpose: 'reply', messages: ROOF }],
    ['Thanks for letting me know about the roof. Do you have a price in mind that would make selling worth it?', { purpose: 'reply', messages: ROOF }],
  ]) {
    const r = v(body, o)
    assert.deepEqual([r.ok, r.code, r.reasons], [true, null, []], `${body}: ${JSON.stringify(r)}`)
  }
})

test('validator: every refusal names its rule — money, human claim, the unanswered bot question, two questions, a link, an invented acknowledgement, a no-contact promise, a placeholder, a STOP, a non-owner, length, a dash', () => {
  const cases = [
    ['We could pay $150,000 cash for it. Would that work?', { purpose: 'negotiation', messages: PRICE }, 'MONEY_NOT_AUTHORIZED', 'money:no_negotiation_authority_for_this_lead'],
    ['I am a real person, not a bot. Would you consider selling?', { purpose: 'reply', messages: BOT }, 'CONTENT_REJECTED', 'persona:denies_automation'],
    ['Good question. Would you consider selling the house?', { purpose: 'reply', messages: BOT }, 'CONTENT_REJECTED', 'identity:automation_question_unanswered'],
    ['Do you own it? Would you sell?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'content:more_than_one_question'],
    ['See https://example.com for details. Do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'content:contains_link'],
    ['Thanks for getting back to me. Do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'thread:acknowledges_reply_seller_never_sent'],
    ['Understood, we will not contact you again.', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'claim:no_further_contact_while_nurture_scheduled'],
    ['Hi {{seller_first_name}}, do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'transport:unresolved_placeholder'],
    ['Sorry to bother you.', { purpose: 'reply', messages: [...ROOF, { id: 'i2', direction: 'inbound', body: 'ALTO', at: ago(0.1) }] }, 'STOP_REQUESTED', 'inbound:opt_out'],
    ['Would your landlord consider selling?', { purpose: 'reply', messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, do you own the house?', at: ago(5) }, { id: 'i1', direction: 'inbound', body: 'No, I rent here. My landlord owns it.', at: ago(1) }] }, null, 'non_owner:reply_to_non_owner_contact'],
    ['A person on our team reads every message. Do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'identity:human_review_claim_not_configured'],
    [`Do you still own it? ${'a'.repeat(320)}`, { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'length:over_320_characters'],
    ['Do you still own it — the house?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'style:em_or_en_dash'],
    ['test', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'content:not_a_message'],
    ['placeholder', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'content:not_a_message'],
    ['Sorry, that last text was sent by mistake, please ignore it.', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'content:correction_of_earlier_text'],
    ['We buy houses as-is, so no repairs needed. Do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'identity:company_practice_not_configured:as_is'],
    ['We can close on your timeline with no fees. Do you still own it?', { purpose: 'first_touch', messages: [] }, 'CONTENT_REJECTED', 'identity:company_practice_not_configured:flexible_close'],
    ['Thanks for letting me know. What is a good time to reach your mom?', { purpose: 'reply', messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, do you still own the house on Elm St?', at: ago(5) }, { id: 'i1', direction: 'inbound', body: 'You have reached her daughter. My mom takes care of the house stuff.', at: ago(1) }] }, null, 'non_owner:reply_to_non_owner_contact'],
    ['Thanks. Could you ask him to text me when he has a minute?', { purpose: 'reply', messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, do you still own the house on Elm St?', at: ago(5) }, { id: 'i1', direction: 'inbound', body: 'This is his nephew, he is not much of a texter.', at: ago(1) }] }, null, 'non_owner:asks_about_third_party_owner'],
    ['Thanks for sharing that. Once we have an offer ready, someone from our team will call you.', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_offer_review_or_call'],
    ['Good question. The team will review the property first. What timeline works for you?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_offer_review_or_call'],
    ['Thanks. I am an AI assistant, but I am passing your request to a person on the team. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_handoff_to_person'],
    ['Thanks for telling me. I will let the team know. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_handoff_to_person'],
    ['Thanks. I can\'t give a date for an offer yet. When would you ideally want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_forthcoming_offer_or_date'],
    ['Thanks. I don\'t have any numbers on the house right now. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_forthcoming_offer_or_date'],
    ['I hear you. I can\'t promise a closing date yet. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:implied_forthcoming_offer_or_date'],
    // without negotiation authority the company's offer, price, terms or dates are not discussed at all, not even declined
    ['Thanks. I can\'t give you a number or say when one would come. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:offer_price_or_terms_without_authority'],
    ['Thanks for writing back. I can\'t give an offer, a price or a closing date in this chat.', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:offer_price_or_terms_without_authority'],
    ['Thanks. I can\'t say whether moving costs would be covered. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:offer_price_or_terms_without_authority'],
    ['Thanks for the details. Would our offer work for you if it came in fair?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'commitment:offer_price_or_terms_without_authority'],
    // where the seller's number or details came from is never stated (a person answers that)
    ['Fair question. Your number is linked to the house in public property records. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'claim:data_source_not_backed'],
    ['Good question. We got your number from a list of owners in the area. When would you want to sell?', { purpose: 'reply', messages: ROOF }, 'CONTENT_REJECTED', 'claim:data_source_not_backed'],
  ]
  for (const [body, o, code, reason] of cases) {
    const r = v(body, o)
    assert.equal(r.ok, false, body)
    if (code) assert.equal(r.code, code, `${body}: ${JSON.stringify(r)}`)
    assert.ok(r.reasons.includes(reason), `${body}: ${r.reasons.join(',')}`)
  }
  // one amount, permitted by a LIVE negotiation send authorization of this lead (≤ its ceiling)
  assert.equal(v('We could do $140,000 for it. Would that work?', { purpose: 'negotiation', messages: PRICE, moneyAuthority: { ceiling: 150000 } }).ok, true)
  assert.ok(v('We could do $160,000 for it. Would that work?', { purpose: 'negotiation', messages: PRICE, moneyAuthority: { ceiling: 150000 } }).reasons.includes('money:amount_above_authorized_ceiling'))
  assert.ok(v('We could do $140,000 or $145,000. Would that work?', { purpose: 'negotiation', messages: PRICE, moneyAuthority: { ceiling: 150000 } }).reasons.includes('money:exactly_one_amount_required'))
})

test('purpose rules: an answer names the latest unanswered inbound; an initiated text answers nothing and is refused over an unanswered seller message; quiet hours; the first-touch opener rule', () => {
  const pv = (o) => agentTextPurposeVerdict({ policy: POLICY, now: NOW, messages: ROOF, ...o })
  assert.deepEqual(AGENT_TEXT_PURPOSES, ['first_touch', 'reply', 'followup', 'reengage', 'nurture', 'qualification', 'negotiation', 'appointment'])
  assert.equal(pv({ purpose: 'reply' }).code, 'IN_REPLY_TO_REQUIRED')
  for (const p of ['qualification', 'negotiation', 'appointment']) assert.equal(pv({ purpose: p }).code, 'IN_REPLY_TO_REQUIRED', p)
  assert.equal(pv({ purpose: 'reply', inReplyTo: 'o1' }).code, 'IN_REPLY_TO_NOT_LATEST_INBOUND')
  assert.equal(pv({ purpose: 'reply', inReplyTo: 'i1' }).ok, true)
  assert.equal(pv({ purpose: 'followup' }).code, 'UNANSWERED_SELLER_MESSAGE')
  assert.equal(pv({ purpose: 'followup', inReplyTo: 'i1' }).code, 'IN_REPLY_TO_NOT_ALLOWED')
  const quiet = [ROOF[0], ROOF[1], { id: 'o2', direction: 'outbound', body: 'Thanks, noted.', at: ago(30) }]
  assert.equal(pv({ purpose: 'followup', messages: quiet }).ok, true)
  assert.deepEqual([pv({ purpose: 'nurture', messages: [...quiet.slice(0, 2), { ...quiet[2], at: ago(2) }] }).code], ['FOLLOWUP_QUIET_HOURS'])
  assert.equal(pv({ purpose: 'reengage', messages: quiet }).code, 'THREAD_NOT_QUIET')
  const ready = { target_status: 'ready', routing_status: 'ready', identity_status: 'verified', suppression_status: 'clear' }
  assert.equal(pv({ purpose: 'first_touch', messages: [], target: ready }).ok, true)
  assert.equal(pv({ purpose: 'first_touch', messages: [quiet[2]], target: ready }).code, 'ALREADY_CONTACTED')
  assert.equal(pv({ purpose: 'first_touch', messages: [], target: null }).code, 'FIRST_TOUCH_REQUIRES_CAMPAIGN_TARGET')
  // the AI send scope applies only WHEN SET; caps
  assert.equal(agentTextScopeVerdict({ scope: { thread_keys: [], market_ids: [], campaign_ids: [] } }, { thread_key: '+13125550100' }), null)
  assert.equal(agentTextScopeVerdict({ scope: { thread_keys: ['+13125550199'] } }, { thread_key: '+13125550100' }).code, 'LEAD_NOT_IN_AI_SEND_SCOPE')
  assert.equal(agentTextScopeVerdict({ scope: { thread_keys: ['+13125550100'] } }, { thread_key: '+13125550100' }), null)
  assert.equal(agentTextCapVerdict({ usage: { lead_today: 0, initiated_today: 1, global_today: 0 }, policy: POLICY, purpose: 'followup' }).code, 'DAILY_INITIATED_CAP_REACHED')
  assert.equal(agentTextCapVerdict({ usage: { lead_today: 0, initiated_today: 1, global_today: 0 }, policy: POLICY, purpose: 'reply' }), null)
})

test('the input schema: exactly the shape Agntei sends (attribution session_id / model / provider / turn_id may be null; employee + route required; body 1–320)', () => {
  const ok = { client_request_id: 'agntei:abc12345', campaign_target_id: '00000000-0000-4000-8000-000000000001', purpose: 'first_touch', body: 'Hi, this is Nova. Do you still own it?',
    attribution: { employee: 'nova', model: 'claude-x', provider: 'anthropic', route: 'agntei.acquisitions', session_id: null, turn_id: 't-1' } }
  assert.deepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, ok), [])
  assert.deepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, attribution: { ...ok.attribution, model: null, provider: null, turn_id: null } }), [])
  assert.notDeepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, attribution: { employee: 'nova' } }), [])
  assert.notDeepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, attribution: { ...ok.attribution, route: null } }), [])
  assert.notDeepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, body: 'x'.repeat(321) }), [])
  assert.notDeepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, body: '' }), [])
  assert.notDeepEqual(validateSchema(QUEUE_AGENT_TEXT_SPEC.input, { ...ok, to_phone_number: '+13125550100' }), [], 'the agent never names a number')
  assert.deepEqual([QUEUE_AGENT_TEXT_SPEC.verbatim_keys, QUEUE_AGENT_TEXT_SPEC.idempotency_conflict_code, QUEUE_AGENT_TEXT_SPEC.standing_reply], [['attribution'], 'IDEMPOTENCY_CONFLICT', true])
})

test('transport: ONE set of content rules — the TextGrid client and the queue runner import them; the agent-text profile (an exact, verified agent text) is never refused for a greeting, the placeholder rule always applies', async () => {
  // the transport's own literals ARE the shared module's (the validator applies exactly what the client / runner apply)
  const provider = fs.readFileSync(path.join(SRC, 'providers/textgrid.js'), 'utf8')
  const runner = fs.readFileSync(path.join(SRC, 'domain/queue/process-send-queue.js'), 'utf8')
  assert.ok(provider.includes(`const BLANK_GREETING_RE = ${TEXTGRID_BLANK_GREETING_RE.toString()};`))
  assert.ok(provider.includes(`const UNRESOLVED_PLACEHOLDER_RE = ${TEXTGRID_UNRESOLVED_PLACEHOLDER_RE.toString()};`))
  assert.ok(runner.includes(`const BLANK_GREETING_GUARD_RE = ${RUNNER_BLANK_GREETING_GUARD_RE.toString()};`))
  assert.ok(runner.includes(`const BLANK_GREETING_INLINE_RE = ${RUNNER_BLANK_GREETING_INLINE_RE.toString()};`))
  for (const src of [provider, runner]) assert.match(src, /appliesBlankGreetingRule\(/)
  assert.ok(TEXTGRID_BLANK_GREETING_RE.test('ok so hi, there'), 'the client rule: case-insensitive, anywhere')
  assert.ok(TEXTGRID_UNRESOLVED_PLACEHOLDER_RE.test('Hi [[seller_first_name]],'))
  assert.deepEqual(transportContentReasons('Hi, this is Nova. Do you still own it?'), ['transport:blank_greeting_pattern'])
  assert.deepEqual(transportContentReasons('Hi, this is Nova. Do you still own it?', { profile: 'agent_text' }), [])
  assert.deepEqual(transportContentReasons('Hi {{name}}, still own it?', { profile: 'agent_text' }), ['transport:unresolved_placeholder'])
  // the REAL client on a stubbed fetch: the exact agent text crosses; a rendered body with the same greeting does not
  const original = { ...process.env }
  const fetch0 = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: String(init?.body || '') }); return { status: 201, ok: true, text: async () => JSON.stringify({ sid: 'SM0123456789abcdef012345678', status: 'queued' }) } }
  process.env.TEXTGRID_ACCOUNT_SID = 'AC_test_account'
  process.env.TEXTGRID_AUTH_TOKEN = 'test_token'
  resetTextgridConfigCache()
  try {
    const body = 'Hi, this is Nova, an AI assistant with Reivesti Home Buyers. Do you still own the house on Kapiolani Blvd?'
    const sent = await sendTextgridSMS({ to: '+15550000000', from: '+15550000001', body, bypass_system_control: true, agent_text_exact_body: true })
    assert.ok(sent && calls.length === 1, JSON.stringify(sent))
    let refused = null
    try { await sendTextgridSMS({ to: '+15550000000', from: '+15550000001', body, bypass_system_control: true }) } catch (e) { refused = e }
    assert.equal(refused?.local_refusal_reason, 'blank_seller_greeting')
    refused = null
    try { await sendTextgridSMS({ to: '+15550000000', from: '+15550000001', body: 'Hi {{seller_first_name}}, still own it?', bypass_system_control: true, agent_text_exact_body: true }) } catch (e) { refused = e }
    assert.equal(refused?.local_refusal_reason, 'unresolved_placeholder')
    assert.equal(calls.length, 1)
    // the validator refuses at request time exactly what the client would (a placeholder), and lets through what it sends
    assert.equal(v(body, { purpose: 'first_touch', messages: [] }).ok, true)
  } finally {
    globalThis.fetch = fetch0
    process.env = original
    resetTextgridConfigCache()
  }
})

// ── the agent-text row gate ──────────────────────────────────────────────────
const INTENT = '11111111-2222-4333-8444-555555555555'
const PHONE = '+13125550171'
function agentRow({ body = 'Hi, this is Nova. Do you still own it?', purpose = 'first_touch', inReplyTo = null, inboundAt = null, generatedAt = ago(0.1) } = {}) {
  const rec = { id: 'rec-1', ...buildAgentTextMessage({ intentId: INTENT, purpose, body, inReplyTo, attribution: { employee: 'nova', route: 'agntei.acq' }, threadKey: PHONE, recipientPhone: PHONE, senderPhone: '+13125550199',
    decisionId: `action_gateway:${INTENT}`, contextVersion: 'agent-text.v1', validation: { status: 'validated' }, ledgerSnapshot: {}, policy: {}, generatedAt }) }
  const row = { id: 'q1', queue_key: `agent_text:${INTENT}`, message_body: body, to_phone_number: PHONE, thread_key: PHONE, message_origin: 'ai_generated', source: 'ai_conversation', created_at: generatedAt,
    metadata: { agent_text_intent_id: INTENT, agent_id: 'agt_nova', source: 'ai_conversation', message_origin: 'ai_generated', ai_message_id: 'rec-1', ai_message_body_sha256: sha256Hex(body), recipient_zones: ['America/Chicago'],
      agent_text: { purpose, generated_at: generatedAt, in_reply_to_message_id: inReplyTo, inbound_received_at: inboundAt } } }
  return { rec, row }
}
const LAWFUL = '2026-10-29T17:00:00.000Z' // 12:00 Chicago
const gate = (row, rec, o = {}) => evaluateAgentTextRowGate(row, { now: LAWFUL, readActivation: async () => ({ available: true }), loadRecord: async () => ({ record: rec }), readHolder: async () => ({ agent_id: 'agt_nova' }), loadInbounds: async () => ({ rows: [] }), automationHoldChecker: async () => ({ held: false }), ...o })

test('agent-text row gate: its OWN switch (never the reply engine\'s), the body = its ledger record, the author still holds the lead, staleness, the window; the AI reply gate skips these rows', async () => {
  const { rec, row } = agentRow()
  assert.deepEqual([(await gate(row, rec)).action], ['proceed'])
  assert.deepEqual(await evaluateAiConversationRowGate(row, { readSwitch: async () => null }), { applies: false }, 'ai_conversation_send_enabled never decides an agent text')
  assert.equal((await gate(row, rec, { readActivation: async () => ({ available: false, code: 'AGENT_TEXT_KILL_SWITCH_OFF' }) })).reason, 'agent_text_unavailable_at_send:agent_text_kill_switch_off')
  assert.equal((await gate(row, rec, { readActivation: async () => ({ available: false, code: 'EMERGENCY_STOP_ACTIVE' }) })).action, 'cancel')
  assert.equal((await gate(row, rec, { readActivation: async () => ({ read_failed: true }) })).action, 'defer')
  assert.equal((await gate({ ...row, message_body: 'Hi, this is Nova. Do you still own it? Call me.' }, rec)).reason, 'ai_generated_body_mismatch')
  assert.equal((await gate(row, null, { loadRecord: async () => ({ record: null }) })).reason, 'ai_generated_record_not_found')
  assert.equal((await gate(row, rec, { readHolder: async () => ({ agent_id: 'agt_sterling' }) })).reason, 'agent_text_author_no_longer_holds_lead')
  assert.equal((await gate(row, rec, { readHolder: async () => ({ agent_id: null }) })).reason, 'agent_text_author_no_longer_holds_lead')
  assert.equal((await gate(row, rec, { loadInbounds: async () => ({ rows: [{ id: 'new-1' }] }) })).reason, 'agent_text_stale_new_inbound')
  const night = await gate(row, rec, { now: '2026-10-29T08:00:00.000Z' }) // 03:00 Chicago
  assert.deepEqual([night.action, night.reason, Date.parse(night.next_permitted_at) > Date.parse('2026-10-29T08:00:00.000Z')], ['cancel', 'agent_text_outside_recipient_window_at_send', true])
  // an answer: bound to ITS inbound; the record must name it
  const a = agentRow({ purpose: 'reply', inReplyTo: 'in-9', inboundAt: ago(0.2) })
  assert.equal((await gate(a.row, a.rec)).action, 'proceed')
  assert.equal((await gate(a.row, { ...a.rec, inbound_message_id: 'in-8' })).reason, 'agent_text_record_not_bound_to_its_inbound')
})

test('NO SECOND AI ENGINE: on an agent-held lead the AI reply row is cancelled, the turn decider and the decide job make NO model decision; a stop is still routed deterministically when turns are on', async () => {
  // the AI reply gate (LeadCommand's own reply on the thread)
  const body = 'Good to know. Would you consider an offer on it?'
  const rec = { id: 'r1', ...buildAiGeneratedMessage({ body, inboundMessageId: 'in-1', queueKey: 'ai_conversation:in-1', threadKey: PHONE, recipientPhone: PHONE, decisionId: 'd', model: 'm', playbookVersion: 'p', promptVersion: 'p', contextVersion: 'c', validation: { status: 'validated' }, ledgerSnapshot: {}, policy: {}, authorizationScope: { scope_match: 'thread_keys', category: 'next_missing_fact' }, generatedAt: ago(0.1) }) }
  const row = { id: 'q2', queue_key: 'ai_conversation:in-1', message_body: body, to_phone_number: PHONE, thread_key: PHONE, message_origin: 'ai_generated', source: 'ai_conversation', inbound_message_id: 'in-1',
    metadata: { source: 'ai_conversation', ai_message_id: 'r1', ai_message_body_sha256: sha256Hex(body), inbound_message_event_id: 'in-1' } }
  const sw = async (k) => (k === 'ai_conversation_send_enabled' ? 'true' : JSON.stringify({ enabled: true, scope: { thread_keys: [PHONE] } }))
  const held = await evaluateAiConversationRowGate(row, { readSwitch: sw, loadRecord: async () => ({ record: rec }), readLeadHolder: async () => ({ agent_id: 'agt_nova' }), automationHoldChecker: async () => ({ held: false }) })
  assert.deepEqual([held.action, held.reason], ['cancel', 'ai_reply_agent_holds_lead'])
  assert.equal((await evaluateAiConversationRowGate(row, { readSwitch: sw, loadRecord: async () => ({ record: rec }), readLeadHolder: async () => ({ read_failed: true }), automationHoldChecker: async () => ({ held: false }) })).action, 'defer')
  // the turn decider
  let modelDecisions = 0
  const inner = async () => { modelDecisions += 1; return { code: 'REPLY', reply: { text: 'x' } } }
  const rpcFake = (holder) => ({ rpc: async (fn) => (fn === 'lc_agent_lead_holder' ? { data: holder, error: null } : { data: null, error: { message: 'unexpected' } }) })
  const d = await standDownDecider(inner, { supabase: rpcFake('agt_nova') })({ thread_key: PHONE })
  assert.deepEqual([d.code, d.reply, modelDecisions], [AGENT_HELD_STAND_DOWN, null, 0])
  await standDownDecider(inner, { supabase: rpcFake(null) })({ thread_key: PHONE })
  assert.equal(modelDecisions, 1, 'a lead nobody holds is LeadCommand\'s as before')
  // without link #32 the read does not exist: nobody holds a lead
  const absent = { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) }
  await standDownDecider(inner, { supabase: absent })({ thread_key: PHONE })
  assert.equal(modelDecisions, 2)
  // the decide job: no model run on a held lead; a stop with turns on is still routed (deterministic, no model)
  let runs = 0
  let routed = 0
  const ctx = { job: { input: { inbound_ref: 'ababab' } }, step: async () => {}, remainingMs: () => 10_000 }
  const h1 = createConversationDecideHandler({ env: {}, run: async () => { runs += 1; return {} }, standDown: async () => ({ stand_down: true, stop: false }) })
  assert.equal((await h1.run(ctx)).result.code, AGENT_HELD_STAND_DOWN)
  const h2 = createConversationDecideHandler({ env: { AI_CONVERSATION_TURNS_ENABLED: 'true', AI_CONVERSATION_SHADOW_ENABLED: 'true' }, route: async () => { routed += 1; return { code: 'TURN_CANCELLED', route: 'stop' } }, runtimeStore: {}, standDown: async () => ({ stand_down: true, stop: true }) })
  assert.equal((await h2.run(ctx)).result.code, 'TURN_CANCELLED')
  assert.deepEqual([runs, routed], [0, 1])
})

test('the carrier\'s verdict reaches the agents\' feed (delivered / undelivered), only for agent rows; the production receipt sweep is a born-OFF maintenance task', async () => {
  const calls = []
  const sb = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: { ok: true, appended: true }, error: null } }, from: () => ({ insert: async (r) => { calls.push(['event', r]); return { error: null } } }) }
  assert.deepEqual(await recordAgentDeliveryVerdict(sb, { id: 'q1', metadata: {} }, { delivered: true }), { ok: false, reason: 'not_an_agent_row' })
  const r = await recordAgentDeliveryVerdict(sb, { id: 'q1', metadata: { agent_text_intent_id: INTENT, ai_message_id: 'rec-1' } }, { delivered: false, code: 'carrier_violation' })
  assert.deepEqual([r.ok, r.state], [true, 'undelivered'])
  assert.deepEqual(calls[0], ['lc_agent_text_delivery_record', { p_queue_row_id: 'q1', p_state: 'undelivered', p_code: 'carrier_violation' }])
  assert.equal(calls[1][1].event_type, 'undelivered')
  // the sweep: [] unless the executor is on; on: it follows receipts, throttled
  assert.deepEqual(actionGatewayRuntimeMaintenance({}), [])
  __resetReceiptSweepThrottleForTests()
  let swept = 0
  const [task] = actionGatewayRuntimeMaintenance({ LC_ACTION_GATEWAY_EXECUTION: '1' }, { execution: { reconcileReceipts: async () => { swept += 1; return { scanned: 2, recorded: [{}] } } } })
  assert.deepEqual(await task.run({ now: NOW }), { scanned: 2, recorded: 1 })
  assert.deepEqual(await task.run({ now: NOW }), { skipped: 'throttled' })
  assert.equal(swept, 1)
  __resetReceiptSweepThrottleForTests()
  // the tick route registers it
  assert.match(fs.readFileSync(path.join(SRC, '../app/api/internal/agent/runtime/tick/route.js'), 'utf8'), /actionGatewayRuntimeMaintenance\(\)/)
})

test('nothing on the agent path constructs a model client: the agent-text executor, the retired agent-message executor, the gateway action and the validator import no model / composer', () => {
  const exec = fs.readFileSync(path.join(SRC, 'ai/action-gateway-execution.js'), 'utf8')
  const fn = (name) => { const i = exec.indexOf(`async function ${name}(`); const j = exec.indexOf('\n  async function ', i + 10); return exec.slice(i, j > 0 ? j : undefined) }
  for (const name of ['agentText', 'agentMessage']) {
    const body = fn(name)
    assert.ok(body.length > 200, name)
    assert.ok(!/model-client|createConversationModelClient|anthropic-provider|composeAgentOutbound|decideAndCompose|createCanonicalTurnDecider|trackerFor|provider \|\||provider:/.test(body), `${name} reaches a model`)
  }
  for (const f of ['domain/action-gateway/actions/agent-text/index.js', 'domain/conversation-ai/agent-text-validator.js', 'domain/outreach/agent-text.js', 'domain/queue/agent-text-row-gate.js']) {
    assert.ok(!/model-client|anthropic|composeAgentOutbound|decideAndCompose|runtime\/canonical/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f)
  }
})

test('a first touch may name the property LeadCommand holds: its street number and ZIP are known numbers; any other number is not', async () => {
  const property = { property_id: '808100004', property_type: 'SFR', property_address: '2230 Wilder Ave', property_address_full: '2230 Wilder Ave, Honolulu, HI 96816', property_address_zip: '96816' }
  const ok = v('Hi, this is Nova with Reivesti Home Buyers. Are you the owner of 2230 Wilder Ave in Honolulu?', { purpose: 'first_touch', messages: [], property })
  assert.equal(ok.reasons.includes('content:unsupported_number'), false, ok.reasons.join(','))
  assert.equal(v('Hi, this is Nova with Reivesti Home Buyers. Do you own a house in the 96816 area?', { purpose: 'first_touch', messages: [], property }).reasons.includes('content:unsupported_number'), false)
  assert.ok(v('Hi, this is Nova with Reivesti Home Buyers. Are you the owner of 4410 Wilder Ave in Honolulu?', { purpose: 'first_touch', messages: [], property }).reasons.includes('content:unsupported_number'))
  // the request-time gate reads the address columns (the execution path reads the whole row)
  const { readFileSync } = await import('node:fs')
  const ports = readFileSync(new URL('../../src/lib/domain/action-gateway/ports.js', import.meta.url), 'utf8')
  assert.match(ports, /from\('properties'\)\.select\('[^']*property_address,property_address_full/)
})
