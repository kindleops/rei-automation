// THE RECIPIENT-TIMEZONE + MESSAGING-CATEGORY POLICY (rc-8.5.21 S3; owner ruling 2026-10-18). Pure:
// no I/O, no clock.
//
// ONE module answers, for every outbound path, "what kind of message is this, in which zone(s) might the
// recipient be, and may we text them at instant t?":
//   conversation-ai/turns/delay-planner.js   the adaptive 3–40 min reply scheduler (via reply-timing.js)
//   ai/conversation-ai-r3-executor.js        the enqueue-time check (via reply-timing.js)
//   queue/ai-conversation-row-gate.js        the AI row's dispatch-time check (via reply-timing.js)
//   followups/followup-lifecycle.js          the follow-up scheduler (send instant of a materialized row)
//   supabase/sms-engine#evaluateDispatchWindow / #evaluateContactWindow
//                                            the queue dispatcher (pre-claim AND pre-send, process-send-queue)
// so a scheduler and the dispatcher cannot disagree about the same row at the same instant.
//
// THREE MESSAGING CATEGORIES — classifyMessagingCategory(), the ONE classification function:
//   1. active_seller_conversation  a reply to a seller's inbound inside the active conversation (the
//      conversational session: queue/conversational-reply-window.js — linked to one inbound message
//      event, queued within the session, never a follow-up / nurture / campaign touch). Eligible at ANY
//      hour (adaptive 3–40 min delay) unless MESSAGING_RESTRICTIONS names it. No universal after-hours block.
//   2. campaign_outreach           first touches / cold campaign touches: 08:00–21:00 recipient-local.
//   3. scheduled_followup          nurtures, follow-ups, reactivation, and any reply no longer in an active
//      conversation: 08:00–21:00 recipient-local (+ the lifecycle's own eligibility rules).
//   The session decides CONVERSATION CONTINUITY only: it never makes a nurture / campaign / new-topic
//   touch category 1, even inside an active session. STOP, suppression, holds, duplicate prevention,
//   authorization and persona continuity are unchanged and absolute (they are separate gates).
//
// resolveRecipientWindowZones() — ZONE PRECEDENCE (recipient evidence first):
//   1. zones STAMPED on the row by this policy (metadata.recipient_zones + recipient_zone_policy)
//   2. the recipient phone's area code (nanp-area-zones.js; a straddling code lists every zone)
//   3. mailing / other recipient evidence (owner mailing state / ZIP)
//   4. the property zone and any stored row zone only NARROW: they are added to the zone set (the
//      window is the intersection, so they can only shrink it), never the sole basis for "known".
//      A legacy stamp (no policy marker; it may be property-derived) narrows the same way.
//   5. no recipient evidence ⇒ UNKNOWN: the conservative intersection of the continental-US zones
//      (08:00 Pacific … 21:00 Eastern, i.e. 11:00–21:00 Eastern), narrowed by 4. No evidence of ANY
//      kind (has_evidence false) ⇒ the queue dispatcher and the follow-up scheduler HOLD (rc-7.1 D10).
//   (a stored zone on a PHONELESS window query, e.g. the inbox schedule preview, is that caller's
//    asserted zone; every real queue row has a phone, so its stored zone only narrows.)
// Several plausible zones ⇒ the intersection of their 08:00–21:00 local windows. No instant inside the
// intersection (within 3 days) ⇒ hold.
//
// evaluateMessagingWindow() — THE window verdict: category base window ∩ every matching entry of the
// jurisdiction × category restriction table (queue/messaging-restrictions.js; empty by default).
import { zonesForPhone } from './nanp-area-zones.js'
import { deriveTimezoneFromGeography } from '../campaigns/contact-window-timezone.js'
import { storedTimezoneToIana, rowPropertyGeography } from './recipient-timezone.js'
import { evaluateInSessionReply, isOutreachTouch, DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES } from './conversational-reply-window.js'
import { MESSAGING_RESTRICTIONS } from './messaging-restrictions.js'

