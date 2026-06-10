import type { InboxThread } from '../../domain/inbox/inbox-model-types'
import { getSupabaseClient } from '../supabaseClient'
import { getInboxThreads, getThreadMessagesForThread, normalizeMessageDirection } from './inboxData'
import { asBoolean, asIso, asString, getSupabaseErrorMessage, mapErrorMessage, normalizeStatus, safeArray, type AnyRecord } from './shared'
import { logInboxActivity } from './inboxActivityData'
import * as backendClient from '../api/backendClient'

const DEV = Boolean(import.meta.env?.DEV)
const SENT_MESSAGES_PAGE_SIZE = 1000

export type InboxStatus =
  | 'new_reply'
  | 'needs_review'
  | 'ai_draft_ready'
  | 'queued'
  | 'waiting'
  | 'suppressed'
  | 'closed'

export type SellerStage =
  | 'ownership_check'
  | 'interest_probe'
  | 'seller_response'
  | 'price_discovery'
  | 'condition_details'
  | 'offer_reveal'
  | 'negotiation'
  | 'contract_path'
  | 'dead_suppressed'
  | 'mf_ownership_check'
  | 'mf_interested'
  | 'mf_units_confirmed'
  | 'mf_occupancy_requested'
  | 'mf_rent_roll_requested'
  | 'mf_gross_rents_requested'
  | 'mf_asking_price_requested'
  | 'mf_underwriting_needed'
  | 'mf_offer_needed'
  | 'mf_offer_sent'
  | 'mf_negotiation'
  | 'mf_contract_requested'
  | 'mf_dead'
  | 'mf_suppressed'

// Aliases to prevent massive breakage during transition
export type InboxStage = SellerStage
export type InboxWorkflowStatus = InboxStatus

export type AutomationState = 'active' | 'paused' | 'completed' | 'manual_control'

export type InboxPriority = 'urgent' | 'high' | 'normal' | 'low'

export type InboxStatusTab =
  | 'priority'
  | 'needs_response'
  | 'sent'
  | 'queued'
  | 'scheduled'
  | 'failed'
  | 'archived'
  | 'all'

export interface InboxThreadsQuery {
  tab?: InboxStatusTab
  search?: string
  market?: string
  direction?: 'all' | 'inbound' | 'outbound'
  stage?: string | 'all'
  status?: InboxStatus | 'all'
  priority?: InboxPriority | 'all'
  read?: 'all' | 'read' | 'unread'
  hasPropertyLink?: boolean
  hasOwnerLink?: boolean
  hasPhoneLink?: boolean
  dncOptOut?: boolean
  startDate?: string
  endDate?: string
}

export interface InboxThreadWorkflow {
  threadKey: string
  inboxStatus: InboxStatus
  conversationStage: SellerStage
  // Backwards compat
  inboxStage: SellerStage
  automationState: AutomationState
  nextSystemAction: string
  isArchived: boolean
  isRead: boolean
  isPinned: boolean
  isStarred: boolean
  isHidden: boolean
  isSuppressed: boolean
  priority: InboxPriority
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastMessageAt: string
  lastMessageBody: string
  lastDirection: 'inbound' | 'outbound' | 'unknown'
  updatedAt: string
  queueStatus: string | null
  sellerName?: string
  sellerFirstName?: string
  sellerPhone?: string
  showInPriorityInbox?: boolean
  threadWorkflowStatus?: string
  threadWorkflowStage?: string
  isAbsentee?: boolean
  isOwnerOccupied?: boolean
  isVacant?: boolean
  isTaxDelinquent?: boolean
  isProbate?: boolean
  hasLien?: boolean
  motivationScore?: number | string
  latitude?: number
  longitude?: number
  isHotLead?: boolean
  isNewInbound?: boolean
  displayName?: string
  displayAddress?: string
  displayPhone?: string
  displayMarket?: string
  displayStatus?: string
  displayScore?: number
}

export type InboxWorkflowThread = InboxThread & InboxThreadWorkflow

export interface WorkflowMutationResult {
  ok: boolean
  writeTarget: 'operator_thread_state' | 'none'
  errorMessage: string | null
  threadKey: string
  mutationPayload: AnyRecord | null
}

export interface SentMessageItem {
  id: string
  threadKey: string
  body: string
  recipientNumber: string
  fromNumber: string
  providerMessageId: string | null
  sentAt: string
  deliveryStatus: string
  providerDeliveryStatus: string | null
  deliveryConfirmed: boolean
  failedReason: string | null
  ownerName: string
  propertyAddress: string
}

const tableProbeCache = new Map<string, boolean>()

export const normalizePhone = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return ''
  const hasPlus = raw.startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return hasPlus ? `+${digits}` : digits
}

