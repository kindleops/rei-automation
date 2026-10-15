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
  assert.equal(r.playbook_version, PLAYBOOK_VERSION)
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
  const r = await executeAiConversationReply({ plan: { actions: [{ type: 'UPDATE_SELLER_FACTS', facts: { opt_out: 'stop_requested' } }, { type: 'SUPPRESS', cancel_pending: true }] }, inbound: { id: 'i1', thread_key: TK } }, {
    now: NOW, readSwitch: async () => null, cancelPending: async (a) => { cancelled.push(a); return { ok: true, cancelled_count: 2 } },
    insertQueueRow: async () => { throw new Error('must not enqueue') }, insertRecord: async () => { throw new Error('must not write a record') },
  })
  assert.deepEqual([r.status, r.cancel_result], ['suppressed', { ok: true, cancelled_count: 2 }])
  assert.deepEqual([cancelled[0].thread_key, cancelled[0].policy, cancelled[0].reason], [TK, 'compliance_terminal', 'stop_request'])
})