export const RECIPIENT_WINDOW_POLICY_VERSION = 'recipient-window.v1'
export const CONTACT_HOURS = Object.freeze({ start_hour: 8, end_hour: 21 })
// The lower-48 zones: their common 08:00–21:00 window is 08:00 PT … 21:00 ET.
export const UNKNOWN_ZONE_FALLBACK = Object.freeze(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'])

export const MESSAGING_CATEGORIES = Object.freeze({
  ACTIVE_CONVERSATION: 'active_seller_conversation',
  CAMPAIGN_OUTREACH: 'campaign_outreach',
  SCHEDULED_FOLLOWUP: 'scheduled_followup',
})
const CATEGORY_VALUES = Object.freeze(Object.values(MESSAGING_CATEGORIES))
/** The base recipient-local hours of a category; null = no base window (category 1). */
export const CATEGORY_BASE_HOURS = Object.freeze({
  [MESSAGING_CATEGORIES.ACTIVE_CONVERSATION]: null,
  [MESSAGING_CATEGORIES.CAMPAIGN_OUTREACH]: CONTACT_HOURS,
  [MESSAGING_CATEGORIES.SCHEDULED_FOLLOWUP]: CONTACT_HOURS,
})

const MIN = 60_000
const clean = (v) => String(v ?? '').trim()
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const VALID = new Map()
function validZone(tz) {
  if (!tz || typeof tz !== 'string' || !tz.includes('/')) return false
  const known = VALID.get(tz)
  if (known !== undefined) return known
  let ok
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true } catch { ok = false }
  if (VALID.size < 1000) VALID.set(tz, ok)
  return ok
}
const FMT = new Map()
function localMinutes(ms, tz) {
  let f = FMT.get(tz)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }); FMT.set(tz, f) }
  const parts = f.formatToParts(new Date(ms))
  return (Number(parts.find((x) => x.type === 'hour')?.value || 0) % 24) * 60 + Number(parts.find((x) => x.type === 'minute')?.value || 0)
}

/** Normalise a zone list: valid IANA names only, de-duplicated, stable order. */
export function normalizeZones(zones) {
  return [...new Set((Array.isArray(zones) ? zones : []).map(clean).filter(validZone))]
}

function geoZone(g) {
  if (!g || typeof g !== 'object') return null
  const state = clean(g.state)
  const zip = clean(g.zip)
  if (!state && !zip) return null
  const d = deriveTimezoneFromGeography(state, zip)
  return d?.confident && d.iana ? d.iana : null
}

/**
 * THE zone resolver.
 * @param {{ stampedZones?: string[]|null, stampedCertainty?: string|null, stampedPolicy?: string|null,
 *           recipientPhone?: string|null, mailingGeography?: {state?: string|null, zip?: string|null}|null,
 *           propertyGeography?: {state?: string|null, zip?: string|null}|Array<{state?: string|null, zip?: string|null}>|null,
 *           storedTimezone?: string|null }} e
 * @returns {{ version: string, zones: string[], certainty: 'single'|'multiple'|'unknown', recipient_local: boolean,
 *             timezone_known: boolean, primary_zone: string|null, basis: string, has_evidence: boolean, jurisdictions: string[], sources: Array<{source: string, role: 'recipient'|'narrowing', zones: string[]}> }}
 */
export function resolveRecipientWindowZones(e = {}) {
  const sources = []
  const add = (source, role, zones) => { const z = normalizeZones(zones); if (z.length) sources.push({ source, role, zones: z }) }

  // 1. a stamp by THIS policy is recipient evidence (it may carry mailing evidence the row lacks);
  //    a stamp without the marker (legacy: possibly property-derived) only narrows
  const stamped = normalizeZones(e.stampedZones)
  if (stamped.length) {
    const trusted = clean(e.stampedPolicy).startsWith('recipient-window.')
    if (trusted && clean(e.stampedCertainty) !== 'unknown') add('stamped_recipient_zones', 'recipient', stamped)
    else add(trusted ? 'stamped_unknown_window' : 'legacy_stamped_zones', 'narrowing', stamped)
  }
  // 2. the recipient phone's area code
  const ac = zonesForPhone(e.recipientPhone)
  if (ac?.length) add('recipient_area_code', 'recipient', ac)
  // 3. mailing / other recipient evidence
  const mail = geoZone(e.mailingGeography)
  if (mail) add('mailing_geography', 'recipient', [mail])
  // 4. property + stored: narrowing only
  const props = Array.isArray(e.propertyGeography) ? e.propertyGeography : [e.propertyGeography]
  for (const g of props) { const z = geoZone(g); if (z) add('property_geography', 'narrowing', [z]) }
  // jurisdictions (the restriction-table hook): every state the evidence names (mailing, property)
  const jurisdictions = [...new Set([e.mailingGeography, ...props].map((g) => clean(g?.state).toUpperCase()).filter((st) => /^[A-Z]{2}$/.test(st)))]
  // a stored row zone is not recipient evidence (rows carry property-derived zones). The one exception
  // is a PHONELESS window query (inbox schedule preview, workflow guard): there is no recipient to
  // place, so the caller's named zone is the question being asked. Every real queue row has a phone.
  const stored = storedTimezoneToIana(e.storedTimezone)
  if (stored) add(clean(e.recipientPhone) ? 'stored_timezone' : 'asserted_timezone', clean(e.recipientPhone) ? 'narrowing' : 'recipient', [stored])

  const recipient = sources.filter((s) => s.role === 'recipient')
  const known = recipient.length > 0
  const recipientZones = normalizeZones(recipient.flatMap((s) => s.zones))
  const base = known ? recipientZones : [...UNKNOWN_ZONE_FALLBACK]
  const zones = normalizeZones([...base, ...sources.filter((s) => s.role === 'narrowing').flatMap((s) => s.zones)])
  return {
    version: RECIPIENT_WINDOW_POLICY_VERSION,
    zones,
    certainty: !known ? 'unknown' : zones.length > 1 ? 'multiple' : 'single',
    recipient_local: known,
    timezone_known: known,
    primary_zone: known ? recipientZones[0] : null,
    basis: known ? recipient[0].source : sources.length ? 'unknown_conservative_intersection' : 'no_evidence',
    // false ⇒ nothing at all places the recipient (no stamp, phone zone, mailing, property or stored
    // zone): the dispatcher HOLDS such a row (rc-7.1 D10), the follow-up scheduler holds it too
    has_evidence: sources.length > 0,
    jurisdictions,
    sources,
  }
}

