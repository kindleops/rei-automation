// DRY-RUN bridge to the EXISTING deterministic eligibility functions. Not a copy:
//
//   evaluateSendTimeContactGuard  (queue/send-time-contact-guard.js) — suppression list,
//       automation suppressions, thread opt-out / suppressed state, wrong number, prior
//       not-owner replies. PURE over facts; facts come from the existing
//       loadSendTimeContactFacts(supabase, row) (read-only selects) or are injected.
//   isOutsideLocalContactWindow   (queue/conversational-reply-window.js) — the 08–21
//       recipient-local window; null when the zone is unknown (never a guess).
//   resolveRecipientTimezone      (queue/recipient-timezone.js) — the recipient's zone from
//       the PROPERTY's state/ZIP first, then a stored zone; unresolved ⇒ the window
//       verdict is null and the validator fails closed (never a Chicago default).
//   evaluateInSessionReply        (same module) — whether the existing engine would
//       treat this as an in-session reply (reported; the AI policy still applies its
//       own hours, which are never looser than the existing window).
//
// Nothing here writes: the guard's runSendTimeContactGuard / block-send-at-compliance
// writers are deliberately NOT imported (they cancel/hold rows).
import { evaluateSendTimeContactGuard, loadSendTimeContactFacts } from '../queue/send-time-contact-guard.js'
import { evaluateInSessionReply, isOutsideLocalContactWindow } from '../queue/conversational-reply-window.js'
import { resolveRecipientTimezone } from '../queue/recipient-timezone.js'

export const ELIGIBILITY_BRIDGE_VERSION = 'conv-ai.eligibility-bridge.v1'

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
export async function dryRunEligibility({ row, facts = null, supabase = null, loadFacts = loadSendTimeContactFacts, timezone = null, geography = null, now }) {
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
  const tz = resolveRecipientTimezone({ ...row, timezone }, { propertyGeography: geography })
  const outside = tz.ok ? isOutsideLocalContactWindow(now, tz.iana) : null
  let inSession = null
  try { inSession = Boolean(evaluateInSessionReply(row, { now })?.in_session) } catch { inSession = null }
  return { blocked: Boolean(guard.blocked), reasons, outside_window: outside, timezone_basis: tz.ok ? tz.basis : tz.reason, in_session: inSession, guard: { blocked: guard.blocked, reason: guard.reason || null, reason_code: guard.reason_code || null }, version: ELIGIBILITY_BRIDGE_VERSION }
}
