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
  GroupedNotification,
  NotificationEvent,
  NotificationListFilters,
  NotificationPatchOp,
  NotificationPreferences,
} from './notification-contract'
import { deduplicateNotifications } from './notification-contract'
import { playGroupedNotificationSounds } from './notification-sound-bridge'

const POLL_INTERVAL_MS = 30_000
const POLL_BACKOFF_MAX_MS = 5 * 60_000

/**
 * Tombstones — why they exist.
 *
 * `patch()` used to optimistically remove a card, then `await refresh()` on
 * BOTH the success and failure branches, replacing state wholesale from the
 * server. Any of the following brought the card straight back:
 *
 *   - the 30s poll landing between the optimistic removal and the server write
 *   - the failure branch refreshing and silently restoring the card
 *   - a duplicate row (the feed emits the same event keyed by '+1252…' and
 *     '252…') surviving and looking identical to the one just dismissed
 *
 * A tombstone records "the operator finished with this id" locally. Nothing
 * tombstoned renders again, whatever the server returns, until the tombstone
 * is explicitly reverted because the write failed.
 */
const TOMBSTONE_STORAGE_KEY = 'lc.notifications.tombstones.v1'
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

type TombstoneKind = 'dismissed' | 'snoozed'

interface Tombstone {
  kind: TombstoneKind
  /** For snoozes: when the item is allowed back. */
  until: number | null
  createdAt: number
}

function loadTombstones(): Map<string, Tombstone> {
  const map = new Map<string, Tombstone>()
  if (typeof window === 'undefined') return map
  try {
    const raw = window.sessionStorage.getItem(TOMBSTONE_STORAGE_KEY)
    if (!raw) return map
    const parsed = JSON.parse(raw) as Record<string, Tombstone>
    const now = Date.now()
    for (const [id, tombstone] of Object.entries(parsed)) {
      if (!tombstone) continue
      if (now - tombstone.createdAt > TOMBSTONE_TTL_MS) continue
      if (tombstone.kind === 'snoozed' && tombstone.until != null && tombstone.until <= now) continue
      map.set(id, tombstone)
    }
  } catch {
    // A corrupt store must never take the feed down.
  }
  return map
}

function persistTombstones(map: Map<string, Tombstone>) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Storage full or blocked — in-memory tombstones still hold for this session.
  }
}

export interface NotificationIntelligenceState {
  /** Deduplicated, tombstone-filtered, snooze-filtered. What the UI renders. */
  notifications: GroupedNotification[]
  /** Every row the server returned, before dedup. For counts and diagnostics. */
  rawNotifications: NotificationEvent[]
  /** How many rows dedup collapsed away this cycle. */
  duplicatesCollapsed: number
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
  // Unread is derived from the deduplicated, tombstone-filtered list below —
  // a server `unread_count` over the raw rows double-counts twin notifications.
  const [, setUnreadCount] = useState(0)
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
  const tombstonesRef = useRef<Map<string, Tombstone>>(loadTombstones())
  /** Bumped whenever tombstones change so derived state recomputes. */
  const [tombstoneVersion, setTombstoneVersion] = useState(0)

  const addTombstones = useCallback((ids: string[], kind: TombstoneKind, until?: string) => {
    const now = Date.now()
    const untilMs = until ? new Date(until).getTime() : null
    for (const id of ids) {
      tombstonesRef.current.set(id, {
        kind,
        until: Number.isFinite(untilMs) ? untilMs : null,
        createdAt: now,
      })
    }
    persistTombstones(tombstonesRef.current)
    setTombstoneVersion((v) => v + 1)
  }, [])

  const removeTombstones = useCallback((ids: string[]) => {
    for (const id of ids) tombstonesRef.current.delete(id)
    persistTombstones(tombstonesRef.current)
    setTombstoneVersion((v) => v + 1)
  }, [])

  /** Drop anything the operator has already finished with, plus live snoozes. */
  const applySuppression = useCallback((items: NotificationEvent[]): NotificationEvent[] => {
    const now = Date.now()
    let changed = false
    const kept = items.filter((item) => {
      const tombstone = tombstonesRef.current.get(item.id)
      if (tombstone) {
        if (tombstone.kind === 'dismissed') return false
        if (tombstone.until == null || tombstone.until > now) return false
        // Snooze expired — retire the tombstone and let the item back.
        tombstonesRef.current.delete(item.id)
        changed = true
      }
      // The server already excludes dismissed rows and live snoozes, but a
      // status-bearing row must never slip through client-side either.
      if (item.status === 'dismissed') return false
      if (item.status === 'snoozed') return false
      return true
    })
    if (changed) persistTombstones(tombstonesRef.current)
    return kept
  }, [])

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

    // Tombstones win over the server payload. A poll that lands mid-write can
    // no longer resurrect a card the operator just dismissed.
    const visible = applySuppression(result.notifications)

    setError(null)
    setNotifications(visible)
    setUnreadCount(visible.filter((item) => item.status === 'unread').length)
    setTotal(result.total)
    setLastFetchedAt(result.scannedAt ?? new Date().toISOString())

    if (!initialLoadRef.current) {
      const known = knownIdsRef.current
      const freshUnread = visible.filter(
        (item) => item.status === 'unread' && !known.has(item.id),
      )
      if (freshUnread.length) {
        playGroupedNotificationSounds(freshUnread, preferencesRef.current)
      }
    }

    knownIdsRef.current = new Set(visible.map((item) => item.id))
    initialLoadRef.current = false
  }, [applySuppression])

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
    const targetIds = op.startsWith('bulk_') ? (extras?.ids ?? []) : [id]
    const removesFromView = op === 'dismiss' || op === 'bulk_dismiss' || op === 'clear' || op === 'snooze'

    // Tombstone BEFORE the request so an in-flight poll cannot resurrect it.
    if (removesFromView) {
      addTombstones(targetIds, op === 'snooze' ? 'snoozed' : 'dismissed', extras?.snoozeUntil)
    }
    applyLocalPatch(id, op, extras)

    // Bulk ops fan out to one request per id when the caller passed a synthetic
    // lead id (the notification center passes 'all'), so drive them by ids.
    const requestId = op.startsWith('bulk_') ? (targetIds[0] ?? id) : id
    const result = await patchNotification(requestId, op, extras)

    if (!result.ok) {
      // Revert precisely. Refreshing here is what used to make dismissal look
      // like a no-op: the whole list came back from the server, card included,
      // with no indication anything had failed.
      if (removesFromView) removeTombstones(targetIds)
      setError(
        result.message
          ?? result.error
          ?? (removesFromView
            ? 'Could not update this notification, so it is still showing. Retry from the card menu.'
            : 'Notification update failed'),
      )
      await refresh()
      return
    }

    setError(null)
    await refresh()
  }, [addTombstones, applyLocalPatch, refresh, removeTombstones])

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

  // Collapse the '+1252…' / '252…' twin rows into one card. `tombstoneVersion`
  // is a dependency so an optimistic dismiss recomputes immediately.
  const visible = useMemo(
    () => applySuppression(notifications),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notifications, applySuppression, tombstoneVersion],
  )
  const grouped = useMemo(() => deduplicateNotifications(visible), [visible])
  const duplicatesCollapsed = visible.length - grouped.length
  const groupedUnreadCount = useMemo(
    () => grouped.filter((item) => item.status === 'unread').length,
    [grouped],
  )

  return useMemo(() => ({
    notifications: grouped,
    rawNotifications: notifications,
    duplicatesCollapsed,
    unreadCount: groupedUnreadCount,
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
    grouped,
    notifications,
    duplicatesCollapsed,
    groupedUnreadCount,
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