/** The evidence a queue row (raw or normalized) carries, plus optional loaded property / mailing geography. */
export function recipientEvidenceFromRow(row = {}, { propertyGeography = null, mailingGeography = null } = {}) {
  const meta = obj(row?.metadata)
  return {
    stampedZones: Array.isArray(meta.recipient_zones) ? meta.recipient_zones : null,
    stampedCertainty: meta.recipient_zone_certainty || null,
    stampedPolicy: meta.recipient_zone_policy || null,
    recipientPhone: row?.to_phone_number || null,
    mailingGeography: mailingGeography || null,
    propertyGeography: [rowPropertyGeography(row || {}), propertyGeography].filter(Boolean),
    storedTimezone: row?.timezone || null,
  }
}

/** The metadata a writer stamps on a row so the dispatcher re-reads the same resolution. */
export function recipientZoneStamp(resolution) {
  return {
    recipient_zones: [...(resolution?.zones || [])],
    recipient_zone_certainty: resolution?.certainty || 'unknown',
    recipient_zone_policy: RECIPIENT_WINDOW_POLICY_VERSION,
  }
}

/** Is the local window open at `ms` in EVERY zone (the intersection)? Empty ⇒ the unknown fallback. */
export function localHoursOpen(ms, zones, hours = CONTACT_HOURS) {
  const zs = normalizeZones(zones)
  const list = zs.length ? zs : UNKNOWN_ZONE_FALLBACK
  return list.every((tz) => { const m = localMinutes(ms, tz); return m >= hours.start_hour * 60 && m < hours.end_hour * 60 })
}

/** The first instant ≥ ms (minute precision, ≤ 3 days ahead) at which the intersection is open, or null. */
export function nextLocalOpen(ms, zones, hours = CONTACT_HOURS) {
  if (localHoursOpen(ms, zones, hours)) return ms
  let t = Math.ceil(ms / MIN) * MIN
  if (localHoursOpen(t, zones, hours)) return t
  for (let i = 0; i < 3 * 24 * 4; i += 1) {
    const next = t + 15 * MIN
    if (localHoursOpen(next, zones, hours)) {
      for (let k = t + MIN; k <= next; k += MIN) if (localHoursOpen(k, zones, hours)) return k
      return next
    }
    t = next
  }
  return null
}

/** First instant ≥ ms (minute precision, ≤ 3 days) where `open(t)` holds, or null. */
function nextOpen(ms, open) {
  if (open(ms)) return ms
  let t = Math.ceil(ms / MIN) * MIN
  if (open(t)) return t
  for (let i = 0; i < 3 * 24 * 4; i += 1) {
    const next = t + 15 * MIN
    if (open(next)) {
      for (let k = t + MIN; k <= next; k += MIN) if (open(k)) return k
      return next
    }
    t = next
  }
  return null
}

/**
 * THE classification function. Either a queue row (the dispatcher, the lifecycle's materialized row) or
 * explicit facts (the delay planner / R3 deciding a reply before any row exists).
 * @param {{ row?: object|null, now?: string|null, windowMinutes?: number, session?: {in_session: boolean}|null,
 *           isReply?: boolean, inSession?: boolean, kind?: 'campaign'|'followup'|null }} a
 * @returns {{ category: string, in_session: boolean, reason: string }}
 */
