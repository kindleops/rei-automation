// R3 AI SEND POLICY (8.5.16) — pure, OFF by default, SEPARATE from template auto-reply.
//
// Two system_control keys, both absent in production:
//   ai_conversation_send_enabled   the KILL SWITCH. Only the string 'true' (trimmed, any case) is on;
//                                  absent / false / anything else = OFF. Read at enqueue
//                                  (R3 executor) AND by the queue runner for every
//                                  ai_conversation row (off ⇒ the row is cancelled).
//   ai_conversation_send_policy    JSON policy. Absent / malformed ⇒ DEFAULT (enabled:false).
//
// Turning template auto-reply on never turns AI sends on, and vice versa
// (auto_reply_mode / followup_automation_mode / sms_templates are not read here).
//
// Scope: routine categories only —
//   next_missing_fact     an S1–S4 question for exactly the ledger's next missing fact
//   identity_answer       "who is this?" answered (optionally re-asking the open S1/S2 question once)
//   not_interested_close  a graceful close with NO question
//   no_response           NO_RESPONSE (nothing is enqueued)
// Excluded (held for a human): money / offers, financial claims, legal / contract,
// negotiation, multi-property, Spanish (and any language not positively English).
import { questionCount, moneyMentions } from './validator.js'
import { identifyReplyLanguage } from '../classification/seller-reply-language.js'
import { STATIC_PERMANENT_EXCLUSIONS, isOwnerHandledThread as staticIsOwnerHandledThread } from '@/lib/domain/holds/automation-hold-core.js'

export const AI_SEND_POLICY_VERSION = 'conv-ai.send-policy.v1'
export const AI_SEND_KILL_SWITCH_KEY = 'ai_conversation_send_enabled'
export const AI_SEND_POLICY_KEY = 'ai_conversation_send_policy'
export const AI_CONVERSATION_SOURCE = 'ai_conversation'
export const INBOUND_REPLY_RESERVATION_SCOPE = 'inbound_reply'

// rc-8.5.21 (Phase 6): the R3 executor is WIRED — the conversation.turn job dispatches a
// send-ready canonical reply through it (ai/conversation-turn-wiring.js). It remains OFF behind
// the existing switches: the kill switch (absent ⇒ off), the AI send policy (absent ⇒ disabled,
// empty scope ⇒ nothing in scope), the env gates of the runtime kinds, and the DB arming. With
// the switch absent the template engine runs exactly as today (coexistence: ai_send_switch_off).
export const R3_EXECUTOR_WIRED = true

// owner limits (8.5.15 spec): a policy row can tighten them, never loosen them
export const AI_SEND_HARD_LIMITS = Object.freeze({ max_per_day_global: 25, max_per_seller_per_day: 1 })

// OWNER DECISION 2026-10-14 (permanent): the thread at 3746 Baltimore Ave is owner-handled —
// R3 never touches it. ONE HOLD AUTHORITY (P0 2026-10-16): the list now lives in
// lib/domain/holds/automation-hold.js (STATIC_PERMANENT_EXCLUSIONS), where it applies to EVERY
// capability (template auto-reply, follow-ups, campaigns, acceptance, closing, manual sends), not only
// the AI paths. These names stay exported for the existing AI callers; reversible holds (Hartford) are
// read from public.automation_holds by resolveAutomationHold, which the AI executor also consults.
export const OWNER_HANDLED_THREAD_SHA256 = Object.freeze(STATIC_PERMANENT_EXCLUSIONS.map((x) => x.thread_key_sha256))
export const OWNER_HANDLED_ADDRESS_PREFIXES = Object.freeze(STATIC_PERMANENT_EXCLUSIONS.map((x) => x.address_prefix))
export function isOwnerHandledThread({ thread_key = null, property_address = null } = {}) {
  return staticIsOwnerHandledThread({ thread_key, property_address })
}

export { STOP_REQUEST_RE, isStopRequest } from './stop-request.js'
import { isStopRequest } from './stop-request.js'

