import type { InboxWorkflowThread } from './inboxWorkflowData'
import { getSupabaseClient } from '../supabaseClient'
import { asBoolean, asIso, asString, getFirst, mapErrorMessage, normalizeStatus, safeArray, type AnyRecord } from './shared'

export type CalendarViewMode = 'day' | 'week' | 'thirty_day' | 'timeline'
export type CalendarScopeMode = 'global' | 'selected'
export type CalendarEventTone = 'blue' | 'cyan' | 'green' | 'amber' | 'red' | 'purple' | 'gold' | 'gray'
export type CalendarEventType =
  | 'scheduled_sms'
  | 'sms_sent'
  | 'sms_delivered'
  | 'sms_failed'
  | 'inbound_reply'
  | 'seller_reply_needs_action'
  | 'seller_follow_up'
  | 'manual_review'
  | 'automation_blocked'
  | 'queue_retry'
  | 'offer_follow_up'
  | 'offer_created'
  | 'offer_sent'
  | 'offer_expiration'
  | 'contract_sent'
  | 'contract_signature_deadline'
  | 'fully_executed_contract'
  | 'title_opened'
  | 'title_milestone'
  | 'clear_to_close'
  | 'closing_scheduled'
  | 'buyer_packet_sent'
  | 'buyer_follow_up'
  | 'email_follow_up'
  | 'dnc_suppression'
  | 'wrong_number'
  | 'positive_intent'
  | 'underwriting_started'
  | 'underwriting_completed'
  | 'historical_event'

export type CalendarFilters = {
  startDate?: string
  endDate?: string
  date?: string
  market?: string
  state?: string
  agent?: string
  priority?: string
  eventTypes?: CalendarEventType[]
  overdueOnly?: boolean
  hotOnly?: boolean
  automationBlocked?: boolean
  closingTitleOnly?: boolean
  buyerFollowUpOnly?: boolean
  selectedSellerOnly?: boolean
  globalOnly?: boolean
  sellerId?: string | null
  propertyId?: string | null
  threadId?: string | null
  threads?: InboxWorkflowThread[]
  limit?: number
}

export type CalendarEvent = {
  id: string
  type: CalendarEventType
  tone: CalendarEventTone
  title: string
  description: string
  timestamp: string
  endTimestamp?: string | null
  sourceTable: string
  status: string
  market: string
  state: string
  sellerName: string
  propertyAddress: string
  propertyId: string | null
  sellerId: string | null
  threadId: string | null
  priority: string
  actor: string
  actionLabel?: string
  metadata?: Record<string, unknown>
  overdue: boolean
  dueSoon: boolean
  hot: boolean
  automationBlocked: boolean
}

export type ExecutionSummaryCard = {
  id: string
  label: string
  value: number
  tone: CalendarEventTone
}

type CalendarDataset = {
  sendQueue: AnyRecord[]
  messageEvents: AnyRecord[]
  offers: AnyRecord[]
  contracts: AnyRecord[]
  closings: AnyRecord[]
  titleRouting: AnyRecord[]
  buyerMatch: AnyRecord[]
  aiBrain: AnyRecord[]
}

const HOUR_MS = 3600000
const DATA_LIMIT = 2000

const normalizePhoneLike = (value: unknown) => {
  const raw = asString(value, '')
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (raw.startsWith('+')) return `+${digits}`
  return digits
}

const safeSelect = async (table: string, columns = '*', limit = DATA_LIMIT): Promise<AnyRecord[]> => {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .limit(limit)
    if (error) {
      console.warn(`[calendarData] ${table} unavailable`, mapErrorMessage(error))
      return []
    }
    return safeArray(data as unknown as AnyRecord[])
  } catch (error) {
    console.warn(`[calendarData] ${table} unavailable`, error)
    return []
  }
}

const startOfDayIso = (value: Date) => {
  const next = new Date(value)
  next.setHours(0, 0, 0, 0)
  return next.toISOString()
}

const endOfDayIso = (value: Date) => {
  const next = new Date(value)
  next.setHours(23, 59, 59, 999)
  return next.toISOString()
}

const formatDateKey = (value: string) => startOfDayIso(new Date(value)).slice(0, 10)

const withinRange = (iso: string, startIso?: string, endIso?: string) => {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return false
  if (startIso && ts < new Date(startIso).getTime()) return false
  if (endIso && ts > new Date(endIso).getTime()) return false
  return true
}