const safeFilterValue = (value: string): string => value.replace(/[(),]/g, '')

const buildPhoneVariants = (phone: string): string[] => {
  if (!phone) return []
  const digits = phone.replace(/\D/g, '')
  if (!digits) return []
  const out = new Set<string>()
  out.add(phone)
  out.add(digits)
  out.add(phone.startsWith('+') ? phone : `+${digits}`)
  if (digits.length === 11 && digits.startsWith('1')) {
    out.add(digits.slice(1))
    out.add(`+${digits}`)
  }
  if (digits.length === 10) out.add(`+1${digits}`)
  return Array.from(out)
}

const buildMessageEventFilter = (thread: InboxThread): string => {
  const terms = [
    thread.phoneNumber ? `from_phone_number.eq.${safeFilterValue(thread.phoneNumber)}` : '',
    thread.phoneNumber ? `to_phone_number.eq.${safeFilterValue(thread.phoneNumber)}` : '',
    thread.canonicalE164 ? `from_phone_number.eq.${safeFilterValue(thread.canonicalE164)}` : '',
    thread.canonicalE164 ? `to_phone_number.eq.${safeFilterValue(thread.canonicalE164)}` : '',
    thread.threadKey ? `message_event_key.eq.${safeFilterValue(thread.threadKey)}` : '',
    thread.ownerId ? `master_owner_id.eq.${safeFilterValue(thread.ownerId)}` : '',
    thread.prospectId ? `prospect_id.eq.${safeFilterValue(thread.prospectId)}` : '',
    thread.propertyId ? `property_id.eq.${safeFilterValue(thread.propertyId)}` : '',
    thread.id ? `thread_id.eq.${safeFilterValue(thread.id)}` : '',
    thread.id ? `conversation_id.eq.${safeFilterValue(thread.id)}` : '',
  ].filter(Boolean)
  return terms.join(',')
}

const isMissingSchemaError = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code
  return code === '42P01' || code === '42703'
}

const tableExists = async (table: string): Promise<boolean> => {
  if (tableProbeCache.has(table)) return tableProbeCache.get(table) ?? false
  const supabase = getSupabaseClient()
  const { error } = await supabase.from(table).select('*').limit(1)
  const exists = !error || !isMissingSchemaError(error)
  tableProbeCache.set(table, exists)
  return exists
}

const toThreadKey = (thread: InboxThread): string =>
  asString(thread.threadKey, '') ||
  asString(thread.id, '') ||
  [thread.ownerId, thread.propertyId, thread.phoneNumber].filter(Boolean).join(':')

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

const inferInboxStatus = (
  thread: InboxThread,
  queueRow: AnyRecord | null,
): InboxStatus => {
  const isArchived = Boolean((thread as any).isArchived || thread.status === 'archived')
  if (isArchived) return 'closed'
  
  if (thread.isOptOut) return 'suppressed'
  
  const queueStatus = normalizeStatus(queueRow?.['queue_status'] ?? queueRow?.['status'] ?? '')
  if (queueStatus === 'queued' || queueStatus === 'scheduled' || queueStatus === 'approval') return 'queued'
  
  if (thread.aiDraft) return 'ai_draft_ready'
  
  const lastInboundTs = thread.lastInboundAt ? new Date(thread.lastInboundAt).getTime() : 0
  const lastOutboundTs = thread.lastOutboundAt ? new Date(thread.lastOutboundAt).getTime() : 0
  const needsResponse = lastInboundTs > lastOutboundTs || (lastInboundTs === lastOutboundTs && normalizeMessageDirection({ direction: thread.directionUsed }) === 'inbound')
  
  if (needsResponse) {
    if (thread.uiIntent === 'info_request' || thread.uiIntent === 'language_switch') return 'needs_review'
    return 'new_reply'
  }
  
  if (lastOutboundTs > 0) return 'waiting'
  
  return 'needs_review'
}

const inferSellerStage = (thread: InboxThread): SellerStage => {
  if (thread.isOptOut) return 'dead_suppressed'
  
  const rawStage = asString((thread as any).current_stage || (thread as any).stage_code || (thread as any).workflowStage || (thread as any).inboxStage, '').toLowerCase()
  if (rawStage.includes('owner')) return 'ownership_check'
  if (rawStage.includes('probe') || rawStage.includes('interest')) return 'interest_probe'
  if (rawStage.includes('discovery') || rawStage.includes('price')) return 'price_discovery'
  if (rawStage.includes('details') || rawStage.includes('condition')) return 'condition_details'
  if (rawStage.includes('reveal') || rawStage.includes('offer')) return 'offer_reveal'
  if (rawStage.includes('negotiat')) return 'negotiation'
  if (rawStage.includes('contract') || rawStage.includes('path')) return 'contract_path'
  
  // Fallback to template use case
  const useCase = asString((thread as any).templateUseCase || (thread as any).template_use_case, '').toLowerCase()
  if (useCase.includes('initial')) return 'ownership_check'
  if (useCase.includes('follow')) return 'interest_probe'
  if (useCase.includes('offer')) return 'offer_reveal'
  
  return 'ownership_check'
}

