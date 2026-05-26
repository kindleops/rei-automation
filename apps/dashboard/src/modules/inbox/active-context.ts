import type { CalendarEvent } from '../../lib/data/calendarData'
import type { ThreadMessage } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { QueueItem } from '../../lib/data/queueData'
import type { CommandMapActivityEvent } from './commandMapLiveActivity'

export type InboxWorkspaceView =
  | 'thread'
  | 'sms_thread'
  | 'list'
  | 'deal_intelligence'
  | 'closing_desk'
  | 'command_map'
  | 'pipeline'
  | 'queue'
  | 'calendar'
  | 'metrics'
  | 'comp_intelligence'
  | 'buyer_match'
  | 'campaigns'

export type ActiveInboxContextIntent =
  | 'open_thread'
  | 'focus_map'
  | 'open_queue'
  | 'open_calendar'
  | 'open_seller'
  | 'filter_related'

export type ActiveInboxContextSource =
  | 'inbox'
  | 'thread'
  | 'pipeline'
  | 'list'
  | 'queue'
  | 'map'
  | 'calendar'
  | 'live_activity'

export type ActiveInboxContext = {
  sellerId?: string
  threadKey?: string
  propertyId?: string
  masterOwnerId?: string
  prospectId?: string
  queueId?: string
  messageEventId?: string
  activityId?: string
  market?: string
  date?: string
  sourceView?: ActiveInboxContextSource
  intent?: ActiveInboxContextIntent
}

export type SetActiveContextOptions = {
  focusView?: InboxWorkspaceView
  openThread?: boolean
  focusMap?: boolean
  centerMap?: boolean
  openSellerCard?: boolean
  preserveCurrentViews?: boolean
  addViewIfMissing?: boolean
}

const text = (value: unknown): string | undefined => {
  const next = String(value ?? '').trim()
  return next || undefined
}

export const buildContextFromThread = (
  thread: InboxWorkflowThread | null | undefined,
  sourceView: ActiveInboxContextSource,
  intent?: ActiveInboxContextIntent,
): ActiveInboxContext => {
  if (!thread) return { sourceView, intent }
  return {
    sellerId: text((thread as any).ownerId ?? (thread as any).sellerId),
    threadKey: text((thread as any).threadKey ?? thread.id),
    propertyId: text((thread as any).propertyId),
    masterOwnerId: text((thread as any).ownerId ?? (thread as any).masterOwnerId),
    prospectId: text((thread as any).prospectId),
    market: text((thread as any).market ?? (thread as any).marketName),
    sourceView,
    intent,
  }
}

export const buildContextFromQueueItem = (
  item: QueueItem | null | undefined,
  sourceView: ActiveInboxContextSource = 'queue',
  intent: ActiveInboxContextIntent = 'open_queue',
): ActiveInboxContext => {
  if (!item) return { sourceView, intent }
  return {
    sellerId: text(item.linkedOwnerId),
    threadKey: text(item.linkedInboxThreadId),
    propertyId: text(item.linkedPropertyId),
    masterOwnerId: text(item.linkedOwnerId),
    prospectId: text(item.metadata?.prospect_id),
    queueId: text(item.queueId ?? item.id),
    messageEventId: text(item.messageEventId),
    market: text(item.market),
    sourceView,
    intent,
  }
}

export const buildContextFromCalendarEvent = (
  event: CalendarEvent | null | undefined,
  sourceView: ActiveInboxContextSource = 'calendar',
): ActiveInboxContext => {
  if (!event) return { sourceView }
  return {
    sellerId: text(event.sellerId),
    threadKey: text(event.threadId),
    propertyId: text(event.propertyId),
    queueId: text(event.metadata?.queue_id),
    messageEventId: text(event.metadata?.message_event_id),
    market: text(event.market),
    date: text(event.timestamp),
    sourceView,
    intent: event.type.includes('scheduled') || event.type.includes('follow_up') ? 'open_calendar' : 'open_thread',
  }
}

export const buildContextFromActivityEvent = (
  event: CommandMapActivityEvent | null | undefined,
  sourceView: ActiveInboxContextSource = 'live_activity',
): ActiveInboxContext => {
  if (!event) return { sourceView }
  return {
    sellerId: text(event.masterOwnerId),
    threadKey: text(event.threadKey ?? event.targetId),
    propertyId: text(event.propertyId),
    masterOwnerId: text(event.masterOwnerId),
    prospectId: text(event.prospectId),
    queueId: text(event.queueId),
    messageEventId: text(event.messageEventId),
    activityId: text(event.id),
    market: text(event.market),
    date: text(event.createdAt),
    sourceView,
    intent: event.targetView === 'queue' ? 'open_queue' : event.targetView === 'calendar' ? 'open_calendar' : 'open_thread',
  }
}

export const buildContextFromMessage = (
  message: ThreadMessage | null | undefined,
  sourceView: ActiveInboxContextSource = 'thread',
): ActiveInboxContext => {
  if (!message) return { sourceView }
  return {
    sellerId: text(message.ownerId),
    threadKey: text((message as any).threadKey),
    propertyId: text(message.propertyId),
    prospectId: text(message.prospectId),
    queueId: text(message.developerMeta?.queue_id),
    messageEventId: text(message.id),
    sourceView,
    intent: 'open_thread',
  }
}
