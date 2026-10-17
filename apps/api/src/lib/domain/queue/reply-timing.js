// ONE SEND-TIME ELIGIBILITY FUNCTION for conversational replies (rc-8.5.21, Phase 5). Pure.
//
// Every layer that decides WHEN an AI conversation reply may go asks this module, so the
// scheduler and the dispatcher can never disagree:
//   turns/delay-planner.js            plans the due time (lawful(t) below)
//   conversation-ai/eligibility-bridge.js  the decision-time verdict the validator reads
//   ai/conversation-ai-r3-executor.js the enqueue-time check (last second before the queue row)
//   queue/ai-conversation-row-gate.js the dispatch-time check (last second before transport)
//
// THE RULE (unchanged, reused — never widened):
//   in session  the owner rule 2026-10-10 as already implemented for template replies:
//               queue/conversational-reply-window.js#evaluateConversationalReply (a reply that
//               answers one inbound, queued within the conversational window of it, and still
//               inside that window at dispatch) is lawful at any hour;
//   otherwise   08:00–21:00 recipient-local, in EVERY plausible recipient zone (the intersection).
//
// RECIPIENT ZONE EVIDENCE (resolveRecipientZones):
//   recipient phone area code   recipient-local (nanp-area-zones.js; a straddling code lists all zones)
//   mailing state / ZIP         recipient-local (when the record has one)
//   property state / ZIP        kept as a NARROWING constraint: the generic send-time window in
//                               sms-engine#evaluateContactWindow is property-first, so including it
//                               guarantees every AI row this module allows also passes that check
//   stored zone                 only when there is no other evidence (it is the noisiest source)
//   none of the above           UNKNOWN: the conservative intersection of the lower-48 zones
//                               (≈ 11:00–21:00 Eastern / 08:00–18:00 Pacific), never a guess.
// Uncertainty is represented (certainty + sources), never collapsed into one zone.
import { evaluateConversationalReply, evaluateInSessionReply, DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES } from './conversational-reply-window.js'
import { deriveTimezoneFromGeography } from '../campaigns/contact-window-timezone.js'
import { storedTimezoneToIana } from './recipient-timezone.js'
import { zonesForPhone } from './nanp-area-zones.js'

