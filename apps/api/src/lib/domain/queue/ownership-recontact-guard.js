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
//   cleared   only by NEW valid ownership evidence for that property, later than the denial
//             (an explicit confirmation, a "yes" to a later ownership question, a confirming label)
//   override  a MANUAL operator send may cross it with an audited override
//             metadata.ownership_recontact_override = { actor, reason (≥ 10 chars), at }; no
//             automated path can
// Explicit opt-out / STOP stays CONTACT-WIDE suppression (checked separately, never here).
import { bareNoAnswer } from '../conversation-ai/answers.js'
import { questionKindOf } from '../conversation-ai/questions.js'
import { BARE_YES_RE, OWN_CONFIRM_RE, OWN_DENY_RE, OWN_FORMER_RE, RETRACTION_RE } from '../conversation-ai/fact-ledger.js'
import { isManualInboxSend } from './is-manual-inbox-send.js'
import { NEVER_OWNED_LONG_RE } from '../classification/conversation-context.js'

export const RECONTACT_GUARD_VERSION = 'ownership-recontact-guard.v1'
const NOT_OWNER_LABELS = new Set(['property_specific_non_owner', 'former_owner_respondent', 'sold_property', 'sold', 'tenant_respondent', 'non_owner_referral', 'not_owner', 'ownership_denied'])
const CONFIRM_LABELS = new Set(['ownership_confirmed'])
const clean = (v) => String(v ?? '').trim()
const t = (m) => Date.parse(m?.at || m?.event_timestamp || m?.created_at || 0) || 0

/**
 * @param {{ messages: Array<{ id: string, direction: string, body?: string, message_body?: string, at?: string, created_at?: string, property_id?: string|null, detected_intent?: string|null }> }} a
 * @returns {Map<string, { state: 'denied'|'confirmed', message_id: string, at: number, basis: string }>} property key → latest ownership evidence
 */
export function ownershipEvidenceByProperty({ messages = [] } = {}) {
  const out = new Map()
  let lastQ = null // { property_id }
  for (const m of [...messages].sort((a, b) => t(a) - t(b))) {
    const body = clean(m.body ?? m.message_body)
    const dir = String(m.direction || '').toLowerCase()
    if (dir.startsWith('out')) {
      const kind = questionKindOf({ use_case: m.use_case || null, body })
      lastQ = kind === 'ownership' ? { property_id: clean(m.property_id) || null } : kind !== 'none' ? null : lastQ
      continue
    }
    if (!dir.startsWith('in')) continue
    const prop = clean(m.property_id) || lastQ?.property_id || ''
    const label = String(m.detected_intent || '')
    const denyMatch = OWN_DENY_RE.exec(body) || OWN_FORMER_RE.exec(body)
    const retracted = denyMatch && RETRACTION_RE.test(body.slice(denyMatch.index + denyMatch[0].length))
    const set = (state, basis) => out.set(prop, { state, message_id: String(m.id), at: t(m), basis })
    if (denyMatch && !retracted) set('denied', 'explicit_denial')
    else if (lastQ && bareNoAnswer(body).ownership_denial) set('denied', 'bare_no_to_ownership_question')
    else if (lastQ && NEVER_OWNED_LONG_RE.test(body)) set('denied', 'never_owned_to_ownership_question')
    else if (NOT_OWNER_LABELS.has(label)) set('denied', `label:${label}`)
    else if (retracted || OWN_CONFIRM_RE.test(body) || (lastQ && BARE_YES_RE.test(body)) || CONFIRM_LABELS.has(label)) set('confirmed', retracted ? 'retracted_denial' : 'confirmation')
    lastQ = null
  }
  return out
}

const PAIR_DENIAL_ROLES = new Set(['not_owner', 'former_owner', 'referral_source'])

/**
 * The property-scoped resolution store verdict (pure).
 * @param {{ property_id?: string|null, resolutions?: Array<{ property_id?: string, contact_property_role?: string, suppression_scope?: string, rejected_at?: string|null, rejection_reason?: string|null }> }} a
 * @returns {{ excluded: boolean, reason: string|null, scope: 'phone'|'person_property'|null, role: string|null, source: 'contact_property_resolution'|null }}
 */
