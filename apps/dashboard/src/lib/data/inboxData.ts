import { formatRelativeTime } from '../../shared/formatters'
import type { InboxModel, InboxThread } from '../../modules/inbox/inbox.adapter'
import type { InboxViewSelectValue } from '../../modules/inbox/inbox-ui-helpers'
import type { InboxWorkflowThread } from './inboxWorkflowData'
import type { SmsTemplate } from './templateData'
import { resolveOutboundTextgridNumber } from './textgridRouting'
import { getSupabaseClient, hasSupabaseEnv } from '../supabaseClient'
import * as backendClient from '../api/backendClient'
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  getFirst,
  mapErrorMessage,
  normalizeStatus,
  safeArray,
  shouldUseSupabase,
  type AnyRecord,
} from './shared'
import { emitNotification } from '../../shared/NotificationToast'

/**
 * Confirmed message_events schema — direct column references used below:
 *   id, message_event_key, provider_message_sid
 *   direction, event_type, message_body
 *   from_phone_number  — sender (seller for inbound, our number for outbound)
 *   to_phone_number    — recipient (our number for inbound, seller for outbound)
 *   phone_number_id, queue_id, conversation_brain_id
 *   metadata (jsonb — may contain payload.from/to/raw.From/To/Body/SmsStatus)
 *   event_timestamp, created_at, sent_at, received_at, delivered_at, failed_at
 *   error_message, property_address, message_id
 *   master_owner_id, prospect_id, property_id
 *   textgrid_number_id, sms_agent_id, template_id
 *   market_id, ai_route, source_app
 *   delivery_status, raw_carrier_status, provider_delivery_status
 *   is_final_failure, failure_bucket, failure_code, failure_reason
 *   is_opt_out, opt_out_keyword, opt_out_message
 *   stage_before, stage_after, podio_sync_status
 *
 * Thread identity: group by sellerPhone (from_phone_number for inbound,
 *   to_phone_number for outbound) + property_id / master_owner_id.
 * Do NOT use provider_message_sid or message_event_key as thread key.
 */

export type InboxSourceMode = 'conversations' | 'all_sellers'

export interface InboxThreadFilters {
  status?: 'all' | 'unread' | 'read' | 'replied' | 'archived'
  priority?: 'all' | 'urgent' | 'high' | 'normal' | 'low'
  query?: string
  view?: string
  stage?: string
  advanced?: Record<string, any>
}

export interface InboxFetchOptions {
  signal?: AbortSignal
  maxRows?: number
  offset?: number
  cursor?: string | null
  limit?: number
  map?: boolean
  filters?: InboxThreadFilters
  sourceMode?: InboxSourceMode
  /** @internal */
  _automatic?: boolean
}

export interface LiveInboxFetchParams {
  filter?: string
  direction?: 'inbound' | 'outbound' | 'all' | string
  q?: string
  keywordGroup?: string
  cursor?: string | null
  limit?: number
  map?: boolean
  signal?: AbortSignal
}

export interface LiveInboxPagination {
  cursor: string | null
  nextCursor: string | null
  hasMore: boolean
  limit: number
  total?: number | null
}

export interface LiveInboxMapPin {
  id: string
  threadKey: string
  lat: number
  lng: number
  status?: string
  stage?: string
  ownerName?: string
  propertyAddress?: string
  latestMessageBody?: string
}

export interface LiveInboxResponse {
  threads: InboxThread[]
  messages: ThreadMessage[]
  counts: Record<string, number | null | undefined>
  mapPins: LiveInboxMapPin[]
  pagination: LiveInboxPagination
}

export interface ThreadMessage {
  id: string
  threadKey?: string
  direction: 'inbound' | 'outbound' | 'unknown'
  body: string
  createdAt: string
  timelineAt: string
  sentAt?: string | null
  deliveredAt: string | null
  deliveryStatus: string
  deliveryStatusDisplay?: 'sent' | 'delivered' | 'failed'
  fromNumber: string
  toNumber: string
  ownerId: string
  prospectId: string
  propertyId: string
  phoneNumber: string
  canonicalE164: string
  templateId: string | null
  templateName: string | null
  agentId: string | null
  source: string
  rawStatus: string
  error: string | null
  eventType?: string
  metadata?: Record<string, unknown>
  developerMeta?: Record<string, string>
}

export interface ThreadContextDebug {
  resolvedPhoneTable: string | null
  resolvedMasterOwnerTable: string | null
  resolvedOwnerTable: string | null
  resolvedPropertyTable: string | null
  resolvedProspectTable: string | null
  matchedOwnerBy: string | null
  matchedProspectBy: string | null
  matchedPropertyBy: string | null
  matchedPhoneBy: string | null
  matchedPhoneRowId: string | null
  matchedEmailBy: string | null
  matchedAiBrainBy: string | null
  matchedQueueBy: string | null
  bridgedMasterOwnerId: string | null
  bridgedProspectId: string | null
  bridgedPropertyId: string | null
}

export interface ThreadContext {
  seller: { id: string; name: string; market: string } | null
  property: { id: string; address: string; market: string } | null
  phone: string | null
  contactStack: { type: string; value: string; status: string }[]
  dealContext: { stage: string; nextAction: string } | null
  aiContext: { summary: string; intent: string; sentiment: string } | null
  queueContext: { items: { id: string; status: string; scheduleAt: string | null }[] } | null
  contextMatchQuality: 'high' | 'medium' | 'low' | 'missing'
  contextDebug: ThreadContextDebug
}

export type ThreadIntelligenceRecord = Record<string, unknown>

export interface SuggestedDraft {
  text: string
  confidence: number | null
  reason: string | null
  source: 'ai_brain' | 'send_queue' | 'template' | 'placeholder'
}

export interface QueueReplyResult {
  ok: boolean
  queueId: string | null
  status: string | null
  errorMessage: string | null
  insertPayloadKeys: string[]
}

export interface ManualSendProof {
  requestPayload: Record<string, unknown>
  backendResponse: unknown
  queueRowInserted: boolean
  queueRowId: string | null
}

export interface SendNowResult {
  ok: boolean
  clientSendId?: string | null
  queueId: string | null
  messageEventId: string | null
  providerMessageSid: string | null
  deliveryStatus: string | null
  errorMessage: string | null
  guardReason?: string | null
  backendReason?: string | null
  hardBlock?: boolean
  operatorOverrideAllowed?: boolean
  insertPayloadKeys: string[]
  suppressionBlocked: boolean
  sendRouteUsed: 'provider_immediate' | 'send_queue_queued' | 'none'
  queueProcessorEligible: boolean
  proof?: ManualSendProof | null
}

interface InboxTemplateSendOptions {
  selectedTemplate?: SmsTemplate | null
  threadContext?: ThreadContext | null
}

interface InboxSendOptions extends InboxTemplateSendOptions {
  fromPhoneNumber?: string
  clientSendId?: string | null
  operatorOverride?: boolean
}

export interface QueueProcessorHealth {
  checkedAt: string
  queuedCount: number
  scheduledCount: number
  sendingCount: number
  sentTodayCount: number
  deliveredTodayCount: number
  failedTodayCount: number
  blockedCount: number
  pausedInvalidCount: number
  duplicateSkippedCount: number
  suppressionBlockedCount: number
  blankBodyBlockedCount: number
  routingBlockedCount: number
  repliedBeforeSendCount: number
  queuedOlderThanLagWindow: number
  oldestQueuedAt: string | null
  latestSentAt: string | null
  latestWebhookAt: string | null
  webhookHealthy: boolean
  processorHealthy: boolean
  status: 'healthy' | 'warning' | 'critical' | 'unknown'
  failedRate: number | null
  duplicateActiveCount: number
  activeBlankRowCount: number
  routingBlockedSpike: boolean
  liveAutopilotAllowed: boolean
  routingBlockedRows: Array<{
    id: string
    sellerName: string
    propertyAddress: string
    market: string
    reason: string
    queueStatus: string
  }>
  summary: string
  staleRowsCount?: number
  orphanedRowsCount?: number
  duplicateFingerprintCount?: number
  retriedGtOneCount?: number
  processingLockConflictCount?: number
}

const QUEUE_PROCESSOR_LAG_MINUTES = 10

const DEV = Boolean(import.meta.env?.DEV)
const MESSAGE_EVENTS_THREAD_PAGE_SIZE = 250
export const HYDRATED_INBOX_PAGE_SIZE = 100
export const HYDRATED_INBOX_THREADS_VIEW = 'v_universal_inbox_threads'
export const HYDRATED_INBOX_COUNTS_VIEW = 'inbox_category_counts'

export const INBOX_LIST_COLUMNS = [
  'thread_key', 'latest_message_at', 'latest_message_body', 'latest_direction',
  'unread_count', 'is_read', 'inbox_category', 'priority_bucket',
  'final_acquisition_score', 'priority_score', 'ui_intent', 'detected_intent',
  'stage', 'queue_stage', 'workflow_stage', 'is_archived',
  'prospect_full_name', 'prospect_name', 'first_name',
  'owner_display_name', 'owner_name', 'seller_display_name', 'seller_name',
  'property_address_full', 'property_address', 'filter_market', 'market',
  'property_type', 'property_class', 'queue_status', 'automation_state',
  'is_hot_lead', 'is_new_inbound', 'inbound_count', 'outbound_count',
  'language_preference', 'latitude', 'longitude',
  'is_pinned', 'is_starred', 'is_hidden', 'is_suppressed', 'is_dnc', 'has_opt_out',
  'show_in_priority_inbox', 'display_name', 'display_address', 'display_phone',
  'display_market', 'display_status', 'display_score',
  'seller_state', 'seller_status', 'execution_state', 'pipeline_stage',
  'master_owner_id', 'prospect_id', 'property_id', 'best_phone', 'seller_phone', 'canonical_e164', 'phone'
].join(',')

const HYDRATED_INBOX_CATEGORIES = [
  'hot_leads',
  'needs_review',
  'new_inbound',
  'automated',
  'outbound_active',
  'cold_no_response',
  'dnc_opt_out',
  'all_inbound',
  'not_contacted',
] as const

type HydratedInboxCategory = (typeof HYDRATED_INBOX_CATEGORIES)[number]

const HYDRATED_CATEGORY_BY_VIEW: Partial<Record<string, HydratedInboxCategory | HydratedInboxCategory[]>> = {
  positive_hot: 'hot_leads',
  manual_review: 'needs_review',
  needs_reply: 'new_inbound',
  auto_replied: 'automated',
  outbound_only: 'outbound_active',
  missing_context: 'cold_no_response',
  suppressed: 'dnc_opt_out',
  wrong_number: 'dnc_opt_out',
  opt_out: 'dnc_opt_out',
  priority: ['hot_leads', 'needs_review', 'new_inbound'],
  active: ['automated', 'outbound_active'],
  waiting: 'cold_no_response',
  not_contacted: 'not_contacted',
}

const HYDRATED_PRIORITY_CATEGORIES = new Set<HydratedInboxCategory>(['hot_leads', 'needs_review', 'new_inbound'])

const EMPTY_HYDRATED_CATEGORY_COUNTS: Record<HydratedInboxCategory | 'all' | 'all_inbound', number> = {
  hot_leads: 0,
  needs_review: 0,
  new_inbound: 0,
  automated: 0,
  outbound_active: 0,
  cold_no_response: 0,
  dnc_opt_out: 0,
  all_inbound: 0,
  not_contacted: 0,
  all: 0,
}

/** Values that map 1:1 to `nexus_inbox_threads_v.stage` / `inbox_thread_state.stage`. */
export const SERVER_INBOX_THREAD_STAGE_VALUES = new Set([
  'new_reply',
  'needs_response',
  'ai_draft_ready',
  'queued_reply',
  'sent_waiting',
  'interested',
  'needs_offer',
  'needs_call',
  'nurture',
  'not_interested',
  'wrong_number',
  'dnc_opt_out',
  'archived',
  'closed_converted',
])

export const formatDisplayPhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw.startsWith('+') ? raw : `+${digits}`
}

/**
 * Checks if a string looks like a raw E.164 phone number (e.g. +16127433952).
 * These are treated as poor display names if any real name field exists.
 */
const isRawE164 = (val: string): boolean => /^\+1\d{10}$/.test(val) || /^\+\d{10,15}$/.test(val)

export const resolveInboxSellerNameWithSource = (row: Record<string, unknown>): { value: string; source: string } => {
  const firstName = asString(row.first_name || row.firstName || row.seller_first_name || row.sellerFirstName || row.prospect_first_name || row.prospectFirstName)
  const lastName = asString(row.last_name || row.lastName || row.seller_last_name || row.sellerLastName || row.prospect_last_name || row.prospectLastName)
  const ownerFirstName = asString(row.owner_first_name || row.ownerFirstName)
  const ownerLastName = asString(row.owner_last_name || row.ownerLastName)

  let meta: Record<string, unknown> = (row.metadata || row.meta || {}) as Record<string, unknown>
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) as Record<string, unknown> } catch (e) { meta = {} }
  }

  const candidates: Array<{ val: unknown; source: string }> = [
    { val: row.owner_display_name || row.ownerDisplayName, source: 'owner_display_name' },
    { val: row.seller_display_name || row.sellerDisplayName, source: 'seller_display_name' },
    { val: row.seller_name || row.sellerName, source: 'seller_name' },
    { val: row.owner_name || row.ownerName, source: 'owner_name' },
    { val: row.prospect_full_name || row.prospectFullName, source: 'prospect_full_name' },
    { val: row.primary_owner_name || row.primaryOwnerName, source: 'primary_owner_name' },
    { val: row.contact_name || row.contactName, source: 'contact_name' },
    { val: firstName && lastName ? `${firstName} ${lastName}` : firstName || null, source: 'prospect_names' },
    { val: ownerFirstName && ownerLastName ? `${ownerFirstName} ${ownerLastName}` : ownerFirstName || null, source: 'owner_names' },
    { val: row.property_owner_name || row.propertyOwnerName, source: 'property_owner_name' },
    { val: row.prospect_cnam || row.prospectCnam, source: 'prospect_cnam' },
    { val: meta.owner_name || meta.ownerName || meta.seller_name || meta.contact_name, source: 'metadata_name' },
  ]

  for (const candidate of candidates) {
    const text = asString(candidate.val, '').trim()
    if (text && !isRawE164(text) && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'unknown seller') {
      return { value: text, source: candidate.source }
    }
  }

  // Final fallbacks
  const phoneRaw = asString(row.phoneNumber || row.phoneNumberId || row.canonicalE164 || row.seller_phone || row.phone || row.prospect_phone, '').trim()
  if (phoneRaw) {
    return { value: formatDisplayPhone(phoneRaw), source: 'phone_fallback' }
  }

  return { value: 'Unknown Seller', source: 'none' }
}

export const resolveInboxSellerName = (row: Record<string, unknown>): string => 
  resolveInboxSellerNameWithSource(row).value

export const resolveInboxPropertyAddressWithSource = (row: Record<string, unknown>): { value: string; source: string } => {
  const street = asString(row.property_address_street || row.street || row.address_line_1 || row.property_street)
  const city = asString(row.property_address_city || row.property_city || row.city || row.property_city)
  const state = asString(row.property_address_state || row.property_state || row.state || row.property_state)
  const zip = asString(row.property_address_zip || row.property_zip || row.zip || row.postal_code || row.property_zip)
  
  const combined = [street, city, state, zip].map(s => s.trim()).filter(Boolean).join(', ')
  let meta: Record<string, unknown> = (row.metadata || row.meta || {}) as Record<string, unknown>
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) as Record<string, unknown> } catch (e) { meta = {} }
  }

  const candidates: Array<{ val: unknown; source: string }> = [
    { val: row.property_address_full || row.propertyAddressFull, source: 'property_address_full' },
    { val: row.property_address || row.propertyAddress, source: 'property_address' },
    { val: row.address, source: 'address' },
    { val: meta.property_address || meta.address || meta.propertyAddress || meta.property_address_full, source: 'metadata_address' },
    { val: combined, source: 'combined_fields' },
  ]

  for (const candidate of candidates) {
    const text = asString(candidate.val, '').trim()
    if (text && text.toLowerCase() !== 'no address' && text.toLowerCase() !== 'unknown') {
      return { value: text, source: candidate.source }
    }
  }

  return { value: 'No Address', source: 'none' }
}

export const resolveInboxPropertyAddress = (row: Record<string, unknown>): string =>
  resolveInboxPropertyAddressWithSource(row).value

const applyInboxSearchServerFilter = (query: any, text: string | undefined): any => {
  if (!text || !text.trim()) return query
  const term = `%${text.trim()}%`
  return query.or(
    `display_name.ilike.${term},` +
    `display_address.ilike.${term},` +
    `display_phone.ilike.${term},` +
    `display_market.ilike.${term},` +
    `latest_message_body.ilike.${term},` +
    `property_type.ilike.${term},` +
    `ui_intent.ilike.${term},` +
    `stage.ilike.${term},` +
    `inbox_category.ilike.${term}`
  )
}

const applyInboxAdvancedServerFilters = (query: any, filters: Record<string, any> | undefined): any => {
  if (!filters) return query
  let q = query

  // 1. Geographic Filters
  if (filters.market) q = q.eq('filter_market', filters.market)
  if (filters.state) q = q.eq('filter_state', filters.state)
  if (filters.city) q = q.eq('filter_city', filters.city)
  if (filters.zip) q = q.eq('filter_zip', filters.zip)
  
  // 2. Property & Owner Type
  if (filters.propertyType) q = q.eq('filter_property_type', filters.propertyType)
  if (filters.propertyClass) q = q.eq('property_class', filters.propertyClass)
  if (filters.ownerType) q = q.eq('filter_owner_type', filters.ownerType)
  
  // 3. Lead & Conversation State
  if (filters.intent) q = q.eq('filter_intent', filters.intent)
  if (filters.stage) q = q.eq('filter_stage', filters.stage)
  if (filters.status) q = q.eq('filter_status', filters.status)
  if (filters.language) q = q.eq('filter_language', filters.language)
  if (filters.persona) q = q.eq('filter_agent_persona', filters.persona)
  if (filters.priorityTier) q = q.eq('filter_priority_tier', filters.priorityTier)
  
  // 4. Score Ranges
  if (filters.aiScoreMin !== undefined) q = q.gte('filter_min_score', filters.aiScoreMin)
  if (filters.motivationMin !== undefined) q = q.gte('priority_score', filters.motivationMin)
  
  // 5. Binary/Boolean Flags
  if (filters.isHot === true) q = q.eq('filter_is_hot', true)
  if (filters.isDnc === true) q = q.eq('filter_is_dnc', true)
  if (filters.taxDelinquent === true) q = q.eq('filter_tax_delinquent', true)
  if (filters.activeLien === true) q = q.eq('filter_active_lien', true)
  if (filters.highEquity === true) q = q.eq('filter_high_equity', true)
  if (filters.absenteeOwner === true) q = q.eq('filter_absentee_owner', true)
  if (filters.corporateOwner === true) q = q.eq('filter_corporate_owner', true)
  if (filters.hasProperty === true) q = q.eq('filter_has_property', true)
  if (filters.hasOwner === true) q = q.eq('filter_has_owner', true)
  if (filters.hasProspect === true) q = q.eq('filter_has_prospect', true)

  // 6. Directional Filters
  if (filters.direction === 'inbound') q = q.eq('filter_is_inbound', true)
  if (filters.direction === 'outbound') q = q.eq('filter_is_outbound', true)

  // 7. Legacy/Numeric Ranges
  if (filters.bedsMin !== undefined) q = q.gte('beds', filters.bedsMin)
  if (filters.bathsMin !== undefined) q = q.gte('baths', filters.bathsMin)
  if (filters.estimatedValueMin !== undefined) q = q.gte('estimated_value', filters.estimatedValueMin)
  if (filters.estimatedValueMax !== undefined) q = q.lte('estimated_value', filters.estimatedValueMax)
  if (filters.repairCostMin !== undefined) q = q.gte('estimated_repair_cost', filters.repairCostMin)
  if (filters.repairCostMax !== undefined) q = q.lte('estimated_repair_cost', filters.repairCostMax)
  
  if (filters.activityDateFrom) q = q.gte('latest_message_at', filters.activityDateFrom)
  if (filters.activityDateTo) q = q.lte('latest_message_at', filters.activityDateTo)

  return q
}



const getHydratedCategoriesForView = (view: string | undefined): HydratedInboxCategory[] => {
  if (!view || view === 'all') return []
  const mapped = HYDRATED_CATEGORY_BY_VIEW[view]
  if (!mapped) return []
  return Array.isArray(mapped) ? mapped : [mapped]
}

const readHydratedCategoryCount = (row: AnyRecord, key: string): number => {
  const direct = asNumber(row[key], Number.NaN)
  if (Number.isFinite(direct)) return direct
  return asNumber(
    row[`${key}_count`] ??
    row[`${key}_threads`] ??
    row[`${key}_total`] ??
    row.thread_count ??
    row.total_count ??
    row.count,
    0,
  )
}

const normalizeHydratedCategoryCounts = (rows: AnyRecord[]): Record<HydratedInboxCategory | 'all_inbound' | 'all', number> => {
  const counts = { ...EMPTY_HYDRATED_CATEGORY_COUNTS, all_inbound: 0 } as any
  if (rows.length === 0) return counts

  const first = rows[0] ?? {}
  if (Object.prototype.hasOwnProperty.call(first, 'inbox_category') || Object.prototype.hasOwnProperty.call(first, 'category')) {
    rows.forEach((row) => {
      const category = asString(row.inbox_category ?? row.category, '').toLowerCase() as HydratedInboxCategory
      if (category in counts) {
        counts[category] = readHydratedCategoryCount(row, category)
      }
    })
  } else {
    for (const category of HYDRATED_INBOX_CATEGORIES) {
      counts[category] = readHydratedCategoryCount(first, category)
    }
    counts.all = readHydratedCategoryCount(first, 'all')
  }

  if (!counts.all) {
    counts.all = HYDRATED_INBOX_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0), 0)
  }
  return counts
}