const isOverdue = (iso: string, status: string) => {
  const normalized = normalizeStatus(status)
  if (['delivered', 'sent', 'completed', 'executed', 'closed', 'clear_to_close', 'signed'].includes(normalized)) return false
  return new Date(iso).getTime() < Date.now()
}

const isDueSoon = (iso: string) => {
  const ts = new Date(iso).getTime()
  return Number.isFinite(ts) && ts >= Date.now() && ts - Date.now() <= 36 * HOUR_MS
}

const threadIndex = (threads: InboxWorkflowThread[] = []) => {
  const byThread = new Map<string, InboxWorkflowThread>()
  const byProperty = new Map<string, InboxWorkflowThread>()
  const bySeller = new Map<string, InboxWorkflowThread>()
  const byProspect = new Map<string, InboxWorkflowThread>()
  const byPhone = new Map<string, InboxWorkflowThread>()
  threads.forEach((thread) => {
    const threadKey = asString(thread.threadKey || thread.id, '')
    const propertyId = asString(thread.propertyId, '')
    const sellerId = asString(thread.ownerId, '')
    const prospectId = asString((thread as any).prospectId, '')
    const phones = [
      normalizePhoneLike((thread as any).phoneNumber),
      normalizePhoneLike((thread as any).canonicalE164),
      normalizePhoneLike((thread as any).sellerPhone),
    ].filter(Boolean)
    if (threadKey) byThread.set(threadKey, thread)
    if (thread.id) byThread.set(thread.id, thread)
    if (propertyId && !byProperty.has(propertyId)) byProperty.set(propertyId, thread)
    if (sellerId && !bySeller.has(sellerId)) bySeller.set(sellerId, thread)
    if (prospectId && !byProspect.has(prospectId)) byProspect.set(prospectId, thread)
    phones.forEach((phone) => {
      if (!byPhone.has(phone)) byPhone.set(phone, thread)
    })
  })
  return { byThread, byProperty, bySeller, byProspect, byPhone }
}

const resolveThreadForRow = (row: AnyRecord, indexes: ReturnType<typeof threadIndex>) => {
  const threadKey = asString(getFirst(row, ['thread_key', 'queue_key', 'message_event_key', 'conversation_id', 'thread_id']), '')
  const propertyId = asString(getFirst(row, ['property_id']), '')
  const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '')
  const prospectId = asString(getFirst(row, ['prospect_id']), '')
  const phone = normalizePhoneLike(getFirst(row, ['to_phone_number', 'from_phone_number', 'phone_number', 'seller_phone']))
  return indexes.byThread.get(threadKey)
    || indexes.byThread.get(asString(getFirst(row, ['thread_id', 'conversation_id']), ''))
    || indexes.byProperty.get(propertyId)
    || indexes.bySeller.get(sellerId)
    || indexes.byProspect.get(prospectId)
    || indexes.byPhone.get(phone)
    || null
}

const resolveSellerName = (row: AnyRecord, thread: InboxWorkflowThread | null) =>
  asString(
    getFirst(
      row,
      ['seller_name', 'owner_name', 'owner_display_name', 'contact_name', 'prospect_name'],
    ) || thread?.ownerDisplayName || thread?.ownerName || thread?.sellerName,
    'Unknown Seller',
  )

const resolvePropertyAddress = (row: AnyRecord, thread: InboxWorkflowThread | null) =>
  asString(
    getFirst(
      row,
      ['property_address_full', 'property_address', 'address', 'situs_address'],
    ) || thread?.propertyAddressFull || thread?.propertyAddress || thread?.subject,
    'Property Unknown',
  )

const resolveMarket = (row: AnyRecord, thread: InboxWorkflowThread | null) =>
  asString(getFirst(row, ['market']), thread?.market || thread?.marketName || 'Market Unknown')

const resolveState = (row: AnyRecord, thread: InboxWorkflowThread | null) =>
  asString(getFirst(row, ['property_address_state', 'state']), (thread as any)?.property_address_state || '—')

const resolvePriority = (row: AnyRecord, thread: InboxWorkflowThread | null) =>
  asString(getFirst(row, ['priority', 'risk_level']), thread?.priority || 'normal')

const resolveActor = (row: AnyRecord) =>
  asString(getFirst(row, ['selected_agent_id', 'agent_id', 'agent_name', 'created_by', 'updated_by']), 'System')

const makeEvent = (
  partial: Omit<CalendarEvent, 'overdue' | 'dueSoon'>,
): CalendarEvent => ({
  ...partial,
  overdue: isOverdue(partial.timestamp, partial.status),
  dueSoon: isDueSoon(partial.timestamp),
})