const getAutomationState = (thread: InboxThread): AutomationState => {
  if ((thread as any).isArchived || thread.isOptOut || thread.status === 'archived') return 'completed'
  if (thread.uiIntent === 'info_request' || thread.uiIntent === 'needs_review') return 'manual_control'
  return 'active'
}

const getNextSystemAction = (status: InboxStatus): string => {
  if (status === 'ai_draft_ready') return 'Review AI draft and approve for send.'
  if (status === 'new_reply') return 'Analyze intent and categorize seller.'
  if (status === 'waiting') return 'Monitor for inbound reply or followup trigger.'
  if (status === 'queued') return 'Message scheduled for next delivery window.'
  if (status === 'suppressed') return 'Suppression active. No further actions.'
  if (status === 'closed') return 'Thread closed. No active workflow.'
  return 'Manual operator intervention recommended.'
}

const queueStateForThread = (thread: InboxThread, queueRows: AnyRecord[]): AnyRecord | null => {
  const phoneVariants = buildPhoneVariants(thread.phoneNumber || thread.canonicalE164 || '')
  return queueRows.find((row) => {
    if (thread.id && row['thread_id'] === thread.id) return true
    if (thread.id && row['conversation_id'] === thread.id) return true
    if (thread.threadKey && row['queue_key'] === thread.threadKey) return true
    if (row['to_phone_number'] && phoneVariants.includes(normalizePhone(row['to_phone_number']))) return true
    return false
  }) ?? null
}

const withWorkflowState = (
  thread: InboxThread,
  stateRow: AnyRecord | null,
  queueRow: AnyRecord | null,
): InboxWorkflowThread => {
  const hasStateRow = Boolean(stateRow)
  const queueStatus = normalizeStatus(queueRow?.['queue_status'] ?? queueRow?.['status'] ?? '') || null
  
  const isArchived = hasStateRow ? asBoolean(stateRow?.['is_archived'], false) : Boolean((thread as any).isArchived || thread.status === 'archived')
  const isRead = hasStateRow ? asBoolean(stateRow?.['is_read'], false) : !thread.unread
  
  const inboxStatus = hasStateRow 
    ? (normalizeStatus(stateRow?.['status']) as InboxStatus || inferInboxStatus(thread, queueRow))
    : inferInboxStatus(thread, queueRow)
    
  const conversationStage = hasStateRow
    ? (normalizeStatus(stateRow?.['stage']) as SellerStage || inferSellerStage(thread))
    : inferSellerStage(thread)

  const lastMessageAt = thread.lastMessageIso || new Date().toISOString()

  let ownerName = thread.ownerName
  let ownerDisplayName = thread.ownerDisplayName
  let subject = thread.subject
  let propertyAddressFull = thread.propertyAddressFull

  if (stateRow?.metadata) {
    const meta = stateRow.metadata as AnyRecord
    if (meta.owner_name) {
      ownerName = asString(meta.owner_name, ownerName)
      ownerDisplayName = ownerName
    }
    if (meta.property_address) {
      subject = asString(meta.property_address, subject)
      propertyAddressFull = subject
    }
  }

  return {
    ...thread,
    ownerName,
    ownerDisplayName,
    subject,
    propertyAddressFull,
    threadKey: toThreadKey(thread),
    inboxStatus,
    conversationStage,
    inboxStage: conversationStage,
    automationState: getAutomationState(thread),
    nextSystemAction: getNextSystemAction(inboxStatus),
    isArchived,
    isRead,
    isPinned: asBoolean(stateRow?.['is_pinned'], false),
    isStarred: asBoolean(stateRow?.['is_starred'], false),
    isHidden: asBoolean(stateRow?.['is_hidden'], false),
    isSuppressed: asBoolean(stateRow?.['is_suppressed'], false),
    priority: hasStateRow
      ? ((normalizeStatus(stateRow?.['priority']) as InboxPriority) || thread.priority)
      : (inboxStatus === 'new_reply' ? 'urgent' : 'normal'),
    lastInboundAt: asIso(stateRow?.['last_inbound_at']) ?? thread.lastInboundAt ?? null,
    lastOutboundAt: asIso(stateRow?.['last_outbound_at']) ?? thread.lastOutboundAt ?? null,
    lastMessageAt,
    lastMessageBody: thread.preview,
    lastDirection: normalizeMessageDirection({ direction: thread.directionUsed }),
    updatedAt: asIso(stateRow?.['updated_at']) ?? lastMessageAt,
    queueStatus,
  }
}