export const getQueueProcessorHealth = async (): Promise<QueueProcessorHealth> => {
  const supabase = getSupabaseClient()
  const checkedAt = new Date().toISOString()
  const lagCutoffIso = new Date(Date.now() - QUEUE_PROCESSOR_LAG_MINUTES * 60 * 1000).toISOString()
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startOfDayIso = startOfDay.toISOString()
  const webhookStaleCutoffIso = new Date(Date.now() - 90 * 60 * 1000).toISOString()

  const ACTIVE_CANONICAL_STATUSES = ['queued', 'pending', 'approval', 'scheduled', 'processing'] as const

  try {
    const [
      queuedProbe,
      pendingProbe,
      approvalProbe,
      scheduledProbe,
      processingProbe,
      lagProbe,
      oldestQueuedProbe,
      latestSentProbe,
      sentTodayProbe,
      deliveredTodayProbe,
      failedTodayProbe,
      issueRowsProbe,
      latestWebhookProbe,
      staleActiveProbe,
      orphanedProbe,
      retriedGtOneProbe,
      processingLockConflictProbe,
    ] = await Promise.all([
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'queued'),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'pending'),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'approval'),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'scheduled'),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'processing'),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .in('queue_status', ['queued', 'pending', 'processing'])
        .lt('created_at', lagCutoffIso),
      supabase
        .from('send_queue')
        .select('created_at')
        .eq('queue_status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1),
      supabase
        .from('send_queue')
        .select('sent_at,updated_at,created_at')
        .in('queue_status', ['sent', 'delivered'])
        .order('sent_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .gte('sent_at', startOfDayIso),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'delivered')
        .gte('delivered_at', startOfDayIso),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'failed')
        .gte('updated_at', startOfDayIso),
      supabase
        .from('send_queue')
        .select('id,queue_status,created_at,updated_at,scheduled_for_utc,sent_at,delivered_at,guard_reason,blocked_reason,failed_reason,paused_reason,dedupe_key,market,property_address,message_body,message_text,to_phone_number,master_owner_id,property_id,metadata')
        .order('updated_at', { ascending: false })
        .limit(4000),
      supabase
        .from('webhook_log')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .in('queue_status', ['queued', 'pending', 'approval', 'scheduled', 'processing'])
        .lt('updated_at', lagCutoffIso),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .in('queue_status', ['queued', 'pending', 'approval', 'scheduled', 'processing'])
        .is('to_phone_number', null),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .in('queue_status', ['queued', 'pending', 'approval', 'scheduled', 'processing'])
        .gt('retry_count', 1),
      supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'processing')
        .or('is_locked.is.false,lock_token.is.null'),
    ])

    if (
      queuedProbe.error ||
      scheduledProbe.error ||
      pendingProbe.error ||
      approvalProbe.error ||
      processingProbe.error ||
      lagProbe.error ||
      oldestQueuedProbe.error ||
      latestSentProbe.error ||
      sentTodayProbe.error ||
      deliveredTodayProbe.error ||
      failedTodayProbe.error ||
      issueRowsProbe.error
      || staleActiveProbe.error
      || orphanedProbe.error
      || retriedGtOneProbe.error
      || processingLockConflictProbe.error
    ) {
      const err =
        queuedProbe.error ??
        pendingProbe.error ??
        approvalProbe.error ??
        scheduledProbe.error ??
        processingProbe.error ??
        lagProbe.error ??
        oldestQueuedProbe.error ??
        latestSentProbe.error ??
        sentTodayProbe.error ??
        deliveredTodayProbe.error ??
        failedTodayProbe.error ??
        issueRowsProbe.error
        ?? staleActiveProbe.error
        ?? orphanedProbe.error
        ?? retriedGtOneProbe.error
        ?? processingLockConflictProbe.error
      return {
        checkedAt,
        queuedCount: queuedProbe.count ?? 0,
        scheduledCount: (scheduledProbe.count ?? 0) + (approvalProbe.count ?? 0),
        sendingCount: processingProbe.count ?? 0,
        sentTodayCount: sentTodayProbe.count ?? 0,
        deliveredTodayCount: deliveredTodayProbe.count ?? 0,
        failedTodayCount: failedTodayProbe.count ?? 0,
        blockedCount: 0,
        pausedInvalidCount: 0,
        duplicateSkippedCount: 0,
        suppressionBlockedCount: 0,
        blankBodyBlockedCount: 0,
        routingBlockedCount: 0,
        repliedBeforeSendCount: 0,
        queuedOlderThanLagWindow: lagProbe.count ?? 0,
        oldestQueuedAt: null,
        latestSentAt: null,
        latestWebhookAt: null,
        webhookHealthy: false,
        processorHealthy: false,
        status: 'unknown',
        failedRate: null,
        duplicateActiveCount: 0,
        activeBlankRowCount: 0,
        routingBlockedSpike: false,
        liveAutopilotAllowed: false,
        routingBlockedRows: [],
        summary: mapErrorMessage(err) || 'Unable to read queue processor status',
      }
    }

    const queuedCount = queuedProbe.count ?? 0
    const pendingCount = pendingProbe.count ?? 0
    const approvalCount = approvalProbe.count ?? 0
    const scheduledBaseCount = scheduledProbe.count ?? 0
    const scheduledCount = scheduledBaseCount + approvalCount
    const sendingCount = processingProbe.count ?? 0
    const sentTodayCount = sentTodayProbe.count ?? 0
    const deliveredTodayCount = deliveredTodayProbe.count ?? 0
    const failedTodayCount = failedTodayProbe.count ?? 0
    const queuedOlderThanLagWindow = lagProbe.count ?? 0
    const oldestQueuedRow = safeArray(oldestQueuedProbe.data as AnyRecord[])[0] ?? null
    const latestSentRow = safeArray(latestSentProbe.data as AnyRecord[])[0] ?? null
    const latestWebhookRow = safeArray(latestWebhookProbe.data as AnyRecord[])[0] ?? null
    const issueRows = safeArray(issueRowsProbe.data as AnyRecord[])

    const oldestQueuedAt = asIso(getFirst(oldestQueuedRow ?? {}, ['created_at'])) ?? null
    const latestSentAt = asIso(getFirst(latestSentRow ?? {}, ['sent_at', 'updated_at', 'created_at'])) ?? null
    const latestWebhookAt = asIso(getFirst(latestWebhookRow ?? {}, ['created_at'])) ?? null

    const activeRows = issueRows.filter((row) => ACTIVE_CANONICAL_STATUSES.includes(normalizeStatus(row.queue_status) as any))
    const blockedRows = issueRows.filter((row) => normalizeStatus(row.queue_status) === 'blocked')
    const pausedRows = issueRows.filter((row) => normalizeStatus(row.queue_status) === 'paused_invalid_queue_row')
    const duplicateSkippedCount = issueRows.filter((row) => {
      const reason = `${asString(row.blocked_reason)} ${asString(row.failed_reason)}`.toLowerCase()
      return reason.includes('duplicate')
    }).length
    const suppressionBlockedCount = issueRows.filter((row) => {
      const reason = `${asString(row.blocked_reason)} ${asString(row.failed_reason)} ${asString(row.guard_reason)}`.toLowerCase()
      return ['suppressed', 'opt_out', 'dnc', 'wrong_number', 'hostile', 'legal'].some((token) => reason.includes(token))
    }).length
    const blankBodyBlockedCount = issueRows.filter((row) => {
      const reason = `${asString(row.blocked_reason)} ${asString(row.failed_reason)} ${asString(row.guard_reason)}`.toLowerCase()
      const body = asString(row.message_body || row.message_text).trim()
      return !body || reason.includes('blank_message_body') || reason.includes('missing_message_body')
    }).length
    const routingBlockedRows = issueRows.filter((row) => {
      const reason = `${asString(row.guard_reason)} ${asString(row.failed_reason)}`.toLowerCase()
      return reason.includes('no_valid_local_textgrid_number') || reason.includes('routing blocked')
    })
    const routingBlockedCount = routingBlockedRows.length
    const repliedBeforeSendCount = issueRows.filter((row) => {
      const reason = `${asString(row.paused_reason)} ${asString(row.failed_reason)}`.toLowerCase()
      return reason.includes('replied_before_send')
    }).length
    const blockedCount = blockedRows.length
    const pausedInvalidCount = pausedRows.length
    const dedupeCounts = new Map<string, number>()
    activeRows.forEach((row) => {
      const key = asString(row.dedupe_key)
      if (!key) return
      dedupeCounts.set(key, (dedupeCounts.get(key) ?? 0) + 1)
    })
    const duplicateActiveCount = Array.from(dedupeCounts.values()).filter((count) => count > 1).length
    const staleRowsCount = staleActiveProbe.count ?? 0
    const orphanedRowsCount = orphanedProbe.count ?? 0
    const retriedGtOneCount = retriedGtOneProbe.count ?? 0
    const processingLockConflictCount = processingLockConflictProbe.count ?? 0
    const activeBlankRowCount = activeRows.filter((row) => !asString(row.message_body || row.message_text).trim()).length
    const latestSentTs = latestSentAt ? new Date(latestSentAt).getTime() : NaN
    const latestWebhookTs = latestWebhookAt ? new Date(latestWebhookAt).getTime() : NaN
    const webhookHealthy = !Number.isFinite(latestSentTs) || latestSentTs < new Date(webhookStaleCutoffIso).getTime()
      ? true
      : Number.isFinite(latestWebhookTs) && latestWebhookTs >= new Date(webhookStaleCutoffIso).getTime()
    const failedRate = sentTodayCount > 0 ? (failedTodayCount / sentTodayCount) * 100 : null
    const routingBlockedSpike = routingBlockedCount >= 5
    const critical =
      activeBlankRowCount > 0 ||
      duplicateActiveCount > 0 ||
      routingBlockedSpike ||
      (failedRate !== null && failedRate > 12)
    const warning =
      !critical &&
      (!webhookHealthy ||
        queuedOlderThanLagWindow > 0 ||
        pausedInvalidCount > 0 ||
        routingBlockedCount > 0 ||
        (failedRate !== null && failedRate > 5) ||
        blockedCount > 0)
    const status: QueueProcessorHealth['status'] = critical ? 'critical' : warning ? 'warning' : 'healthy'
    const processorHealthy = status === 'healthy'
    const summary = critical
      ? activeBlankRowCount > 0
        ? `${activeBlankRowCount} active blank queue rows require intervention`
        : duplicateActiveCount > 0
          ? `${duplicateActiveCount} active duplicate dedupe collisions detected`
          : routingBlockedSpike
            ? `${routingBlockedCount} routing blocked rows need sender coverage`
            : `${failedTodayCount} failed today exceeded threshold`
      : warning
        ? !webhookHealthy
          ? 'Delivery webhook appears stale'
          : queuedOlderThanLagWindow > 0
            ? `${queuedOlderThanLagWindow} queued older than ${QUEUE_PROCESSOR_LAG_MINUTES}m`
            : `${pausedInvalidCount + routingBlockedCount} queue rows need review`
        : (queuedCount + pendingCount + approvalCount + scheduledBaseCount + sendingCount) > 0
          ? `${queuedCount + pendingCount + approvalCount + scheduledBaseCount + sendingCount} queue rows active and inside guardrails`
          : 'Queue clear'

    return {
      checkedAt,
      queuedCount,
      scheduledCount,
      sendingCount,
      sentTodayCount,
      deliveredTodayCount,
      failedTodayCount,
      blockedCount,
      pausedInvalidCount,
      duplicateSkippedCount,
      suppressionBlockedCount,
      blankBodyBlockedCount,
      routingBlockedCount,
      repliedBeforeSendCount,
      queuedOlderThanLagWindow,
      oldestQueuedAt,
      latestSentAt,
      latestWebhookAt,
      webhookHealthy,
      processorHealthy,
      status,
      failedRate,
      duplicateActiveCount,
      activeBlankRowCount,
      staleRowsCount,
      orphanedRowsCount,
      duplicateFingerprintCount: duplicateActiveCount,
      retriedGtOneCount,
      processingLockConflictCount,
      routingBlockedSpike,
      liveAutopilotAllowed: true,
      routingBlockedRows: routingBlockedRows.slice(0, 8).map((row) => ({
        id: asString(row.id, ''),
        sellerName: asString(((row.metadata as AnyRecord | null)?.seller_name) || ((row.metadata as AnyRecord | null)?.owner_name) || row.master_owner_id, 'Unknown Seller'),
        propertyAddress: asString(row.property_address, 'Property Unknown'),
        market: asString(row.market, 'Unknown'),
        reason: asString(row.failed_reason || row.guard_reason || row.blocked_reason, 'Routing blocked'),
        queueStatus: asString(row.queue_status, 'paused_invalid_queue_row'),
      })),
      summary,
    }
  } catch (error) {
    return {
      checkedAt,
      queuedCount: 0,
      scheduledCount: 0,
      sendingCount: 0,
      sentTodayCount: 0,
      deliveredTodayCount: 0,
      failedTodayCount: 0,
      blockedCount: 0,
      pausedInvalidCount: 0,
      duplicateSkippedCount: 0,
      suppressionBlockedCount: 0,
      blankBodyBlockedCount: 0,
      routingBlockedCount: 0,
      repliedBeforeSendCount: 0,
      queuedOlderThanLagWindow: 0,
      oldestQueuedAt: null,
      latestSentAt: null,
      latestWebhookAt: null,
      webhookHealthy: false,
      processorHealthy: false,
      status: 'warning',
      failedRate: null,
      duplicateActiveCount: 0,
      activeBlankRowCount: 0,
      routingBlockedSpike: false,
      liveAutopilotAllowed: true,
      routingBlockedRows: [],
      summary: mapErrorMessage(error) || 'Unable to read queue processor status',
    }
  }
}

// UUID v4 safety guard — prevents inserting 'ph_...' text ids into uuid columns
const isValidUUID = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)

const normalizePhone = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return ''
  const hasPlus = raw.startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return hasPlus ? `+${digits}` : digits
}

const safeFilterValue = (value: string): string => `"${value.replace(/"/g, '""')}"`

/**
 * Build phone number variants for broad field matching.
 * Returns unique non-empty strings covering:
 * - original
 * - +E.164 form (e.g. +16127433952)
 * - digits only (e.g. 16127433952)
 * - 10-digit local US (e.g. 6127433952)
 * - +1 + 10-digit (e.g. +16127433952, same as E.164 if US)
 */
const buildPhoneVariants = (phone: string): string[] => {
  if (!phone) return []
  const digits = phone.replace(/\D/g, '')
  if (!digits) return []
  const variants = new Set<string>()
  variants.add(phone)
  // E.164-style
  if (!phone.startsWith('+')) variants.add(`+${digits}`)
  else variants.add(phone)
  variants.add(digits)
  // 10-digit local US (strip leading 1 if 11 digits)
  if (digits.length === 11 && digits.startsWith('1')) {
    const local = digits.slice(1)
    variants.add(local)
    variants.add(`+1${local}`)
  }
  if (digits.length === 10) {
    variants.add(`+1${digits}`)
  }
  return Array.from(variants).filter(Boolean)
}

type PersonalizationCandidate = {
  seller_first_name?: string | null
  seller_full_name?: string | null
  seller_name_source?: string | null
  owner_display_name?: string | null
  prospect_first_name?: string | null
  prospect_full_name?: string | null
  phone_first_name?: string | null
  phone_full_name?: string | null
  primary_display_name?: string | null
  master_owner_display_name?: string | null
  property_owner_name?: string | null
  owner_name?: string | null
  first_name?: string | null
}

type SellerFirstNameResolution = {
  value: string
  source: string
}

type RenderGuardResult = {
  messageText: string
  repaired: boolean
  passed: boolean
}