export const ROUTINE_CATEGORIES = Object.freeze(['next_missing_fact', 'identity_answer', 'not_interested_close', 'no_response'])
// rc-8.5.21: categories the canonical writer can produce that a policy must list EXPLICITLY (they
// are never part of the default category set)
export const OPT_IN_CATEGORIES = Object.freeze(['conditional_interest_clarify', 'clarification'])
// link #32: AGENT-INITIATED messages (Action Gateway queue_agent_message) — a policy must list each EXPLICITLY too; the
// AI row gate cancels an agent message whose category the policy does not list
export const AGENT_OUTBOUND_POLICY_CATEGORIES = Object.freeze(['first_touch', 'reengage', 'followup'])
const ALLOWED_POLICY_CATEGORIES = [...ROUTINE_CATEGORIES, ...OPT_IN_CATEGORIES, ...AGENT_OUTBOUND_POLICY_CATEGORIES]

export const DEFAULT_AI_SEND_POLICY = Object.freeze({
  policy_version: AI_SEND_POLICY_VERSION,
  enabled: false,
  // empty scope = NOTHING in scope (there is no "everyone" default)
  scope: Object.freeze({ thread_keys: Object.freeze([]), market_ids: Object.freeze([]), campaign_ids: Object.freeze([]) }),
  languages: Object.freeze(['en']),
  categories: ROUTINE_CATEGORIES,
  limits: AI_SEND_HARD_LIMITS,
  hours: Object.freeze({ start_local_hour: 8, end_local_hour: 21 }),
  min_confidence: 0.85,
})

const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [])
const clampInt = (v, max) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : max
}

/** Only the exact string / boolean true turns the switch on. */
export function parseKillSwitch(raw) {
  if (raw === true) return true
  return String(raw ?? '').trim().toLowerCase() === 'true'
}