const matchesSearch = (thread: InboxWorkflowThread, search: string): boolean => {
  if (!search) return true
  const q = search.toLowerCase()
  const tokens = [
    thread.ownerName,
    thread.subject,
    thread.preview,
    thread.phoneNumber,
    thread.propertyAddress,
    thread.market,
    thread.marketId,
    thread.conversationStage,
    thread.inboxStatus,
  ]
  return tokens.filter(Boolean).some((value) => String(value).toLowerCase().includes(q))
}

const applyThreadFilters = (threads: InboxWorkflowThread[], params: InboxThreadsQuery): InboxWorkflowThread[] => {
  let filtered = [...threads]

  if (params.tab && params.tab !== 'all') {
    filtered = filtered.filter((thread) => {
      if (params.tab === 'priority') return thread.priority === 'urgent' || thread.priority === 'high'
      if (params.tab === 'needs_response') return thread.inboxStatus === 'new_reply' || thread.inboxStatus === 'needs_review'
      if (params.tab === 'sent') return thread.inboxStatus === 'waiting'
      if (params.tab === 'queued') return thread.inboxStatus === 'queued'
      if (params.tab === 'archived') return thread.isArchived
      return true
    })
  }

  if (!params.tab || params.tab !== 'archived') {
    filtered = filtered.filter((thread) => !thread.isArchived)
  }

  if (params.market) filtered = filtered.filter((thread) => (thread.market || thread.marketId) === params.market)
  if (params.direction && params.direction !== 'all') filtered = filtered.filter((thread) => thread.lastDirection === params.direction)
  if (params.stage && params.stage !== 'all') filtered = filtered.filter((thread) => thread.conversationStage === params.stage)
  if (params.status && params.status !== 'all') filtered = filtered.filter((thread) => thread.inboxStatus === params.status)
  if (params.priority && params.priority !== 'all') filtered = filtered.filter((thread) => thread.priority === params.priority)
  if (params.read === 'read') filtered = filtered.filter((thread) => thread.isRead)
  if (params.read === 'unread') filtered = filtered.filter((thread) => !thread.isRead)
  if (params.hasPropertyLink) filtered = filtered.filter((thread) => Boolean(thread.propertyId || thread.propertyAddress))
  if (params.hasOwnerLink) filtered = filtered.filter((thread) => Boolean(thread.ownerId || thread.ownerName))
  if (params.hasPhoneLink) filtered = filtered.filter((thread) => Boolean(thread.phoneNumber || thread.canonicalE164))
  if (params.dncOptOut) filtered = filtered.filter((thread) => Boolean(thread.isOptOut) || thread.inboxStatus === 'suppressed')

  if (params.startDate) {
    const start = new Date(params.startDate).getTime()
    filtered = filtered.filter((thread) => new Date(thread.lastMessageAt).getTime() >= start)
  }
  if (params.endDate) {
    const end = new Date(params.endDate).getTime()
    filtered = filtered.filter((thread) => new Date(thread.lastMessageAt).getTime() <= end)
  }

  if (params.search) {
    const query = params.search
    filtered = filtered.filter((thread) => matchesSearch(thread, query))
  }

  filtered.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
    if (!a.isRead && b.isRead) return -1
    if (!b.isRead && a.isRead) return 1
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  })

  return filtered
}

export const fetchThreadQueueState = async (thread: InboxThread): Promise<AnyRecord[]> => {
  const supabase = getSupabaseClient()
  let query = supabase.from('send_queue').select('*').limit(50)

  const filters = buildMessageEventFilter(thread)
  query = query.or(filters
    .replaceAll('from_phone_number', 'to_phone_number')
    .replaceAll('message_event_key', 'queue_key'))

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) {
    if (DEV) console.warn('[inboxWorkflow] fetchThreadQueueState failed', error.message)
    return []
  }
  return safeArray(data as AnyRecord[])
}

export const fetchThreadSentMessages = async (thread: InboxThread): Promise<SentMessageItem[]> => {
  const messages = await getThreadMessagesForThread(thread)
  return messages
    .filter((msg) => msg.direction === 'outbound')
    .map((msg) => ({
      id: msg.id,
      threadKey: toThreadKey(thread),
      body: msg.body,
      recipientNumber: msg.toNumber,
      fromNumber: msg.fromNumber,
      providerMessageId: null,
      sentAt: msg.createdAt,
      deliveryStatus: msg.deliveryStatus,
      providerDeliveryStatus: null,
      deliveryConfirmed: ['delivered', 'confirmed'].includes(normalizeStatus(msg.deliveryStatus)),
      failedReason: msg.error,
      ownerName: thread.ownerName,
      propertyAddress: thread.subject,
    }))
}

