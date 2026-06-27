import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { loadSettings, subscribeSettings, updateSetting } from '../../shared/settings'
import {
  executeNotificationAction,
  fetchNotifications,
  fetchPreferences,
  patchNotification,
  savePreferences,
  triggerScan,
} from './notification-api'
import type {
  NotificationEvent,
  NotificationListFilters,
  NotificationPatchOp,
  NotificationPreferences,
} from './notification-contract'
import { playGroupedNotificationSounds } from './notification-sound-bridge'

const POLL_INTERVAL_MS = 30_000
const POLL_BACKOFF_MAX_MS = 5 * 60_000

export interface NotificationIntelligenceState {
  notifications: NotificationEvent[]
  unreadCount: number
  total: number
  loading: boolean
  error: string | null
  preferences: NotificationPreferences
  preferencesLoading: boolean
  lastFetchedAt: string | null
  scanning: boolean
}

export interface NotificationIntelligenceActions {
  refresh: (filters?: NotificationListFilters) => Promise<void>
  patch: (id: string, op: NotificationPatchOp, extras?: { ids?: string[]; snoozeUntil?: string; muteSource?: boolean }) => Promise<void>
  runAction: (id: string, actionType: string, payload?: Record<string, unknown>) => Promise<{ href?: string | null }>
  savePrefs: (prefs: NotificationPreferences) => Promise<void>
  scan: () => Promise<void>
  muteDomain: (domain: NotificationEvent['domain'], muted?: boolean) => void
  setMasterMuted: (muted: boolean) => void
}

export type NotificationIntelligenceValue = NotificationIntelligenceState & NotificationIntelligenceActions

const NotificationIntelligenceContext = createContext<NotificationIntelligenceValue | null>(null)

function defaultPreferences(): NotificationPreferences {
  const settings = loadSettings()
  return {
    masterMuted: settings.notificationMasterMuted,
    quietHoursEnabled: settings.notificationQuietHoursEnabled,
    quietHoursStart: settings.notificationQuietHoursStart,
    quietHoursEnd: settings.notificationQuietHoursEnd,
    domainMutes: { ...(settings.notificationDomainMutes ?? {}) },
    soundCategoryEnabled: {},
    soundCategoryVolumes: {},
  }
}

