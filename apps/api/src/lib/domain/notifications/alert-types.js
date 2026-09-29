/**
 * ALERT TYPES — the operator-facing grouping of notifications.
 *
 * The operator turns alerts on and off, and picks sounds, per TYPE — not per
 * event_type (there are dozens) and not per severity (a seller reply is
 * `neutral`, yet it is the alert that matters most). This file is the single
 * mapping from a notification row to its type; the dashboard mirrors it in
 * src/domain/notifications/alert-types.ts, and the two are pinned by tests.
 *
 *   seller_reply  a seller texted back
 *   hot_lead      hot lead, ownership confirmed, price captured, offer/contract
 *   opt_out       opt-outs and negative/hostile replies
 *   campaign      campaign lifecycle (scheduled, activated, paused, archived)
 *   system        delivery, sender, webhook, safety and platform problems
 */

export const ALERT_TYPES = Object.freeze(['seller_reply', 'hot_lead', 'opt_out', 'campaign', 'system'])

/** Which types buzz a phone when the operator has not chosen for that device. */
export const PUSH_DEFAULTS = Object.freeze({
  seller_reply: true,
  hot_lead: true,
  opt_out: false,
  campaign: false,
  system: true,
})

/**
 * A type whose every emission is a NEW thing that happened (another message),
 * as opposed to a standing condition that re-reports. A new occurrence of these
 * re-opens a read or dismissed notification; a condition does not.
 */
export const OCCURRENCE_TYPES = Object.freeze(new Set(['seller_reply', 'hot_lead']))

const HOT_FRAGMENTS = ['hot_lead', 'ownership_confirmed', 'price_captured', 'price_received', 'offer', 'contract', 'counter', 'closing', 'acquisition', 'motivat']
const OPT_OUT_FRAGMENTS = ['opt_out', 'negative', 'hostile', 'wrong_number', 'stop']

export function alertTypeFor(row = {}) {
  const type = String(row.event_type ?? row.type ?? '').toLowerCase()
  const domain = String(row.domain ?? '').toLowerCase()
  const severity = String(row.severity ?? '').toLowerCase()

  if (domain === 'inbox' || type.startsWith('inbox_')) {
    if (OPT_OUT_FRAGMENTS.some((f) => type.includes(f))) return 'opt_out'
    if (HOT_FRAGMENTS.some((f) => type.includes(f))) return 'hot_lead'
    if (severity === 'critical' && !type.includes('message_received')) return 'system'
    return 'seller_reply'
  }
  if (domain === 'acquisition' || domain === 'closing' || HOT_FRAGMENTS.some((f) => type.includes(f))) return 'hot_lead'
  if (domain === 'campaigns' && severity !== 'critical' && !type.includes('stale') && !type.includes('fail')) return 'campaign'
  return 'system'
}

/** Should this subscription receive a push of this type? Stored choice first, else default. */
export function pushEnabledFor(subscriptionAlertTypes, alertType) {
  const stored = subscriptionAlertTypes && typeof subscriptionAlertTypes === 'object' ? subscriptionAlertTypes[alertType] : undefined
  return typeof stored === 'boolean' ? stored : PUSH_DEFAULTS[alertType] === true
}

/** Keep only known types with boolean values. */
export function sanitizeAlertTypes(input) {
  if (!input || typeof input !== 'object') return null
  const out = {}
  for (const key of ALERT_TYPES) if (typeof input[key] === 'boolean') out[key] = input[key]
  return out
}