export const deriveThreadStateFromEvents = (events: AnyRecord[], queueRows: AnyRecord[]): Partial<InboxThreadWorkflow> => {
  const sorted = [...events].sort((a, b) => {
    const aTs = asIso(a['event_timestamp'] ?? a['created_at']) ?? ''
    const bTs = asIso(b['event_timestamp'] ?? b['created_at']) ?? ''
    return new Date(bTs).getTime() - new Date(aTs).getTime()
  })
  const last = sorted[0] ?? null
  const latestInbound = sorted.find((row) => normalizeStatus(row['direction']) === 'inbound')
  const latestOutbound = sorted.find((row) => normalizeStatus(row['direction']) === 'outbound')
  const queue = queueRows[0] ?? null

  const lastInboundAt = asIso(latestInbound?.['event_timestamp'] ?? latestInbound?.['created_at']) ?? null
  const lastOutboundAt = asIso(latestOutbound?.['event_timestamp'] ?? latestOutbound?.['created_at']) ?? null
  
  // Mock thread for inference
  const mockThread: any = {
    isArchived: normalizeStatus(last?.['status']) === 'archived',
    isOptOut: asBoolean(last?.['is_opt_out'], false),
    lastInboundAt,
    lastOutboundAt,
    directionUsed: normalizeStatus(last?.['direction'])
  }

  const inboxStatus = inferInboxStatus(mockThread, queue)
  const conversationStage = inferSellerStage(mockThread)

  return {
    inboxStatus,
    conversationStage,
    inboxStage: conversationStage,
    lastInboundAt,
    lastOutboundAt,
    lastDirection: normalizeMessageDirection(last ?? {}),
    lastMessageAt: asIso(last?.['event_timestamp'] ?? last?.['created_at']) ?? new Date().toISOString(),
    lastMessageBody: asString(last?.['message_body'], ''),
    updatedAt: asIso(last?.['updated_at'] ?? last?.['created_at']) ?? new Date().toISOString(),
  }
}

export const getThreadWorkflowState = async (thread: InboxThread): Promise<InboxThreadWorkflow> => {
  const queueRows = await fetchThreadQueueState(thread)
  const messages = await getThreadMessagesForThread(thread)
  const inferred = deriveThreadStateFromEvents(
    messages.map((msg) => ({
      direction: msg.direction,
      event_timestamp: msg.createdAt,
      created_at: msg.createdAt,
      message_body: msg.body,
      delivery_status: msg.deliveryStatus,
      error_message: msg.error,
    })),
    queueRows,
  )

  return {
    threadKey: toThreadKey(thread),
    inboxStatus: inferred.inboxStatus ?? 'needs_review',
    conversationStage: inferred.conversationStage ?? 'ownership_check',
    inboxStage: inferred.conversationStage ?? 'ownership_check',
    automationState: getAutomationState(thread),
    nextSystemAction: getNextSystemAction(inferred.inboxStatus ?? 'needs_review'),
    isArchived: (inferred.inboxStatus as InboxStatus) === 'closed',
    isRead: !thread.unread,
    isPinned: false,
    isStarred: false,
    isHidden: false,
    isSuppressed: false,
    priority: thread.priority,
    lastInboundAt: inferred.lastInboundAt ?? thread.lastInboundAt ?? null,
    lastOutboundAt: inferred.lastOutboundAt ?? thread.lastOutboundAt ?? null,
    lastMessageAt: inferred.lastMessageAt ?? thread.lastMessageIso,
    lastMessageBody: inferred.lastMessageBody ?? thread.preview,
    lastDirection: inferred.lastDirection ?? 'unknown',
    updatedAt: inferred.updatedAt ?? thread.lastMessageIso,
    queueStatus: normalizeStatus(queueRows[0]?.['queue_status'] ?? queueRows[0]?.['status']) || null,
  }
}

