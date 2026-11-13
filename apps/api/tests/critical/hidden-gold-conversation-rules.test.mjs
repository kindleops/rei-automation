// Operation Hidden Gold (owner addendum 2026-10-27), the two conversation-rule closures:
//   F1  a bare Spanish / Portuguese STOP ("Para", "ALTO", "Basta", "Detente") is a confirmed opt-out at every reading
//       (the classification reading, the combined reading, the inbound stop request) — while a soft disinterest, a
//       "maybe later" or a conversational goodbye is NEVER an opt-out;
//   F5  "are you a bot / a real person?" is answered by the AI itself, truthfully: the decider plans an identity
//       answer flagged as an automation question, the composer is told to disclose, and the validator refuses an
//       identity answer that does not disclose (and, as before, any denial).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readStop } from '../../src/lib/domain/conversation-ai/stop-reading.js'
import { isStopRequest } from '../../src/lib/domain/conversation-ai/stop-request.js'
import { readStopLikeText, matchMultilingualOptOut } from '../../src/lib/domain/classification/multilingual-opt-out.js'
import { decideActions, AUTOMATION_QUESTION_RE } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { validateOutbound, askedInOpenBurst } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { buildComposePrompt } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { PLAYBOOK_RULES } from '../../src/lib/domain/conversation-ai/playbook/v3/index.js'

const NOW = new Date('2026-10-27T15:00:00Z')
const ago = (m) => new Date(NOW.getTime() - m * 60_000).toISOString()
const thread = (inbound) => buildCanonicalLedger({ messages: [{ id: 'o1', direction: 'outbound', body: 'Hi, this is Helen. Do you still own 12 Elm St?', at: ago(30), use_case: 'ownership_check' }, { id: 'i1', direction: 'inbound', body: inbound, at: ago(1) }], now: NOW })

test('F1: bare Spanish / Portuguese stop words are a CONFIRMED opt-out at every reading', () => {
  for (const t of ['Para', 'para.', 'ALTO', 'Alto!', 'Basta', 'Detente', 'Cancela', 'No más', 'Chega', 'PARE']) {
    assert.ok(matchMultilingualOptOut(t), `grammar: ${t}`)
    assert.equal(readStopLikeText(t).confirmed, true, `classification reading: ${t}`)
    assert.equal(readStop({ text: t }).confirmed, true, `combined reading: ${t}`)
  }
  for (const t of ['Para', 'ALTO', 'Basta', 'Detente', 'Cancela', 'No más', 'Ya no me escriban', 'no me escriba más por favor']) assert.equal(isStopRequest(t), true, `stop request: ${t}`)
})

test('F1: soft disinterest, "maybe later" and a goodbye are NEVER an opt-out (a temporary no is not a permanent stop)', () => {
  for (const t of ['not interested right now', 'maybe later', 'Not now, maybe in the spring', 'ok bye', 'Thanks, bye!', 'no gracias', 'ahorita no', 'más adelante tal vez', 'Para el verano quizás', 'I will stop by the bank later', 'Alto precio, no vendo por menos de 300k']) {
    const r = readStop({ text: t })
    assert.equal(r.confirmed, false, `confirmed: ${t} ${JSON.stringify(r)}`)
    assert.equal(readStopLikeText(t).confirmed, false, `classification confirmed: ${t}`)
    assert.equal(isStopRequest(t), false, `stop request: ${t}`)
  }
})