/** Malformed / missing ⇒ the safe default. Limits never exceed the owner's. */
export function normalizeSendPolicy(raw = null) {
  let row = raw
  if (typeof raw === 'string') {
    try { row = JSON.parse(raw) } catch { row = null }
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return DEFAULT_AI_SEND_POLICY
  const scope = row.scope && typeof row.scope === 'object' ? row.scope : {}
  const limits = row.limits && typeof row.limits === 'object' ? row.limits : {}
  const hours = row.hours && typeof row.hours === 'object' ? row.hours : {}
  const start = clampInt(hours.start_local_hour ?? 8, 23)
  const end = clampInt(hours.end_local_hour ?? 21, 24)
  return Object.freeze({
    policy_version: AI_SEND_POLICY_VERSION,
    enabled: row.enabled === true,
    scope: Object.freeze({ thread_keys: arr(scope.thread_keys), market_ids: arr(scope.market_ids), campaign_ids: arr(scope.campaign_ids) }),
    // OWNER DECISION 2026-10-18: native Spanish is approved through THIS setting (born ['en']:
    // production sending stays English-only until the row lists 'es'). Any other language is never
    // enabled here, and there is no automatic English fallback.
    languages: Object.freeze([...new Set(['en', ...arr(row.languages).map((l) => String(l).trim().toLowerCase()).filter((l) => ALLOWED_POLICY_LANGUAGES.includes(l))])]),
    categories: Object.freeze(arr(row.categories).filter((c) => ALLOWED_POLICY_CATEGORIES.includes(c)).length ? arr(row.categories).filter((c) => ALLOWED_POLICY_CATEGORIES.includes(c)) : ROUTINE_CATEGORIES),
    limits: Object.freeze({
      max_per_day_global: clampInt(limits.max_per_day_global ?? AI_SEND_HARD_LIMITS.max_per_day_global, AI_SEND_HARD_LIMITS.max_per_day_global),
      max_per_seller_per_day: clampInt(limits.max_per_seller_per_day ?? AI_SEND_HARD_LIMITS.max_per_seller_per_day, AI_SEND_HARD_LIMITS.max_per_seller_per_day),
    }),
    // never wider than 08–21 recipient-local
    hours: Object.freeze({ start_local_hour: Math.max(8, start), end_local_hour: Math.min(21, end) }),
    min_confidence: Math.max(0.85, Number(row.min_confidence) || 0.85),
  })
}

/** Is this thread inside the policy's explicit scope? Empty scope ⇒ false. */
export function threadInPolicyScope(policy, { thread_key = null, market_id = null, campaign_id = null } = {}) {
  const s = policy?.scope || {}
  if (thread_key && arr(s.thread_keys).includes(String(thread_key))) return true
  if (market_id && arr(s.market_ids).includes(String(market_id))) return true
  if (campaign_id && arr(s.campaign_ids).includes(String(campaign_id))) return true
  return false
}

// words that are English and NOT also Spanish ("no", "a", "ok" are shared and prove nothing)
const ENGLISH_WORD_RE = /\b(?:the|you|u|ur|your|it|is|are|r|not|yes|yeah|yep|yup|nope|my|me|we|us|our|this|that|these|those|who|what|which|when|where|why|how|with|for|from|of|and|or|but|if|so|just|still|also|actually|really|about|any|some|all|do|does|did|can|could|would|will|should|was|were|been|be|am|has|had|get|got|want|need|know|think|sell|selling|sold|own|owner|owned|house|home|property|place|rental|rent|tenant|company|price|offer|cash|much|many|more|less|interested|thanks|thank|please|stop|sorry|okay|sure|wrong|number|maybe|later|now|today|tomorrow|week|month|year|call|text|have|don'?t|doesn'?t|didn'?t|can'?t|won'?t|i'?m|i'?ll|i'?d|it'?s|thats|already|here|there|again|right|good|great|fine|well|ok)\b/i
const SPANISH_STOPWORD_RE = /\b(?:el|la|los|las|del|que|por|para|con|mi|tengo|pero|esta|muy|bien|estoy|tiene|usted|vendo|vender|ahora|gracias|hola|casa|propiedad|soy|somos|quiero|puedo|tambi[eé]n|todav[ií]a|seguro|claro|bueno|nada|algo)\b/i
const SPANISH_RE = /[¿¡ñ]|\b(?:hola|gracias|vender|casa|propiedad|cu[aá]nto|usted|s[ií]\s+(?:soy|es)|no\s+estoy|due[nñ]o|oferta|precio|quien\s+es|qui[eé]n)\b/i
const FINANCIAL_RE = /\b(?:mortgage|loan|lien|equity|owe|payoff|refinanc\w*|bank|credit|financ\w*|interest\s+rate|taxes?|appraisal|cash\s+offer|proof\s+of\s+funds|closing\s+costs?|commission)\b/i
const LEGAL_CONTRACT_RE = /\b(?:contract|agreement|sign|signature|attorney|lawyer|legal|title\s+company|escrow|deed|probate|court|lawsuit|sue|purchase\s+agreement|binding|earnest)\b/i
const NEGOTIATION_RE = /\b(?:counter|lowest|highest|best\s+(?:offer|price)|meet\s+(?:me\s+)?in\s+the\s+middle|firm|negotiat\w*|come\s+up|go\s+(?:up|higher|lower)|other\s+offers?|another\s+buyer)\b/i
const MULTI_PROPERTY_RE = /\b(?:(?:both|all|several|multiple|two|three|other)\s+(?:of\s+(?:my|the)\s+)?(?:properties|houses|homes|lots|units|addresses)|i\s+(?:own|have)\s+(?:a\s+few|several|multiple|[0-9]+)\s+(?:properties|houses|homes)|which\s+(?:property|house|one))\b/i
// money turns are classified by INTENT (an offer request / a negotiation), never by an amount
// being present in the seller's text: a stated asking price is recorded and the owner's flow
// then asks the condition (S3 price, then S4 condition). Our OWN text still carries no amount.
const MONEY_INTENTS = new Set(['asks_offer', 'counter_or_negotiation'])
const NEVER_INTENTS = new Set(['opt_out', 'hostile_or_legal', 'wrong_number', 'ownership_denied', 'tenant_or_occupant', 'listed_or_sold', 'non_owner_referral', 'multi_property', 'counter_or_negotiation', 'language_switch'])
const STAGE_OBJECTIVES = Object.freeze({ confirm_ownership: 'ownership', gauge_interest: 'interest', get_asking_price: 'asking_price', get_condition: 'condition' })

/** Is the language POSITIVELY English? Unknown is unknown (held), never assumed English. */
// blind-eval v2 (SPA-01 "Sí, es mía", LNG-04 Haitian Creole): a stored "English" label sent both an
// English reply. Owner rule: an unknown language is UNKNOWN, never English. The INBOUND TEXT decides:
//   1. the shared reply-language identifier names a language ⇒ that language
//   2. any non-English marker in the text (accented / non-Latin letters, Spanish words) ⇒ not English
//   3. English words in the text ⇒ English (a stored English label then only confirms it)
//   4. a bare universal token ("ok", "no", "k") counts as English ONLY with a stored English label
//   5. otherwise unknown (held), whatever the stored label says
const UNIVERSAL_TOKEN_RE = /^\s*(?:ok(?:ay)?|k|no|nah|yes|ya|y|n|\?+|!+)\s*[.!?]*\s*$/i
const NON_ENGLISH_LETTER_RE = /[\u00C0-\u024F\u0370-\uFFFF]/
const stripSymbols = (t) => String(t || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D\u2019\u2018\u201C\u201D]/gu, '')
export const ALLOWED_POLICY_LANGUAGES = Object.freeze(['en', 'es'])
const SPANISH_LETTER_RE = /[áéíóúñü¿¡]/i
const OTHER_ROMANCE_LETTER_RE = /[àèìòùâêîôûçãõë]/i
const PORTUGUESE_RE = /\b(?:sim|n[aã]o|obrigad[oa]|voc[eê]|minha|meu|propriedade|vender\s+a)\b/i

// rc-8.5.21 v4 (S4, code-switch): words of languages the policy can NEVER enable. A message that carries
// them is that language (mixed with English or not): "Pwede po ba tawagan nyo na lang ako? … mag text"
// was read as English from its English words and got an autonomous English reply. STRONG = one token
// names the language; WEAK = two are needed (short words other languages share).
const W = (words) => new RegExp(`(?<![\\p{L}'])(?:${words})(?![\\p{L}])`, 'giu')
const OTHER_LANGUAGE_LEXICON = Object.freeze([
  { code: 'tl', strong: W('po(?!\\s*box)|opo|nyo|niyo|ninyo|naman|nalang|na\\s+lang|pwede|puwede|pwd|salamat|yung|iyong|tawag(?:an|in)|ibenta|ibebenta|benta(?:han)?|bahay|kayo|talaga|ngayon|ngayong|ako|akong|sige|kasi|lang|wag|huwag|bakit|sino|magkano|kailan|paano'), weak: W('ko|mo|na|ba|oo|ano|mga|baka|wala|meron|sila|siya|kami|nga|eh|mag|hirap|hindi|gusto|din|rin|ang|ng') },
  { code: 'ht', strong: W('mwen|konnen|poukisa|kounye\\s?a|bezwen|mesi|ank[oò]|kisa|pitit|tanpri'), weak: W('nou|vle|vann|kay|pa|se|sa|men|m') },
  { code: 'pt', strong: W('obrigad[oa]|voc[eê]|n[aã]o|minha|tamb[eé]m|im[oó]vel|vend[eê]-?la|vender\\s+a\\s+casa'), weak: W('sim|meu|casa|ela|ele|isso|t[aá]') },
  { code: 'fr', strong: W("merci|oui|je|j'ai|j'|vous|maison|c'est|bonjour|d'accord|monsieur|madame"), weak: W('pas|est|une|mais|avec|pour|moi') },
  { code: 'it', strong: W('grazie|ciao|voglio|vendere|buongiorno|perch[eé]'), weak: W('sono|casa|non|ho') },
  { code: 'pl', strong: W('dzi[eę]kuj[eę]|dzieki|dzięki|prosz[eę]|dzien\\s+dobry|dzień\\s+dobry'), weak: W('tak|nie|dom|jest') },
  { code: 'vi', strong: W('khong|kh[oô]ng|duoc|đ[uư]ợc|cam\\s+on|c[aả]m\\s+[oơ]n|v[aâ]ng|nh[aà]'), weak: W('toi|anh|chi|em|ban') },
])
const countOf = (re, text) => (String(text || '').match(re) || []).length
/** The non-enabled language a message carries (code-switched or not), or null. */
export function otherLanguageMarker(text = '') {
  const t = stripSymbols(text)
  for (const L of OTHER_LANGUAGE_LEXICON) {
    const strong = countOf(L.strong, t)
    const weak = countOf(L.weak, t)
    if (strong >= 1) return L.code
    if (weak >= 3) return L.code
  }
  return null
}
const LETTER_WORD_RE = /\p{L}[\p{L}'-]*/gu
/** No language signal of its own: no letters, or one / two words no lexicon recognises ("185k", "ballpark?", "pine"). */
export function isSignalLessText(text = '') {
  const t = stripSymbols(text)
  if (NON_ENGLISH_LETTER_RE.test(t)) return false
  const words = t.match(LETTER_WORD_RE) || []
  if (!words.length) return true
  if (words.length > 2) return false
  if (SPANISH_RE.test(t) || SPANISH_STOPWORD_RE.test(t) || otherLanguageMarker(t)) return false
  if (ENGLISH_WORD_RE.test(t) && !UNIVERSAL_TOKEN_RE.test(t)) return false
  return !identifyReplyLanguage(t) || UNIVERSAL_TOKEN_RE.test(t)
}

/**
 * OWNER DECISION 2026-10-18: the seller's language from the INBOUND evidence — 'en', 'es', another
 * identified language, or 'unknown'. Never English by default; the stored label never overrides the text.
 */
export function replyLanguageOf({ language = null, inboundText = '' } = {}) {
  const v = languageVerdict({ language, inboundText })
  if (v.english) return 'en'
  const text = String(inboundText || '')
  if (SPANISH_RE.test(text)) return 'es'
  // a CODE-SWITCHED message (English words + a non-enabled language's words) is that language; a
  // message wholly in another language keeps the identifier's reading (unknown unless identified)
  const other = otherLanguageMarker(text)
  if (other && ENGLISH_WORD_RE.test(stripSymbols(text))) return other
  const identified = identifyReplyLanguage(inboundText)
  if (identified) return /^spanish$/i.test(identified) ? 'es' : /^english$/i.test(identified) ? 'en' : String(identified).toLowerCase()
  if (OTHER_ROMANCE_LETTER_RE.test(text) || PORTUGUESE_RE.test(text)) return 'unknown'
  if (SPANISH_RE.test(text) || SPANISH_LETTER_RE.test(text) || SPANISH_STOPWORD_RE.test(text) || /^\s*s[ií][\s,.!]*$/i.test(text)) return 'es'
  const l = String(language || '').trim().toLowerCase()
  if (['es', 'spanish', 'español', 'espanol'].includes(l) || l.startsWith('es-')) return 'es'
  return 'unknown'
}

/**
 * rc-8.5.21 v4 (S4): the seller's DOMINANT language. The current inbound decides when it carries any
 * language evidence (a non-enabled-language segment anywhere ⇒ that language: English is never inferred
 * from partial English). An inbound with NO signal of its own ("185k", "ballpark?", "pine") takes the
 * language the seller has written in on this thread (the mode of the prior inbounds; a tie is unknown).
 * A positively English inbound from a seller who has mostly written a non-enabled language is that language.
 * @param {{ language?: string|null, inboundText?: string, priorInbounds?: string[] }} a
 * @returns {{ language: string, basis: string }}
 */
export function dominantLanguageOf({ language = null, inboundText = '', priorInbounds = [] } = {}) {
  // a prior bare "yes" / "yeah" / "nope" is the seller writing English ("ok", "no", "k" prove nothing)
  const priors = (priorInbounds || []).map((b) => String(b ?? '')).filter((b) => b.trim() && (!isSignalLessText(b) || /^\s*(?:yes|yeah|yep|yup|nope)\b/i.test(b)))
  const counts = {}
  for (const b of priors) { const v = languageVerdict({ inboundText: b }); const l = v.english ? 'en' : (SPANISH_RE.test(b) ? 'es' : otherLanguageMarker(b) || replyLanguageOf({ inboundText: b })); if (l !== 'unknown') counts[l] = (counts[l] || 0) + 1 }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const mode = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null
  if (isSignalLessText(inboundText)) {
    if (mode) return { language: mode, basis: 'thread' }
    const l = String(language || '').trim().toLowerCase()
    if (UNIVERSAL_TOKEN_RE.test(stripSymbols(inboundText)) && (l === 'en' || l === 'english' || l.startsWith('en-'))) return { language: 'en', basis: 'stored_label_short_token' }
    return { language: 'unknown', basis: 'no_signal' }
  }
  const current = replyLanguageOf({ language, inboundText })
  if (current === 'en' && mode && mode !== 'en' && mode !== 'es' && counts[mode] * 2 >= priors.length) return { language: mode, basis: 'thread_dominant_non_enabled' }
  return { language: current, basis: 'inbound' }
}

/** Is the seller's language one the policy enables? (unknown / any other language: never) */
export function languageEnabledFor({ language = null, inboundText = '', languages = ['en'], priorInbounds = null } = {}) {
  const { language: lang, basis } = priorInbounds ? dominantLanguageOf({ language, inboundText, priorInbounds }) : { language: replyLanguageOf({ language, inboundText }), basis: 'inbound' }
  const mixed = lang !== 'en' && lang !== 'es' && lang !== 'unknown' && ENGLISH_WORD_RE.test(stripSymbols(inboundText))
  return { language: lang, basis, enabled: lang !== 'unknown' && (languages || ['en']).includes(lang), reason: lang === 'unknown' ? 'language_unknown' : mixed ? `language_mixed_${lang}` : `language_${lang}` }
}

/** The seller's earlier inbound bodies (before the given inbound), oldest first — the dominant-language evidence. */
export function priorInboundBodies(thread = [], inbound = null) {
  const at = Date.parse(inbound?.at || 0) || Infinity
  const id = inbound?.id != null ? String(inbound.id) : null
  return [...(thread || [])].filter((m) => String(m?.direction || '').startsWith('in') && String(m.id) !== id && (Date.parse(m.at || 0) || 0) <= at)
    .sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0)).map((m) => m.body ?? m.message_body ?? '')
}