export const persistWorkflowPatch = async (
  thread: InboxThread,
  patch: Partial<Pick<InboxThreadWorkflow, 'inboxStatus' | 'conversationStage' | 'isArchived' | 'isRead' | 'isPinned' | 'isStarred' | 'isHidden' | 'isSuppressed' | 'priority'>> & { isHotLead?: boolean; automationState?: AutomationState },

): Promise<WorkflowMutationResult> => {
  const threadKey = toThreadKey(thread)
  
  if (DEV) {
    console.log(`[NexusWorkflowStatus]`, {
      thread_key: threadKey.slice(-8),
      patch,
      action: 'persist_start'
    })
  }

  if (await tableExists('operator_thread_state')) {
    const payload: AnyRecord = {}
    if (patch.inboxStatus) payload['inbox_bucket'] = patch.inboxStatus === 'closed' ? 'all' : patch.inboxStatus
    if (patch.conversationStage) {
      payload['seller_stage'] = patch.conversationStage
      payload['conversation_stage'] = patch.conversationStage
    }
    if (patch.priority) {
      payload['lead_temperature'] = patch.priority === 'urgent' ? 'hot' : patch.priority === 'high' ? 'warm' : 'cold'
    }
    if (patch.isSuppressed != null) {
      payload['suppression_status'] = patch.isSuppressed ? 'suppressed' : null
    }

    const result = await backendClient.updateThreadState(threadKey, payload)
    if (result.ok) {
      return { ok: true, writeTarget: 'operator_thread_state', errorMessage: null, threadKey, mutationPayload: payload }
    }
    return { ok: false, writeTarget: 'none', errorMessage: result.message, threadKey, mutationPayload: payload }
  }

  return {
    ok: false,
    writeTarget: 'none',
    errorMessage: 'operator_thread_state table missing. Run the Inbox thread-state migration.',
    threadKey,
    mutationPayload: null,
  }
}

export const fetchInboxThreads = async (params: InboxThreadsQuery = {}): Promise<InboxWorkflowThread[]> => {
  const { threads: base } = await getInboxThreads({ query: params.search })
  const supabase = getSupabaseClient()

  const stateRowsByKey = new Map<string, AnyRecord>()
  if (await tableExists('operator_thread_state')) {
    const keys = base.map((thread) => toThreadKey(thread)).filter(Boolean)
    if (keys.length > 0) {
      const stateResponses = await Promise.all(
        chunk(keys, 40).map((keyBatch) => (
          supabase
            .from('operator_thread_state')
            .select('thread_key,stage,status,priority,is_archived,is_read,is_pinned,is_starred,is_hidden,is_suppressed,last_read_at,archived_at,updated_at,metadata')
            .in('thread_key', keyBatch)
        )),
      )
      for (const response of stateResponses) {
        if (!response.error) {
          for (const row of safeArray(response.data as AnyRecord[])) {
            const key = asString(row['thread_key'], '')
            if (key) stateRowsByKey.set(key, row)
          }
        } else if (DEV) {
          console.warn('[inboxWorkflow] operator_thread_state read failed', getSupabaseErrorMessage(response.error))
        }
      }
    }
  }

  const { data: queueData, error: queueError } = await supabase
    .from('send_queue')
    .select('id,queue_status,status,scheduled_for,to_phone_number,phone_number,master_owner_id,prospect_id,property_id,created_at,updated_at,error_message,failure_reason')
    .order('created_at', { ascending: false })
    .limit(2500)

  if (queueError && DEV) {
    console.warn('[inboxWorkflow] send_queue read failed', getSupabaseErrorMessage(queueError))
  }

  const queueRows = safeArray(queueData as AnyRecord[])

  const enriched = base.map((thread) => withWorkflowState(thread, stateRowsByKey.get(toThreadKey(thread)) ?? null, queueStateForThread(thread, queueRows)))
  return applyThreadFilters(enriched, params)
}

export const fetchArchivedThreads = async (params: InboxThreadsQuery = {}): Promise<InboxWorkflowThread[]> => {
  return fetchInboxThreads({ ...params, tab: 'archived' })
}