const loadDataset = async (): Promise<CalendarDataset> => {
  const [
    sendQueue,
    messageEvents,
    offers,
    contracts,
    closings,
    titleRouting,
    buyerMatch,
    aiBrain,
  ] = await Promise.all([
    safeSelect('send_queue'),
    safeSelect('message_events'),
    safeSelect('offers'),
    safeSelect('contracts'),
    safeSelect('closings'),
    safeSelect('title_routing_closing_engine'),
    safeSelect('buyer_match'),
    safeSelect('ai_conversation_brain'),
  ])

  return { sendQueue, messageEvents, offers, contracts, closings, titleRouting, buyerMatch, aiBrain }
}

const buildThreadDerivedEvents = (threads: InboxWorkflowThread[], startIso?: string, endIso?: string): CalendarEvent[] =>
  threads.flatMap((thread) => {
    const sellerName = asString(thread.ownerDisplayName || thread.ownerName || thread.sellerName, 'Unknown Seller')
    const propertyAddress = asString(thread.propertyAddressFull || thread.propertyAddress || thread.subject, 'Property Unknown')
    const market = asString(thread.market || thread.marketName, 'Market Unknown')
    const state = asString((thread as any).property_address_state, '—')
    const sellerId = asString(thread.ownerId, '') || null
    const propertyId = asString(thread.propertyId, '') || null
    const threadId = asString(thread.id, '') || null
    const nextFollowUp = asIso((thread as any).next_follow_up_at || (thread as any).follow_up_at)
    const events: CalendarEvent[] = []
    if (nextFollowUp && withinRange(nextFollowUp, startIso, endIso)) {
      events.push(makeEvent({
        id: `thread-follow-up:${thread.id}:${nextFollowUp}`,
        type: 'seller_follow_up',
        tone: 'blue',
        title: 'Seller Follow-Up',
        description: asString((thread as any).next_action || thread.nextSystemAction, 'Review conversation'),
        timestamp: nextFollowUp,
        endTimestamp: null,
        sourceTable: 'inbox_thread_state',
        status: asString(thread.inboxStatus, 'scheduled'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: asString(thread.priority, 'normal'),
        actor: asString((thread as any).agentId || (thread as any).agent_id, 'System'),
        actionLabel: 'Open Conversation',
        metadata: { stage: thread.conversationStage },
        hot: Boolean(thread.isHotLead),
        automationBlocked: asString(thread.automationState, '').toLowerCase().includes('paused'),
      }))
    }
    const lastInbound = asIso(thread.lastInboundAt)
    if (lastInbound && withinRange(lastInbound, startIso, endIso)) {
      events.push(makeEvent({
        id: `thread-reply:${thread.id}:${lastInbound}`,
        type: 'seller_reply_needs_action',
        tone: Boolean(thread.isHotLead) ? 'gold' : 'cyan',
        title: 'Seller Reply Needs Action',
        description: asString(thread.lastMessageBody, 'Inbound seller activity'),
        timestamp: lastInbound,
        endTimestamp: null,
        sourceTable: 'inbox_threads_hydrated',
        status: 'action_needed',
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: asString(thread.priority, 'normal'),
        actor: 'Seller',
        actionLabel: 'Open Deal Intelligence',
        metadata: { stage: thread.conversationStage },
        hot: Boolean(thread.isHotLead),
        automationBlocked: false,
      }))
    }
    if (asBoolean((thread as any).is_suppressed || thread.isSuppressed || thread.isOptOut, false)) {
      const updated = asIso(thread.updatedAt)
      if (updated && withinRange(updated, startIso, endIso)) {
        events.push(makeEvent({
          id: `thread-suppressed:${thread.id}:${updated}`,
          type: 'dnc_suppression',
          tone: 'red',
          title: 'Suppression / DNC',
          description: 'Seller is suppressed or opted out.',
          timestamp: updated,
          endTimestamp: null,
          sourceTable: 'inbox_thread_state',
          status: 'suppressed',
          market,
          state,
          sellerName,
          propertyAddress,
          propertyId,
          sellerId,
          threadId,
          priority: asString(thread.priority, 'normal'),
          actor: 'Safety Layer',
          actionLabel: 'Mark Reviewed',
          metadata: { stage: thread.conversationStage },
          hot: false,
          automationBlocked: true,
        }))
      }
    }
    return events
  })

const buildQueueEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const timestamp =
      asIso(getFirst(row, ['scheduled_for', 'scheduled_at', 'send_at', 'approved_at', 'held_at', 'sent_at', 'updated_at', 'created_at']))
    if (!timestamp || !withinRange(timestamp, startIso, endIso)) return []
    const status = normalizeStatus(getFirst(row, ['queue_status', 'status']))
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = asString(getFirst(row, ['thread_id', 'thread_key', 'queue_key']), '') || thread?.id || null
    let type: CalendarEventType = 'scheduled_sms'
    let tone: CalendarEventTone = 'blue'
    let title = 'Scheduled SMS'
    if (status === 'failed') { type = 'sms_failed'; tone = 'red'; title = 'SMS Failed' }
    else if (status === 'delivered') { type = 'sms_delivered'; tone = 'green'; title = 'SMS Delivered' }
    else if (status === 'sent' || status === 'sending' || status === 'ready') { type = 'sms_sent'; tone = 'green'; title = 'SMS Sent' }
    else if (status === 'retry') { type = 'queue_retry'; tone = 'amber'; title = 'Queue Retry' }
    else if (status === 'blocked' || status === 'held' || status === 'approval') { type = 'automation_blocked'; tone = 'red'; title = 'Automation Blocked' }
    return [makeEvent({
      id: `queue:${asString(getFirst(row, ['id', 'queue_id']), `${index}`)}`,
      type,
      tone,
      title,
      description: asString(getFirst(row, ['message_body', 'message_text', 'paused_reason', 'failed_reason']), 'Queue event'),
      timestamp,
      endTimestamp: null,
      sourceTable: 'send_queue',
      status: status || 'scheduled',
      market,
      state,
      sellerName,
      propertyAddress,
      propertyId,
      sellerId,
      threadId,
      priority: resolvePriority(row, thread),
      actor: resolveActor(row),
      actionLabel: 'Open Conversation',
      metadata: { template: getFirst(row, ['selected_template_id', 'use_case_template']) },
      hot: Boolean(thread?.isHotLead),
      automationBlocked: type === 'automation_blocked',
    })]
  })

const buildMessageEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const timestamp = asIso(getFirst(row, ['timeline_at', 'event_timestamp', 'message_created_at', 'received_at', 'sent_at', 'created_at']))
    if (!timestamp || !withinRange(timestamp, startIso, endIso)) return []
    const direction = normalizeStatus(getFirst(row, ['direction']))
    const delivery = normalizeStatus(getFirst(row, ['delivery_status', 'provider_delivery_status', 'raw_carrier_status', 'status']))
    const isOptOut = asBoolean(getFirst(row, ['is_opt_out']), false)
    const body = asString(getFirst(row, ['body', 'message_body', 'text', 'content']), '')
    const status = delivery || (direction === 'inbound' ? 'received' : 'sent')
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = asString(getFirst(row, ['thread_id', 'message_event_key', 'conversation_id']), '') || thread?.id || null
    let type: CalendarEventType = 'historical_event'
    let tone: CalendarEventTone = 'gray'
    let title = 'Historical Event'
    if (isOptOut) { type = 'dnc_suppression'; tone = 'red'; title = 'DNC / Suppression Event' }
    else if (body.toLowerCase().includes('wrong number')) { type = 'wrong_number'; tone = 'red'; title = 'Wrong Number' }
    else if (direction === 'inbound') {
      type = body.toLowerCase().includes('yes') || body.toLowerCase().includes('interested') ? 'positive_intent' : 'inbound_reply'
      tone = type === 'positive_intent' ? 'green' : 'cyan'
      title = type === 'positive_intent' ? 'Positive Intent' : 'Inbound Reply'
    } else if (delivery.includes('delivered')) {
      type = 'sms_delivered'; tone = 'green'; title = 'SMS Delivered'
    } else if (delivery.includes('failed')) {
      type = 'sms_failed'; tone = 'red'; title = 'SMS Failed'
    } else {
      type = 'sms_sent'; tone = 'blue'; title = 'SMS Sent'
    }
    return [makeEvent({
      id: `msg:${asString(getFirst(row, ['id', 'message_event_id', 'provider_message_sid']), `${index}`)}`,
      type,
      tone,
      title,
      description: body || asString(getFirst(row, ['failure_reason', 'error_message']), 'Message event'),
      timestamp,
      endTimestamp: null,
      sourceTable: 'message_events',
      status,
      market,
      state,
      sellerName,
      propertyAddress,
      propertyId,
      sellerId,
      threadId,
      priority: resolvePriority(row, thread),
      actor: direction === 'inbound' ? 'Seller' : resolveActor(row),
      actionLabel: 'Open Conversation',
      metadata: { direction, delivery },
      hot: Boolean(thread?.isHotLead) || type === 'positive_intent',
      automationBlocked: false,
    })]
  })

const buildOfferEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const events: CalendarEvent[] = []
    const createdAt = asIso(getFirst(row, ['created_at', 'offer_created_at']))
    const sentAt = asIso(getFirst(row, ['sent_at', 'offer_sent_at', 'updated_at']))
    const expiresAt = asIso(getFirst(row, ['expires_at', 'expiration_at', 'follow_up_at']))
    if (createdAt && withinRange(createdAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `offer-created:${asString(getFirst(row, ['offer_id', 'id']), `${index}`)}`,
        type: 'offer_created',
        tone: 'purple',
        title: 'Offer Created',
        description: asString(getFirst(row, ['status', 'offer_status']), 'Offer created'),
        timestamp: createdAt,
        endTimestamp: null,
        sourceTable: 'offers',
        status: asString(getFirst(row, ['status', 'offer_status']), 'created'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: { amount: getFirst(row, ['offer_amount', 'recommended_offer', 'amount']) },
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    if (sentAt && withinRange(sentAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `offer-sent:${asString(getFirst(row, ['offer_id', 'id']), `${index}`)}`,
        type: 'offer_sent',
        tone: 'purple',
        title: 'Offer Sent',
        description: asString(getFirst(row, ['status', 'offer_status']), 'Offer sent to seller'),
        timestamp: sentAt,
        endTimestamp: null,
        sourceTable: 'offers',
        status: asString(getFirst(row, ['status', 'offer_status']), 'sent'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: { amount: getFirst(row, ['offer_amount', 'recommended_offer', 'amount']) },
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    if (expiresAt && withinRange(expiresAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `offer-exp:${asString(getFirst(row, ['offer_id', 'id']), `${index}`)}`,
        type: 'offer_expiration',
        tone: 'amber',
        title: 'Offer Expiration',
        description: 'Offer response window is approaching.',
        timestamp: expiresAt,
        endTimestamp: null,
        sourceTable: 'offers',
        status: asString(getFirst(row, ['status', 'offer_status']), 'open'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: { amount: getFirst(row, ['offer_amount', 'recommended_offer', 'amount']) },
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    return events
  })

const buildContractEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const sentAt = asIso(getFirst(row, ['sent_at', 'contract_sent_at', 'created_at']))
    const signedDeadline = asIso(getFirst(row, ['signature_deadline', 'expires_at', 'due_at']))
    const executedAt = asIso(getFirst(row, ['fully_executed_at', 'executed_at', 'signed_at']))
    const status = asString(getFirst(row, ['status', 'contract_status']), 'pending')
    const events: CalendarEvent[] = []
    if (sentAt && withinRange(sentAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `contract-sent:${asString(getFirst(row, ['contract_id', 'id']), `${index}`)}`,
        type: 'contract_sent',
        tone: 'purple',
        title: 'Contract Sent',
        description: 'Contract packet sent for signature.',
        timestamp: sentAt,
        endTimestamp: null,
        sourceTable: 'contracts',
        status,
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: {},
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    if (signedDeadline && withinRange(signedDeadline, startIso, endIso)) {
      events.push(makeEvent({
        id: `contract-deadline:${asString(getFirst(row, ['contract_id', 'id']), `${index}`)}`,
        type: 'contract_signature_deadline',
        tone: 'amber',
        title: 'Contract Signature Deadline',
        description: 'Unsigned contract needs movement.',
        timestamp: signedDeadline,
        endTimestamp: null,
        sourceTable: 'contracts',
        status,
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: {},
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    if (executedAt && withinRange(executedAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `contract-executed:${asString(getFirst(row, ['contract_id', 'id']), `${index}`)}`,
        type: 'fully_executed_contract',
        tone: 'green',
        title: 'Fully Executed Contract',
        description: 'Seller and buyer have fully executed the contract.',
        timestamp: executedAt,
        endTimestamp: null,
        sourceTable: 'contracts',
        status,
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: {},
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    return events
  })

const buildTitleClosingEvents = (
  titleRows: AnyRecord[],
  closingRows: AnyRecord[],
  indexes: ReturnType<typeof threadIndex>,
  startIso?: string,
  endIso?: string,
): CalendarEvent[] => {
  const titleEvents = titleRows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const openedAt = asIso(getFirst(row, ['title_opened_at', 'opened_at', 'created_at']))
    const milestoneAt = asIso(getFirst(row, ['next_milestone_at', 'milestone_at', 'updated_at']))
    const milestoneLabel = asString(getFirst(row, ['milestone_name', 'status', 'title_status']), 'Title milestone')
    const events: CalendarEvent[] = []
    if (openedAt && withinRange(openedAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `title-opened:${asString(getFirst(row, ['id', 'title_id']), `${index}`)}`,
        type: 'title_opened',
        tone: 'gold',
        title: 'Title Opened',
        description: 'Title routing opened for this deal.',
        timestamp: openedAt,
        endTimestamp: null,
        sourceTable: 'title_routing_closing_engine',
        status: asString(getFirst(row, ['status', 'title_status']), 'opened'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: {},
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    if (milestoneAt && withinRange(milestoneAt, startIso, endIso)) {
      events.push(makeEvent({
        id: `title-milestone:${asString(getFirst(row, ['id', 'title_id']), `${index}`)}`,
        type: milestoneLabel.toLowerCase().includes('clear') ? 'clear_to_close' : 'title_milestone',
        tone: milestoneLabel.toLowerCase().includes('clear') ? 'gold' : 'amber',
        title: milestoneLabel.toLowerCase().includes('clear') ? 'Clear To Close' : 'Title Milestone',
        description: milestoneLabel,
        timestamp: milestoneAt,
        endTimestamp: null,
        sourceTable: 'title_routing_closing_engine',
        status: asString(getFirst(row, ['status', 'title_status']), 'active'),
        market,
        state,
        sellerName,
        propertyAddress,
        propertyId,
        sellerId,
        threadId,
        priority: resolvePriority(row, thread),
        actor: resolveActor(row),
        actionLabel: 'Open Deal Intelligence',
        metadata: {},
        hot: Boolean(thread?.isHotLead),
        automationBlocked: false,
      }))
    }
    return events
  })

  const closingEvents = closingRows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const scheduledAt = asIso(getFirst(row, ['closing_date', 'scheduled_at', 'closing_scheduled_at']))
    if (!scheduledAt || !withinRange(scheduledAt, startIso, endIso)) return []
    return [makeEvent({
      id: `closing:${asString(getFirst(row, ['closing_id', 'id']), `${index}`)}`,
      type: 'closing_scheduled',
      tone: 'gold',
      title: 'Closing Scheduled',
      description: 'Closing target is on the board.',
      timestamp: scheduledAt,
      endTimestamp: null,
      sourceTable: 'closings',
      status: asString(getFirst(row, ['status', 'closing_status']), 'scheduled'),
      market,
      state,
      sellerName,
      propertyAddress,
      propertyId,
      sellerId,
      threadId,
      priority: resolvePriority(row, thread),
      actor: resolveActor(row),
      actionLabel: 'Open Deal Intelligence',
      metadata: {},
      hot: Boolean(thread?.isHotLead),
      automationBlocked: false,
    })]
  })

  return [...titleEvents, ...closingEvents]
}

const buildBuyerEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const timestamp = asIso(getFirst(row, ['follow_up_at', 'packet_sent_at', 'created_at', 'updated_at']))
    if (!timestamp || !withinRange(timestamp, startIso, endIso)) return []
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const packetSent = Boolean(getFirst(row, ['packet_sent_at']))
    return [makeEvent({
      id: `buyer:${asString(getFirst(row, ['id', 'buyer_match_id']), `${index}`)}`,
      type: packetSent ? 'buyer_packet_sent' : 'buyer_follow_up',
      tone: packetSent ? 'green' : 'amber',
      title: packetSent ? 'Buyer Packet Sent' : 'Buyer Follow-Up',
      description: asString(getFirst(row, ['recommended_action', 'reason', 'status']), 'Buyer activity'),
      timestamp,
      endTimestamp: null,
      sourceTable: 'buyer_match',
      status: asString(getFirst(row, ['status']), 'active'),
      market,
      state,
      sellerName,
      propertyAddress,
      propertyId,
      sellerId,
      threadId,
      priority: resolvePriority(row, thread),
      actor: resolveActor(row),
      actionLabel: 'Open Buyer Match',
      metadata: {},
      hot: Boolean(thread?.isHotLead),
      automationBlocked: false,
    })]
  })

const buildAiEvents = (rows: AnyRecord[], indexes: ReturnType<typeof threadIndex>, startIso?: string, endIso?: string): CalendarEvent[] =>
  rows.flatMap((row, index) => {
    const thread = resolveThreadForRow(row, indexes)
    const timestamp = asIso(getFirst(row, ['updated_at', 'created_at', 'started_at', 'completed_at']))
    if (!timestamp || !withinRange(timestamp, startIso, endIso)) return []
    const sellerName = resolveSellerName(row, thread)
    const propertyAddress = resolvePropertyAddress(row, thread)
    const market = resolveMarket(row, thread)
    const state = resolveState(row, thread)
    const sellerId = asString(getFirst(row, ['master_owner_id', 'owner_id', 'prospect_id']), '') || asString(thread?.ownerId, '') || null
    const propertyId = asString(getFirst(row, ['property_id']), '') || asString(thread?.propertyId, '') || null
    const threadId = thread?.id || null
    const status = normalizeStatus(getFirst(row, ['underwriting_status', 'status', 'brain_status']))
    const completed = status.includes('complete') || Boolean(getFirst(row, ['completed_at']))
    return [makeEvent({
      id: `ai:${asString(getFirst(row, ['id', 'conversation_brain_id']), `${index}`)}`,
      type: completed ? 'underwriting_completed' : 'underwriting_started',
      tone: completed ? 'green' : 'blue',
      title: completed ? 'Underwriting Completed' : 'Underwriting Started',
      description: asString(getFirst(row, ['summary', 'recommended_action', 'next_action']), 'AI underwriting execution'),
      timestamp,
      endTimestamp: null,
      sourceTable: 'ai_conversation_brain',
      status: status || 'active',
      market,
      state,
      sellerName,
      propertyAddress,
      propertyId,
      sellerId,
      threadId,
      priority: resolvePriority(row, thread),
      actor: resolveActor(row),
      actionLabel: 'Open Deal Intelligence',
      metadata: {},
      hot: Boolean(thread?.isHotLead),
      automationBlocked: false,
    })]
  })

const applyFilters = (events: CalendarEvent[], filters: CalendarFilters): CalendarEvent[] =>
  events
    .filter((event) => {
      if (filters.market && event.market !== filters.market) return false
      if (filters.state && event.state !== filters.state) return false
      if (filters.priority && event.priority !== filters.priority) return false
      if (filters.agent && event.actor !== filters.agent) return false
      if (filters.eventTypes?.length && !filters.eventTypes.includes(event.type)) return false
      if (filters.overdueOnly && !event.overdue) return false
      if (filters.hotOnly && !event.hot) return false
      if (filters.automationBlocked && !event.automationBlocked) return false
      if (filters.closingTitleOnly && !['contract_sent', 'contract_signature_deadline', 'fully_executed_contract', 'title_opened', 'title_milestone', 'clear_to_close', 'closing_scheduled'].includes(event.type)) return false
      if (filters.buyerFollowUpOnly && !['buyer_follow_up', 'buyer_packet_sent'].includes(event.type)) return false
      if (filters.propertyId && event.propertyId !== filters.propertyId) return false
      if (filters.sellerId && event.sellerId !== filters.sellerId) return false
      if (filters.threadId && event.threadId !== filters.threadId) return false
      return true
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(0, filters.limit ?? 500)

export const loadCalendarEvents = async (filters: CalendarFilters = {}): Promise<CalendarEvent[]> => {
  const dataset = await loadDataset()
  const indexes = threadIndex(filters.threads)
  const startIso = filters.startDate
  const endIso = filters.endDate
  const events = [
    ...buildThreadDerivedEvents(filters.threads ?? [], startIso, endIso),
    ...buildQueueEvents(dataset.sendQueue, indexes, startIso, endIso),
    ...buildMessageEvents(dataset.messageEvents, indexes, startIso, endIso),
    ...buildOfferEvents(dataset.offers, indexes, startIso, endIso),
    ...buildContractEvents(dataset.contracts, indexes, startIso, endIso),
    ...buildTitleClosingEvents(dataset.titleRouting, dataset.closings, indexes, startIso, endIso),
    ...buildBuyerEvents(dataset.buyerMatch, indexes, startIso, endIso),
    ...buildAiEvents(dataset.aiBrain, indexes, startIso, endIso),
  ]
  return applyFilters(events, filters)
}

export const loadDailyCalendar = async (date: string, filters: CalendarFilters = {}) =>
  loadCalendarEvents({ ...filters, startDate: startOfDayIso(new Date(date)), endDate: endOfDayIso(new Date(date)) })

export const loadWeeklyCalendar = async (startDate: string, filters: CalendarFilters = {}) => {
  const start = new Date(startDate)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return loadCalendarEvents({ ...filters, startDate: startOfDayIso(start), endDate: endOfDayIso(end) })
}

export const loadThirtyDayCalendar = async (startDate: string, filters: CalendarFilters = {}) => {
  const start = new Date(startDate)
  const end = new Date(start)
  end.setDate(end.getDate() + 29)
  return loadCalendarEvents({ ...filters, startDate: startOfDayIso(start), endDate: endOfDayIso(end) })
}

export const loadGlobalExecutionTimeline = async (filters: CalendarFilters = {}) =>
  loadCalendarEvents({ ...filters, limit: 700 })

export const loadSelectedSellerTimeline = async (sellerId: string, propertyId?: string, threads?: InboxWorkflowThread[]) =>
  loadCalendarEvents({ sellerId, propertyId, threads, limit: 700 })

export const loadSelectedDealTimeline = async (propertyId: string) =>
  loadCalendarEvents({ propertyId, limit: 700 })

export const loadTodayExecutionSummary = async (filters: CalendarFilters = {}): Promise<ExecutionSummaryCard[]> => {
  const events = await loadDailyCalendar(new Date().toISOString(), filters)
  const count = (predicate: (event: CalendarEvent) => boolean) => events.filter(predicate).length
  return [
    { id: 'due-today', label: 'Due Today', value: events.length, tone: 'blue' },
    { id: 'overdue', label: 'Overdue', value: count((event) => event.overdue), tone: 'red' },
    { id: 'seller-replies', label: 'Seller Replies', value: count((event) => ['inbound_reply', 'seller_reply_needs_action', 'positive_intent'].includes(event.type)), tone: 'cyan' },
    { id: 'scheduled-sms', label: 'Scheduled SMS', value: count((event) => event.type === 'scheduled_sms'), tone: 'blue' },
    { id: 'offers-due', label: 'Offers Due', value: count((event) => ['offer_follow_up', 'offer_expiration'].includes(event.type)), tone: 'purple' },
    { id: 'contracts-awaiting', label: 'Contracts Awaiting Signature', value: count((event) => event.type === 'contract_signature_deadline'), tone: 'purple' },
    { id: 'title-milestones', label: 'Title Milestones', value: count((event) => ['title_opened', 'title_milestone', 'clear_to_close'].includes(event.type)), tone: 'gold' },
    { id: 'buyer-follow-ups', label: 'Buyer Follow-Ups', value: count((event) => ['buyer_follow_up', 'buyer_packet_sent'].includes(event.type)), tone: 'amber' },
    { id: 'closings', label: 'Closings', value: count((event) => event.type === 'closing_scheduled'), tone: 'gold' },
    { id: 'automation-blocks', label: 'Automation Blocks', value: count((event) => event.automationBlocked), tone: 'red' },
  ]
}

export const loadOverdueExecutionItems = async (filters: CalendarFilters = {}) =>
  loadCalendarEvents({ ...filters, overdueOnly: true, limit: 80 })

export const loadAutomationSchedule = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) =>
    ['scheduled_sms', 'seller_follow_up', 'automation_blocked', 'queue_retry', 'underwriting_started', 'underwriting_completed'].includes(event.type))
}

export const loadClosingDeadlines = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) => ['title_opened', 'title_milestone', 'clear_to_close', 'closing_scheduled'].includes(event.type))
}

export const loadBuyerFollowUps = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) => ['buyer_follow_up', 'buyer_packet_sent'].includes(event.type))
}

export const loadContractDeadlines = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) => ['contract_sent', 'contract_signature_deadline', 'fully_executed_contract'].includes(event.type))
}

export const loadOfferFollowUps = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) => ['offer_created', 'offer_sent', 'offer_expiration', 'offer_follow_up'].includes(event.type))
}

export const getCalendarModeRangeLabel = (mode: CalendarViewMode, anchor: Date) => {
  if (mode === 'day') return formatDateKey(anchor.toISOString())
  if (mode === 'week') {
    const end = new Date(anchor)
    end.setDate(end.getDate() + 6)
    return `${formatDateKey(anchor.toISOString())} → ${formatDateKey(end.toISOString())}`
  }
  if (mode === 'thirty_day') {
    const end = new Date(anchor)
    end.setDate(end.getDate() + 29)
    return `${formatDateKey(anchor.toISOString())} → ${formatDateKey(end.toISOString())}`
  }
  return 'Full Timeline'
}
