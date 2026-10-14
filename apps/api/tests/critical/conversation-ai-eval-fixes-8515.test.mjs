// RC 8.5.15: the independent 150-item blind evaluation (2026-10-14) fixes for the
// conversation-ai engine (SHADOW ONLY). No network: every model is a local fake.
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { understandInbound } from '../../src/lib/domain/conversation-ai/understand.js'
import { buildConversationContext, requiredObjectiveFor } from '../../src/lib/domain/conversation-ai/context-builder.js'
import { validateDraft, minConfidenceFor, MIN_CONFIDENCE_BY_OBJECTIVE } from '../../src/lib/domain/conversation-ai/validator.js'
import { questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../../src/lib/domain/conversation-ai/prompts.js'
import { createConversationModelClient, createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'

const PHONE = '+15555550123'
const NOW = '2026-10-13T17:00:00.000Z'
const OPEN = { blocked: false, reasons: [], outside_window: false }
const msg = (id, direction, body, at, extra = {}) => ({ id, direction, body, at, thread_key: 'thr_test', seller_phone: PHONE, ...extra })
function input(inboundBody, thread = [], extra = {}) {
  const inbound = { id: 'in-1', body: inboundBody, at: '2026-10-13T16:58:00.000Z', thread_key: 'thr_test', from_phone: PHONE, property_id: 'p1' }
  return { now: NOW, inbound, thread: [...thread, msg('in-1', 'inbound', inboundBody, inbound.at)], properties: [{ property_id: 'p1', property_type: 'SFR', city: 'Dallas', state: 'TX' }], offers: [], followups: [], names: { full_names: ['Jane Q Seller'], first_name: 'Jane' }, eligibility: OPEN, ...extra }
}
function fakeProvider(respond) {
  const calls = []
  return {
    calls,
    async listModels() { return [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' }, { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' }] },
    async createMessage(params) {
      calls.push(params)
      const out = typeof respond === 'function' ? respond(params, calls.length) : respond
      return { content: [{ type: 'tool_use', name: params.tools[0].name, input: out }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 } }
    },
  }
}
const client = (respond) => { const provider = fakeProvider(respond); return { provider, mc: createConversationModelClient({ provider, tracker: createSpendTracker({ capUsd: 1 }), env: {} }) } }
const S1 = [msg('o1', 'outbound', 'Hi Jane, do you still own 12 Elm St?', '2026-10-12T15:00:00.000Z', { use_case: 'ownership_check' })]
const S3 = [
  ...S1,
  msg('i0', 'inbound', 'Yes I do', '2026-10-12T15:05:00.000Z', { intent: 'ownership_confirmed' }),
  msg('o2', 'outbound', 'Would you consider an offer on it?', '2026-10-12T15:06:00.000Z', { use_case: 'consider_selling' }),
  msg('i00', 'inbound', 'Sure', '2026-10-12T15:10:00.000Z', { intent: 'seller_interested' }),
  msg('o3', 'outbound', 'What number makes sense for you?', '2026-10-12T15:11:00.000Z', { use_case: 'seller_asking_price' }),
]
const decision = (over = {}) => makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'Thanks for confirming. Would you consider selling it?', confidence: 0.9, source_message_ids: ['in-1'], stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['in-1'], rationale: 'x' }, ...over })

// ── 1. Bare "No" after S1 = ownership denied, no model call ────────────────
test('pre-check: a bare "No" to OUR ownership question is ownership_denied / UPDATE_ONLY / no nurture, with NO model call', async () => {
  for (const text of ['No', 'Nope', 'No!!!', 'Not really']) {
    const { provider, mc } = client(decision())
    const ctx = buildConversationContext(input(text, S1))
    assert.equal(ctx.last_question_kind, 'ownership')
    const r = await understandInbound({ context: ctx, inboundText: text, inboundId: 'in-1', deterministic: { intent: 'unclear' }, eligibility: OPEN, modelClient: mc })
    assert.equal(r.trace.path, 'deterministic_precheck', text)
    assert.equal(r.decision.intent, 'ownership_denied', text)
    assert.equal(r.decision.outcome, 'UPDATE_ONLY', text)
    assert.equal(r.decision.next_objective, 'none', text)
    assert.equal(provider.calls.length, 0, `${text}: no model call`)
  }
})

