import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import { notificationPath, type FocusTarget, type HomeInbox } from './home-signals'

/**
 * One stream of "what just happened", shared by the live ticker under the greeting
 * and the Live activity module. Notifications are the system's own events; seller
 * replies come from the inbox read. A reply that already has a notification is
 * listed once.
 */

export interface ActivityEntry {
  id: string
  tone: 'good' | 'warn' | 'bad' | 'neutral'
  title: string
  detail: string
  at: string | null
  target: FocusTarget
}

const NOTIFICATION_TONE: Record<NotificationEvent['severity'], ActivityEntry['tone']> = {
  positive: 'good',
  neutral: 'neutral',
  warning: 'warn',
  critical: 'bad',
}

export function buildActivity(notifications: NotificationEvent[], inbox: HomeInbox | null, limit = 6): ActivityEntry[] {
  const fromNotifications = notifications
    .filter((event) => event.status !== 'dismissed')
    .map((event): ActivityEntry => ({
      id: `n-${event.id}`,
      tone: NOTIFICATION_TONE[event.severity],
      title: event.title,
      detail: event.summary || event.body,
      at: event.createdAt,
      target: { kind: 'route', path: notificationPath(event) },
    }))
  const notified = new Set(notifications.map((event) => event.threadKey).filter(Boolean))
  const fromReplies = (inbox?.threads ?? [])
    .filter((thread) => thread.at && !notified.has(thread.threadKey))
    .map((thread): ActivityEntry => ({
      id: `r-${thread.id}`,
      tone: thread.hot ? 'warn' : 'good',
      title: `${thread.seller} replied`,
      detail: thread.preview || thread.address || '',
      at: thread.at,
      target: { kind: 'thread', thread },
    }))
  return [...fromNotifications, ...fromReplies]
    .sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
    .slice(0, limit)
}
