import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { resolveInboxThreadState } from './resolveInboxThreadState'

export type InboxBucket =
  | 'new_replies'
  | 'priority'
  | 'negotiating'
  | 'follow_up_due'
  | 'waiting'
  | 'waiting_on_seller'
  | 'automated'
  | 'needs_review'
  | 'cold_no_response'
  | 'dnc_suppressed'
  | 'all_conversations'
  // canonical names (used by classifyInboxBucket and new sidebar)
  | 'follow_up'
  | 'cold'
  | 'dead'
  | 'suppressed'
  | 'all'

export type ConversationStatus =
  | 'active'
  | 'new_reply'
  | 'waiting_on_seller'
  | 'follow_up_due'
  | 'negotiating'
  | 'underwriting'
  | 'offer_ready'
  | 'contract_ready'
  | 'suppressed'
  | 'dead'

export type DeterministicConversationStage =
  | 'new'
  | 'identity_clarification'
  | 'ownership_confirmed'
  | 'price_received'
  | 'price_discussion'
  | 'seller_countered'
  | 'offer_requested'
  | 'underwriting_needed'
  | 'follow_up'
  | 'offer_ready'
  | 'contract_ready'
  | 'closed'

export type LeadTemperature = 'COLD' | 'WARM' | 'HOT' | 'VERY_HOT' | 'READY_TO_CLOSE'

export type AutomationStatus =
  | 'AUTO-ELIGIBLE'
  | 'AUTO-QUEUED'
  | 'WAITING'
  | 'REVIEW REQUIRED'
  | 'AUTO-BLOCKED'
  | 'FOLLOW-UP DUE'
  | 'SUPPRESSED'
  | 'UNDERWRITING'
  | 'OFFER READY'
  | 'CONTRACT READY'

export interface ConversationDecision {
  conversation_id: string
  last_message_id: string | null
  inbox_bucket: InboxBucket
  conversation_status: ConversationStatus
  conversation_stage: DeterministicConversationStage
  lead_temperature: LeadTemperature
  seller_intent: string
  unread: boolean
  priority_score: number
  automation_status: AutomationStatus
  next_action: string
  next_follow_up_at: string | null
  suppression_status: 'clear' | 'suppressed'
  review_reason: string | null
  confidence: number
  language: string | null
  tags: string[]
  intent_tags: string[]
  has_inbound_history: boolean
  last_message_direction: 'inbound' | 'outbound' | 'unknown'
  active: boolean
}

const POSITIVE_TERMS = ['interested', 'yes', 'make offer', 'call me', 'how much', 'price', 'offer', 'sell']
const SPANISH_TERMS = ['hola', 'si', 'sí', 'hablo', 'espanol', 'español', 'precio', 'oferta', 'casa']
const HOSTILE_TERMS = ['fuck', 'fucking', 'idiot', 'harass', 'lawsuit', 'cease', 'attorney', 'legal', 'drop dead', 'go to hell', 'bitch', 'asshole', 'moron', 'stupid']
const NEGATIVE_TERMS = ['not interested', 'not for sale', 'no thanks', 'no', 'nah', 'nope', 'pass', 'stop', "don't bother", 'do not bother', 'leave me alone']
const UNDERWRITING_STAGES = new Set<DeterministicConversationStage>([
  'price_received',
  'price_discussion',
  'seller_countered',
  'offer_requested',
  'underwriting_needed',
])

