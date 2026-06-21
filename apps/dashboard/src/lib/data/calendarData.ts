import type { InboxWorkflowThread } from './inboxWorkflowData'
import { fetchCalendarNexus } from '../calendar/calendar-api'
import { dayRangeIso, monthRangeIso, weekRangeIso } from '../calendar/calendar-date-engine'
import type { CalendarLayerId } from '../calendar/calendar-layers'
import { getSupabaseClient } from '../supabaseClient'
import { asBoolean, asIso, asString, getFirst, mapErrorMessage, normalizeStatus, safeArray, type AnyRecord } from './shared'

export type CalendarViewMode = 'day' | 'week' | 'month' | 'agenda' | 'timeline'
export type CalendarScopeMode = 'global' | 'selected'
export type CalendarEventTone = 'blue' | 'cyan' | 'green' | 'amber' | 'red' | 'purple' | 'gold' | 'gray' | 'violet' | 'teal' | 'emerald' | 'pink'
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
  | 'workflow_wake'
  | 'workflow_task'
  | 'workflow_blocked'
  | 'campaign_scheduled'
  | 'pipeline_next_action'
  | 'manual_call'
  | 'manual_meeting'
  | 'manual_visit'
  | 'manual_task'
  | 'manual_reminder'
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
  layers?: CalendarLayerId[]
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
  sourceDomain?: string
  status: string
  market: string
  state: string
  sellerName: string
  propertyAddress: string
  propertyId: string | null
  sellerId: string | null
  threadId: string | null
  opportunityId?: string | null
  priority: string
  actor: string
  actionLabel?: string
  metadata?: Record<string, unknown>
  overdue: boolean
  dueSoon: boolean
  hot: boolean
  automationBlocked: boolean
  allDay?: boolean
  timezone?: string
  reschedulable?: boolean
  cancellable?: boolean
  editable?: boolean
  readOnlyReason?: string | null
  correlationId?: string | null
  resolutionSource?: string | null
  unresolvedReason?: string | null
  deepLinkContext?: Record<string, string | null>
  riskState?: string
  layer?: string
  category?: string
  sourceRecordId?: string | null
}

export type ExecutionSummaryCard = {
  id: string
  label: string
  value: number
  tone: CalendarEventTone
}

export type CalendarLoadMeta = {
  reconciliation?: Record<string, number>
  sourceCounts?: Record<string, number>
  performance?: Record<string, unknown>
  synchronizedAt?: string
  error?: string | null
}

let lastLoadMeta: CalendarLoadMeta = {}

export function getLastCalendarLoadMeta() {
  return lastLoadMeta
}

function mapApiEvent(row: AnyRecord): CalendarEvent {
  const type = asString(row.event_type, 'historical_event') as CalendarEventType
  const tone = asString(row.tone, 'gray') as CalendarEventTone
  return {
    id: asString(row.event_id, ''),
    type,
    tone,
    title: asString(row.title, 'Event'),
    description: asString(row.description, ''),
    timestamp: asString(row.start_timestamp, new Date().toISOString()),
    endTimestamp: asIso(row.end_timestamp),
    sourceTable: asString(row.source_table, 'unknown'),
    sourceDomain: asString(row.source_domain, ''),
    status: asString(row.status, 'scheduled'),
    market: asString(row.market, 'Market Unknown'),
    state: asString(row.state, '—'),
    sellerName: asString(row.seller_name, 'Unknown Seller'),
    propertyAddress: asString(row.property_address, 'Property Unknown'),
    propertyId: asString(row.property_id, '') || null,
    sellerId: asString(row.master_owner_id, '') || null,
    threadId: asString(row.thread_key, '') || null,
    opportunityId: asString(row.opportunity_id, '') || null,
    priority: asString(row.priority, 'normal'),
    actor: asString(row.actor, 'System'),
    actionLabel: asString(row.action_label, ''),
    metadata: (row.metadata as Record<string, unknown>) || {},
    overdue: Boolean(row.overdue),
    dueSoon: Boolean(row.due_soon),
    hot: Boolean(row.hot),
    automationBlocked: type === 'automation_blocked' || type === 'workflow_blocked',
    allDay: Boolean(row.all_day),
    timezone: asString(row.timezone, 'UTC'),
    reschedulable: Boolean(row.reschedulable),
    cancellable: Boolean(row.cancellable),
    editable: Boolean(row.editable),
    readOnlyReason: asString(row.read_only_reason, '') || null,
    correlationId: asString(row.correlation_id, '') || null,
    resolutionSource: asString(row.resolution_source, '') || null,
    unresolvedReason: asString(row.unresolved_reason, '') || null,
    deepLinkContext: (row.deep_link_context as Record<string, string | null>) || {},
    riskState: asString(row.risk_state, ''),
    layer: asString(row.layer, ''),
    category: asString(row.category, ''),
    sourceRecordId: asString(row.source_record_id, '') || null,
  }
}

