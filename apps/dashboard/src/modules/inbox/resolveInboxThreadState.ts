import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

export type CanonicalBucket =
  | 'new_replies'
  | 'priority'
  | 'negotiating'
  | 'follow_up'
  | 'waiting_on_seller'
  | 'automated'
  | 'needs_review'
  | 'cold'
  | 'suppressed'
  | 'all'

export interface BucketClassification {
  bucket: CanonicalBucket
  reasons: string[]
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : fallback
}

const bool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

const str = (...values: unknown[]): string =>
  values.map((v) => String(v ?? '').trim()).filter(Boolean).join(' ').toLowerCase()

const hasAny = (haystack: string, terms: string[]): boolean => terms.some((t) => haystack.includes(t))

const getAny = (thread: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    const v = thread[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return undefined
}

const getDirection = (thread: Record<string, unknown>): string => {
  return str(getAny(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed', 'direction'))
}

export const resolveInboxThreadState = (threadData: InboxWorkflowThread, _now: Date = new Date()): BucketClassification => {
  const thread = threadData as unknown as Record<string, unknown>
  const reasons: string[] = []

  const direction = getDirection(thread)
  const isArchived = bool(getAny(thread, 'isArchived', 'is_archived', 'archived', 'threadIsArchived'))
  const isUnread = bool(getAny(thread, 'unread', 'isUnread', 'is_unread', 'needsResponse', 'needsReply')) ||
                   num(getAny(thread, 'unreadCount', 'unread_count')) > 0 ||
                   (!bool(getAny(thread, 'isRead', 'is_read', 'threadIsRead')))
  
  // 1. Suppressed
  const suppressed = bool(getAny(thread, 'isSuppressed', 'threadIsSuppressed', 'is_suppressed')) ||
                     bool(getAny(thread, 'isOptOut', 'is_opt_out', 'opt_out')) ||
                     bool(getAny(thread, 'isDnc', 'is_dnc', 'dnc')) ||
                     str(getAny(thread, 'priorityBucket', 'priority_bucket')) === 'suppressed'
  if (suppressed) {
    reasons.push('explicit suppression flag')
    return { bucket: 'suppressed', reasons }
  }
  if (isArchived) {
    reasons.push('thread is archived')
    return { bucket: 'all', reasons }
  }

  // Intent and keywords
  const messageBlob = str(thread.lastMessageBody, thread.preview, getAny(thread, 'latest_message_body'))
  const intent = str(getAny(thread, 'detected_intent', 'seller_intent', 'uiIntent', 'ui_intent'))
  const stage = str(getAny(thread, 'conversation_stage', 'thread_stage', 'conversationStage'))
  
  const isHostile = bool(getAny(thread, 'hostile')) || hasAny(messageBlob, ['fuck', 'lawsuit', 'attorney', 'cease', 'harass'])
  if (isHostile || hasAny(messageBlob, ['wrong number', 'stop', 'unsubscribe'])) {
    reasons.push('suppressed via intent/keywords')
    return { bucket: 'suppressed', reasons }
  }

  // 2. New Replies
  // Visible rows = Count. (Inbound + Unread + Not Archived).
  if (direction.includes('inbound') && isUnread) {
    reasons.push('inbound direction and unread')
    return { bucket: 'new_replies', reasons }
  }

  // 3. Priority
  // Priority: Visible rows = Count. (Active inbound engagement, high AI scores, positive keywords, active negotiation stage, or explicit priority flag).
  const isExplicitPriority = bool(getAny(thread, 'showInPriorityInbox', 'show_in_priority_inbox', 'isPriority')) || 
                             str(getAny(thread, 'priorityBucket', 'priority_bucket')) === 'priority'
  const isHighScore = num(getAny(thread, 'priority_score', 'priorityScore', 'finalAcquisitionScore', 'motivationScore', 'aiScore')) >= 70
  const isPositive = hasAny(messageBlob, ['interested', 'yes', 'make offer', 'call me', 'how much', 'price', 'offer']) || 
                     hasAny(intent, ['seller_interested', 'price_interest'])
  const isNegotiating = hasAny(stage, ['offer_requested', 'offer_ready', 'contract_ready', 'underwriting', 'price_discussion'])
  
  // Note: Priority bucket typically requires the latest direction to be inbound, or user specifically starred/prioritized it
  if (isExplicitPriority || isHighScore || (direction.includes('inbound') && (isPositive || isNegotiating))) {
    if (isExplicitPriority) reasons.push('explicit priority flag')
    if (isHighScore) reasons.push('high priority score')
    if (isPositive) reasons.push('positive keywords/intent')
    if (isNegotiating) reasons.push('negotiation stage')
    return { bucket: 'priority', reasons }
  }

  // 4. Negotiating / Follow Up
  if (isNegotiating) {
    reasons.push('negotiation stage fallback')
    return { bucket: 'negotiating', reasons }
  }
  
  const followUpDue = str(getAny(thread, 'status', 'thread_status', 'inboxStatus')) === 'follow_up_due' || hasAny(stage, ['follow_up'])
  if (followUpDue) {
    reasons.push('follow up due')
    return { bucket: 'follow_up', reasons }
  }

  // 5. Waiting / Automated / Cold
  if (direction.includes('outbound')) {
    const queueStatus = str(getAny(thread, 'queueStatus', 'queue_status', 'automation_status', 'automationStatus'))
    if (hasAny(queueStatus, ['auto-eligible', 'auto-queued'])) {
       reasons.push('automation active')
       return { bucket: 'automated', reasons }
    }
    reasons.push('outbound sent, waiting on seller')
    return { bucket: 'waiting_on_seller', reasons }
  }

  // Catch-all
  if (!direction.includes('inbound') && !direction.includes('outbound')) {
    reasons.push('cold or unknown')
    return { bucket: 'cold', reasons }
  }

  reasons.push('default all bucket')
  return { bucket: 'all', reasons }
}