export function languageVerdict({ language = null, inboundText = '', draftText = '' } = {}) {
  const l = String(language || '').trim().toLowerCase()
  const storedEnglish = l === 'en' || l === 'english' || l.startsWith('en-')
  if (SPANISH_RE.test(inboundText) || SPANISH_RE.test(draftText)) return { english: false, reason: 'spanish_detected' }
  // rc-8.5.21 v4 (S4): a code-switched message is never English because some of its words are
  const other = otherLanguageMarker(inboundText)
  if (other) return { english: false, reason: ENGLISH_WORD_RE.test(stripSymbols(inboundText)) ? `language_mixed_${other}` : `language_${other}` }
  const identified = identifyReplyLanguage(inboundText)
  if (identified) return /^english$/i.test(identified) ? { english: true, reason: 'english' } : { english: false, reason: `language_${String(identified).toLowerCase()}` }
  const text = stripSymbols(inboundText)
  if (NON_ENGLISH_LETTER_RE.test(text) || SPANISH_STOPWORD_RE.test(text)) return { english: false, reason: 'language_unknown' }
  if (l && !storedEnglish) return { english: false, reason: `language_${l}` }
  if (ENGLISH_WORD_RE.test(text)) return { english: true, reason: storedEnglish ? 'english' : 'english_inferred_from_text' }
  if (storedEnglish && UNIVERSAL_TOKEN_RE.test(text)) return { english: true, reason: 'english_short_token' }
  return { english: false, reason: 'language_unknown' }
}