export function classifyMessagingCategory({ row = null, now = null, windowMinutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, session = null, isReply = false, inSession = false, kind = null } = {}) {
  const C = MESSAGING_CATEGORIES
  if (row && typeof row === 'object') {
    if (isOutreachTouch(row)) return { category: isCampaignTouch(row) ? C.CAMPAIGN_OUTREACH : C.SCHEDULED_FOLLOWUP, in_session: false, reason: 'outreach_touch' }
    const s = session || evaluateInSessionReply(row, { now: now || new Date().toISOString(), window_minutes: windowMinutes })
    if (s?.in_session === true) return { category: C.ACTIVE_CONVERSATION, in_session: true, reason: 'active_conversation_reply' }
    return { category: C.SCHEDULED_FOLLOWUP, in_session: false, reason: clean(s?.reason) || 'not_in_active_conversation' }
  }
  if (kind === 'campaign') return { category: C.CAMPAIGN_OUTREACH, in_session: false, reason: 'campaign_touch' }
  if (kind === 'followup') return { category: C.SCHEDULED_FOLLOWUP, in_session: false, reason: 'scheduled_followup' }
  if (isReply === true && inSession === true) return { category: C.ACTIVE_CONVERSATION, in_session: true, reason: 'active_conversation_reply' }
  return { category: C.SCHEDULED_FOLLOWUP, in_session: false, reason: isReply === true ? 'reply_outside_active_conversation' : 'not_a_reply' }
}

const lower = (v) => clean(v).toLowerCase()
function isCampaignTouch(row = {}) {
  const m = obj(row.metadata)
  const qc = obj(m.queue_context)
  if (clean(row.campaign_target_id) || clean(m.campaign_target_id)) return true
  if (row.is_first_touch === true || m.is_first_touch === true || qc.is_first_touch === true) return true
  if (Number(m.candidate_snapshot?.touch_number) >= 1) return true
  if (/^campaign[:_-]/.test(lower(row.queue_key || row.queue_id || m.queue_key))) return true
  return [row.type, row.send_kind, m.type, m.send_kind, m.source, m.action_type].map(lower).some((k) => /campaign|opener|first_touch/.test(k))
}

/** The restriction-table entries binding `category` in any of `jurisdictions`. */
export function matchingRestrictions(category, jurisdictions = [], table = MESSAGING_RESTRICTIONS) {
  const js = new Set((jurisdictions || []).map((j) => clean(j).toUpperCase()))
  return (Array.isArray(table) ? table : []).filter((e) => e && js.has(clean(e.jurisdiction).toUpperCase()) && Array.isArray(e.categories) && e.categories.includes(category))
}

/**
 * THE window verdict: the category's base recipient-local window ∩ every matching restriction entry, in
 * EVERY plausible recipient zone. An unknown category is treated as scheduled_followup (never category 1).
 * @param {{ category: string, at: string|number|Date, zones: string[], jurisdictions?: string[], restrictions?: object[], hours?: {start_hour: number, end_hour: number}|null }} a
 * @returns {{ version: string, category: string, lawful: boolean, basis: 'active_conversation'|'local_hours'|null,
 *             local_hours_open: boolean, restrictions_applied: string[], zones: string[], next_permitted_at: string|null, hold: boolean }}
 */
export function evaluateMessagingWindow({ category, at, zones = [], jurisdictions = [], restrictions = MESSAGING_RESTRICTIONS, hours = null } = {}) {
  const cat = CATEGORY_VALUES.includes(category) ? category : MESSAGING_CATEGORIES.SCHEDULED_FOLLOWUP
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(clean(at))
  const zs = normalizeZones(zones)
  const list = zs.length ? zs : [...UNKNOWN_ZONE_FALLBACK]
  const matched = matchingRestrictions(cat, jurisdictions, restrictions)
  const base = { version: RECIPIENT_WINDOW_POLICY_VERSION, category: cat, restrictions_applied: matched.map((e) => clean(e.id) || clean(e.jurisdiction)), zones: list }
  if (!Number.isFinite(ms)) return { ...base, lawful: false, basis: null, local_hours_open: false, next_permitted_at: null, hold: true }
  // a caller may only NARROW the category's base hours (e.g. the planner's tightened policy window)
  const catHours = CATEGORY_BASE_HOURS[cat]
  const baseHours = catHours && hours ? { start_hour: Math.max(catHours.start_hour, Number(hours.start_hour) || 0), end_hour: Math.min(catHours.end_hour, Number(hours.end_hour) || 24) } : catHours
  if (matched.some((e) => e.blocked === true)) return { ...base, lawful: false, basis: null, local_hours_open: false, next_permitted_at: null, hold: true }
  const open = (t) => (!baseHours || localHoursOpen(t, list, baseHours)) && matched.every((e) => localHoursOpen(t, list, e.hours))
  const lawful = open(ms)
  const next = lawful ? ms : nextOpen(ms, open)
  return {
    ...base,
    lawful,
    basis: lawful ? (baseHours ? 'local_hours' : 'active_conversation') : null,
    local_hours_open: localHoursOpen(ms, list, CONTACT_HOURS),
    next_permitted_at: next == null ? null : new Date(next).toISOString(),
    hold: !lawful && next == null,
  }
}
