import type { InboxStatus, InboxWorkflowThread, SellerStage } from '../../lib/data/inboxWorkflowData'
import type { ThreadMessage } from '../../lib/data/inboxData'

export type OptimisticThreadAction =
  | 'archive'
  | 'unarchive'
  | 'star'
  | 'unstar'
  | 'pin'
  | 'unpin'
  | 'read'
  | 'unread'
  | 'snooze'
  | 'approve_queue'
  | 'cancel_queue'
  | 'edit_queue'
  | { type: 'status'; status: InboxStatus | 'sent_message' }
  | { type: 'stage'; stage: SellerStage }

export function buildOptimisticThreadPatch(
  action: OptimisticThreadAction,
  thread: InboxWorkflowThread,
  extra?: { queueId?: string },
): Partial<InboxWorkflowThread> {
  if (typeof action === 'object' && action.type === 'status') {
    const actualStatus: InboxStatus = action.status === 'sent_message' ? 'waiting' : action.status
    const sentPatch = action.status === 'sent_message'
      ? { latestDirection: 'outbound' as const, lastDirection: 'outbound' as const, lastOutboundAt: new Date().toISOString() }
      : {}
    return { inboxStatus: actualStatus, ...sentPatch }
  }

  if (typeof action === 'object' && action.type === 'stage') {
    return { conversationStage: action.stage }
  }

  switch (action) {
    case 'approve_queue':
      return { inboxStatus: 'queued' }
    case 'cancel_queue':
    case 'edit_queue':
      return { inboxStatus: 'waiting' }
    case 'archive':
      return { isArchived: true, inboxStatus: 'closed' }
    case 'unarchive':
      return { isArchived: false, inboxStatus: 'needs_review' }
    case 'star':
      return { isStarred: true }
    case 'unstar':
      return { isStarred: false }
    case 'pin':
      return { isPinned: true }
    case 'unpin':
      return { isPinned: false }
    case 'read':
      return { isRead: true, unread: false, unreadCount: 0, status: 'read', inboxStatus: 'closed' }
    case 'unread':
      return { isRead: false, unread: true, unreadCount: 1, status: 'unread', inboxStatus: 'new_reply' }
    case 'snooze':
      return {
        inboxStatus: 'waiting',
        followUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }
    default:
      return {}
  }
}

export function mergeOptimisticPatches(
  threads: InboxWorkflowThread[],
  patches: Record<string, Partial<InboxWorkflowThread>>,
): InboxWorkflowThread[] {
  return threads.map((thread) => {
    const patch = patches[thread.id]
    return patch ? { ...thread, ...patch } : thread
  })
}

export function buildOptimisticOutboundMessage(
  thread: InboxWorkflowThread,
  text: string,
  clientSendId: string,
  template?: { templateId?: string | null; id?: string | null; useCase?: string | null } | null,
): ThreadMessage {
  const timestamp = new Date().toISOString()
  return {
    id: `pending-${thread.id}-${Date.now()}`,
    direction: 'outbound',
    body: text.trim(),
    createdAt: timestamp,
    timelineAt: timestamp,
    deliveredAt: null,
    deliveryStatus: 'sending',
    fromNumber: '',
    toNumber: thread.canonicalE164 || thread.phoneNumber || '',
    ownerId: thread.ownerId || '',
    prospectId: thread.prospectId || '',
    propertyId: thread.propertyId || '',
    phoneNumber: thread.phoneNumber || '',
    canonicalE164: thread.canonicalE164 || '',
    templateId: template?.templateId ?? template?.id ?? null,
    templateName: template?.useCase ?? null,
    agentId: null,
    source: 'operator',
    rawStatus: 'sending',
    error: null,
    metadata: { client_send_id: clientSendId },
    developerMeta: { client_send_id: clientSendId },
  }
}