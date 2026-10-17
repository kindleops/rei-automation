// DRY-RUN bridge to the EXISTING deterministic eligibility functions. Not a copy:
//
//   evaluateSendTimeContactGuard  (queue/send-time-contact-guard.js) — suppression list,
//       automation suppressions, thread opt-out / suppressed state, wrong number, prior
//       not-owner replies. PURE over facts; facts come from the existing
//       loadSendTimeContactFacts(supabase, row) (read-only selects) or are injected.
//   evaluateReplyTiming           (queue/reply-timing.js) — THE shared send-time eligibility
//       function: in session (queue/conversational-reply-window.js, the owner rule as
//       implemented for templates) or 08–21 in every plausible recipient zone
//       (resolveRecipientZones: area code + mailing state + property state; unknown ⇒ the
//       conservative lower-48 intersection). The planner, R3 and the row gate call it too.
//
// Nothing here writes: the guard's runSendTimeContactGuard / block-send-at-compliance
// writers are deliberately NOT imported (they cancel/hold rows).
import { evaluateSendTimeContactGuard, loadSendTimeContactFacts } from '../queue/send-time-contact-guard.js'
import { evaluateReplyTiming, resolveRecipientZones } from '../queue/reply-timing.js'

// rc-8.5.21: the window verdict is THE shared eligibility function (queue/reply-timing.js) —
// in-session (the owner rule, as implemented for templates) OR 08–21 in every plausible
// recipient zone. outside_window is never null any more: an unknown zone is the conservative
// intersection, not a fail-open and not a blanket hold.
export const ELIGIBILITY_BRIDGE_VERSION = 'conv-ai.eligibility-bridge.v2'

/** The hypothetical reply row the existing guard evaluates (a reply, never an opener). */
export function hypotheticalReplyRow({ sellerPhone, ourPhone = null, threadKey = null, propertyId = null, prospectId = null, inboundId, inboundAt, now }) {
  return {
    id: `conv-ai-dry-run:${inboundId}`,
    type: 'auto_reply',
    message_type: 'auto_reply',
    to_phone_number: sellerPhone,
    from_phone_number: ourPhone,
    thread_key: threadKey || sellerPhone,
    property_id: propertyId,
    prospect_id: prospectId,
    is_first_touch: false,
    inbound_message_id: inboundId,
    created_at: now,
    metadata: { type: 'auto_reply', inbound_message_event_id: inboundId, inbound_received_at: inboundAt, dry_run: true, source: 'conversation_ai_shadow' },
  }
}

/**
 * @param {object} a
 * @param {object} a.row          hypotheticalReplyRow()
 * @param {object|null} [a.facts] injected facts (replay); else loaded read-only via the existing loader
 * @param {object|null} [a.supabase] read-only client for the existing loader
 * @param {string|null} [a.timezone] a stored recipient zone (label or IANA), if any
 * @param {{ state?: string|null, zip?: string|null }|null} [a.geography] the property's state / ZIP
 * @param {string} a.now
 * @returns {Promise<{ blocked: boolean, reasons: string[], outside_window: boolean|null, in_session: boolean|null, guard: object, version: string }>}
 */
export async function dryRunEligibility({ row, facts = null, supabase = null, loadFacts = loadSendTimeContactFacts, timezone = null, geography = null, mailingGeography = null, recipientZones = null, sessionMinutes = undefined, now }) {
  let f = facts
  const reasons = []
  if (!f) {
    try {
      f = await loadFacts(supabase, row)
    } catch {
      // fail closed, exactly like the existing runSendTimeContactGuard
      return { blocked: true, reasons: ['send_time_guard_read_failed'], outside_window: null, in_session: null, guard: { blocked: true, reason: 'send_time_guard_read_failed' }, version: ELIGIBILITY_BRIDGE_VERSION }
    }
  }
  const guard = evaluateSendTimeContactGuard(row, f, { now })
  if (guard.blocked) reasons.push(guard.reason)
  const zones = recipientZones || resolveRecipientZones({ recipientPhone: row.to_phone_number, propertyGeography: geography, mailingGeography, storedTimezone: timezone })
  const timing = evaluateReplyTiming({ at: now, queuedAt: now, inboundId: row.inbound_message_id, inboundAt: row.metadata?.inbound_received_at || null, zones: zones.zones, sessionMinutes })
  return {
    blocked: Boolean(guard.blocked), reasons, outside_window: !timing.lawful, timezone_basis: zones.certainty, in_session: timing.in_session,
    timing: { lawful: timing.lawful, basis: timing.basis, next_permitted_at: timing.next_permitted_at, zones: timing.zones, certainty: zones.certainty, sources: (zones.sources || []).map((x) => x.source) },
    guard: { blocked: guard.blocked, reason: guard.reason || null, reason_code: guard.reason_code || null, signal: guard.detail?.signal || null, source: guard.detail?.source || null },
    version: ELIGIBILITY_BRIDGE_VERSION,
  }
}
