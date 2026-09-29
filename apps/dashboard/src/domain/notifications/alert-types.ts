import type { SoundAssetId } from '../../shared/sound-assets'

/**
 * ALERT TYPES — what the operator turns on/off and picks sounds for.
 *
 * Mirrors apps/api/src/lib/domain/notifications/alert-types.js exactly (the
 * server uses the same mapping to decide which phones a push goes to). Both
 * sides are pinned by tests; change them together.
 */
export type AlertType = 'seller_reply' | 'hot_lead' | 'opt_out' | 'campaign' | 'system'

export const ALERT_TYPES: AlertType[] = ['seller_reply', 'hot_lead', 'opt_out', 'campaign', 'system']

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  seller_reply: 'Seller replies',
  hot_lead: 'Hot leads & offers',
  opt_out: 'Opt-outs & negative replies',
  campaign: 'Campaign activity',
  system: 'System problems',
}

export const ALERT_TYPE_HINT: Record<AlertType, string> = {
  seller_reply: 'A seller texted back',
  hot_lead: 'Hot lead, ownership confirmed, price captured, offers',
  opt_out: 'STOP, wrong number, hostile or negative replies',
  campaign: 'Scheduled, launched, paused, finished',
  system: 'Delivery, sender numbers, webhooks, safety stops',
}

export const DEFAULT_ALERT_SOUND: Record<AlertType, SoundAssetId> = {
  seller_reply: 'new-sms',
  hot_lead: 'priority-sms',
  opt_out: 'new-alert',
  campaign: 'delivered-sms',
  system: 'error-alert',
}

/** Which types buzz a phone until the operator chooses otherwise for that device. */
export const PUSH_DEFAULTS: Record<AlertType, boolean> = {
  seller_reply: true,
  hot_lead: true,
  opt_out: false,
  campaign: false,
  system: true,
}

const HOT_FRAGMENTS = ['hot_lead', 'ownership_confirmed', 'price_captured', 'price_received', 'offer', 'contract', 'counter', 'closing', 'acquisition', 'motivat']
const OPT_OUT_FRAGMENTS = ['opt_out', 'negative', 'hostile', 'wrong_number', 'stop']

export function alertTypeFor(event: { type?: string | null; domain?: string | null; severity?: string | null }): AlertType {
  const type = String(event.type ?? '').toLowerCase()
  const domain = String(event.domain ?? '').toLowerCase()
  const severity = String(event.severity ?? '').toLowerCase()

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
