// THE SHARED OUTBOUND VALIDATOR (rc-8.5.21, Phases 2 + 4). Every AI-written text is judged by
// this ONE function, wherever it is produced or re-checked:
//   pipeline/compose.js            each composition attempt (content only; one regeneration)
//   runtime/canonical.js           the decision (content + eligibility + timing)
//   ai/conversation-ai-r3-executor.js  the enqueue re-validation on FRESH state (no model call)
// Content = playbook v3 style (persona, identity, forbidden claims) + attribution + close rules +
// question rules (one useful question, the objective's question, never an answered / asked fact)
// + money / numbers / names / links / commitments (validator.js#contentClaimReasons, the same
// checks the legacy draft validator applies). Eligibility = the existing send-time contact guard
// verdict. Timing = queue/reply-timing.js (in-session rule or the recipient-zone window).
// Deterministic blocks only ADD reasons; nothing here can loosen a block.
import { validatePlaybookStyle, sentenceCount } from './playbook/v3/style-validator.js'
import { STYLE_VALIDATOR_VERSION } from './playbook/v3/style-validator.js'
import { NO_COMPANY_IDENTITY } from './company-identity.js'
import { validateProposedMessage } from './fact-ledger.js'
import { questionKindOf } from './questions.js'
import { contentClaimReasons } from './validator.js'
import { addressKeysIn, mixedAnswerTarget, propertiesNamedIn } from './property-facts.js'
import { replyLanguageOf } from './send-policy.js'

export const OUTBOUND_VALIDATOR_VERSION = 'conv-ai.outbound-validator.v2'
// blind safety eval v1 remediation: the writer-safety rules (non-owner contact, invented acknowledgement / stale seller
// time, unsupported human-review / persona-descriptor claims) for a text composed by ANY writer (writer-safety.js)
export { validateWriterSafety, nonOwnerContactReasons, detectNonOwnerStatement, threadNonOwnerReading, thirdPartyOwnerAskReasons, inventedAcknowledgementReasons, sellerWroteSinceOurLast, staleSellerTimeReasons, unsupportedIdentityClaimReasons, WRITER_SAFETY_VERSION } from './writer-safety.js'

