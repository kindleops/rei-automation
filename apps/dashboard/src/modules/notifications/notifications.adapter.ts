import type { CommandCenterStore } from '../../domain/types'
import { formatRelativeTime } from '../../shared/formatters'

export interface NotificationItem {
  id: string
  kind: 'autopilot' | 'alert' | 'deal' | 'system' | 'inbox'
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  read: boolean
  actionLabel: string | null
  actionRoute: string | null
  timestampLabel: string
  timestampIso: string
}

export interface NotificationsModel {
  items: NotificationItem[]
  unreadCount: number
  totalCount: number
}

export const adaptNotificationsModel = (store: CommandCenterStore): NotificationsModel => {
  const items: NotificationItem[] = store.notificationIds.map((id) => {
    const raw = store.notificationsById[id]!
    return {
      ...raw,
      timestampLabel: formatRelativeTime(raw.timestampIso),
    }
  })

  items.sort((a, b) => new Date(b.timestampIso).getTime() - new Date(a.timestampIso).getTime())

  return {
    items,
    unreadCount: items.filter((i) => !i.read).length,
    totalCount: items.length,
  }
}

export const loadNotifications = async (): Promise<NotificationsModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptNotificationsModel(store)
}