test('F5: an automation question (English and Spanish) is planned as an AI identity answer flagged automation_question — never an escalation, never a denial', () => {
  for (const t of ['Is this a bot?', 'are you a real person', 'Am I talking to a robot?', 'is this automated?', 'Is this AI?', 'r u a bot', 'Is this an auto text?']) {
    assert.ok(AUTOMATION_QUESTION_RE.test(t), t)
    const ledger = thread(t)
    assert.ok(askedInOpenBurst(ledger, ['automation_question']), `ledger request: ${t}`)
    const p = decideActions({ ledger, inboundText: t, inboundId: 'i1', language: 'en' })
    const a = p.actions.find((x) => x.type === 'AI_GENERATED_REPLY')
    assert.ok(a && a.category === 'identity_answer' && a.automation_question === true, `${t}: ${JSON.stringify(p.actions)}`)
    assert.ok(JSON.stringify(p).includes('automation_question_truthful_disclosure'), JSON.stringify(p))
  }
  for (const t of ['¿Eres un robot?', 'es esto un bot', 'hablo con una persona real?', '¿Es usted una máquina?']) assert.ok(AUTOMATION_QUESTION_RE.test(t), t)
  assert.ok(!AUTOMATION_QUESTION_RE.test('Are you a real estate agent?'), 'a real-estate-agent question is not an automation question')
  assert.ok(!askedInOpenBurst(thread('Are you a real estate agent?'), ['automation_question']))
})

test('F5: the validator refuses an identity answer that does not disclose, refuses a denial, and passes a truthful disclosure; the composer and the playbook carry the rule', () => {
  const ledger = thread('Is this a bot?')
  const base = { ledger, objective: 'none', category: 'identity_answer', establishedPersona: 'Helen' }
  const silent = validateOutbound("It's Helen, a local buyer. Do you still own the house on Elm St?", base)
  assert.ok(silent.content_reasons.includes('identity:automation_question_unanswered'), JSON.stringify(silent.content_reasons))
  const denial = validateOutbound("No, I'm a real person. It's Helen, a local buyer.", base)
  assert.ok(denial.content_reasons.includes('persona:denies_automation'), JSON.stringify(denial.content_reasons))
  const truthful = validateOutbound("Fair question: this number uses an AI assistant to write the texts for Helen, a local buyer, and a person on the team reads every message.", base)
  assert.ok(!truthful.content_reasons.some((r) => r.startsWith('identity:') || r.startsWith('persona:')), JSON.stringify(truthful.content_reasons))
  // not asked: an automation statement is still refused (never volunteered)
  const unasked = validateOutbound('This is an AI assistant texting for Helen. Do you still own 12 Elm St?', { ledger: thread('yes I own it'), objective: 'interest', category: 'next_missing_fact', establishedPersona: 'Helen' })
  assert.ok(unasked.content_reasons.includes('identity:automation_statement_not_asked'))
  // Spanish: the same, in the seller's language
  const es = thread('¿Eres un robot?')
  const esOk = validateOutbound('Buena pregunta: este número usa un asistente de inteligencia artificial que escribe por Helen, y una persona del equipo lee cada mensaje.', { ledger: es, objective: 'none', category: 'identity_answer', establishedPersona: 'Helen', replyLanguage: 'es' })
  assert.ok(!esOk.content_reasons.some((r) => r.startsWith('identity:') || r.startsWith('persona:')), JSON.stringify(esOk.content_reasons))
  const esDeny = validateOutbound('No soy un robot, soy una persona real.', { ledger: es, objective: 'none', category: 'identity_answer', establishedPersona: 'Helen', replyLanguage: 'es' })
  assert.ok(esDeny.content_reasons.includes('persona:denies_automation'), JSON.stringify(esDeny.content_reasons))
  const prompt = buildComposePrompt({ ledger, inboundText: 'Is this a bot?', category: 'identity_answer', objective: 'none', tone: 'neutral', establishedPersona: 'Helen' })
  assert.match(prompt.user, /AI assistant/)
  assert.match(prompt.user, /Never claim to be human/)
  assert.ok(!buildComposePrompt({ ledger: thread('yes I own it'), inboundText: 'yes I own it', category: 'next_missing_fact', objective: 'interest', tone: 'neutral' }).user.includes('They asked whether this is automated'))
  assert.ok(PLAYBOOK_RULES.some((r) => /never claim to be a human/i.test(r)))
})
