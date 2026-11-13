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
//   in session  the owner rule 2026-10-10 as already implemented for template replies
//               (owner ruling 2026-10-18: category 1, active seller conversation; no universal after-hours
//               block, only the jurisdiction × category restriction table, empty by default):
//               queue/conversational-reply-window.js#evaluateConversationalReply (a reply that
//               answers one inbound, queued within the conversational window of it, and still
//               inside that window at dispatch) is lawful at any hour;
//   otherwise   08:00–21:00 recipient-local, in EVERY plausible recipient zone (the intersection).
//
// RECIPIENT ZONE EVIDENCE + THE WINDOW: queue/recipient-window-policy.js (rc-8.5.21 S3), the same
// resolver and verdict the follow-up lifecycle and sms-engine#evaluateContactWindow call. Area code,
// then mailing evidence; property / stored zones only narrow; unknown ⇒ the conservative continental
// intersection (11:00–21:00 Eastern). The category (classifyMessagingCategory) and the verdict
// (evaluateMessagingWindow) are that module's too.
import { evaluateConversationalReply, evaluateInSessionReply, DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES } from './conversational-reply-window.js'
import {
  CONTACT_HOURS, UNKNOWN_ZONE_FALLBACK, RECIPIENT_WINDOW_POLICY_VERSION, MESSAGING_CATEGORIES, normalizeZones, localHoursOpen, nextLocalOpen,
  resolveRecipientWindowZones, recipientEvidenceFromRow, classifyMessagingCategory, evaluateMessagingWindow,
} from './recipient-window-policy.js'

// rc-8.5.21 S3: the zone resolver, the window arithmetic and the in-session setting live in the ONE
// recipient-timezone policy module (recipient-window-policy.js); this module keeps the reply-specific
// session evaluation and re-exports the shared pieces for its existing callers.
export { CONTACT_HOURS, UNKNOWN_ZONE_FALLBACK, RECIPIENT_WINDOW_POLICY_VERSION, MESSAGING_CATEGORIES, normalizeZones, localHoursOpen, nextLocalOpen }
export const REPLY_TIMING_VERSION = 'reply-timing.v2'

const clean = (v) => String(v ?? '').trim()

/**
 * The recipient zone set (recipient-window-policy.js#resolveRecipientWindowZones): area code, then
 * mailing evidence; the property / stored zone only narrows; no recipient evidence ⇒ 'unknown' with the
 * conservative continental intersection.
 * @param {{ recipientPhone?: string|null, propertyGeography?: {state?: string|null, zip?: string|null}|null,
 *           mailingGeography?: {state?: string|null, zip?: string|null}|null, storedTimezone?: string|null }} a
 */
export function resolveRecipientZones({ recipientPhone = null, propertyGeography = null, mailingGeography = null, storedTimezone = null, verifiedTimezone = null, locationHistory = null } = {}) {
  return resolveRecipientWindowZones({ recipientPhone, propertyGeography, mailingGeography, storedTimezone, verifiedTimezone, locationHistory })
}

/**
 * THE eligibility function. `at` = the send instant being judged; `queuedAt` = when the reply row is
 * (or would be) queued — the planner and R3 queue at the send instant, the row gate passes the
 * row's real queue time. `sessionMinutes` defaults to the conversational window (system_control
 * conversational_reply_window_minutes, default 30); a caller may only shorten it (a margin).
 * @returns {{ version: string, lawful: boolean, basis: 'in_session'|'local_hours'|null, in_session: boolean, local_hours_open: boolean, session_reason: string|null, zones: string[], next_permitted_at: string|null }}
 */
export function evaluateReplyTiming({ purpose = 'reply', at, queuedAt = null, inboundId = null, inboundAt = null, zones = [], jurisdictions = [], sessionMinutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, hours = CONTACT_HOURS, restrictions = undefined } = {}) {
  const ms = Date.parse(clean(at))
  if (!Number.isFinite(ms)) {
    const zs = normalizeZones(zones)
    return { version: REPLY_TIMING_VERSION, lawful: false, basis: null, in_session: false, local_hours_open: false, session_reason: 'invalid_instant', zones: zs.length ? zs : [...UNKNOWN_ZONE_FALLBACK], next_permitted_at: null }
  }
  let session = { in_session: false, reason: purpose === 'reply' ? 'session_disabled' : 'outreach_touch' }
  if (purpose === 'reply' && Number(sessionMinutes) > 0) {
    session = evaluateConversationalReply({
      is_reply: true, is_outreach: false, inbound_message_event_id: inboundId, inbound_received_at: inboundAt,
      queued_at: clean(queuedAt) || new Date(ms).toISOString(), now: new Date(ms).toISOString(),
      // the existing window's own cap applies; a caller can only shorten it
      window_minutes: Math.min(Number(sessionMinutes), DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES * 4),
    })
  }
  // THE category (owner ruling 2026-10-18): only an in-session reply is an active seller conversation;
  // outreach and an out-of-session reply wait for the recipient-local window
  const c = classifyMessagingCategory(purpose === 'reply' ? { isReply: true, inSession: session.in_session === true } : { kind: purpose === 'campaign' ? 'campaign' : 'followup' })
  const v = evaluateMessagingWindow({ category: c.category, at: ms, zones, jurisdictions, hours, ...(restrictions ? { restrictions } : {}) })
  return {
    version: REPLY_TIMING_VERSION,
    lawful: v.lawful,
    basis: v.lawful ? (c.category === MESSAGING_CATEGORIES.ACTIVE_CONVERSATION ? 'in_session' : 'local_hours') : null,
    category: c.category,
    in_session: session.in_session === true,
    local_hours_open: v.local_hours_open,
    session_reason: session.reason || null,
    restrictions_applied: v.restrictions_applied,
    zones: v.zones,
    next_permitted_at: v.next_permitted_at,
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
 * evaluateInSessionReply, the same call the runner makes) + the recipient zones resolved from the row
 * by THE policy (stamp, area code, property narrowing) — the same resolution evaluateContactWindow uses.
 * `fallbackZones` (legacy) can only narrow.
 */
export function evaluateRowReplyTiming(row = {}, { now, windowMinutes = DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, fallbackZones = null, propertyGeography = null, hours = CONTACT_HOURS, restrictions = undefined } = {}) {
  const ms = Date.parse(clean(now))
  const resolution = resolveRecipientWindowZones(recipientEvidenceFromRow(row, { propertyGeography }))
  const zones = normalizeZones([...resolution.zones, ...normalizeZones(fallbackZones)])
  const session = evaluateInSessionReply(row, { now, window_minutes: windowMinutes })
  const c = classifyMessagingCategory({ row, session })
  const v = evaluateMessagingWindow({ category: c.category, at: ms, zones, jurisdictions: resolution.jurisdictions, hours, ...(restrictions ? { restrictions } : {}) })
  const lawful = Number.isFinite(ms) && v.lawful
  return {
    version: REPLY_TIMING_VERSION,
    lawful,
    basis: lawful ? (c.category === MESSAGING_CATEGORIES.ACTIVE_CONVERSATION ? 'in_session' : 'local_hours') : null,
    category: c.category,
    in_session: session?.in_session === true,
    local_hours_open: Number.isFinite(ms) && v.local_hours_open,
    session_reason: session?.reason || null,
    restrictions_applied: v.restrictions_applied,
    zones: v.zones,
    certainty: resolution.certainty,
    zones_source: rowRecipientZones(row) ? 'row_metadata' : 'fallback',
    next_permitted_at: v.next_permitted_at,
  }
}
