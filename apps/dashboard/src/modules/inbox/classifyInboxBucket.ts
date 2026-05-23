import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'

export type CanonicalBucket =
  | 'suppressed'
  | 'needs_review'
  | 'priority'
  | 'new_replies'
  | 'follow_up'
  | 'cold'
  | 'all'

export interface BucketClassification {
  bucket: CanonicalBucket
  reasons: string[]
}

const DEV = import.meta.env.DEV

const r = (thread: InboxWorkflowThread): Record<string, unknown> => thread as unknown as Record<string, unknown>

const str = (...values: unknown[]): string =>
  values
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

const getAny = (thread: InboxWorkflowThread, ...keys: string[]): unknown => {
  const row = r(thread)
  for (const key of keys) {
    const v = row[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return undefined
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

const hasAny = (haystack: string, terms: string[]): boolean => terms.some((t) => haystack.includes(t))

// ── Suppression ────────────────────────────────────────────────────────────

const SUPPRESSION_KEYWORDS = [
  'opt_out', 'dnc', 'stop', 'unsubscribe', 'suppressed', 'remove me',
  'do not contact', 'wrong number', 'wrong_number',
]

const isSuppressed = (thread: InboxWorkflowThread): boolean => {
  if (bool(getAny(thread, 'isOptOut', 'is_opt_out', 'optOut'))) return true
  if (bool(getAny(thread, 'isDnc', 'is_dnc', 'dnc'))) return true
  if (bool(getAny(thread, 'isWrongNumber', 'is_wrong_number', 'wrongNumber'))) return true
  if (bool(getAny(thread, 'trueSuppression', 'true_post_contact_suppression'))) return true

  const status = str(
    getAny(thread, 'inboxStatus', 'inbox_status', 'status', 'conversationStatus', 'conversation_status'),
  )
  if (hasAny(status, ['suppressed', 'dnc', 'opt_out', 'dead', 'closed_compliance'])) return true

  const priorityBucket = str(getAny(thread, 'priorityBucket', 'priority_bucket'))
  if (priorityBucket === 'suppressed') return true

  const intent = str(getAny(thread, 'uiIntent', 'ui_intent', 'sellerIntent', 'seller_intent'))
  if (hasAny(intent, ['opt_out', 'wrong_number', 'dnc'])) return true

  const blob = str(
    thread.conversationStage,
    thread.inboxStatus,
    thread.preview,
    thread.lastMessageBody,
    thread.labels?.join(' '),
    getAny(thread, 'opt_out_keyword'),
  )
  return hasAny(blob, SUPPRESSION_KEYWORDS)
}

// ── Needs Review ───────────────────────────────────────────────────────────

const LEGAL_HOSTILE_KEYWORDS = [
  'attorney', 'lawyer', 'lawsuit', 'sue', 'legal action',
  'cease', 'desist', 'harassment', 'harass', 'court',
]

const needsReview = (thread: InboxWorkflowThread): string[] => {
  const reasons: string[] = []

  if (bool(getAny(thread, 'needsReview', 'needs_review', 'flaggedForReview'))) reasons.push('flagged_for_review')

  const confidence = num(getAny(thread, 'aiConfidence', 'ai_confidence', 'aiScore', 'ai_score', 'confidence'))
  if (confidence > 0 && confidence < 0.55) reasons.push(`low_ai_confidence(${confidence.toFixed(2)})`)

  const intent = str(getAny(thread, 'uiIntent', 'ui_intent', 'sellerIntent', 'seller_intent'))
  if (hasAny(intent, ['hostile', 'legal_threat', 'legal', 'uncertain'])) reasons.push(`hostile_or_legal_intent(${intent})`)

  const blob = str(thread.preview, thread.lastMessageBody)
  if (hasAny(blob, LEGAL_HOSTILE_KEYWORDS)) reasons.push('legal_hostile_keywords')

  if (bool(getAny(thread, 'missingPhoneContext', 'missing_phone_context', 'ambiguousIdentity', 'ambiguous_identity'))) {
    reasons.push('ambiguous_identity')
  }

  if (bool(getAny(thread, 'failedAutoReply', 'failed_auto_reply', 'autoReplyFailed'))) reasons.push('failed_auto_reply')

  const multipleProperties = num(getAny(thread, 'propertyCount', 'property_count', 'totalProperties', 'total_properties'))
  if (multipleProperties > 1) reasons.push(`multiple_properties(${multipleProperties})`)

  return reasons
}

// ── Priority ───────────────────────────────────────────────────────────────

const PRIORITY_POSITIVE_TERMS = [
  'yes', 'interested', 'how much', 'price', 'offer', 'sell', 'make offer',
  'call me', 'want to sell', 'ready to sell', 'what would you pay',
]

const PRIORITY_SELLER_INTENTS = [
  'seller_interested', 'price_interest', 'offer_requested', 'sell_intent',
  'positive', 'interested',
]

const PRIORITY_STAGES = new Set([
  'price_received', 'price_discussion', 'seller_countered',
  'offer_requested', 'underwriting_needed', 'offer_ready', 'contract_ready',
])

const isPriority = (thread: InboxWorkflowThread): string[] => {
  const reasons: string[] = []

  const direction = str(getAny(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed'))
  const unread = bool(getAny(thread, 'unread', 'isUnread', 'is_unread'))

  // Must be inbound + unread to qualify as priority (active engagement)
  const isActiveInbound = direction.includes('inbound') && unread
  if (!isActiveInbound) return []

  const messageBlob = str(thread.preview, thread.lastMessageBody, getAny(thread, 'latest_message_body', 'latestMessageBody'))
  if (hasAny(messageBlob, PRIORITY_POSITIVE_TERMS)) reasons.push('positive_keywords')

  const intent = str(getAny(thread, 'uiIntent', 'ui_intent', 'sellerIntent', 'seller_intent'))
  if (hasAny(intent, PRIORITY_SELLER_INTENTS)) reasons.push(`positive_seller_intent(${intent})`)

  const stage = str(getAny(thread, 'conversation_stage', 'conversationStage', 'threadWorkflowStage', 'stage'))
  if (PRIORITY_STAGES.has(stage as any) || hasAny(stage, ['offer', 'negotiat', 'contract', 'price'])) {
    reasons.push(`active_negotiation_stage(${stage})`)
  }

  const inboundCount = num(getAny(thread, 'inboundMessageCount', 'inbound_message_count', 'inboundCount', 'reply_count'))
  if (inboundCount >= 2) reasons.push(`multiple_inbound_replies(${inboundCount})`)

  const priorityScore = num(getAny(thread, 'priority_score', 'priorityScore', 'aiScore', 'ai_score'))
  if (priorityScore >= 70) reasons.push(`high_priority_score(${priorityScore})`)

  const equity = num(getAny(thread, 'estimatedEquityPct', 'estimated_equity_pct', 'equityPercent', 'equity_pct'))
  if (equity >= 40) reasons.push(`high_equity(${equity}%)`)

  if (bool(getAny(thread, 'showInPriorityInbox', 'show_in_priority_inbox'))) reasons.push('show_in_priority_inbox_flag')

  return reasons
}

// ── New Replies ────────────────────────────────────────────────────────────

const isNewReply = (thread: InboxWorkflowThread): boolean => {
  const direction = str(getAny(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed'))
  const unread = bool(getAny(thread, 'unread', 'isUnread', 'is_unread'))
  const archived = bool(getAny(thread, 'isArchived', 'is_archived', 'archived'))
  return direction.includes('inbound') && unread && !archived
}

// ── Follow Up ──────────────────────────────────────────────────────────────

const COLD_THRESHOLD_HOURS = 72

const isFollowUp = (thread: InboxWorkflowThread, now: Date): boolean => {
  const followUpAt = String(getAny(thread, 'follow_up_due_at', 'followUpDueAt', 'next_follow_up_at', 'nextFollowUpAt') ?? '').trim()
  if (followUpAt) {
    const due = new Date(followUpAt)
    if (!isNaN(due.getTime()) && due.getTime() <= now.getTime()) return true
  }

  // Outbound with no inbound reply and not yet stale enough to be cold
  const direction = str(getAny(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed'))
  const hasInboundHistory = bool(getAny(thread, 'hasInboundHistory', 'has_inbound_history', 'hasInbound'))
  if (!direction.includes('outbound') || hasInboundHistory) return false

  const lastOutbound = String(getAny(thread, 'lastOutboundAt', 'last_outbound_at', 'lastMessageAt') ?? '').trim()
  if (!lastOutbound) return false
  const outboundDate = new Date(lastOutbound)
  if (isNaN(outboundDate.getTime())) return false
  const elapsedHours = (now.getTime() - outboundDate.getTime()) / 3_600_000
  // Follow-up window: outbound sent but still under cold threshold
  return elapsedHours > 0 && elapsedHours < COLD_THRESHOLD_HOURS
}

// ── Cold ───────────────────────────────────────────────────────────────────

const isCold = (thread: InboxWorkflowThread, now: Date): boolean => {
  const direction = str(getAny(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed'))
  const hasInboundHistory = bool(getAny(thread, 'hasInboundHistory', 'has_inbound_history', 'hasInbound'))
  const archived = bool(getAny(thread, 'isArchived', 'is_archived', 'archived'))
  if (archived || hasInboundHistory) return false

  const coldThreshold = num(getAny(thread, 'cold_threshold_hours', 'coldThresholdHours'), COLD_THRESHOLD_HOURS)

  const lastOutbound = String(getAny(thread, 'lastOutboundAt', 'last_outbound_at', 'lastMessageAt') ?? '').trim()
  if (!lastOutbound) return direction.includes('outbound') // sent but no timestamp → cold
  const outboundDate = new Date(lastOutbound)
  if (isNaN(outboundDate.getTime())) return false
  const elapsedHours = (now.getTime() - outboundDate.getTime()) / 3_600_000
  return elapsedHours >= coldThreshold
}

// ── Main Classifier ────────────────────────────────────────────────────────

export const classifyInboxBucket = (
  thread: InboxWorkflowThread,
  now: Date = new Date(),
): BucketClassification => {
  // Priority order: suppressed → needs_review → priority → new_replies → follow_up → cold → all

  if (isSuppressed(thread)) {
    const result: BucketClassification = { bucket: 'suppressed', reasons: ['suppression_detected'] }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  const reviewReasons = needsReview(thread)
  if (reviewReasons.length > 0) {
    const result: BucketClassification = { bucket: 'needs_review', reasons: reviewReasons }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  const priorityReasons = isPriority(thread)
  if (priorityReasons.length > 0) {
    const result: BucketClassification = { bucket: 'priority', reasons: priorityReasons }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  if (isNewReply(thread)) {
    const result: BucketClassification = { bucket: 'new_replies', reasons: ['unread_inbound'] }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  if (isFollowUp(thread, now)) {
    const result: BucketClassification = { bucket: 'follow_up', reasons: ['follow_up_due_or_pending'] }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  if (isCold(thread, now)) {
    const result: BucketClassification = { bucket: 'cold', reasons: ['stale_no_inbound_reply'] }
    if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
    return result
  }

  const result: BucketClassification = { bucket: 'all', reasons: ['default'] }
  if (DEV) console.debug('[InboxBucket]', thread.threadKey || thread.id, result)
  return result
}

export const getCanonicalBucketCounts = (
  threads: InboxWorkflowThread[],
  now: Date = new Date(),
): Record<CanonicalBucket, number> => {
  const counts: Record<CanonicalBucket, number> = {
    suppressed: 0,
    needs_review: 0,
    priority: 0,
    new_replies: 0,
    follow_up: 0,
    cold: 0,
    all: threads.length,
  }
  for (const thread of threads) {
    const { bucket } = classifyInboxBucket(thread, now)
    if (bucket !== 'all') counts[bucket]++
  }
  return counts
}