// a promise of no further contact is false whenever a follow-up is scheduled (disinterest = 30-day follow-up)
const FALSE_NO_CONTACT_RE = /\b(?:(?:won'?t|wont|will\s+not|never|not\s+going\s+to)\s+(?:bother|contact|text|message|call|trouble|reach\s+out(?:\s+to)?|be\s+(?:bothering|contacting|texting|reaching\s+out))(?:\s+you)?(?:\s+(?:again|anymore|any\s+more|further))?|leave\s+you\s+(?:be|alone)|leave\s+it\s+(?:alone|there)|take\s+you\s+off\s+(?:our|my|the)\s+list|(?:remove|removing)\s+(?:you|your\s+number)|last\s+(?:time|message|text)\s+(?:you'?ll|we|i)|won'?t\s+(?:take|waste)\s+(?:up\s+)?(?:any\s+)?more\s+of\s+your\s+time|won'?t\s+hear\s+from\s+(?:us|me)\s+again|close\s+(?:this|it)\s+out|close\s+the\s+loop|done\s+(?:reaching|texting)\s+out|leave\s+it\s+(?:with|to)\s+(?:them|your\s+(?:agent|realtor)|the\s+(?:agent|realtor))|won'?t\s+(?:push|pursue|follow\s+up))\b/i
// rc-8.5.21 v4 (S4): the AI never promises a call, a visit or a human callback (a callback / visit
// request is an OPERATOR TASK; a text promising one denies the automation and commits a person)
const DAYS = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?'
const CALL_OR_VISIT_PROMISE_RE = new RegExp([
  String.raw`\b(?:i|we|someone|somebody|one\s+of\s+(?:us|our\s+team)|our\s+team|a\s+(?:team\s+member|rep(?:resentative)?|specialist|person|colleague)|my\s+(?:partner|colleague|manager|team))\s*(?:'ll|'d|will|can|could|shall|would(?:\s+be\s+(?:happy|glad))?|am\s+going\s+to|'m\s+going\s+to|are\s+going\s+to|'re\s+going\s+to|be\s+happy\s+to|would\s+love\s+to|(?:'m|am|'re|are)\s+(?:happy|glad)\s+to)\s+(?:to\s+)?(?:(?:give|get)\s+(?:you\s+)?a\s+(?:call|ring|buzz)|call|phone|ring|reach\s+out\s+by\s+phone|come\s+(?:by|out|over|take|see|look|check)|stop\s+by|swing\s+by|drop\s+by|visit|meet(?:\s+you)?|be\s+there|head\s+over|have\s+someone\s+(?:call|come|reach))\b`,
  String.raw`\b(?:${DAYS}|tomorrow|today|tonight|that|this\s+(?:week|weekend))\s+(?:works|would\s+work|is\s+(?:fine|great|perfect))\s+(?:for\s+(?:us|me)\s+)?(?:to\s+)?(?:come|stop|swing|drop|meet|call|visit|see|look|take)`,
  String.raw`\b(?:happy|glad|able|free)\s+to\s+(?:give\s+you\s+a\s+)?(?:call|phone|ring|come\s+(?:by|out|over)|stop\s+by|swing\s+by|visit|meet)\b`,
  String.raw`\blet'?s\s+(?:set\s+up|schedule|hop\s+on|jump\s+on|plan)\s+(?:a\s+)?(?:call|visit|walk-?through|time\s+to\s+(?:talk|meet|come))\b`,
  String.raw`\b(?:(?:le|te|lo|la|los)\s+(?:llamo|llamamos|llamar[eé]|llamaremos|marco|marcamos|marcar[eé])|(?:paso|pasamos|pasar[eé]|pasaremos|voy|vamos|iremos|podemos\s+ir|puedo\s+ir)\s+(?:a\s+)?(?:verla|verlo|ver\s+la\s+(?:casa|propiedad)|por\s+(?:all[aá]|ah[ií])|el\s+${DAYS})|alguien\s+(?:le|te)\s+(?:llamar[aá]|va\s+a\s+llamar|contactar[aá]))\b`,
].join('|'), 'i')
export function callOrVisitPromiseReasons(text) {
  return CALL_OR_VISIT_PROMISE_RE.test(String(text || '')) ? ['commitment:call_or_visit_promise'] : []
}
// "since you're confident you own it" after "I don't know": an attribution must be a STATED fact
const ATTRIBUTION_RE = /\b(?:since\s+you(?:'re|\s+are|'ve|\s+have)?|you\s+(?:said|mentioned|told\s+(?:me|us)|confirmed|noted|indicated)|as\s+you\s+(?:said|mentioned|noted)|you(?:'re|\s+are)\s+(?:confident|sure|certain))\b([^.?!,;]{0,80})/i
const ATTRIBUTION_TOPICS = [
  ['ownership', /\b(?:own|owner|yours|title)\b/i, (v) => ['confirmed', 'representative'].includes(v)],
  ['asking_price', /\b(?:price|number|asking|\$|[0-9]+k)\b/i, (v) => v != null],
  ['condition', /\b(?:repair|roof|condition|work|fix|hvac|foundation|update)\w*/i, (v) => v != null],
  // \"you mentioned maybe later in the year\" names a timeline (blind evaluation v7, Z47): still checked against the ledger
  // "you mentioned checking back after the holidays" (blind v8 Z53) names a timeline too: checked against the ledger
  ['timeline', /\b(?:close|closing|timeline|move|soon|later|month|year|week|november|december|spring|summer|fall|winter|holidays?|christmas|thanksgiving|new\s+year|school)\b/i, (v) => v != null],
  ['seller_interest', /\b(?:sell|selling|interested|open\s+to)\b/i, (v) => v != null],
]
export function unsupportedAttribution(text, ledger) {
  const m = ATTRIBUTION_RE.exec(String(text || ''))
  if (!m) return null
  const clause = `${m[0]}`
  const topics = ATTRIBUTION_TOPICS.filter(([, re]) => re.test(clause))
  if (!topics.length) return 'unsupported_attribution'
  for (const [key, , ok] of topics) {
    const f = ledger?.facts?.[key]
    if (!f || f.basis === 'inferred' || !ok(f.value)) return `unsupported_attribution:${key}`
  }
  return null
}

// blind-eval S1: "thanks for confirming / letting me know / sharing …" asserts a seller fact too
const THANKS_FOR_RE = /\b(?:thanks?|thank\s+you|appreciate(?:\s+you)?)\s+(?:you\s+)?(?:for\s+)?(?:confirming|letting\s+(?:me|us)\s+know|telling\s+(?:me|us)|sharing|clarifying|verifying)\b([^.?!;]{0,80})/i
const CONFIRM_CLAIM_RE = /\b(?:thanks?|thank\s+you|appreciate)\b[^.?!;]{0,40}\b(?:confirm\w*|verif\w*)\b|\byou(?:'ve|\s+have)?\s+(?:confirmed|verified)\b/i
export function unsupportedThanksClaim(text, ledger) {
  const m = THANKS_FOR_RE.exec(String(text || ''))
  if (!m) return null
  const topics = ATTRIBUTION_TOPICS.filter(([, re]) => re.test(m[0]))
  for (const [key, , ok] of topics) {
    const f = ledger?.facts?.[key]
    if (!f || f.basis === 'inferred' || !ok(f.value)) return `unsupported_claim:${key}`
  }
  return null
}

/**
 * blind-eval S1: what a text may say about the thread's PROPERTIES (canonical per-property facts,
 * ledger.property.ownership). HARD blocks, never loosened:
 *   - naming a property the contact DENIED, declined (unverified), or one held by an evidence
 *     conflict / an unattributed denial (thread hold)
 *   - naming a property that is not CONFIRMED for this contact, except in the ownership question
 *   - naming an address the thread does not know
 *   - "thanks for confirming …" with no confirmed property behind it (or about a property that is not
 *     the confirmed one)
 * @returns {string[]}
 */
export function propertyMentionReasons(text, ledger, { questionKind = null } = {}) {
  const po = ledger?.property?.ownership
  const r = []
  const t = String(text || '')
  if (!po) {
    if (CONFIRM_CLAIM_RE.test(t) && !['confirmed', 'representative'].includes(ledger?.facts?.ownership?.value)) r.push('property:unsupported_confirmation_claim')
    return r
  }
  const index = new Map()
  for (const [pid, keys] of Object.entries(po.address_keys || {})) for (const k of keys) index.set(k, pid)
  const named = propertiesNamedIn(t, index)
  const st = (pid) => po.by_property?.[pid]?.state || 'unknown'
  for (const pid of named) {
    const s = st(pid)
    if (s === 'denied') r.push('property:names_denied_property')
    else if (s === 'declined') r.push('property:names_declined_unverified_property')
    else if (s === 'conflict') r.push('property:names_held_property')
    else if (s !== 'confirmed' && questionKind !== 'ownership') r.push('property:names_unconfirmed_property')
    if (po.thread_hold && s !== 'confirmed') r.push('property:names_property_under_thread_hold')
  }
  // an address-like mention (≥ 2-digit house number) the thread does not know
  // a mixed per-property answer: this reply is about the ONE property the conversation continues on
  const target = mixedAnswerTarget(po)
  if (target && named.some((pid) => pid !== target.property)) r.push('property:names_property_outside_this_reply')
  const numbered = addressKeysIn(t).filter((k) => !k.startsWith('street:') && /^[0-9]{2,}\s/.test(k))
  if (numbered.some((k) => !index.has(k))) r.push('property:names_unknown_address')
  if (CONFIRM_CLAIM_RE.test(t)) {
    const confirmed = Object.entries(po.by_property || {}).filter(([, v]) => v.state === 'confirmed' && v.source === 'message').map(([pid]) => pid)
    // no property named: a stated confirmation anywhere in the thread supports it (single-property
    // threads carry no property id on their messages); a NAMED property must itself be confirmed
    const stated = ['confirmed', 'representative'].includes(ledger?.facts?.ownership?.value) && ledger.facts.ownership.basis !== 'inferred'
    if (named.length ? named.some((pid) => !confirmed.includes(pid)) : !(confirmed.length || stated)) r.push('property:unsupported_confirmation_claim')
  }
  return [...new Set(r)]
}

// blind-eval S2: ANY statement about a company (affirmative or negative: "I don't represent a
// company", "I have no company name to share") is allowed only when a company identity is configured
// AND the seller asked; any statement about automation ("I'm not a bot", "this is automated") only
// when the seller asked directly (the truthful disclosure). Never volunteered.
const COMPANY_STATEMENT_RE = /\b(?:company|companies|firm|agency|organi[sz]ation|corporation|corp\b|llc|business\s+name|brokerage|represent(?:ing)?\s+(?:a|an|any)\b)/i
const AUTOMATION_STATEMENT_RE = /\b(?:bot|robot|automated|automation|auto-?reply|ai\b|artificial\s+intelligence|real\s+person|a\s+human|not\s+human)\b/i
const COLLEAGUE_CLAIM_RE = /\b(?:colleague|co-?worker|teammate|my\s+team|our\s+team|(?:my|our)\s+(?:business\s+)?partner|works?\s+with\s+me|on\s+my\s+side|same\s+outreach|my\s+assistant|my\s+associate|(?:my|our)\s+office)\b/i
/** The seller asked one of these in the open burst (any message since our last text; RT-11 / RT-05). */
export function askedInOpenBurst(ledger, kinds) {
  const latest = ledger?.last_message?.direction === 'inbound' ? ledger.last_message.id : null
  const open = new Set([...(Array.isArray(ledger?.open_inbound_ids) ? ledger.open_inbound_ids : []), ...(latest ? [latest] : [])].map(String))
  return (ledger?.requests || []).some((q) => kinds.includes(q.kind) && (!latest || open.has(String(q.source_message_id))))
}
// Operation Hidden Gold: a truthful disclosure — the reply to "are you a bot / a real person?" must say so
// (English or Spanish); a reply that neither discloses nor denies is not an answer
export const AUTOMATION_DISCLOSURE_RE = /\b(?:ai|a\.i\.|automated|automation|assistant|virtual|software|asistente|automatizad[oa]|autom[áa]tic[oa]|inteligencia\s+artificial|ia)\b/i
export function identityStatementReasons(text, ledger, companyIdentity = NO_COMPANY_IDENTITY) {
  const t = String(text || '')
  const r = []
  const asked = (kinds) => askedInOpenBurst(ledger, kinds)
  if (COMPANY_STATEMENT_RE.test(t)) {
    if (!companyIdentity?.configured) r.push('identity:company_statement_without_configured_identity')
    else if (!asked(['company_identity', 'identity'])) r.push('identity:company_statement_not_asked')
  }
  if (AUTOMATION_STATEMENT_RE.test(t) && !asked(['automation_question'])) r.push('identity:automation_statement_not_asked')
  // blind-eval SCONV-22: an invented colleague / team story ("Alex is on my side of the same outreach")
  if (COLLEAGUE_CLAIM_RE.test(t)) r.push('identity:unverifiable_colleague_claim')
  return r
}

// blind-eval SYN-47: "Sounds good." to an asking price (a $3M ask on a $174K house) reads as acceptance.
// After a seller states a price, the text never approves it: the ask is stored, never promoted.
const PRICE_APPROVAL_RE = /\b(?:sounds?\s+(?:good|great|fair|reasonable|right|doable)|(?:that|it)(?:'s|\s+is)?\s+(?:works|fair|reasonable|doable|a\s+(?:fair|good|great)\s+(?:price|number))|that\s+works|works\s+for\s+(?:me|us)|fair\s+(?:price|number|enough)|(?:good|great|reasonable)\s+(?:price|number)|we\s+can\s+(?:do|work\s+with)\s+that|i\s+can\s+(?:do|work\s+with)\s+that|agreed|deal\b|perfect|love\s+(?:it|that))/i
export function priceApprovalReasons(text, ledger) {
  const latest = ledger?.last_message?.direction === 'inbound' ? ledger.last_message.id : null
  const priced = latest && (ledger?.facts?.asking_price?.source_message_ids || []).includes(latest)
  return priced && PRICE_APPROVAL_RE.test(String(text || '')) ? ['content:implies_acceptance_of_stated_price'] : []
}

// OWNER DECISION 2026-10-18 — native Spanish: the SAME must-not checks in Spanish (company /
// automation statements, false confirmations, price approval, false no-contact promises, persona
// name claims, invented backstory), and a reply is never in a different language than the seller's.
const ES_COMPANY_RE = /\b(?:empresa|compa[nñ][ií]a|negocio|firma|corporaci[oó]n|agencia|nombre\s+de\s+(?:la\s+)?empresa|represento\s+a)\b/i
const ES_AUTOMATION_RE = /\b(?:bot|robot|automatizad[oa]s?|autom[aá]tic[oa]|inteligencia\s+artificial|persona\s+real|ser\s+humano|humano)\b/i
const ES_CONFIRM_CLAIM_RE = /\bgracias\s+por\s+(?:confirmar|confirmarlo|confirmarme|aclarar|verificar)|\b(?:usted|t[uú])\s+(?:confirm[oó]|dijo|mencion[oó])\b/i
const ES_PRICE_APPROVAL_RE = /\b(?:suena\s+(?:bien|genial|justo|razonable)|me\s+parece\s+(?:bien|justo|razonable|perfecto)|perfecto|de\s+acuerdo|trato\s+hecho|es\s+un\s+buen\s+precio|podemos\s+hacer\s+eso)\b/i
const ES_FALSE_NO_CONTACT_RE = /\bno\s+(?:le|te|los|las)\s+(?:volver[eé]\s+a\s+)?(?:escribir|molestar|contactar|mandar)|no\s+(?:le|te)\s+molestar[eé]\s+m[aá]s|(?:lo|la|los)\s+(?:quito|quitamos|elimino|eliminamos|saco|sacamos)\s+de\s+(?:la|nuestra|mi)\s+lista|no\s+volver[aá]\s+a\s+saber\s+de\s+(?:nosotros|m[ií])\b/i
const ES_NAME_CLAIM_RE = /\b(?:[Ss]oy|[Hh]abla|[Ll]e\s+escribe|[Tt]e\s+escribe|[Mm]e\s+llamo|[Mm]i\s+nombre\s+es)\s+([A-Z][a-záéíóúñ]+)\b/g
const ES_NON_NAMES = new Set(['Un', 'Una', 'El', 'La', 'De', 'Del', 'Inversionista', 'Comprador', 'Compradora', 'Local', 'Yo'])
const ES_BACKSTORY_RE = /\b(?:crec[ií]|nac[ií]|me\s+cri[eé]|vivo\s+(?:cerca|en\s+(?:el|la)\s+(?:zona|barrio))|tengo\s+[0-9]+\s+a[nñ]os\s+(?:de\s+experiencia|en\s+el\s+negocio)|soy\s+(?:un[ao]?\s+)?(?:agente|corredor[a]?|realtor|abogad[oa]|contratista|licenciad[oa]))\b/i
export function spanishMustNotReasons(text, { ledger = null, companyIdentity = NO_COMPANY_IDENTITY, establishedPersona = null, followupScheduled = null, category = null } = {}) {
  const t = String(text || '')
  const r = []
  const latest = ledger?.last_message?.direction === 'inbound' ? ledger.last_message.id : null
  // rc-8.5.21 v3 (RT-11 / RT-05): a question in ANY message of the seller's burst since our last text counts
  const open = new Set([...(Array.isArray(ledger?.open_inbound_ids) ? ledger.open_inbound_ids : []), ...(latest ? [latest] : [])].map(String))
  const asked = (kinds) => (ledger?.requests || []).some((q) => kinds.includes(q.kind) && (!latest || open.has(String(q.source_message_id))))
  if (ES_COMPANY_RE.test(t)) {
    if (!companyIdentity?.configured) r.push('identity:company_statement_without_configured_identity')
    else if (!asked(['company_identity', 'identity'])) r.push('identity:company_statement_not_asked')
  }
  if (ES_AUTOMATION_RE.test(t) && !asked(['automation_question'])) r.push('identity:automation_statement_not_asked')
  if (/\bno\s+soy\s+(?:un[ao]?\s+)?(?:bot|robot|m[aá]quina)|\bsoy\s+(?:una\s+persona\s+real|humano|humana)\b/i.test(t)) r.push('persona:denies_automation')
  if (ES_CONFIRM_CLAIM_RE.test(t) && !['confirmed', 'representative'].includes(ledger?.facts?.ownership?.value)) r.push('property:unsupported_confirmation_claim')
  const priced = latest && (ledger?.facts?.asking_price?.source_message_ids || []).includes(latest)
  if (priced && ES_PRICE_APPROVAL_RE.test(t)) r.push('content:implies_acceptance_of_stated_price')
  if ((followupScheduled || category === 'not_interested_close') && ES_FALSE_NO_CONTACT_RE.test(t)) r.push('close:false_no_contact_promise_with_followup_scheduled')
  const persona = String(establishedPersona || '').trim().toLowerCase()
  for (const m of t.matchAll(ES_NAME_CLAIM_RE)) if (!ES_NON_NAMES.has(m[1]) && m[1].toLowerCase() !== persona) r.push('persona:name_not_established')
  if (ES_BACKSTORY_RE.test(t)) r.push('persona:invented_backstory_or_credentials')
  return [...new Set(r)]
}

/** The send-side subset (R3 re-checks it on the final text): false no-contact promise, close length, attribution. */
export function closeAndAttributionReasons(text, { ledger, category, followupScheduled = null }) {
  const r = []
  if ((followupScheduled || category === 'not_interested_close') && FALSE_NO_CONTACT_RE.test(text)) r.push('close:false_no_contact_promise_with_followup_scheduled')
  if (category === 'not_interested_close' && sentenceCount(text) > 2) r.push('close:more_than_two_sentences')
  const attr = unsupportedAttribution(text, ledger)
  if (attr) r.push(`ledger:${attr}`)
  return r
}


const openingOf = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ')
const STAGE_OBJECTIVES = new Set(['ownership', 'interest', 'asking_price', 'condition'])

/**
 * @param {string} text
 * @param {object} o
 * @param {object} o.ledger                 the canonical ledger as of the inbound
 * @param {string|null} [o.objective]        the decided objective (ownership … condition | close_no_question | none)
 * @param {string|null} [o.category]         the decided reply category
 * @param {string|null} [o.inboundIntent]
 * @param {object} [o.personaPolicy]
 * @param {string|null} [o.establishedPersona]
 * @param {object} [o.companyIdentity]
 * @param {object|null} [o.followupScheduled]
 * @param {string|null} [o.previousOutbound]
 * @param {number[]} [o.offerAmounts]
 * @param {string[]} [o.knownNumbers]       numbers that appear in the thread (addresses …)
 * @param {string|null} [o.firstName]
 * @param {string[]} [o.otherNames]         names that must never appear (owners other than the seller)
 * @param {object|null} [o.eligibility]     dryRunEligibility() (guard + timing); omitted ⇒ content only
 * @param {object|null} [o.timing]          evaluateReplyTiming() result (overrides eligibility.timing)
 * @returns {{ ok: boolean, status: 'validated'|'rejected', reasons: string[], content_reasons: string[], eligibility_reasons: string[], timing_reasons: string[], question_kind: string, version: string, style_version: string }}
 */
export function validateOutbound(text, { ledger = null, objective = null, category = null, inboundIntent = null, personaPolicy = { allow_established_persona: true }, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY, followupScheduled = null, previousOutbound = null, offerAmounts = [], knownNumbers = [], firstName = null, otherNames = [], eligibility = undefined, timing = undefined, replyLanguage = 'en' } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const content = []
  if (!t) content.push('empty_composition')
  for (const r of validatePlaybookStyle(t, { personaPolicy, establishedPersona, companyIdentity }).reasons) if (!(replyLanguage === 'es' && (r === 'style:non_english_characters' || r === 'style:non_english'))) content.push(r)
  for (const r of spanishMustNotReasons(t, { ledger, companyIdentity, establishedPersona, followupScheduled, category })) content.push(r)
  // the reply is in the seller's language: never an English reply to a Spanish seller (no fallback), never the reverse
  const draftLang = t ? replyLanguageOf({ inboundText: t }) : null
  if (replyLanguage === 'es' && draftLang === 'en') content.push('language:reply_not_in_seller_language')
  if (replyLanguage === 'en' && draftLang === 'es') content.push('language:reply_not_in_seller_language')
  if ((followupScheduled || category === 'not_interested_close') && FALSE_NO_CONTACT_RE.test(t)) content.push('close:false_no_contact_promise_with_followup_scheduled')
  if (category === 'not_interested_close' && sentenceCount(t) > 2) content.push('close:more_than_two_sentences')
  const attr = unsupportedAttribution(t, ledger)
  if (attr) content.push(`ledger:${attr}`)
  const thanks = unsupportedThanksClaim(t, ledger)
  if (thanks) content.push(`ledger:${thanks}`)
  for (const r of identityStatementReasons(t, ledger, companyIdentity)) content.push(r)
  // Operation Hidden Gold: an identity answer to an automation question MUST disclose (never claim to be human)
  if (category === 'identity_answer' && askedInOpenBurst(ledger, ['automation_question']) && !AUTOMATION_DISCLOSURE_RE.test(t)) content.push('identity:automation_question_unanswered')
  for (const r of priceApprovalReasons(t, ledger)) content.push(r)
  for (const r of callOrVisitPromiseReasons(t)) content.push(r)
  if (previousOutbound && openingOf(previousOutbound) && openingOf(previousOutbound) === openingOf(t)) content.push('style:repeated_opening')
  const cc = contentClaimReasons(t, { offerAmounts: [], knownNumbers, otherNames, firstName, allowedLinks: companyIdentity?.website ? [companyIdentity.website] : [] })
  // AI text never states an amount (money goes through the negotiation authority / a template)
  for (const r of cc.reasons) if (!(r === 'contains_link' && companyIdentity?.website && t.includes(companyIdentity.website))) content.push(`content:${r}`)
  const qn = (t.match(/\?/g) || []).length
  const kind = questionKindOf({ body: t })
  for (const r of propertyMentionReasons(t, ledger, { questionKind: qn ? kind : null })) content.push(r)
  if (qn) {
    for (const r of validateProposedMessage(ledger, { text: t, inboundIntent }).reasons) content.push(`ledger:${r}`)
    if (objective && STAGE_OBJECTIVES.has(objective) && kind !== objective) content.push(`off_objective:${kind}`)
    if (['close_no_question', 'none'].includes(objective) || category === 'not_interested_close') content.push('question_not_allowed_for_objective')
  }
  const eligibilityReasons = []
  const timingReasons = []
  if (eligibility !== undefined) {
    if (!eligibility) eligibilityReasons.push('eligibility_unknown')
    else if (eligibility.blocked) for (const r of eligibility.reasons?.length ? eligibility.reasons : ['blocked']) eligibilityReasons.push(`eligibility_blocked:${r}`)
  }
  const tm = timing !== undefined ? timing : eligibility?.timing
  if (timing !== undefined || eligibility !== undefined) {
    if (!tm) timingReasons.push('sending_window_unknown')
    else if (tm.lawful !== true) timingReasons.push('outside_sending_window')
  }
  const reasons = [...new Set([...content, ...eligibilityReasons, ...timingReasons])]
  return { ok: reasons.length === 0, status: reasons.length ? 'rejected' : 'validated', reasons, content_reasons: [...new Set(content)], eligibility_reasons: eligibilityReasons, timing_reasons: timingReasons, question_kind: kind, version: OUTBOUND_VALIDATOR_VERSION, style_version: STYLE_VALIDATOR_VERSION }
}