const cleanFirstToken = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return ''
  const noHonorific = raw.replace(/^(mr|mrs|ms|dr|sr|sra|srta)\.?\s+/i, '')
  const primarySegment = noHonorific.split(/[,&/]|\sand\s|\sy\s/i)[0] ?? noHonorific
  const firstToken = primarySegment.trim().split(/\s+/)[0] ?? ''
  return firstToken.replace(/^[^A-Za-z\u00C0-\u024F]+|[^A-Za-z\u00C0-\u024F'-]+$/g, '')
}

export const resolveSellerFirstName = (candidate: PersonalizationCandidate): SellerFirstNameResolution => {
  const ordered: Array<{ value: unknown; source: string }> = [
    { value: candidate.seller_first_name, source: 'candidate.seller_first_name' },
    { value: candidate.prospect_first_name, source: 'prospects.first_name' },
    { value: candidate.phone_first_name, source: 'phones.first_name' },
    { value: candidate.first_name, source: 'candidate.first_name' },
    { value: candidate.primary_display_name, source: 'candidate.primary_display_name' },
    { value: candidate.phone_full_name, source: 'phones.full_name' },
    { value: candidate.prospect_full_name, source: 'prospects.full_name' },
    { value: candidate.owner_display_name, source: 'owners.display_name' },
    { value: candidate.master_owner_display_name, source: 'master_owners.display_name' },
    { value: candidate.property_owner_name, source: 'properties.owner_name' },
    { value: candidate.owner_name, source: 'candidate.owner_name' },
  ]

  for (const item of ordered) {
    const token = cleanFirstToken(item.value)
    if (token) return { value: token, source: item.source }
  }

  return { value: '', source: 'none' }
}

const applyRenderGuard = (renderedMessage: string): RenderGuardResult => {
  const greetingCommaPattern = /^(\s*(?:hi|hey|hello|hola|ola|marhaba))\s+,/i
  const repaired = renderedMessage.replace(greetingCommaPattern, '$1,')
  return {
    messageText: repaired,
    repaired: repaired !== renderedMessage,
    passed: !/^(hi|hey|hello|hola|ola|marhaba)\s+,/i.test(repaired.trim()),
  }
}

const buildPersonalizationCandidate = (thread: InboxThread): PersonalizationCandidate => {
  const owner = asString(thread.ownerName, '')
  return {
    seller_first_name: null,
    seller_full_name: owner || null,
    seller_name_source: owner ? 'thread.ownerName' : null,
    owner_display_name: owner || null,
    prospect_first_name: null,
    prospect_full_name: null,
    phone_first_name: null,
    phone_full_name: null,
    primary_display_name: owner || null,
    master_owner_display_name: owner || null,
    property_owner_name: owner || null,
    owner_name: owner || null,
    first_name: null,
  }
}

const buildQueuePersonalization = (thread: InboxThread, messageText: string) => {
  const candidate = buildPersonalizationCandidate(thread)
  const resolved = resolveSellerFirstName(candidate)
  const renderGuard = applyRenderGuard(messageText)
  const firstNameFallback = resolved.value

  const renderVariables = {
    seller_first_name: cleanFirstToken(candidate.seller_first_name) || firstNameFallback,
    seller_name: cleanFirstToken(candidate.seller_first_name) || firstNameFallback,
    owner_first_name: cleanFirstToken(candidate.first_name) || firstNameFallback,
    first_name: cleanFirstToken(candidate.first_name) || firstNameFallback,
  }

  const candidateSnapshot = {
    phone_id: thread.phoneNumberId ?? null,
    property_id: thread.propertyId ?? null,
    seller_state: null,
    touch_number: 1,
    best_phone_id: thread.phoneNumberId ?? null,
    seller_market: thread.market ?? thread.marketId ?? null,
    master_owner_id: thread.ownerId ?? null,
    canonical_phone_masked: thread.canonicalE164 ?? null,
    seller_first_name: renderVariables.seller_first_name || null,
    seller_full_name: candidate.seller_full_name ?? null,
    seller_name_source: resolved.source,
    owner_display_name: candidate.owner_display_name ?? null,
    prospect_first_name: candidate.prospect_first_name ?? null,
    prospect_full_name: candidate.prospect_full_name ?? null,
    phone_first_name: candidate.phone_first_name ?? null,
    phone_full_name: candidate.phone_full_name ?? null,
    primary_display_name: candidate.primary_display_name ?? null,
    master_owner_display_name: candidate.master_owner_display_name ?? null,
    property_owner_name: candidate.property_owner_name ?? null,
  }

  const personalizationMeta = {
    seller_first_name: renderVariables.seller_first_name || null,
    seller_name_source: resolved.source,
    name_missing: !renderVariables.seller_first_name,
    render_guard_passed: renderGuard.passed,
    render_guard_repaired: renderGuard.repaired,
  }

  return {
    messageText: renderGuard.messageText,
    renderVariables,
    candidateSnapshot,
    personalizationMeta,
  }
}

const buildSelectedTemplatePayload = (
  selectedTemplate?: SmsTemplate | null,
  threadContext?: ThreadContext | null,
): {
  templateId: string | null
  useCaseTemplate: string
  templateName: string | null
  language: string | null
  metadata: Record<string, unknown>
} => {
  if (!selectedTemplate) {
    return {
      templateId: null,
      useCaseTemplate: 'manual_reply',
      templateName: null,
      language: null,
      metadata: {
        template_source: 'manual_composer',
        thread_context_available: Boolean(threadContext),
      },
    }
  }

  return {
    templateId: selectedTemplate.templateId ?? selectedTemplate.id ?? null,
    useCaseTemplate: selectedTemplate.useCaseSlug || 'manual_reply',
    templateName: selectedTemplate.useCase ?? null,
    language: selectedTemplate.language ?? null,
    metadata: {
      template_source: 'sms_templates',
      template_record_id: selectedTemplate.id,
      template_id: selectedTemplate.templateId ?? selectedTemplate.id ?? null,
      template_use_case: selectedTemplate.useCaseSlug,
      template_label: selectedTemplate.useCase,
      template_stage_code: selectedTemplate.stageCode,
      template_stage_label: selectedTemplate.stageLabel,
      template_language: selectedTemplate.language,
      template_agent_style: selectedTemplate.agentStyle,
      thread_context_available: Boolean(threadContext),
      seller_context: threadContext?.seller ?? null,
      property_context: threadContext?.property ?? null,
    },
  }
}

const SMS_ROUTE_METADATA = {
  preferred_channel: 'sms',
  channel: 'sms',
  transport: 'sms',
  message_channel: 'sms',
  send_transport: 'sms',
  force_sms: true,
  sms_only: true,
  skip_rcs: true,
  disable_rcs: true,
  provider_hint: 'textgrid_sms',
} as const

if (DEV) {
  const check1 = resolveSellerFirstName({ prospect_first_name: 'Jose' })
  const msg1 = applyRenderGuard(`Hello ${check1.value}, this is Chris...`)

  const check2 = resolveSellerFirstName({ owner_display_name: 'Jose A Valdizon & Rocio Mendoza' })
  const msg2 = applyRenderGuard(`Hello ${check2.value}, this is Chris...`)

  const check3 = resolveSellerFirstName({})
  const msg3 = applyRenderGuard('Hello , this is Chris...')

  console.debug('[personalization-check]', {
    case_prospect_first_name: msg1.messageText,
    case_owner_display_name: msg2.messageText,
    case_missing_name_source: check3.source,
    case_missing_name: msg3.messageText,
    guard_pattern_blocked: !/^(hi|hey|hello|hola|ola|marhaba)\s+,/i.test(msg1.messageText) &&
      !/^(hi|hey|hello|hola|ola|marhaba)\s+,/i.test(msg2.messageText) &&
      !/^(hi|hey|hello|hola|ola|marhaba)\s+,/i.test(msg3.messageText),
  })
}

// All likely phone field names in the `phones` / `phone_numbers` table
const PHONE_NUMBER_FIELD_NAMES = ['phone', 'canonical_e164'] as const

// ── Table alias resolution ─────────────────────────────────────────────────
// Maps logical alias keys to ordered candidate table names.
// resolveTable tries each until one succeeds (code 42P01 = table missing).
// Results are module-scoped cached so probe queries run only once per session.
const TABLE_ALIASES: Record<string, readonly string[]> = {
  phones:       ['phones', 'phone_numbers', 'phonenumbers'],
  masterOwners: ['master_owners', 'masterowners', 'masterowners_30679234'],
  owners:       ['sub_owners', 'owners'],
  aiBrain:      ['contact_outreach_state', 'ai_conversation_brain'],
  templates:    ['sms_templates', 'templates'],
  offers:       ['property_cash_offer_snapshots', 'offers'],
}

const resolvedTableCache = new Map<string, string | null>()

const FILTER_COLUMNS_BY_ALIAS: Record<string, readonly string[]> = {
  phones: ['phone', 'canonical_e164', 'master_owner_id'],
  masterOwners: [],
  owners: [],
  prospects: ['prospect_id', 'master_owner_id', 'first_name', 'full_name'],
  emails: [],
  aiBrain: ['id', 'to_phone_number'],
  offers: [],
  send_queue: [
    'id',
    'queue_key',
    'to_phone_number',
    'from_phone_number',
    'master_owner_id',
    'prospect_id',
    'property_id',
  ],
}

/** Returns the first existing table for an alias key, or the raw key if not a known alias. */
const resolveTable = async (aliasKey: string): Promise<string> => {
  if (!(aliasKey in TABLE_ALIASES)) return aliasKey
  if (resolvedTableCache.has(aliasKey)) {
    return resolvedTableCache.get(aliasKey) ?? ''
  }
  const supabase = getSupabaseClient()
  const candidates = TABLE_ALIASES[aliasKey]!
  for (const candidate of candidates) {
    const { error } = await supabase.from(candidate).select('*').limit(1)
    // PostgreSQL 42P01 = undefined_table; any other result means the table exists
    if (!error || (error as { code?: string }).code !== '42P01') {
      resolvedTableCache.set(aliasKey, candidate)
      return candidate
    }
  }
  resolvedTableCache.set(aliasKey, null)
  if (DEV) console.warn(`[NEXUS] resolveTable: no valid table for "${aliasKey}". Tried: ${candidates.join(', ')}`)
  return ''
}



/**
 * Traverse a dot-separated path into a plain object/array tree.
 * Returns `undefined` if any segment is missing or non-traversable.
 * Example: getNestedValue(row, 'payload.from') -> row.payload?.from
 */
export const getNestedValue = (row: AnyRecord, dotPath: string): unknown => {
  const parts = dotPath.split('.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = row
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/**
 * Try a list of top-level fields first, then fall back to dot-path nested
 * fields. Returns the first truthy value found.
 */
export const getFirstDeep = (
  row: AnyRecord,
  topLevelFields: readonly string[],
  nestedPaths: readonly string[],
): unknown => {
  for (const field of topLevelFields) {
    const val = row[field]
    if (val !== undefined && val !== null && val !== '') return val
  }
  for (const path of nestedPaths) {
    const val = getNestedValue(row, path)
    if (val !== undefined && val !== null && val !== '') return val
  }
  return undefined
}

// Top-level JSON blob keys that may contain nested phone/body/direction data
const NESTED_BLOB_KEYS = [
  'payload', 'raw_payload', 'event', 'data', 'body', 'message', 'textgrid',
  'textgrid_payload', 'webhook_payload', 'metadata', 'request_body',
  'response_body', 'raw', 'json', 'details',
] as const

/**
 * DEV-only: inspect a message_events row and log top-level keys plus any
 * nested keys found in known JSON blob fields (up to depth 2).
 */
export const inspectMessageEventShape = (row: AnyRecord): void => {
  if (!DEV) return
  const topLevelKeys = Object.keys(row)
  const nestedKeyMap: Record<string, string[]> = {}
  for (const blobKey of NESTED_BLOB_KEYS) {
    const blob = row[blobKey]
    if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
      const blobRecord = blob as AnyRecord
      const keys = Object.keys(blobRecord)
      if (keys.length > 0) {
        nestedKeyMap[blobKey] = keys
        // One level deeper
        for (const k of keys) {
          const sub = blobRecord[k]
          if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
            const subRecord = sub as AnyRecord
            const subKeys = Object.keys(subRecord)
            if (subKeys.length > 0) {
              nestedKeyMap[`${blobKey}.${k}`] = subKeys
            }
          }
        }
      }
    }
  }
  // Likely fields: any key whose name resembles phone/body/direction
  const likelyRe = /phone|body|message|direction|from|to|text|content|number|e164|sender|recipient|type|event/i
  const likelyFields: Record<string, string> = {}
  for (const key of topLevelKeys) {
    if (likelyRe.test(key)) {
      const val = String(row[key] ?? '').slice(0, 160)
      likelyFields[key] = val
    }
  }
  for (const [path, keys] of Object.entries(nestedKeyMap)) {
    for (const key of keys) {
      if (likelyRe.test(key)) {
        const val = String(getNestedValue(row, `${path}.${key}`) ?? '').slice(0, 160)
        likelyFields[`${path}.${key}`] = val
      }
    }
  }
  console.log('[inspectMessageEventShape] topLevelKeys:', topLevelKeys)
  console.log('[inspectMessageEventShape] nestedKeyMap:', nestedKeyMap)
  console.log('[inspectMessageEventShape] likelyFields:', likelyFields)
}

// ── Message_events phone field candidates (kept as fallback documentation) ─
// These were used before the actual schema was confirmed. The primary fields
// are now from_phone_number and to_phone_number. These are used only in the
// direction-unknown nested fallback scan inside getSellerPhoneFromMessage.

export interface SellerPhoneResult {
  sellerPhone: string
  sellerPhoneSourceField: string
  canonicalE164: string
  ourNumber: string
  directionUsed: 'inbound' | 'outbound' | 'unknown'
}

// Business numbers to exclude when direction is unknown (env-configured)
const KNOWN_OUR_NUMBERS: Set<string> = new Set(
  [
    import.meta.env.VITE_TEXTGRID_FROM_NUMBER,
    import.meta.env.VITE_TEXTGRID_NUMBER,
  ]
    .filter(Boolean)
    .map(normalizePhone)
    .filter(Boolean),
)

// Nested paths for inbound sender phone
const NESTED_INBOUND_FROM = [
  'payload.from', 'payload.from_number', 'payload.sender', 'payload.caller_id',
  'raw_payload.from', 'raw_payload.from_number', 'raw_payload.sender',
  'raw_payload.data.from', 'raw_payload.data.from_number',
  'event.from', 'event.from_number', 'event.sender',
  'data.from', 'data.from_number', 'data.sender',
  'textgrid_payload.from', 'textgrid_payload.from_number',
  'webhook_payload.from', 'webhook_payload.from_number',
  'details.from', 'details.from_number',
] as const

// Nested paths for outbound recipient phone
const NESTED_OUTBOUND_TO = [
  'payload.to', 'payload.to_number', 'payload.recipient', 'payload.destination',
  'raw_payload.to', 'raw_payload.to_number', 'raw_payload.recipient',
  'raw_payload.data.to', 'raw_payload.data.to_number',
  'event.to', 'event.to_number', 'event.recipient',
  'data.to', 'data.to_number', 'data.recipient',
  'textgrid_payload.to', 'textgrid_payload.to_number',
  'webhook_payload.to', 'webhook_payload.to_number',
  'details.to', 'details.to_number',
] as const

// Nested paths for canonical/generic phone fields (kept for reference; not
// actively used since actual schema has from_phone_number / to_phone_number)

/**
 * Determine the seller's phone number from a message_events row.
 * Primary: from_phone_number (inbound) / to_phone_number (outbound).
 * Fallback: metadata.payload.from/to, metadata.payload.raw.From/To.
 * Returns ourNumber (the TextGrid business line) and directionUsed.
 */
export const getSellerPhoneFromMessage = (row: AnyRecord): SellerPhoneResult => {
  const direction = normalizeMessageDirection(row)
  const directionUsed = direction

  let sellerPhone = ''
  let sellerPhoneSourceField = ''
  let ourNumber = ''

  if (direction === 'inbound') {
    // Seller sent the message — their number is in from_phone_number
    const fromPhone = normalizePhone(row['from_phone_number'])
    if (fromPhone) {
      sellerPhone = fromPhone
      sellerPhoneSourceField = 'from_phone_number'
      ourNumber = normalizePhone(row['to_phone_number'])
    } else {
      // Nested metadata fallback
      const nestedFrom =
        normalizePhone(getNestedValue(row, 'metadata.payload.from')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.raw.From')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.from_number'))
      if (nestedFrom) {
        sellerPhone = nestedFrom
        sellerPhoneSourceField = 'metadata.payload.from'
      }
      ourNumber =
        normalizePhone(row['to_phone_number']) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.to')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.raw.To'))
    }
  } else if (direction === 'outbound') {
    // We sent the message — seller's number is in to_phone_number
    const toPhone = normalizePhone(row['to_phone_number'])
    if (toPhone) {
      sellerPhone = toPhone
      sellerPhoneSourceField = 'to_phone_number'
      ourNumber = normalizePhone(row['from_phone_number'])
    } else {
      const nestedTo =
        normalizePhone(getNestedValue(row, 'metadata.payload.to')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.raw.To')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.to_number'))
      if (nestedTo) {
        sellerPhone = nestedTo
        sellerPhoneSourceField = 'metadata.payload.to'
      }
      ourNumber =
        normalizePhone(row['from_phone_number']) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.from')) ||
        normalizePhone(getNestedValue(row, 'metadata.payload.raw.From'))
    }
  } else {
    // Direction unknown: use KNOWN_OUR_NUMBERS heuristic to pick seller side
    const fromPhone = normalizePhone(row['from_phone_number'])
    const toPhone = normalizePhone(row['to_phone_number'])

    if (fromPhone && toPhone) {
      if (!KNOWN_OUR_NUMBERS.has(fromPhone)) {
        sellerPhone = fromPhone; sellerPhoneSourceField = 'from_phone_number'; ourNumber = toPhone
      } else {
        sellerPhone = toPhone; sellerPhoneSourceField = 'to_phone_number'; ourNumber = fromPhone
      }
    } else if (fromPhone) {
      sellerPhone = fromPhone; sellerPhoneSourceField = 'from_phone_number'
    } else if (toPhone) {
      sellerPhone = toPhone; sellerPhoneSourceField = 'to_phone_number'
    } else {
      // No actual columns — full nested scan as last resort
      for (const path of NESTED_INBOUND_FROM) {
        const val = normalizePhone(getNestedValue(row, path))
        if (val && !KNOWN_OUR_NUMBERS.has(val)) { sellerPhone = val; sellerPhoneSourceField = path; break }
      }
      if (!sellerPhone) {
        for (const path of NESTED_OUTBOUND_TO) {
          const val = normalizePhone(getNestedValue(row, path))
          if (val && !KNOWN_OUR_NUMBERS.has(val)) { sellerPhone = val; sellerPhoneSourceField = path; break }
        }
      }
    }
  }

  // ── DEV warnings ──────────────────────────────────────────────────────────
  if (DEV && !sellerPhone) {
    const fromPhone = normalizePhone(row['from_phone_number'])
    const toPhone = normalizePhone(row['to_phone_number'])
    if (direction !== 'unknown' && (fromPhone || toPhone)) {
      // Direction IS known but phone extraction still failed — inspect why
      console.warn('[Inbox Seller Phone Mapping Failed]', {
        direction,
        from_phone_number: fromPhone,
        to_phone_number: toPhone,
        id: row['id'],
        message_event_key: row['message_event_key'],
      })
    } else if (!fromPhone && !toPhone) {
      // Both phone columns are empty — record not viable for phone-based grouping
      const nestedKeyMap: Record<string, string[]> = {}
      for (const blobKey of NESTED_BLOB_KEYS) {
        const blob = row[blobKey]
        if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
          nestedKeyMap[blobKey] = Object.keys(blob as AnyRecord)
        }
      }
      console.warn('[Inbox Thread Identity Missing] from_phone_number and to_phone_number are both empty.', {
        id: row['id'],
        direction,
        nestedKeyMap,
        recommendation: 'message_events rows need from_phone_number / to_phone_number populated.',
      })
    }
  }

  // canonicalE164 = sellerPhone (no separate canonical_e164 column in schema)
  const canonicalE164 = sellerPhone

  return { sellerPhone, sellerPhoneSourceField, canonicalE164, ourNumber, directionUsed }
}

export const getMessageTimestamp = (row: AnyRecord): string => {
  const value = getFirstDeep(
    row,
    ['event_timestamp', 'created_at', 'timestamp', 'message_timestamp', 'sent_at', 'received_at', 'delivered_at'],
    [
      'payload.created_at', 'payload.timestamp', 'payload.sent_at', 'payload.received_at',
      'raw_payload.created_at', 'raw_payload.timestamp', 'raw_payload.sent_at',
      'event.created_at', 'event.timestamp', 'event.sent_at',
      'data.created_at', 'data.timestamp', 'data.sent_at',
      'textgrid_payload.created_at', 'textgrid_payload.timestamp',
      'webhook_payload.created_at', 'webhook_payload.timestamp',
      'details.created_at', 'details.timestamp',
    ],
  )
  return asIso(value) ?? new Date().toISOString()
}

export const getMessageBody = (row: AnyRecord): string => {
  return asString(
    getFirstDeep(
      row,
      ['message_body', 'body', 'text', 'message', 'content', 'rendered_message', 'template_text'],
      [
        'metadata.payload.message', 'metadata.payload.message_body', 'metadata.payload.raw.Body',
        'payload.body', 'payload.message', 'payload.text', 'payload.content',
        'raw_payload.body', 'raw_payload.message', 'raw_payload.text',
        'raw_payload.data.body', 'raw_payload.data.message', 'raw_payload.data.text',
        'event.body', 'event.message', 'event.text',
        'data.body', 'data.message', 'data.text',
        'textgrid_payload.body', 'textgrid_payload.message', 'textgrid_payload.text',
        'webhook_payload.body', 'webhook_payload.message', 'webhook_payload.text',
        'request_body.body', 'request_body.message', 'request_body.text',
        'details.body', 'details.message', 'details.text',
      ],
    ),
    '',
  )
}

export const normalizeMessageDirection = (row: AnyRecord): 'inbound' | 'outbound' | 'unknown' => {
  const direction = normalizeStatus(
    getFirstDeep(
      row,
      ['direction', 'message_direction'],
      [
        'metadata.payload.direction', 'metadata.payload.raw.SmsStatus', 'metadata.payload.type',
        'payload.direction', 'payload.type', 'payload.event_type', 'payload.status',
        'raw_payload.direction', 'raw_payload.type', 'raw_payload.event_type', 'raw_payload.status',
        'event.direction', 'event.type', 'event.event_type',
        'data.direction', 'data.type', 'data.event_type',
        'textgrid_payload.direction', 'textgrid_payload.type',
        'webhook_payload.direction', 'webhook_payload.type',
        'details.direction',
      ],
    ),
  )
  if (['inbound', 'incoming', 'received', 'reply', 'from_seller'].includes(direction)) return 'inbound'
  if (['outbound', 'outgoing', 'sent', 'queued', 'to_seller'].includes(direction)) return 'outbound'

  const typeDirection = normalizeStatus(
    getFirstDeep(
      row,
      ['type'],
      [
        'metadata.type', 'metadata.payload.type',
        'payload.type', 'raw_payload.type', 'event.type', 'data.type',
        'textgrid_payload.type', 'webhook_payload.type', 'details.type',
      ],
    ),
  )
  if (typeDirection === 'outbound') return 'outbound'
  if (typeDirection === 'inbound') return 'inbound'

  const eventType = normalizeStatus(
    getFirstDeep(
      row,
      ['event_type', 'type'],
      [
        'payload.event_type', 'raw_payload.event_type', 'event.event_type', 'data.event_type',
        'textgrid_payload.event_type', 'webhook_payload.event_type',
      ],
    ),
  )
  if (['inbound', 'incoming', 'received', 'message_received', 'reply_received'].includes(eventType)) return 'inbound'
  if (['outbound', 'outgoing', 'sent', 'message_sent', 'send'].includes(eventType)) return 'outbound'

  const deliveryStatus = normalizeStatus(getFirst(row, ['delivery_status', 'raw_carrier_status', 'provider_delivery_status']))
  if (['received', 'inbound'].includes(deliveryStatus)) return 'inbound'
  if (['queued', 'sent', 'delivered', 'outbound'].includes(deliveryStatus)) return 'outbound'

  const sourceApp = normalizeStatus(getFirst(row, ['source_app']))
  if (['inbound', 'incoming', 'seller'].includes(sourceApp)) return 'inbound'
  if (['outbound', 'outgoing', 'operator', 'ai'].includes(sourceApp)) return 'outbound'

  const fromNumber = normalizePhone(row['from_phone_number'] as unknown ?? getFirst(row, ['from_number']))
  const toNumber = normalizePhone(row['to_phone_number'] as unknown ?? getFirst(row, ['to_number']))
  const ownerPhone = normalizePhone(getFirst(row, ['phone_number', 'canonical_e164']))

  if (ownerPhone && fromNumber && ownerPhone === fromNumber) return 'inbound'
  if (ownerPhone && toNumber && ownerPhone === toNumber) return 'outbound'

  return 'unknown'
}

const getThreadKeyParts = (
  row: AnyRecord,
  indexHint: number,
): { key: string; method: string; confidence: 'high' | 'medium' | 'low' } => {
  // Direct column access — actual message_events schema
  const ownerId = asString(row['master_owner_id'], '')
  const prospectId = asString(row['prospect_id'], '')
  const propertyId = asString(row['property_id'], '')
  const { sellerPhone } = getSellerPhoneFromMessage(row)

  // The inbox conversation is keyed by seller phone. Outbound rows often carry
  // owner/property IDs while inbound webhook rows do not, so phone-first keeps
  // replies merged with the original outreach thread.
  if (sellerPhone)
    return { key: `phone:${sellerPhone}`, method: 'seller_phone', confidence: 'medium' }
  if (ownerId && propertyId)
    return { key: `owner_property:${ownerId}:${propertyId}`, method: 'master_owner_id+property_id', confidence: 'medium' }
  if (prospectId && propertyId)
    return { key: `prospect_property:${prospectId}:${propertyId}`, method: 'prospect_id+property_id', confidence: 'low' }
  if (propertyId)
    return { key: `property:${propertyId}`, method: 'property_id', confidence: 'low' }
  if (ownerId)
    return { key: `owner:${ownerId}`, method: 'master_owner_id', confidence: 'low' }
  if (prospectId)
    return { key: `prospect:${prospectId}`, method: 'prospect_id', confidence: 'low' }
  return { key: `fallback:${indexHint}`, method: 'fallback_id', confidence: 'low' }
}

export const doesMessageBelongToThread = (
  messageRow: AnyRecord,
  selectedThread: InboxThread,
): boolean => {
  // Direct column access — actual message_events schema
  const ownerId = asString(messageRow['master_owner_id'], '')
  const propertyId = asString(messageRow['property_id'], '')
  const prospectId = asString(messageRow['prospect_id'], '')
  const { sellerPhone, canonicalE164: msgCanonical } = getSellerPhoneFromMessage(messageRow)

  const selectedOwnerId = asString(selectedThread.ownerId, '')
  const selectedPropertyId = asString(selectedThread.propertyId, '')
  const selectedProspectId = asString(selectedThread.prospectId, '')
  const selectedPhone = normalizePhone(selectedThread.phoneNumber)
  const selectedCanonical = normalizePhone(selectedThread.canonicalE164)
  const fromPhone = normalizePhone(messageRow['from_phone_number'] ?? getFirst(messageRow, ['from_number']))
  const toPhone = normalizePhone(messageRow['to_phone_number'] ?? getFirst(messageRow, ['to_number']))

  const keys = new Set<string>(
    [
      selectedThread.id,
      selectedThread.threadKey,
      selectedThread.leadId,
      selectedOwnerId,
      selectedPropertyId,
      selectedProspectId,
      selectedPhone,
      selectedCanonical,
    ].filter((v): v is string => Boolean(v)),
  )

  if (ownerId && keys.has(ownerId)) return true
  if (propertyId && keys.has(propertyId)) return true
  if (prospectId && keys.has(prospectId)) return true
  if (sellerPhone && keys.has(sellerPhone)) return true
  if (msgCanonical && keys.has(msgCanonical)) return true
  if (fromPhone && (fromPhone === selectedPhone || fromPhone === selectedCanonical)) return true
  if (toPhone && (toPhone === selectedPhone || toPhone === selectedCanonical)) return true

  if (selectedThread.threadKey) {
    const derived = getThreadKeyParts(messageRow, 0)
    if (derived.key === selectedThread.threadKey) return true
  }

  return false
}


const toQueryParam = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : null
}

