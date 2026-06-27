/**
 * LeadCommand operator sound assets (MP3).
 *
 * Files live in /sounds at repo root and are served from /sounds/*.mp3
 * via apps/dashboard/public/sounds.
 */
export type SoundAssetId =
  | 'priority-sms'
  | 'new-sms'
  | 'new-alert'
  | 'error-alert'
  | 'deal-to-offer-stage'

export const SOUND_ASSET_URLS: Record<SoundAssetId, string> = {
  'priority-sms': '/sounds/priority-sms.mp3',
  'new-sms': '/sounds/new-sms.mp3',
  'new-alert': '/sounds/new-alert.mp3',
  'error-alert': '/sounds/error-alert.mp3',
  'deal-to-offer-stage': '/sounds/deal-to-offer-stage.mp3',
}

export const SOUND_ASSET_LABELS: Record<SoundAssetId, string> = {
  'priority-sms': 'Priority SMS',
  'new-sms': 'New SMS',
  'new-alert': 'New Alert',
  'error-alert': 'Error Alert',
  'deal-to-offer-stage': 'Deal / Offer Stage',
}

/** Map legacy + intelligence sound events to bundled MP3 assets. */
export const SOUND_EVENT_ASSET_MAP: Partial<Record<string, SoundAssetId>> = {
  'hot-lead-escalation': 'priority-sms',
  'inbound-reply': 'new-sms',
  'seller-reply': 'new-sms',
  'alert-triggered': 'new-alert',
  'notification': 'new-alert',
  'toast-arrive': 'new-alert',
  'warning-alert': 'new-alert',
  'campaign-activity': 'new-alert',
  'positive-outcome': 'new-alert',
  'queue-issue': 'error-alert',
  'critical-system': 'error-alert',
  'ui-error': 'error-alert',
  'offer-contract': 'deal-to-offer-stage',
  'buyer-match': 'deal-to-offer-stage',
  'title-clear': 'deal-to-offer-stage',
  'closing-scheduled': 'deal-to-offer-stage',
  'contract-milestone': 'deal-to-offer-stage',
}

const PRIORITY_NOTIFICATION_TYPES = new Set([
  'inbox_hot_lead',
  'inbox_sla_breach',
  'inbox_thread_escalation',
  'hot_lead_untouched',
  'hot_lead_escalation',
  'inbox_hostile_reply',
])

const OFFER_NOTIFICATION_FRAGMENTS = [
  'offer',
  'asking',
  'price_captured',
  'price_received',
  'mao',
  'counter',
  'acquisition',
  'underwrite',
  'deal_intelligence',
  'comp_confidence',
  'negotiation',
  'contract',
  'closing',
]

const ERROR_NOTIFICATION_FRAGMENTS = [
  'failed',
  'failure',
  'error',
  'outage',
  'stopped',
  'degraded',
  'blacklist',
  '21610',
  'critical',
]

export function resolveNotificationSoundAsset(input: {
  type?: string
  domain?: string
  severity?: string
}): SoundAssetId {
  const type = String(input.type ?? '').toLowerCase()
  const domain = String(input.domain ?? '').toLowerCase()
  const severity = String(input.severity ?? '').toLowerCase()

  if (
    PRIORITY_NOTIFICATION_TYPES.has(type)
    || (domain === 'inbox' && severity === 'critical' && !type.includes('opt_out'))
  ) {
    return 'priority-sms'
  }

  if (
    domain === 'acquisition'
    || domain === 'closing'
    || OFFER_NOTIFICATION_FRAGMENTS.some((fragment) => type.includes(fragment))
  ) {
    return 'deal-to-offer-stage'
  }

  if (
    severity === 'critical'
    || domain === 'platform'
    || ERROR_NOTIFICATION_FRAGMENTS.some((fragment) => type.includes(fragment))
  ) {
    return 'error-alert'
  }

  if (domain === 'inbox') {
    return 'new-sms'
  }

  if (
    severity === 'warning'
    || domain === 'campaigns'
    || domain === 'templates'
    || domain === 'numbers'
    || domain === 'markets'
    || domain === 'workflow'
    || domain === 'intelligence'
  ) {
    return 'new-alert'
  }

  return 'new-alert'
}

export const SOUND_CATEGORY_ASSET_MAP = {
  'positive-outcome': 'new-alert',
  'seller-reply': 'new-sms',
  'campaign-activity': 'new-alert',
  'offer-contract': 'deal-to-offer-stage',
  'warning-alert': 'new-alert',
  'critical-system': 'error-alert',
} as const satisfies Record<string, SoundAssetId>