export const fetchSentMessages = async (params: InboxThreadsQuery = {}): Promise<SentMessageItem[]> => {
  const supabase = getSupabaseClient()

  const eventData: AnyRecord[] = []
  let eventFrom = 0
  while (true) {
    const eventTo = eventFrom + SENT_MESSAGES_PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('message_events')
      .select('id,message_body,to_phone_number,from_phone_number,provider_message_sid,provider_message_id,event_timestamp,created_at,sent_at,delivery_status,provider_delivery_status,error_message,failure_reason,master_owner_id,property_id,property_address')
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .range(eventFrom, eventTo)
    if (error) throw new Error(mapErrorMessage(error))
    const batch = safeArray(data as AnyRecord[])
    if (batch.length === 0) break
    eventData.push(...batch)
    if (batch.length < SENT_MESSAGES_PAGE_SIZE) break
    eventFrom += batch.length
  }

  const queueData: AnyRecord[] = []
  let queueFrom = 0
  while (true) {
    const queueTo = queueFrom + SENT_MESSAGES_PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('send_queue')
      .select('id,message_body,to_phone_number,from_phone_number,provider_message_id,created_at,sent_at,queue_status,status,error_message,failure_reason,master_owner_id,property_id,property_address')
      .in('queue_status', ['sent', 'delivered', 'queued', 'scheduled', 'failed'])
      .order('created_at', { ascending: false })
      .range(queueFrom, queueTo)
    if (error) throw new Error(mapErrorMessage(error))
    const batch = safeArray(data as AnyRecord[])
    if (batch.length === 0) break
    queueData.push(...batch)
    if (batch.length < SENT_MESSAGES_PAGE_SIZE) break
    queueFrom += batch.length
  }

  const rows: SentMessageItem[] = []

  for (const row of eventData) {
    const sentAt = asIso(row['sent_at'] ?? row['event_timestamp'] ?? row['created_at']) ?? new Date().toISOString()
    rows.push({
      id: asString(row['id'], sentAt),
      threadKey: [row['master_owner_id'], row['property_id'], normalizePhone(row['to_phone_number'])].filter(Boolean).join(':'),
      body: asString(row['message_body'], ''),
      recipientNumber: normalizePhone(row['to_phone_number']),
      fromNumber: normalizePhone(row['from_phone_number']),
      providerMessageId: asString(row['provider_message_id'] ?? row['provider_message_sid'], '') || null,
      sentAt,
      deliveryStatus: asString(row['delivery_status'], 'sent'),
      providerDeliveryStatus: asString(row['provider_delivery_status'], '') || null,
      deliveryConfirmed: ['delivered', 'confirmed'].includes(normalizeStatus(row['delivery_status'] ?? row['provider_delivery_status'])),
      failedReason: asString(row['failure_reason'] ?? row['error_message'], '') || null,
      ownerName: '',
      propertyAddress: asString(row['property_address'], ''),
    })
  }

  for (const row of queueData) {
    const sentAt = asIso(row['sent_at'] ?? row['created_at']) ?? new Date().toISOString()
    rows.push({
      id: `queue:${asString(row['id'], sentAt)}`,
      threadKey: [row['master_owner_id'], row['property_id'], normalizePhone(row['to_phone_number'])].filter(Boolean).join(':'),
      body: asString(row['message_body'], ''),
      recipientNumber: normalizePhone(row['to_phone_number']),
      fromNumber: normalizePhone(row['from_phone_number']),
      providerMessageId: asString(row['provider_message_id'], '') || null,
      sentAt,
      deliveryStatus: asString(row['queue_status'] ?? row['status'], 'queued'),
      providerDeliveryStatus: null,
      deliveryConfirmed: ['sent', 'delivered'].includes(normalizeStatus(row['queue_status'] ?? row['status'])),
      failedReason: asString(row['failure_reason'] ?? row['error_message'], '') || null,
      ownerName: '',
      propertyAddress: asString(row['property_address'], ''),
    })
  }

  const filtered = rows.filter((row) => {
    if (params.search) {
      const q = params.search.toLowerCase()
      const hay = [row.body, row.recipientNumber, row.fromNumber, row.propertyAddress].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (params.startDate && new Date(row.sentAt).getTime() < new Date(params.startDate).getTime()) return false
    if (params.endDate && new Date(row.sentAt).getTime() > new Date(params.endDate).getTime()) return false
    return true
  })

  filtered.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
  return filtered
}

export const updateThreadStage = async (thread: InboxThread, stage: SellerStage): Promise<WorkflowMutationResult> => {
  const patch: Partial<InboxThreadWorkflow> = { conversationStage: stage }
  if (stage === 'dead_suppressed') {
    patch.inboxStatus = 'suppressed'
    patch.isSuppressed = true
  }
  const result = await persistWorkflowPatch(thread, patch as any)
  
  if (result.ok) {
    void logInboxActivity({
      event_type: 'stage_change',
      thread_key: result.threadKey,
      actor: 'operator',
      title: 'Seller Stage Updated',
      description: `Seller moved to ${stage.replace(/_/g, ' ')}`,
      metadata: { old_stage: (thread as any).conversationStage, new_stage: stage },
      undo_payload: { thread_key: result.threadKey, stage: (thread as any).conversationStage },
    })
  }
  
  return result
}

export const updateThreadStatus = async (thread: InboxThread, status: InboxStatus): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { inboxStatus: status })
}

export const updateThreadPriority = async (thread: InboxThread, priority: InboxPriority): Promise<WorkflowMutationResult> => {
  const result = await persistWorkflowPatch(thread, { priority })
  if (result.ok) {
    void logInboxActivity({
      event_type: 'priority_change' as any,
      thread_key: result.threadKey,
      actor: 'operator',
      title: 'Priority Changed',
      description: `Set priority to ${priority}`,
      metadata: { old_priority: thread.priority, new_priority: priority },
      undo_payload: { thread_key: result.threadKey, priority: thread.priority },
    })
  }
  return result
}