const normalizeLiveThread = (row: AnyRecord, index: number): InboxThread => {
  const threadKey = asString(row['thread_key'] ?? row['threadKey'] ?? row['id'], '') || `live:${index}`
  const latestMessageIso = asIso(row['latest_message_at'] ?? row['latestMessageAt'] ?? row['lastMessageIso']) ?? new Date().toISOString()
  const latestDirection = normalizeMessageDirection({ direction: row['latest_direction'] ?? row['latestDirection'] ?? row['direction'] })
  
  // Mapping based on requirements
  const bestPhone = asString(row['best_phone'] ?? row['phone'] ?? row['canonical_e164'] ?? row['seller_phone'] ?? row['phoneNumber'], '')
  const sellerPhone = normalizePhone(bestPhone)
  
  const prospectName = asString(row['prospect_full_name'] ?? row['prospect_name'], '')
  const ownerDisplayName = prospectName || 'Unknown Prospect'
  
  const propertyAddressFull = asString(row['property_address_full'] ?? row['address'] ?? row['propertyAddressFull'], 'No Address')
  const latestMessageBody = asString(
    row['latest_message_body'] ??
    row['latest_inbound_message_body'] ??
    row['latest_inbound_body'] ??
    row['latestMessageBody'] ??
    row['preview'] ??
    row['message_body'] ??
    row['latest_outbound_message_body'] ??
    row['latest_outbound_body'],
    'No recent message',
  )
  
  const uiIntent = normalizeStatus(row['latest_intent'] ?? row['detected_intent'] ?? row['ui_intent'] ?? row['uiIntent'] ?? 'needs_review')
  const inboxCategory = asString(row['inbox_bucket'] ?? row['inbox_category'] ?? row['category'], 'all')
  const queueStatus = asString(row['queue_status'] ?? row['delivery_status'], '')
  
  const stage = asString(row['conversation_stage'] ?? row['seller_stage'] ?? row['queue_stage'] ?? row['thread_stage'] ?? row['detected_intent'] ?? row['inbox_category'] ?? row['workflow_stage'], 'ownership_check')
  const score = asNumber(row['final_acquisition_score'] ?? row['priority_score'], 0)
  
  const needsReply = asBoolean(row['needs_reply'] ?? row['needsReply'] ?? row['show_in_priority_inbox'] ?? row['showInPriorityInbox'], latestDirection === 'inbound' && !queueStatus)
  
  return {
    ...row, // Preserve all unmapped dossier fields from the proxy
    id: threadKey,
    leadId: asString(row['property_id'] ?? row['propertyId'] ?? row['master_owner_id'] ?? row['ownerId'], threadKey),
    marketId: asString(row['market'] ?? row['marketId'] ?? row['market_name'], 'unknown') || 'unknown',
    ownerName: ownerDisplayName,
    sellerName: asString(row['seller_name'] ?? row['owner_name'] ?? ownerDisplayName, ''),
    subject: propertyAddressFull,
    preview: latestMessageBody,
    status: asBoolean(row['is_archived'] ?? row['isArchived'], false) ? 'archived' : (needsReply ? 'unread' : 'read'),
    priority: needsReply ? 'urgent' : 'normal',
    sentiment: uiIntent === 'potential_interest' || uiIntent === 'price_anchor' ? 'hot' : 'neutral',
    messageCount: asNumber(row['message_count'] ?? row['messageCount'], 0),
    lastMessageLabel: formatRelativeTime(latestMessageIso),
    lastMessageIso: latestMessageIso,
    unreadCount: needsReply ? 1 : 0,
    aiDraft: queueStatus && queueStatus.includes('queued') ? 'Auto-reply decision available.' : null,
    labels: [uiIntent, inboxCategory].filter(Boolean),
    threadKey,
    ownerId: asString(row['master_owner_id'] ?? row['ownerId'], '') || undefined,
    prospectId: asString(row['prospect_id'] ?? row['prospectId'], '') || undefined,
    propertyId: asString(row['property_id'] ?? row['propertyId'], '') || undefined,
    phoneNumberId: asString(row['phone_number_id'] ?? row['phoneNumberId'] ?? row['best_phone_id'], '') || undefined,
    textgridNumberId: asString(row['textgrid_number_id'] ?? row['textgridNumberId'], '') || undefined,
    phoneNumber: sellerPhone || undefined,
    canonicalE164: sellerPhone || undefined,
    sellerPhone: sellerPhone || undefined,
    ourNumber: normalizePhone(row['our_number'] ?? row['ourNumber'] ?? row['textgrid_phone']) || undefined,
    directionUsed: latestDirection,
    latestDirection,
    autoReplyStatus: queueStatus,
    needsReply,
    needsResponse: needsReply,
    deliveryStatus: queueStatus,
    failureReason: asString(row['failure_reason'] ?? row['failureReason'] ?? row['error_message'], ''),
    isOptOut: asBoolean(row['is_opt_out'] ?? row['isOptOut'], false),
    propertyAddress: propertyAddressFull !== 'No Address' ? propertyAddressFull : undefined,
    propertyAddressFull,
    market: asString(row['market'] ?? row['marketName'] ?? row['market_id'], 'unknown'),
    marketName: asString(row['market_name'] ?? row['marketName'] ?? row['market'], ''),
    lastInboundAt: latestDirection === 'inbound' ? latestMessageIso : asIso(row['last_inbound_at'] ?? row['lastInboundAt']),
    lastOutboundAt: latestDirection === 'outbound' ? latestMessageIso : asIso(row['last_outbound_at'] ?? row['lastOutboundAt']),
    unread: needsReply,
    uiIntent,
    priorityBucket: normalizeStatus(row['inbox_bucket'] ?? row['inboxCategory'] ?? row['priority_bucket'] ?? row['priorityBucket'] ?? (needsReply ? 'priority' : 'active')),
    workflowStatus: normalizeStatus(row['review_status'] ?? row['conversation_status'] ?? row['workflow_status'] ?? row['workflowStatus'] ?? row['status'] ?? 'open'),
    workflowStage: stage,
    threadWorkflowStatus: normalizeStatus(row['review_status'] ?? row['conversation_status'] ?? row['workflow_status'] ?? row['workflowStatus'] ?? row['status'] ?? 'open'),
    threadWorkflowStage: stage,
    ownerDisplayName,
    latestMessageBody,
    latestMessageAt: latestMessageIso,
    matchedKeywords: safeArray((row['matched_keywords'] ?? row['matchedKeywords']) as string[]),
    lat: asNumber(row['lat'] ?? row['latitude'], 0),
    lng: asNumber(row['lng'] ?? row['longitude'], 0),
    ownerType: asString(row['owner_type'] ?? row['ownerType'], ''),
    propertyType: asString(row['property_type'] ?? row['propertyType'], ''),
    propertyClass: asString(row['property_class'] ?? row['propertyClass'], ''),
    finalAcquisitionScore: score,
    priorityScore: score,
    inboxCategory,
  } as InboxThread
}


const normalizeLiveInboxResponse = (payload: AnyRecord, fallbackLimit: number): LiveInboxResponse => {
  const rawThreads = safeArray(payload['threads'] as AnyRecord[])
  const rawMessages = safeArray(payload['messages'] as AnyRecord[])
  const rawPins = safeArray((payload['mapPins'] ?? payload['map_pins']) as AnyRecord[])
  const pagination = (payload['pagination'] ?? {}) as AnyRecord
  return {
    threads: rawThreads.map(normalizeLiveThread),
    messages: rawMessages.map(toThreadMessage),
    counts: (payload['counts'] ?? {}) as Record<string, number | null | undefined>,
    mapPins: rawPins.map((pin, index) => ({
      id: asString(pin['id'], `pin:${index}`),
      threadKey: asString(pin['thread_key'] ?? pin['threadKey'], ''),
      lat: asNumber(pin['lat'] ?? pin['latitude'], 0),
      lng: asNumber(pin['lng'] ?? pin['longitude'], 0),
      status: asString(pin['status'], ''),
      stage: asString(pin['stage'], ''),
      ownerName: asString(pin['owner_name'] ?? pin['ownerName'], ''),
      propertyAddress: asString(pin['property_address'] ?? pin['propertyAddress'], ''),
      latestMessageBody: asString(pin['latest_message_body'] ?? pin['latestMessageBody'], ''),
    })),
    pagination: {
      cursor: asString(pagination['cursor'], '') || null,
      nextCursor: asString(pagination['nextCursor'] ?? pagination['next_cursor'], '') || null,
      hasMore: asBoolean(pagination['hasMore'] ?? pagination['has_more'], rawThreads.length >= fallbackLimit),
      limit: asNumber(pagination['limit'], fallbackLimit),
      total: Number.isFinite(Number(pagination['total'])) ? Number(pagination['total']) : null,
    },
  }
}

export const fetchLiveInbox = async ({
  filter = 'all',
  direction = 'all',
  q = '',
  keywordGroup = '',
  cursor = null,
  limit = 200,
  map = true,
  signal,
}: LiveInboxFetchParams = {}): Promise<LiveInboxResponse> => {
  const params = new URLSearchParams()
  const entries: Record<string, unknown> = { filter, direction, q, keywordGroup, cursor, limit, map: map ? '1' : '0' }
  Object.entries(entries).forEach(([key, value]) => {
    const param = toQueryParam(value)
    if (param) params.set(key, param)
  })

  const result = await backendClient.fetchLiveInbox(params.toString(), signal)
  if (!result.ok) {
    const errorMsg = result.message || result.error || 'Unknown API error'
    throw new Error(`Live inbox API failed (${result.status}): ${errorMsg}`)
  }
  const payload = result.data as AnyRecord
  const normalizedPayload = asBoolean(payload['ok'], false)
    ? ((payload['diagnostics'] as AnyRecord) ?? payload)
    : payload
  return normalizeLiveInboxResponse(normalizedPayload, limit)
}

const runFilteredQuery = async (
  tableOrAlias: string,
  filters: Array<{ key: string; value: string }>,
  limit = 20,
): Promise<AnyRecord[]> => {
  const table = await resolveTable(tableOrAlias)
  if (!table) return []
  const supabase = getSupabaseClient()
  let query = supabase.from(table).select('*').limit(limit)
  const allowedColumns = FILTER_COLUMNS_BY_ALIAS[tableOrAlias]
  const valid = filters.filter((f) => f.value && (!allowedColumns || allowedColumns.includes(f.key)))
  if (valid.length > 0) {
    const orClause = valid.map((f) => `${f.key}.eq.${safeFilterValue(f.value)}`).join(',')
    query = query.or(orClause)
  } else if (filters.some((f) => f.value)) {
    return []
  }
  const { data, error } = await query
  if (error) {
    if (DEV) console.warn(`[NEXUS] ${table} lookup failed`, error.message)
    return []
  }
  return safeArray(data as AnyRecord[])
}

export const normalizeInboxThread = (row: AnyRecord, offset = 0, index = 0): InboxThread => {
  const id = asString(row.thread_key, `hydrated-thread:${offset + index}`)
  const threadKey = id
  const masterOwnerId = asString(row.master_owner_id, '')
  const propertyId = asString(row.property_id, '')
  const ownerName = asString(row.owner_name ?? row.prospect_name, 'Unknown Owner')
  const sellerName = ownerName
  const propertyAddress = asString(row.property_address ?? row.property_address_full, 'Unknown Address')
  const address = propertyAddress
  const market = asString(row.market, 'Unknown Market')
  const phone = threadKey
  const bestPhone = asString(row.best_phone ?? row.seller_phone ?? row.canonical_e164, '')
  const latestMessageBody = asString(row.latest_message_body ?? row.last_message_body, '')
  const latestMessageAt = asIso(row.latest_message_at ?? row.last_message_at) ?? new Date().toISOString()
  const latestMessageDirection = normalizeMessageDirection({ direction: row.latest_message_direction ?? row.direction })
  const direction = latestMessageDirection
  const inboxBucket = asString(row.inbox_bucket ?? row.inbox_category ?? row.priority_bucket, 'all_messages').toLowerCase()
  const status = normalizeStatus(row.universal_status ?? row.inbox_status ?? 'unknown')
  const stage = normalizeStatus(row.universal_stage ?? row.conversation_stage ?? row.stage ?? 'unknown')
  const universalStatus = status
  const universalStage = stage
  const unreadCountRaw = asNumber(row.unread_count ?? row.unread, 0)
  const unreadCount = Math.max(0, unreadCountRaw)
  const replyIntent = asString(row.reply_intent ?? row.ui_intent ?? row.detected_intent, '')
  const leadTemperature = asString(row.lead_temperature ?? row.priority_score, '')
  const suppressionStatus = asString(row.suppression_status, '')
  const optOut = asBoolean(row.opt_out ?? row.is_dnc ?? row.has_opt_out ?? row.is_suppressed, false)
  const wrongNumber = asBoolean(row.wrong_number, false)
  const notInterested = asBoolean(row.not_interested, false)
  const needsReview = asBoolean(row.needs_review, false)

  // Map to the existing PRIORITY_BUCKET_MAP if possible
  const PRIORITY_BUCKET_MAP: Record<string, HydratedInboxCategory> = {
    hot: 'hot_leads',
    priority: 'hot_leads',
    hot_leads: 'hot_leads',
    needs_review: 'needs_review',
    review: 'needs_review',
    new_inbound: 'new_inbound',
    new_replies: 'new_inbound',
    unread: 'new_inbound',
    automated: 'automated',
    auto: 'automated',
    outbound_active: 'outbound_active',
    outbound: 'outbound_active',
    follow_up: 'outbound_active',
    cold_no_response: 'cold_no_response',
    cold: 'cold_no_response',
    normal: 'cold_no_response',
    dnc_opt_out: 'dnc_opt_out',
    suppressed: 'dnc_opt_out',
    dnc: 'dnc_opt_out',
    hidden: 'dnc_opt_out',
    all_inbound: 'all_inbound' as any,
  }
  const category = (PRIORITY_BUCKET_MAP[inboxBucket] ?? 'cold_no_response') as HydratedInboxCategory

  return {
    ...row,
    id,
    threadKey,
    thread_id: threadKey,
    masterOwnerId,
    propertyId,
    ownerName,
    sellerName,
    propertyAddress,
    address,
    market,
    phone,
    bestPhone,
    latestMessageBody,
    latestMessageAt,
    latestMessageDirection,
    direction,
    inboxBucket,
    status,
    stage,
    universalStatus,
    universalStage,
    unreadCount,
    replyIntent,
    leadTemperature,
    suppressionStatus,
    optOut,
    wrongNumber,
    notInterested,
    needsReview,
    
    owner: { name: ownerName },
    property: { address: propertyAddress, market },
    latestMessage: {
      body: latestMessageBody,
      at: latestMessageAt,
      direction: latestMessageDirection
    },
    state: {
      bucket: inboxBucket,
      status,
      stage
    },

    // Legacy fallback fields UI might still depend on
    leadId: propertyId || masterOwnerId || threadKey,
    marketId: market,
    ownerDisplayName: ownerName,
    subject: propertyAddress,
    preview: latestMessageBody,
    latest_message_body: latestMessageBody,
    latestMessage: latestMessageBody,
    latest_activity_at: latestMessageAt,
    latest_message_direction: latestMessageDirection,
    lastMessageLabel: formatRelativeTime(latestMessageAt),
    lastMessageIso: latestMessageAt,
    unread: unreadCount > 0,
    priorityBucket: category,
    inboxCategory: category,
    inbox_category: category,
    workflowStatus: status,
    workflowStage: stage,
    isArchived: false,
    isRead: unreadCount === 0,
    isPinned: false,
    isStarred: false,
    isSuppressed: optOut,
    isDnc: optOut,
    sellerPhone: bestPhone,
    display_phone: bestPhone ? formatDisplayPhone(bestPhone) : '',
    canonicalE164: bestPhone,
    marketName: market,
    propertyAddressFull: propertyAddress,
  } as InboxThread
}

/**
 * CANONICAL FUNCTION: Fetch both backend count and rows for a specific view.
 * Ensures parity between sidebar badges and rendered list.
 */
export const getInboxRowsForView = async (
  view: InboxViewSelectValue,
  options: InboxFetchOptions = {}
): Promise<{
  view_key: string;
  backend_count: number;
  rows: InboxThread[];
  rendered_count: number;
  has_more: boolean;
  next_cursor: string | null;
}> => {
  const page_size = options.maxRows ?? options.limit ?? HYDRATED_INBOX_PAGE_SIZE
  const offset = Number.parseInt(options.cursor ?? '0', 10) || (options.offset ?? 0)
  
  let inbox_bucket = 'all_messages'
  if (view === 'new_replies' || view === 'new_inbound' || view === 'needs_reply') inbox_bucket = 'new_replies'
  else if (view === 'priority' || view === 'negotiating') inbox_bucket = 'priority'
  else if (view === 'follow_up' || view === 'follow_up_due') inbox_bucket = 'follow_up'
  else if (view === 'cold' || view === 'cold_no_response' || view === 'waiting_on_seller') inbox_bucket = 'cold'
  else if (view === 'needs_review' || view === 'manual_review') inbox_bucket = 'needs_review'
  else if (view === 'suppressed' || view === 'dnc_opt_out' || view === 'opt_out') inbox_bucket = 'suppressed'
  else if (view === 'all_messages' || view === 'all') inbox_bucket = 'all_messages'
  
  const params = new URLSearchParams()
  params.set('inbox_bucket', inbox_bucket)
  params.set('limit', String(page_size))
  params.set('cursor', String(offset))
  if (options.filters?.query) params.set('q', options.filters.query)
  
  const result = await backendClient.fetchInboxThreads(params.toString(), options.signal)
  const payload = result.ok
    ? ((result.data ?? {}) as AnyRecord)
    : (() => {
        if (DEV) console.warn('[getInboxRowsForView] /threads unavailable, falling back to /live', result.message || result.error)
        return null
      })()

  // Normalize the threads response to support all shapes
  const threadsRaw =
    payload?.data?.threads ??
    payload?.threads ??
    payload?.items ??
    payload?.data ??
    []

  const countRaw =
    payload?.data?.count ??
    payload?.count ??
    threadsRaw.length

  if (DEV && result.ok) {
    console.log('[Inbox] /threads payload', {
      ok: result.ok,
      threadCount: threadsRaw.length,
      count: countRaw,
      sample: threadsRaw[0]
    })
    console.log('[Inbox] fetch complete', {
      url: '/api/cockpit/threads',
      status: result.status,
      threadCount: threadsRaw.length,
      count: countRaw
    })
  }

  // Stop falling back to /live if /threads returned ok: true
  const fallbackLive = !result.ok
    ? await fetchLiveInbox({
        filter: view === ('all_messages' as any) ? 'all' : String(view || 'all'),
        q: options.filters?.query || '',
        cursor: String(offset),
        limit: page_size,
        map: false,
        signal: options.signal,
      }).catch(err => {
        if (DEV) console.error('[getInboxRowsForView] fetchLiveInbox failed', err)
        emitNotification({
          title: 'Live Inbox Error',
          body: 'Failed to fetch live inbox data. Returning empty view.',
          severity: 'error'
        })
        return { threads: [], pagination: { total: 0, has_more: false } }
      })
    : null

  const diagnostics = fallbackLive ? ((fallbackLive as unknown) as AnyRecord) : {}
  const fallbackThreads = safeArray((diagnostics.threads ?? []) as AnyRecord[])
  const rowsRaw = result.ok ? safeArray(threadsRaw) : fallbackThreads

  const rows = rowsRaw.map((row, index) => normalizeInboxThread(row, offset, index))
  const pagination = (diagnostics.pagination ?? {}) as AnyRecord
  const backendCount = result.ok ? asNumber(countRaw, rows.length) : asNumber(pagination.total, rows.length)
  const nextCursor = result.ok ? null : asString(pagination.next_cursor ?? pagination.nextCursor, '') || null

  if (DEV && result.ok) {
    console.log('[Inbox] threads normalized', {
      bucket: view,
      rawCount: threadsRaw.length,
      normalizedCount: rows.length,
      totalCount: backendCount,
      sampleRaw: threadsRaw[0],
      sampleNormalized: rows[0]
    })
  }

  return {
    view_key: view,
    backend_count: backendCount,
    rows,
    rendered_count: rows.length,
    has_more: asBoolean(pagination.has_more ?? pagination.hasMore, Boolean(nextCursor)),
    next_cursor: nextCursor,
  }
}

