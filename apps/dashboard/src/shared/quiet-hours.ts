import { loadSettings } from './settings'

/**
 * The operator's quiet hours (this device's settings unless a preference set
 * is passed). Alerts still arrive in the notification centre, silently — every
 * sound system asks this one function.
 */
export interface QuietHoursPrefs {
  quietHoursEnabled?: boolean
  quietHoursStart?: string
  quietHoursEnd?: string
}

function toMinutes(value: string | undefined | null): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

export function isWithinQuietHours(now = new Date(), prefs?: QuietHoursPrefs): boolean {
  const settings = loadSettings()
  const enabled = prefs?.quietHoursEnabled ?? settings.notificationQuietHoursEnabled
  if (!enabled) return false

  const start = toMinutes(prefs?.quietHoursStart ?? settings.notificationQuietHoursStart)
  const end = toMinutes(prefs?.quietHoursEnd ?? settings.notificationQuietHoursEnd)
  if (start == null || end == null) return false

  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}