export function evaluateContactPropertyResolution({ property_id = null, resolutions = [] } = {}) {
  const target = clean(property_id)
  for (const r of resolutions || []) {
    const scope = clean(r.suppression_scope)
    const role = clean(r.contact_property_role)
    if (scope === 'channel_compliance' || role === 'suppressed') return { excluded: true, reason: 'contact_channel_suppressed', scope: 'phone', role: role || null, source: 'contact_property_resolution' }
  }
  for (const r of resolutions || []) {
    const role = clean(r.contact_property_role)
    if (!clean(r.rejected_at) || !PAIR_DENIAL_ROLES.has(role)) continue
    if (clean(r.suppression_scope) && clean(r.suppression_scope) !== 'contact_property_pair') continue
    if (!target || !clean(r.property_id) || clean(r.property_id) === target) return { excluded: true, reason: 'prior_reply_not_owner', scope: 'person_property', role, source: 'contact_property_resolution', rejected_at: clean(r.rejected_at) }
  }
  return { excluded: false, reason: null, scope: null, role: null, source: null }
}

/**
 * @param {object} row       the send_queue row about to go out
 * @param {Array} messages   the thread's message_events (both directions), any order
 * @returns {{ blocked: boolean, reason: string|null, detail: object, version: string }}
 */
export function evaluateOwnershipRecontact(row = {}, messages = [], { resolutions = [] } = {}) {
  const meta0 = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const store = evaluateContactPropertyResolution({ property_id: row.property_id, resolutions })
  if (store.excluded && store.scope === 'phone') return { blocked: true, reason: store.reason, detail: { scope: 'phone', role: store.role, source: store.source }, version: RECONTACT_GUARD_VERSION }
  const ev = ownershipEvidenceByProperty({ messages })
  const prop = clean(row.property_id)
  if (store.excluded) {
    // the store says "denied for this property"; only a confirmation in the thread LATER than the
    // recorded rejection clears it
    const latest = ev.get(prop) || ev.get('')
    const rejectedAt = Date.parse(store.rejected_at || '') || 0
    const later = latest && latest.at > rejectedAt ? latest : null
    const ov0 = meta0.ownership_recontact_override
    const overridden = ov0 && isManualInboxSend(row) && clean(ov0.actor) && clean(ov0.reason).length >= 10 && Number.isFinite(Date.parse(clean(ov0.at)))
    if (!(later && later.state === 'confirmed') && !overridden) return { blocked: true, reason: 'property_ownership_denied_no_recontact', detail: { scope: 'person_property', role: store.role, source: store.source }, version: RECONTACT_GUARD_VERSION }
  }
  // the row's property, plus a denial whose property is unknown (it answered a question about this thread)
  const hits = [...ev.entries()].filter(([p, e]) => e.state === 'denied' && (!p || !prop || p === prop))
  if (!hits.length) return { blocked: false, reason: null, detail: { checked: ev.size }, version: RECONTACT_GUARD_VERSION }
  const [p, e] = hits.sort((a, b) => b[1].at - a[1].at)[0]
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const ov = meta.ownership_recontact_override
  if (ov && isManualInboxSend(row) && clean(ov.actor) && clean(ov.reason).length >= 10 && Number.isFinite(Date.parse(clean(ov.at)))) {
    return { blocked: false, reason: null, detail: { overridden: true, override: { actor: clean(ov.actor), reason: clean(ov.reason).slice(0, 200), at: clean(ov.at) }, denial_message_id: e.message_id }, version: RECONTACT_GUARD_VERSION }
  }
  return { blocked: true, reason: 'property_ownership_denied_no_recontact', detail: { scope: 'person_property', property_scoped: Boolean(p), basis: e.basis, denial_message_id: e.message_id }, version: RECONTACT_GUARD_VERSION }
}