export const getInboxThreads = async (
  filters: InboxThreadFilters = {},
  options: InboxFetchOptions = {},
): Promise<{ threads: InboxThread[], totalAvailable: number }> => {
  const supabase = getSupabaseClient()
  const supabaseEnabled = hasSupabaseEnv && shouldUseSupabase()
  
  if (DEV) {
    console.log('[getInboxThreads] supabaseEnabled=', supabaseEnabled, {
      hasSupabaseEnv,
      shouldUseSupabase: shouldUseSupabase(),
      url: import.meta.env.VITE_SUPABASE_URL ? 'set' : 'missing',
      key: import.meta.env.VITE_SUPABASE_ANON_KEY ? 'set' : 'missing',
    })
  }

  const maxRows = Number.isFinite(options.maxRows ?? Number.NaN)
    ? Math.max(1, Number(options.maxRows))
    : HYDRATED_INBOX_PAGE_SIZE
  const filterState = options.filters ?? filters
  const viewCategories = getHydratedCategoriesForView(filterState.view)
  const offset = Number.parseInt(options.cursor ?? '', 10)
  const startOffset = Number.isFinite(offset) ? offset : Math.max(0, options.offset ?? 0)

  let countQuery: any = supabase
    .from(HYDRATED_INBOX_THREADS_VIEW)
    .select('thread_key', { count: 'estimated', head: true })
  countQuery = applyInboxSearchServerFilter(countQuery, filterState.query)
  countQuery = applyInboxAdvancedServerFilters(countQuery, filterState.advanced)
  if (viewCategories.length === 1) {
    countQuery = countQuery.eq('inbox_category', viewCategories[0])
  } else if (viewCategories.length > 1) {
    countQuery = countQuery.in('inbox_category', viewCategories)
  }

  if (options.signal) countQuery = countQuery.abortSignal(options.signal)

  const { count: rawCount, error: countError } = await countQuery
  if (countError && DEV) {
    console.warn('[getInboxThreads] countQuery fallback:', mapErrorMessage(countError))
  }

  const supressNullCount = (v: number | null | undefined): number => (v == null ? 0 : v)

  let query: any = supabase
    .from('message_events')
    .select('thread_key, to_phone_number, from_phone_number, direction, message_body, created_at, unread', { count: 'exact' })
    .in('direction', ['inbound', 'outbound'])
    .order('created_at', { ascending: false })
    .range(startOffset, startOffset + maxRows - 1)

  // Temporarily bypass all filters
  // query = applyInboxSearchServerFilter(query, filterState.query)
  // query = applyInboxAdvancedServerFilters(query, filterState.advanced)
  // if (viewCategories.length === 1) {
  //   query = query.eq('inbox_category', viewCategories[0])
  // } else if (viewCategories.length > 1) {
  //   query = query.in('inbox_category', viewCategories)
  // }

  // if (filterState.stage && filterState.stage !== 'all_stages') {
  //   query = query.eq('stage', filterState.stage)
  // }
  if (options.signal) query = query.abortSignal(options.signal)

  let data: AnyRecord[] = []
  let queryError: string | null = null
  try {
    const result = await query
    if (result.error) throw result.error
    
    // Group by thread_key / phones
    const threadsMap = new Map<string, AnyRecord>()
    for (const event of (result.data || [])) {
      const phones = [event.from_phone_number, event.to_phone_number].filter(Boolean).sort().join(':')
      const key = event.thread_key || phones || 'unknown'
      
      if (!threadsMap.has(key)) {
        threadsMap.set(key, {
          thread_key: key,
          latest_message_at: event.created_at,
          latest_message_body: event.message_body,
          latest_direction: event.direction,
          unread_count: event.direction === 'inbound' ? 1 : 0,
          is_read: event.unread === false,
          phone: event.from_phone_number !== '+10000000000' ? event.from_phone_number : event.to_phone_number,
          best_phone: event.from_phone_number,
          inbox_category: 'hot_leads', // temporary dummy
        })
      }
    }
    data = Array.from(threadsMap.values())
  } catch (err) {
    queryError = mapErrorMessage(err)
    if (DEV) {
        console.error('[getInboxThreads] query failed', {
            filterState,
            startOffset,
            maxRows,
            error: queryError
        })
    }
    // We do NOT throw here as requested: "Revert any recent frontend change that silently returns [] on API failure."
    // Actually we do throw here, and let the caller show the error banner. Or wait, if we bypass, it shouldn't fail.
    // If it still fails, the UI needs to handle the error. For now, throw it so UI handles it if we implement that.
    throw new Error(`Inbox threads bypass query failed: ${queryError}`)
  }

  const totalAvailable = countError ? supressNullCount(null) : supressNullCount(rawCount)

  if (queryError) {
    return { threads: [], totalAvailable }
  }

  const rows = safeArray(data as AnyRecord[])

  if (DEV) {
    console.log('[getInboxThreads] rawHydratedRows', {
      count: rows.length,
      totalAvailable,
      firstHydratedRow: rows[0] ?? null,
      view: filterState.view,
      stage: filterState.stage,
      query: filterState.query,
    })
  }

  const threads = rows.map((row, index) => {
    const derivedThreadKey = [
      asString(row.thread_key, ''),
      asString(row.canonical_e164, ''),
      asString(row.best_phone, ''),
      asString(row.phone, ''),
      [asString(row.master_owner_id, ''), asString(row.property_id, '')].filter(Boolean).join(':'),
      asString(row.prospect_id, ''),
    ].find((value) => Boolean(value && String(value).trim()))
    const threadKey = derivedThreadKey || `hydrated-thread:${startOffset + index}`
    
    if (DEV && index === 0) {
      console.log('[getInboxThreads] normalizing row[0]:', {
        thread_key: row.thread_key,
        prospect_name: row.prospect_name,
        owner_name: row.owner_name,
        first_name: row.first_name,
        best_phone: row.best_phone,
        canonical_e164: row.canonical_e164,
        phone: row.phone,
        property_address_full: row.property_address_full,
        latest_message_body: row.latest_message_body ? String(row.latest_message_body).slice(0, 50) : null,
        latest_message_at: row.latest_message_at,
        inbox_category: row.inbox_category,
        queue_stage: row.queue_stage,
        detected_intent: row.detected_intent,
      })
    }

    const latestMessageIso = asIso(row.latest_message_at) ?? new Date().toISOString()
    // nexus_inbox_threads_v uses priority_bucket; inbox_threads_hydrated uses inbox_category
    const rawCategory = asString(row.inbox_bucket || row.inbox_category || row.priority_bucket, '').toLowerCase()
    // Map nexus_inbox_threads_v priority_bucket values to internal HydratedInboxCategory names
    const PRIORITY_BUCKET_MAP: Record<string, HydratedInboxCategory> = {
      hot: 'hot_leads',
      priority: 'hot_leads',
      hot_leads: 'hot_leads',
      needs_review: 'needs_review',
      review: 'needs_review',
      new_inbound: 'new_inbound',
      unread: 'new_inbound',
      automated: 'automated',
      auto: 'automated',
      outbound_active: 'outbound_active',
      outbound: 'outbound_active',
      cold_no_response: 'cold_no_response',
      cold: 'cold_no_response',
      normal: 'cold_no_response',
      dnc_opt_out: 'dnc_opt_out',
      suppressed: 'dnc_opt_out',
      dnc: 'dnc_opt_out',
      hidden: 'dnc_opt_out',
    }
    const category = (PRIORITY_BUCKET_MAP[rawCategory] ?? 'cold_no_response') as HydratedInboxCategory
    const finalAcquisitionScore = asNumber(row.final_acquisition_score, 0)
    const latestDirection = normalizeMessageDirection({ direction: row.latest_direction })
    const unreadCount = Math.max(0, asNumber(row.unread_count, latestDirection === 'inbound' && !asBoolean(row.is_read, false) ? 1 : 0))

    // Fallback display name order:
    // 1. prospect_full_name
    // 2. owner_display_name
    // 3. seller_display_name
    // 4. seller_phone
    // 5. thread_key
    const sellerPhone = asString(row.best_phone || row.seller_phone || row.canonical_e164 || row.phone, '')
    const canonicalE164 = asString(row.canonical_e164 || sellerPhone, '')
    const bestPhone = sellerPhone
    const displayPhone = sellerPhone ? formatDisplayPhone(sellerPhone) : ''
    
    const ownerDisplayName = asString(
      row.seller_name ??
      row.owner_name ??
      row.prospect_full_name ??
      row.prospect_name ??
      row.owner_display_name,
      ''
    ) || 'Unknown Seller'

    // Fallback address order:
    // 1. property_address_full
    // 2. property_address
    // 3. latest property_address from message_events (already rolled into property_address_full in views)
    // 4. "Unknown Property"
    const address = [
      asString(row.property_address_full, ''),
      asString(row.property_address, ''),
    ].find(v => v && v.trim()) || 'Unknown Property'
    
    // filter_market comes from v_inbox_enriched (properties.market); fall back to
    // the view's own market field which comes from message_events and is usually 'unknown'.
    const market = asString(row.filter_market ?? (row.market !== 'unknown' ? row.market : null), '') || asString(row.market, '')
    const marketLabel = (market && market !== 'unknown' && market !== 'Unknown') ? market : 'Unknown Market'
    
    const latestBody = asString(row.latest_message_body, '') || 'No recent message'
    const propertyType = asString(row.property_type, '')
    const propertyClass = asString(row.property_class, '')
    const queueStatus = normalizeStatus(row.queue_status ?? '')
    const automationState = normalizeStatus(row.automation_state ?? row.queue_status ?? '')
    // nexus_inbox_threads_v uses ui_intent; older views use detected_intent
    const detectedIntent = normalizeStatus(row.latest_intent ?? row.ui_intent ?? row.detected_intent ?? '')
    // Stage: stage (nexus view) || queue_stage || detected_intent
    const threadStage = normalizeStatus(row.conversation_stage ?? row.seller_stage ?? row.stage ?? row.queue_stage ?? row.detected_intent ?? row.inbox_category ?? 'ownership_check')
    const isDnc = asBoolean(row.is_suppressed || row.is_dnc || row.has_opt_out, false) || category === 'dnc_opt_out'
    const isAutomated = category === 'automated' || automationState.includes('auto')
    
    const status: InboxThread['status'] = unreadCount > 0 ? 'unread' : 'read'
    const priority: InboxThread['priority'] =
      category === 'hot_leads' || asBoolean(row.is_hot_lead, false) ? 'urgent'
      : category === 'needs_review' || category === 'new_inbound' || asBoolean(row.is_new_inbound, false) ? 'high'
      : category === 'dnc_opt_out' ? 'low'
      : 'normal'
    const sentiment: InboxThread['sentiment'] =
      category === 'hot_leads' || asBoolean(row.is_hot_lead, false) ? 'hot'
      : category === 'needs_review' || category === 'new_inbound' ? 'warm'
      : category === 'dnc_opt_out' || category === 'cold_no_response' ? 'cold'
      : 'neutral'

    const labels = [
      marketLabel,
      propertyType,
      asString(row.language_preference, ''),
    ].filter(Boolean)

    const normalized = {
      ...row,
      id: threadKey,
      threadKey,
      thread_id: threadKey,
      leadId: asString(row.property_id ?? row.master_owner_id ?? row.prospect_id, '') || threadKey,
      market: marketLabel,
      marketId: marketLabel,
      marketName: marketLabel,
      ownerName: ownerDisplayName,
      ownerDisplayName,
      sellerName: asString(row.seller_name ?? row.owner_name ?? ownerDisplayName, ''),
      subject: address,
      preview: latestBody,
      latest_message_body: latestBody,
      latestMessageBody: latestBody,
      latestMessage: latestBody,
      latestMessageAt: latestMessageIso,
      latest_activity_at: latestMessageIso,
      latest_message_direction: latestDirection,
      latestDirection: latestDirection,
      lastMessageLabel: formatRelativeTime(latestMessageIso),
      lastMessageIso: latestMessageIso,
      status,
      priority,
      sentiment,
      unreadCount,
      unread: unreadCount > 0,
      messageCount: asNumber(row.inbound_count, 0) + asNumber(row.outbound_count, 0),
      aiDraft: isAutomated ? 'Automation active' : null,
      labels,
      inbound_count: asNumber(row.inbound_count, 0),
      outbound_count: asNumber(row.outbound_count, 0),
      ownerId: asString(row.master_owner_id, '') || undefined,
      prospectId: asString(row.prospect_id, '') || undefined,
      propertyId: asString(row.property_id, '') || undefined,
      phoneNumber: displayPhone || undefined,
      display_phone: displayPhone || undefined,
      sellerPhone: displayPhone || undefined,
      canonicalE164: canonicalE164 || undefined,
      bestPhone: bestPhone || undefined,
      propertyAddress: address,
      propertyAddressFull: address,
      propertyType: propertyType || undefined,
      propertyClass: propertyClass || undefined,
      beds: row.beds as string | number,
      baths: row.baths as string | number,
      sqft: row.sqft as string | number,
      yearBuilt: row.year_built as string | number,
      equityAmount: asNumber(row.equity_percent, 0) > 0 && asNumber(row.estimated_value, 0) > 0
        ? (asNumber(row.equity_percent, 0) / 100) * asNumber(row.estimated_value, 0)
        : 0,
      equityPercent: asNumber(row.equity_percent, 0),
      estimatedRepairCost: asNumber(row.estimated_repair_cost, 0),
      estimatedValue: row.estimated_value ?? null,
      finalAcquisitionScore: finalAcquisitionScore || null,
      motivationScore: asNumber(row.priority_score, 0),
      ownerType: asString(row.owner_type, '') || undefined,
      contactLanguage: asString(row.language_preference, '') || undefined,
      lat: asNumber(row.latitude, 0) || undefined,
      lng: asNumber(row.longitude, 0) || undefined,
      uiIntent: detectedIntent,
      priorityBucket: category,
      inboxCategory: category,
      inbox_category: category,
      workflowStatus: queueStatus || automationState || category,
      workflowStage: threadStage,
      threadWorkflowStage: threadStage,
      threadWorkflowStatus: queueStatus || automationState || category,
      threadIsRead: unreadCount === 0,
      threadIsArchived: asBoolean(row.is_archived || row.thread_is_archived, false),
      threadIsPinned: asBoolean(row.is_pinned || row.thread_is_pinned, false),
      threadIsStarred: asBoolean(row.is_starred || row.thread_is_starred, false),
      threadIsHidden: asBoolean(row.is_hidden || row.thread_is_hidden, false),
      threadIsSuppressed: isDnc,
      showInPriorityInbox: asBoolean(row.show_in_priority_inbox, false) || HYDRATED_PRIORITY_CATEGORIES.has(category) || asBoolean(row.is_hot_lead, false) || asBoolean(row.is_new_inbound, false),
      needsResponse: HYDRATED_PRIORITY_CATEGORIES.has(category) || unreadCount > 0,
      needsReply: category === 'new_inbound' || unreadCount > 0,
      needs_reply: category === 'new_inbound' || unreadCount > 0,
      autoReplyStatus: automationState || queueStatus || undefined,
      
      // Dossier Expansion
      displayName: asString(row.display_name, ownerDisplayName),
      displayAddress: asString(row.display_address, address),
      displayPhone: asString(row.display_phone, displayPhone),
      displayMarket: (row.filter_market && row.filter_market !== 'Unknown')
        ? asString(row.filter_market, marketLabel)
        : (row.display_market && row.display_market !== 'Unknown')
          ? asString(row.display_market, marketLabel)
          : marketLabel,
      displayStatus: asString(row.display_status, status),
      displayScore: asNumber(row.display_score, finalAcquisitionScore),

      // Canonical seller state fields (from v_inbox_enriched)
      seller_state: asString(row.seller_state, ''),
      seller_status: asString(row.seller_status, ''),
      execution_state: asString(row.execution_state, ''),
      pipeline_stage: asString(row.pipeline_stage, ''),

      // Filter Metadata
      filterState: row.filter_state,
      filterCity: row.filter_city,
      filterZip: row.filter_zip,
      filterMarket: row.filter_market ?? row.market,
      filterPropertyType: row.filter_property_type,
      filterOwnerType: row.filter_owner_type,
      filterLanguage: row.filter_language,
      filterAgentPersona: row.filter_agent_persona,
      filterPriorityTier: row.filter_priority_tier,
    }

    if (DEV && index === 0) {
      console.log('[getInboxThreads] normalized thread[0]:', {
        id: normalized.id,
        ownerName: normalized.ownerName,
        subject: normalized.subject,
        latestMessage: normalized.latestMessageBody,
        status: normalized.status,
        priority: normalized.priority,
        category,
        normalizationDropReasons: !normalized.id ? ['missing thread_key'] : [],
      })
    }

    return normalized as InboxThread
  })
  const missingThreadKeys = rows.filter((row) => !asString(row.thread_key, '')).length
  const dedupedThreads = dedupeThreadsByKey(threads)
  const duplicateCount = threads.length - dedupedThreads.length

  if (DEV) {
    console.log('[NexusInboxFilterQuery]', {
      source: HYDRATED_INBOX_THREADS_VIEW,
      mode: filterState.view || 'all',
      stage: filterState.stage || 'all_stages',
      query: filterState.query || '',
      offset: startOffset,
      limit: maxRows,
      returned: rows.length,
      totalAvailable: countError ? rows.length : (totalAvailable ?? rows.length),
    })
    console.log('[getInboxThreads] normalizedThreads', {
      count: dedupedThreads.length,
      firstNormalizedThread: dedupedThreads[0] ?? null,
      duplicateCount,
      missingThreadKeys,
    })
  }

  return { threads: dedupedThreads, totalAvailable: countError ? dedupedThreads.length : (totalAvailable ?? dedupedThreads.length) }
}

export const fetchInboxMapPins = async (
  filters: InboxThreadFilters = {},
): Promise<LiveInboxMapPin[]> => {
  const supabase = getSupabaseClient()
  // Use canonical v_map_property_pins which has lat/lng data
  let query = supabase
    .from('v_map_property_pins')
    .select('*')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  const filterState = filters
  query = applyInboxSearchServerFilter(query, filterState.query)

  const { data, error } = await query

  if (error) {
    if (DEV) console.warn('[fetchInboxMapPins] failed', mapErrorMessage(error))
    if (error.message?.includes('does not exist')) {
      emitNotification({
        title: 'Map pins unavailable',
        body: 'Map pins unavailable — view missing.',
        severity: 'warning'
      })
    }
    return []
  }

  const rows = safeArray(data as AnyRecord[])
  const pins = rows.map((row, index) => ({
    id: asString(row.thread_key ?? row.threadKey ?? row.id, `pin:${index}`),
    threadKey: asString(row.thread_key ?? row.threadKey, ''),
    lat: asNumber(row.latitude, 0),
    lng: asNumber(row.longitude, 0),
    status: asString(row.status ?? row.thread_stage, ''),
    stage: asString(row.stage ?? row.thread_stage, ''),
    ownerName: asString(row.owner_name ?? row.ownerName ?? row.prospect_name, ''),
    propertyAddress: asString(row.property_address ?? row.propertyAddress ?? row.property_address_full, ''),
    latestMessageBody: asString(row.latest_message_body ?? row.latestMessageBody, ''),
  }))
  const deduped = dedupeMapPinsByThreadKey(pins)
  if (DEV) {
    console.log('[NexusInboxMapHydration]', {
      sourceRows: rows.length,
      dedupedPins: deduped.length,
      duplicatePinsRemoved: rows.length - deduped.length,
      missingThreadKeys: pins.filter((pin) => !pin.threadKey).length,
      invalidCoordinates: pins.filter((pin) => !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng) || pin.lat === 0 || pin.lng === 0).length,
    })
  }
  return deduped
}

export const fetchInboxModel = async (options: InboxFetchOptions = {}): Promise<InboxModel> => {
  const lastLiveFetchAt = new Date().toISOString()
  const filterState = options.filters || {}
  
  const [viewResult, mapPins] = await Promise.all([
    getInboxRowsForView((filterState.view || 'priority') as InboxViewSelectValue, options),
    fetchInboxMapPins(filterState),
  ])

  let allInboundCount = 0
  try {
    const { count: allInboundRaw, error: allInboundError } = await getSupabaseClient()
      .from(HYDRATED_INBOX_THREADS_VIEW)
      .select('thread_key', { count: 'estimated', head: true })
      .gt('inbound_count', 0)
    if (!allInboundError) allInboundCount = allInboundRaw ?? 0
  } catch (err) {
    if (DEV) console.warn('[fetchInboxModel] allInboundCount fetch failed', err)
  }

  const { rows: threads, backend_count: totalAvailable } = viewResult
  let categoryCounts = {
    hot_leads: 0,
    needs_review: 0,
    new_inbound: 0,
    automated: 0,
    outbound_active: 0,
    cold_no_response: 0,
    all: 0,
    dnc_opt_out: 0,
    all_inbound: 0
  }

  try {
    const res = await backendClient.fetchInboxCounts(options.signal)
    if (res.ok) {
      const payload = res.data as AnyRecord
      const rawCounts = (payload?.data?.counts ?? payload?.counts ?? payload?.data ?? {}) as AnyRecord
      
      categoryCounts = {
        hot_leads: Number(rawCounts.priority) || 0,
        needs_review: Number(rawCounts.needs_review) || 0,
        new_inbound: Number(rawCounts.new_replies) || 0,
        automated: 0,
        outbound_active: Number(rawCounts.follow_up) || 0,
        cold_no_response: Number(rawCounts.cold) || 0,
        all: Number(rawCounts.all_messages) || 0,
        dnc_opt_out: Number(rawCounts.suppressed) || 0,
        all_inbound: allInboundCount
      }
    } else {
      if (DEV) console.warn('[fetchInboxModel] counts fetch failed', res.error || res.message)
    }
  } catch (err) {
    if (DEV) console.warn('[fetchInboxModel] counts fetch failed', err)
  }

  const priorityInboxCount = categoryCounts.hot_leads + categoryCounts.needs_review + categoryCounts.new_inbound
  const activeInboxCount = categoryCounts.automated + categoryCounts.outbound_active
  const waitingInboxCount = categoryCounts.cold_no_response
  const allInboxCount = categoryCounts.all || totalAvailable
  
  const unreadThreadsCount = categoryCounts.new_inbound
  const suppressedThreadsCount = categoryCounts.dnc_opt_out
  const loadedCount = threads.length
  
  const fullyHydratedCount = threads.filter((t) => t.propertyId).length
  const partiallyHydratedCount = threads.filter((t) => !t.propertyId).length
  const orphanCount = threads.filter((t) => !t.propertyId && !t.ownerId && !t.prospectId).length
  const latestFetchMs = 0

  const pageSize = options.limit ?? options.maxRows ?? HYDRATED_INBOX_PAGE_SIZE
  const cursorOffset = Number.parseInt(options.cursor ?? '0', 10) || (options.offset ?? 0)
  const nextOffset = cursorOffset + threads.length
  const hasMoreActual = nextOffset < totalAvailable

  return {
    threads,
    unreadCount: unreadThreadsCount,
    urgentCount: categoryCounts.hot_leads,
    totalCount: totalAvailable,
    aiDraftCount: threads.filter((thread) => thread.aiDraft !== null).length,
    dataMode: 'live',
    liveFetchStatus: 'active',
    liveFetchError: null,
    messageEventsCount: totalAvailable,
    messageEventsRawCount: allInboxCount,
    groupedThreadCount: totalAvailable,
    priorityInboxCount,
    activeInboxCount,
    waitingInboxCount,
    allInboxCount,
    unreadThreadsCount,
    sendQueueCount: null,
    archivedThreadsCount: 0,
    hiddenThreadsCount: 0,
    suppressedThreadsCount,
    lastLiveFetchAt,
    counts: {
      ...categoryCounts,
      positive_hot: categoryCounts.hot_leads,
      manual_review: categoryCounts.needs_review,
      needs_reply: categoryCounts.new_inbound,
      auto_replied: categoryCounts.automated,
      outbound_only: categoryCounts.outbound_active,
      missing_context: categoryCounts.cold_no_response,
      suppressed: categoryCounts.dnc_opt_out,
      priority: priorityInboxCount,
      active: activeInboxCount,
      waiting: waitingInboxCount,
      all: allInboxCount,
    },
    pagination: {
      cursor: String(cursorOffset),
      nextCursor: hasMoreActual ? String(nextOffset) : null,
      hasMore: hasMoreActual,
      limit: pageSize,
      total: totalAvailable,
    },
    loadedCount,
    fullyHydratedCount,
    partiallyHydratedCount,
    orphanCount,
    latestFetchMs,
    mapPins,
  }
}