test('pre-check: the classifier verdict property_specific_non_owner (written denial, read against the question) is ownership_denied; a polite "No thanks" is not', () => {
  const d = deterministicPrecheck({ text: 'not mine', inboundId: 'x', deterministic: { intent: 'property_specific_non_owner' }, eligibility: OPEN })
  assert.equal(d.decided, true)
  assert.equal(d.decision.outcome, 'UPDATE_ONLY')
  assert.equal(d.decision.intent, 'ownership_denied')
  const polite = deterministicPrecheck({ text: 'No thanks', inboundId: 'x', deterministic: { intent: 'not_interested' }, eligibility: OPEN, lastQuestionKind: 'ownership' })
  assert.equal(polite.decided, false, 'a decline goes to the model (30-day nurture), not the denial lane')
  const s2 = deterministicPrecheck({ text: 'No', inboundId: 'x', deterministic: { intent: 'not_interested' }, eligibility: OPEN, lastQuestionKind: 'interest' })
  assert.equal(s2.decided, false, 'a "No" to S2 is not an ownership denial')
})

test('the system prompt encodes the 2026-10-14 rules, not the superseded "No → nurture" ownership rule', () => {
  assert.equal(PROMPT_VERSION, 'conv-ai.prompt.v2')
  assert.ok(!/after our ownership question or our interest question it means not_interested/.test(SYSTEM_PROMPT))
  assert.match(SYSTEM_PROMPT, /OWNERSHIP question[^\n]*= ownership_denied: outcome UPDATE_ONLY, next_objective "none"/)
  assert.match(SYSTEM_PROMPT, /INTEREST question[^\n]*nurture_later/)
  assert.match(SYSTEM_PROMPT, /ANY request to stop messaging/)
})

// ── 2. Opt-out glued / stop requests (compliance) ──────────────────────────
test('pre-check: glued STOP, a stop sign and any stop-messaging request SUPPRESS with no model call', () => {
  for (const text of ['God bless JesusSTOP 🛑', 'Not interested please stop sending', 'Stop asking me about [address]', '🛑']) {
    const d = deterministicPrecheck({ text, inboundId: 'x', eligibility: OPEN })
    assert.equal(d.decided, true, text)
    assert.equal(d.decision.outcome, 'SUPPRESS', text)
  }
})

// ── 3. Question kinds (EN / ES) ────────────────────────────────────────────
test('question kinds: S2 interest phrasings and Spanish ownership questions are recognised (were "other")', () => {
  for (const b of ['Would you ever consider selling 12 Elm St?', '¿Estaría abierto a una oferta por la propiedad?', 'Would you be open to a cash offer on it?', '¿Le interesaría vender la casa?']) assert.equal(questionKindOf({ body: b }), 'interest', b)
  for (const b of ['¿Es usted el dueño de la propiedad en 12 Elm?', 'Hola, ¿12 Elm St es tu propiedad?', 'Is 12 Elm St yours?']) assert.equal(questionKindOf({ body: b }), 'ownership', b)
})

// ── 4. Never re-ask the price after an offer request ───────────────────────
test('objective override: once S3 was asked, an offer request requires the condition question (or a human when condition is known)', () => {
  const ctx = buildConversationContext(input('What would you offer?', S3, {}))
  assert.equal(ctx.required_next_objective, 'get_condition')
  assert.equal(ctx.model.required_next_objective, 'get_condition')
  assert.equal(requiredObjectiveFor({ inboundText: 'make me an offer', ledger: ctx.ledger, facts: { condition: { current: { value: 'good' } } } }), 'offer_needs_human')
  assert.equal(requiredObjectiveFor({ inboundText: 'make me an offer', ledger: { asking_price: { asked_count: 0 } }, facts: {} }), null, 'before S3 the price question is still allowed')
})

test('validator: a draft that re-asks the price after an offer request violates the binding objective', async () => {
  const ctx = buildConversationContext(input('What would you offer?', S3))
  const v = await validateDraft({ decision: decision({ intent: 'asks_offer', next_objective: 'get_asking_price', proposed_message: 'What price would work for you?' }), context: ctx, inboundText: 'What would you offer?', eligibility: OPEN })
  assert.ok(v.reasons.includes('objective_override_violated:get_condition'), v.reasons.join(','))
})

