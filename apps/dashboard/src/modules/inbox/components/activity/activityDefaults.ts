import type { ThreadMessage } from '../../../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../../../lib/data/inboxWorkflowData'
import { type ActivityFilters, type ActivityEvent } from '../../inbox-ui-helpers'

export const getDefaultActivityFilters = (): ActivityFilters => ({
  category: 'all',
  search: '',
  importantOnly: true,
  showSuppressed: true,
  showAutomationEvents: true,
  showOperatorEvents: true,
})

export const shouldAutoExpandActivity = (
  thread: InboxWorkflowThread,
  messages: ThreadMessage[],
  events: ActivityEvent[],
): boolean => {
  const now = Date.now()
  const hasRecentInbound = messages.some((message) => (
    message.direction === 'inbound' && Number.isFinite(new Date(message.createdAt).getTime()) &&
    now - new Date(message.createdAt).getTime() < 6 * 60 * 60 * 1000
  ))
  const hasRisk = events.some((event) => event.severity === 'critical' || event.severity === 'warning' || event.severity === 'suppressed')
  const hasDealMovement = events.some((event) => event.entityType === 'offer' || event.entityType === 'contract' || event.entityType === 'title')
  return hasRecentInbound || hasRisk || hasDealMovement || thread.inboxStatus === 'suppressed'
}