export const toThreadMessage = (row: AnyRecord): ThreadMessage => {
  const timelineAt =
    asIso(row['timeline_at'] ?? row['event_timestamp'] ?? row['message_created_at'] ?? row['created_at'] ?? row['sent_at'] ?? row['received_at']) ??
    new Date().toISOString()
  const createdAt =
    asIso(row['message_created_at'] ?? row['event_timestamp'] ?? row['created_at'] ?? row['sent_at'] ?? row['received_at'] ?? row['timeline_at']) ??
    timelineAt
  const direction = normalizeMessageDirection(row)
  
  const status = asString(
    row['delivery_status'] ?? row['provider_delivery_status'] ?? row['raw_carrier_status'] ?? row['queue_status'] ?? row['status'],
    'unknown',
  ).toLowerCase()
  
  let deliveryStatus = 'pending'
  if (status.includes('deliver')) deliveryStatus = 'delivered'
  else if (status.includes('sent') || status === 'success') deliveryStatus = 'sent'
  else if (status.includes('fail') || status.includes('undeliv')) deliveryStatus = 'failed'
  else if (status.includes('queue')) deliveryStatus = 'queued'
  else if (status === 'pending') deliveryStatus = 'pending'

  const { sellerPhone, canonicalE164: msgCanonical } = getSellerPhoneFromMessage(row)
  const source =
    asString(row['source_app'] ?? row['message_source'] ?? row['event_type'], '') ||
    asString(getNestedValue(row, 'metadata.source'), '') ||
    'textgrid'

  const developerMetaEntries = [
    ['template_id', asString(row['template_id'], '')],
    ['template_name', asString(row['template_name'], '')],
    ['use_case', asString(row['use_case'] ?? row['use_case_template'] ?? row['template_use_case'], '')],
    ['queue_id', asString(row['queue_id'], '')],
    ['provider_message_sid', asString(row['provider_message_sid'], '')],
    ['event_type', asString(row['event_type'], '')],
    ['client_send_id', asString(getNestedValue(row, 'metadata.client_send_id') ?? row['client_send_id'], '')],
  ].filter(([, value]) => value)

  const developerMeta = developerMetaEntries.length > 0
    ? Object.fromEntries(developerMetaEntries)
    : undefined

  return {
    id: asString(row['message_event_id'] ?? row['id'], createdAt),
    threadKey: asString(row['thread_key'], ''),
    direction,
    body: asString(row['message_body'] ?? row['rendered_message'], '') || getMessageBody(row),
    createdAt,
    timelineAt,
    sentAt: asIso(row['sent_at']),
    deliveredAt: asIso(row['delivered_at']),
    deliveryStatus,
    deliveryStatusDisplay: undefined,
    fromNumber: normalizePhone(row['from_phone_number']),
    toNumber: normalizePhone(row['to_phone_number']),
    ownerId: asString(row['master_owner_id'], ''),
    prospectId: asString(row['prospect_id'], ''),
    propertyId: asString(row['property_id'], ''),
    phoneNumber: sellerPhone,
    canonicalE164: msgCanonical,
    templateId: asString(row['template_id'], '') || null,
    templateName: null,
    agentId: asString(row['sms_agent_id'], '') || null,
    source,
    rawStatus: normalizeStatus(row['delivery_status'] ?? row['raw_carrier_status']),
    error: asString(row['error_message'] ?? row['failure_reason'] ?? row['failure_code'], '') || null,
    eventType: asString(row['event_type'], ''),
    metadata: (row['metadata'] as Record<string, unknown> | null | undefined) ?? ({} as Record<string, unknown>),
    developerMeta,
  }
}

const toMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

const isOutboundSendEvent = (message: ThreadMessage): boolean => {
  const eventType = normalizeStatus(message.eventType)
  if (eventType === 'outbound_send') return true
  return normalizeStatus(message.source) === 'message_events' && message.direction === 'outbound'
}

const hasProviderSid = (message: ThreadMessage): boolean => {
  const sid = asString(
    message.developerMeta?.provider_message_sid ??
    (message.metadata as AnyRecord | undefined)?.provider_message_sid ??
    (message.metadata as AnyRecord | undefined)?.provider_message_id,
    '',
  )
  return sid.length > 0
}

const resolveDeliveryStatusDisplay = (
  message: ThreadMessage,
  allMessages: ThreadMessage[],
): ThreadMessage['deliveryStatusDisplay'] => {
  if (message.direction !== 'outbound') return undefined

  const raw = normalizeStatus(message.rawStatus || message.deliveryStatus)
  const queueFailed = raw.includes('fail') || raw.includes('undeliv') || normalizeStatus(message.deliveryStatus) === 'failed'
  const terminalFailure = queueFailed
  const outboundEventExists = isOutboundSendEvent(message)
  const providerSidExists = hasProviderSid(message)

  const messageTs = toMs(message.timelineAt || message.createdAt) ?? 0
  const hasLaterInboundReply = allMessages.some((candidate) => {
    if (candidate.direction !== 'inbound') return false
    const candidateTs = toMs(candidate.timelineAt || candidate.createdAt) ?? -1
    return candidateTs > messageTs
  })

  const sentAt = toMs(message.sentAt || message.createdAt)
  const deliveredAt = toMs(message.deliveredAt)
  const hasDeliveredAt = deliveredAt !== null
  const validDelivered = hasDeliveredAt && (sentAt === null || deliveredAt >= sentAt)

  if (validDelivered) return 'delivered'
  if (hasDeliveredAt && sentAt !== null && deliveredAt !== null && deliveredAt < sentAt) {
    if (DEV) console.log('[DeliveryDisplay] invalid_delivery_timestamp', { id: message.id, sentAt: message.sentAt, deliveredAt: message.deliveredAt, reason: 'invalid_delivery_timestamp' })
    return 'sent'
  }

  if (queueFailed && (providerSidExists || outboundEventExists || hasLaterInboundReply)) {
    if (DEV) {
      console.log('[DeliveryDisplay] disputed_hidden_from_ui', {
        id: message.id,
        reason: 'queue_failed_but_success_evidence',
        providerSidExists,
        outboundEventExists,
        hasLaterInboundReply,
      })
    }
    return 'sent'
  }

  if (providerSidExists || outboundEventExists) return 'sent'
  if (terminalFailure && !providerSidExists && !outboundEventExists && !hasLaterInboundReply) return 'failed'
  return 'sent'
}

const applyDeliveryStatusDisplay = (messages: ThreadMessage[]): ThreadMessage[] =>
  messages.map((message) => {
    const display = resolveDeliveryStatusDisplay(message, messages)
    if (!display) return message
    return {
      ...message,
      deliveryStatusDisplay: display,
      deliveryStatus: display,
    }
  })



const buildMessageEventThreadCandidates = (thread: InboxThread): Array<{ key: string; value: string }> => {
  const phoneVariants = Array.from(new Set([
    ...buildPhoneVariants(normalizePhone(thread.phoneNumber)),
    ...buildPhoneVariants(normalizePhone(thread.canonicalE164)),
    ...buildPhoneVariants(normalizePhone(thread.sellerPhone)),
  ]))
  const filters: Array<{ key: string; value: string }> = []
  phoneVariants.forEach((value) => {
    filters.push({ key: 'from_phone_number', value })
    filters.push({ key: 'to_phone_number', value })
  })
  ;[
    ['master_owner_id', asString(thread.ownerId, '')],
    ['prospect_id', asString(thread.prospectId, '')],
    ['property_id', asString(thread.propertyId, '')],
    ['queue_id', asString(thread.queueId, '')],
    ['message_event_key', asString(thread.threadKey, '')],
  ].forEach(([key, value]) => {
    if (value) filters.push({ key, value })
  })
  return filters
}

const getThreadMessagesFromMessageEvents = async (
  thread: InboxThread | InboxWorkflowThread,
  options: ThreadMessageFetchOptions = {},
): Promise<ThreadMessage[]> => {
  const supabase = getSupabaseClient()
  const pageSize = MESSAGE_EVENTS_THREAD_PAGE_SIZE
  const maxPages = Math.max(1, options.maxPages ?? 20)
  const maxMessages = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : null
  const candidateFilters = buildMessageEventThreadCandidates(thread)
  if (candidateFilters.length === 0) {
    if (DEV) console.warn('[ThreadMessageHydration] no candidate filters for fallback', { threadKey: getCanonicalThreadKey(thread) })
    return []
  }

  const orClause = candidateFilters
    .map(({ key, value }) => `${key}.eq.${safeFilterValue(value)}`)
    .join(',')

  const rows: AnyRecord[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await supabase
      .from('message_events')
      .select('*')
      .or(orClause)
      .order('event_timestamp', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (error) throw new Error(mapErrorMessage(error))

    const sourceRows = safeArray(data as AnyRecord[])
    rows.push(...sourceRows.filter((row) => doesMessageBelongToThread(row, thread)))
    if (maxMessages !== null && rows.length >= maxMessages) break
    if (sourceRows.length < pageSize) break
  }

  const bounded = maxMessages !== null ? rows.slice(0, maxMessages) : rows
  return dedupeMessages(bounded.map(toThreadMessage))
}

export interface ThreadMessageFetchOptions {
  maxPages?: number
  maxMessages?: number
}

const getCanonicalThreadKey = (thread: Pick<InboxThread, 'threadKey' | 'id'>): string =>
  asString(thread.threadKey, '') || asString(thread.id, '')

const dedupeThreadsByKey = (threads: InboxThread[]): InboxThread[] => {
  const byKey = new Map<string, InboxThread>()
  for (const thread of threads) {
    const key = getCanonicalThreadKey(thread)
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, thread)
      continue
    }
    const existingTs = new Date(existing.latestMessageAt ?? existing.lastMessageIso ?? 0).getTime()
    const incomingTs = new Date(thread.latestMessageAt ?? thread.lastMessageIso ?? 0).getTime()
    byKey.set(key, incomingTs >= existingTs ? { ...existing, ...thread } : { ...thread, ...existing })
  }
  return Array.from(byKey.values()).sort((a, b) => (
    new Date(b.latestMessageAt ?? b.lastMessageIso ?? 0).getTime() -
    new Date(a.latestMessageAt ?? a.lastMessageIso ?? 0).getTime()
  ))
}

const dedupeMapPinsByThreadKey = (pins: LiveInboxMapPin[]): LiveInboxMapPin[] => {
  const byKey = new Map<string, LiveInboxMapPin>()
  for (const pin of pins) {
    const key = pin.threadKey || pin.id
    if (!key) continue
    if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng) || pin.lat === 0 || pin.lng === 0) continue
    const existing = byKey.get(key)
    byKey.set(key, existing ? { ...existing, ...pin } : pin)
  }
  return Array.from(byKey.values())
}

export const normalizeOutboundMessageIdentity = (message: ThreadMessage): string => {
  const clientSendId =
    asString(message.developerMeta?.client_send_id, '') ||
    asString((message.metadata as AnyRecord | undefined)?.client_send_id, '')
  if (clientSendId) return `csid:${clientSendId}`

  const providerId = asString(message.developerMeta?.provider_message_sid, '')
  if (providerId) return `provider:${providerId}`

  const queueId = asString(message.developerMeta?.queue_id, '')
  if (queueId) return `queue:${queueId}`

  const body = message.body.trim().toLowerCase()
  const counterparty = normalizePhone(message.direction === 'inbound' ? message.fromNumber : message.toNumber)
  const bucket = Math.floor(new Date(message.timelineAt || message.createdAt).getTime() / (3 * 60 * 1000))
  return `body:${message.direction}:${counterparty}:${bucket}:${body}`
}

const getMessageMergeKey = normalizeOutboundMessageIdentity

const getDeliveryStatusRank = (status: string): number => {
  switch (normalizeStatus(status)) {
    case 'delivered':
      return 5
    case 'sent':
      return 4
    case 'failed':
      return 3
    case 'queued':
      return 2
    case 'pending':
      return 1
    default:
      return 0
  }
}

export const mergeOutboundLifecycleMessages = (existing: ThreadMessage, incoming: ThreadMessage): ThreadMessage => {
  // message_events is always the canonical source — it represents the confirmed backend record
  const canonical =
    incoming.source === 'message_events' && existing.source !== 'message_events' ? incoming :
    existing.source === 'message_events' && incoming.source !== 'message_events' ? existing :
    getDeliveryStatusRank(incoming.deliveryStatus) >= getDeliveryStatusRank(existing.deliveryStatus) ? incoming : existing

  const earliestCreatedAt = new Date(existing.createdAt).getTime() <= new Date(incoming.createdAt).getTime()
    ? existing.createdAt
    : incoming.createdAt
  const earliestTimelineAt = new Date(existing.timelineAt).getTime() <= new Date(incoming.timelineAt).getTime()
    ? existing.timelineAt
    : incoming.timelineAt

  const mergedDeveloperMeta = { ...(existing.developerMeta ?? {}), ...(incoming.developerMeta ?? {}) }
  const mergedMetadata = { ...(existing.metadata ?? {}), ...(incoming.metadata ?? {}) }

  if (DEV) {
    const key = normalizeOutboundMessageIdentity(existing)
    if (canonical.deliveryStatus === 'delivered') {
      console.log('[MessageLifecycle] delivered merged', { key, existingStatus: existing.deliveryStatus, incomingStatus: incoming.deliveryStatus })
    } else {
      console.log('[MessageLifecycle] duplicate suppressed', { key, existingSource: existing.source, incomingSource: incoming.source, resolvedStatus: canonical.deliveryStatus })
    }
  }

  return {
    ...existing,
    ...incoming,
    id: existing.id.startsWith('pending-') && !incoming.id.startsWith('pending-') ? incoming.id : existing.id,
    source: canonical.source,
    body: incoming.body || existing.body,
    createdAt: earliestCreatedAt,
    timelineAt: earliestTimelineAt,
    deliveredAt: incoming.deliveredAt || existing.deliveredAt,
    deliveryStatus: canonical.deliveryStatus,
    rawStatus: canonical.rawStatus || incoming.rawStatus || existing.rawStatus,
    error: incoming.error || existing.error,
    metadata: mergedMetadata,
    developerMeta: mergedDeveloperMeta,
  }
}

const mergeThreadMessages = mergeOutboundLifecycleMessages

export const dedupeMessages = (messages: ThreadMessage[]): ThreadMessage[] => {
  const byKey = new Map<string, ThreadMessage>()
  for (const message of messages) {
    const key = getMessageMergeKey(message)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, message)
      continue
    }
    byKey.set(key, mergeThreadMessages(existing, message))
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const aTs = new Date(a.timelineAt || a.createdAt).getTime()
    const bTs = new Date(b.timelineAt || b.createdAt).getTime()
    return aTs - bTs
  })
}

export const toThreadMessageFromQueue = (row: AnyRecord): ThreadMessage => {
  const createdAt = asIso(row['created_at']) ?? new Date().toISOString()
  const scheduledAt = asIso(row['scheduled_for'] ?? row['scheduled_at']) ?? createdAt
  
  const status = normalizeStatus(row['queue_status'] ?? row['status'] ?? 'pending')
  let deliveryStatus = 'pending'
  if (status === 'approval') deliveryStatus = 'approval'
  else if (status === 'queued' || status === 'scheduled') deliveryStatus = 'queued'
  else if (status === 'sent') deliveryStatus = 'sent'
  else if (status === 'failed') deliveryStatus = 'failed'

  return {
    id: asString(row['id'], `queue-${createdAt}`),
    threadKey: asString(row['queue_key'], ''),
    direction: 'outbound',
    body: asString(row['message_body'] ?? row['message_text'], ''),
    createdAt,
    timelineAt: scheduledAt,
    sentAt: asIso(row['sent_at']),
    deliveredAt: null,
    deliveryStatus,
    deliveryStatusDisplay: undefined,
    fromNumber: normalizePhone(row['from_phone_number']),
    toNumber: normalizePhone(row['to_phone_number']),
    ownerId: asString(row['master_owner_id'], ''),
    prospectId: asString(row['prospect_id'], ''),
    propertyId: asString(row['property_id'], ''),
    phoneNumber: normalizePhone(row['to_phone_number']),
    canonicalE164: normalizePhone(row['to_phone_number']),
    templateId: asString(row['template_id'], '') || null,
    templateName: asString(row['template_name'], '') || null,
    agentId: null,
    source: 'send_queue',
    rawStatus: status,
    error: asString(row['error_message'] ?? row['failed_reason'], '') || null,
    developerMeta: {
      queue_id: asString(row['id'], ''),
      queue_key: asString(row['queue_key'], ''),
      use_case: asString(row['use_case_template'], ''),
      ...(asString(getNestedValue(row, 'metadata.client_send_id'), '') ? { client_send_id: asString(getNestedValue(row, 'metadata.client_send_id'), '') } : {}),
    }
  }
}

export const getThreadMessagesForThread = async (
  thread: InboxThread | InboxWorkflowThread,
  options: ThreadMessageFetchOptions = {},
): Promise<ThreadMessage[]> => {
  const threadKey = thread.threadKey || thread.id
  if (!threadKey) return []
  const pageSize = MESSAGE_EVENTS_THREAD_PAGE_SIZE
  const limit = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : pageSize

  try {
    const params = new URLSearchParams()
    params.set('offset', '0')
    params.set('limit', String(limit))
    const result = await backendClient.fetchInboxThreadMessages(threadKey, params.toString())
    if (result.ok) {
      const payload = (result.data ?? {}) as AnyRecord
      const diagnostics = (payload.diagnostics ?? payload) as AnyRecord
      const apiMessages = safeArray((diagnostics.messages ?? []) as AnyRecord[]).map(toThreadMessage)
      if (apiMessages.length > 0) return applyDeliveryStatusDisplay(dedupeMessages(apiMessages))
    }
  } catch (err) {
    if (DEV) console.warn('[ThreadMessageHydration] cockpit thread-messages failed; falling back', err)
  }

  const maxPages = Math.max(1, options.maxPages ?? 50)
  const maxMessages = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : null
  const supabase = getSupabaseClient()

  const rows: AnyRecord[] = []
  let viewErrorMessage: string | null = null

  // 1. Fetch from hydrated view or message_events
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const { data, error } = await supabase
        .from('inbox_messages_hydrated')
        .select('*')
        .eq('thread_key', threadKey)
        .order('message_created_at', { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1)

      if (error) throw new Error(mapErrorMessage(error))

      const batch = safeArray(data as AnyRecord[])
      rows.push(...batch)
      if (maxMessages !== null && rows.length >= maxMessages) break
      if (batch.length < pageSize) break
    }
  } catch (error) {
    viewErrorMessage = mapErrorMessage(error)
    if (DEV) {
      console.warn('[ThreadMessageHydration] inbox_messages_hydrated failed, falling back to message_events', {
        threadKey,
        error: viewErrorMessage,
      })
    }
  }

  const viewMessages = rows.map(toThreadMessage)
  
  if (viewMessages.length === 0) {
    const fallbackMessages = await getThreadMessagesFromMessageEvents(thread, options)
    viewMessages.push(...fallbackMessages)
  }

  const mapped = applyDeliveryStatusDisplay(dedupeMessages(viewMessages))

  if (DEV) {
    console.log('[ThreadMessageHydration]', {
      threadKey,
      viewRows: viewMessages.length,
      mergedRows: mapped.length,
    })
  }

  return mapped
}


export const getThreadMessages = async (threadIdOrKey: string): Promise<ThreadMessage[]> => {
  return getThreadMessagesForThread({
    id: threadIdOrKey,
    threadKey: threadIdOrKey,
    leadId: threadIdOrKey,
    marketId: 'unknown',
    ownerName: 'Unknown owner',
    subject: 'Thread',
    preview: '',
    status: 'read',
    priority: 'normal',
    sentiment: 'neutral',
    messageCount: 0,
    lastMessageLabel: '',
    lastMessageIso: new Date().toISOString(),
    unreadCount: 0,
    aiDraft: null,
    labels: [],
  })
}

export const getThreadIntelligence = async (thread: InboxWorkflowThread): Promise<ThreadIntelligenceRecord | null> => {
  const threadKey = asString(thread.threadKey, '') || asString(thread.id, '')
  if (!threadKey) return null

  try {
    const params = new URLSearchParams()
    params.set('thread_key', threadKey)
    const result = await backendClient.fetchInboxThreadDossier(params.toString())
    if (result.ok) {
      const payload = (result.data ?? {}) as AnyRecord
      const diagnostics = (payload.diagnostics ?? payload) as AnyRecord
      if (diagnostics?.selected_thread) return diagnostics as ThreadIntelligenceRecord
    }
  } catch (err) {
    if (DEV) console.warn('[getThreadIntelligence] cockpit thread-dossier failed; falling back', err)
  }
  const supabase = getSupabaseClient()

  // 1. Try preferred RPC
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_inbox_thread_dossier', { thread_key_param: threadKey })
    if (!rpcError && rpcData) {
      if (DEV) console.log('[getThreadIntelligence] RPC success', { threadKey })
      return rpcData as ThreadIntelligenceRecord
    }
  } catch (rpcErr) {
    // Ignore RPC failure, move to view
  }

  // 2. Try dossier view
  const { data, error } = await supabase
    .from('inbox_threads_hydrated')
    .select('*')
    .eq('thread_key', threadKey)
    .limit(1)

  if (!error && data && data.length > 0) {
    const row = data[0] as ThreadIntelligenceRecord
    if (DEV) console.log('[getThreadIntelligence] View success', { threadKey })
    return row
  }

  // 3. Fallback to thread row
  if (DEV) console.log('[getThreadIntelligence] Falling back to thread row', { threadKey })
  return thread as unknown as ThreadIntelligenceRecord
}


