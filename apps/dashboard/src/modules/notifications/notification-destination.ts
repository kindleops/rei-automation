import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import { pushRoutePath } from '../../app/router'
import { openInboxThread } from '../mobile/mobile-inbox-bridge'

/**
 * Where tapping a notification (in a centre, its pop-up or a push) takes the
 * operator — the exact object it is about, with its context:
 *   a seller conversation  → that thread (and its property, when one phone
 *                            carries two conversations)
 *   a property             → its decision room
 *   a campaign             → that campaign
 *   a closing              → that case on the Closing Desk
 * An explicit action href from the server always wins.
 */
export const inboxThreadHref = (threadKey: string, propertyId?: string | null): string =>
  `/inbox?thread=${encodeURIComponent(threadKey)}${propertyId ? `&thread_property=${encodeURIComponent(propertyId)}` : ''}`

const explicitHref = (event: NotificationEvent): string | null => {
  const primary = event.actions.find((action) => action.primary) ?? event.actions[0]
  return primary?.href || null
}

export const resolveNotificationDestination = (event: NotificationEvent): string | null => {
  const href = explicitHref(event)
  if (href) return href
  if (event.threadKey) return inboxThreadHref(event.threadKey, event.propertyId)
  if (event.propertyId) return `/deal-intelligence?property_id=${encodeURIComponent(event.propertyId)}`
  if (event.campaignId) return `/campaign-command?campaign=${encodeURIComponent(event.campaignId)}`
  if (event.contractId) return `/closing-desk?case=${encodeURIComponent(event.contractId)}`
  if (event.queueId) return '/queue'
  if (event.domain === 'workflow') return '/workflow-studio'
  if (event.domain === 'markets') return '/map'
  return null
}

/**
 * Open a notification's destination. A seller conversation opens through the
 * Inbox's own deep-link path (the pending thread survives a cold mount and the
 * Inbox opens exactly that conversation — never a different seller). Returns
 * false when the notification has nowhere to go.
 */
export function openNotificationDestination(event: NotificationEvent): boolean {
  if (!explicitHref(event) && event.threadKey) {
    openInboxThread({ threadKey: event.threadKey, propertyId: event.propertyId ?? null })
    return true
  }
  const href = resolveNotificationDestination(event)
  if (!href) return false
  pushRoutePath(href)
  return true
}
