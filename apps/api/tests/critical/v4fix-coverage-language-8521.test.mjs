// rc-8.5.21 v4 fix pass — COVERAGE + LANGUAGE GATE (S4). Written from the v4 defect DESCRIPTIONS (never the
// blind cases): every phrase below is composed from linguistic knowledge of the forms, with negatives.
//   S4  a code-switched inbound with a non-enabled-language segment never gets an English reply; the reply
//       language is the seller's DOMINANT language; a signal-less inbound ("185k") takes the thread's language
//   S4  a callback / visit request is an operator task in every language; no AI text promises a call / visit
//   cov the ask-once offer reply ("do you have a number in mind for <address>?") is in R3 scope — an address
//       is never a price; any amount stays excluded
//   cov identity / offer-request / ownership-answer / wish-to-sell recognition composed generatively
//   cov the composer knows the property's address numbers (no unsupported_number rejection for naming it)
import test from 'node:test'
import assert from 'node:assert/strict'

import { ledgerFromContextInput, buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '../../src/lib/domain/conversation-ai/property-ownership.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { composeReply } from '../../src/lib/domain/conversation-ai/pipeline/compose.js'
import { ACTIONS } from '../../src/lib/domain/conversation-ai/pipeline/outcomes.js'
import { canonicalRoutineScope } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'
import { callOrVisitPromiseReasons, validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { isDeflectionToOffer, questionKindOf } from '../../src/lib/domain/conversation-ai/questions.js'
import { dominantLanguageOf, languageEnabledFor, languageVerdict, otherLanguageMarker } from '../../src/lib/domain/conversation-ai/send-policy.js'

const T = (min) => new Date(Date.parse('2026-10-19T16:00:00Z') - min * 60_000).toISOString()
const out = (id, body, min, use_case = null) => ({ id, direction: 'outbound', body, at: T(min), use_case, property_id: 'p1' })
const inb = (id, body, min) => ({ id, direction: 'inbound', body, at: T(min), property_id: 'p1' })
const ADDR = '4417 Quarry Hollow Rd'
const S1 = out('o1', `Hi, this is Dana. Do you still own ${ADDR}?`, 300, 'ownership_check')
const S2 = [S1, inb('i1', 'yes I do', 290), out('o2', 'Would you consider selling it?', 280, 'consider_selling')]
const S3 = [...S2, inb('i2', 'yeah possibly', 270), out('o3', 'What price would you be looking for?', 200, 'seller_asking_price')]
const ES1 = out('o1', `Hola, soy Dana. ¿Todavía es dueño de ${ADDR}?`, 300, 'ownership_check')
const EN_ES = ['en', 'es']

function decide(thread, { enabledLanguages = EN_ES, judgment = { outcome: 'REPLY_CANDIDATE', confidence: 0.9, intent: 'unclear' }, language = null } = {}) {
  const last = [...thread].reverse().find((m) => m.direction === 'inbound')
  const input = { now: T(0), inbound: { id: last.id, body: last.body, at: last.at, property_id: 'p1' }, thread: thread.filter((m) => m !== last), properties: [{ property_id: 'p1', address: ADDR }], language }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const plan = decideActions({ ledger, inboundText: last.body, inboundId: last.id, eligibility: { blocked: false }, judgment, language, propertyCount: 1, thread: input.thread, inbound: input.inbound, enabledLanguages })
  return { ledger, plan, input }
}
const terminal = (p) => p.actions.find((a) => a.type !== ACTIONS.UPDATE_SELLER_FACTS && a.type !== ACTIONS.SCHEDULE_FOLLOWUP && a.type !== ACTIONS.RESEARCH_PROPERTY)
const replies = (p) => p.actions.some((a) => a.type === ACTIONS.AI_GENERATED_REPLY || a.type === ACTIONS.DETERMINISTIC_REPLY)

// ── S4: code-switched inbound ───────────────────────────────────────────────
const CODE_SWITCHED = [
  ['tl', 'Oo naman, I still own it pero ayoko pa ibenta ngayon'],
  ['tl', 'Sige po, how much po ba kayo mag offer?'],
  ['tl', 'Yes po, akin pa yung bahay'],
  ['tl', 'Salamat po but not now'],
  ['tl', 'baka pwede next month na lang, busy ako'],
  ['ht', 'Yes se kay mwen, men mwen pa konnen si m vle vann'],
  ['ht', 'Mesi, maybe later'],
  ['fr', "Oui c'est ma maison, but I'm not sure"],
  ['pt', 'Sim, é minha, but I need to think'],
  ['pt', 'Obrigado, not interested right now'],
  ['vi', 'Yes toi van con so huu, khong muon ban'],
]
for (const [code, text] of CODE_SWITCHED) {
  test(`S4: a code-switched ${code} + English inbound is never English ("${text}")`, () => {
    assert.equal(otherLanguageMarker(text), code)
    assert.equal(languageVerdict({ language: 'English', inboundText: text }).english, false)
    const v = languageEnabledFor({ language: 'English', inboundText: text, languages: EN_ES, priorInbounds: ['yes I own it'] })
    assert.equal(v.enabled, false, JSON.stringify(v))
    assert.equal(v.language, code)
    const { plan } = decide([...S2, inb('x', text, 10)], { language: 'English' })
    assert.ok(!replies(plan), JSON.stringify(plan))
    // a non-enabled language is escalated; a disinterest keeps the 30-day follow-up with NO reply text
    assert.ok([ACTIONS.ESCALATE_TO_OPERATOR, ACTIONS.NO_RESPONSE].includes(terminal(plan).type), JSON.stringify(plan))
  })
}
const PLAIN_ENGLISH = ['Yes I still own it', 'maybe, depends what you offer', 'I need to talk to my wife first', 'No thanks, not selling', 'how did you get my number', 'na im good', 'PO box 12 is my mailing address', 'Who is this?', 'Stop by anytime', 'my mom passed and I inherited it']
for (const text of PLAIN_ENGLISH) {
  test(`S4 control: plain English stays English ("${text}")`, () => {
    assert.equal(otherLanguageMarker(text), null)
    assert.equal(languageEnabledFor({ inboundText: text, languages: ['en'], priorInbounds: [] }).language, 'en')
  })
}
test('S4: Spanglish follows the Spanish evidence (never English from partial English); disabled Spanish holds', () => {
  for (const t of ['Yes es mía but no sé si quiero vender', 'ok gracias, lo voy a pensar', 'yes I own it, pero no quiero vender ahorita']) {
    assert.equal(languageEnabledFor({ inboundText: t, languages: EN_ES, priorInbounds: [] }).language, 'es', t)
    assert.equal(languageEnabledFor({ inboundText: t, languages: ['en'], priorInbounds: [] }).enabled, false, t)
  }
})
test('S4: a wholly non-English message keeps the identifier reading (Creole never enabled)', () => {
  assert.equal(languageEnabledFor({ inboundText: 'Wi, se kay mwen', languages: EN_ES }).enabled, false)
  assert.equal(languageEnabledFor({ inboundText: 'Gusto ko sana ibenta yung bahay', languages: EN_ES }).enabled, false)
})

// ── S4: dominant language ───────────────────────────────────────────────────
const SIGNAL_LESS = ['185k', 'ballpark?', '$210,000', 'oak', '??', '👍', 'ok', '2', 'the 2nd one']
for (const t of SIGNAL_LESS.slice(0, 8)) {
  test(`dominant: a signal-less inbound ("${t}") takes the seller's thread language`, () => {
    assert.equal(dominantLanguageOf({ inboundText: t, priorInbounds: ['yes I still own it', 'maybe if the price is right'] }).language, 'en')
    assert.equal(dominantLanguageOf({ inboundText: t, priorInbounds: ['Sí, es mía', 'tal vez, depende del precio'] }).language, 'es')
    // a seller who writes Tagalog: a number is still Tagalog's turn (never English)
    assert.equal(languageEnabledFor({ inboundText: t, languages: EN_ES, priorInbounds: ['Opo, akin pa po yung bahay', 'baka po, depende sa presyo'] }).enabled, false)
    // no evidence at all: unknown (held), never English
    assert.equal(dominantLanguageOf({ inboundText: t, priorInbounds: [] }).language, t === 'ok' ? 'unknown' : 'unknown')
  })
}
test('dominant: a prior bare "yes" is the seller writing English; "ok" / "no" prove nothing', () => {
  assert.equal(dominantLanguageOf({ inboundText: 'pine', priorInbounds: ['yes'] }).language, 'en')
  assert.equal(dominantLanguageOf({ inboundText: 'pine', priorInbounds: ['ok'] }).language, 'unknown')
})
test('dominant: an English line from a seller who mostly writes a non-enabled language is that language', () => {
  const v = languageEnabledFor({ inboundText: 'ok call me', languages: EN_ES, priorInbounds: ['Opo, akin pa po yung bahay', 'Hindi ko pa po alam kung ibebenta'] })
  assert.equal(v.enabled, false)
})
test('dominant (decide): "185k" after our English price question is an English S4 turn, not language_not_enabled', () => {
  const { plan } = decide([...S3, inb('x', '185k', 10)])
  assert.notEqual(plan.reasons[0], 'language_not_enabled', JSON.stringify(plan))
  assert.ok(replies(plan), JSON.stringify(plan))
})
test('dominant (decide): "ballpark?" on an English thread is the ask-once offer turn', () => {
  const { plan } = decide([...S2, inb('i2', 'yes', 270), inb('x', 'ballpark?', 10)])
  assert.equal(plan.reasons[0], 'offer_request_ask_number_once', JSON.stringify(plan))
})

// ── S4: callback / visit = operator task, every language ────────────────────
const CALLBACKS = ['can you just call me', 'call me back tomorrow after 5', 'give me a ring', 'I would rather talk on the phone', 'Can someone call me please',
  'Llámeme por favor', '¿Me pueden llamar mañana?', 'Prefiero que me llamen', 'Tawagan nyo na lang po ako', 'pa-call na lang po', 'Me liga amanhã', 'Appelez-moi demain', 'Rele m tanpri']
for (const text of CALLBACKS) {
  test(`callback: "${text}" is an operator task (requested_callback), never a reply`, () => {
    const { plan } = decide([...S2, inb('x', text, 10)])
    assert.ok(!replies(plan), JSON.stringify(plan))
    assert.equal(terminal(plan).reason, 'requested_callback', JSON.stringify(plan))
  })
}
for (const text of ["don't call me, text is fine", 'please dont call me', 'no calls please', 'wag nyo ako tawagan']) {
  test(`callback negative: "${text}" is not a callback request`, () => {
    const L = buildCanonicalLedger({ messages: [S1, inb('x', text, 10)] })
    assert.ok(!L.requests.some((r) => r.kind === 'callback'), JSON.stringify(L.requests))
  })
}
for (const text of ['Come by Saturday and take a look', 'you can swing by tomorrow', 'stop by any time and see it', 'Feel free to come over and look']) {
  test(`visit: "${text}" is an operator task (requested_visit)`, () => {
    const { plan } = decide([...S2, inb('x', text, 10)])
    assert.ok(!replies(plan))
    assert.equal(terminal(plan).reason, 'requested_visit', JSON.stringify(plan))
  })
}
const PROMISES = ['Sure, I can call you. Do you have a number in mind?', "I'll give you a call this afternoon.", 'Someone from our team will reach out by phone.', 'Saturday works for us to come take a look.',
  'We could swing by Monday to see it.', "Let's set up a call this week.", 'Claro, le llamo mañana.', 'Pasamos a verla el sábado.', 'Happy to call you whenever works.']
for (const d of PROMISES) test(`validator: a call / visit promise is rejected ("${d}")`, () => assert.deepEqual(callOrVisitPromiseReasons(d), ['commitment:call_or_visit_promise']))
for (const d of ['Do you have a number in mind for it?', 'I can look into it once I know your price. What were you hoping to get?', 'What would you call a fair price?', 'Would you consider selling it?', '¿Tiene algún precio en mente?']) {
  test(`validator control: no promise in "${d}"`, () => assert.deepEqual(callOrVisitPromiseReasons(d), []))
}

// ── coverage: the ask-once offer reply is in R3 scope ──────────────────────
function scopeOf(thread, draft, extraLedger = {}) {
  const { ledger, plan, input } = decide(thread)
  const reply = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
  assert.ok(reply, JSON.stringify(plan))
  const record = { terminal: { type: ACTIONS.AI_GENERATED_REPLY }, reply: { category: reply.category, objective: reply.objective, text: draft }, inbound_message_id: input.inbound.id, judgment: { confidence: 0.9 } }
  return canonicalRoutineScope(record, { languageEnglish: true, policy: { categories: ['next_missing_fact', 'identity_answer'], min_confidence: 0.85 }, inboundText: input.inbound.body, ledger: { ...ledger, ...extraLedger }, thread: input.thread, inbound: input.inbound })
}
const OFFER_TURN = [...S2, inb('x', 'Maybe. What would you pay for it?', 10)]
test('cov ask-once: a draft that names the property ADDRESS (digits) is in scope — an address is never a price', () => {
  const s = scopeOf(OFFER_TURN, `Fair question. Do you have a number in mind for ${ADDR}?`)
  assert.deepEqual(s.reasons, [], JSON.stringify(s))
})
for (const d of ['Would $150,000 work for you?', 'We are usually around 150k on these, what were you thinking?', 'Do you have a number in mind, maybe 150 grand?']) {
  test(`cov ask-once control: a draft with an AMOUNT stays excluded ("${d}")`, () => {
    assert.ok(scopeOf(OFFER_TURN, d).reasons.includes('excluded_offer_on_thread'))
  })
}
test('cov ask-once control: an existing offer on the thread stays excluded', () => {
  const s = scopeOf(OFFER_TURN, 'Do you have a number in mind for it?', { existing_offers: [{ id: 'so1', amount: 120000 }] })
  assert.ok(s.reasons.includes('excluded_offer_on_thread'))
})

// ── coverage: offer-request recognition ────────────────────────────────────
const OFFER_REQUESTS = ["what's the most you could pay for it", 'how much u guys offering', 'whats the max u can do', 'what are you paying per unit on a fourplex', 'give me a number', 'throw me a ballpark',
  'what kind of money are you offering', 'ballpark?', '¿Cuánto me ofrecen?', '¿Qué ofrecerían por la casa?', 'Hágame una oferta', '¿Cuál sería su oferta?', 'en cuánto la comprarían']
for (const t of OFFER_REQUESTS) test(`cov offer request: "${t}"`, () => assert.equal(isDeflectionToOffer(t), true))
for (const t of ['what do you need from me', 'how much time do I have to decide', 'what are you talking about', 'what would you need to know', 'what number is this', 'I would take 199k', 'how much do I still owe? not sure', '¿Qué necesita saber?']) {
  test(`cov offer request negative: "${t}"`, () => assert.equal(isDeflectionToOffer(t), false))
}

// ── coverage: identity questions are identity answers (never "clarification") ──
const IDENTITY = ['how did you even get my number', 'where did u get my info', 'sorry whats your name', 'and you are?', 'who wants to know', 'who is this texting me', 'do I know you',
  'have we met?', 'did we talk before?', '¿Quién habla?', '¿Con quién hablo?', '¿Cómo consiguió mi número?', 'Sí, ¿por qué pregunta?', '¿Cuál es su nombre?']
for (const t of IDENTITY) {
  test(`cov identity: "${t}" → identity_answer`, () => {
    const { plan } = decide([S1, inb('x', t, 10)])
    const r = plan.actions.find((a) => a.type === ACTIONS.AI_GENERATED_REPLY)
    assert.equal(r?.category, 'identity_answer', JSON.stringify(plan))
  })
}
for (const t of ['who is the buyer for the house next door', 'I know who you are', 'what is the name of the street']) {
  test(`cov identity negative: "${t}"`, () => {
    const L = buildCanonicalLedger({ messages: [S1, inb('x', t, 10)] })
    assert.ok(!L.requests.some((r) => r.kind === 'identity'), JSON.stringify(L.requests))
  })
}
test('cov identity: a Spanish identity answer may re-ask the open S1 question once', () => {
  const { ledger } = decide([ES1, inb('x', '¿Quién habla?', 10)])
  const v = validateOutbound(`Soy Dana, compro casas en la zona. ¿Todavía es dueño de ${ADDR}?`, { ledger, objective: 'ownership', category: 'identity_answer', establishedPersona: 'Dana', replyLanguage: 'es', knownNumbers: ['4417'] })
  assert.ok(!v.content_reasons.some((r) => r.startsWith('ledger:already_asked')), JSON.stringify(v.content_reasons))
})

// ── coverage: ownership answer forms ───────────────────────────────────────
const CONFIRMS = ['me and my brother', 'my wife and I do', "It's in my LLC but yeah", 'yes, through our family trust', 'it is under my company name', 'we do', 'yeah we still do', 'Sí, todavía la tengo', 'mi esposa y yo', 'es de mi familia']
for (const t of CONFIRMS) {
  test(`cov ownership answer: "${t}" confirms ownership (next is S2)`, () => {
    const L = buildCanonicalLedger({ messages: [S1, inb('x', t, 10)] })
    assert.equal(L.facts.ownership?.value, 'confirmed', t)
    assert.equal(L.next_missing, 'interest')
    assert.ok(!L.requests.some((r) => r.kind === 'company_identity'), JSON.stringify(L.requests))
  })
}
for (const t of ['used to', 'I used to', 'not anymore', 'no longer']) {
  test(`cov ownership answer: "${t}" to our ownership question is a former owner`, () => assert.equal(buildCanonicalLedger({ messages: [S1, inb('x', t, 10)] }).facts.ownership?.value, 'former_owner'))
}
for (const t of ['me and my brother sold it last year', 'I used to live there, my mom owns it now', 'we do not']) {
  test(`cov ownership answer negative: "${t}" is not a confirmation`, () => assert.notEqual(buildCanonicalLedger({ messages: [S1, inb('x', t, 10)] }).facts.ownership?.value, 'confirmed'))
}
test('cov ownership answer: never read without OUR ownership question', () => {
  assert.equal(buildCanonicalLedger({ messages: [out('o1', 'Thanks for the info!', 20), inb('x', 'we do', 10)] }).facts.ownership, undefined)
})

// ── coverage: a stated wish to sell is interest ────────────────────────────
for (const t of ["I'm 80 and alone now, just want it gone before winter", 'need to get rid of it honestly', "I'd sell if it made sense", 'Sí la quiero vender', 'quiero salir de esa casa lo antes posible']) {
  test(`cov interest: "${t}" is interest (the next step is the asking price)`, () => {
    const L = buildCanonicalLedger({ messages: [...S2, inb('x', t, 10)] })
    assert.equal(L.facts.seller_interest?.value, 'interested', t)
    assert.equal(L.next_missing, 'asking_price')
  })
}
for (const t of ["I don't want to sell it", 'not ready to sell', 'no la quiero vender', 'never selling, want it gone from your list']) {
  test(`cov interest negative: "${t}" is never interest`, () => assert.notEqual(buildCanonicalLedger({ messages: [...S2, inb('x', t, 10)] }).facts.seller_interest?.value, 'interested'))
}

// ── coverage: Spanish S4 questions are condition questions ─────────────────
for (const q of ['¿Cómo está la casa por dentro, necesita alguna reparación?', '¿En qué estado está la propiedad?', '¿Necesita arreglos?', '¿Qué condición tiene el techo?']) {
  test(`cov question kind: "${q}" is a condition question`, () => assert.equal(questionKindOf({ body: q }), 'condition'))
}

// ── coverage: the composer knows the property's address numbers ────────────
test('cov compose: naming the property address is not an unsupported number (the thread never spelled it)', async () => {
  const thread = [out('o1', 'Hi, this is Dana. Do you still own the house on Quarry Hollow?', 300, 'ownership_check'), inb('x', 'yes I do', 10)]
  const input = { now: T(0), inbound: { id: 'x', body: 'yes I do', at: T(10), property_id: 'p1' }, thread: thread.slice(0, 1), properties: [{ property_id: 'p1', address: ADDR }] }
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(input, { now: T(0) }), input)
  const modelClient = { decide: async () => ({ input: { message: `Thanks. Would you consider selling ${ADDR}?` }, model: 'stub', usd: 0 }) }
  const spend = { estimateUsd: () => 0.001, spentTodayUsd: () => 0, perMessageMaxUsd: 0.05, dailyMaxUsd: 1 }
  const msgs = thread.map((m) => ({ from: m.direction === 'inbound' ? 'seller' : 'us', text: m.body }))
  const ok = await composeReply({ ledger, inboundText: 'yes I do', category: 'next_missing_fact', objective: 'interest', modelClient, spend, messages: msgs, establishedPersona: 'Dana', propertyAddresses: [ADDR] })
  assert.equal(ok.ok, true, JSON.stringify(ok.attempts))
  const without = await composeReply({ ledger, inboundText: 'yes I do', category: 'next_missing_fact', objective: 'interest', modelClient, spend, messages: msgs, establishedPersona: 'Dana' })
  assert.equal(without.ok, false, 'control: an address that is not the property is still an unsupported number')
})