// ── 5. Validator calibration ───────────────────────────────────────────────
test('validator: per-objective confidence floors (calibrated on the blind gold set); never above the policy floor', () => {
  assert.equal(minConfidenceFor('clarify_identity'), MIN_CONFIDENCE_BY_OBJECTIVE.clarify_identity)
  assert.equal(minConfidenceFor('gauge_interest'), 0.8)
  assert.equal(minConfidenceFor('get_asking_price'), 0.85)
  assert.equal(minConfidenceFor('confirm_ownership'), 0.85)
  assert.equal(minConfidenceFor('gauge_interest', { min_confidence: 0.7 }), 0.7, 'a stricter-or-equal policy floor wins')
})

test('validator: "cash offer" is allowed inside an S2 interest QUESTION; a promised follow-up proposal is a commitment', async () => {
  const S1Yes = [...S1, msg('i0', 'inbound', 'Yes', '2026-10-12T15:05:00.000Z', { intent: 'ownership_confirmed' })]
  const ctx = buildConversationContext(input('Yes I do', S1Yes))
  const ok = await validateDraft({ decision: decision({ proposed_message: 'Thanks for confirming. Would you be open to a cash offer on it?' }), context: ctx, inboundText: 'Yes I do', eligibility: OPEN })
  assert.ok(!ok.reasons.includes('legal_claim_or_commitment'), ok.reasons.join(','))
  const promise = await validateDraft({ decision: decision({ intent: 'asks_offer', next_objective: 'get_condition', proposed_message: "Fair question. I'll have our team follow up with a proposal. How is the condition?" }), context: ctx, inboundText: 'Yes I do', eligibility: OPEN })
  assert.ok(promise.reasons.includes('legal_claim_or_commitment'), promise.reasons.join(','))
  const statement = await validateDraft({ decision: decision({ proposed_message: 'We can make you a cash offer today.' }), context: ctx, inboundText: 'Yes I do', eligibility: OPEN })
  assert.ok(statement.reasons.includes('legal_claim_or_commitment'), 'a cash offer outside a question is still a commitment')
})

test('validator: the semantic duplicate check only counts ANSWERED or deflected questions (an unanswered ownership question is not a duplicate)', async () => {
  const ctx = buildConversationContext(input('Who is this?', S1))
  let seen = null
  const semanticCheck = async (q) => { seen = q; return { duplicate: true, irrelevant: false } }
  const v = await validateDraft({ decision: decision({ intent: 'who_is_this', next_objective: 'clarify_identity', proposed_message: "I'm Alex, a local buyer reaching out about 12 Elm St. Are you the owner?", confidence: 0.9 }), context: ctx, inboundText: 'Who is this?', eligibility: OPEN, semanticCheck })
  assert.deepEqual(seen.prior_questions, [], 'the unanswered ownership question is not sent as a prior question')
  assert.ok(!v.reasons.includes('semantic_duplicate_question'), v.reasons.join(','))
})

// ── 6. Escalation policy ───────────────────────────────────────────────────
test('escalation: NO_RESPONSE / NEEDS_REVIEW never escalate; Sonnet only for a reply candidate with a trigger', async () => {
  const { provider, mc } = client(decision({ intent: 'not_interested', seller_interest: 'not_interested', outcome: 'NO_RESPONSE', next_objective: 'nurture_later', response_needed: false, proposed_message: null, escalation_required: true, escalation_reason: 'financing' }))
  const ctx = buildConversationContext(input('not interested, maybe owner financing later', S3))
  const r = await understandInbound({ context: ctx, inboundText: 'not interested, maybe owner financing later', inboundId: 'in-1', deterministic: null, eligibility: OPEN, modelClient: mc })
  assert.equal(provider.calls.length, 1)
  assert.equal(r.decision.outcome, 'NO_RESPONSE')
})

// ── 7. Internal / placeholder names ────────────────────────────────────────
test('a placeholder first name ("Internal", "Test") is never used as the seller name', () => {
  for (const first of ['Internal', 'TEST', 'Unknown']) {
    const ctx = buildConversationContext(input('Who is this?', S1, { names: { full_names: [], first_name: first } }))
    assert.equal(ctx.model.seller_first_name, null, first)
  }
  const real = buildConversationContext(input('Who is this?', S1))
  assert.equal(real.model.seller_first_name, 'Jane')
})
