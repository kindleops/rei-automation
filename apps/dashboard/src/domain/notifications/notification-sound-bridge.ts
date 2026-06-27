/**
 * Notification sound bridge — maps intelligence events to NEXUS sound events
 * with dedup, grouping, quiet hours, and preference-aware volume.
 */
import { loadSettings } from '../../shared/settings'
import {
  resolveNotificationSoundAsset,
  SOUND_CATEGORY_ASSET_MAP,
} from '../../shared/sound-assets'
import { playSoundAsset, previewSoundAsset } from '../../shared/sounds'
import type { NotificationEvent, NotificationPreferences, SoundCategory } from './notification-contract'

const SETTINGS_ENABLED_KEY: Record<SoundCategory, keyof ReturnType<typeof loadSettings>> = {
  'positive-outcome': 'soundPositiveOutcome',
  'seller-reply': 'soundSellerReply',
  'campaign-activity': 'soundCampaignActivity',
  'offer-contract': 'soundOfferContract',
  'warning-alert': 'soundWarningAlert',
  'critical-system': 'soundCriticalSystem',
}

const SETTINGS_VOLUME_KEY: Record<SoundCategory, keyof ReturnType<typeof loadSettings>> = {
  'positive-outcome': 'soundPositiveOutcomeVolume',
  'seller-reply': 'soundSellerReplyVolume',
  'campaign-activity': 'soundCampaignActivityVolume',
  'offer-contract': 'soundOfferContractVolume',
  'warning-alert': 'soundWarningAlertVolume',
  'critical-system': 'soundCriticalSystemVolume',
}

const SEVERITY_PRIORITY: Record<NotificationEvent['severity'], number> = {
  critical: 4,
  warning: 3,
  positive: 2,
  neutral: 1,
}

const DEDUP_WINDOW_MS = 4_500
const recentPlays = new Map<string, number>()

function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

export function isWithinQuietHours(
  now = new Date(),
  prefs?: Pick<NotificationPreferences, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>,
): boolean {
  const settings = loadSettings()
  const enabled = prefs?.quietHoursEnabled ?? settings.notificationQuietHoursEnabled
  if (!enabled) return false

  const start = parseTimeToMinutes(prefs?.quietHoursStart ?? settings.notificationQuietHoursStart)
  const end = parseTimeToMinutes(prefs?.quietHoursEnd ?? settings.notificationQuietHoursEnd)
  if (start == null || end == null) return false

  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

export function resolveNotificationVolume(category: SoundCategory): number {
  const settings = loadSettings()
  const volumeKey = SETTINGS_VOLUME_KEY[category]
  const categoryVolume = Number(settings[volumeKey])
  if (Number.isFinite(categoryVolume)) {
    return Math.min(1, Math.max(0, categoryVolume)) * settings.soundVolume
  }
  return settings.soundVolume
}

export function shouldPlayNotificationSound(
  event: Pick<NotificationEvent, 'domain' | 'soundCategory'>,
  prefs?: Partial<NotificationPreferences>,
): boolean {
  const settings = loadSettings()
  if (!settings.soundEnabled) return false
  if (settings.notificationMasterMuted || prefs?.masterMuted) return false
  if (isWithinQuietHours(undefined, prefs as NotificationPreferences)) return false

  const domainMuted = prefs?.domainMutes?.[event.domain]
    ?? settings.notificationDomainMutes?.[event.domain]
  if (domainMuted) return false

  const enabledKey = SETTINGS_ENABLED_KEY[event.soundCategory]
  if (settings[enabledKey] === false) return false
  if (prefs?.soundCategoryEnabled?.[event.soundCategory] === false) return false

  return true
}

function dedupKey(event: NotificationEvent): string {
  return event.groupKey ?? `${event.domain}:${event.type}:${event.soundCategory}`
}

function shouldDedup(key: string, now: number): boolean {
  const last = recentPlays.get(key)
  if (last != null && now - last < DEDUP_WINDOW_MS) return true
  recentPlays.set(key, now)
  return false
}

export function playNotificationSound(
  event: NotificationEvent,
  prefs?: Partial<NotificationPreferences>,
): void {
  if (!shouldPlayNotificationSound(event, prefs)) return

  const now = Date.now()
  const key = dedupKey(event)
  if (shouldDedup(key, now)) return

  const asset = resolveNotificationSoundAsset({
    type: event.type,
    domain: event.domain,
    severity: event.severity,
  })
  const volume = resolveNotificationVolume(event.soundCategory)
  playSoundAsset(asset, volume)
}

/**
 * When a batch of new notifications arrives, play only the highest-priority
 * grouped sound once (prevents notification storms).
 */
export function playGroupedNotificationSounds(
  events: NotificationEvent[],
  prefs?: Partial<NotificationPreferences>,
): void {
  if (!events.length) return

  const playable = events.filter((event) => shouldPlayNotificationSound(event, prefs))
  if (!playable.length) return

  const byCategory = new Map<SoundCategory, NotificationEvent>()
  for (const event of playable) {
    const existing = byCategory.get(event.soundCategory)
    if (!existing || SEVERITY_PRIORITY[event.severity] > SEVERITY_PRIORITY[existing.severity]) {
      byCategory.set(event.soundCategory, event)
    }
  }

  const winners = [...byCategory.values()].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  )

  // Play only the top event — grouped behavior
  playNotificationSound(winners[0], prefs)
}

export function previewNotificationSound(category: SoundCategory): void {
  const asset = SOUND_CATEGORY_ASSET_MAP[category]
  const volume = resolveNotificationVolume(category)
  previewSoundAsset(asset, volume)
}