function useNotificationIntelligenceInternal(): NotificationIntelligenceValue {
  const [notifications, setNotifications] = useState<NotificationEvent[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultPreferences)
  const [preferencesLoading, setPreferencesLoading] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const knownIdsRef = useRef<Set<string>>(new Set())
  const initialLoadRef = useRef(true)
  const filtersRef = useRef<NotificationListFilters>({ limit: 120, includeSnoozed: false })
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const pollBackoffMsRef = useRef(POLL_INTERVAL_MS)

  const applyLocalPatch = useCallback((id: string, op: NotificationPatchOp, extras?: { ids?: string[]; snoozeUntil?: string }) => {
    const targetIds = op.startsWith('bulk_') ? (extras?.ids ?? []) : [id]
    setNotifications((prev) => {
      if (op === 'dismiss' || op === 'bulk_dismiss' || op === 'clear') {
        return prev.filter((item) => !targetIds.includes(item.id))
      }

      return prev.map((item) => {
        if (!targetIds.includes(item.id)) return item
        if (op === 'mark_read' || op === 'bulk_mark_read') {
          return { ...item, status: 'read' as const, readAt: new Date().toISOString() }
        }
        if (op === 'mark_unread') {
          return { ...item, status: 'unread' as const, readAt: null }
        }
        if (op === 'snooze') {
          return { ...item, status: 'snoozed' as const, snoozedUntil: extras?.snoozeUntil ?? null }
        }
        return item
      })
    })
  }, [])

  const refresh = useCallback(async (filters?: NotificationListFilters) => {
    if (filters) filtersRef.current = { ...filtersRef.current, ...filters }

    setLoading((prev) => prev || initialLoadRef.current)
    const result = await fetchNotifications(filtersRef.current)
    setLoading(false)

    if (!result.ok) {
      const isUnavailable = [404, 405, 500, 502, 503].includes(Number(result.status))
        || /not found|schema cache|unavailable/i.test(String(result.message ?? result.error ?? ''))
      if (isUnavailable) {
        pollBackoffMsRef.current = Math.min(POLL_BACKOFF_MAX_MS, pollBackoffMsRef.current * 2)
      }
      setError(result.message ?? result.error ?? 'Unable to load notifications')
      if (initialLoadRef.current) {
        setNotifications([])
        setUnreadCount(0)
        setTotal(0)
      }
      return
    }

    pollBackoffMsRef.current = POLL_INTERVAL_MS

    setError(null)
    setNotifications(result.notifications)
    setUnreadCount(result.unreadCount)
    setTotal(result.total)
    setLastFetchedAt(result.scannedAt ?? new Date().toISOString())

    if (!initialLoadRef.current) {
      const known = knownIdsRef.current
      const freshUnread = result.notifications.filter(
        (item) => item.status === 'unread' && !known.has(item.id),
      )
      if (freshUnread.length) {
        playGroupedNotificationSounds(freshUnread, preferencesRef.current)
      }
    }

    knownIdsRef.current = new Set(result.notifications.map((item) => item.id))
    initialLoadRef.current = false
  }, [])

  const loadPrefs = useCallback(async () => {
    setPreferencesLoading(true)
    const result = await fetchPreferences()
    setPreferencesLoading(false)

    if (result.ok) {
      setPreferences(result.preferences)
      return
    }

    setPreferences(defaultPreferences())
  }, [])

  useEffect(() => {
    void refresh()
    void loadPrefs()
  }, [loadPrefs, refresh])

  useEffect(() => {
    let timeoutId = 0
    const schedulePoll = () => {
      timeoutId = window.setTimeout(() => {
        void refresh().finally(schedulePoll)
      }, pollBackoffMsRef.current)
    }
    schedulePoll()
    return () => window.clearTimeout(timeoutId)
  }, [refresh])

  useEffect(() => {
    const unsubSettings = subscribeSettings(() => {
      setPreferences((prev) => ({
        ...prev,
        masterMuted: loadSettings().notificationMasterMuted,
        quietHoursEnabled: loadSettings().notificationQuietHoursEnabled,
        quietHoursStart: loadSettings().notificationQuietHoursStart,
        quietHoursEnd: loadSettings().notificationQuietHoursEnd,
        domainMutes: { ...(loadSettings().notificationDomainMutes ?? {}) },
      }))
    })
    return unsubSettings
  }, [])

  const patch = useCallback(async (
    id: string,
    op: NotificationPatchOp,
    extras?: { ids?: string[]; snoozeUntil?: string; muteSource?: boolean },
  ) => {
    applyLocalPatch(id, op, extras)
    const result = await patchNotification(id, op, extras)
    if (!result.ok) {
      setError(result.message ?? result.error ?? 'Notification update failed')
      await refresh()
      return
    }
    await refresh()
  }, [applyLocalPatch, refresh])

  const runAction = useCallback(async (id: string, actionType: string, payload: Record<string, unknown> = {}) => {
    const result = await executeNotificationAction(id, actionType, payload)
    if (!result.ok) {
      setError(result.message ?? result.error ?? 'Notification action failed')
      return { href: null }
    }
    await patch(id, 'mark_read')
    return { href: result.href ?? null }
  }, [patch])

  const savePrefs = useCallback(async (prefs: NotificationPreferences) => {
    setPreferences(prefs)
    updateSetting('notificationMasterMuted', prefs.masterMuted)
    updateSetting('notificationQuietHoursEnabled', prefs.quietHoursEnabled)
    updateSetting('notificationQuietHoursStart', prefs.quietHoursStart)
    updateSetting('notificationQuietHoursEnd', prefs.quietHoursEnd)
    updateSetting('notificationDomainMutes', prefs.domainMutes as Record<string, boolean>)

    const result = await savePreferences(prefs)
    if (!result.ok) {
      setError(result.message ?? result.error ?? 'Failed to save notification preferences')
      return
    }
    setPreferences(result.preferences)
  }, [])

  const scan = useCallback(async () => {
    setScanning(true)
    const result = await triggerScan()
    setScanning(false)
    if (!result.ok) {
      setError(result.message ?? result.error ?? 'Notification scan failed')
      return
    }
    await refresh()
  }, [refresh])

  const muteDomain = useCallback((domain: NotificationEvent['domain'], muted = true) => {
    const settings = loadSettings()
    const nextMutes = { ...(settings.notificationDomainMutes ?? {}), [domain]: muted }
    updateSetting('notificationDomainMutes', nextMutes)
    setPreferences((prev) => ({
      ...prev,
      domainMutes: { ...prev.domainMutes, [domain]: muted },
    }))
  }, [])

  const setMasterMuted = useCallback((muted: boolean) => {
    updateSetting('notificationMasterMuted', muted)
    setPreferences((prev) => ({ ...prev, masterMuted: muted }))
  }, [])

  return useMemo(() => ({
    notifications,
    unreadCount,
    total,
    loading,
    error,
    preferences,
    preferencesLoading,
    lastFetchedAt,
    scanning,
    refresh,
    patch,
    runAction,
    savePrefs,
    scan,
    muteDomain,
    setMasterMuted,
  }), [
    notifications,
    unreadCount,
    total,
    loading,
    error,
    preferences,
    preferencesLoading,
    lastFetchedAt,
    scanning,
    refresh,
    patch,
    runAction,
    savePrefs,
    scan,
    muteDomain,
    setMasterMuted,
  ])
}

export function NotificationIntelligenceProvider({ children }: { children: ReactNode }) {
  const value = useNotificationIntelligenceInternal()
  return (
    <NotificationIntelligenceContext.Provider value={value}>
      {children}
    </NotificationIntelligenceContext.Provider>
  )
}

export function useNotificationIntelligence(): NotificationIntelligenceValue {
  const ctx = useContext(NotificationIntelligenceContext)
  if (!ctx) {
    throw new Error('useNotificationIntelligence must be used within NotificationIntelligenceProvider')
  }
  return ctx
}