export const archiveThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  const result = await persistWorkflowPatch(thread, { isArchived: true, inboxStatus: 'closed' })
  if (result.ok) {
    void logInboxActivity({
      event_type: 'archive_thread',
      thread_key: result.threadKey,
      actor: 'operator',
      title: 'Thread Archived',
      description: `Archived thread for ${thread.ownerName}`,
      metadata: { owner_name: thread.ownerName },
      undo_payload: { thread_key: result.threadKey, action: 'unarchive' },
    })
  }
  return result
}

export const unarchiveThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  const lastIn = thread.lastInboundAt ? new Date(thread.lastInboundAt).getTime() : 0
  const lastOut = thread.lastOutboundAt ? new Date(thread.lastOutboundAt).getTime() : 0
  const needsResponse = lastIn > lastOut
  return persistWorkflowPatch(thread, {
    isArchived: false,
    inboxStatus: needsResponse ? 'new_reply' : 'waiting',
  })
}

export const markThreadRead = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isRead: true })
}

export const markThreadUnread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isRead: false })
}

export const pinThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isPinned: true })
}

export const unpinThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isPinned: false })
}

export const starThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isStarred: true })
}

export const unstarThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isStarred: false })
}

export const hideThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isHidden: true })
}

export const unhideThread = async (thread: InboxWorkflowThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isHidden: false })
}

export const suppressThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isSuppressed: true, inboxStatus: 'suppressed', conversationStage: 'dead_suppressed' })
}

export const approveQueueItem = async (queueId: string, thread: InboxThread): Promise<WorkflowMutationResult> => {
  const threadKey = toThreadKey(thread)

  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.approveQueueItem(queueId)
  if (!result.ok) return { ok: false, writeTarget: 'none', errorMessage: result.message, threadKey, mutationPayload: null }

  await persistWorkflowPatch(thread, { inboxStatus: 'queued' })
  
  await logInboxActivity({
    event_type: 'message_sent',
    thread_key: threadKey,
    actor: 'Operator',
    title: 'Draft Approved',
    description: 'Manual approval of queued reply.',
    metadata: { queue_id: queueId },
    undo_payload: null
  })

  return { ok: true, writeTarget: 'operator_thread_state', errorMessage: null, threadKey, mutationPayload: { status: 'queued' } }
}

export const cancelQueueItem = async (queueId: string, thread: InboxThread): Promise<WorkflowMutationResult> => {
  const threadKey = toThreadKey(thread)

  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.cancelQueueItem(queueId)
  if (!result.ok) return { ok: false, writeTarget: 'none', errorMessage: result.message, threadKey, mutationPayload: null }

  await persistWorkflowPatch(thread, { inboxStatus: 'waiting' })
  
  await logInboxActivity({
    event_type: 'stage_change',
    thread_key: threadKey,
    actor: 'Operator',
    title: 'Draft Cancelled',
    description: 'Manual deletion of queued draft.',
    metadata: { queue_id: queueId },
    undo_payload: null
  })

  return { ok: true, writeTarget: 'operator_thread_state', errorMessage: null, threadKey, mutationPayload: { status: 'waiting' } }
}
export const unsuppressThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isSuppressed: false, inboxStatus: 'needs_review' })
}

export const markThreadHot = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { isHotLead: true, priority: 'high' } as any)
}

export const snoozeThread = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { inboxStatus: 'waiting' })
}

export const pauseAutomation = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { automationState: 'paused' } as any)
}

export const resumeAutomation = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  return persistWorkflowPatch(thread, { automationState: 'active' } as any)
}

export const retryFailedSend = async (thread: InboxThread): Promise<WorkflowMutationResult> => {
  const supabase = getSupabaseClient()
  const threadKey = toThreadKey(thread)

  // Find last failed queue item (read-only SELECT is allowed)
  const { data } = await supabase
    .from('send_queue')
    .select('id')
    .eq('queue_key', threadKey)
    .eq('queue_status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)

  if (data && data.length > 0) {
    // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
    const result = await backendClient.retryQueueItem(String(data[0].id))
    if (result.ok) return { ok: true, writeTarget: 'none', errorMessage: null, threadKey, mutationPayload: { action: 'retry_queued' } }
    return { ok: false, writeTarget: 'none', errorMessage: result.message, threadKey, mutationPayload: null }
  }

  return { ok: false, writeTarget: 'none', errorMessage: 'No failed messages found to retry.', threadKey, mutationPayload: null }
}
