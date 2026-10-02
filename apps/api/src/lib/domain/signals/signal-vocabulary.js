/**
 * SIGNAL CENTER — the ONE severity vocabulary.
 *
 * Three vocabularies existed:
 *   envelope        info | attention | warning | critical          (platform/events/envelope.js)
 *   notifications   positive | neutral | warning | critical          (notification_events CHECK)
 *   10-01 proposal  critical | high | medium | low | info           (dropped)
 *
 * Signals speak the ENVELOPE vocabulary (a signal is a projection over envelope
 * events). The only crossings are here: toNotificationSeverity (signal → the
 * notification it raises) and the envelope's own severityOfNotification
 * (notification → envelope), re-exported so callers import both directions from
 * one place.
 */
import { SEVERITIES, severityOfNotification } from '@/lib/domain/platform/events/envelope.js'

export const SIGNAL_SEVERITIES = SEVERITIES
export { severityOfNotification }

const RANK = Object.freeze({ info: 0, attention: 1, warning: 2, critical: 3 })

export const isSignalSeverity = (s) => SIGNAL_SEVERITIES.includes(s)

/** Signal (envelope) severity → notification_events.severity. Attention is not
 *  "positive" news and is not quiet either: it is the warning tier there. */
export function toNotificationSeverity(severity) {
  switch (severity) {
    case 'critical': return 'critical'
    case 'warning':
    case 'attention': return 'warning'
    default: return 'neutral'
  }
}

/** The higher of two signal severities. */
export const maxSeverity = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a)
export const severityRank = (s) => RANK[s] ?? 0
