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
  flags: {
    detected_intent: string
    latest_direction: 'inbound' | 'outbound' | 'unknown'
    is_read: boolean
    is_suppressed: boolean
    follow_up_at: string | null
  }
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

const SHOW_BUCKET_DEBUG = String((import.meta as any)?.env?.VITE_SHOW_DEBUG ?? '').toLowerCase() === 'true'

const normalizeDirection = (raw: string): 'inbound' | 'outbound' | 'unknown' => {
  if (raw === 'in' || raw.startsWith('in_') || raw.startsWith('in-') || raw.startsWith('in ')) return 'inbound'
  if (raw === 'out' || raw.startsWith('out_') || raw.startsWith('out-') || raw.startsWith('out ')) return 'outbound'
  if (raw.includes('inbound') || raw.includes('incoming') || raw.includes('received')) return 'inbound'
  if (raw.includes('outbound') || raw.includes('outgoing') || raw.includes('sent')) return 'outbound'
  return 'unknown'
}

export const resolveInboxThreadState = (threadData: InboxWorkflowThread, _now: Date = new Date()): BucketClassification => {
  const thread = threadData as unknown as Record<string, unknown>
  const now = _now
  const reasons: string[] = []

  const direction = normalizeDirection(getDirection(thread))
  const isArchived = bool(getAny(thread, 'isArchived', 'is_archived', 'archived', 'threadIsArchived'))
  const isRead = bool(getAny(thread, 'is_read', 'isRead', 'threadIsRead'))
  const unreadCount = num(getAny(thread, 'unreadCount', 'unread_count'))
  const isUnread = !isRead || unreadCount > 0 || bool(getAny(thread, 'needsResponse', 'needsReply'))

  const intent = str(
    getAny(
      thread,
      'detected_intent',
      'inbox_detected_intent',
      'message_events_detected_intent',
      'ui_intent',
      'uiIntent',
      'seller_intent',
      'sellerIntent',
    ),
  )
  const stage = str(getAny(thread, 'current_stage', 'thread_stage', 'conversation_stage', 'conversationStage'))
  const statusBucket = str(getAny(thread, 'status_bucket', 'inbox_category', 'inboxCategory', 'priority_bucket', 'priorityBucket'))
  const priorityValue = str(getAny(thread, 'priority'))
  const followUpAtRaw = String(getAny(thread, 'follow_up_at', 'next_follow_up_at', 'followUpAt', 'nextFollowUpAt') ?? '').trim()
  const followUpAt = followUpAtRaw || null
  const messageBlob = str(thread.lastMessageBody, thread.preview, getAny(thread, 'latest_message_body'))

  const isHardSuppressed = bool(getAny(thread, 'is_suppressed', 'isSuppressed', 'threadIsSuppressed')) ||
    hasAny(intent, ['stop', 'opt_out', 'optout', 'dnc', 'do_not_contact', 'legal_threat', 'hostile_legal', 'permanent_suppression']) ||
    hasAny(statusBucket, ['suppressed', 'dnc', 'opt_out']) ||
    hasAny(messageBlob, ['stop', 'unsubscribe', 'do not contact', 'legal threat', 'attorney'])
  const isWrongNumberSuppression = hasAny(intent, ['wrong_number']) && (
    bool(getAny(thread, 'is_suppressed', 'isSuppressed', 'threadIsSuppressed')) ||
    hasAny(messageBlob, ['wrong number', 'not owner', 'not me'])
  )
  const isSuppressed = isHardSuppressed || isWrongNumberSuppression

  const isPriorityIntent = hasAny(intent, [
    'positive_interest', 'interested', 'motivated_seller', 'seller_asking_price',
    'wants_offer', 'negotiation', 'appointment', 'close', 'handoff', 'price_interest', 'offer_requested',
  ])
  const showInPriority = bool(getAny(thread, 'is_hot_lead', 'isHotLead', 'show_in_priority_inbox', 'showInPriorityInbox'))
  const isHotLead = bool(getAny(thread, 'is_hot_lead', 'isHotLead')) || hasAny(priorityValue, ['urgent', 'high']) || num(getAny(thread, 'priority_score', 'priorityScore')) >= 80

  const isPriorityExcluded = isSuppressed ||
    hasAny(intent, ['not_interested', 'no', 'wrong_number', 'dnc', 'opt_out', 'stop', 'hostile', 'legal', 'tenant', 'realtor', 'listed_or_unavailable', 'already_sold']) ||
    hasAny(messageBlob, ['not interested', 'wrong number', 'tenant', 'realtor', 'already sold'])

  const followUpIntent = hasAny(intent, [
    'no', 'not_interested', 'later', 'timing_issue', 'follow_up_later', 'soft_rejection', 'maybe_later', 'check_back', 'not_right_now',
  ]) || hasAny(messageBlob, [
    'not interested', 'no thanks', 'maybe later', 'check back', 'not right now', 'later',
  ])
  const followUpStage = hasAny(stage, ['follow_up', 'nurture']) || hasAny(str(getAny(thread, 'queue_stage', 'workflow_stage', 'threadWorkflowStage')), ['follow_up', 'nurture'])

  const needsReviewIntent = hasAny(intent, ['unclear', 'ambiguous', 'manual_review']) ||
    bool(getAny(thread, 'needs_review')) ||
    hasAny(statusBucket, ['needs_review'])
  const isLowConfidence = Number(getAny(thread, 'classification_confidence', 'confidence', 'ai_confidence') ?? 1) < 0.55
  const missingClassificationInbound = direction === 'inbound' && isUnread && !intent

  const bucketFromBackend = (() => {
    if (!statusBucket) return null
    if (hasAny(statusBucket, ['priority', 'hot_leads', 'hot'])) return 'priority'
    if (hasAny(statusBucket, ['new_reply', 'new_replies', 'new_inbound', 'needs_reply'])) return 'new_replies'
    if (hasAny(statusBucket, ['needs_review', 'manual_review'])) return 'needs_review'
    if (hasAny(statusBucket, ['follow_up', 'follow_up_due'])) return 'follow_up'
    if (hasAny(statusBucket, ['suppressed', 'dnc_opt_out', 'dnc', 'opt_out'])) return 'suppressed'
    if (hasAny(statusBucket, ['cold', 'cold_no_response', 'not_contacted'])) return 'cold'
    return null
  })()

  let bucket: CanonicalBucket = 'all'
  if (isSuppressed) {
    bucket = 'suppressed'
    reasons.push('hard suppression/compliance')
  } else if (bucketFromBackend) {
    bucket = bucketFromBackend
    reasons.push(`backend_status_bucket(${statusBucket})`)
  } else if (!isPriorityExcluded && (showInPriority || isHotLead || isPriorityIntent)) {
    bucket = 'priority'
    reasons.push('opportunity/hot/priority flag')
  } else if (followUpIntent || followUpStage || Boolean(followUpAt)) {
    bucket = 'follow_up'
    reasons.push(followUpAt ? 'follow_up_at scheduled' : 'soft rejection follow-up')
  } else if (direction === 'inbound' && isUnread && !isArchived) {
    bucket = 'new_replies'
    reasons.push('latest inbound unread')
  } else if (needsReviewIntent || isLowConfidence || missingClassificationInbound) {
    bucket = 'needs_review'
    reasons.push('unclear/low-confidence/ambiguous inbound')
  } else {
    const lastMessageTs = new Date(String(getAny(thread, 'latest_activity_at', 'lastMessageAt', 'lastMessageIso', 'updatedAt') ?? '')).getTime()
    const isOld = Number.isFinite(lastMessageTs) && (now.getTime() - lastMessageTs) > (1000 * 60 * 60 * 24 * 7)
    if (isOld || direction === 'outbound' || direction === 'unknown') {
      bucket = 'cold'
      reasons.push('inactive/non-responsive')
    } else {
      bucket = 'all'
      reasons.push('default')
    }
  }

  const result: BucketClassification = {
    bucket,
    reasons,
    flags: {
      detected_intent: intent,
      latest_direction: direction,
      is_read: isRead,
      is_suppressed: isSuppressed,
      follow_up_at: followUpAt,
    },
  }

  if (SHOW_BUCKET_DEBUG) {
    // eslint-disable-next-line no-console
    console.debug('[InboxBucketDebug]', {
      thread_key: String(getAny(thread, 'threadKey', 'thread_key', 'id') ?? ''),
      detected_intent: result.flags.detected_intent,
      latest_direction: result.flags.latest_direction,
      is_read: result.flags.is_read,
      is_suppressed: result.flags.is_suppressed,
      follow_up_at: result.flags.follow_up_at,
      bucket: result.bucket,
      reasons: result.reasons,
    })
  }

  return result
}