/**
 * Classify a VALIDATED decision + draft against the routine scope.
 * NOTE: a stated asking price ("I'd sell for $175K") is a money turn → excluded from
 * AI sends (held for a human), even though the ledger records it.
 * @returns {{ in_scope: boolean, category: string|null, reasons: string[] }}
 */
export function classifyRoutineScope({ decision, draftText = '', inboundText = '', ledger = null, language = null, propertyCount = 1, policy = DEFAULT_AI_SEND_POLICY } = {}) {
  const reasons = []
  if (!decision) return { in_scope: false, category: null, reasons: ['no_decision'] }
  if (decision.outcome === 'NO_RESPONSE') return { in_scope: true, category: 'no_response', reasons: [] }
  if (decision.outcome !== 'REPLY_CANDIDATE') return { in_scope: false, category: null, reasons: [`outcome_${String(decision.outcome).toLowerCase()}`] }
  const draft = String(draftText || '')
  const inbound = String(inboundText || '')
  if (isStopRequest(inbound)) reasons.push('excluded_stop_request')
  const lang = languageVerdict({ language, inboundText: inbound, draftText: draft })
  if (!lang.english) reasons.push(`excluded_language:${lang.reason}`)
  if (NEVER_INTENTS.has(decision.intent)) reasons.push(`excluded_intent:${decision.intent}`)
  if (MONEY_INTENTS.has(decision.intent) || decision.next_objective === 'offer_needs_human') reasons.push('excluded_money_or_offer')
  if (moneyMentions(draft).length) reasons.push('excluded_money_amount')
  if (ledger?.offer_requests?.length || ledger?.existing_offers?.length) reasons.push('excluded_offer_on_thread')
  if (FINANCIAL_RE.test(draft) || FINANCIAL_RE.test(inbound)) reasons.push('excluded_financial')
  if (LEGAL_CONTRACT_RE.test(draft) || LEGAL_CONTRACT_RE.test(inbound)) reasons.push('excluded_legal_or_contract')
  if (NEGOTIATION_RE.test(draft) || NEGOTIATION_RE.test(inbound) || (ledger?.objections || []).some((o) => o.kind === 'price_objection')) reasons.push('excluded_negotiation')
  if ((Number(propertyCount) || 0) > 1 || MULTI_PROPERTY_RE.test(inbound) || ledger?.property?.identity_requested) reasons.push('excluded_multi_property')
  if (!(decision.confidence >= (policy.min_confidence ?? 0.85))) reasons.push('low_confidence')

  const qn = questionCount(draft)
  let category = null
  if (decision.intent === 'who_is_this' && decision.next_objective === 'clarify_identity') category = 'identity_answer'
  else if (decision.intent === 'not_interested') category = qn === 0 ? 'not_interested_close' : null
  else if (STAGE_OBJECTIVES[decision.next_objective] && qn === 1) {
    const want = STAGE_OBJECTIVES[decision.next_objective]
    if (ledger && ledger.next_missing !== want) reasons.push(`not_next_missing_fact:${want}`)
    else category = 'next_missing_fact'
  }
  if (decision.intent === 'not_interested' && qn > 0) reasons.push('not_interested_close_must_not_ask')
  if (!category) reasons.push('not_a_routine_category')
  else if (!(policy.categories || ROUTINE_CATEGORIES).includes(category)) reasons.push(`category_not_enabled:${category}`)
  const uniq = [...new Set(reasons)]
  return { in_scope: uniq.length === 0, category, reasons: uniq }
}

/**
 * TEMPLATE COEXISTENCE (pure decision). When the AI policy is on for this inbound's
 * scope, the template auto-reply defers per inbound; otherwise the template engine
 * runs exactly as today.
 */
export function templateDeferVerdict({ executorWired = R3_EXECUTOR_WIRED, killSwitchOn = false, policy = DEFAULT_AI_SEND_POLICY, inScope = false } = {}) {
  if (!executorWired) return { defer: false, reason: 'r3_executor_not_wired' }
  if (!killSwitchOn) return { defer: false, reason: 'ai_send_switch_off' }
  if (!policy?.enabled) return { defer: false, reason: 'ai_send_policy_disabled' }
  if (!inScope) return { defer: false, reason: 'thread_not_in_ai_scope', claim_reservation: true }
  return { defer: true, reason: 'deferred_to_ai_conversation' }
}