const asRecord = (thread: InboxWorkflowThread): Record<string, unknown> => thread as unknown as Record<string, unknown>
const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const num = (value: unknown, fallback = 0): number => {
  const n = Number(String(value ?? '').replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : fallback
}
const bool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  const normalized = lower(value)
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}
const iso = (value: unknown): string | null => {
  const raw = text(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
const includesAny = (haystack: string, terms: string[]) => terms.some((term) => haystack.includes(term))
const get = (thread: InboxWorkflowThread, ...keys: string[]): unknown => {
  const row = asRecord(thread)
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

const normalizedDirection = (thread: InboxWorkflowThread): 'inbound' | 'outbound' | 'unknown' => {
  const value = lower(get(thread, 'latest_message_direction', 'latestDirection', 'lastDirection', 'directionUsed'))
  if (value.includes('inbound')) return 'inbound'
  if (value.includes('outbound')) return 'outbound'
  return 'unknown'
}

const normalizedStage = (thread: InboxWorkflowThread): DeterministicConversationStage => {
  const raw = lower(get(
    thread,
    'conversation_stage',
    'conversationStage',
    'threadWorkflowStage',
    'thread_stage',
    'workflowStage',
    'stage',
    'current_stage',
    'uiIntent',
    'ui_intent',
  ))
  if (includesAny(raw, ['contract'])) return 'contract_ready'
  if (includesAny(raw, ['offer_ready', 'offer sent'])) return 'offer_ready'
  if (includesAny(raw, ['seller_counter', 'counter'])) return 'seller_countered'
  if (includesAny(raw, ['offer_requested', 'asking price', 'price ask'])) return 'offer_requested'
  if (includesAny(raw, ['underwriting', 'underwrite'])) return 'underwriting_needed'
  if (includesAny(raw, ['price_discussion', 'negotiat'])) return 'price_discussion'
  if (includesAny(raw, ['price_received', 'price_discovery'])) return 'price_received'
  if (includesAny(raw, ['owner', 'ownership'])) return 'ownership_confirmed'
  if (includesAny(raw, ['follow'])) return 'follow_up'
  if (includesAny(raw, ['wrong number', 'opt out', 'suppressed', 'closed', 'dead'])) return 'closed'

  const messageBlob = lower([
    thread.lastMessageBody,
    thread.preview,
    get(thread, 'latest_message_body'),
  ].filter(Boolean).join(' '))
  if (includesAny(messageBlob, HOSTILE_TERMS)) return 'identity_clarification'
  if (includesAny(messageBlob, ['wrong number', 'who is this', 'huh'])) return 'identity_clarification'
  if (includesAny(messageBlob, ['offer', 'how much'])) return 'offer_requested'
  if (includesAny(messageBlob, ['price', '$'])) return 'price_received'
  return 'new'
}

const inferSellerIntent = (thread: InboxWorkflowThread): string => {
  const rawIntent = lower(get(thread, 'seller_intent', 'detected_intent', 'uiIntent', 'ui_intent'))
  if (rawIntent) return rawIntent.replace(/\s+/g, '_')
  const blob = lower([thread.lastMessageBody, thread.preview, get(thread, 'latest_message_body')].filter(Boolean).join(' '))
  if (includesAny(blob, ['wrong number', 'not me'])) return 'wrong_number'
  if (includesAny(blob, ['stop', 'remove me', 'unsubscribe'])) return 'opt_out'
  if (includesAny(blob, HOSTILE_TERMS)) return 'hostile'
  if (includesAny(blob, ['not interested', 'not for sale'])) return 'not_interested'
  if (/\bno\b/.test(blob) || includesAny(blob, ['no thanks', 'nope', 'nah'])) return 'negative'
  if (includesAny(blob, ['how much', 'what price', 'offer'])) return 'price_interest'
  if (includesAny(blob, ['yes', 'interested', 'call me'])) return 'seller_interested'
  if (includesAny(blob, ['huh', 'who is this'])) return 'identity_clarification'
  return 'unknown'
}

const inferLanguage = (thread: InboxWorkflowThread): string | null => {
  const explicit = lower(get(thread, 'language', 'seller_language', 'best_language', 'contactLanguage', 'detected_language'))
  if (explicit) return explicit
  const blob = lower([thread.lastMessageBody, thread.preview, get(thread, 'latest_message_body')].filter(Boolean).join(' '))
  if (includesAny(blob, SPANISH_TERMS)) return 'spanish'
  return null
}

const getSuppressionStatus = (thread: InboxWorkflowThread, sellerIntent: string): 'clear' | 'suppressed' => {
  const blob = lower([
    sellerIntent,
    thread.inboxStatus,
    thread.conversationStage,
    thread.lastMessageBody,
    thread.preview,
    get(thread, 'opt_out_keyword'),
    get(thread, 'suppression_reason'),
  ].filter(Boolean).join(' '))
  const rawSuppressed =
    bool(get(thread, 'isSuppressed', 'threadIsSuppressed', 'is_suppressed')) ||
    bool(get(thread, 'isOptOut', 'is_opt_out', 'opt_out')) ||
    bool(get(thread, 'isDnc', 'is_dnc', 'dnc')) ||
    bool(get(thread, 'wrong_number')) ||
    includesAny(blob, ['opt_out', 'dnc', 'wrong number', 'legal threat', 'lawsuit', 'suppressed', 'remove me', 'stop'])
  return rawSuppressed ? 'suppressed' : 'clear'
}

const getPriorityScore = (thread: InboxWorkflowThread): number =>
  num(get(thread, 'priority_score', 'priorityScore', 'finalAcquisitionScore', 'motivationScore', 'owner_priority_score'), 0)

const getUnread = (thread: InboxWorkflowThread): boolean =>
  bool(get(thread, 'unread')) || num(get(thread, 'unreadCount'), 0) > 0 || !bool(get(thread, 'isRead', 'threadIsRead'))

const getNextFollowUpAt = (thread: InboxWorkflowThread): string | null =>
  iso(get(thread, 'next_follow_up_at', 'nextFollowUpAt', 'follow_up_at', 'followUpAt'))

const getHasInboundHistory = (thread: InboxWorkflowThread): boolean =>
  num(get(thread, 'inbound_count', 'inboundCount'), 0) > 0 || Boolean(iso(thread.lastInboundAt))

const getReviewReasons = (thread: InboxWorkflowThread, sellerIntent: string): string[] => {
  const blob = lower([
    sellerIntent,
    thread.lastMessageBody,
    thread.preview,
    get(thread, 'latest_message_body'),
    get(thread, 'uiIntent'),
    get(thread, 'ui_intent'),
  ].filter(Boolean).join(' '))
  const reasons: string[] = []
  if (bool(get(thread, 'ambiguous_intent')) || includesAny(blob, ['huh', 'who is this'])) reasons.push('ambiguous intent')
  if (bool(get(thread, 'legal_language')) || includesAny(blob, ['attorney', 'lawyer', 'legal'])) reasons.push('legal language')
  if (bool(get(thread, 'hostile')) || includesAny(blob, HOSTILE_TERMS)) reasons.push('hostile response')
  if (bool(get(thread, 'ownership_uncertain')) || sellerIntent === 'wrong_number') reasons.push('ownership uncertain')
  if (bool(get(thread, 'price_gap_too_large'))) reasons.push('price gap too large')
  if (bool(get(thread, 'missing_required_data'))) reasons.push('missing required data')
  if (bool(get(thread, 'confidence')) && num(get(thread, 'confidence')) < 0.55) reasons.push('low confidence')
  return Array.from(new Set(reasons))
}

const inferIntentTags = (
  thread: InboxWorkflowThread,
  sellerIntent: string,
  language: string | null,
  stage: DeterministicConversationStage,
  reviewReasons: string[],
): string[] => {
  const blob = lower([thread.lastMessageBody, thread.preview, get(thread, 'latest_message_body')].filter(Boolean).join(' '))
  const tags: string[] = []
  if (sellerIntent === 'seller_interested' || stage === 'ownership_confirmed') tags.push('Seller Confirmed')
  if (sellerIntent === 'price_interest' || stage === 'price_received' || stage === 'price_discussion') tags.push('Price Given')
  if (sellerIntent === 'not_interested' || sellerIntent === 'negative') tags.push('Not Interested')
  if (sellerIntent === 'identity_clarification') tags.push('Confused')
  if (language === 'spanish') tags.push('Spanish Reply')
  if (sellerIntent === 'hostile' || reviewReasons.some((reason) => reason.includes('hostile'))) tags.push('Hostile')
  if (sellerIntent === 'wrong_number') tags.push('Wrong Number')
  if (includesAny(blob, ['tenant', 'renter', 'renting'])) tags.push('Tenant')
  if (includesAny(blob, ['listed', 'mls', 'agent'])) tags.push('Listed')
  if (stage === 'offer_requested' || includesAny(blob, ['offer', 'how much'])) tags.push('Offer Requested')
  return Array.from(new Set(tags))
}

const inferTemperature = (
  thread: InboxWorkflowThread,
  stage: DeterministicConversationStage,
  suppressionStatus: 'clear' | 'suppressed',
  sellerIntent: string,
  priorityScore: number,
): LeadTemperature => {
  if (suppressionStatus === 'suppressed' || includesAny(sellerIntent, ['wrong_number', 'opt_out', 'not_interested', 'negative', 'hostile'])) return 'COLD'
  const explicit = upperTemperature(lower(get(thread, 'lead_temperature', 'temperature', 'dealTemperature')))
  if (explicit) return explicit
  if (stage === 'contract_ready') return 'READY_TO_CLOSE'
  if (stage === 'offer_ready') return 'VERY_HOT'
  if (UNDERWRITING_STAGES.has(stage)) return priorityScore >= 90 ? 'VERY_HOT' : priorityScore >= 65 ? 'HOT' : 'WARM'
  if (sellerIntent === 'price_interest') return priorityScore >= 75 ? 'HOT' : 'WARM'
  if (includesAny(lower([thread.lastMessageBody, thread.preview, get(thread, 'latest_message_body')].filter(Boolean).join(' ')), NEGATIVE_TERMS)) return 'COLD'
  if (priorityScore >= 85) return 'VERY_HOT'
  if (priorityScore >= 70 || includesAny(sellerIntent, POSITIVE_TERMS)) return 'HOT'
  if (priorityScore >= 45) return 'WARM'
  return 'COLD'
}

const upperTemperature = (value: string): LeadTemperature | null => {
  if (!value) return null
  const normalized = value.replace(/\s+/g, '_').toUpperCase()
  if (normalized === 'VERY_HOT') return 'VERY_HOT'
  if (normalized === 'READY_TO_CLOSE') return 'READY_TO_CLOSE'
  if (normalized === 'HOT') return 'HOT'
  if (normalized === 'WARM') return 'WARM'
  if (normalized === 'COLD') return 'COLD'
  return null
}

const inferConversationStatus = (
  thread: InboxWorkflowThread,
  stage: DeterministicConversationStage,
  suppressionStatus: 'clear' | 'suppressed',
  lastMessageDirection: 'inbound' | 'outbound' | 'unknown',
  unread: boolean,
  nextFollowUpAt: string | null,
  now: Date,
): ConversationStatus => {
  if (suppressionStatus === 'suppressed') return 'suppressed'
  if (stage === 'contract_ready') return 'contract_ready'
  if (stage === 'offer_ready') return 'offer_ready'
  if (UNDERWRITING_STAGES.has(stage)) return 'underwriting'
  if (lastMessageDirection === 'inbound' && unread) return 'new_reply'
  if (nextFollowUpAt && new Date(nextFollowUpAt).getTime() <= now.getTime()) return 'follow_up_due'
  if (lower(get(thread, 'status', 'thread_status')) === 'waiting_on_seller') return 'waiting_on_seller'
  if (lastMessageDirection === 'outbound') return 'waiting_on_seller' // Default all outbound without responses to waiting_on_seller
  if (lastMessageDirection === 'inbound' && !unread) return 'active'
  return 'active'
}

const inferAutomationStatus = (
  thread: InboxWorkflowThread,
  conversationStatus: ConversationStatus,
  suppressionStatus: 'clear' | 'suppressed',
  reviewReasons: string[],
  nextActionDeterministic: boolean,
  confidence: number,
  language: string | null,
): AutomationStatus => {
  if (suppressionStatus === 'suppressed') return 'SUPPRESSED'
  if (conversationStatus === 'contract_ready') return 'CONTRACT READY'
  if (conversationStatus === 'offer_ready') return 'OFFER READY'
  if (conversationStatus === 'underwriting') return 'UNDERWRITING'
  if (conversationStatus === 'follow_up_due') return 'FOLLOW-UP DUE'
  if (conversationStatus === 'waiting_on_seller') return 'WAITING'
  if (reviewReasons.length > 0) return 'REVIEW REQUIRED'

  const autopilotEnabled = bool(get(thread, 'autopilot_enabled', 'autopilotEnabled')) || lower(thread.automationState) === 'active'
  const humanTakeover = bool(get(thread, 'human_takeover', 'humanTakeover')) || lower(thread.automationState) === 'manual_control'
  const queued = includesAny(lower(get(thread, 'queueStatus', 'queue_status', 'status')), ['queued', 'scheduled', 'pending'])
  const sellerIntent = inferSellerIntent(thread)
  const threshold = 80
  const highConfidence = confidence >= threshold
  const highConfidenceSpanish = language === 'spanish' ? confidence >= threshold : true
  const automationBlocked = includesAny(sellerIntent, ['hostile', 'negative', 'not_interested', 'wrong_number', 'opt_out']) || !highConfidenceSpanish
  if (automationBlocked) return 'AUTO-BLOCKED'
  if (!nextActionDeterministic || !highConfidence || humanTakeover) return 'REVIEW REQUIRED'
  if (queued && autopilotEnabled && !humanTakeover && !automationBlocked) return 'AUTO-QUEUED'
  if (autopilotEnabled && !humanTakeover && highConfidence && nextActionDeterministic && !automationBlocked) return 'AUTO-ELIGIBLE'
  return 'REVIEW REQUIRED'
}

const inferNextAction = (
  decision: Omit<ConversationDecision, 'inbox_bucket'>,
  language: string | null,
  confidence: number,
): string => {
  if (decision.suppression_status === 'suppressed') return 'No contact. Respect suppression.'
  if (decision.conversation_status === 'contract_ready') return 'Open contract workflow.'
  if (decision.conversation_status === 'offer_ready') return 'Review and send offer.'
  if (decision.conversation_status === 'underwriting') return 'Run underwriting and confirm buy box.'
  if (decision.conversation_status === 'follow_up_due') return language === 'spanish' && confidence >= 80 ? 'Send Spanish follow-up template.' : 'Send next follow-up touch.'
  if (decision.conversation_status === 'waiting_on_seller') return 'Wait for seller response.'
  if (decision.review_reason) return 'Operator review required.'
  if (decision.last_message_direction === 'inbound' && decision.unread) return language === 'spanish' && confidence >= 80 ? 'Review inbound and route Spanish response.' : 'Review inbound and reply.'
  if (decision.automation_status === 'AUTO-ELIGIBLE') return 'Allow deterministic automation.'
  return 'Monitor thread.'
}

export const buildConversationDecision = (
  thread: InboxWorkflowThread,
  now: Date = new Date(),
): ConversationDecision => {
  const sellerIntent = inferSellerIntent(thread)
  const suppressionStatus = getSuppressionStatus(thread, sellerIntent)
  const lastMessageDirection = normalizedDirection(thread)
  const unread = getUnread(thread)
  const priorityScore = getPriorityScore(thread)
  const nextFollowUpAt = getNextFollowUpAt(thread)
  const conversationStage = normalizedStage(thread)
  const reviewReasons = getReviewReasons(thread, sellerIntent)
  const hasInboundHistory = getHasInboundHistory(thread)
  const language = inferLanguage(thread)
  const confidence = Math.max(0, Math.min(100, Math.round(num(get(thread, 'confidence'), 0.76) <= 1 ? num(get(thread, 'confidence'), 0.76) * 100 : num(get(thread, 'confidence'), 76))))
  const conversationStatus = inferConversationStatus(thread, conversationStage, suppressionStatus, lastMessageDirection, unread, nextFollowUpAt, now)
  const leadTemperature = inferTemperature(thread, conversationStage, suppressionStatus, sellerIntent, priorityScore)
  const nextActionDeterministic = !includesAny(sellerIntent, ['hostile', 'negative', 'not_interested', 'wrong_number', 'opt_out']) && reviewReasons.length === 0
  const automationStatus = inferAutomationStatus(thread, conversationStatus, suppressionStatus, reviewReasons, nextActionDeterministic, confidence, language)
  const intentTags = inferIntentTags(thread, sellerIntent, language, conversationStage, reviewReasons)
  const tags = [
    leadTemperature,
    language === 'spanish' ? 'SPANISH' : '',
    priorityScore >= 70 ? 'HIGH PRIORITY' : '',
    sellerIntent === 'wrong_number' ? 'WRONG NUMBER' : '',
    ...intentTags,
  ].filter(Boolean)

  const baseDecision: Omit<ConversationDecision, 'inbox_bucket'> = {
    conversation_id: thread.id,
    last_message_id: text(get(thread, 'last_message_id', 'latest_message_id', 'message_event_id')) || null,
    conversation_status: conversationStatus,
    conversation_stage: conversationStage,
    lead_temperature: leadTemperature,
    seller_intent: sellerIntent,
    unread,
    priority_score: priorityScore,
    automation_status: automationStatus,
    next_action: '',
    next_follow_up_at: nextFollowUpAt,
    suppression_status: suppressionStatus,
    review_reason: reviewReasons.length > 0 ? reviewReasons.join(', ') : null,
    confidence,
    language,
    tags,
    intent_tags: intentTags,
    has_inbound_history: hasInboundHistory,
    last_message_direction: lastMessageDirection,
    active: suppressionStatus === 'clear' && conversationStatus !== 'dead',
  }

  const inbox_bucket = resolveInboxBucket(thread, baseDecision, now)
  return {
    ...baseDecision,
    inbox_bucket,
    next_action: inferNextAction(baseDecision, language, confidence),
  }
}

export const resolveInboxBucket = (
  thread: InboxWorkflowThread,
  _decision: Omit<ConversationDecision, 'inbox_bucket'>,
  now: Date = new Date(),
): InboxBucket => {
  const { bucket } = resolveInboxThreadState(thread, now)
  // Map canonical names → legacy names for backwards-compat consumers
  if (bucket === 'suppressed') return 'dnc_suppressed'
  if (bucket === 'follow_up') return 'follow_up_due'
  if (bucket === 'cold') return 'cold_no_response'
  if (bucket === 'waiting') return 'waiting'
  if (bucket === 'all' || bucket === 'all_messages') return 'all_conversations'
  return bucket // 'needs_review' | 'priority' | 'new_replies' are identical
}

export const matchesInboxBucket = (
  thread: InboxWorkflowThread,
  bucket: InboxBucket,
  _decision?: ConversationDecision,
  now: Date = new Date(),
): boolean => {
  // Canonical buckets — delegate directly to the classifier
  if (bucket === 'all' || bucket === 'all_conversations') return true
  if (bucket === 'suppressed' || bucket === 'dnc_suppressed') {
    return resolveInboxThreadState(thread, now).bucket === 'suppressed'
  }
  if (bucket === 'needs_review') return resolveInboxThreadState(thread, now).bucket === 'needs_review'
  if (bucket === 'priority') return resolveInboxThreadState(thread, now).bucket === 'priority'
  if (bucket === 'new_replies') return resolveInboxThreadState(thread, now).bucket === 'new_replies'
  if (bucket === 'waiting' || bucket === 'waiting_on_seller') {
    const raw = String(get(thread, 'inbox_bucket', 'inboxBucket') ?? '').toLowerCase()
    return raw === 'waiting' || raw === 'waiting_on_seller' || resolveInboxThreadState(thread, now).bucket === 'waiting'
  }
  if (bucket === 'follow_up' || bucket === 'follow_up_due') return resolveInboxThreadState(thread, now).bucket === 'follow_up'
  if (bucket === 'cold' || bucket === 'cold_no_response') return resolveInboxThreadState(thread, now).bucket === 'cold'
  // Legacy-only buckets that have no canonical equivalent
  if (bucket === 'negotiating') return UNDERWRITING_STAGES.has(buildConversationDecision(thread, now).conversation_stage)
  if (bucket === 'automated') {
    const status = buildConversationDecision(thread, now).automation_status
    return status === 'AUTO-ELIGIBLE' || status === 'AUTO-QUEUED'
  }
  return false
}

export const isHotLeadDecision = (decision: ConversationDecision): boolean =>
  ['HOT', 'VERY_HOT', 'READY_TO_CLOSE'].includes(decision.lead_temperature) &&
  decision.suppression_status === 'clear' &&
  !includesAny(decision.seller_intent, ['wrong_number', 'opt_out', 'not_interested', 'negative', 'hostile'])

export const sortThreadsByDecision = (
  threads: InboxWorkflowThread[],
  _decisions: Map<string, ConversationDecision>,
): InboxWorkflowThread[] => {
  return [...threads].sort((a, b) => {
    // Strict chronological sorting as per requirements
    const timeA = new Date(a.lastMessageAt || (a as any).lastMessageIso || a.updatedAt || 0).getTime()
    const timeB = new Date(b.lastMessageAt || (b as any).lastMessageIso || b.updatedAt || 0).getTime()
    return timeB - timeA
  })
}
