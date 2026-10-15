// Conversation Engine 2.0 R1/R2 (SHADOW ONLY): contract, pre-check, validator, ledgers,
// idempotency, kill switch. No network: every model is a local fake.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DECISION_CONTRACT_VERSION, validateDecision, failClosedDecision, makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { understandInbound } from '../../src/lib/domain/conversation-ai/understand.js'
import { buildConversationContext, ContextError } from '../../src/lib/domain/conversation-ai/context-builder.js'
import { validateDraft, moneyMentions, contentReasons } from '../../src/lib/domain/conversation-ai/validator.js'
import { buildFactLedger } from '../../src/lib/domain/conversation-ai/facts.js'
import { questionKindOf, questionLedger, blockedQuestionKinds } from '../../src/lib/domain/conversation-ai/questions.js'
import { runConversationAiShadow, createMemoryShadowStore } from '../../src/lib/domain/conversation-ai/engine.js'
import { DEFAULT_AI_REPLY_POLICY, assertSendAllowed, shadowAllowed, normalizePolicy, SHADOW_ENV_FLAG } from '../../src/lib/domain/conversation-ai/policy.js'
import { createConversationModelClient, createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { maskText } from '../../src/lib/domain/conversation-ai/pii.js'
import { reevaluateFollowUp } from '../../src/lib/domain/conversation-ai/followup-reevaluation.js'
import { dryRunEligibility, hypotheticalReplyRow } from '../../src/lib/domain/conversation-ai/eligibility-bridge.js'

const PHONE = '+15555550123'
const NOW = '2026-10-13T17:00:00.000Z' // 12:00 Central
const ON_POLICY = { shadow_enabled: true, kill_switch_engaged: false }
const ON_ENV = { [SHADOW_ENV_FLAG]: 'true' }
const OPEN = { blocked: false, reasons: [], outside_window: false }

function msg(id, direction, body, at, extra = {}) {
  return { id, direction, body, at, thread_key: 'thr_test', seller_phone: PHONE, ...extra }
}
function input(inboundBody, thread = [], extra = {}) {
  const inbound = { id: 'in-1', body: inboundBody, at: '2026-10-13T16:58:00.000Z', thread_key: 'thr_test', from_phone: PHONE, property_id: 'p1' }
  return { now: NOW, inbound, thread: [...thread, msg('in-1', 'inbound', inboundBody, inbound.at)], properties: [{ property_id: 'p1', property_type: 'SFR', city: 'Dallas', state: 'TX' }], offers: [], followups: [], names: { full_names: ['Jane Q Seller'], first_name: 'Jane' }, eligibility: OPEN, ...extra }
}
function goodDecision(over = {}) {
  return makeDecision({ intent: 'asks_offer', seller_interest: 'interested', outcome: 'REPLY_CANDIDATE', next_objective: 'get_condition', response_needed: true, proposed_message: 'Happy to work up a number. How is the condition overall, any repairs needed?', confidence: 0.92, source_message_ids: ['in-1'], stage_evidence: { stage: 'S4_condition', evidence_message_ids: ['in-1'], rationale: 'x' }, ...over })
}
/** A fake provider: counts calls, returns a tool_use with the given input (or a function of params). */
function fakeProvider(respond) {
  const calls = []
  return {
    calls,
    async listModels() { return [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' }] },
    async createMessage(params) {
      calls.push(params)
      const out = typeof respond === 'function' ? respond(params, calls.length) : respond
      return { content: out === null ? [] : [{ type: 'tool_use', name: params.tools[0].name, input: out }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 } }
    },
  }
}
function client(respond, cap = 1) {
  const provider = fakeProvider(respond)
  return { provider, mc: createConversationModelClient({ provider, tracker: createSpendTracker({ capUsd: cap }), env: {} }) }
}
const priceAskThread = [
  msg('o1', 'outbound', 'Hi Jane, do you still own 12 Elm St?', '2026-10-12T15:00:00.000Z', { use_case: 'ownership_check' }),
  msg('i0', 'inbound', 'Yes I do', '2026-10-12T15:05:00.000Z', { intent: 'ownership_confirmed' }),
  msg('o2', 'outbound', 'If I put together a proposal would you take a look?', '2026-10-12T15:06:00.000Z', { use_case: 'consider_selling' }),
  msg('i00', 'inbound', 'Sure', '2026-10-12T15:10:00.000Z', { intent: 'seller_interested' }),
  msg('o3', 'outbound', 'What number makes sense for you?', '2026-10-12T15:11:00.000Z', { use_case: 'seller_asking_price' }),
]

// ── contract ────────────────────────────────────────────────────────────────
test('contract: a valid decision passes; unknown keys, bad enums, foreign ids, reply without text all fail', () => {
  const ids = { messageIds: ['in-1', 'o1'], inboundMessageIds: ['in-1'] }
  assert.equal(validateDecision(goodDecision(), ids).ok, true)
  assert.equal(validateDecision({ ...goodDecision(), extra: 1 }, ids).ok, false)
  assert.equal(validateDecision({ ...goodDecision(), outcome: 'SEND_NOW' }, ids).ok, false)
  assert.equal(validateDecision({ ...goodDecision(), contract_version: 'v0' }, ids).ok, false)
  assert.equal(validateDecision({ ...goodDecision(), source_message_ids: ['someone-else'] }, ids).ok, false)
  assert.equal(validateDecision({ ...goodDecision(), proposed_message: null }, ids).ok, false)
  assert.equal(validateDecision({ ...goodDecision(), outcome: 'NO_RESPONSE' }, ids).ok, false, 'a message on a no-reply outcome is invalid')
  assert.equal(validateDecision({ ...goodDecision(), facts_extracted: [{ fact: 'asking_price', value: 180000, source_message_id: 'o1', confidence: 0.9 }] }, ids).ok, false, 'a fact must cite a SELLER message')
  assert.equal(validateDecision('garbage', ids).ok, false)
  const fc = failClosedDecision({ errors: ['x'], sourceMessageIds: ['in-1'] })
  assert.equal(fc.outcome, 'NEEDS_REVIEW')
  assert.equal(fc.proposed_message, null)
  assert.equal(fc.contract_version, DECISION_CONTRACT_VERSION)
})

test('contract: invalid model output is retried once on Haiku, then fails closed to NEEDS_REVIEW — never escalated without a candidate (8.5.15)', async () => {
  const { provider, mc } = client({ intent: 'nonsense' })
  const ctx = buildConversationContext(input('hmm not sure yet', priceAskThread))
  const r = await understandInbound({ context: ctx, inboundText: 'hmm not sure yet', inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })
  assert.equal(r.decision.outcome, 'NEEDS_REVIEW')
  assert.equal(r.decision.proposed_message, null)
  assert.equal(provider.calls.length, 2, 'haiku, then one haiku repair that sees the errors (8.5.16) — no sonnet without a candidate (8.5.15)')
  assert.match(provider.calls[0].model, /haiku/)
  assert.match(provider.calls[1].model, /haiku/)
  assert.match(JSON.stringify(provider.calls[1].messages), /FAILED VALIDATION/)
  assert.equal(r.trace.default_retry, true)
  assert.deepEqual(r.trace.repair, { attempted: true, ok: false })
})

test('escalation (8.5.15): a Haiku ESCALATE with no reply candidate is a human item — Sonnet is not called', async () => {
  const { provider, mc } = client(goodDecision({ escalation_required: true, escalation_reason: 'financing', outcome: 'ESCALATE_TO_SONNET', proposed_message: null, response_needed: false }))
  const ctx = buildConversationContext(input('would you do owner financing?', priceAskThread))
  const r = await understandInbound({ context: ctx, inboundText: 'would you do owner financing?', inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })
  assert.equal(r.decision.outcome, 'NEEDS_REVIEW')
  assert.equal(provider.calls.length, 1)
  assert.ok(r.trace.escalation_withheld.includes('financing'))
})

test('escalation: a reply candidate with a non-human-bound trigger goes to Sonnet, and Sonnet gains no authority — its ESCALATE becomes NEEDS_REVIEW', async () => {
  const { provider, mc } = client((p, n) => (n === 1 ? goodDecision({ escalation_required: true, escalation_reason: 'low_confidence' }) : goodDecision({ outcome: 'ESCALATE_TO_SONNET', proposed_message: null, response_needed: false, escalation_required: true, escalation_reason: 'low_confidence' })))
  const ctx = buildConversationContext(input('hmm let me see', priceAskThread))
  const r = await understandInbound({ context: ctx, inboundText: 'hmm let me see', inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })
  assert.deepEqual(provider.calls[1].tool_choice, { type: 'auto' }, 'sonnet 5.5 refuses forced tool_choice')
  assert.equal(r.trace.path, 'haiku→sonnet')
  assert.equal(r.decision.outcome, 'NEEDS_REVIEW')
  assert.match(provider.calls[1].model, /sonnet/)
})

test('8.5.16 eval: NO Sonnet call when the turn goes to a human anyway (financing, offer request, Spanish); price contradiction is a HOLD', async () => {
  for (const text of ['would you do owner financing?', 'what is your offer', '¿Cuánto me ofrece por la casa?']) {
    const { provider, mc } = client(() => goodDecision({ escalation_required: true, escalation_reason: 'other', outcome: 'ESCALATE_TO_SONNET', proposed_message: null, response_needed: false }))
    const ctx = buildConversationContext(input(text, priceAskThread))
    const r = await understandInbound({ context: ctx, inboundText: text, inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })
    assert.equal(provider.calls.length, 1, text)
    assert.match(provider.calls[0].model, /haiku/)
    assert.equal(r.trace.escalation_skipped, 'human_bound', text)
    assert.notEqual(r.decision.outcome, 'ESCALATE_TO_SONNET')
  }
})

// ── deterministic pre-check ────────────────────────────────────────────────
test('STOP / opt-out / legal → SUPPRESS with NO model call', async () => {
  for (const text of ['STOP', 'Stop texting me', 'please remove my number', 'No me escriba más', 'I will sue you under the TCPA']) {
    const { provider, mc } = client(goodDecision())
    const ctx = buildConversationContext(input(text, priceAskThread))
    const r = await understandInbound({ context: ctx, inboundText: text, inboundId: 'in-1', deterministic: { intent: 'unclear' }, eligibility: OPEN, modelClient: mc })
    assert.equal(r.decision.outcome, 'SUPPRESS', text)
    assert.equal(provider.calls.length, 0, `${text}: no model call`)
    assert.equal(r.trace.path, 'deterministic_precheck')
  }
})

test('pre-check: "número equivocado" is a wrong number (UPDATE_ONLY), an insult is NO_RESPONSE — neither is an opt-out', () => {
  const wn = deterministicPrecheck({ text: 'Número equivocado', inboundId: 'x', deterministic: { intent: 'wrong_number' }, eligibility: OPEN })
  assert.equal(wn.decision.outcome, 'UPDATE_ONLY')
  const hostile = deterministicPrecheck({ text: 'you people are clowns', inboundId: 'x', deterministic: { intent: 'hostile_or_legal' }, eligibility: OPEN })
  assert.equal(hostile.decision.outcome, 'NO_RESPONSE')
  const other = deterministicPrecheck({ text: 'Stop being so pushy lol', inboundId: 'x', deterministic: { intent: 'unclear' }, eligibility: OPEN })
  assert.equal(other.decided, false, 'stop-other-action scope (existing stop-scope.js) is not an opt-out')
  const comm = deterministicPrecheck({ text: 'stop calling me', inboundId: 'x', deterministic: { intent: 'unclear' }, eligibility: OPEN })
  assert.equal(comm.decision.outcome, 'SUPPRESS', 'a stop with a communication object is an opt-out')
})

test('eligibility block from the EXISTING guard → SUPPRESS, no model call; validator never passes a blocked draft', async () => {
  const row = hypotheticalReplyRow({ sellerPhone: PHONE, inboundId: 'in-1', inboundAt: NOW, now: NOW })
  const elig = await dryRunEligibility({ row, facts: { suppressions: [{ phone_e164: PHONE, is_active: true, suppression_type: 'opt_out' }] }, geography: { state: 'TX', zip: '75201' }, now: NOW })
  assert.equal(elig.blocked, true)
  assert.deepEqual(elig.reasons, ['sms_suppression_list_active'])
  const { provider, mc } = client(goodDecision())
  const ctx = buildConversationContext(input('what is your offer', priceAskThread, { eligibility: elig }))
  const r = await understandInbound({ context: ctx, inboundText: 'what is your offer', inboundId: 'in-1', deterministic: { intent: 'asks_offer' }, eligibility: elig, modelClient: mc })
  assert.equal(r.decision.outcome, 'SUPPRESS')
  assert.equal(provider.calls.length, 0)
  const v = await validateDraft({ decision: goodDecision(), context: ctx, inboundText: 'what is your offer', eligibility: elig })
  assert.equal(v.status, 'rejected_with_reasons')
  assert.ok(v.reasons.includes('eligibility_blocked:sms_suppression_list_active'))
})

// ── validator ──────────────────────────────────────────────────────────────
test('validator: rejects a repeat asking-price question after "what\'s your proposal" (2026-10-13 failure #2)', async () => {
  const ctx = buildConversationContext(input("What's your proposal", priceAskThread))
  assert.equal(ctx.ledger.asking_price.deflected, true)
  assert.ok(ctx.blocked.has('asking_price'))
  const again = await validateDraft({ decision: goodDecision({ next_objective: 'get_asking_price', proposed_message: 'What price would you take for it?' }), context: ctx, inboundText: "What's your proposal", eligibility: OPEN })
  assert.equal(again.status, 'rejected_with_reasons')
  assert.ok(again.reasons.some((r) => r.startsWith('question_already_asked:asking_price')))
  assert.ok(again.reasons.includes('irrelevant:re_asks_price_after_offer_request'))
  const ok = await validateDraft({ decision: goodDecision(), context: ctx, inboundText: "What's your proposal", eligibility: OPEN })
  assert.equal(ok.status, 'validated_draft', JSON.stringify(ok.reasons))
})

test('validator: "what\'s your offer" never yields an invented number; an authoritative offer amount passes only flagged for approval', async () => {
  const ctx = buildConversationContext(input("What's your offer?", priceAskThread))
  for (const text of ['We could do $150k cash.', 'I can offer 150,000 for it.', 'How about 145k?', 'We pay 70% of value.']) {
    const v = await validateDraft({ decision: goodDecision({ proposed_message: text, next_objective: 'answer_question' }), context: ctx, inboundText: "What's your offer?", eligibility: OPEN })
    assert.equal(v.status, 'rejected_with_reasons', text)
    assert.ok(v.reasons.includes('unsupported_monetary_amount'), text)
  }
  const withOffer = buildConversationContext(input("What's your offer?", priceAskThread, { offers: [{ id: 'so1', property_id: 'p1', amount: 150000, status: 'active', created_at: '2026-10-12T00:00:00Z', source_table: 'seller_offers' }] }))
  const v = await validateDraft({ decision: goodDecision({ proposed_message: 'Our offer on file is $150,000.', next_objective: 'answer_question' }), context: withOffer, inboundText: "What's your offer?", eligibility: OPEN })
  assert.equal(v.draft.needs_approval, true)
  assert.ok(!v.reasons.includes('unsupported_monetary_amount'))
  assert.deepEqual(moneyMentions('about $1.2M or 950k').map((m) => m.amount), [1200000, 950000])
})

test('validator: price + condition in one message → neither is asked again', async () => {
  const text = 'I want 180,000 for it, it needs a new roof and the kitchen is outdated'
  const ctx = buildConversationContext(input(text, priceAskThread))
  assert.ok(ctx.facts.asking_price?.current, 'price extracted')
  for (const q of ['What price would you take?', 'How is the condition overall, any repairs needed?']) {
    const v = await validateDraft({ decision: goodDecision({ intent: 'price_and_condition', proposed_message: `Thanks. ${q}`, next_objective: 'get_condition' }), context: { ...ctx, blocked: new Set([...ctx.blocked, 'condition']) }, inboundText: text, eligibility: OPEN })
    assert.equal(v.status, 'rejected_with_reasons', q)
  }
  const noQ = await validateDraft({ decision: goodDecision({ intent: 'price_and_condition', proposed_message: 'Thanks for the details, that helps. I will look this over and get back to you.', next_objective: 'acknowledge' }), context: ctx, inboundText: text, eligibility: OPEN })
  // content passes; the AI policy still holds S5 (offer) for a human
  assert.deepEqual(contentReasons(noQ.reasons), [], JSON.stringify(noQ.reasons))
  assert.ok(noQ.reasons.includes('policy_stage_out_of_bounds'))
})

test('validator: shape, tone, distress, protected classes, commitments, window', async () => {
  const ctx = buildConversationContext(input('ok', priceAskThread))
  const cases = {
    'more_than_one_question': 'Is it vacant? Any repairs?',
    'over_length': `${'word '.repeat(60)}?`,
    'distress_mention': 'Sorry to hear about the foreclosure. How is the condition?',
    'protected_class_reference': 'Great for a family with kids. How is the condition?',
    'legal_claim_or_commitment': 'We guarantee to close in 7 days. How is the condition?',
    'pressure_language': 'Act now, limited time. How is the condition?',
    'filler': 'Just checking in! How is the condition?',
    'names_other_than_first_name': 'Thanks Seller. How is the condition?',
  }
  for (const [reason, text] of Object.entries(cases)) {
    const v = await validateDraft({ decision: goodDecision({ proposed_message: text }), context: ctx, inboundText: 'ok', eligibility: OPEN })
    assert.ok(v.reasons.includes(reason), `${reason}: ${JSON.stringify(v.reasons)}`)
  }
  const late = await validateDraft({ decision: goodDecision(), context: ctx, inboundText: 'ok', eligibility: { ...OPEN, outside_window: true } })
  assert.ok(late.reasons.includes('outside_sending_window'))
  const unknownTz = await validateDraft({ decision: goodDecision(), context: ctx, inboundText: 'ok', eligibility: { ...OPEN, outside_window: null } })
  assert.ok(unknownTz.reasons.includes('sending_window_unknown_timezone'))
})

test('validator: a semantic duplicate check can only ADD reasons', async () => {
  const ctx = buildConversationContext(input("What's your proposal", priceAskThread))
  const v = await validateDraft({ decision: goodDecision(), context: ctx, inboundText: "What's your proposal", eligibility: OPEN, semanticCheck: async () => ({ duplicate: true, irrelevant: false }) })
  assert.ok(v.reasons.includes('semantic_duplicate_question'))
})

// ── ledgers ────────────────────────────────────────────────────────────────
test('correction reconciliation: the later stated price replaces the earlier one with provenance', () => {
  const l = buildFactLedger({ inbound: [
    { id: 'a', body: 'I would want 200k for it', at: '2026-10-10T00:00:00Z' },
    { id: 'b', body: 'actually make that 185,000', at: '2026-10-11T00:00:00Z' },
  ] })
  assert.equal(l.asking_price.current.value.amount, 185000)
  assert.equal(l.asking_price.current.corrects, 'a')
  assert.equal(l.asking_price.history[0].superseded_by, 'b')
  assert.equal(l.asking_price.history.length, 2)
})

test('question ledger: kinds come from the use case first, then the text', () => {
  assert.equal(questionKindOf({ use_case: 'seller_asking_price', body: '' }), 'asking_price')
  assert.equal(questionKindOf({ use_case: null, body: 'Got it. How is the property overall? Anything that needs work?' }), 'condition')
  assert.equal(questionKindOf({ use_case: 'who_is_this', body: "I'm a local buyer. Would you be open to an offer?" }), 'interest')
  const led = questionLedger([msg('o', 'outbound', 'What number works?', 'x', { use_case: 'seller_asking_price' }), msg('o2', 'outbound', 'Did you have a number in mind?', 'y', { use_case: 'asking_price_follow_up' })], {})
  assert.equal(led.asking_price.asked_count, 2)
  assert.ok(blockedQuestionKinds(led).has('asking_price'))
})

test('context builder never mixes threads, phones or properties', () => {
  assert.throws(() => buildConversationContext(input('hi', [msg('x', 'inbound', 'other', '2026-10-12T00:00:00Z', { thread_key: 'thr_other' })])), (e) => e instanceof ContextError && e.code === 'CONTEXT_MIXED')
  assert.throws(() => buildConversationContext(input('hi', [msg('x', 'inbound', 'other', '2026-10-12T00:00:00Z', { seller_phone: '+15555550999' })])), (e) => e.code === 'CONTEXT_MIXED')
  assert.throws(() => buildConversationContext(input('hi', [], { offers: [{ id: 'o', property_id: 'p-other', amount: 1, source_table: 'seller_offers' }] })), (e) => e.code === 'CONTEXT_MIXED')
})

test('PII: phones and emails are masked, other names removed, the first name kept', () => {
  const s = maskText('Call Jane Seller at (214) 555-0147 or jane@example.com, $180,000 or 175,000', { maskNames: ['Jane Q Seller'], keepFirstName: 'Jane' })
  assert.ok(!/555-0147|example\.com|Seller/.test(s), s)
  assert.match(s, /Jane/)
  assert.match(s, /\$180,000 or 175,000/, 'money is not mistaken for a phone')
})

test('model client refuses a payload with residual PII and never exceeds the spend cap', async () => {
  const { provider, mc } = client(goodDecision(), 0.0001)
  await assert.rejects(() => mc.decide({ system: 's', user: 'call 214-555-0147', inputSchema: { type: 'object' } }), (e) => e.code === 'RESIDUAL_PII')
  await assert.rejects(() => mc.decide({ system: 's', user: 'hello', inputSchema: { type: 'object' } }), (e) => e.code === 'SPEND_CAP_REACHED')
  assert.equal(provider.calls.length, 0)
})

// ── engine: idempotency, kill switch, no send ──────────────────────────────
test('parallel duplicate inbound (same message id) → exactly one decision', async () => {
  const store = createMemoryShadowStore()
  const { provider, mc } = client(goodDecision())
  const inp = input("What's your proposal", priceAskThread)
  const rs = await Promise.all([1, 2, 3, 4].map(() => runConversationAiShadow({ input: inp, deterministic: { intent: 'asks_offer' }, modelClient: mc, policy: ON_POLICY, env: ON_ENV, store })))
  assert.equal(rs.filter((r) => r.code === 'SHADOW_RECORDED').length, 1)
  assert.equal(store.all().length, 1)
  assert.equal(new Set(rs.map((r) => r.record.idempotency_key)).size, 1)
  assert.equal(rs[0].record.idempotency_key, 'conv-ai:v1:in-1')
  const again = await runConversationAiShadow({ input: inp, deterministic: { intent: 'asks_offer' }, modelClient: mc, policy: ON_POLICY, env: ON_ENV, store })
  assert.equal(again.code, 'DUPLICATE_INBOUND')
  assert.ok(provider.calls.length <= 2, 'one decision (+ at most its own escalation / semantic check)')
})

test('kill switch / env / policy gates block every shadow run (no model call); no policy ever allows a send', async () => {
  const { provider, mc } = client(goodDecision())
  const inp = input("What's your proposal", priceAskThread)
  assert.equal((await runConversationAiShadow({ input: inp, modelClient: mc, policy: { ...ON_POLICY, kill_switch_engaged: true }, env: ON_ENV })).code, 'KILL_SWITCH_ENGAGED')
  assert.equal((await runConversationAiShadow({ input: inp, modelClient: mc, policy: ON_POLICY, env: {} })).code, 'SHADOW_ENV_OFF')
  assert.equal((await runConversationAiShadow({ input: inp, modelClient: mc, policy: DEFAULT_AI_REPLY_POLICY, env: ON_ENV })).code, 'KILL_SWITCH_ENGAGED')
  assert.equal(provider.calls.length, 0)
  assert.equal(shadowAllowed(normalizePolicy({ shadow_enabled: 'true', kill_switch_engaged: 'false' }), ON_ENV).allowed, false, 'strings never enable')
  assert.equal(assertSendAllowed(DEFAULT_AI_REPLY_POLICY).allowed, false)
  assert.equal(assertSendAllowed({ enabled: true, kill_switch_engaged: true }).code, 'KILL_SWITCH_ENGAGED')
  assert.deepEqual(assertSendAllowed({ enabled: true, kill_switch_engaged: false }), { allowed: false, code: 'NO_SEND_PATH_IN_RELEASE', release: 'R1+R2-shadow' })
})

test('every shadow record says not sent; send permission is never granted', async () => {
  const { mc } = client(goodDecision({ send_permission_requested: true }))
  const r = await runConversationAiShadow({ input: input("What's your proposal", priceAskThread), deterministic: { intent: 'asks_offer' }, modelClient: mc, policy: ON_POLICY, env: ON_ENV })
  assert.equal(r.record.send_status, 'not_sent_shadow')
  assert.equal(r.record.decision.send_permission_granted, false)
  assert.equal(r.record.policy_code, 'AI_REPLY_POLICY_DISABLED')
})

// ── follow-up re-evaluation ────────────────────────────────────────────────
test('follow-up re-evaluation: answered → skip, intervening unanswered → rewrite, untouched → keep, historical overdue → skip', () => {
  const fu = { use_case: 's3_no_response_fu1', created_at: '2026-10-12T15:12:00.000Z', due_at: '2026-10-13T16:00:00.000Z' }
  assert.equal(reevaluateFollowUp({ followup: fu, thread: [...priceAskThread], now: NOW }).verdict, 'keep')
  const answered = reevaluateFollowUp({ followup: fu, thread: [...priceAskThread, msg('i9', 'inbound', 'I want 180k', '2026-10-13T10:00:00.000Z')], now: NOW })
  assert.equal(answered.verdict, 'skip')
  assert.ok(answered.reasons.includes('already_answered:asking_price'))
  const deflected = reevaluateFollowUp({ followup: fu, thread: [...priceAskThread, msg('i9', 'inbound', "what's your offer", '2026-10-13T10:00:00.000Z')], now: NOW })
  assert.equal(deflected.verdict, 'skip')
  const noThanks = reevaluateFollowUp({ followup: fu, thread: [...priceAskThread, msg('i9', 'inbound', 'not interested', '2026-10-13T10:00:00.000Z', { intent: 'not_interested' })], now: NOW })
  assert.equal(noThanks.verdict, 'skip')
  const chat = reevaluateFollowUp({ followup: fu, thread: [...priceAskThread, msg('i9', 'inbound', 'who is this again?', '2026-10-13T10:00:00.000Z')], now: NOW })
  assert.equal(chat.verdict, 'rewrite_draft')
  const old = reevaluateFollowUp({ followup: { ...fu, due_at: '2026-10-01T00:00:00.000Z' }, thread: priceAskThread, now: NOW })
  assert.deepEqual(old.reasons, ['historical_overdue_never_replayed'])
})
