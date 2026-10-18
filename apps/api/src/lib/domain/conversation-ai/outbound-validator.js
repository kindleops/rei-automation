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
import { addressKeysIn, propertiesNamedIn } from './property-facts.js'

export const OUTBOUND_VALIDATOR_VERSION = 'conv-ai.outbound-validator.v2'

// a promise of no further contact is false whenever a follow-up is scheduled (disinterest = 30-day follow-up)
const FALSE_NO_CONTACT_RE = /\b(?:(?:won'?t|wont|will\s+not|never|not\s+going\s+to)\s+(?:bother|contact|text|message|call|trouble|reach\s+out(?:\s+to)?|be\s+(?:bothering|contacting|texting|reaching\s+out))(?:\s+you)?(?:\s+(?:again|anymore|any\s+more|further))?|leave\s+you\s+(?:be|alone)|leave\s+it\s+(?:alone|there)|take\s+you\s+off\s+(?:our|my|the)\s+list|(?:remove|removing)\s+(?:you|your\s+number)|last\s+(?:time|message|text)\s+(?:you'?ll|we|i)|won'?t\s+(?:take|waste)\s+(?:up\s+)?(?:any\s+)?more\s+of\s+your\s+time|won'?t\s+hear\s+from\s+(?:us|me)\s+again|close\s+(?:this|it)\s+out|close\s+the\s+loop|done\s+(?:reaching|texting)\s+out|leave\s+it\s+(?:with|to)\s+(?:them|your\s+(?:agent|realtor)|the\s+(?:agent|realtor))|won'?t\s+(?:push|pursue|follow\s+up))\b/i
// "since you're confident you own it" after "I don't know": an attribution must be a STATED fact
const ATTRIBUTION_RE = /\b(?:since\s+you(?:'re|\s+are|'ve|\s+have)?|you\s+(?:said|mentioned|told\s+(?:me|us)|confirmed|noted|indicated)|as\s+you\s+(?:said|mentioned|noted)|you(?:'re|\s+are)\s+(?:confident|sure|certain))\b([^.?!,;]{0,80})/i
const ATTRIBUTION_TOPICS = [
  ['ownership', /\b(?:own|owner|yours|title)\b/i, (v) => ['confirmed', 'representative'].includes(v)],
  ['asking_price', /\b(?:price|number|asking|\$|[0-9]+k)\b/i, (v) => v != null],
  ['condition', /\b(?:repair|roof|condition|work|fix|hvac|foundation|update)\w*/i, (v) => v != null],
  ['timeline', /\b(?:close|closing|timeline|move|soon|month|week|november|december|spring|summer|fall|winter)\b/i, (v) => v != null],
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
  const numbered = addressKeysIn(t).filter((k) => !k.startsWith('street:'))
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
export function identityStatementReasons(text, ledger, companyIdentity = NO_COMPANY_IDENTITY) {
  const t = String(text || '')
  const r = []
  const latest = ledger?.last_message?.direction === 'inbound' ? ledger.last_message.id : null
  const asked = (kinds) => (ledger?.requests || []).some((q) => kinds.includes(q.kind) && (!latest || q.source_message_id === latest))
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
export function validateOutbound(text, { ledger = null, objective = null, category = null, inboundIntent = null, personaPolicy = { allow_established_persona: true }, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY, followupScheduled = null, previousOutbound = null, offerAmounts = [], knownNumbers = [], firstName = null, otherNames = [], eligibility = undefined, timing = undefined } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const content = []
  if (!t) content.push('empty_composition')
  for (const r of validatePlaybookStyle(t, { personaPolicy, establishedPersona, companyIdentity }).reasons) content.push(r)
  if ((followupScheduled || category === 'not_interested_close') && FALSE_NO_CONTACT_RE.test(t)) content.push('close:false_no_contact_promise_with_followup_scheduled')
  if (category === 'not_interested_close' && sentenceCount(t) > 2) content.push('close:more_than_two_sentences')
  const attr = unsupportedAttribution(t, ledger)
  if (attr) content.push(`ledger:${attr}`)
  const thanks = unsupportedThanksClaim(t, ledger)
  if (thanks) content.push(`ledger:${thanks}`)
  for (const r of identityStatementReasons(t, ledger, companyIdentity)) content.push(r)
  for (const r of priceApprovalReasons(t, ledger)) content.push(r)
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