export const getThreadContext = async (thread: InboxThread): Promise<ThreadContext> => {
  const supabase = getSupabaseClient()

  let ownerId = asString(thread.ownerId, '')
  let propertyId = asString(thread.propertyId, '')
  let prospectId = asString(thread.prospectId, '')
  const queueId = asString(thread.queueId, '')
  const phoneNumberId = asString(thread.phoneNumberId, '')
  const canonical = normalizePhone(thread.canonicalE164)
  const phone = normalizePhone(thread.phoneNumber)
  const searchPhone = canonical || phone
  const phoneVariants = buildPhoneVariants(searchPhone)
  const propertyAddress = asString(thread.propertyAddress ?? thread.subject, '')

  // ── Phase 1: find phone_numbers row via direct filter ───────────────────
  // Try all likely field names with all phone variants in one OR query.
  let phoneRows: AnyRecord[] = []
  let matchedPhoneBy: string | null = null
  let matchedPhoneRowId: string | null = null
  let bridgedMasterOwnerId: string | null = null
  let bridgedProspectId: string | null = null
  let bridgedPropertyId: string | null = null

  if (searchPhone) {
    const phoneFilters: Array<{ key: string; value: string }> = []
    if (phoneNumberId) phoneFilters.push({ key: 'id', value: phoneNumberId })
    for (const field of PHONE_NUMBER_FIELD_NAMES) {
      for (const variant of phoneVariants) {
        phoneFilters.push({ key: field, value: variant })
      }
    }
    // Deduplicate
    const seen = new Set<string>()
    const uniquePhoneFilters = phoneFilters.filter((f) => {
      const k = `${f.key}:${f.value}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    phoneRows = await runFilteredQuery('phones', uniquePhoneFilters, 8)

    // ── Phase 1b: client-side broad scan if server returned nothing ──────
    if (phoneRows.length === 0 && searchPhone) {
      if (DEV) console.log('[Inbox phones] direct filter returned 0 — attempting broad client-side scan')
      const phonesTable = await resolveTable('phones')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let broadData: any = null
      let broadFailed = true
      if (phonesTable) {
        const broadResult = await supabase.from(phonesTable).select('*').limit(5000)
        if (!broadResult.error) { broadData = broadResult.data; broadFailed = false }
      }
      if (!broadFailed && broadData) {
        const broadRows = safeArray(broadData as AnyRecord[])
        if (DEV && broadRows.length > 0) {
          const sample = Math.min(3, broadRows.length)
          for (let i = 0; i < sample; i++) {
            console.log('[Inbox phones sample keys]', Object.keys(broadRows[i]!))
            console.log('[Inbox phones sample row]', broadRows[i])
          }
        }
        phoneRows = broadRows.filter((row) => {
          for (const field of PHONE_NUMBER_FIELD_NAMES) {
            const val = normalizePhone(row[field])
            if (val && phoneVariants.includes(val)) return true
          }
          return false
        })
        if (DEV) {
          if (phoneRows.length > 0) {
            console.log(`[Inbox phones] client-side matched ${phoneRows.length} rows for ${searchPhone}`)
          } else {
            console.log('[Inbox phones] client-side scan also found 0 matches')
          }
        }
        matchedPhoneBy = phoneRows.length > 0 ? 'client_side:phone_scan' : null
      }
    }

    // ── Phase 1c: determine how we matched ────────────────────────────────
    if (phoneRows.length > 0 && !matchedPhoneBy) {
      const phoneRow = phoneRows[0]!
      for (const field of PHONE_NUMBER_FIELD_NAMES) {
        const val = normalizePhone(phoneRow[field])
        if (val && phoneVariants.includes(val)) {
          matchedPhoneBy = field
          break
        }
      }
      if (!matchedPhoneBy && phoneNumberId) matchedPhoneBy = 'id'
    }

    // ── Phase 1d: extract bridged IDs from matched phone row ─────────────
    if (phoneRows.length > 0) {
      const phoneRow = phoneRows[0]!
      matchedPhoneRowId = asString(getFirst(phoneRow, ['id', 'phone_number_id']), '') || null
      const bridgedOwner = asString(
        getFirst(phoneRow, ['master_owner_id', 'owner_id', 'masterowner_id']), '',
      )
      const bridgedProspect = asString(getFirst(phoneRow, ['prospect_id']), '')
      const bridgedProperty = asString(getFirst(phoneRow, ['property_id']), '')
      if (bridgedOwner) {
        bridgedMasterOwnerId = bridgedOwner
        if (!ownerId) ownerId = bridgedOwner
      }
      if (bridgedProspect) {
        bridgedProspectId = bridgedProspect
        if (!prospectId) prospectId = bridgedProspect
      }
      if (bridgedProperty) {
        bridgedPropertyId = bridgedProperty
        if (!propertyId) propertyId = bridgedProperty
      }
      if (DEV) {
        console.log('[Inbox phones bridge]', {
          matchedPhoneBy,
          matchedPhoneRowId,
          bridgedMasterOwnerId,
          bridgedProspectId,
          bridgedPropertyId,
        })
      }
    }
  }

  // ── Phase 2: main context queries using actual + bridged IDs ─────────────
  const [masterowners, owners, prospects, properties, emails, aiRows, queueRows, offers] = await Promise.all([
    runFilteredQuery('masterOwners', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'owner_id', value: ownerId },
      { key: 'normalized_owner_key', value: ownerId },
    ], 5),
    runFilteredQuery('owners', [
      { key: 'owner_id', value: ownerId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'normalized_owner_key', value: ownerId },
      { key: 'podio_item_id', value: ownerId },
    ], 5),
    runFilteredQuery('prospects', [
      { key: 'prospect_id', value: prospectId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
    ], 5),
    runFilteredQuery('properties', [
      { key: 'property_id', value: propertyId },
      { key: 'owner_id', value: ownerId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'property_address', value: propertyAddress },
    ], 5),
    runFilteredQuery('emails', [
      { key: 'owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
    ], 8),
    runFilteredQuery('aiBrain', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
      { key: 'canonical_e164', value: canonical },
      { key: 'conversation_brain_id', value: asString(thread.queueId, '') },
    ], 5),
    runFilteredQuery('send_queue', [
      { key: 'id', value: queueId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
      { key: 'to_phone_number', value: searchPhone },
    ], 12),
    runFilteredQuery('offers', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'property_address', value: propertyAddress },
    ], 8),
  ])

  // ── Phase 3: build debug + contextMatchQuality ────────────────────────────
  // Read resolved table names from cache (populated during Phases 1 & 2)
  const resolvedPhoneTable = resolvedTableCache.get('phones') ?? null
  const resolvedMasterOwnerTable = resolvedTableCache.get('masterOwners') ?? null
  const resolvedOwnerTable = resolvedTableCache.get('owners') ?? null

  const ownerRow = owners[0] ?? masterowners[0] ?? null
  const propertyRow = properties[0] ?? null
  const prospectRow = prospects[0] ?? null
  const aiRow = aiRows[0] ?? null

  const phoneMatched = phoneRows.length > 0
  const ownerMatched = ownerRow !== null
  const propertyMatched = propertyRow !== null
  const prospectMatched = prospectRow !== null

  const debug: ThreadContextDebug = {
    resolvedPhoneTable,
    resolvedMasterOwnerTable,
    resolvedOwnerTable,
    resolvedPropertyTable: 'properties',
    resolvedProspectTable: 'prospects',
    matchedOwnerBy: ownerMatched
      ? (asString(getFirst(ownerRow!, ['master_owner_id']), '') === ownerId
        ? 'master_owner_id'
        : asString(getFirst(ownerRow!, ['owner_id']), '') === ownerId
        ? 'owner_id'
        : bridgedMasterOwnerId
        ? `phone_bridge:master_owner_id`
        : 'normalized_owner_key')
      : null,
    matchedProspectBy: prospectMatched
      ? (asString(getFirst(prospectRow!, ['prospect_id']), '') === prospectId
        ? 'prospect_id'
        : bridgedProspectId
        ? 'phone_bridge:prospect_id'
        : asString(getFirst(prospectRow!, ['master_owner_id']), '') === ownerId
        ? 'master_owner_id'
        : 'property_id')
      : null,
    matchedPropertyBy: propertyMatched
      ? (asString(getFirst(propertyRow!, ['property_id']), '') === propertyId
        ? 'property_id'
        : bridgedPropertyId
        ? 'phone_bridge:property_id'
        : asString(getFirst(propertyRow!, ['property_address']), '') === propertyAddress
        ? 'property_address'
        : 'master_owner_id')
      : null,
    matchedPhoneBy,
    matchedPhoneRowId,
    matchedEmailBy: emails.length > 0 ? 'owner_id/prospect_id' : null,
    matchedAiBrainBy: aiRow
      ? (asString(getFirst(aiRow, ['master_owner_id']), '') === ownerId
        ? 'master_owner_id'
        : asString(getFirst(aiRow, ['prospect_id']), '') === prospectId
        ? 'prospect_id'
        : 'phone_number')
      : null,
    matchedQueueBy: queueRows.length > 0
      ? (queueId && queueRows.some((r) => asString(getFirst(r, ['id']), '') === queueId)
        ? 'queue_id'
        : searchPhone && queueRows.some((r) =>
            normalizePhone(getFirst(r, ['phone_number', 'to_phone_number'])) === searchPhone,
          )
        ? 'phone'
        : 'master_owner_id/property_id')
      : null,
    bridgedMasterOwnerId,
    bridgedProspectId,
    bridgedPropertyId,
  }

  // contextMatchQuality based on what we actually resolved
  const contextMatchQuality: ThreadContext['contextMatchQuality'] = (() => {
    if (phoneMatched && ownerMatched && propertyMatched) return 'high'
    if (phoneMatched && (ownerMatched || prospectMatched)) return 'medium'
    if (phoneMatched || ownerMatched || propertyMatched || prospectMatched) return 'low'
    return 'missing'
  })()

  // ── Phase 4: build response ───────────────────────────────────────────────
  const sellerName = asString(
    getFirst(ownerRow ?? prospectRow ?? {}, ['full_name', 'name', 'first_name', 'owner_name']),
    thread.ownerName,
  )

  const sellerMarket = asString(
    getFirst(ownerRow ?? propertyRow ?? prospectRow ?? {}, ['market', 'market_id']),
    thread.market || thread.marketId,
  )

  const propertyAddressValue = asString(
    getFirst(propertyRow ?? prospectRow ?? {}, ['property_address', 'address']),
    thread.propertyAddress || thread.subject,
  )

  const primaryPhone = phone || canonical || null

  const stack: ThreadContext['contactStack'] = []
  for (const row of phoneRows.slice(0, 3)) {
    const value = normalizePhone(
      getFirst(row, ['canonical_e164', 'phone_number', 'phone', 'e164', 'phone_e164']),
    ) || searchPhone
    if (value) stack.push({ type: 'phone', value, status: asString(getFirst(row, ['status']), 'active') })
  }
  for (const row of emails.slice(0, 3)) {
    const value = asString(getFirst(row, ['email']), '')
    if (value) stack.push({ type: 'email', value, status: asString(getFirst(row, ['status']), 'active') })
  }
  if (stack.length === 0 && primaryPhone) {
    stack.push({ type: 'phone', value: primaryPhone, status: 'active' })
    const fallbackEmail = asString(getFirst(ownerRow ?? prospectRow ?? {}, ['email']), '')
    if (fallbackEmail) stack.push({ type: 'email', value: fallbackEmail, status: 'active' })
  }

  const queueContext = queueRows.length > 0
    ? {
        items: queueRows.map((row) => ({
          id: asString(getFirst(row, ['id']), ''),
          status: asString(getFirst(row, ['status']), 'unknown'),
          scheduleAt: asIso(getFirst(row, ['scheduled_at', 'scheduled_for', 'created_at'])),
        })),
      }
    : null

  const aiContext = aiRow
    ? {
        summary: asString(getFirst(aiRow, ['summary']), ''),
        intent: asString(getFirst(aiRow, ['intent', 'recommended_action']), ''),
        sentiment: asString(getFirst(aiRow, ['sentiment']), thread.sentiment),
      }
    : null

  const archived = thread.status === 'archived'
  const needsResponse = asBoolean(thread.needsResponse, false)
  const offerCount = offers.length

  return {
    seller: sellerName
      ? {
          id: ownerId || asString(getFirst(ownerRow ?? {}, ['owner_id', 'master_owner_id']), ''),
          name: sellerName,
          market: sellerMarket,
        }
      : null,
    property: propertyAddressValue
      ? {
          id: propertyId || asString(getFirst(propertyRow ?? {}, ['property_id']), ''),
          address: propertyAddressValue,
          market: sellerMarket,
        }
      : null,
    phone: primaryPhone,
    contactStack: stack,
    dealContext: {
      stage: archived ? 'Archived' : needsResponse ? 'Needs Response' : 'Active',
      nextAction: archived ? 'Review Archive' : needsResponse ? 'Respond Now' : offerCount > 0 ? 'Review Offer' : 'Monitor',
    },
    aiContext,
    queueContext,
    contextMatchQuality,
    contextDebug: debug,
  }
}

/**
 * Queue a reply from the Inbox by inserting a send_queue row with queue_status=approval.
 * Never sends SMS directly — the queue processor handles the actual send.
 */
export const queueReplyFromInbox = async (
  thread: InboxThread,
  messageText: string,
  options?: ({ scheduledAt?: string } & InboxTemplateSendOptions),
): Promise<QueueReplyResult> => {
  void options?.scheduledAt
  const trimmedText = messageText.trim()
  if (!trimmedText) {
    return { ok: false, queueId: null, status: null, errorMessage: 'Message text is required', insertPayloadKeys: [] }
  }

  const personalization = buildQueuePersonalization(thread, trimmedText)
  const templateAttachment = buildSelectedTemplatePayload(options?.selectedTemplate, options?.threadContext)

  const toPhone = normalizePhone(thread.canonicalE164 || thread.phoneNumber)
  if (!toPhone) {
    return { ok: false, queueId: null, status: null, errorMessage: 'Thread has no valid phone number', insertPayloadKeys: [] }
  }

  const routingResult = await resolveOutboundTextgridNumber({
    marketId: thread.marketId,
    market: thread.market || thread.marketName,
    ourNumber: thread.ourNumber,
    phoneNumber: thread.phoneNumber,
    textgridNumberId: thread.textgridNumberId,
    property_address_state: thread.property_address_state,
    propertyId: thread.propertyId,
    threadKey: thread.threadKey,
  }, false)

  if (!routingResult.ok) {
    return { ok: false, queueId: null, status: null, errorMessage: routingResult.error || 'Routing failed', insertPayloadKeys: [] }
  }

  const fromPhone = routingResult.from_phone_number
  const textgridNumberId = routingResult.textgrid_number_id

  const now = new Date().toISOString()
  const queueKey = `inbox:approval:${thread.threadKey ?? thread.id}:${Date.now()}`

  const payload: Record<string, unknown> = {
    queue_status: 'approval',
    queue_key: queueKey,
    queue_id: queueKey,
    queue_sequence: 1,
    scheduled_for: now,
    scheduled_for_utc: now,
    scheduled_for_local: now,
    send_priority: 5,
    is_locked: false,
    retry_count: 0,
    max_retries: 3,
    message_body: personalization.messageText,
    message_text: personalization.messageText,
    to_phone_number: toPhone,
    character_count: personalization.messageText.length,
    touch_number: 1,
    current_stage: 'manual_reply',
    message_type: 'manual_reply',
    use_case_template: templateAttachment.useCaseTemplate,
    metadata: {
      source: 'inbox',
      action: 'queue_reply',
      thread_key: thread.threadKey,
      selected_thread_id: thread.id,
      created_from: 'leadcommand_inbox',
      our_number: thread.ourNumber,
      seller_phone: thread.phoneNumber,
      ...buildQueueRoutingMetadata(thread),
      template_variables: personalization.renderVariables,
      candidate_snapshot: personalization.candidateSnapshot,
      personalization: personalization.personalizationMeta,
      ...SMS_ROUTE_METADATA,
      ...templateAttachment.metadata,
    },
    created_at: now,
  }

  // ALWAYS include from_phone_number (even if null)
  payload.from_phone_number = fromPhone
  if (templateAttachment.language) payload.language = templateAttachment.language
  if (isValidUUID(asString(templateAttachment.templateId, ''))) {
    payload.template_id = templateAttachment.templateId
    payload.selected_template_id = templateAttachment.templateId
  }
  if (isValidUUID(asString(thread.phoneNumberId, ''))) payload.phone_number_id = thread.phoneNumberId
  if (isValidUUID(asString(textgridNumberId, ''))) payload.textgrid_number_id = textgridNumberId
  Object.assign(payload, buildQueueRoutingColumns(thread))

  const insertPayloadKeys = Object.keys(payload)

  if (DEV) {
    console.log('[queueReplyFromInbox] routing to backend', { keys: insertPayloadKeys, toPhone, queue_status: 'approval', queueKey })
  }

  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.queueInboxReply(payload)
  if (!result.ok) {
    if (DEV) console.error('[queueReplyFromInbox] backend call failed:', result.error, result.message)
    return { ok: false, queueId: null, status: null, errorMessage: result.message, insertPayloadKeys }
  }

  const queueId = asString((result.data as AnyRecord)?.queueId || (result.data as AnyRecord)?.queue_id || queueKey, '')
  if (DEV) console.log('[queueReplyFromInbox] success via backend', { queueId })

  return { ok: true, queueId, status: 'approval', errorMessage: null, insertPayloadKeys }
}

export const getSuggestedDraft = async (thread: InboxThread): Promise<SuggestedDraft> => {
  const supabase = getSupabaseClient()
  const ownerId = asString(thread.ownerId ?? thread.leadId, '')

  const aiFilters = [
    ownerId ? `owner_id.eq.${safeFilterValue(ownerId)}` : '',
    thread.id ? `thread_id.eq.${safeFilterValue(thread.id)}` : '',
    thread.id ? `conversation_id.eq.${safeFilterValue(thread.id)}` : '',
  ].filter(Boolean)

  const aiBrainTable = await resolveTable('aiBrain')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aiResult: { data: any; error: any } = { data: null, error: null }
  if (aiBrainTable) {
    const aiQuery = supabase
      .from(aiBrainTable)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
    aiResult = aiFilters.length > 0 ? await aiQuery.or(aiFilters.join(',')) : await aiQuery
  }
  if (!aiResult.error) {
    const aiRow = safeArray(aiResult.data as AnyRecord[])[0] ?? null
    const text = asString(getFirst(aiRow ?? {}, ['suggested_reply', 'rendered_message']), '')
    if (text) {
      return {
        text,
        confidence: asNumber(getFirst(aiRow ?? {}, ['confidence']), 0) || null,
        reason: asString(getFirst(aiRow ?? {}, ['recommended_action', 'summary']), '') || null,
        source: 'ai_brain',
      }
    }
  }

  const queueFilters = [
    ownerId ? `owner_id.eq.${safeFilterValue(ownerId)}` : '',
    thread.id ? `thread_id.eq.${safeFilterValue(thread.id)}` : '',
    thread.phoneNumber ? `phone_number.eq.${safeFilterValue(thread.phoneNumber)}` : '',
  ].filter(Boolean)

  const queueQuery = supabase
    .from('send_queue')
    .select('*')
    .in('status', ['pending', 'draft', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
  const queueResult = queueFilters.length > 0 ? await queueQuery.or(queueFilters.join(',')) : await queueQuery

  if (!queueResult.error) {
    const queueRow = safeArray(queueResult.data as AnyRecord[])[0] ?? null
    const text = getMessageBody(queueRow ?? {})
    if (text) {
      return {
        text,
        confidence: null,
        reason: `Queued reply - status: ${asString(getFirst(queueRow ?? {}, ['status']), 'pending')}`,
        source: 'send_queue',
      }
    }
  }

  const templatesTable = await resolveTable('templates')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const templatesResult: { data: any; error: any } = templatesTable
    ? await supabase.from(templatesTable).select('*').limit(1)
    : { data: null, error: 'no templates table' }
  if (!templatesResult.error) {
    const template = safeArray(templatesResult.data as AnyRecord[])[0] ?? null
    const templateText = getMessageBody(template ?? {})
    if (templateText) {
      return {
        text: templateText,
        confidence: null,
        reason: 'Template fallback',
        source: 'template',
      }
    }
  }

  return {
    text: thread.aiDraft ?? 'No draft generated yet.',
    confidence: null,
    reason: null,
    source: 'placeholder',
  }
}

export interface InboxThreadStateMutationResult {
  ok: boolean
  threadKey: string
  mutationPayload: AnyRecord
  errorMessage: string | null
}

const buildQueueRoutingColumns = (thread: InboxThread): Record<string, unknown> => {
  const sellerName = asString(thread.ownerName || thread.sellerName || thread.ownerDisplayName, '').trim()
  const market = asString(thread.market || thread.marketName || thread.marketId, '').trim()
  const state = asString(thread.property_address_state, '').trim().toUpperCase()

  const payload: Record<string, unknown> = {}

  if (sellerName) payload.seller_name = sellerName
  if (thread.propertyAddress) payload.property_address = thread.propertyAddress
  if (state) payload.property_address_state = state
  if (market) payload.market = market
  if (thread.threadKey) payload.thread_key = thread.threadKey
  if (isValidUUID(asString(thread.ownerId, ''))) payload.master_owner_id = thread.ownerId
  if (isValidUUID(asString(thread.prospectId, ''))) payload.prospect_id = thread.prospectId
  if (isValidUUID(asString(thread.propertyId, ''))) payload.property_id = thread.propertyId
  if (isValidUUID(asString(thread.marketId, ''))) payload.market_id = thread.marketId

  return payload
}

const buildQueueRoutingMetadata = (thread: InboxThread): Record<string, unknown> => {
  const sellerName = asString(thread.ownerName || thread.sellerName || thread.ownerDisplayName, '').trim()
  const market = asString(thread.market || thread.marketName || thread.marketId, '').trim()
  const state = asString(thread.property_address_state, '').trim().toUpperCase()

  return {
    seller_name: sellerName || null,
    property_address: thread.propertyAddress || null,
    property_id: thread.propertyId || null,
    market: market || null,
    property_address_state: state || null,
    thread_key: thread.threadKey || null,
  }
}

const writeInboxThreadState = async (
  threadKey: string,
  patch: AnyRecord,
): Promise<InboxThreadStateMutationResult> => {
  const now = new Date().toISOString()
  const mutationPayload: AnyRecord = {
    thread_key: threadKey,
    updated_at: now,
    ...patch,
  }
  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.updateThreadState(threadKey, mutationPayload)
  if (result.ok) {
    return { ok: true, threadKey, mutationPayload, errorMessage: null }
  }
  return { ok: false, threadKey, mutationPayload, errorMessage: result.message }
}

export const upsertInboxThreadState = async (thread: InboxThread): Promise<InboxThreadStateMutationResult> => {
  const threadKey = asString(thread.threadKey, '') || asString(thread.id, '')
  if (!threadKey) {
    return { ok: false, threadKey: '', mutationPayload: {}, errorMessage: 'Missing thread key for state upsert' }
  }

  return writeInboxThreadState(threadKey, {
    master_owner_id: thread.ownerId ?? null,
    prospect_id: thread.prospectId ?? null,
    property_id: thread.propertyId ?? null,
    seller_phone: thread.phoneNumber ?? null,
    canonical_e164: thread.canonicalE164 ?? null,
    our_number: thread.ourNumber ?? null,
    market: thread.market ?? thread.marketId,
  })
}

export const markThreadRead = async (threadKey: string): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    is_read: true,
    status: 'read',
    last_read_at: new Date().toISOString(),
  })
}

export const markThreadUnread = async (threadKey: string): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    is_read: false,
    status: 'unread',
    last_read_at: null,
  })
}

export const archiveThread = async (threadKey: string): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    is_archived: true,
    status: 'archived',
    stage: 'archived',
    archived_at: new Date().toISOString(),
  })
}

export const unarchiveThread = async (threadKey: string): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    is_archived: false,
    status: 'open',
    stage: 'needs_response',
    archived_at: null,
  })
}

export const updateThreadStage = async (threadKey: string, stage: string): Promise<InboxThreadStateMutationResult> => {
  const status = stage === 'archived' ? 'archived' : stage === 'dnc_opt_out' ? 'suppressed' : 'open'
  return writeInboxThreadState(threadKey, {
    stage,
    status,
    is_archived: stage === 'archived',
    archived_at: stage === 'archived' ? new Date().toISOString() : null,
  })
}

export const updateThreadStatus = async (threadKey: string, status: string): Promise<InboxThreadStateMutationResult> => {
  const archived = status === 'archived'
  return writeInboxThreadState(threadKey, {
    status,
    is_archived: archived,
    archived_at: archived ? new Date().toISOString() : null,
  })
}

export const updateThreadPriority = async (threadKey: string, priority: string): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    priority,
    is_urgent: priority === 'urgent',
  })
}

export const pinThread = async (threadKey: string, pinned: boolean): Promise<InboxThreadStateMutationResult> => {
  return writeInboxThreadState(threadKey, {
    is_pinned: pinned,
  })
}

export const flagThread = async (threadKey: string): Promise<InboxThreadStateMutationResult> => {
  return updateThreadStage(threadKey, 'needs_response')
}

export const sendDraft = async (_threadIdOrKey: string, _text: string): Promise<void> => {
  void _threadIdOrKey
  void _text
  throw new Error('sendDraft: replaced by sendInboxMessageNow — use that instead')
}

// ── Suppression / opt-out check ───────────────────────────────────────────
/**
 * Returns true if the phone number appears opted out or suppressed.
 * Checks:
 *   1. The most recent message_events row for that phone has is_opt_out=true
 *   2. A sms_suppression_list table exists and contains the phone
 */
export const checkSuppressionStatus = async (phone: string): Promise<{ suppressed: boolean; reason: string | null }> => {
  if (!phone) return { suppressed: false, reason: null }
  const supabase = getSupabaseClient()
  const variants = buildPhoneVariants(phone)

  // Check message_events for opt-out
  const { data: optOutRows } = await supabase
    .from('message_events')
    .select('is_opt_out,opt_out_keyword')
    .or(
      variants.map(v => `from_phone_number.eq.${safeFilterValue(v)}`).concat(
        variants.map(v => `to_phone_number.eq.${safeFilterValue(v)}`),
      ).join(','),
    )
    .order('created_at', { ascending: false })
    .limit(10)

  const rows = safeArray(optOutRows as AnyRecord[])
  const optedOut = rows.some((r) => asBoolean(r['is_opt_out'], false))
  if (optedOut) {
    const keywordRow = rows.find(r => r['opt_out_keyword'])
    const keyword = asString(keywordRow ? (keywordRow as AnyRecord)['opt_out_keyword'] : null, '')
    return { suppressed: true, reason: `Opted out${keyword ? ` (${keyword})` : ''}` }
  }

  // Try sms_suppression_list if it exists
  for (const variant of variants) {
    const { data: suppRows, error: suppErr } = await supabase
      .from('sms_suppression_list')
      .select('id,reason')
      .or(`phone.eq.${safeFilterValue(variant)},phone_number.eq.${safeFilterValue(variant)},canonical_e164.eq.${safeFilterValue(variant)}`)
      .limit(1)
    if (!suppErr && safeArray(suppRows as AnyRecord[]).length > 0) {
      const suppRow = safeArray(suppRows as AnyRecord[])[0]!
      return { suppressed: true, reason: `Suppressed: ${asString(getFirst(suppRow, ['reason']), 'on suppression list')}` }
    }
    // If error code 42P01 (no such table), stop trying
    if (suppErr && (suppErr as { code?: string }).code === '42P01') break
  }

  return { suppressed: false, reason: null }
}

/**
 * Send Now from Inbox:
 * Manual operator sends always route through the backend cockpit API.
 * The backend owns validation, immediate provider send, message_events, and send_queue audit writes.
 */
export const sendInboxMessageNow = async (
  thread: InboxThread,
  messageText: string,
  options?: InboxSendOptions,
): Promise<SendNowResult> => {
  const simplifyBackendError = (sendResult: any): { message: string; reason: string; detailReason: string } => {
    const upstream = (sendResult?.upstream ?? {}) as AnyRecord
    const reason = String(
      upstream?.reason ||
      upstream?.error ||
      sendResult?.error ||
      ''
    ).trim().toLowerCase()
    const detailReason = String(
      upstream?.detail_reason ||
      (upstream?.diagnostics as AnyRecord | undefined)?.detail_reason ||
      ''
    ).trim()
    const messageMap: Record<string, string> = {
      outbound_sms_disabled: 'Automation paused.',
      queue_runner_disabled: 'Queue runner is currently disabled.',
      operator_send_disabled: 'Manual operator send is currently disabled.',
      recent_delivery_failures: 'Recent delivery issue detected.',
      hard_compliance_block: 'Send blocked by compliance rules (STOP/DNC/legal).',
      compliance_blocked: 'Send blocked by compliance rules (STOP/DNC/legal).',
      duplicate_blocked: 'Duplicate send prevented.',
      missing_routing: 'No reply route was resolved for this thread.',
      invalid_number: 'The destination phone number is invalid.',
      invalid_payload: 'Manual send payload is invalid.',
      content_blocked: 'Message blocked by content safety checks.',
      send_failed: 'Provider send failed.',
      queue_insert_failure: 'Queue insertion failed before provider send could start.',
    }
    const friendlyMessage = detailReason || messageMap[reason] || String(upstream?.message || sendResult?.message || 'Send failed').slice(0, 220)
    return {
      reason,
      detailReason,
      message: reason
        ? `${reason}${friendlyMessage && friendlyMessage.toLowerCase() !== reason ? ` — ${friendlyMessage}` : ''}`
        : friendlyMessage,
    }
  }

  const emitManualSendProof = (proof: ManualSendProof) => {
    try {
      if (typeof window !== 'undefined') {
        ;(window as typeof window & { __LAST_MANUAL_SEND_PROOF__?: ManualSendProof }).__LAST_MANUAL_SEND_PROOF__ = proof
      }
    } catch {
      // ignore window proof persistence failures
    }
    console.log('[ManualSendProof]', proof)
  }

  const trimmedText = messageText.trim()
  if (!trimmedText) {
    return { ok: false, clientSendId: null, queueId: null, messageEventId: null, providerMessageSid: null, deliveryStatus: null, errorMessage: 'Message text is required', guardReason: null, backendReason: null, insertPayloadKeys: [], suppressionBlocked: false, sendRouteUsed: 'none', queueProcessorEligible: false, proof: null }
  }

  const personalization = buildQueuePersonalization(thread, trimmedText)
  const templateAttachment = buildSelectedTemplatePayload(options?.selectedTemplate, options?.threadContext)

  const toPhone = normalizePhone(thread.canonicalE164 || thread.phoneNumber)
  if (!toPhone) {
    return { ok: false, clientSendId: null, queueId: null, messageEventId: null, providerMessageSid: null, deliveryStatus: null, errorMessage: 'Thread has no valid phone number', guardReason: null, backendReason: null, insertPayloadKeys: [], suppressionBlocked: false, sendRouteUsed: 'none', queueProcessorEligible: false, proof: null }
  }

  // ── Suppression check ──────────────────────────────────────────────────────
  const { suppressed, reason: suppressionReason } = await checkSuppressionStatus(toPhone)
  if (suppressed) {
    console.warn('[sendInboxMessageNow] local suppression matched; deferring final decision to backend', { toPhone, suppressionReason })
  }

  // ── Resolve from number (STRICT RULE) ──────────────────────────────────────
  // 1. Identify seller phone (normalized to E.164)
  const toE164 = (v: unknown): string => {
    const raw = String(v ?? '').trim()
    if (!raw) return ''
    const digits = raw.replace(/\D/g, '')
    if (!digits) return ''
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
    return raw.startsWith('+') ? raw : digits ? `+${digits}` : ''
  }

  const sellerPhone = toE164(thread.canonicalE164 || thread.phoneNumber || thread.sellerPhone || toPhone)
  
  let fromPhone = options?.fromPhoneNumber || thread.ourNumber || null
  if (fromPhone) fromPhone = toE164(fromPhone)

  let textgridNumberId = thread.textgridNumberId || null

  const now = new Date().toISOString()
  const queueKey = `inbox:send_now:${thread.threadKey ?? thread.id}:${Date.now()}`

  const insertPayload: Record<string, unknown> = {
    queue_status: 'queued',    // processor selects WHERE queue_status = 'queued'
    queue_key: queueKey,
    queue_id: queueKey,
    queue_sequence: 1,
    scheduled_for: now,
    scheduled_for_utc: now,
    scheduled_for_local: now,
    send_priority: 10,          // higher priority than feed rows (priority 5)
    is_locked: false,
    retry_count: 0,
    max_retries: 3,
    message_body: personalization.messageText,
    message_text: personalization.messageText,
    to_phone_number: sellerPhone,
    from_phone_number: fromPhone,
    thread_key: thread.threadKey || sellerPhone,
    property_id: thread.propertyId || options?.threadContext?.property?.id || null,
    master_owner_id: thread.ownerId || options?.threadContext?.seller?.id || null,
    prospect_id: thread.prospectId || null,
    phone_number_id: thread.phoneNumberId || null,
    character_count: personalization.messageText.length,
    touch_number: 1,
    current_stage: 'manual_reply',
    message_type: 'manual_reply',
    use_case_template: templateAttachment.useCaseTemplate,
    metadata: {
      source: 'inbox',
      action: 'send_now',
      thread_key: thread.threadKey || sellerPhone,
      selected_thread_id: thread.id,
      created_from: 'leadcommand_inbox',
      our_number: fromPhone,
      seller_phone: sellerPhone,
      note: 'queued_ready_for_processor',
      ...(options?.clientSendId ? { client_send_id: options.clientSendId } : {}),
      ...buildQueueRoutingMetadata(thread),
      template_variables: personalization.renderVariables,
      candidate_snapshot: personalization.candidateSnapshot,
      personalization: personalization.personalizationMeta,
      ...SMS_ROUTE_METADATA,
      ...templateAttachment.metadata,
      resolution: {
        sellerPhone,
        resolvedFromPhone: fromPhone,
        resolutionSource: 'strict_thread_context',
        fromEqualsTo: fromPhone === sellerPhone,
      },
    },
    created_at: now,
    operator_override: options?.operatorOverride === true,
    force: options?.operatorOverride === true,
  }

  // ALWAYS include from_phone_number (now natively included above but preserving logic)
  if (templateAttachment.language) insertPayload.language = templateAttachment.language
  if (isValidUUID(asString(templateAttachment.templateId, ''))) {
    insertPayload.template_id = templateAttachment.templateId
    insertPayload.selected_template_id = templateAttachment.templateId
  }
  if (isValidUUID(asString(textgridNumberId, ''))) insertPayload.textgrid_number_id = textgridNumberId
  Object.assign(insertPayload, buildQueueRoutingColumns(thread))
  const requestPayload = {
    ...insertPayload,
    metadata: { ...((insertPayload.metadata as AnyRecord | undefined) || {}) },
  }


  const insertPayloadKeys = Object.keys(insertPayload)

  if (DEV) {
    console.log('[sendInboxMessageNow] routing to backend', { keys: insertPayloadKeys, toPhone, fromPhone, queueKey })
  } else {
    console.log('[sendInboxMessageNow] routing to backend | toPhone:', toPhone, '| fromPhone:', fromPhone)
  }

  // Log safe secret debug before delegating — confirms secret path is backendClient only.
  const { debug: secretDebug } = backendClient.getBackendApiSecretDebugSafe()
  console.log('[sendInboxMessageNow] using backendClient.sendInboxMessageNow', { secretDebug })

  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  // Backend is responsible for creating message_events row — no optimistic insert from dashboard.
  const sendResult = await backendClient.sendInboxMessageNow(insertPayload)

  const backendResponse = sendResult.ok
    ? (sendResult.data as AnyRecord)
    : (((sendResult as unknown as AnyRecord).upstream as AnyRecord | undefined) || null)
  const proof: ManualSendProof = {
    requestPayload,
    backendResponse,
    queueRowInserted: backendResponse
      ? (
          (backendResponse as AnyRecord).queue_inserted === true ||
          (
            (backendResponse as AnyRecord).queue_inserted !== false &&
            (
              (backendResponse as AnyRecord).queue_created === true ||
              Boolean((backendResponse as AnyRecord).queue_row_id) ||
              Boolean((backendResponse as AnyRecord).queue_id)
            )
          )
        )
      : false,
    queueRowId: backendResponse
      ? (asString(
          (backendResponse as AnyRecord).queue_row_id ||
          (backendResponse as AnyRecord).queue_id ||
          null,
          ''
        ) || null)
      : null,
  }
  emitManualSendProof(proof)

  if (!sendResult.ok) {
    const simplified = simplifyBackendError(sendResult as any)
    const upstream = (((sendResult as unknown as AnyRecord).upstream as AnyRecord | undefined) || {}) as AnyRecord
    console.error('[sendInboxMessageNow] backend call FAILED:', { error: sendResult.error, message: simplified.message, reason: simplified.reason, toPhone, fromPhone })
    return {
      ok: false,
      clientSendId: options?.clientSendId ?? null,
      queueId: proof.queueRowId,
      messageEventId: asString(upstream.message_event_id, '') || null,
      providerMessageSid: asString(upstream.provider_message_id || upstream.provider_message_sid, '') || null,
      deliveryStatus: asString(upstream.delivery_status_display, '') || 'failed',
      errorMessage: simplified.message,
      guardReason: simplified.reason || String(sendResult.error || ''),
      backendReason: simplified.reason || null,
      hardBlock: upstream.hard_block === true,
      operatorOverrideAllowed: upstream.operator_override_allowed === true,
      insertPayloadKeys,
      suppressionBlocked: simplified.reason === 'compliance_blocked' || simplified.reason === 'hard_compliance_block',
      sendRouteUsed: 'provider_immediate',
      queueProcessorEligible: false,
      proof,
    }
  }

  const queueData = sendResult.data as AnyRecord
  const queueId = asString(queueData?.queue_audit_id || queueData?.queue_row_id || queueData?.queueId || queueData?.queue_id || queueKey, '')
  const messageEventId = asString((queueData as AnyRecord)?.messageEventId || (queueData as AnyRecord)?.message_event_id || null, '') || null
  const providerMessageSid = asString((queueData as AnyRecord)?.provider_message_id || (queueData as AnyRecord)?.provider_message_sid || null, '') || null
  const deliveryStatus = asString((queueData as AnyRecord)?.delivery_status_display || (queueData as AnyRecord)?.deliveryStatus || 'sent', 'sent') || 'sent'

  if (DEV) console.log('[sendInboxMessageNow] success via backend', { queueId, messageEventId, providerMessageSid, deliveryStatus, queueKey })
  else console.log('[sendInboxMessageNow] SUCCESS via backend - queueId:', queueId)

  return {
    ok: true,
    clientSendId: options?.clientSendId ?? null,
    queueId,
    messageEventId,
    providerMessageSid,
    deliveryStatus,
    errorMessage: null,
    guardReason: null,
    backendReason: null,
    insertPayloadKeys,
    suppressionBlocked: false,
    sendRouteUsed: 'provider_immediate',
    queueProcessorEligible: true,
    proof,
  }
}

/**
 * Schedule a reply from Inbox.
 * Inserts a send_queue row with status='scheduled' and the given scheduledAt time.
 */
export const scheduleReplyFromInbox = async (
  thread: InboxThread,
  messageText: string,
  scheduledAt: string,
  options?: InboxTemplateSendOptions,
): Promise<QueueReplyResult> => {
  const trimmedText = messageText.trim()
  if (!trimmedText) {
    return { ok: false, queueId: null, status: null, errorMessage: 'Message text is required', insertPayloadKeys: [] }
  }

  const personalization = buildQueuePersonalization(thread, trimmedText)
  const templateAttachment = buildSelectedTemplatePayload(options?.selectedTemplate, options?.threadContext)

  const toPhone = normalizePhone(thread.canonicalE164 || thread.phoneNumber)
  if (!toPhone) {
    return { ok: false, queueId: null, status: null, errorMessage: 'Thread has no valid phone number', insertPayloadKeys: [] }
  }

  const routingResult = await resolveOutboundTextgridNumber({
    marketId: thread.marketId,
    market: thread.market || thread.marketName,
    ourNumber: thread.ourNumber,
    phoneNumber: thread.phoneNumber,
    textgridNumberId: thread.textgridNumberId,
    property_address_state: thread.property_address_state,
    propertyId: thread.propertyId,
    threadKey: thread.threadKey,
  }, false)

  if (!routingResult.ok) {
    return { ok: false, queueId: null, status: null, errorMessage: routingResult.error || 'Routing failed', insertPayloadKeys: [] }
  }

  const fromPhone = routingResult.from_phone_number
  const textgridNumberId = routingResult.textgrid_number_id

  const now = new Date().toISOString()
  const scheduledIso = scheduledAt || now
  const queueKey = `inbox:scheduled:${thread.threadKey ?? thread.id}:${Date.now()}`

  const payload: Record<string, unknown> = {
    queue_status: 'queued',    // processor selects WHERE queue_status = 'queued' AND scheduled_for <= now
    queue_key: queueKey,
    queue_id: queueKey,
    queue_sequence: 1,
    scheduled_for: scheduledIso,   // processor skips until this timestamp is reached
    scheduled_for_utc: scheduledIso,
    scheduled_for_local: scheduledIso,
    send_priority: 5,
    is_locked: false,
    retry_count: 0,
    max_retries: 3,
    message_body: personalization.messageText,
    message_text: personalization.messageText,
    to_phone_number: toPhone,
    character_count: personalization.messageText.length,
    touch_number: 1,
    current_stage: 'manual_reply',
    message_type: 'manual_scheduled_reply',
    use_case_template: templateAttachment.useCaseTemplate,
    metadata: {
      source: 'inbox',
      action: 'schedule_reply',
      thread_key: thread.threadKey,
      selected_thread_id: thread.id,
      created_from: 'leadcommand_inbox',
      our_number: thread.ourNumber,
      seller_phone: thread.phoneNumber,
      ...buildQueueRoutingMetadata(thread),
      template_variables: personalization.renderVariables,
      candidate_snapshot: personalization.candidateSnapshot,
      personalization: personalization.personalizationMeta,
      ...SMS_ROUTE_METADATA,
      ...templateAttachment.metadata,
    },
    created_at: now,
  }

  // ALWAYS include from_phone_number (even if null)
  payload.from_phone_number = fromPhone
  if (templateAttachment.language) payload.language = templateAttachment.language
  if (isValidUUID(asString(templateAttachment.templateId, ''))) {
    payload.template_id = templateAttachment.templateId
    payload.selected_template_id = templateAttachment.templateId
  }
  if (isValidUUID(asString(thread.phoneNumberId, ''))) payload.phone_number_id = thread.phoneNumberId
  if (isValidUUID(asString(textgridNumberId, ''))) payload.textgrid_number_id = textgridNumberId
  Object.assign(payload, buildQueueRoutingColumns(thread))

  const insertPayloadKeys = Object.keys(payload)
  if (DEV) console.log('[scheduleReplyFromInbox] routing to backend queue_status=scheduled', { toPhone, scheduledAt: scheduledIso, queueKey })

  // This mutation must live in real-estate-automation. Dashboard is cockpit-only.
  const result = await backendClient.scheduleInboxReply(payload)
  if (!result.ok) {
    if (DEV) console.error('[scheduleReplyFromInbox] backend call failed:', result.error, result.message)
    return { ok: false, queueId: null, status: null, errorMessage: result.message, insertPayloadKeys }
  }

  const queueId = asString((result.data as AnyRecord)?.queueId || (result.data as AnyRecord)?.queue_id || queueKey, '')
  if (DEV) console.log('[scheduleReplyFromInbox] success via backend', { queueId, scheduledAt: scheduledIso })

  return { ok: true, queueId, status: 'scheduled', errorMessage: null, insertPayloadKeys }
}

export interface LiveDashboardPrepMetrics {
  inboundVolume: number | null
  outboundSent: number | null
  delivered: number | null
  failed: number | null
  responseRate: number | null
  positiveReplies: number | null
  needsReply: number | null
  autoRepliesQueued: number | null
  autoRepliesSent: number | null
  autoRepliesFailed: number | null
  marketPerformance: Record<string, number | null>
  queueHealth: Record<string, unknown>
  textGridNumberHealth: Record<string, unknown>
  podioCooldownStatus: string | null
}

export const buildLiveDashboardPrepMetrics = (counts: Record<string, number | null | undefined> = {}): LiveDashboardPrepMetrics => ({
  inboundVolume: counts.inboundVolume ?? counts.inbound_volume ?? null,
  outboundSent: counts.outboundSent ?? counts.outbound_sent ?? null,
  delivered: counts.delivered ?? null,
  failed: counts.failed ?? null,
  responseRate: counts.responseRate ?? counts.response_rate ?? null,
  positiveReplies: counts.positiveReplies ?? counts.positive_replies ?? null,
  needsReply: counts.needsReply ?? counts.needs_reply ?? null,
  autoRepliesQueued: counts.autoRepliesQueued ?? counts.auto_replies_queued ?? null,
  autoRepliesSent: counts.autoRepliesSent ?? counts.auto_replies_sent ?? null,
  autoRepliesFailed: counts.autoRepliesFailed ?? counts.auto_replies_failed ?? null,
  marketPerformance: {},
  queueHealth: {},
  textGridNumberHealth: {},
  podioCooldownStatus: counts.podioCooldown === null || counts.podioCooldown === undefined ? null : String(counts.podioCooldown),
})
