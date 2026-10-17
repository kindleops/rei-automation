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
import { STATIC_PERMANENT_EXCLUSIONS, isOwnerHandledThread as staticIsOwnerHandledThread } from '@/lib/domain/holds/automation-hold-core.js'

export const AI_SEND_POLICY_VERSION = 'conv-ai.send-policy.v1'
export const AI_SEND_KILL_SWITCH_KEY = 'ai_conversation_send_enabled'
export const AI_SEND_POLICY_KEY = 'ai_conversation_send_policy'
export const AI_CONVERSATION_SOURCE = 'ai_conversation'
export const INBOUND_REPLY_RESERVATION_SCOPE = 'inbound_reply'

// The R3 executor is BUILT but NOT WIRED to any runtime in 8.5.16. While this is
// false the template engine never defers (it cannot hand an inbound to an executor
// that nothing calls), whatever the switch or the policy say.
export const R3_EXECUTOR_WIRED = false

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
    // Spanish (and every other language) is excluded in 8.5.16 whatever the row says
    languages: Object.freeze(['en']),
    categories: Object.freeze(arr(row.categories).filter((c) => ROUTINE_CATEGORIES.includes(c)).length ? arr(row.categories).filter((c) => ROUTINE_CATEGORIES.includes(c)) : ROUTINE_CATEGORIES),
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
const ENGLISH_WORD_RE = /\b(?:the|you|it|is|are|not|yes|yeah|yep|nope|my|me|we|this|that|who|what|why|how|sell|selling|own|owner|house|home|property|interested|thanks|thank|please|stop|sorry|okay|sure|wrong|number|maybe|later|call|text|have|don'?t|i'?m|it'?s|thats|already)\b/i
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
export function languageVerdict({ language = null, inboundText = '', draftText = '' } = {}) {
  const l = String(language || '').trim().toLowerCase()
  if (SPANISH_RE.test(inboundText) || SPANISH_RE.test(draftText)) return { english: false, reason: 'spanish_detected' }
  if (l === 'en' || l === 'english' || l.startsWith('en-')) return { english: true, reason: 'english' }
  // no stored language: English TEXT (Latin-only, no accented letters, no Spanish markers, at
  // least one English word) is English (8.5.16 eval); anything else stays unknown and is held
  if (!l) return ENGLISH_WORD_RE.test(inboundText) && !SPANISH_STOPWORD_RE.test(inboundText) && !/[\u00C0-\u024F\u0370-\uFFFF]/.test(String(inboundText).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D\u2019\u2018\u201C\u201D]/gu, '')) ? { english: true, reason: 'english_inferred_from_text' } : { english: false, reason: 'language_unknown' }
  return { english: false, reason: `language_${l}` }
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
