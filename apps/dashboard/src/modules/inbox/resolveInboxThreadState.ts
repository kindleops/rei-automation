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
  if (hasAny(intent, ['not_interested', 'wrong_number', 'opt_out'])) {
    reasons.push('terminal intent suppression')
    return { bucket: 'suppressed', reasons }
  }

  // 1.5. Needs Review
  const autoReplyStatus = str(getAny(thread, 'auto_reply_status', 'autoReplyStatus'))
  const safetyStatus = str(getAny(thread, 'safety_status', 'safetyStatus'))
  const needsReviewAutoReply = hasAny(autoReplyStatus, ['failed', 'needs_review', 'pending_review'])
  const needsReviewSafety = hasAny(safetyStatus, ['review', 'blocked'])
  const needsReviewInbound = direction.includes('inbound') && (!intent || intent === 'unknown' || intent === '')

  if (needsReviewAutoReply || needsReviewSafety || needsReviewInbound) {
    reasons.push('needs review flag (auto reply, safety, or uncategorized inbound)')
    return { bucket: 'needs_review', reasons }
  }

  // 2. New Replies
  const sellerStatus = str(getAny(thread, 'seller_status', 'sellerStatus'))
  const isTerminalStatus = hasAny(sellerStatus, ['not_interested', 'no', 'wrong_number', 'dnc', 'closed'])
  
  if (direction.includes('inbound') && !isArchived && !suppressed && !isTerminalStatus) {
    reasons.push('inbound direction and not suppressed/archived')
    return { bucket: 'new_replies', reasons }
  }

  // 3. Priority
  const priorityLevel = str(getAny(thread, 'priority'))
  const risk = str(getAny(thread, 'risk'))
  const isPriorityIntent = hasAny(intent, ['positive_interest', 'price_provided', 'asks_question', 'wants_offer'])
  const isPriorityLevel = hasAny(priorityLevel, ['high', 'urgent'])
  const isPriorityRisk = risk === 'needs_review'
  
  const isPriority = direction.includes('inbound') || isPriorityIntent || isPriorityLevel || isPriorityRisk || needsReviewAutoReply
  const isExplicitNegative = hasAny(messageBlob, ['not interested', 'no thanks', 'stop texting', 'wrong number']) ||
    hasAny(intent, ['not_interested', 'wrong_number', 'opt_out']) || isTerminalStatus
    
  if (isPriority && !isExplicitNegative && !isArchived && !suppressed) {
    reasons.push('priority flags/intent')
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