async function loadFromNexus(filters: CalendarFilters): Promise<CalendarEvent[]> {
  const startDate = filters.startDate || new Date(0).toISOString()
  const endDate = filters.endDate || new Date('2099-12-31').toISOString()
  const response = await fetchCalendarNexus({
    startDate,
    endDate,
    sellerId: filters.sellerId,
    propertyId: filters.propertyId,
    threadId: filters.threadId,
    market: filters.market,
    layers: filters.layers,
    overdueOnly: filters.overdueOnly,
  })
  lastLoadMeta = {
    reconciliation: response.reconciliation,
    sourceCounts: response.source_counts,
    performance: response.performance,
    synchronizedAt: response.synchronized_at,
    error: null,
  }
  return (response.events || []).map((event) => mapApiEvent(event as unknown as AnyRecord))
}

// Client-side fallback retained for offline/dev when API unavailable.
const HOUR_MS = 3600000
const DATA_LIMIT = 2000

const safeSelect = async (table: string, columns = '*', limit = DATA_LIMIT): Promise<AnyRecord[]> => {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from(table).select(columns).limit(limit)
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

const isOverdue = (iso: string, status: string, type: string) => {
  const normalized = normalizeStatus(status)
  if (['delivered', 'sent', 'completed', 'executed', 'closed', 'clear_to_close', 'signed'].includes(normalized)) return false
  if (['sms_sent', 'sms_delivered', 'inbound_reply', 'positive_intent'].includes(type)) return false
  return new Date(iso).getTime() < Date.now()
}

const isDueSoon = (iso: string) => {
  const ts = new Date(iso).getTime()
  return Number.isFinite(ts) && ts >= Date.now() && ts - Date.now() <= 36 * HOUR_MS
}

const makeEvent = (partial: Omit<CalendarEvent, 'overdue' | 'dueSoon'>): CalendarEvent => ({
  ...partial,
  overdue: isOverdue(partial.timestamp, partial.status, partial.type),
  dueSoon: isDueSoon(partial.timestamp),
})

async function loadClientFallback(filters: CalendarFilters): Promise<CalendarEvent[]> {
  const [sendQueue, messageEvents] = await Promise.all([
    safeSelect('send_queue'),
    safeSelect('message_events'),
  ])
  const indexes = new Map<string, InboxWorkflowThread>()
  for (const thread of filters.threads ?? []) {
    if (thread.id) indexes.set(thread.id, thread)
    if (thread.threadKey) indexes.set(thread.threadKey, thread)
  }
  const events: CalendarEvent[] = []
  for (const row of sendQueue) {
    const ts = asIso(getFirst(row, ['scheduled_for', 'sent_at', 'created_at']))
    if (!ts) continue
    const thread = indexes.get(asString(getFirst(row, ['thread_key']), ''))
    events.push(makeEvent({
      id: `queue:${asString(row.id, '')}`,
      type: 'scheduled_sms',
      tone: 'blue',
      title: 'Scheduled SMS',
      description: asString(row.message_body, 'Queue event'),
      timestamp: ts,
      sourceTable: 'send_queue',
      status: asString(row.queue_status, 'scheduled'),
      market: asString(thread?.market, 'Market Unknown'),
      state: '—',
      sellerName: asString(thread?.ownerDisplayName || thread?.ownerName, 'Unresolved Queue Recipient'),
      propertyAddress: asString(thread?.propertyAddress, 'Property Unknown'),
      propertyId: asString(thread?.propertyId, '') || null,
      sellerId: asString(thread?.ownerId, '') || null,
      threadId: thread?.id || null,
      priority: 'normal',
      actor: 'System',
      hot: false,
      automationBlocked: false,
      reschedulable: true,
    }))
  }
  for (const row of messageEvents.slice(0, 200)) {
    const ts = asIso(getFirst(row, ['created_at', 'sent_at']))
    if (!ts) continue
    events.push(makeEvent({
      id: `msg:${asString(row.id, '')}`,
      type: 'sms_sent',
      tone: 'green',
      title: 'SMS Sent',
      description: asString(row.message_body, 'Message'),
      timestamp: ts,
      sourceTable: 'message_events',
      status: 'sent',
      market: 'Market Unknown',
      state: '—',
      sellerName: 'Unknown Seller',
      propertyAddress: 'Property Unknown',
      propertyId: null,
      sellerId: null,
      threadId: null,
      priority: 'normal',
      actor: 'System',
      hot: false,
      automationBlocked: false,
    }))
  }
  return events
    .filter((event) => {
      if (filters.sellerId && event.sellerId !== filters.sellerId) return false
      if (filters.propertyId && event.propertyId !== filters.propertyId) return false
      if (filters.threadId && event.threadId !== filters.threadId) return false
      if (filters.overdueOnly && !event.overdue) return false
      return true
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(0, filters.limit ?? 500)
}

export const loadCalendarEvents = async (filters: CalendarFilters = {}): Promise<CalendarEvent[]> => {
  try {
    return await loadFromNexus(filters)
  } catch (error) {
    console.warn('[calendarData] nexus API unavailable, using client fallback', error)
    lastLoadMeta = { error: error instanceof Error ? error.message : 'calendar_api_unavailable' }
    return loadClientFallback(filters)
  }
}

export const loadDailyCalendar = async (date: string, filters: CalendarFilters = {}) => {
  const anchor = new Date(date)
  const range = dayRangeIso(anchor)
  return loadCalendarEvents({ ...filters, startDate: range.startIso, endDate: range.endIso })
}

export const loadWeeklyCalendar = async (startDate: string, filters: CalendarFilters = {}) => {
  const range = weekRangeIso(new Date(startDate))
  return loadCalendarEvents({ ...filters, startDate: range.startIso, endDate: range.endIso })
}

export const loadMonthCalendar = async (anchorDate: string, filters: CalendarFilters = {}) => {
  const range = monthRangeIso(new Date(anchorDate))
  return loadCalendarEvents({ ...filters, startDate: range.startIso, endDate: range.endIso })
}

/** @deprecated use loadMonthCalendar */
export const loadThirtyDayCalendar = loadMonthCalendar

export const loadGlobalExecutionTimeline = async (filters: CalendarFilters = {}) => {
  const start = new Date()
  start.setDate(start.getDate() - 30)
  const end = new Date()
  end.setDate(end.getDate() + 90)
  return loadCalendarEvents({ ...filters, startDate: start.toISOString(), endDate: end.toISOString(), limit: 700 })
}

export const loadSelectedSellerTimeline = async (sellerId: string, propertyId?: string, threads?: InboxWorkflowThread[]) =>
  loadCalendarEvents({ sellerId, propertyId, threads, limit: 700 })

export const loadTodayExecutionSummary = async (filters: CalendarFilters = {}): Promise<ExecutionSummaryCard[]> => {
  const range = dayRangeIso(new Date())
  try {
    const response = await fetchCalendarNexus({
      startDate: range.startIso,
      endDate: range.endIso,
      sellerId: filters.sellerId,
      propertyId: filters.propertyId,
      threadId: filters.threadId,
      layers: filters.layers,
    })
    return response.kpis
  } catch {
    const events = await loadDailyCalendar(new Date().toISOString(), filters)
    const count = (predicate: (event: CalendarEvent) => boolean) => events.filter(predicate).length
    return [
      { id: 'due-today', label: 'Due Today', value: events.length, tone: 'blue' },
      { id: 'overdue', label: 'Overdue', value: count((e) => e.overdue), tone: 'red' },
      { id: 'seller-replies', label: 'Seller Replies', value: count((e) => ['inbound_reply', 'seller_reply_needs_action', 'positive_intent'].includes(e.type)), tone: 'cyan' },
      { id: 'scheduled-sms', label: 'Scheduled SMS', value: count((e) => e.type === 'scheduled_sms'), tone: 'blue' },
      { id: 'workflow-wakes', label: 'Workflow Wakes', value: count((e) => ['workflow_wake', 'workflow_task'].includes(e.type)), tone: 'violet' },
      { id: 'offers-due', label: 'Offers Due', value: count((e) => ['offer_follow_up', 'offer_expiration'].includes(e.type)), tone: 'gold' },
      { id: 'contracts-awaiting', label: 'Contracts Awaiting', value: count((e) => e.type === 'contract_signature_deadline'), tone: 'purple' },
      { id: 'title-milestones', label: 'Title Milestones', value: count((e) => ['title_opened', 'title_milestone', 'clear_to_close'].includes(e.type)), tone: 'gold' },
      { id: 'buyer-follow-ups', label: 'Buyer Follow-Ups', value: count((e) => e.type === 'buyer_follow_up'), tone: 'amber' },
      { id: 'closings', label: 'Closings', value: count((e) => e.type === 'closing_scheduled'), tone: 'gold' },
    ]
  }
}

export const loadOverdueExecutionItems = async (filters: CalendarFilters = {}) =>
  loadCalendarEvents({ ...filters, overdueOnly: true, limit: 80 })

export const loadAutomationSchedule = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) =>
    ['scheduled_sms', 'seller_follow_up', 'automation_blocked', 'queue_retry', 'workflow_wake', 'workflow_task'].includes(event.type))
}

export const loadClosingDeadlines = async (filters: CalendarFilters = {}) => {
  const events = await loadCalendarEvents({ ...filters, limit: 200 })
  return events.filter((event) => ['title_opened', 'title_milestone', 'clear_to_close', 'closing_scheduled'].includes(event.type))
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
  if (mode === 'day') return anchor.toISOString().slice(0, 10)
  if (mode === 'week') {
    const range = weekRangeIso(anchor)
    return `${range.startIso.slice(0, 10)} → ${range.endIso.slice(0, 10)}`
  }
  if (mode === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  if (mode === 'agenda') return 'Agenda'
  return 'Execution Timeline'
}