// RECONTACT GUARD — no recontact about a property whose ownership was DENIED (rc-8.5.21, owner P0
// 2026-10-16: campaign 55400439 re-targeted a thread on 10-06 after the seller said they never
// owned the property; the stored label was not a not-owner intent, so the label-based check
// passed). Pure. Called by the send-time contact guard, i.e. on EVERY outbound path (campaign
// openers, follow-ups, AI replies, manual sends), from the thread's own messages, not from labels:
//
//   denial    an inbound that answers OUR ownership question with a bare negative (the shared
//             answers.js matcher, polite or not), an explicit denial ("never owned it", "wrong
//             house", "I sold it" not taken back), or a not-owner classifier label
//   property  the property the denial is about: the inbound's own property_id, else the property
//             of the ownership question it answers (a thread can carry several properties)
//   store     public.contact_property_resolution (unique property × phone, written by the live
//             inbound waterfall): a rejected contact_property_pair row with role not_owner /
//             former_owner / referral_source excludes that phone for THAT property; a
//             channel_compliance / suppressed row excludes the phone everywhere (opt-out stays
//             contact-wide). evaluateContactPropertyResolution() is shared with the campaign
//             opener exclusion (campaigns/opener-reply-exclusion.js), so planner and dispatch agree.
//   override  a MANUAL operator send may cross it with an audited override
//             metadata.ownership_recontact_override = { actor, reason (≥ 10 chars), at }; no
//             automated path can
// Explicit opt-out / STOP stays CONTACT-WIDE suppression (checked separately, never here).
//
// OWNER RULES 2026-10-17 (binding):
//   1. a property-specific denial never becomes a phone-level suppression: every denial verdict here
//      is scope person_property (or a thread hold); only channel_compliance / suppressed store rows,
//      written exclusively for an explicit opt-out (resolve-contact-outcome-phase.js), are phone-wide.
//   2. an AMBIGUOUS denial (no reliably identified property: the inbound has no property, it answers no
//      ownership question about a known property, the store row carries no property, or the outbound
//      row itself has no property) HOLDS the thread pending operator resolution
//      (reason ownership_denial_property_unresolved, scope thread_hold: deferred, never terminal); it
//      never labels every property on the thread as denied.
//   3. evidence is ordered by RECENCY and CONFIDENCE (EVIDENCE_RANK): a later item replaces the current
//      one only when it is at least as confident. A later explicit confirmation or seller engagement on
//      the property supersedes an earlier low-confidence denial label, and a later explicit denial
//      supersedes an earlier low-confidence confirmation label; a stale low-confidence label never
//      defeats newer explicit evidence.
//   OWNER DECISION 2026-10-17 (supersedes 831df6cd): a POLITE "No thanks" to OUR ownership question is
//      state 'declined' (ownership_declined_unverified): a property × contact no-recontact HOLD, never a
//      denial fact (scope person_property, reason ownership_declined_unverified_hold). The store records
//      it as role ownership_declined_unverified (rejected_at NULL). Newer, at-least-as-confident
//      confirmation / engagement clears it; it never becomes 'denied'.
import { bareNoAnswer } from '../conversation-ai/answers.js'
import { questionKindOf } from '../conversation-ai/questions.js'
import { moneyMentions } from '../conversation-ai/validator.js'
import { BARE_YES_RE, OWN_CONFIRM_RE, OWN_DENY_RE, OWN_FORMER_RE, RETRACTION_RE } from '../conversation-ai/fact-ledger.js'
import { isManualInboxSend } from './is-manual-inbox-send.js'
import { NEVER_OWNED_LONG_RE } from '../classification/conversation-context.js'
import { attributeInbounds } from '../conversation-ai/property-facts.js'

