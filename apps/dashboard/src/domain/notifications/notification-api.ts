/**
 * LeadCommand Notification Intelligence — API client.
 */
import { callBackend } from '../../lib/api/backendClient'
import type {
  ApiNotificationActionResponse,
  ApiNotificationPatchResponse,
  ApiNotificationPreferencesResponse,
  ApiNotificationScanResponse,
  ApiNotificationsListResponse,
  NotificationEvent,
  NotificationListFilters,
  NotificationPatchOp,
  NotificationPreferences,
} from './notification-contract'
import {
  mapApiNotificationsList as mapList,
  mapApiPreferences as mapPrefs,
  serializePreferences as serializePrefs,
} from './notification-contract'

const BASE = '/api/cockpit/notifications'

function buildFilterQuery(filters: NotificationListFilters = {}): string {
  const qs = new URLSearchParams()

  const appendList = (key: string, value: string | string[] | undefined) => {
    if (!value) return
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) qs.append(key, item)
  }

  appendList('severity', filters.severity)
  appendList('domain', filters.domain)

  if (filters.search?.trim()) qs.set('search', filters.search.trim())
  if (filters.limit != null) qs.set('limit', String(filters.limit))
  if (filters.offset != null) qs.set('offset', String(filters.offset))
  if (filters.status) qs.set('status', String(filters.status))

  const query = qs.toString()
  return query ? `?${query}` : ''
}

function patchOpToAction(op: NotificationPatchOp): string {
  switch (op) {
    case 'mark_read':
    case 'bulk_mark_read':
      return 'mark_read'
    case 'mark_unread':
      return 'mark_unread'
    case 'dismiss':
    case 'bulk_dismiss':
      return 'dismiss'
    case 'clear':
      return 'clear'
    case 'snooze':
      return 'snooze'
    default:
      return op
  }
}

export interface FetchNotificationsResult {
  ok: boolean
  status?: number
  notifications: NotificationEvent[]
  unreadCount: number
  total: number
  scannedAt: string | null
  error?: string
  message?: string
}

export async function fetchNotifications(
  filters: NotificationListFilters = {},
  signal?: AbortSignal,
): Promise<FetchNotificationsResult> {
  const result = await callBackend<ApiNotificationsListResponse>(
    `${BASE}${buildFilterQuery(filters)}`,
    { signal },
  )

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      notifications: [],
      unreadCount: 0,
      total: 0,
      scannedAt: null,
      error: result.error,
      message: result.message,
    }
  }

  const mapped = mapList(result.data)
  return {
    ok: true,
    ...mapped,
  }
}

export async function patchNotification(
  id: string,
  op: NotificationPatchOp,
  extras: { ids?: string[]; snoozeUntil?: string; muteSource?: boolean } = {},
): Promise<{ ok: boolean; notification?: NotificationEvent; affectedCount?: number; error?: string; message?: string }> {
  if (op === 'bulk_mark_read' || op === 'bulk_dismiss') {
    const bulkResult = await callBackend<{ ok?: boolean; updated_count?: number; error?: string }>(
      `${BASE}/bulk`,
      {
        method: 'POST',
        body: JSON.stringify({
          ids: extras.ids ?? [],
          action: patchOpToAction(op),
        }),
      },
    )
    if (!bulkResult.ok) {
      return { ok: false, error: bulkResult.error, message: bulkResult.message }
    }
    return {
      ok: Boolean(bulkResult.data?.ok ?? true),
      affectedCount: bulkResult.data?.updated_count,
    }
  }

  const result = await callBackend<ApiNotificationPatchResponse>(
    `${BASE}/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        action: patchOpToAction(op),
        snoozed_until: extras.snoozeUntil,
        mute_source: extras.muteSource,
      }),
    },
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message }
  }

  const row = result.data?.notification
  return {
    ok: Boolean(result.data?.ok ?? true),
    affectedCount: result.data?.affected_count,
    notification: row ? mapList({ notifications: [row] }).notifications[0] : undefined,
    error: result.data?.error,
    message: result.data?.message,
  }
}

export async function executeNotificationAction(
  id: string,
  actionType: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; href?: string | null; result?: Record<string, unknown>; error?: string; message?: string }> {
  const result = await callBackend<ApiNotificationActionResponse>(
    `${BASE}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({
        notification_id: id,
        action_type: actionType,
        ...payload,
      }),
    },
  )

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message }
  }

  const navigation = result.data?.result?.navigation as { route?: string; params?: Record<string, string> } | undefined
  let href: string | null = result.data?.href ?? null
  if (!href && navigation?.route) {
    const params = navigation.params ?? {}
    const qs = new URLSearchParams(params).toString()
    href = qs ? `${navigation.route}?${qs}` : navigation.route
  }

  return {
    ok: Boolean(result.data?.ok ?? true),
    href,
    result: result.data?.result,
    error: result.data?.error,
    message: result.data?.message,
  }
}

export async function fetchPreferences(signal?: AbortSignal): Promise<{ ok: boolean; preferences: NotificationPreferences; error?: string; message?: string }> {
  const result = await callBackend<ApiNotificationPreferencesResponse>(`${BASE}/preferences`, { signal })

  if (!result.ok) {
    return {
      ok: false,
      preferences: mapPrefs(null),
      error: result.error,
      message: result.message,
    }
  }

  return {
    ok: Boolean(result.data?.ok ?? true),
    preferences: mapPrefs(result.data?.preferences),
    error: result.data?.error,
    message: result.data?.message,
  }
}

export async function savePreferences(
  preferences: NotificationPreferences,
): Promise<{ ok: boolean; preferences: NotificationPreferences; error?: string; message?: string }> {
  const result = await callBackend<ApiNotificationPreferencesResponse>(`${BASE}/preferences`, {
    method: 'PUT',
    body: JSON.stringify({ preferences: serializePrefs(preferences) }),
  })

  if (!result.ok) {
    return {
      ok: false,
      preferences,
      error: result.error,
      message: result.message,
    }
  }

  return {
    ok: Boolean(result.data?.ok ?? true),
    preferences: mapPrefs(result.data?.preferences ?? serializePrefs(preferences)),
    error: result.data?.error,
    message: result.data?.message,
  }
}

export async function triggerScan(): Promise<{ ok: boolean; scanned?: number; created?: number; updated?: number; error?: string; message?: string }> {
  const result = await callBackend<ApiNotificationScanResponse>(BASE, {
    method: 'POST',
    body: JSON.stringify({ action: 'scan' }),
  })

  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message }
  }

  return {
    ok: Boolean(result.data?.ok ?? true),
    scanned: result.data?.scanned ?? result.data?.campaigns_checked,
    created: result.data?.created ?? result.data?.notifications_created,
    updated: result.data?.updated,
    error: result.data?.error,
    message: result.data?.message,
  }
}