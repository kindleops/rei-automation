// 8.5.16 NATIVE AI CONVERSATION PIPELINE: decide first, then text; playbook v1 enforced in
// code; locked owner policies identical on the deterministic and AI paths; negotiation hooks.
import test from 'node:test'
import assert from 'node:assert/strict'

import { runConversationPipeline } from '../../src/lib/domain/conversation-ai/pipeline/run.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS, validatePlan } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { checkComposedText, composeReply, buildComposePrompt } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { measureComplexity, checkSpend } from '../../src/lib/domain/conversation-ai/pipeline/complexity.js'
import { createEscalatingNegotiationAuthority, normalizeNegotiationResult, NEGOTIATION_AUTHORITY_INTERFACE_VERSION } from '../../src/lib/domain/conversation-ai/pipeline/negotiation-authority.js'
import { validatePlaybookStyle } from '../../src/lib/domain/conversation-ai/playbook/v1/style-validator.js'
import { detectSellerTone } from '../../src/lib/domain/conversation-ai/playbook/v1/tone.js'
import { PLAYBOOK_RULES, PLAYBOOK_VERSION } from '../../src/lib/domain/conversation-ai/playbook/v1/index.js'
import { buildCanonicalLedger, ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { executeAiConversationReply } from '../../src/lib/ai/conversation-ai-r3-executor.js'

const NOW = '2026-10-15T17:00:00.000Z'
const TK = '+15555550101'
const at = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString()
const m = (id, direction, body, minAgo, use_case = null) => ({ id, direction, body, at: at(minAgo), thread_key: TK, seller_phone: TK, use_case })
const input = (thread, over = {}) => {
  const last = thread.filter((x) => x.direction === 'inbound').at(-1)
  return { now: NOW, inbound: { id: last.id, body: last.body, at: last.at, thread_key: TK, from_phone: TK }, thread, properties: [{ property_id: 'p1' }], offers: [], language: 'en', ...over }
}
const OWNER_EXAMPLE = "I'd sell it for $145K. It needs a roof, and I want to close before November."
const fakeModel = (texts) => {
  const calls = []
  return { calls, decide: async (a) => { calls.push(a); const t = texts[Math.min(calls.length - 1, texts.length - 1)]; return { input: { message: t }, model: a.route === 'escalation' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5', usd: 0.0004, usage: { input_tokens: 900, output_tokens: 30 } } } }
}
const spend = (over = {}) => ({ spentTodayUsd: () => 0, perMessageMaxUsd: 0.02, dailyMaxUsd: 1, estimateUsd: (route) => (route === 'escalation' ? 0.01 : 0.002), ...over })

// ── owner example ───────────────────────────────────────────────────────────
test('owner example: interest, $145K, roof and the timeline are recorded (with source ids); none is asked again; no fabricated offer', async () => {
  const thread = [m('o1', 'outbound', 'Would you consider selling the house on Elm?', 30, 'consider_selling'), m('i1', 'inbound', OWNER_EXAMPLE, 2)]
  const L = ledgerFromContextInput(input(thread))
  assert.equal(L.facts.seller_interest.value, 'interested')
  assert.equal(L.facts.asking_price.value.amount, 145000)
  assert.ok(L.facts.condition.source_message_ids.includes('i1'))
  assert.match(JSON.stringify(L.facts.timeline.value), /before november/)
  for (const k of ['seller_interest', 'asking_price', 'condition', 'timeline']) assert.deepEqual(L.facts[k].source_message_ids, ['i1'], k)
  assert.equal(L.facts.asking_price.basis, 'stated')
  for (const text of ['What price did you have in mind?', 'Does it need any repairs?', 'When are you looking to close?', 'Would you consider selling?']) {
    assert.ok(checkComposedText(text, { ledger: L, objective: 'none', category: 'next_missing_fact' }).length, text)
  }
  // responding to what was said, without a question, passes every code check
  assert.deepEqual(checkComposedText('Got it, thanks. A new roof and closing before November both work for us, let me run the numbers on it.', { ledger: L, objective: 'none', category: 'next_missing_fact' }), [])
  const out = await runConversationPipeline({ input: input(thread), modelClient: fakeModel(['unused']), spend: spend() })
  const types = out.plan.actions.map((a) => a.type)
  assert.ok(types.includes(ACTIONS.UPDATE_SELLER_FACTS))
  assert.deepEqual(Object.keys(out.plan.actions.find((a) => a.type === ACTIONS.UPDATE_SELLER_FACTS).facts).sort(), ['asking_price', 'condition', 'seller_interest', 'timeline'])
  assert.equal(out.plan.negotiation.requested, ACTIONS.PREPARE_OFFER, 'facts complete: the offer is the authority step')
  assert.ok(types.includes(ACTIONS.ESCALATE_TO_OPERATOR), 'the stub authority escalates: no offer, no amount')
  assert.equal(out.composition, null, 'no model text for a money step')
  assert.equal(out.send_status, 'not_sent_pipeline')
})

// ── no em dash, ever ────────────────────────────────────────────────────────
test('playbook v1: NO em dash ever; en dash only inside a numeric range; dash substitutes refused', () => {
  assert.deepEqual(validatePlaybookStyle('Got it — does it need repairs?').reasons, ['style:em_dash'])
  assert.ok(validatePlaybookStyle('Got it – does it need repairs?').reasons.includes('style:en_dash_as_dash'))
  assert.ok(validatePlaybookStyle('Got it–does it need repairs?').reasons.includes('style:en_dash_as_dash'))
  assert.ok(validatePlaybookStyle('Got it -- does it need repairs?').reasons.includes('style:dash_substitute'))
  assert.ok(validatePlaybookStyle('Got it - does it need repairs?').reasons.includes('style:dash_substitute'))
  assert.equal(validatePlaybookStyle('Is it a 3–4 bedroom?').ok, true)
  assert.equal(validatePlaybookStyle('Got it. Does it need any repairs?').ok, true)
  assert.ok(PLAYBOOK_RULES.some((r) => /em dash/.test(r)))
  assert.ok(!PLAYBOOK_RULES.join(' ').includes('—') && !PLAYBOOK_RULES.join(' ').includes('–'), 'the playbook itself has no em / en dash')
})

test('playbook v1: filler, flattery, emojis, robotic transitions, slang, invented claims, dollar amounts and fake human identity are refused', () => {
  const bad = {
    'Hope you are doing well! Would you sell?': 'style:filler',
    'Great question. Would you sell?': 'style:flattery',
    'Would you sell? \u{1F60A}': 'style:emoji',
    'Additionally, would you sell?': 'style:robotic_transition',
    'Cool bro, wanna sell?': 'style:slang_or_textspeak',
    "We've closed hundreds of deals. Would you sell?": 'style:invented_claim_offer_deadline_or_capacity',
    'We can close in 7 days. Interested?': 'style:invented_claim_offer_deadline_or_capacity',
    'Offer ends Friday. Interested?': 'style:invented_claim_offer_deadline_or_capacity',
    'Would you take $120K?': 'style:dollar_amount',
    'This is Mike with a local buying group. Would you sell?': 'style:claims_to_be_a_specific_human',
    "I'm a real person, not a bot. Would you sell?": 'style:claims_to_be_a_specific_human',
    'Would you sell? Or rent it? Or wait?': 'style:more_than_one_question',
    'What a shit situation. Would you sell?': 'style:profanity',
  }
  for (const [t, reason] of Object.entries(bad)) assert.ok(validatePlaybookStyle(t).reasons.includes(reason), `${t} => ${JSON.stringify(validatePlaybookStyle(t).reasons)}`)
  // an established thread persona is allowed ONLY when the owner enables persona use for AI
  assert.ok(validatePlaybookStyle('This is Helen again. Would you sell?', { establishedPersona: 'Helen' }).reasons.includes('style:claims_to_be_a_specific_human'))
  assert.equal(validatePlaybookStyle('This is Helen again. Would you sell?', { establishedPersona: 'Helen', personaPolicy: { allow_established_persona: true } }).ok, true)
  assert.ok(!validatePlaybookStyle('This is Mike. Would you sell?', { establishedPersona: 'Helen', personaPolicy: { allow_established_persona: true } }).ok)
})

test('seller mirroring: register detected; abuse and slang are never mirrored', () => {
  assert.equal(detectSellerTone('who is this and how did you get my number').tone, 'skeptical')
  assert.equal(detectSellerTone('Thank you for reaching out. Please advise on next steps. Regards').tone, 'professional')
  assert.equal(detectSellerTone('stop texting me so much, I already told you!!').tone, 'frustrated')
  const ab = detectSellerTone('f*** off, this is bs')
  assert.equal(ab.tone, 'frustrated')
  const p = buildComposePrompt({ ledger: buildCanonicalLedger({ messages: [] }), inboundText: 'yeah maybe lol', category: 'next_missing_fact', objective: 'asking_price', tone: 'casual' })
  assert.match(p.system, /Never use an em dash/)
  assert.match(p.user, /SELLER REGISTER: casual/)
  assert.ok(!/lol/.test(p.system))
})

// ── decide first ────────────────────────────────────────────────────────────
test('plans: compatible internal updates allowed; conflicting outbound actions refused', () => {
  assert.equal(validatePlan([{ type: 'UPDATE_SELLER_FACTS' }, { type: 'SCHEDULE_FOLLOWUP' }, { type: 'AI_GENERATED_REPLY' }]).ok, true)
  assert.ok(validatePlan([{ type: 'AI_GENERATED_REPLY' }, { type: 'DETERMINISTIC_REPLY' }]).reasons.includes('conflicting_outbound_actions'))
  assert.ok(validatePlan([{ type: 'SUPPRESS' }, { type: 'AI_GENERATED_REPLY' }]).reasons.some((r) => r.startsWith('suppress_conflicts_with')))
  assert.ok(validatePlan([{ type: 'SUPPRESS' }, { type: 'SCHEDULE_FOLLOWUP' }]).ok === false)
  assert.ok(validatePlan([{ type: 'UPDATE_SELLER_FACTS', facts: { ownership: 'denied' } }, { type: 'SCHEDULE_FOLLOWUP' }, { type: 'NO_RESPONSE' }]).reasons.includes('followup_after_stop_or_ownership_denial'))
  assert.ok(validatePlan([{ type: 'UPDATE_SELLER_FACTS' }]).reasons.includes('terminal_actions:0'))
})

const plan = (thread, extra = {}) => {
  const inp = input(thread)
  const ledger = ledgerFromContextInput(inp)
  return decideActions({ ledger, inboundText: inp.inbound.body, inboundId: inp.inbound.id, language: 'en', ...extra })
}
const types = (p) => p.actions.map((a) => a.type)

test('locked owner policies (identical on both paths): STOP, ownership denial, disinterest, price never re-asked, offer request, ambiguity', async () => {
  // STOP / any stop request, incl. glued — SUPPRESS that cancels pending sends, no AI override
  for (const t of ['STOP', 'Yes I own it STOP\u{1F6D1}', 'please remove me from your list']) {
    const p = plan([m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', t, 1)], { judgment: { outcome: 'REPLY_CANDIDATE', confidence: 0.99 } })
    assert.deepEqual(types(p), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SUPPRESS], t)
    assert.equal(p.actions[1].cancel_pending, true)
  }
  // "No" to ownership = denial: facts only, no reply, NO nurture
  const own = plan([m('o1', 'outbound', 'Do you still own 9 Birch?', 10, 'ownership_check'), m('i1', 'inbound', 'No', 1)])
  assert.deepEqual(types(own), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.NO_RESPONSE])
  assert.ok(!types(own).includes(ACTIONS.SCHEDULE_FOLLOWUP))
  // disinterest = the existing 30-day follow-up (+ a graceful close)
  const ni = plan([m('o1', 'outbound', 'Do you still own it?', 30, 'ownership_check'), m('i0', 'inbound', 'yes', 25), m('o2', 'outbound', 'Would you consider selling it?', 20, 'consider_selling'), m('i1', 'inbound', 'No', 1)])
  assert.deepEqual(types(ni), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.AI_GENERATED_REPLY])
  assert.deepEqual([ni.actions[1].kind, ni.actions[1].days], ['nurture_30_day', 30])
  assert.equal(ni.actions[2].category, 'not_interested_close')
  const niTpl = plan([m('o2', 'outbound', 'Would you consider selling it?', 20, 'consider_selling'), m('i1', 'inbound', 'not interested', 1)], { deterministicTemplate: { available: true, use_case: 'nurture_not_interested' } })
  assert.equal(niTpl.actions.at(-1).type, ACTIONS.DETERMINISTIC_REPLY, 'the deterministic path decides the same thing')
  // asking price recorded, never re-asked: after a price, the next objective is condition
  const price = plan([m('o1', 'outbound', 'What price would you want?', 10, 'seller_asking_price'), m('i1', 'inbound', 'around 200 thousand', 1)])
  assert.equal(price.actions.at(-1).type, ACTIONS.AI_GENERATED_REPLY)
  assert.equal(price.actions.at(-1).objective, 'condition')
  // offer request → no fabricated offer: PREPARE_OFFER (→ authority)
  const offer = plan([m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', "What's your offer?", 1)])
  assert.equal(offer.actions.at(-1).type, ACTIONS.PREPARE_OFFER)
  // ambiguous → review (no confident judgment), or a clarification when the judgment is confident
  const amb = plan([m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', 'the blue one by the lake', 1)])
  assert.deepEqual(types(amb), [ACTIONS.HOLD])
  const ambOk = plan([m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', 'the blue one by the lake', 1)], { judgment: { outcome: 'REPLY_CANDIDATE', confidence: 0.9 } })
  assert.equal(ambOk.actions.at(-1).category, 'clarification')
  // eligibility / owner-handled / language
  assert.equal(plan([m('i1', 'inbound', 'yes', 1)], { eligibility: { blocked: true, reasons: ['sms_suppression_list_active'] } }).actions.at(-1).type, ACTIONS.SUPPRESS)
  assert.deepEqual(types(plan([m('i1', 'inbound', 'yes I own it', 1)], { ownerHandled: true })), [ACTIONS.HOLD])
  assert.equal(plan([m('i1', 'inbound', 'Sí, soy el dueño', 1)], { language: 'es' }).actions.at(-1).type, ACTIONS.ESCALATE_TO_OPERATOR)
  // a simple turn with an existing template stays deterministic (no model cost)
  const simple = plan([m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', 'yes', 1)], { deterministicTemplate: { available: true, use_case: 'consider_selling' } })
  assert.equal(simple.actions.at(-1).type, ACTIONS.DETERMINISTIC_REPLY)
})

test('negotiation hooks: PREPARE_OFFER / NEGOTIATE_WITHIN_AUTHORITY call the authority interface; the stub escalates; nothing outside the contract passes', async () => {
  assert.equal(NEGOTIATION_AUTHORITY_INTERFACE_VERSION, 'negotiation-authority.v1')
  const stub = createEscalatingNegotiationAuthority()
  assert.equal((await stub.prepareOffer({})).action, 'ESCALATE_TO_OPERATOR')
  assert.equal((await stub.negotiateWithinAuthority({})).action, 'ESCALATE_TO_OPERATOR')
  assert.equal(normalizeNegotiationResult({ action: 'AI_GENERATED_REPLY' }).action, 'ESCALATE_TO_OPERATOR', 'money text is never AI-generated')
  const seen = []
  const authority = { version: 'test', prepareOffer: async (ctx) => { seen.push(ctx); return { action: 'DETERMINISTIC_REPLY', template_use_case: 'offer_reveal', authority_ref: 'auth-1' } }, negotiateWithinAuthority: async () => ({ action: 'HOLD', reason: 'x' }) }
  const out = await runConversationPipeline({ input: input([m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', "What's your offer?", 1)]), negotiationAuthority: authority })
  assert.equal(seen[0].request, 'offer_request')
  assert.ok(!('amount' in (seen[0].ledger_summary.facts.asking_price || {})), 'the authority receives facts, the engine invents nothing')
  assert.deepEqual([out.plan.actions.at(-1).type, out.plan.actions.at(-1).use_case, out.plan.actions.at(-1).authority_ref], [ACTIONS.DETERMINISTIC_REPLY, 'offer_reveal', 'auth-1'])
})

// ── text generation ─────────────────────────────────────────────────────────
test('compose: Haiku writes original text; a draft with an em dash is regenerated once, then held; Sonnet only for measured complexity; spend caps enforced', async () => {
  const thread = [m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', 'yes I still own it', 1)]
  const L = ledgerFromContextInput(input(thread))
  const ok = fakeModel(['Thanks for confirming — would you sell?', 'Thanks for confirming. Would you consider selling it?'])
  const r = await composeReply({ ledger: L, inboundText: 'yes I still own it', category: 'next_missing_fact', objective: 'interest', modelClient: ok, spend: spend() })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.text, 'Thanks for confirming. Would you consider selling it?')
  assert.equal(ok.calls.length, 2)
  assert.match(ok.calls[1].user, /style:em_dash/)
  assert.equal(r.route, 'default')
  assert.equal(r.playbook_version, 'playbook.v3') // rc-8.5.21: compose runs playbook v3 (v2 + configured identity + forbidden claims)
  const bad = fakeModel(['Thanks — would you sell?'])
  const held = await composeReply({ ledger: L, inboundText: 'yes', category: 'next_missing_fact', objective: 'interest', modelClient: bad, spend: spend() })
  assert.deepEqual([held.ok, held.reason, bad.calls.length], [false, 'composition_rejected', 2])
  // re-asking an answered fact is refused even if the model tries
  const reask = fakeModel(['Do you still own it?'])
  assert.equal((await composeReply({ ledger: L, inboundText: 'yes', category: 'next_missing_fact', objective: 'interest', modelClient: reask, spend: spend() })).ok, false)
  // complexity
  assert.equal(measureComplexity({ inboundText: 'yes', ledger: L }).route, 'default')
  const hard = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'What price?', 30, 'seller_asking_price'), m('i0', 'inbound', 'around 200 thousand', 20), m('i1', 'inbound', "Actually $150,000, but that's a lowball compared to my neighbor and I'm not sure about the timing, can you call me? What's the process? Is it cash?", 1)] })
  assert.equal(measureComplexity({ inboundText: "Actually $150,000, but that's a lowball compared to my neighbor and I'm not sure about the timing, can you call me? What's the process? Is it cash?", ledger: hard }).route, 'escalation')
  // spend caps
  assert.deepEqual(checkSpend({ estimateUsd: 0.03, spentTodayUsd: 0, perMessageMaxUsd: 0.02, dailyMaxUsd: 1 }), { allowed: false, reason: 'spend_cap_per_message' })
  assert.deepEqual(checkSpend({ estimateUsd: 0.01, spentTodayUsd: 0.995, perMessageMaxUsd: 0.02, dailyMaxUsd: 1 }), { allowed: false, reason: 'spend_cap_daily' })
  assert.equal(checkSpend({ estimateUsd: 0.01, spentTodayUsd: null, perMessageMaxUsd: 0.02, dailyMaxUsd: 1 }).allowed, false, 'unknown spend fails closed')
  const capped = fakeModel(['x'])
  const c = await composeReply({ ledger: L, inboundText: 'yes', category: 'next_missing_fact', objective: 'interest', modelClient: capped, spend: spend({ spentTodayUsd: () => 5 }) })
  assert.deepEqual([c.ok, c.reason, capped.calls.length], [false, 'spend_cap_daily', 0])
  // the prompt never carries a phone number
  assert.ok(!/555/.test(ok.calls[0].user))
})

test('pipeline end to end (no send): ownership confirmed → AI-generated interest question that passes every check', async () => {
  const model = fakeModel(['Thanks for confirming. Would you consider selling it?'])
  const out = await runConversationPipeline({ input: input([m('o1', 'outbound', 'Do you still own it?', 10, 'ownership_check'), m('i1', 'inbound', 'yes I still own it', 1)]), modelClient: model, spend: spend() })
  assert.deepEqual(out.plan.actions.map((a) => a.type), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.AI_GENERATED_REPLY])
  assert.equal(out.composition.ok, true)
  assert.equal(out.send_status, 'not_sent_pipeline')
})

test('STOP plan through the executor: queued / scheduled sends are cancelled even with the AI switch OFF (no AI override)', async () => {
  const cancelled = []
  const r = await executeAiConversationReply({ record: { plan: { actions: [{ type: 'UPDATE_SELLER_FACTS', facts: { opt_out: 'stop_requested' } }, { type: 'SUPPRESS', cancel_pending: true }] } }, inbound: { id: 'i1', thread_key: TK } }, {
    now: NOW, readSwitch: async () => null, cancelPending: async (a) => { cancelled.push(a); return { ok: true, cancelled_count: 2 } },
    insertQueueRow: async () => { throw new Error('must not enqueue') }, insertRecord: async () => { throw new Error('must not write a record') },
  })
  assert.deepEqual([r.status, r.cancel_result], ['suppressed', { ok: true, cancelled_count: 2 }])
  assert.deepEqual([cancelled[0].thread_key, cancelled[0].policy, cancelled[0].reason], [TK, 'compliance_terminal', 'stop_request'])
})

// ── 8.5.16 held-out evaluation fixes (fixtures are new phrasings, not the held-out texts) ──
test('eval fix 1: disinterest and ownership denial run BEFORE the language gate; missing language + English text is English', () => {
  const sellQ = [m('o1', 'outbound', 'Would you consider selling the place?', 20, 'consider_selling')]
  const p = plan([...sellQ, m('i1', 'inbound', 'Not looking to sell, thanks', 1)], { language: null })
  assert.deepEqual(types(p), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.AI_GENERATED_REPLY])
  const es = plan([...sellQ, m('i1', 'inbound', 'No gracias, no está a la venta', 1)], { language: 'es', judgment: { intent: 'not_interested', confidence: 0.92, outcome: 'NO_RESPONSE' } })
  assert.deepEqual(types(es), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.NO_RESPONSE], 'the nurture is scheduled; only the text is language-gated')
  const own = plan([m('o1', 'outbound', 'Is 4 Oak St yours?', 20, 'ownership_check'), m('i1', 'inbound', 'no', 1)], { language: null })
  assert.deepEqual(types(own), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.NO_RESPONSE])
  const hello = plan([m('o1', 'outbound', 'Do you still own 4 Oak St?', 20, 'ownership_check'), m('i1', 'inbound', 'yes that is mine', 1)], { language: null })
  assert.notEqual(hello.actions.at(-1).reason, 'language:language_unknown')
})

test('eval fix 2: a close knows the follow-up is scheduled; false no-contact promises and long closes are refused', async () => {
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', 'nope', 1)] })
  const opts = { ledger: L, objective: 'close_no_question', category: 'not_interested_close', followupScheduled: { kind: 'nurture_30_day', days: 30 } }
  for (const t of ["No problem. I won't bother you again.", 'Got it, we will leave you be.', "Understood, I won't reach out again.", "No worries, I'll take you off our list.", "Thanks. We won't take more of your time.", 'All good, I will close this out on my end.']) {
    assert.ok(checkComposedText(t, opts).includes('close:false_no_contact_promise_with_followup_scheduled'), t)
  }
  assert.ok(checkComposedText('No problem at all. Thanks for the reply. Have a great week.', opts).includes('close:more_than_two_sentences'))
  assert.deepEqual(checkComposedText('No problem at all, thanks for letting me know. If anything changes down the road, I am around.', opts), [])
  const p = buildComposePrompt({ ledger: L, inboundText: 'nope', category: 'not_interested_close', objective: 'close_no_question', tone: 'direct', followupScheduled: { days: 30 } })
  assert.match(p.user, /check-in is scheduled in about 30 days/)
  // the pipeline passes the scheduled follow-up to the writer
  const model = fakeModel(['No problem at all, thanks for letting me know. If anything changes down the road, I am around.'])
  const out = await runConversationPipeline({ input: input([m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', 'nope', 1)]), modelClient: model, spend: spend() })
  assert.match(model.calls[0].user, /check-in is scheduled/)
  assert.equal(out.composition.ok, true)
})

test('eval fix 3 + 11: "would you ever consider", "do you currently own", "is <address> yours" and "did I reach the owner" are recognised; abbreviations do not split sentences', async () => {
  const { questionKindOf } = await import('../../src/lib/domain/conversation-ai/questions.js')
  const { sentenceCount } = await import('../../src/lib/domain/conversation-ai/playbook/v1/style-validator.js')
  assert.equal(questionKindOf({ body: 'Thanks for confirming. Would you ever consider selling 18 Pine Ave?' }), 'interest')
  assert.equal(questionKindOf({ body: 'Would you still be open to selling it?' }), 'interest')
  assert.equal(questionKindOf({ body: 'Do you currently own the house on Elm?' }), 'ownership')
  assert.equal(questionKindOf({ body: 'Is 2200 W Main St yours?' }), 'ownership')
  assert.equal(questionKindOf({ body: 'Did I reach the owner?' }), 'ownership')
  assert.equal(sentenceCount('Thanks. Would you sell 12 N. Elm St. in Dallas?'), 2)
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 18 Pine Ave?', 10, 'ownership_check'), m('i1', 'inbound', 'yes I do', 1)] })
  assert.deepEqual(checkComposedText('Thanks for confirming. Would you ever consider selling 18 Pine Ave.?'.replace('.?', '?'), { ledger: L, objective: 'interest', category: 'next_missing_fact' }), [])
})

test('eval fix 4 + 9: "who is this" / "why?" / "what can I do for you" are identity requests; ONE re-ask of the deflected question inside the identity answer', () => {
  for (const t of ['why?', 'Why do you ask', 'What can I do for you?', 'what is this about', 'Why do you want it']) {
    const p = plan([m('o1', 'outbound', 'Do you still own 9 Birch Rd?', 10, 'ownership_check'), m('i1', 'inbound', t, 1)])
    assert.equal(p.actions.at(-1).category, 'identity_answer', t)
  }
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 9 Birch Rd?', 10, 'ownership_check'), m('i1', 'inbound', 'why?', 1)] })
  assert.deepEqual(checkComposedText("We're local buyers looking at homes on your street. Do you still own 9 Birch Rd?", { ledger: L, objective: 'ownership', category: 'identity_answer' }), [])
  assert.ok(checkComposedText('Do you still own 9 Birch Rd?', { ledger: L, objective: 'ownership', category: 'identity_answer' }).some((r) => r.includes('already_asked')), 'a bare repeat is still refused')
  const L2 = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own it?', 30, 'ownership_check'), m('i0', 'inbound', 'who is this', 20), m('o2', 'outbound', "I'm a local buyer. Do you still own it?", 10, 'ownership_check'), m('i1', 'inbound', 'why', 1)] })
  assert.ok(checkComposedText("I'm a local buyer. Do you still own it?", { ledger: L2, objective: 'ownership', category: 'identity_answer' }).some((r) => r.includes('already_asked')), 'only ONE re-ask')
})

test('eval fix 5: the model verdict (≥ 0.85, not contradicted) drives denial / disinterest; "Sold" and "gave the house to my son" are former owner', () => {
  const q = [m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling')]
  const dis = plan([...q, m('i1', 'inbound', 'Probably not, I like it here', 1)], { judgment: { intent: 'not_interested', confidence: 0.9, outcome: 'NO_RESPONSE' } })
  assert.deepEqual(types(dis), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.AI_GENERATED_REPLY])
  const low = plan([...q, m('i1', 'inbound', 'Probably not, I like it here', 1)], { judgment: { intent: 'not_interested', confidence: 0.6, outcome: 'NO_RESPONSE' } })
  assert.ok(!types(low).includes(ACTIONS.SCHEDULE_FOLLOWUP), 'low confidence is not honoured')
  const contradicted = plan([...q, m('i1', 'inbound', 'Probably not, I like it here', 1)], { judgment: { intent: 'not_interested', confidence: 0.95 }, deterministic: { intent: 'seller_interested' } })
  assert.ok(!types(contradicted).includes(ACTIONS.SCHEDULE_FOLLOWUP), 'a contradicting deterministic verdict wins')
  const den = plan([m('o1', 'outbound', 'Is this the owner of 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', 'That was my uncle years ago', 1)], { judgment: { intent: 'ownership_denied', outcome: 'UPDATE_ONLY', confidence: 0.9 } })
  assert.deepEqual(types(den), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.NO_RESPONSE])
  for (const t of ['Sold', 'sold it in March', 'I gave the house to my son last year', 'The property belongs to my daughter now']) {
    const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', t, 1)] })
    assert.equal(L.facts.ownership?.value, 'former_owner', t)
    assert.deepEqual(types(plan([m('o1', 'outbound', 'Do you still own 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', t, 1)])), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.NO_RESPONSE], t)
  }
})

test('eval fix 6: targeting claims and attributions the seller did not make are refused', () => {
  const unsure = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', "I don't know honestly", 1)] })
  assert.ok(checkComposedText("Since you're confident you own 5 Ash, would you sell?", { ledger: unsure, objective: 'interest', category: 'next_missing_fact' }).some((r) => r.startsWith('ledger:unsupported_attribution')))
  const owns = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', 'yes I own it', 1)] })
  assert.deepEqual(checkComposedText('Since you own 5 Ash, would you consider selling it?', { ledger: owns, objective: 'interest', category: 'next_missing_fact' }), [])
  for (const t of ["I'm not just casting a wide net here. Would you sell?", 'You were specifically chosen. Would you sell?', "We're looking at 5 Ash specifically. Would you sell?", 'Your home was hand-picked. Would you sell?']) {
    assert.ok(validatePlaybookStyle(t).reasons.includes('style:targeting_claim'), t)
  }
})

test('eval fix 7: price contradiction is a plain HOLD in decide (no Sonnet)', () => {
  const p = plan([m('o1', 'outbound', 'What price?', 30, 'seller_asking_price'), m('i0', 'inbound', '90k', 20), m('i1', 'inbound', 'actually 300k', 1)], { judgment: { escalation_required: true, escalation_reason: 'contradiction', outcome: 'NEEDS_REVIEW', confidence: 0.8 } })
  assert.deepEqual(p.actions.at(-1), { type: ACTIONS.HOLD, reason: 'price_contradiction' })
})

test('eval fix 8: send-side scope classifies money by INTENT; a stated price lets the condition question through', async () => {
  const { classifyRoutineScope } = await import('../../src/lib/domain/conversation-ai/send-policy.js')
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'What price would you want?', 10, 'seller_asking_price'), m('i1', 'inbound', 'I would take 180k', 1)] })
  const d = { outcome: 'REPLY_CANDIDATE', intent: 'asking_price_provided', next_objective: 'get_condition', confidence: 0.95 }
  assert.equal(classifyRoutineScope({ decision: d, draftText: 'Got it, thanks. How is the condition of the house?', inboundText: 'I would take 180k', ledger: L, language: 'en' }).in_scope, true)
  assert.ok(classifyRoutineScope({ decision: { ...d, intent: 'counter_or_negotiation' }, draftText: 'Got it. How is the condition?', inboundText: 'can you do 200k?', ledger: L, language: 'en' }).reasons.includes('excluded_money_or_offer'))
  assert.ok(classifyRoutineScope({ decision: d, draftText: 'Would 150k work?', inboundText: 'I would take 180k', ledger: L, language: 'en' }).reasons.includes('excluded_money_amount'))
})

test('eval fix 10: stock openers refused; never open two consecutive turns the same way', () => {
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Do you still own 5 Ash?', 10, 'ownership_check'), m('i1', 'inbound', 'yes', 1)] })
  for (const t of ['Fair question. Would you consider selling?', 'Quick question: would you consider selling?', 'Understood, thanks for letting me know. Would you sell?']) assert.ok(validatePlaybookStyle(t).reasons.includes('style:stock_opener'), t)
  assert.ok(checkComposedText('Thanks for confirming. Would you consider selling it?', { ledger: L, objective: 'interest', category: 'next_missing_fact', previousOutbound: 'Thanks for confirming, do you still own it?' }).includes('style:repeated_opening'))
  assert.deepEqual(checkComposedText('Appreciate it. Would you consider selling it?', { ledger: L, objective: 'interest', category: 'next_missing_fact', previousOutbound: 'Thanks for confirming, do you still own it?' }), [])
})

test('eval fix 1b/10b: NULL language with Spanish words stays unknown; Spanish text is refused; openings rotate', async () => {
  const { languageVerdict } = await import('../../src/lib/domain/conversation-ai/send-policy.js')
  assert.equal(languageVerdict({ language: null, inboundText: 'Not interested in selling, thanks' }).english, true)
  assert.equal(languageVerdict({ language: null, inboundText: 'No por ahora, tengo el prestamo' }).english, false)
  assert.equal(languageVerdict({ language: null, inboundText: 'no' }).english, false, '"no" alone proves nothing')
  assert.ok(validatePlaybookStyle('Entendido, gracias por avisar.').reasons.includes('style:non_english'))
  const { openingHintFor, OPENING_HINTS } = await import('../../src/lib/domain/conversation-ai/pipeline/compose.js')
  const hints = new Set(['yes', 'no thanks', 'who is this', 'maybe later', 'not for sale', 'how much', 'sure', 'why'].map(openingHintFor))
  assert.ok(hints.size >= 3 && [...hints].every((h) => OPENING_HINTS.includes(h)))
})

test('eval fix 11b: courtesy is not flattery; stock "<ack>, thanks for letting me know" openers are refused', () => {
  assert.equal(validatePlaybookStyle('No problem, I appreciate you letting me know.').ok, true)
  assert.ok(validatePlaybookStyle('I appreciate you. Would you sell?').reasons.includes('style:flattery'))
  for (const t of ['Makes sense, thanks for letting me know.', 'Got it, thank you for letting me know.']) assert.ok(validatePlaybookStyle(t).reasons.includes('style:stock_opener'), t)
})

test('eval fix 6b: inventory claims and "won\'t take up more of your time" are refused', () => {
  assert.ok(validatePlaybookStyle("We don't have any cheap fixer uppers to share right now.").reasons.includes('style:inventory_or_capacity_claim'))
  assert.ok(validatePlaybookStyle('We have a few houses available right now.').reasons.includes('style:inventory_or_capacity_claim'))
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', 'no', 1)] })
  assert.ok(checkComposedText("Understood, we won't take up more of your time.", { ledger: L, objective: 'close_no_question', category: 'not_interested_close', followupScheduled: { days: 30 } }).includes('close:false_no_contact_promise_with_followup_scheduled'))
})

test('post-measure rules: "about X specifically", invented visits, compound questions, "leave it with them"; a rejected close keeps the follow-up and sends nothing', async () => {
  assert.ok(validatePlaybookStyle("We buy houses in the area and I reached out about 5 Ash St specifically. Would you sell?").reasons.includes('style:targeting_claim'))
  assert.ok(validatePlaybookStyle('Before we set up a time to view, what condition is it in?').reasons.includes('style:invented_next_step'))
  assert.ok(validatePlaybookStyle("What's the condition of the house, and are there any repairs?").reasons.includes('style:compound_question'))
  assert.equal(validatePlaybookStyle('Would you consider selling it, or is it not on your radar?').ok, true, 'a choice question is one question')
  const L = buildCanonicalLedger({ messages: [m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', 'no its listed', 1)] })
  assert.ok(checkComposedText("Understood, since it's with an agent we'll leave it with them.", { ledger: L, objective: 'close_no_question', category: 'not_interested_close', followupScheduled: { days: 30 } }).includes('close:false_no_contact_promise_with_followup_scheduled'))
  const bad = fakeModel(["Understood. I won't bother you again. Take care."])
  const out = await runConversationPipeline({ input: input([m('o1', 'outbound', 'Would you consider selling?', 10, 'consider_selling'), m('i1', 'inbound', 'nope', 1)]), modelClient: bad, spend: spend() })
  assert.deepEqual(out.plan.actions.map((a) => a.type), [ACTIONS.UPDATE_SELLER_FACTS, ACTIONS.SCHEDULE_FOLLOWUP, ACTIONS.NO_RESPONSE])
})
