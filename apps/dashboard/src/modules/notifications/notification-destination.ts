import type { NotificationEvent } from '../../domain/notifications/notification-contract'

/** Where tapping a notification (in the centre or its pop-up) takes the operator. */
export const resolveNotificationDestination = (event: NotificationEvent): string | null => {
  const primary = event.actions.find((action) => action.primary) ?? event.actions[0]
  if (primary?.href) return primary.href
  if (event.threadKey) return `/inbox?thread=${encodeURIComponent(event.threadKey)}`
  if (event.propertyId) return `/deal-intelligence?property=${encodeURIComponent(event.propertyId)}`
  if (event.campaignId) return `/campaign-command?campaign=${encodeURIComponent(event.campaignId)}`
  if (event.contractId) return '/closing-desk'
  if (event.queueId) return '/queue'
  if (event.domain === 'workflow') return '/workflow-studio'
  if (event.domain === 'markets') return '/map'
  return null
}
