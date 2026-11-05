// OWNER DECISIONS LOCKED 2026-10-18, tested from the descriptions (new phrasings).
import test from 'node:test'
import assert from 'node:assert/strict'

import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { languageEnabledFor, normalizeSendPolicy, replyLanguageOf } from '../../src/lib/domain/conversation-ai/send-policy.js'
import { isStopRequest } from '../../src/lib/domain/conversation-ai/stop-request.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { createMemoryTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { runDueTurn } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'

const T = (min) => new Date(Date.parse('2026-10-19T17:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min) => ({ id, direction: 'outbound', body, at: T(min), property_id: 'p1' })
const inb = (id, body, min) => ({ id, direction: 'inbound', body, at: T(min), property_id: 'p1' })
const judgmentOf = (intent, id) => makeDecision({ intent, seller_interest: 'interested', outcome: 'REPLY_CANDIDATE', next_objective: 'get_asking_price', response_needed: true, proposed_message: 'x', confidence: 0.93, source_message_ids: [id], facts_extracted: [], stage_evidence: { stage: 'S3_asking_price', evidence_message_ids: [id], rationale: 'x' } })
function decide(thread, { enabledLanguages = ['en'], judgment = null, language = 'English' } = {}) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: 'p1' }, thread: thread.filter((m) => m !== last), properties: [{ property_id: 'p1', address: '61 Alder Bend Rd' }], language }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  return { ledger, plan: decideActions({ ledger, inboundText: last.body, inboundId: last.id, eligibility: { blocked: false }, judgment, language, propertyCount: 1, thread: input.thread, inbound: input.inbound, enabledLanguages }) }
}
const OWN = (min) => out('o1', 'Hi Marta, this is Helen. Do you still own 61 Alder Bend Rd?', min)

// ── 1. offer before price ──
test('offer before price: "What would you pay?" with no number asked yet ⇒ ask ONCE whether they have a number in mind (no amount, no fabricated offer)', () => {
  const thread = [OWN(90), inb('i0', 'yes I do', 80), out('o2', 'Would you ever consider selling it?', 60), inb('i1', 'Possibly. How much would you pay for it?', 2)]
  const { plan, ledger } = decide(thread, { judgment: judgmentOf('asks_offer', 'i1') })
  const reply = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.deepEqual([reply?.objective, reply?.offer_request], ['asking_price', true], JSON.stringify(plan.actions))
  assert.ok(!plan.actions.some((a) => a.type === ACTIONS.PREPARE_OFFER))
  // the validator never lets an amount through
  const v = validateOutbound('I could do $95,000. Does that work?', { ledger, objective: 'asking_price', category: 'next_missing_fact' })
  assert.ok(v.content_reasons.some((r) => /monetary|number/.test(r)), JSON.stringify(v.content_reasons))
})

test('offer before price: after we asked (or they deflected) an asking price is NOT required — property research, then the authorization-gated offer (no price without an envelope); never a re-ask', () => {
  const thread = [OWN(90), inb('i0', 'yes', 80), out('o2', 'Do you have a price in mind for it?', 60, 'seller_asking_price'), inb('i1', 'Not really, what would you pay?', 2)]
  const { plan, ledger } = decide(thread, { judgment: judgmentOf('asks_offer', 'i1') })
  assert.deepEqual(plan.actions.filter((a) => [ACTIONS.RESEARCH_PROPERTY, ACTIONS.PREPARE_OFFER].includes(a.type)).map((a) => a.type), [ACTIONS.RESEARCH_PROPERTY, ACTIONS.PREPARE_OFFER])
  assert.ok(!plan.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY), 'never re-asks the price')
  const v = validateOutbound('Do you have a number in mind?', { ledger, objective: 'asking_price', category: 'next_missing_fact' })
  assert.ok(v.content_reasons.some((r) => /already_asked|never_reask|offer_requested_after_price_ask/.test(r)), JSON.stringify(v.content_reasons))
})

// ── 2. Spanish ──
test('Spanish: the language comes from the INBOUND text; enabled ONLY through the send-policy languages setting (born English-only); Creole is never enabled', () => {
  assert.equal(replyLanguageOf({ language: 'English', inboundText: 'Sí, es mía' }), 'es')
  assert.equal(replyLanguageOf({ language: 'English', inboundText: 'Wi se kay mwen' }), 'unknown')
  assert.deepEqual(normalizeSendPolicy(null).languages, ['en'], 'born off')
  const on = normalizeSendPolicy(JSON.stringify({ enabled: false, languages: ['en', 'es'] })).languages
  assert.deepEqual(on, ['en', 'es'])
  assert.equal(languageEnabledFor({ inboundText: 'Sí, todavía es mía', languages: on }).enabled, true)
  assert.equal(languageEnabledFor({ inboundText: 'Sí, todavía es mía', languages: ['en'] }).enabled, false)
  assert.equal(languageEnabledFor({ inboundText: 'Wi, se kay mwen', languages: on }).enabled, false)
  const es = [out('o1', 'Hola Marta, soy Helen. ¿Todavía es dueña de 61 Alder Bend Rd?', 60), inb('i1', 'Sí, todavía es mía', 2)]
  const offPlan = decide(es, { enabledLanguages: ['en'] }).plan
  assert.ok(offPlan.actions.some((a) => a.type === ACTIONS.ESCALATE_TO_OPERATOR && a.reason === 'language_not_enabled'), 'disabled ⇒ hold, never English')
  const onPlan = decide(es, { enabledLanguages: on }).plan
  const reply = onPlan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.ok(reply, JSON.stringify(onPlan.actions))
  assert.equal(onPlan.reply_language, 'es')
  const ht = decide([out('o1', 'Bonjou, ou se pwopriyetè kay la?', 60), inb('i1', 'Wi se kay mwen', 2)], { enabledLanguages: on }).plan
  assert.ok(ht.actions.some((a) => a.type === ACTIONS.ESCALATE_TO_OPERATOR && a.reason === 'language_not_enabled'))
})