export const RECONTACT_GUARD_VERSION = 'ownership-recontact-guard.v3'
const NOT_OWNER_LABELS = new Set(['property_specific_non_owner', 'former_owner_respondent', 'sold_property', 'sold', 'tenant_respondent', 'non_owner_referral', 'not_owner', 'ownership_denied'])
const CONFIRM_LABELS = new Set(['ownership_confirmed'])
const ENGAGEMENT_LABELS = new Set(['seller_interested', 'interested', 'asks_offer', 'asking_price_provided', 'counter_offer', 'condition_disclosed', 'latent_interest'])
const OFFER_REQUEST_RE = /\b(?:what(?:'?s|\s+is|\s+would\s+be)?\s+(?:your|ur|the)\s+(?:offer|number|best\s+(?:offer|price))|make\s+(?:me\s+)?an?\s+offer|send\s+(?:me\s+)?(?:your|an?|the)\s+(?:offer|number)|how\s+much\s+(?:would|will|can|could)\s+you\s+(?:offer|pay|give))\b/i
/** Confidence of an evidence item (owner rule 3). Labels are the weakest; explicit text the strongest. */
export const EVIDENCE_RANK = Object.freeze({ label: 1, store: 2, engagement: 2, answer: 3, explicit: 3 })
export const OWNERSHIP_UNRESOLVED_REASON = 'ownership_denial_property_unresolved'
export const OWNERSHIP_DECLINED_REASON = 'ownership_declined_unverified_hold'
export const OWNERSHIP_DECLINED_ROLE = 'ownership_declined_unverified'
const DECLINED_LABELS = new Set(['ownership_declined_unverified'])
const clean = (v) => String(v ?? '').trim()
const t = (m) => Date.parse(m?.at || m?.event_timestamp || m?.created_at || 0) || 0

/**
 * Every ownership evidence item in the thread, in time order (pure).
 * @returns {Array<{ property: string, state: 'denied'|'confirmed', message_id: string, at: number, basis: string, kind: keyof EVIDENCE_RANK, rank: number }>}
 *          property '' = not reliably identified
 */
export function ownershipEvidenceItems({ messages = [], properties = [] } = {}) {
  const items = []
  let lastQ = null // our last question: { kind, property_id }
  // blind-eval S1 (rc-8.5.21): ONE attribution rule (property-facts.js) — a reply naming a property
  // answers THAT property; one bare answer to ownership questions about several properties is
  // unattributed ('') ⇒ a thread hold, never a denial of the latest property
  const attribution = attributeInbounds({ messages, properties, questionKindOf })
  for (const m of [...messages].sort((a, b) => t(a) - t(b))) {
    const body = clean(m.body ?? m.message_body)
    const dir = String(m.direction || '').toLowerCase()
    if (dir.startsWith('out')) {
      const kind = questionKindOf({ use_case: m.use_case || null, body })
      if (kind !== 'none') lastQ = { kind, property_id: clean(m.property_id) || null }
      continue
    }
    if (!dir.startsWith('in')) continue
    const ownQ = lastQ?.kind === 'ownership' ? lastQ : null
    const att = attribution.get(String(m.id))
    const prop = att ? att.property : clean(m.property_id) || clean(lastQ?.property_id) || ''
    const label = String(m.detected_intent || '')
    const denyMatch = OWN_DENY_RE.exec(body) || OWN_FORMER_RE.exec(body)
    const retracted = denyMatch && RETRACTION_RE.test(body.slice(denyMatch.index + denyMatch[0].length))
    const push = (state, basis, kind) => items.push({ property: prop, state, message_id: String(m.id), at: t(m), basis, kind, rank: EVIDENCE_RANK[kind] })
    if (denyMatch && !retracted) push('denied', 'explicit_denial', 'explicit')
    else if (ownQ && bareNoAnswer(body).ownership_denial) push('denied', 'bare_no_to_ownership_question', 'answer')
    else if (ownQ && bareNoAnswer(body).ownership_declined) push('declined', 'polite_no_to_ownership_question', 'answer')
    else if (ownQ && NEVER_OWNED_LONG_RE.test(body)) push('denied', 'never_owned_to_ownership_question', 'answer')
    else if (retracted || OWN_CONFIRM_RE.test(body)) push('confirmed', retracted ? 'retracted_denial' : 'explicit_confirmation', 'explicit')
    else if (ownQ && BARE_YES_RE.test(body)) push('confirmed', 'yes_to_ownership_question', 'answer')
    else if (lastQ && lastQ.kind !== 'ownership' && !bareNoAnswer(body).matched && (moneyMentions(body).length || OFFER_REQUEST_RE.test(body) || (lastQ.kind === 'interest' && BARE_YES_RE.test(body)))) push('confirmed', `seller_engagement:${lastQ.kind}`, 'engagement')
    else if (!lastQ && (moneyMentions(body).length || OFFER_REQUEST_RE.test(body)) && prop) push('confirmed', 'seller_engagement:unprompted', 'engagement')
    else if (NOT_OWNER_LABELS.has(label)) push('denied', `label:${label}`, 'label')
    else if (DECLINED_LABELS.has(label)) push('declined', `label:${label}`, 'label')
    else if (CONFIRM_LABELS.has(label)) push('confirmed', `label:${label}`, 'label')
    else if (ENGAGEMENT_LABELS.has(label)) push('confirmed', `label:${label}`, 'label')
    // an inbound answers (consumes) the question it follows
    lastQ = null
  }
  return items
}

/**
 * Owner rule 3: walk the items in time order; a later item replaces the current one only when it is
 * at least as confident. A LATER but LESS confident item that contradicts the current one neither
 * wins nor is ignored: it is recorded as a conflict (the guard holds the thread for an operator).
 * An OLDER low-confidence item never defeats newer evidence. Pure.
 * @returns {null | (item & { conflict: null | item })}
 */
export function resolveOwnershipEvidence(items = []) {
  let current = null
  let conflict = null
  for (const e of [...items].sort((a, b) => a.at - b.at)) {
    if (!current || e.rank >= current.rank) { current = e; conflict = null; continue }
    if (e.state !== current.state) conflict = e
  }
  return current ? { ...current, conflict } : null
}

/**
 * @returns {Map<string, { state: 'denied'|'confirmed', message_id: string, at: number, basis: string, kind: string, rank: number }>}
 *          property key ('' = not identified) → the resolved ownership evidence (rule 3)
 */
export function ownershipEvidenceByProperty({ messages = [], properties = [] } = {}) {
  const by = new Map()
  for (const e of ownershipEvidenceItems({ messages, properties })) by.set(e.property, [...(by.get(e.property) || []), e])
  return new Map([...by.entries()].map(([p, list]) => [p, resolveOwnershipEvidence(list)]))
}

const PAIR_DENIAL_ROLES = new Set(['not_owner', 'former_owner', 'referral_source'])
const isStoreDenial = (r) => clean(r.rejected_at) && PAIR_DENIAL_ROLES.has(clean(r.contact_property_role)) && (!clean(r.suppression_scope) || clean(r.suppression_scope) === 'contact_property_pair')

/**
 * The property-scoped resolution store verdict (pure).
 * @param {{ property_id?: string|null, resolutions?: Array<{ property_id?: string, contact_property_role?: string, suppression_scope?: string, rejected_at?: string|null, rejection_reason?: string|null }> }} a
 * @returns {{ excluded: boolean, hold?: boolean, reason: string|null, scope: 'phone'|'person_property'|'thread_hold'|null, role: string|null, source: 'contact_property_resolution'|null, rejected_at?: string }}
 */
export function evaluateContactPropertyResolution({ property_id = null, resolutions = [] } = {}) {
  const target = clean(property_id)
  for (const r of resolutions || []) {
    const scope = clean(r.suppression_scope)
    const role = clean(r.contact_property_role)
    // owner rule 4: contact-wide restrictions stay absolute (written only for an explicit opt-out)
    if (scope === 'channel_compliance' || role === 'suppressed') return { excluded: true, reason: 'contact_channel_suppressed', scope: 'phone', role: role || null, source: 'contact_property_resolution' }
  }
  const denials = (resolutions || []).filter(isStoreDenial)
  const exact = target ? denials.find((r) => clean(r.property_id) === target) : null
  if (exact) return { excluded: true, reason: 'prior_reply_not_owner', scope: 'person_property', role: clean(exact.contact_property_role), source: 'contact_property_resolution', rejected_at: clean(exact.rejected_at) }
  // OWNER DECISION 2026-10-17: a recorded polite decline (ownership UNVERIFIED) holds THIS property for
  // this contact — never a denial fact (no rejected_at), never phone-wide
  const declined = (resolutions || []).filter((r) => clean(r.contact_property_role) === OWNERSHIP_DECLINED_ROLE)
  const declinedHere = target ? declined.find((r) => clean(r.property_id) === target) : null
  if (declinedHere) return { excluded: true, declined: true, reason: OWNERSHIP_DECLINED_REASON, scope: 'person_property', role: OWNERSHIP_DECLINED_ROLE, source: 'contact_property_resolution', rejected_at: clean(declinedHere.updated_at || declinedHere.created_at) }
  // owner rule 2: a denial whose property is not identified, or an outbound whose property is not
  // identified while the phone carries a denial, is a thread HOLD (operator resolution), never a
  // denial of every property
  const ambiguous = denials.find((r) => !clean(r.property_id)) || (!target ? denials[0] || declined[0] : null)
  if (ambiguous) return { excluded: true, hold: true, reason: OWNERSHIP_UNRESOLVED_REASON, scope: 'thread_hold', role: clean(ambiguous.contact_property_role), source: 'contact_property_resolution', rejected_at: clean(ambiguous.rejected_at) }
  return { excluded: false, reason: null, scope: null, role: null, source: null }
}

const validOverride = (row, ov) => ov && isManualInboxSend(row) && clean(ov.actor) && clean(ov.reason).length >= 10 && Number.isFinite(Date.parse(clean(ov.at)))

/**
 * @param {object} row       the send_queue row about to go out
 * @param {Array} messages   the thread's message_events (both directions), any order
 * @returns {{ blocked: boolean, hold?: boolean, reason: string|null, detail: object, version: string }}
 */
export function evaluateOwnershipRecontact(row = {}, messages = [], { resolutions = [] } = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const store = evaluateContactPropertyResolution({ property_id: row.property_id, resolutions })
  if (store.excluded && store.scope === 'phone') return { blocked: true, reason: store.reason, detail: { scope: 'phone', role: store.role, source: store.source }, version: RECONTACT_GUARD_VERSION }
  const prop = clean(row.property_id)
  const items = ownershipEvidenceItems({ messages })
  // the evidence about THIS property: the store denial (if any) + the thread's own items for it
  const own = items.filter((e) => prop && e.property === prop)
  if (store.excluded && !store.hold) own.push({ property: prop, state: store.declined ? 'declined' : 'denied', message_id: null, at: Date.parse(store.rejected_at || '') || 0, basis: `store:${store.role}`, kind: 'store', rank: EVIDENCE_RANK.store })
  const resolved = resolveOwnershipEvidence(own)
  const overridden = validOverride(row, meta.ownership_recontact_override)
  const overrideDetail = overridden ? { overridden: true, override: { actor: clean(meta.ownership_recontact_override.actor), reason: clean(meta.ownership_recontact_override.reason).slice(0, 200), at: clean(meta.ownership_recontact_override.at) } } : null
  if (resolved?.conflict) {
    if (overridden) return { blocked: false, reason: null, detail: { ...overrideDetail, conflict_message_id: resolved.conflict.message_id }, version: RECONTACT_GUARD_VERSION }
    return { blocked: true, hold: true, reason: OWNERSHIP_UNRESOLVED_REASON, detail: { scope: 'thread_hold', property_scoped: true, conflict: true, basis: `${resolved.basis} vs later ${resolved.conflict.basis}`, evidence_message_id: resolved.message_id, conflict_message_id: resolved.conflict.message_id, action: 'operator_review' }, version: RECONTACT_GUARD_VERSION }
  }
  if (resolved?.state === 'declined') {
    if (overridden) return { blocked: false, reason: null, detail: { ...overrideDetail, decline_message_id: resolved.message_id }, version: RECONTACT_GUARD_VERSION }
    return { blocked: true, reason: OWNERSHIP_DECLINED_REASON, detail: { scope: 'person_property', property_scoped: true, ownership: 'unverified', basis: resolved.basis, decline_message_id: resolved.message_id, source: resolved.kind === 'store' ? store.source : 'message_text' }, version: RECONTACT_GUARD_VERSION }
  }
  if (resolved?.state === 'denied') {
    if (overridden) return { blocked: false, reason: null, detail: { ...overrideDetail, denial_message_id: resolved.message_id }, version: RECONTACT_GUARD_VERSION }
    return { blocked: true, reason: 'property_ownership_denied_no_recontact', detail: { scope: 'person_property', property_scoped: true, basis: resolved.basis, denial_message_id: resolved.message_id, source: resolved.kind === 'store' ? store.source : 'message_text' }, version: RECONTACT_GUARD_VERSION }
  }
  // owner rule 2: an unidentified-property denial (thread text with no property, a store row with no
  // property, or an outbound with no property while denials exist) holds the thread unless newer,
  // at-least-as-confident evidence for THIS property has resolved it
  const unresolvedText = resolveOwnershipEvidence(items.filter((e) => !e.property))
  const anyDenialWithoutRowProperty = !prop ? resolveOwnershipEvidence(items.filter((e) => e.state === 'denied' || e.state === 'declined')) : null
  const ambiguousDenial = [['denied', 'declined'].includes(unresolvedText?.state) ? unresolvedText : null, anyDenialWithoutRowProperty, store.hold ? { at: Date.parse(store.rejected_at || '') || 0, rank: EVIDENCE_RANK.store, basis: `store:${store.role}`, message_id: null } : null].filter(Boolean).sort((a, b) => b.at - a.at)[0] || null
  if (ambiguousDenial && !(resolved && resolved.state === 'confirmed' && resolved.at > ambiguousDenial.at && resolved.rank >= ambiguousDenial.rank)) {
    if (overridden) return { blocked: false, reason: null, detail: { ...overrideDetail, unresolved_denial_message_id: ambiguousDenial.message_id }, version: RECONTACT_GUARD_VERSION }
    return { blocked: true, hold: true, reason: OWNERSHIP_UNRESOLVED_REASON, detail: { scope: 'thread_hold', property_scoped: false, basis: ambiguousDenial.basis, denial_message_id: ambiguousDenial.message_id, action: 'operator_review' }, version: RECONTACT_GUARD_VERSION }
  }
  return { blocked: false, reason: null, detail: { checked: items.length, resolved: resolved ? { state: resolved.state, basis: resolved.basis } : null }, version: RECONTACT_GUARD_VERSION }
}