export const REPLY_TIMING_VERSION = 'reply-timing.v1'
export const CONTACT_HOURS = Object.freeze({ start_hour: 8, end_hour: 21 })
export const UNKNOWN_ZONE_FALLBACK = Object.freeze(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'])

const MIN = 60_000
const clean = (v) => String(v ?? '').trim()
const FMT = new Map()
function validZone(tz) {
  if (!tz || typeof tz !== 'string' || !tz.includes('/')) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}
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

/**
 * @param {{ recipientPhone?: string|null, propertyGeography?: {state?: string|null, zip?: string|null}|null,
 *           mailingGeography?: {state?: string|null, zip?: string|null}|null, storedTimezone?: string|null }} a
 * @returns {{ version: string, zones: string[], certainty: 'single'|'multiple'|'property_only'|'stored_only'|'unknown', recipient_local: boolean, sources: Array<{source: string, zones: string[]}> }}
 */
export function resolveRecipientZones({ recipientPhone = null, propertyGeography = null, mailingGeography = null, storedTimezone = null } = {}) {
  const sources = []
  const ac = zonesForPhone(recipientPhone)
  if (ac?.length) sources.push({ source: 'recipient_area_code', zones: [...ac] })
  const geo = (g) => (g && (clean(g.state) || clean(g.zip)) ? deriveTimezoneFromGeography(clean(g.state), clean(g.zip)) : null)
  const mail = geo(mailingGeography)
  if (mail?.confident && mail.iana) sources.push({ source: 'mailing_geography', zones: [mail.iana] })
  const prop = geo(propertyGeography)
  if (prop?.confident && prop.iana) sources.push({ source: 'property_geography', zones: [prop.iana] })
  const stored = storedTimezoneToIana(storedTimezone)
  if (!sources.length && stored) sources.push({ source: 'stored_timezone', zones: [stored] })
  const recipientLocal = sources.some((s) => s.source === 'recipient_area_code' || s.source === 'mailing_geography')
  const zones = normalizeZones(sources.flatMap((s) => s.zones))
  if (!zones.length) return { version: REPLY_TIMING_VERSION, zones: [...UNKNOWN_ZONE_FALLBACK], certainty: 'unknown', recipient_local: false, sources: [] }
  const certainty = zones.length > 1 ? 'multiple' : recipientLocal ? 'single' : sources[0].source === 'stored_timezone' ? 'stored_only' : 'property_only'
  return { version: REPLY_TIMING_VERSION, zones, certainty, recipient_local: recipientLocal, sources }
}

/** Is the local contact window open at `ms` in EVERY zone (the intersection)? */
export function localHoursOpen(ms, zones, hours = CONTACT_HOURS) {
  const zs = normalizeZones(zones)
  const list = zs.length ? zs : UNKNOWN_ZONE_FALLBACK
  return list.every((tz) => { const m = localMinutes(ms, tz); return m >= hours.start_hour * 60 && m < hours.end_hour * 60 })
}

/** The first instant ≥ ms (minute precision, ≤ 3 days ahead) at which the intersection is open, or null. */
export function nextLocalOpen(ms, zones, hours = CONTACT_HOURS) {
  if (localHoursOpen(ms, zones, hours)) return ms
  let t = Math.ceil(ms / MIN) * MIN
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

/**
 * THE eligibility function. `at` = the send instant being judged; `queuedAt` = when the reply row is
 * (or would be) queued — the planner and R3 queue at the send instant, the row gate passes the
 * row's real queue time. `sessionMinutes` defaults to the conversational window (system_control
 * conversational_reply_window_minutes, default 30); a caller may only shorten it (a margin).
 * @returns {{ version: string, lawful: boolean, basis: 'in_session'|'local_hours'|null, in_session: boolean, local_hours_open: boolean, session_reason: string|null, zones: string[], next_permitted_at: string|null }}
 */
export function evaluateReplyTiming({ purpose = 'reply', at, queuedAt = null, inboundId = null, inboundAt = null, zones = [], sessionMinutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, hours = CONTACT_HOURS } = {}) {
  const ms = Date.parse(clean(at))
  const zs = normalizeZones(zones)
  const list = zs.length ? zs : [...UNKNOWN_ZONE_FALLBACK]
  if (!Number.isFinite(ms)) return { version: REPLY_TIMING_VERSION, lawful: false, basis: null, in_session: false, local_hours_open: false, session_reason: 'invalid_instant', zones: list, next_permitted_at: null }
  let session = { in_session: false, reason: purpose === 'reply' ? 'session_disabled' : 'outreach_touch' }
  if (purpose === 'reply' && Number(sessionMinutes) > 0) {
    session = evaluateConversationalReply({
      is_reply: true, is_outreach: false, inbound_message_event_id: inboundId, inbound_received_at: inboundAt,
      queued_at: clean(queuedAt) || new Date(ms).toISOString(), now: new Date(ms).toISOString(),
      // the existing window's own cap applies; a caller can only shorten it
      window_minutes: Math.min(Number(sessionMinutes), DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES * 4),
    })
  }
  const local = localHoursOpen(ms, list, hours)
  const lawful = session.in_session === true || local
  const next = lawful ? ms : nextLocalOpen(ms, list, hours)
  return {
    version: REPLY_TIMING_VERSION,
    lawful,
    basis: session.in_session === true ? 'in_session' : local ? 'local_hours' : null,
    in_session: session.in_session === true,
    local_hours_open: local,
    session_reason: session.reason || null,
    zones: list,
    next_permitted_at: next == null ? null : new Date(next).toISOString(),
  }
}

/** Zones stamped on an AI row at enqueue (metadata.recipient_zones), validated; null when absent. */
export function rowRecipientZones(row = {}) {
  const meta = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const z = normalizeZones(meta.recipient_zones)
  return z.length ? z : null
}

/**
 * Dispatch-time verdict for a queued reply row: the row's own in-session evidence (the existing
 * evaluateInSessionReply, the same call the runner makes) + its stamped recipient zones.
 */
export function evaluateRowReplyTiming(row = {}, { now, windowMinutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, fallbackZones = null, hours = CONTACT_HOURS } = {}) {
  const ms = Date.parse(clean(now))
  const zones = rowRecipientZones(row) || normalizeZones(fallbackZones) || []
  const list = zones.length ? zones : [...UNKNOWN_ZONE_FALLBACK]
  const session = evaluateInSessionReply(row, { now, window_minutes: windowMinutes })
  const local = Number.isFinite(ms) && localHoursOpen(ms, list, hours)
  const lawful = session?.in_session === true || local
  const next = lawful || !Number.isFinite(ms) ? (Number.isFinite(ms) ? ms : null) : nextLocalOpen(ms, list, hours)
  return { version: REPLY_TIMING_VERSION, lawful, basis: session?.in_session === true ? 'in_session' : local ? 'local_hours' : null, in_session: session?.in_session === true, local_hours_open: local, session_reason: session?.reason || null, zones: list, zones_source: rowRecipientZones(row) ? 'row_metadata' : 'fallback', next_permitted_at: next == null ? null : new Date(next).toISOString() }
}