test('Spanish validation: a Spanish draft passes in Spanish; an English draft to a Spanish seller is refused (no English fallback); the SAME must-not checks hold in Spanish', () => {
  const es = [out('o1', 'Hola Marta, soy Helen. ¿Todavía es dueña de 61 Alder Bend Rd?', 60), inb('i1', 'Sí, todavía es mía', 2)]
  const { ledger } = decide(es, { enabledLanguages: ['en', 'es'] })
  const good = validateOutbound('Gracias, Marta. ¿Consideraría vender la propiedad algún día?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es', establishedPersona: 'Helen' })
  assert.ok(!good.content_reasons.some((r) => r.startsWith('language:') || r.startsWith('style:non_english')), JSON.stringify(good.content_reasons))
  const english = validateOutbound('Thanks Marta. Would you ever consider selling the property?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es' })
  assert.ok(english.content_reasons.includes('language:reply_not_in_seller_language'))
  const company = validateOutbound('Soy Helen y no represento a ninguna empresa. ¿Consideraría vender?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es', establishedPersona: 'Helen' })
  assert.ok(company.content_reasons.includes('identity:company_statement_without_configured_identity'), JSON.stringify(company.content_reasons))
  const persona = validateOutbound('Soy María, compradora local. ¿Consideraría vender?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es', establishedPersona: 'Helen' })
  assert.ok(persona.content_reasons.includes('persona:name_not_established'), JSON.stringify(persona.content_reasons))
  const bot = validateOutbound('No soy un robot, soy una persona real. ¿Consideraría vender?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es' })
  assert.ok(bot.content_reasons.includes('identity:automation_statement_not_asked'))
  const close = validateOutbound('Entendido, no le volveré a escribir.', { ledger, category: 'not_interested_close', objective: 'close_no_question', replyLanguage: 'es', followupScheduled: { days: 30 } })
  assert.ok(close.content_reasons.includes('close:false_no_contact_promise_with_followup_scheduled'))
  assert.ok(!validateOutbound('Gracias — ¿consideraría vender?', { ledger, objective: 'interest', category: 'next_missing_fact', replyLanguage: 'es' }).ok, 'no em dash in Spanish either')
})

test('Spanish STOP / opt-out forms suppress immediately', () => {
  for (const t of ['Ya no me escriban', 'No me manden más mensajes', 'Basta', 'ALTO', 'no me escriba más por favor']) assert.equal(isStopRequest(t), true, t)
})

// ── 4. STP-09 ──
test('STP-09: "can you stop by Thursday at 3" is never a stop; it is a visit request ⇒ an operator task (escalation raises an operator item before the decision is recorded)', async () => {
  assert.equal(isStopRequest('can you stop by Thursday at 3'), false)
  assert.equal(isStopRequest('stop by if you want, but stop texting me'), true, 'a real stop in the same message still wins')
  const { plan, ledger } = decide([OWN(90), inb('i0', 'yes', 80), out('o2', 'Would you consider selling it?', 60), inb('i1', 'maybe, can you stop by Thursday at 3 to see it?', 2)])
  assert.ok(ledger.requests.some((r) => r.kind === 'visit_request'))
  assert.ok(plan.actions.some((a) => a.type === ACTIONS.ESCALATE_TO_OPERATOR && a.reason === 'requested_visit'), JSON.stringify(plan.actions))
  assert.ok(!plan.actions.some((a) => a.type === ACTIONS.SUPPRESS))
  // the turn engine raises the operator task for any escalation
  const store = createMemoryTurnStore({ now: () => Date.parse(T(0)) })
  const o = await store.open({ thread_key: '+16125550133', inbound_id: 'i1', inbound_at: T(5), due_at: T(1) })
  const items = []
  const r = await runDueTurn({ turn_id: o.turn_id, version: 1, store, worker: 'w1', decideTurn: async () => ({ code: 'ESCALATE_TO_OPERATOR', reason: 'requested_visit', outcome: 'escalate_to_operator' }), raiseOperatorItem: async (h) => { items.push(h); return { ok: true } } })
  assert.equal(r.code, 'TURN_DECIDED_SHADOW')
  assert.deepEqual(items.map((i) => [i.reasons[0], i.escalated_by_decision]), [['requested_visit', true]])
})
