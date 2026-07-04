import { formatRelativeTime } from '../../shared/formatters'
import type { InboxModel, InboxThread } from '../../domain/inbox/inbox-model-types'
import { resolveCanonicalThreadStateKey } from '../../domain/inbox/resolveCanonicalThreadStateKey'
import type { InboxViewSelectValue } from '../../domain/inbox/inbox-view-types'
import type { InboxWorkflowThread } from './inboxWorkflowData'
import type { SmsTemplate } from './templateData'
import { resolveOutboundTextgridNumber } from './textgridRouting'
import { getSupabaseClient, hasSupabaseEnv } from '../supabaseClient'
import * as backendClient from '../api/backendClient'
import { persistUniversalLeadState } from '../../domain/lead-state/persistUniversalLeadState'
import { normalizePatchToCanonical } from '../../domain/lead-state/universal-lead-state-registry'
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
import { getDealContextByThread, normalizeDealContext, type DealContext } from './dealContext'
import { commitDashboardMessages, commitDashboardThreads } from './dashboardEntityStore'
import { dataLayerNow, loadDashboardViewModel, logHydrationPhaseDone } from './dashboardDataLayer'

const TEXTGRID_NUMBERS = new Set([
  '+16128060495', '+13235589881', '+17866052999', '+19804589889', 
  '+13234104544', '+14704920588', '+14693131600', '+12818458577', 
  '+19048774448', '+17042405818'
])

function isTextGridNumber(phone: string | null | undefined): boolean {
  if (!phone) return false
  const digits = String(phone).replace(/\D/g, '')
  let normalized = phone
  if (digits.length === 10) normalized = `+1${digits}`
  else if (digits.length === 11 && digits.startsWith('1')) normalized = `+${digits}`
  else if (digits) normalized = `+${digits}`
  return TEXTGRID_NUMBERS.has(normalized || '')
}

const toE164 = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const normalized = normalizePhone(raw)
  if (!normalized) return ''
  if (normalized.startsWith('+')) return normalized

  const digits = normalized.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

const isAbortLikeError = (err: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted === true) return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error) {
    const message = err.message.toLowerCase()
    return err.name === 'AbortError' || message.includes('abort') || message.includes('signal is aborted')
  }
  return false
}

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
  _force?: boolean
  _timeoutMode?: 'initial_boot' | 'manual_bucket_switch' | 'auto_refresh'
  _refreshReason?: string
  paused?: boolean
}

export interface LiveInboxFetchParams {
  filter?: string
  direction?: 'inbound' | 'outbound' | 'all' | string
  q?: string
  keywordGroup?: string
  cursor?: string | null
  limit?: number
  map?: boolean
  advanced?: Record<string, unknown>
  timeoutMode?: 'initial_boot' | 'manual_bucket_switch' | 'auto_refresh'
  refreshReason?: string
  skipCounts?: boolean
  skipDelivery?: boolean
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
  propertyId?: string
  lat: number
  lng: number
  status?: string
  stage?: string
  ownerName?: string
  propertyAddress?: string
  latestMessageBody?: string
}

export interface LiveInboxDiagnostics {
  source?: string | null
  liveSource?: string | null
  fallbackUsed?: boolean
  countsDegraded?: boolean
  countsApproximate?: boolean
  countsSource?: string | null
  countPreservedReason?: string | null
  queryMs?: number | null
  threadQueryMs?: number | null
  countQueryMs?: number | null
}

export interface LiveInboxResponse {
  threads: InboxThread[]
  messages: ThreadMessage[]
  counts: Record<string, number | null | undefined>
  mapPins: LiveInboxMapPin[]
  pagination: LiveInboxPagination
  diagnostics?: LiveInboxDiagnostics
  source?: string | null
  fallbackUsed?: boolean
  countsDegraded?: boolean
  countsApproximate?: boolean
  countsSource?: string | null
  countPreservedReason?: string | null
  rawRows?: AnyRecord[]
}

export interface ThreadMessage {
  id: string
  threadKey?: string
  conversationThreadId?: string
  conversation_thread_id?: string
  direction: 'inbound' | 'outbound' | 'unknown'
  body: string
  createdAt: string
  timelineAt: string
  sentAt?: string | null
  deliveredAt: string | null
  deliveryStatus: string
  deliveryStatusDisplay?: 'queued' | 'sent' | 'delivered' | 'failed'
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



const DEV = Boolean(import.meta.env?.DEV)
let _loggedPhoneSampleKeys = false
const INBOX_DEBUG_VERBOSE = DEV && String(import.meta.env?.VITE_INBOX_DEBUG ?? 'false').toLowerCase() === 'true'
export const INBOX_DEBUG_LOOKUPS = INBOX_DEBUG_VERBOSE || (DEV && String(import.meta.env?.VITE_INBOX_DEBUG_LOOKUPS ?? 'false').toLowerCase() === 'true')
const MESSAGE_EVENTS_THREAD_PAGE_SIZE = 50
export const HYDRATED_INBOX_PAGE_SIZE = 100
const INITIAL_BOOT_LIVE_LIMIT = 25
const BUCKET_SWITCH_LIVE_LIMIT = 30
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
  'waiting',
  'cold_no_response',
  'dead',
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
  dead: 'dead',
  wrong_number: 'dead',
  opt_out: 'dnc_opt_out',
  priority: ['hot_leads', 'needs_review', 'new_inbound'],
  active: ['automated', 'outbound_active'],
  waiting: 'waiting' as HydratedInboxCategory,
  not_contacted: 'not_contacted',
}

const HYDRATED_PRIORITY_CATEGORIES = new Set<HydratedInboxCategory>(['hot_leads', 'needs_review', 'new_inbound'])

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

  const prospectName = firstName && lastName ? `${firstName} ${lastName}` : firstName || null

  const candidates: Array<{ val: unknown; source: string }> = [
    { val: row.owner_name || row.ownerName, source: 'master_owner_name' },
    { val: row.primary_owner_name || row.primaryOwnerName, source: 'primary_owner_name' },
    { val: row.prospect_full_name || row.prospectFullName || row.prospect_name || row.prospectName, source: 'prospect_full_name' },
    { val: prospectName, source: 'prospect_names' },
    { val: row.contact_name || row.contactName, source: 'contact_name' },
    { val: row.seller_display_name || row.sellerDisplayName, source: 'seller_display_name' },
    { val: row.owner_display_name || row.ownerDisplayName, source: 'owner_display_name' },
    { val: row.seller_name || row.sellerName, source: 'seller_name' },
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

/** Prospect / respondent name for per-phone child threads (sidebar row headline). */
export const resolveInboxProspectNameWithSource = (row: Record<string, unknown>): { value: string; source: string } => {
  const firstName = asString(row.first_name || row.firstName || row.prospect_first_name || row.prospectFirstName || row.seller_first_name || row.sellerFirstName)
  const lastName = asString(row.last_name || row.lastName || row.prospect_last_name || row.prospectLastName || row.seller_last_name || row.sellerLastName)
  const prospectName = firstName && lastName ? `${firstName} ${lastName}` : firstName || null

  let meta: Record<string, unknown> = (row.metadata || row.meta || {}) as Record<string, unknown>
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) as Record<string, unknown> } catch { meta = {} }
  }

  const candidates: Array<{ val: unknown; source: string }> = [
    { val: row.prospect_full_name || row.prospectFullName || row.prospect_name || row.prospectName, source: 'prospect_full_name' },
    { val: prospectName, source: 'prospect_names' },
    { val: row.prospect_cnam || row.prospectCnam, source: 'prospect_cnam' },
    { val: row.contact_name || row.contactName, source: 'contact_name' },
    { val: row.seller_display_name || row.sellerDisplayName, source: 'seller_display_name' },
    { val: row.seller_name || row.sellerName, source: 'seller_name' },
    { val: meta.prospect_name || meta.contact_name || meta.seller_name, source: 'metadata_prospect' },
  ]

  for (const candidate of candidates) {
    const text = asString(candidate.val, '').trim()
    if (text && !isRawE164(text) && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'unknown seller') {
      return { value: text, source: candidate.source }
    }
  }

  const phoneRaw = asString(row.phoneNumber || row.phoneNumberId || row.canonicalE164 || row.canonical_e164 || row.seller_phone || row.phone || row.prospect_phone || row.best_phone, '').trim()
  if (phoneRaw) {
    return { value: formatDisplayPhone(phoneRaw), source: 'phone_fallback' }
  }

  return { value: 'Unknown Contact', source: 'none' }
}

export const resolveInboxProspectName = (row: Record<string, unknown>): string =>
  resolveInboxProspectNameWithSource(row).value

/** Master / property owner name for the property conversation container header. */
export const resolveInboxOwnerNameWithSource = (row: Record<string, unknown>): { value: string; source: string } => {
  const ownerFirstName = asString(row.owner_first_name || row.ownerFirstName || row.master_owner_first_name || row.masterOwnerFirstName)
  const ownerLastName = asString(row.owner_last_name || row.ownerLastName || row.master_owner_last_name || row.masterOwnerLastName)

  let meta: Record<string, unknown> = (row.metadata || row.meta || {}) as Record<string, unknown>
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) as Record<string, unknown> } catch { meta = {} }
  }

  const candidates: Array<{ val: unknown; source: string }> = [
    { val: row.owner_name || row.ownerName, source: 'master_owner_name' },
    { val: row.primary_owner_name || row.primaryOwnerName, source: 'primary_owner_name' },
    { val: row.property_owner_name || row.propertyOwnerName, source: 'property_owner_name' },
    { val: row.owner_display_name || row.ownerDisplayName, source: 'owner_display_name' },
    { val: ownerFirstName && ownerLastName ? `${ownerFirstName} ${ownerLastName}` : ownerFirstName || null, source: 'owner_names' },
    { val: meta.owner_name || meta.ownerName || meta.property_owner_name, source: 'metadata_owner' },
  ]

  for (const candidate of candidates) {
    const text = asString(candidate.val, '').trim()
    if (text && !isRawE164(text) && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'unknown owner') {
      return { value: text, source: candidate.source }
    }
  }

  const prospectFallback = resolveInboxProspectNameWithSource(row)
  if (prospectFallback.source !== 'none') {
    return { value: prospectFallback.value, source: `fallback_${prospectFallback.source}` }
  }

  const sellerName = asString(row.seller_display_name || row.sellerDisplayName || row.seller_name || row.sellerName, '').trim()
  if (sellerName && !isRawE164(sellerName) && sellerName.toLowerCase() !== 'unknown' && sellerName.toLowerCase() !== 'unknown seller') {
    return { value: sellerName, source: 'seller_display_name_fallback' }
  }

  const phoneRaw = asString(
    row.phoneNumber || row.phoneNumberId || row.canonicalE164 || row.canonical_e164
    || row.seller_phone || row.phone || row.best_phone,
    '',
  ).trim()
  if (phoneRaw) {
    return { value: formatDisplayPhone(phoneRaw), source: 'phone_fallback' }
  }

  return { value: 'Unknown Owner', source: 'none' }
}

export const resolveInboxOwnerName = (row: Record<string, unknown>): string =>
  resolveInboxOwnerNameWithSource(row).value

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

export const getQueueProcessorHealth = async (): Promise<QueueProcessorHealth> => {
  const checkedAt = new Date().toISOString()
  const webhookStaleCutoffIso = new Date(Date.now() - 90 * 60 * 1000).toISOString()

  try {
    const apiResult = await backendClient.fetchQueueProcessorHealth()
    if (!apiResult.ok) {
      const err = apiResult as { message?: string; error?: string }
      throw new Error(err.message || err.error || 'queue_processor_health_unavailable')
    }
    if (!apiResult.data) {
      throw new Error('queue_processor_health_unavailable')
    }
    const payload = apiResult.data as AnyRecord
    const counts = (payload.counts && typeof payload.counts === 'object' ? payload.counts : {}) as AnyRecord
    const issueRows = safeArray(payload.issueSample as AnyRecord[])
    const queuedCount = asNumber(counts.queued, 0)
    const pendingCount = asNumber(counts.pending, 0)
    const approvalCount = asNumber(counts.approval, 0)
    const scheduledBaseCount = asNumber(counts.scheduled, 0)
    const scheduledCount = scheduledBaseCount + approvalCount
    const sendingCount = asNumber(counts.processing, 0)
    const sentTodayCount = asNumber(counts.sentToday, 0)
    const deliveredTodayCount = asNumber(counts.deliveredToday, 0)
    const failedTodayCount = asNumber(counts.failedToday, 0)
    const queuedOlderThanLagWindow = asNumber(counts.lagActive, 0)
    const oldestQueuedAt = asIso(payload.oldestQueuedAt) ?? null
    const latestSentAt = asIso(payload.latestSentAt) ?? null
    const latestWebhookAt = asIso(payload.latestWebhookAt) ?? null
    const staleRowsCount = asNumber(counts.staleActive, 0)
    const orphanedRowsCount = asNumber(counts.orphanedActive, 0)
    const retriedGtOneCount = asNumber(counts.retriedGtOne, 0)
    const processingLockConflictCount = asNumber(counts.processingLockConflicts, 0)

    const blockedRows = issueRows.filter((row) => normalizeStatus(row.queue_status) === 'blocked')
    const pausedRows = issueRows.filter((row) => normalizeStatus(row.queue_status) === 'paused_invalid_queue_row')
    const routingBlockedRows = issueRows.filter((row) => {
      const reason = `${asString(row.guard_reason)} ${asString(row.failed_reason)}`.toLowerCase()
      return reason.includes('no_valid_local_textgrid_number') || reason.includes('routing blocked')
    })
    const routingBlockedCount = routingBlockedRows.length
    const failedRate = sentTodayCount > 0 ? (failedTodayCount / sentTodayCount) * 100 : null
    const routingBlockedSpike = routingBlockedCount >= 5
    const latestSentTs = latestSentAt ? new Date(latestSentAt).getTime() : NaN
    const latestWebhookTs = latestWebhookAt ? new Date(latestWebhookAt).getTime() : NaN
    const webhookHealthy = !Number.isFinite(latestSentTs) || latestSentTs < new Date(webhookStaleCutoffIso).getTime()
      ? true
      : Number.isFinite(latestWebhookTs) && latestWebhookTs >= new Date(webhookStaleCutoffIso).getTime()
    const status = (payload.status as QueueProcessorHealth['status']) || 'healthy'
    const processorHealthy = status === 'healthy'

    return {
      checkedAt: asIso(payload.checkedAt) ?? checkedAt,
      queuedCount,
      scheduledCount,
      sendingCount,
      sentTodayCount,
      deliveredTodayCount,
      failedTodayCount,
      blockedCount: blockedRows.length,
      pausedInvalidCount: pausedRows.length,
      duplicateSkippedCount: 0,
      suppressionBlockedCount: 0,
      blankBodyBlockedCount: 0,
      routingBlockedCount,
      repliedBeforeSendCount: 0,
      queuedOlderThanLagWindow,
      oldestQueuedAt,
      latestSentAt,
      latestWebhookAt,
      webhookHealthy,
      processorHealthy,
      status,
      failedRate,
      duplicateActiveCount: 0,
      activeBlankRowCount: 0,
      staleRowsCount,
      orphanedRowsCount,
      retriedGtOneCount,
      processingLockConflictCount,
      routingBlockedSpike,
      liveAutopilotAllowed: processorHealthy,
      routingBlockedRows: routingBlockedRows.slice(0, 8).map((row) => ({
        id: asString(row.id, ''),
        sellerName: asString(row.master_owner_id, 'Unknown Seller'),
        propertyAddress: asString(row.property_address, 'Property Unknown'),
        market: asString(row.market, 'Unknown'),
        reason: asString(row.failed_reason || row.guard_reason || row.blocked_reason, 'Routing blocked'),
        queueStatus: asString(row.queue_status, 'paused_invalid_queue_row'),
      })),
      summary: processorHealthy
        ? `${queuedCount + pendingCount + approvalCount + scheduledBaseCount + sendingCount} queue rows active`
        : 'Queue processor needs attention',
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

const firstNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    const text = asString(value, '').trim()
    if (text) return text
  }
  return ''
}

const normalizedPhoneForThreadIdentity = (row: AnyRecord): string => {
  const explicit = firstNonEmptyString(row.normalized_phone, row.normalizedPhone)
  if (explicit) return toE164(explicit) || normalizePhone(explicit)
  const direction = normalizeMessageDirection(row)
  const counterparty = direction === 'inbound'
    ? row.from_phone_number
    : direction === 'outbound'
      ? row.to_phone_number
      : null
  const raw = firstNonEmptyString(
    row.canonical_e164,
    row.canonicalE164,
    row.seller_phone,
    row.sellerPhone,
    row.best_phone,
    row.bestPhone,
    row.display_phone,
    row.displayPhone,
    row.phone,
    row.phoneNumber,
    counterparty,
  )
  return toE164(raw) || normalizePhone(raw)
}

export const buildConversationThreadIdFromRecord = (row: AnyRecord): string => {
  const explicit = firstNonEmptyString(row.conversation_thread_id, row.conversationThreadId)
  if (explicit) return explicit
  const prospectId = firstNonEmptyString(row.prospect_id, row.prospectId, row.final_prospect_id, row.canonical_prospect_id)
  const propertyId = firstNonEmptyString(row.property_id, row.propertyId, row.final_property_id, row.selected_property_id, row.thread_property_id)
  const ownerId = firstNonEmptyString(row.master_owner_id, row.masterOwnerId, row.owner_id, row.ownerId, row.final_master_owner_id, row.thread_master_owner_id)
  const phone = normalizedPhoneForThreadIdentity(row)
  const campaignOrSequence = firstNonEmptyString(row.campaign_id, row.campaignId, row.sequence_id, row.sequenceId)
  const parts: string[] = []
  if (prospectId) parts.push(`prospect:${prospectId}`)
  if (propertyId) parts.push(`property:${propertyId}`)
  if (ownerId) parts.push(`owner:${ownerId}`)
  if (phone) parts.push(`phone:${phone}`)
  if (!prospectId && !propertyId && !ownerId && campaignOrSequence) parts.push(`campaign:${campaignOrSequence}`)
  return parts.length ? `ct:${parts.join('|')}` : firstNonEmptyString(row.threadKey, row.thread_key, row.id)
}

export const getConversationThreadIdForThread = (thread: Partial<InboxThread> | Partial<InboxWorkflowThread> | AnyRecord | null | undefined): string => {
  if (!thread) return ''
  return buildConversationThreadIdFromRecord(thread as AnyRecord)
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
  // Only allow indexed ID lookups on properties — address-based OR queries cause statement timeouts.
  // NOTE: public.properties has no `id` column — property_id is the canonical key.
  properties: ['property_id', 'owner_id', 'master_owner_id'],
}

// Minimal column sets to avoid select=* on large tables
const SELECT_COLUMNS_BY_ALIAS: Record<string, string> = {
  properties: 'property_id,master_owner_id,owner_id,property_address,property_address_full,market',
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
const viteEnv = (typeof import.meta !== 'undefined' && import.meta.env)
  ? import.meta.env as Record<string, string | undefined>
  : {}
const KNOWN_OUR_NUMBERS: Set<string> = new Set(
  [
    viteEnv.VITE_TEXTGRID_FROM_NUMBER,
    viteEnv.VITE_TEXTGRID_NUMBER,
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_TEXTGRID_FROM_NUMBER,
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_TEXTGRID_NUMBER,
  ]
    .filter(Boolean)
    .map(normalizePhone)
    .filter(Boolean),
)

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
    }
    // Removed expensive nested scan for unknown direction to prevent blocking commit
  }

  // ── DEV warnings (Non-blocking / rate-limited equivalent) ────────────────
  if (!sellerPhone) {
    const fallbackIdentity = normalizePhone(row['canonical_e164']) || normalizePhone(row['thread_key'] ?? row['threadKey'])
    if (fallbackIdentity) {
      sellerPhone = fallbackIdentity
      sellerPhoneSourceField = row['canonical_e164'] ? 'canonical_e164' : 'thread_key'
    }
  }

  if (DEV && !sellerPhone) {
    const fromPhone = normalizePhone(row['from_phone_number'])
    const toPhone = normalizePhone(row['to_phone_number'])
    
    // Identity falls back to threadKey or id safely, don't crash
    const threadKey = asString(row['thread_key'] ?? row['threadKey'] ?? row['id'], '')

    if (direction !== 'unknown' && (fromPhone || toPhone)) {
      if (!threadKey || Math.random() < 0.05) {
        console.warn('[Inbox Seller Phone Mapping Failed]', {
          direction,
          from_phone_number: fromPhone,
          to_phone_number: toPhone,
          id: row['id']
        })
      }
    } else if (!fromPhone && !toPhone) {
      if (!threadKey || Math.random() < 0.05) {
        console.warn('[Inbox Thread Identity Missing] from_phone_number and to_phone_number are both empty.', {
          id: row['id'],
          direction,
          recommendation: 'message_events rows need from_phone_number / to_phone_number populated.'
        })
      }
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
  const threadKeyFallback = normalizePhone(row['canonical_e164']) || normalizePhone(row['thread_key'] ?? row['threadKey'])

  // The inbox conversation is keyed by seller phone. Outbound rows often carry
  // owner/property IDs while inbound webhook rows do not, so phone-first keeps
  // replies merged with the original outreach thread.
  if (sellerPhone)
    return { key: `phone:${sellerPhone}`, method: 'seller_phone', confidence: 'medium' }
  if (threadKeyFallback)
    return { key: `phone:${threadKeyFallback}`, method: 'thread_key_or_canonical_e164', confidence: 'medium' }
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

const asRecord = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : {}

const normalizeLiveThread = (row: AnyRecord, index: number): InboxThread => {
  return normalizeInboxThread(row, 0, index)
}

const normalizeLiveInboxMapPin = (row: AnyRecord, index: number): LiveInboxMapPin => {
  const propertyId = asString(row.property_id ?? row.propertyId, '')
  const threadKey = asString(
    row.thread_key ?? row.threadKey ?? row.latest_thread_key ?? row.latestThreadKey,
    '',
  )
  const id = threadKey || propertyId || asString(row.id, `pin:${index}`)
  return {
    id,
    threadKey: threadKey || id,
    propertyId: propertyId || undefined,
    lat: asNumber(row.lat ?? row.latitude, 0),
    lng: asNumber(row.lng ?? row.longitude, 0),
    status: asString(row.status ?? row.thread_stage ?? row.inbox_status, ''),
    stage: asString(row.stage ?? row.thread_stage ?? row.conversation_stage, ''),
    ownerName: asString(row.owner_name ?? row.ownerName ?? row.prospect_name, ''),
    propertyAddress: asString(
      row.property_address ?? row.propertyAddress ?? row.property_address_full,
      '',
    ),
    latestMessageBody: asString(row.latest_message_body ?? row.latestMessageBody, ''),
  }
}

const normalizeLiveInboxResponse = (payload: AnyRecord, fallbackLimit: number): LiveInboxResponse => {
  const rawThreads = safeArray(payload['threads'] as AnyRecord[])
  const rawMessages = safeArray(payload['messages'] as AnyRecord[])
  const rawPins = safeArray((payload['mapPins'] ?? payload['map_pins']) as AnyRecord[])
  const pagination = (payload['pagination'] ?? {}) as AnyRecord
  const diagnostics = (payload['diagnostics'] ?? {}) as AnyRecord
  return {
    threads: rawThreads.map(normalizeLiveThread),
    rawRows: rawThreads,
    messages: rawMessages.map(toThreadMessage),
    counts: (payload['counts'] ?? {}) as Record<string, number | null | undefined>,
    mapPins: rawPins.map((pin, index) => normalizeLiveInboxMapPin(pin, index)),
    pagination: {
      cursor: asString(pagination['cursor'], '') || null,
      nextCursor: asString(pagination['nextCursor'] ?? pagination['next_cursor'], '') || null,
      hasMore: asBoolean(pagination['hasMore'] ?? pagination['has_more'], rawThreads.length >= fallbackLimit),
      limit: asNumber(pagination['limit'], fallbackLimit),
      total: Number.isFinite(Number(pagination['total'])) ? Number(pagination['total']) : null,
    },
    diagnostics: {
      source: asString(diagnostics['source'] ?? payload['source'], '') || null,
      liveSource: asString(diagnostics['live_source'] ?? diagnostics['liveSource'] ?? diagnostics['source'] ?? payload['source'], '') || null,
      fallbackUsed: asBoolean(diagnostics['fallback_used'] ?? diagnostics['fallbackUsed'] ?? payload['fallback_used'] ?? payload['fallbackUsed'], false),
      countsDegraded: asBoolean(diagnostics['countsDegraded'] ?? diagnostics['counts_degraded'] ?? payload['countsDegraded'] ?? payload['counts_degraded'], false),
      countsApproximate: asBoolean(diagnostics['countsApproximate'] ?? diagnostics['counts_approximate'] ?? payload['countsApproximate'] ?? payload['counts_approximate'], false),
      countsSource: asString(diagnostics['countsSource'] ?? diagnostics['counts_source'] ?? payload['countsSource'] ?? payload['counts_source'], '') || null,
      countPreservedReason: asString(diagnostics['count_preserved_reason'] ?? diagnostics['countPreservedReason'] ?? payload['count_preserved_reason'] ?? payload['countPreservedReason'], '') || null,
      queryMs: Number.isFinite(Number(diagnostics['queryMs'])) ? Number(diagnostics['queryMs']) : null,
      threadQueryMs: Number.isFinite(Number(diagnostics['threadQueryMs'])) ? Number(diagnostics['threadQueryMs']) : null,
      countQueryMs: Number.isFinite(Number(diagnostics['countQueryMs'])) ? Number(diagnostics['countQueryMs']) : null,
    },
    source: asString(payload['source'] ?? diagnostics['source'], '') || null,
    fallbackUsed: asBoolean(payload['fallback_used'] ?? payload['fallbackUsed'] ?? diagnostics['fallback_used'] ?? diagnostics['fallbackUsed'], false),
    countsDegraded: asBoolean(payload['countsDegraded'] ?? payload['counts_degraded'] ?? diagnostics['countsDegraded'] ?? diagnostics['counts_degraded'], false),
    countsApproximate: asBoolean(payload['countsApproximate'] ?? payload['counts_approximate'] ?? diagnostics['countsApproximate'] ?? diagnostics['counts_approximate'], false),
    countsSource: asString(payload['countsSource'] ?? payload['counts_source'] ?? diagnostics['countsSource'] ?? diagnostics['counts_source'], '') || null,
    countPreservedReason: asString(payload['count_preserved_reason'] ?? payload['countPreservedReason'] ?? diagnostics['count_preserved_reason'] ?? diagnostics['countPreservedReason'], '') || null,
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
  advanced,
  timeoutMode,
  refreshReason,
  skipCounts,
  skipDelivery,
  signal,
}: LiveInboxFetchParams = {}): Promise<LiveInboxResponse> => {
  const params = new URLSearchParams()
  const entries: Record<string, unknown> = {
    filter,
    direction,
    q,
    keywordGroup,
    cursor,
    limit,
    map: map ? '1' : '0',
    advanced: advanced && Object.keys(advanced).length > 0 ? JSON.stringify(advanced) : undefined,
    timeout_mode: timeoutMode,
    refresh_reason: refreshReason,
    skip_counts: skipCounts ? '1' : undefined,
    skip_delivery: skipDelivery ? '1' : undefined,
  }
  Object.entries(entries).forEach(([key, value]) => {
    const param = toQueryParam(value)
    if (param) params.set(key, param)
  })

  const queryString = params.toString()
  console.log('[INBOX_API_REQUEST]', {
    url: `/api/cockpit/inbox/live?${queryString}`,
    filter,
    timeoutMode: timeoutMode ?? null,
    refreshReason: refreshReason ?? null,
  })
  const result = await backendClient.fetchLiveInbox(queryString, signal)
  const responsePayload = result.ok ? result.data as AnyRecord : null
  const responseData = responsePayload?.data && typeof responsePayload.data === 'object'
    ? responsePayload.data as AnyRecord
    : null
  const responseThreads = safeArray(
    (responsePayload?.threads ?? responseData?.threads ?? responsePayload?.messages ?? responseData?.messages ?? []) as AnyRecord[],
  )
  console.log('[INBOX_API_RESPONSE]', {
    url: `/api/cockpit/inbox/live?${queryString}`,
    status: result.status,
    ok: result.ok,
    responseBodyCount: responseThreads.length,
    responseBodyPath: responsePayload?.threads ? 'threads' : responseData?.threads ? 'data.threads' : responsePayload?.messages ? 'messages' : responseData?.messages ? 'data.messages' : null,
  })
  if (!result.ok) {
    const errorMsg = result.message || result.error || 'Unknown API error'
    throw new Error(`Live inbox API failed (${result.status}): ${errorMsg}`)
  }
  const payload = result.data as AnyRecord
  const nestedData = ((payload['data'] && typeof payload['data'] === 'object') ? payload['data'] : null) as AnyRecord | null
  const hasNestedLivePayload = Boolean(
    nestedData &&
    (
      Array.isArray(nestedData['threads']) ||
      Array.isArray(nestedData['messages']) ||
      typeof nestedData['pagination'] === 'object' ||
      typeof nestedData['counts'] === 'object'
    )
  )
  const normalizedPayload = hasNestedLivePayload ? { ...payload, ...nestedData } : payload
  const degradedThreads = safeArray((normalizedPayload['threads'] ?? []) as AnyRecord[])
  if (payload['degraded'] && degradedThreads.length === 0) {
    // Backend hit its internal timeout — throw so the adapter falls back to cache
    // rather than overwriting good cached rows with an empty degraded response.
    throw new Error(`Live inbox API degraded (backend timeout)`)
  }
  return normalizeLiveInboxResponse(normalizedPayload, limit)
}

const runFilteredQuery = async (
  tableOrAlias: string,
  filters: Array<{ key: string; value: string }>,
  limit = 20,
  signal?: AbortSignal,
): Promise<AnyRecord[]> => {
  const table = await resolveTable(tableOrAlias)
  if (!table) return []
  const supabase = getSupabaseClient()
  const selectCols = SELECT_COLUMNS_BY_ALIAS[tableOrAlias] ?? '*'
  let query = supabase.from(table).select(selectCols).limit(limit)
  if (signal) query = query.abortSignal(signal)
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
    if (signal?.aborted) return []
    if (DEV) console.warn(`[NEXUS] ${table} lookup failed`, error.message)
    return []
  }
  return safeArray(data as unknown as AnyRecord[])
}

/**
 * Merges source into target, but only for fields that are missing or empty in target.
 * Prevents "Unknown" or empty enrichment from overwriting valid live data.
 */
const fillEmptyFields = (target: AnyRecord, source: AnyRecord): AnyRecord => {
  const result = { ...target }
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key]
    const hasValue = value !== null && value !== undefined && value !== '' && value !== 'unknown' && value !== 'Unknown'
    const targetIsEmpty = existing === null || existing === undefined || existing === '' || existing === 'unknown' || existing === 'Unknown'
    
    if (hasValue && targetIsEmpty) {
      result[key] = value
    }
  }
  return result
}

export const normalizeInboxThread = (row: AnyRecord, offset = 0, index = 0): InboxThread => {
  const dc = normalizeDealContext(row)
  const legacyThreadKey = dc.thread_key || asString(row.legacyThreadKey || row.legacy_thread_key || row.threadKey || row.thread_key, '')
  const conversationThreadId = buildConversationThreadIdFromRecord({
    ...row,
    thread_key: legacyThreadKey || row.thread_key || row.threadKey,
    property_id: dc.propertyId || dc.property_id || row.propertyId || row.property_id,
    prospect_id: dc.prospectId || dc.prospect_id || row.prospectId || row.prospect_id,
    master_owner_id: dc.masterOwnerId || dc.master_owner_id || row.ownerId || row.master_owner_id,
    canonical_e164: dc.canonicalE164 || dc.canonical_e164 || row.canonicalE164 || row.canonical_e164,
    seller_phone: dc.sellerPhone || dc.seller_phone || row.sellerPhone || row.seller_phone,
  }) || asString(row.id, `thread:${offset + index}`)
  const threadKey = legacyThreadKey || conversationThreadId
  
  const latestMessageAt = asIso(dc.latestActivityAt || dc.latest_message_at || row.latest_message_at || row.last_message_at) || new Date().toISOString()
  const latestMessageDirection = normalizeMessageDirection({ direction: dc.latestMessageDirection || dc.latest_message_direction || row.latest_message_direction || row.direction })
  
  const unreadCount = asNumber(row.unread_count ?? row.unread, 0)
  const needsReply = unreadCount > 0 || (latestMessageDirection === 'inbound' && !row.queue_status)
  
  const inboxBucket = asString(
    row.inbox_bucket || row.inbox_category || row.inboxBucket || row.inboxCategory ||
    dc.inbox_bucket || dc.inboxBucket || 'all_messages',
  ).toLowerCase()
  const rawDeliveryStatus = asString(getFirst(row, [
    'latest_delivery_status',
    'delivery_status',
    'provider_delivery_status',
    'latest_provider_delivery_status',
    'queue_status',
  ]), '')
  const rawProviderDeliveryStatus = asString(getFirst(row, [
    'latest_provider_delivery_status',
    'provider_delivery_status',
    'latest_delivery_status',
    'delivery_status',
    'queue_status',
  ]), rawDeliveryStatus)
  const deliveryStatus = latestMessageDirection === 'inbound' ? '' : rawDeliveryStatus
  const providerDeliveryStatus = latestMessageDirection === 'inbound' ? '' : rawProviderDeliveryStatus
  const latestDeliveredAt = asIso(getFirst(row, ['latest_delivered_at', 'delivered_at'])) ?? null
  const latestFailedAt = asIso(getFirst(row, ['latest_failed_at', 'failed_at'])) ?? null
  const latestFailureReason = asString(getFirst(row, [
    'latest_failure_reason',
    'failure_reason',
    'error_message',
    'failed_reason',
    'guard_reason',
    'blocked_reason',
    'paused_reason',
  ]), '')
  const queueStatus = asString(row.queue_status ?? row.queueStatus ?? dc.queue_status, '')
  
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
    waiting: 'waiting',
    waiting_on_seller: 'waiting',
  }
  const category = (PRIORITY_BUCKET_MAP[inboxBucket] ?? 'cold_no_response') as HydratedInboxCategory

  // Merge row and dc carefully: row (live) takes precedence for existing fields.
  const merged = fillEmptyFields(row, dc as unknown as AnyRecord)

  return {
    ...merged,
    id: conversationThreadId,
    conversationThreadId,
    conversation_thread_id: conversationThreadId,
    legacyThreadKey: legacyThreadKey || undefined,
    legacy_thread_key: legacyThreadKey || undefined,
    normalizedPhone: normalizedPhoneForThreadIdentity(row),
    normalized_phone: normalizedPhoneForThreadIdentity(row),
    leadId: dc.property_id || dc.master_owner_id || conversationThreadId,
    ownerId: dc.masterOwnerId || dc.master_owner_id || (row.ownerId as string | undefined) || null,
    propertyId: dc.propertyId || dc.property_id || null,
    prospectId: dc.prospectId || dc.prospect_id || null,
    phoneNumberId: dc.phoneId || dc.phone_id || null,
    textgridNumberId: dc.textgridNumberId || dc.textgrid_number_id || asString(row.textgridNumberId || row.textgrid_number_id, '') || undefined,
    queueId: dc.queueRowId || dc.queue_row_id || null,
    marketId: dc.market || '',
    ownerName: dc.ownerName || asString(row.ownerName || row.owner_name),
    sellerName: dc.sellerDisplayName || dc.ownerName || asString(row.sellerName || row.seller_name),
    subject: dc.propertyAddress || asString(row.propertyAddress || row.property_address || row.subject),
    preview: dc.latestMessageBody || asString(row.latestMessageBody || row.latest_message_body || row.preview || row.message_body),
    status: (row.isArchived || row.is_archived) ? 'archived' : (needsReply ? 'unread' : 'read'),
    priority: (category === 'hot_leads' || category === 'new_inbound') ? 'urgent' : 'normal',
    sentiment: (dc.reply_intent === 'potential_interest' || dc.reply_intent === 'price_anchor') ? 'hot' : 'neutral',
    messageCount: asNumber(row.message_count || row.messageCount, 1),
    lastMessageLabel: formatRelativeTime(latestMessageAt),
    lastMessageIso: latestMessageAt,
    unreadCount,
    aiDraft: row.ai_draft || row.aiDraft || null,
    labels: safeArray((row.labels || row.tags) as string[]),
    threadKey,
    
    // Explicit phone mapping
    sellerPhone: isTextGridNumber(dc.sellerPhone) ? (isTextGridNumber(dc.senderPhone) ? null : dc.senderPhone) : dc.sellerPhone,
    ourNumber: isTextGridNumber(dc.senderPhone) ? dc.senderPhone : (isTextGridNumber(dc.sellerPhone) ? dc.sellerPhone : dc.senderPhone),
    phoneNumber: isTextGridNumber(dc.sellerPhone) ? (isTextGridNumber(dc.senderPhone) ? null : dc.senderPhone) : dc.sellerPhone,
    canonicalE164: isTextGridNumber(dc.sellerPhone) ? (isTextGridNumber(dc.senderPhone) ? null : dc.senderPhone) : dc.sellerPhone,
    
    latestDirection: latestMessageDirection,
    latestMessage: dc.latestMessageBody || asString(row.latestMessageBody || row.latest_message_body || row.preview || row.message_body),
    latestMessageBody: dc.latestMessageBody || asString(row.latestMessageBody || row.latest_message_body || row.preview || row.message_body),
    latestMessageId: asString(getFirst(row, ['latest_message_id', 'latestMessageId', 'latest_message_event_id', 'latestMessageEventId', 'message_event_id', 'messageEventId']), '') || undefined,
    latest_message_id: asString(getFirst(row, ['latest_message_id', 'latestMessageId', 'latest_message_event_id', 'latestMessageEventId', 'message_event_id', 'messageEventId']), '') || undefined,
    latestMessageEventId: asString(getFirst(row, ['latest_message_event_id', 'latestMessageEventId', 'latest_message_id', 'latestMessageId', 'message_event_id', 'messageEventId']), '') || undefined,
    latest_message_event_id: asString(getFirst(row, ['latest_message_event_id', 'latestMessageEventId', 'latest_message_id', 'latestMessageId', 'message_event_id', 'messageEventId']), '') || undefined,
    latestMessageAt,
    latestMessageDirection,
    latest_activity_at: dc.latestActivityAt || latestMessageAt,
    deliveryStatus: deliveryStatus || undefined,
    delivery_status: deliveryStatus || undefined,
    latestDeliveryStatus: deliveryStatus || undefined,
    latest_delivery_status: deliveryStatus || undefined,
    providerDeliveryStatus: providerDeliveryStatus || undefined,
    provider_delivery_status: providerDeliveryStatus || undefined,
    latestProviderDeliveryStatus: providerDeliveryStatus || undefined,
    latest_provider_delivery_status: providerDeliveryStatus || undefined,
    latestDeliveredAt,
    latest_delivered_at: latestDeliveredAt,
    latestFailedAt,
    latest_failed_at: latestFailedAt,
    latestFailureReason: latestFailureReason || undefined,
    latest_failure_reason: latestFailureReason || undefined,
    failureReason: latestFailureReason || undefined,
    queueStatus: queueStatus || undefined,
    queue_status: queueStatus || undefined,
    
    ownerDisplayName: dc.displayName || dc.ownerName,
    propertyAddress: dc.propertyAddress,
    propertyAddressFull: dc.propertyAddress,
    propertyCity: asString((row as AnyRecord).property_address_city ?? (row as AnyRecord).city, ''),
    market: dc.market,
    propertyState: dc.propertyState,
    propertyZip: dc.propertyZip,
    city: asString((row as AnyRecord).city ?? (row as AnyRecord).property_address_city, ''),
    state: dc.propertyState || asString((row as AnyRecord).state ?? (row as AnyRecord).property_address_state, ''),
    zip: dc.propertyZip || asString((row as AnyRecord).zip ?? (row as AnyRecord).property_address_zip, ''),
    propertyCounty: dc.propertyCounty,
    displayName: dc.displayName,
    firstName: dc.firstName,
    fullName: dc.fullName,
    sellerDisplayName: dc.sellerDisplayName,
    statusText: dc.status,
    stage: dc.stage,
    bucket: dc.bucket,
    universalStatus: dc.universalStatus,
    universalStage: dc.universalStage,
    inboxBucket: inboxBucket,
    conversationStageLabel: dc.conversationStage,
    reviewStatus: dc.reviewStatus,
    autoReplyStatus: dc.autoReplyStatus,
    replyIntent: dc.reply_intent,
    leadTemperature: dc.lead_temperature,
    cashOffer: dc.cash_offer,
    estimatedValue: dc.estimated_value,
    equityAmount: dc.equity_amount,
    equityPercent: dc.equity_percent,
    estimatedRepairCost: dc.estimated_repair_cost,
    finalAcquisitionScore: dc.final_acquisition_score,
    priorityScore: dc.priority_score,
    propertyTags: dc.propertyTags,
    sellerTags: dc.sellerTags,
    lat: dc.latitude,
    lng: dc.longitude,
    latitude: dc.latitude,
    longitude: dc.longitude,
    optOut: dc.optOut,
    wrongNumber: dc.wrongNumber,
    notInterested: dc.notInterested,
    needsReview: dc.needsReview,
    suppressed: dc.suppressed,
    isOptOut: dc.optOut,
    property_address_full: dc.propertyAddress,
    owner_name: dc.ownerName,
    display_name: dc.displayName,
    seller_phone: dc.sellerPhone,
    sender_phone: dc.senderPhone,
    universal_status: dc.universalStatus,
    universal_stage: dc.universalStage,
    inbox_bucket: inboxBucket,
    is_final_failure: asBoolean(row.is_final_failure ?? row.isFinalFailure ?? row.latest_is_final_failure, false),
    isFinalFailure: asBoolean(row.is_final_failure ?? row.isFinalFailure ?? row.latest_is_final_failure, false),
    latest_is_final_failure: asBoolean(row.latest_is_final_failure ?? row.latestIsFinalFailure ?? row.is_final_failure, false),
    latestIsFinalFailure: asBoolean(row.latest_is_final_failure ?? row.latestIsFinalFailure ?? row.is_final_failure, false),
    
    owner: { name: dc.owner_name },
    property: { address: dc.property_address_full, market: dc.market },
    threadStateSummary: {
      bucket: inboxBucket,
      status: dc.universalStatus,
      stage: dc.universalStage
    },
    
    // Nested DealContext objects for IntelligencePanel
    property_data: dc.property,
    master_owner_data: dc.masterOwner,
    prospect_data: dc.prospect,
    phone_data: dc.phoneData,
    email_data: dc.email,
    thread_state_data: dc.threadState,
    campaign_data: dc.campaign,
    queue_data: dc.queue,
    suppression_data: dc.suppression,
    valuation_data: dc.valuation,
    buyer_match_data: dc.buyerMatch,
    latest_message_event_data: dc.latestMessageEvent,
    contact_stack_json: dc.contactStack,
    
    unread: needsReply,
    priorityBucket: inboxBucket,
    inboxCategory: inboxBucket,
    inbox_category: inboxBucket,
    workflowStatus: dc.universalStatus,
    workflowStage: dc.universalStage,
  } as unknown as InboxThread
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
  counts?: AnyRecord | null;
  diagnostics?: LiveInboxDiagnostics;
  source?: string | null;
  fallbackUsed?: boolean;
  countsDegraded?: boolean;
  countsApproximate?: boolean;
  countsSource?: string | null;
  countPreservedReason?: string | null;
}> => {
  const requestedPageSize = options.maxRows ?? options.limit ?? HYDRATED_INBOX_PAGE_SIZE
  const page_size = options._timeoutMode === 'initial_boot'
    ? Math.min(requestedPageSize, INITIAL_BOOT_LIVE_LIMIT)
    : options._timeoutMode === 'manual_bucket_switch'
    ? Math.min(requestedPageSize, BUCKET_SWITCH_LIVE_LIMIT)
    : requestedPageSize
  const rawCursor = options.cursor ?? null
  const numericOffset = options.offset ?? 0

  // Normalize aliases before mapping to live filter
  const VIEW_ALIAS_MAP: Record<string, string> = {
    all: 'all_messages', all_conversations: 'all_messages',
    new_inbounds: 'new_replies', needs_reply: 'new_replies', new_inbound: 'new_replies',
    my_priority: 'priority',
    follow_up_due: 'follow_up',
    waiting: 'waiting', waiting_on_seller: 'waiting', cold_no_response: 'cold',
    wrong_number: 'dead',
    manual_review: 'needs_review',
    dnc_opt_out: 'suppressed', opt_out: 'suppressed',
  }
  const normalizedView: string = VIEW_ALIAS_MAP[view as string] ?? view
  let inbox_bucket = 'all_messages'
  if (normalizedView === 'new_replies') inbox_bucket = 'new_replies'
  else if (normalizedView === 'priority' || normalizedView === 'negotiating') inbox_bucket = 'priority'
  else if (normalizedView === 'follow_up') inbox_bucket = 'follow_up'
  else if (normalizedView === 'cold') inbox_bucket = 'cold'
  else if (normalizedView === 'dead') inbox_bucket = 'dead'
  else if (normalizedView === 'needs_review') inbox_bucket = 'needs_review'
  else if (normalizedView === 'suppressed') inbox_bucket = 'suppressed'
  else if (normalizedView === 'active') inbox_bucket = 'active'
  else if (normalizedView === 'waiting') inbox_bucket = 'waiting'
  else if (normalizedView === 'unlinked') inbox_bucket = 'unlinked'
  const endpoint = '/api/cockpit/inbox/live'
  const liveFilter = inbox_bucket === 'all_messages' ? 'all' : inbox_bucket
  const threadShellStartedAt = dataLayerNow()
  const serverAdvancedPayload = options.filters?.advanced && typeof options.filters.advanced === 'object'
    ? options.filters.advanced
    : undefined

  const live = await loadDashboardViewModel(
    'inbox_threads_view',
    () => fetchLiveInbox({
      filter: liveFilter,
      q: options.filters?.query || '',
      cursor: rawCursor ?? String(numericOffset),
      limit: page_size,
      map: false,
      advanced: serverAdvancedPayload,
      timeoutMode: options._timeoutMode,
      refreshReason: options._refreshReason,
      skipCounts: options._timeoutMode === 'initial_boot' || options._timeoutMode === 'manual_bucket_switch',
      skipDelivery: options._timeoutMode === 'initial_boot' || options._timeoutMode === 'manual_bucket_switch',
      signal: options.signal,
    }).catch((err) => {
      const isAbort = isAbortLikeError(err, options.signal)
      if (DEV && !isAbort) console.warn('[Inbox] /api/cockpit/inbox/live failed - preserving previous data', err)
      if (!isAbort) {
        // This notification fires ONLY when /api/cockpit/inbox/live itself fails.
        // Enrichment endpoint failures (deal-context, valuation-snapshot) are isolated
        // at the call site and must never reach this path.
        emitNotification({
          title: 'Inbox could not load',
          detail: 'Retry.',
          severity: 'warning',
        })
      }
      throw err
    }),
    {
      view,
      filter: liveFilter,
      limit: page_size,
      cursor: rawCursor ?? String(numericOffset),
      timeoutMode: options._timeoutMode ?? null,
      refreshReason: options._refreshReason ?? null,
    },
  )

  if (!live) {
    throw new Error(`Live inbox source unavailable for view "${view}"`)
  }

  // Use the already normalized threads from the live fetch, avoiding a duplicate normalization pass
  const normalizedRows = live.threads
  const rawRows = live.rawRows ?? safeArray(live.threads as unknown as AnyRecord[])
  commitDashboardThreads(normalizedRows as unknown as AnyRecord[], {
    view,
    source: 'getInboxRowsForView',
    liveDataSource: live.source ?? live.diagnostics?.source ?? null,
  })
  logHydrationPhaseDone('thread_shell', threadShellStartedAt, {
    view,
    rows: normalizedRows.length,
    source: live.source ?? live.diagnostics?.source ?? null,
  })
  if (DEV) console.log('[Inbox] live inbox success', { threads: normalizedRows.length, counts: live.counts })

  const finalCounts = (live.counts as AnyRecord) || null
  const finalPagination = (live.pagination as unknown as AnyRecord) || {}
  const backendCount = asNumber(live.pagination?.total, normalizedRows.length)
  const nextCursor = asString(finalPagination.next_cursor ?? finalPagination.nextCursor, '') || null

  if (DEV) {
    console.log('[Inbox] source endpoint', endpoint)
    console.log('[Inbox] raw sample', rawRows[0])
    console.log('[Inbox] normalized sample', normalizedRows[0])
    const sample = normalizedRows[0] as unknown as AnyRecord | undefined
    console.log('[Inbox] visible fields', {
      ownerName: sample?.ownerName,
      propertyAddress: sample?.propertyAddress,
      latestMessageBody: sample?.latestMessageBody,
      status: sample?.universalStatus ?? sample?.statusText ?? sample?.universal_status ?? sample?.status,
      stage: sample?.universalStage ?? sample?.stage ?? sample?.universal_stage,
      bucket: sample?.inboxBucket ?? sample?.bucket ?? sample?.inbox_bucket,
      cashOffer: sample?.cashOffer ?? sample?.cash_offer,
      estimatedValue: sample?.estimatedValue ?? sample?.estimated_value,
      equityPercent: sample?.equityPercent ?? sample?.equity_percent,
    })
  }

  return {
    view_key: view,
    backend_count: backendCount,
    rows: normalizedRows,
    rendered_count: normalizedRows.length,
    has_more: asBoolean(finalPagination.has_more ?? finalPagination.hasMore, Boolean(nextCursor)),
    next_cursor: nextCursor,
    counts: finalCounts,
    diagnostics: live.diagnostics,
    source: live.source ?? live.diagnostics?.source ?? null,
    fallbackUsed: live.fallbackUsed ?? live.diagnostics?.fallbackUsed ?? false,
    countsDegraded: live.countsDegraded ?? live.diagnostics?.countsDegraded ?? false,
    countsApproximate: live.countsApproximate ?? live.diagnostics?.countsApproximate ?? false,
    countsSource: live.countsSource ?? live.diagnostics?.countsSource ?? null,
    countPreservedReason: live.countPreservedReason ?? live.diagnostics?.countPreservedReason ?? null,
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
      new_replies: 'new_inbound',
      unread: 'new_inbound',
      automated: 'automated',
      auto: 'automated',
      outbound_active: 'outbound_active',
      outbound: 'outbound_active',
      follow_up: 'outbound_active',
      active: 'outbound_active',
      waiting: 'waiting',
      waiting_on_seller: 'waiting',
      cold_no_response: 'cold_no_response',
      cold: 'cold_no_response',
      unlinked: 'cold_no_response',
      normal: 'cold_no_response',
      dead: 'dead',
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
    
    const ownerDisplayName = resolveInboxOwnerName(row as Record<string, unknown>)
    const prospectDisplayName = resolveInboxProspectName(row as Record<string, unknown>)

    // Fallback address order:
    // 1. property_address_full
    // 2. property_address
    // 3. latest property_address from message_events (already rolled into property_address_full in views)
    const address = [
      asString(row.property_address_full, ''),
      asString(row.property_address, ''),
    ].find(v => v && v.trim()) || ''
    
    // filter_market comes from v_inbox_enriched (properties.market); fall back to
    // the view's own market field which comes from message_events and is usually 'unknown'.
    const market = asString(row.filter_market ?? (row.market !== 'unknown' ? row.market : null), '') || asString(row.market, '')
    const marketLabel = (market && market !== 'unknown' && market !== 'Unknown') ? market : ''
    
    const latestBody = asString(row.latest_message_body, '') || 'No recent message'
    const propertyType = asString(row.property_type, '')
    const propertyClass = asString(row.property_class, '')
    const queueStatus = normalizeStatus(row.queue_status ?? '')
    const automationState = normalizeStatus(row.automation_state ?? row.queue_status ?? '')
    // nexus_inbox_threads_v uses ui_intent; older views use detected_intent
    const detectedIntent = normalizeStatus(row.latest_intent ?? row.ui_intent ?? row.detected_intent ?? '')
    // Stage: stage (nexus view) || queue_stage || detected_intent
    const threadStage = normalizeStatus(
      row.universal_stage
      ?? row.conversation_stage
      ?? row.seller_stage
      ?? row.stage
      ?? row.queue_stage
      ?? row.detected_intent
      ?? row.inbox_category
      ?? 'ownership_check',
    )
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
      id: buildConversationThreadIdFromRecord(row) || threadKey,
      conversationThreadId: buildConversationThreadIdFromRecord(row) || threadKey,
      conversation_thread_id: buildConversationThreadIdFromRecord(row) || threadKey,
      legacyThreadKey: threadKey,
      legacy_thread_key: threadKey,
      normalizedPhone: canonicalE164 || bestPhone || undefined,
      normalized_phone: canonicalE164 || bestPhone || undefined,
      threadKey,
      thread_id: buildConversationThreadIdFromRecord(row) || threadKey,
      leadId: asString(row.property_id ?? row.master_owner_id ?? row.prospect_id, '') || buildConversationThreadIdFromRecord(row) || threadKey,
      market: marketLabel,
      marketId: marketLabel,
      marketName: marketLabel,
      ownerName: ownerDisplayName,
      ownerDisplayName,
      prospectName: prospectDisplayName,
      prospectFullName: asString(row.prospect_full_name ?? row.prospect_name, prospectDisplayName),
      matching_flags: asString(row.matching_flags ?? row.person_flags_text, '') || undefined,
      person_flags_text: asString(row.person_flags_text ?? row.matching_flags, '') || undefined,
      universal_stage: asString(row.universal_stage, '') || undefined,
      universalStage: asString(row.universal_stage, '') || undefined,
      seller_stage: asString(row.seller_stage, '') || undefined,
      sellerStage: asString(row.seller_stage, '') || undefined,
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
      equityAmount: asNumber(row.equity_amount ?? row.estimated_equity_amount, 0)
        || (asNumber(row.equity_percent, 0) > 0 && asNumber(row.estimated_value, 0) > 0
          ? (asNumber(row.equity_percent, 0) / 100) * asNumber(row.estimated_value, 0)
          : 0),
      equityPercent: asNumber(row.equity_percent, 0),
      estimatedRepairCost: asNumber(row.estimated_repair_cost, 0),
      estimatedValue: row.estimated_value ?? null,
      finalAcquisitionScore: finalAcquisitionScore || null,
      final_acquisition_score: finalAcquisitionScore || null,
      deal_strength_score: asNumber(row.deal_strength_score, 0) || undefined,
      dealStrengthScore: asNumber(row.deal_strength_score, 0) || undefined,
      tag_distress_score: asNumber(row.tag_distress_score, 0) || undefined,
      tagDistressScore: asNumber(row.tag_distress_score, 0) || undefined,
      distress_score: asNumber(row.distress_score ?? row.tag_distress_score, 0) || undefined,
      property_flags_text: asString(row.property_flags_text, '') || undefined,
      propertyFlagsText: asString(row.property_flags_text, '') || undefined,
      tax_delinquent: asBoolean(row.tax_delinquent, false) || undefined,
      taxDelinquent: asBoolean(row.tax_delinquent, false) || undefined,
      active_lien: asBoolean(row.active_lien, false) || undefined,
      activeLien: asBoolean(row.active_lien, false) || undefined,
      priorityScore: asNumber(row.priority_score, 0) || undefined,
      unitCount: asNumber(row.units_count ?? row.units ?? row.number_of_units, 0) || undefined,
      units_count: asNumber(row.units_count ?? row.units ?? row.number_of_units, 0) || undefined,
      building_condition: asString(row.building_condition ?? row.condition, '') || undefined,
      buildingCondition: asString(row.building_condition ?? row.condition, '') || undefined,
      motivationScore: asNumber(row.motivation_score ?? row.structured_motivation_score ?? row.priority_score, 0) || undefined,
      motivation_score: asNumber(row.motivation_score ?? row.structured_motivation_score ?? row.priority_score, 0) || undefined,
      ownerType: asString(row.owner_type, '') || undefined,
      contactLanguage: asString(row.language_preference, '') || undefined,
      lat: asNumber(row.latitude, 0) || undefined,
      lng: asNumber(row.longitude, 0) || undefined,
      uiIntent: detectedIntent,
      inbox_bucket: rawCategory,
      inboxBucket: rawCategory,
      priorityBucket: rawCategory,
      inboxCategory: rawCategory,
      inbox_category: rawCategory,
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
      lastInboundAt: asString(row.last_inbound_at ?? row.lastInboundAt, '') || null,
      lastOutboundAt: asString(row.last_outbound_at ?? row.lastOutboundAt, '') || null,

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
  options: { propertyIds?: string[] } = {},
): Promise<LiveInboxMapPin[]> => {
  const propertyIds = [...new Set(
    (options.propertyIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean),
  )]
  if (propertyIds.length === 0) return []

  const supabase = getSupabaseClient()
  const scopedIds = propertyIds.slice(0, 500)
  // Prefer canonical properties table — v_map_property_pins can lag property_universe_state.
  let { data, error } = await supabase
    .from('properties')
    .select('property_id, latitude, longitude, property_address_full, property_type')
    .in('property_id', scopedIds)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  if (error || !data?.length) {
    if (error && DEV) console.warn('[fetchInboxMapPins] properties fallback', mapErrorMessage(error))
    const fallback = await supabase
      .from('v_map_property_pins')
      .select('*')
      .in('property_id', scopedIds)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
    data = fallback.data
    error = fallback.error
  }

  if (error) {
    if (DEV) console.warn('[fetchInboxMapPins] failed', mapErrorMessage(error))
    if (error.message?.includes('does not exist')) {
      emitNotification({
        title: 'Map pins unavailable',
        detail: 'Map pins unavailable — view missing.',
        severity: 'warning'
      })
    }
    return []
  }

  void filters

  const rows = safeArray(data as AnyRecord[])
  const pins = rows.map((row, index) => normalizeLiveInboxMapPin(row, index))
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
  const tStart = Date.now()
  const lastLiveFetchAt = new Date().toISOString()
  const filterState = options.filters || {}

  // Keep row delivery ahead of count enrichment.
  // If the live response already degraded counts, or this is initial boot, do not
  // block thread rendering on a secondary count request.
  const COUNTS_TIMEOUT_MS = 3000
  let viewResult: any
  let mapPins: LiveInboxMapPin[] = []
  try {
    const tLiveFetchStart = Date.now()
    viewResult = await getInboxRowsForView((filterState.view || 'all_messages') as InboxViewSelectValue, options)
    const threadRows = viewResult?.rows ?? []
    const propertyIds = [...new Set(
      (threadRows as AnyRecord[]).map((row) => asString(
        row.property_id ?? row.propertyId ?? row.final_property_id ?? row.selected_property_id,
        '',
      )).filter(Boolean),
    )]
    mapPins = await fetchInboxMapPins(filterState, { propertyIds }).catch((err) => {
      if (DEV && !isAbortLikeError(err, options.signal)) {
        console.warn('[fetchInboxModel] map pins fetch failed', err)
      }
      return [] as LiveInboxMapPin[]
    })
    if (DEV) {
      const liveFetchMs = Date.now() - tLiveFetchStart
      console.log(`[InboxTiming] live_fetch_ms: ${liveFetchMs}ms`)
      console.log(`[InboxTiming] map_pins_ms: included in live_fetch_ms (${mapPins.length} pins for ${propertyIds.length} properties)`)
      console.log(`[InboxTiming] lightweight_normalize_ms: 0ms (built-in)`)
    }
  } catch (err) {
    if (DEV && !isAbortLikeError(err, options.signal)) console.warn('[Inbox] fetchInboxModel core failure', err)
    throw err
  }

  // Rows are committed. Now resolve counts (may already be done if backend was fast).
  const allInboundCount = 0
  const threads = viewResult?.rows ?? []
  const totalAvailable = viewResult?.backend_count ?? threads.length
  const viewCounts = (viewResult?.counts as AnyRecord) ?? null
  const liveDiagnostics = (viewResult?.diagnostics as LiveInboxDiagnostics | undefined) ?? {}
  const countsDegraded = viewResult?.countsDegraded === true || liveDiagnostics.countsDegraded === true
  const countsApproximate = viewResult?.countsApproximate === true || liveDiagnostics.countsApproximate === true
  const countsSource = viewResult?.countsSource ?? liveDiagnostics.countsSource ?? null
  const countPreservedReason = viewResult?.countPreservedReason ?? liveDiagnostics.countPreservedReason ?? null
  const concreteCount = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = viewCounts?.[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }

  const buildCategoryCountsFromEmbedded = () => ({
    hot_leads: concreteCount('priority', 'hot_leads'),
    needs_review: concreteCount('needs_review'),
    new_inbound: concreteCount('new_replies', 'new_inbound'),
    automated: concreteCount('automated'),
    outbound_active: concreteCount('follow_up', 'outbound_active'),
    waiting: concreteCount('waiting', 'waiting_on_seller'),
    cold_no_response: concreteCount('cold', 'cold_no_response'),
    dead: concreteCount('dead'),
    all: concreteCount('all_messages', 'all', 'total'),
    dnc_opt_out: concreteCount('suppressed', 'dnc_opt_out'),
    all_inbound: allInboundCount,
  })

  let categoryCounts = buildCategoryCountsFromEmbedded()
  const hasEmbeddedCounts = Object.values(categoryCounts).some((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  const countsWereSkipped = countsSource === 'skipped' || countPreservedReason === 'counts_skipped_by_request'
  let countsResolved = hasEmbeddedCounts && !countsWereSkipped

  const shouldBlockOnBackgroundCounts =
    Boolean((viewResult as AnyRecord)?.allowBlockingCountFallback) &&
    !countsDegraded &&
    options._timeoutMode !== 'initial_boot'
  if (!hasEmbeddedCounts && shouldBlockOnBackgroundCounts) {
    const countsRace = Promise.race([
      backendClient.fetchDealContextCounts('', options.signal).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COUNTS_TIMEOUT_MS)),
    ])

    const tCountsStart = Date.now()
    const countsRes = await countsRace
    if (DEV) console.log(`[InboxTiming] counts_ms: ${Date.now() - tCountsStart}ms`)
    if (countsRes && countsRes.ok) {
      const payloadRecord = countsRes.data as AnyRecord
      const dataRecord = (payloadRecord?.data as AnyRecord) || {}
      const diagnosticRecord = (payloadRecord?.diagnostics as AnyRecord) || {}
      const rawCounts = (
        dataRecord.counts ?? payloadRecord?.counts ?? diagnosticRecord.counts ??
        dataRecord.data ?? payloadRecord?.data ??
        (dataRecord.total != null ? dataRecord : null) ??
        (payloadRecord.total != null ? payloadRecord : null) ?? {}
      ) as AnyRecord
      const byInboxBucket = (rawCounts.by_inbox_bucket as AnyRecord) || {}
      categoryCounts = {
        hot_leads: Number(rawCounts.priority ?? rawCounts.hot_leads ?? byInboxBucket.priority ?? categoryCounts.hot_leads),
        needs_review: Number(rawCounts.needs_review ?? byInboxBucket.needs_review ?? categoryCounts.needs_review),
        new_inbound: Number(rawCounts.new_replies ?? rawCounts.new_inbound ?? byInboxBucket.new_replies ?? categoryCounts.new_inbound),
        automated: Number(rawCounts.automated ?? byInboxBucket.automated ?? categoryCounts.automated),
        outbound_active: Number(rawCounts.follow_up ?? rawCounts.outbound_active ?? byInboxBucket.follow_up ?? categoryCounts.outbound_active),
        waiting: Number(rawCounts.waiting ?? rawCounts.waiting_on_seller ?? byInboxBucket.waiting ?? categoryCounts.waiting),
        cold_no_response: Number(rawCounts.cold ?? rawCounts.cold_no_response ?? byInboxBucket.cold ?? categoryCounts.cold_no_response),
        dead: Number(rawCounts.dead ?? byInboxBucket.dead ?? categoryCounts.dead),
        all: Number(rawCounts.all_messages ?? rawCounts.all ?? rawCounts.total ?? categoryCounts.all),
        dnc_opt_out: Number(rawCounts.suppressed ?? rawCounts.dnc_opt_out ?? byInboxBucket.suppressed ?? categoryCounts.dnc_opt_out),
        all_inbound: allInboundCount,
      }
      countsResolved = true
      if (DEV) console.log('[fetchInboxModel] counts enriched from deal-context', { categoryCounts })
    } else if (countsRes === null && DEV) {
      console.log('[fetchInboxModel] counts timed out or failed — using live response counts')
    }
  } else if (!hasEmbeddedCounts && DEV) {
    console.log('[fetchInboxModel] skipping blocking count enrichment', {
      timeoutMode: options._timeoutMode ?? null,
      countsDegraded,
      source: viewResult?.liveDataSource ?? viewResult?.source ?? liveDiagnostics.source ?? null,
    })
  } else if (DEV) {
    console.log('[fetchInboxModel] using counts embedded in live response')
  }

  const numOr = (value: number | undefined, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const priorityInboxCount = concreteCount('priority') ?? numOr(categoryCounts.hot_leads)
  const activeInboxCount = concreteCount('active') ?? (
    numOr(categoryCounts.hot_leads) + numOr(categoryCounts.needs_review) + numOr(categoryCounts.new_inbound) + numOr(categoryCounts.outbound_active)
  )
  const waitingInboxCount = concreteCount('waiting', 'waiting_on_seller') ?? numOr(categoryCounts.waiting)
  const allInboxCount = numOr(categoryCounts.all) || totalAvailable
  
  const unreadThreadsCount = numOr(categoryCounts.new_inbound)
  const suppressedThreadsCount = numOr(categoryCounts.dnc_opt_out)
  const deadThreadsCount = numOr(categoryCounts.dead)
  const countsPayloadDegraded = !countsResolved || countsDegraded
  const loadedCount = threads.length
  
  const threadList = threads as InboxThread[]
  const fullyHydratedCount = threadList.filter((t) => t.propertyId).length
  const partiallyHydratedCount = threadList.filter((t) => !t.propertyId).length
  const orphanCount = threadList.filter((t) => !t.propertyId && !t.ownerId && !t.prospectId).length
  const latestFetchMs = Date.now() - tStart
  if (DEV) console.log(`[InboxTiming] total_fetch_model_ms: ${latestFetchMs}ms`)

  const pageSize = options.limit ?? options.maxRows ?? HYDRATED_INBOX_PAGE_SIZE
  // Use the backend-provided cursor and has_more — never recalculate with parseInt
  // so base64 keyset cursors pass through intact for Load More.
  const nextCursorRaw = viewResult?.next_cursor ?? null
  const hasMoreActual = viewResult?.has_more ?? (nextCursorRaw != null)

  // Task: totalCount must be bucket-aware.
  const view = filterState.view || 'all_messages'
  let bucketTotal = allInboxCount
  if (view === 'new_replies' || view === 'new_inbound' || view === 'needs_reply') bucketTotal = unreadThreadsCount
  else if (view === 'priority') bucketTotal = priorityInboxCount
  else if (view === 'needs_review') bucketTotal = numOr(categoryCounts.needs_review)
  else if (view === 'active') bucketTotal = activeInboxCount
  else if (view === 'waiting' || view === 'waiting_on_seller') bucketTotal = waitingInboxCount
  else if (view === 'automated') bucketTotal = numOr(categoryCounts.automated)
  else if (view === 'outbound_active' || view === 'follow_up') bucketTotal = numOr(categoryCounts.outbound_active)
  else if (view === 'cold_no_response' || view === 'cold') bucketTotal = numOr(categoryCounts.cold_no_response)
  else if (view === 'dead') bucketTotal = numOr(categoryCounts.dead)
  else if (view === 'dnc_opt_out' || view === 'suppressed') bucketTotal = numOr(categoryCounts.dnc_opt_out)
  else if (view === 'unlinked') bucketTotal = concreteCount('unlinked') ?? threads.filter((thread: InboxThread) => !thread.propertyId).length

  return {
    threads,
    unreadCount: unreadThreadsCount,
    urgentCount: numOr(categoryCounts.hot_leads),
    totalCount: bucketTotal > 0 ? bucketTotal : totalAvailable,
    aiDraftCount: threadList.filter((thread) => thread.aiDraft !== null).length,
    dataMode: 'live',
    liveFetchStatus: 'active',
    liveFetchError: null,
    messageEventsCount: bucketTotal > 0 ? bucketTotal : totalAvailable,
    messageEventsRawCount: bucketTotal,
    groupedThreadCount: bucketTotal > 0 ? bucketTotal : totalAvailable,
    priorityInboxCount,
    activeInboxCount,
    waitingInboxCount,
    allInboxCount,
    unreadThreadsCount,
    sendQueueCount: null,
    archivedThreadsCount: 0,
    hiddenThreadsCount: 0,
    suppressedThreadsCount,
    deadThreadsCount,
    lastLiveFetchAt,
    counts: {
      ...categoryCounts,
      all_messages: allInboxCount,
      new_replies: categoryCounts.new_inbound,
      follow_up: categoryCounts.outbound_active,
      cold: categoryCounts.cold_no_response,
      positive_hot: categoryCounts.hot_leads,
      manual_review: categoryCounts.needs_review,
      needs_reply: categoryCounts.new_inbound,
      auto_replied: categoryCounts.automated,
      outbound_only: categoryCounts.outbound_active,
      missing_context: categoryCounts.cold_no_response,
      suppressed: categoryCounts.dnc_opt_out,
      dead: categoryCounts.dead,
      priority: priorityInboxCount,
      active: activeInboxCount,
      waiting: waitingInboxCount,
      waiting_on_seller: waitingInboxCount,
      all: allInboxCount,
    },
    pagination: {
      cursor: options.cursor ?? null,
      nextCursor: nextCursorRaw,
      hasMore: hasMoreActual,
      limit: pageSize,
      total: allInboxCount || totalAvailable,
    },
    loadedCount,
    fullyHydratedCount,
    partiallyHydratedCount,
    orphanCount,
    latestFetchMs,
    countsDegraded: countsPayloadDegraded,
    countsApproximate: countsApproximate || !countsResolved,
    countsSource: countsResolved ? countsSource : (countsSource ?? 'deferred_parallel'),
    countPreservedReason: countsResolved ? countPreservedReason : (countPreservedReason ?? 'counts_deferred_non_blocking'),
    liveDiagnostics,
    liveDataSource: viewResult?.liveDataSource ?? viewResult?.source ?? liveDiagnostics.source ?? null,
    fallbackUsed: viewResult?.fallbackUsed ?? liveDiagnostics.fallbackUsed ?? false,
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

  const statusCandidates = [
    row['lifecycle_status'],
    row['delivery_status'],
    row['provider_status'],
    row['provider_delivery_status'],
    row['raw_carrier_status'],
    row['queue_status'],
    row['status'],
    row['delivered_at'] ? 'delivered' : null,
    row['failed_at'] ? 'failed' : null,
  ].map((value) => asString(value, '').toLowerCase()).filter(Boolean)

  let deliveryStatus = 'sent'
  if (statusCandidates.some((status) => status.includes('deliver') && !status.includes('undeliv'))) deliveryStatus = 'delivered'
  else if (statusCandidates.some((status) => status.includes('fail') || status.includes('undeliv') || status.includes('error'))) deliveryStatus = 'failed'
  else if (statusCandidates.some((status) => status.includes('queue') || status.includes('pending') || status.includes('schedul') || status.includes('approval'))) deliveryStatus = 'queued'
  else if (statusCandidates.some((status) => status.includes('sent') || status === 'success' || status === 'accepted')) deliveryStatus = 'sent'

  const { sellerPhone, canonicalE164: msgCanonical } = getSellerPhoneFromMessage(row)
  const rowThreadKey = asString(row['thread_key'] ?? row['threadKey'] ?? row['canonical_e164'], '') || msgCanonical || sellerPhone
  const conversationThreadId = buildConversationThreadIdFromRecord({
    ...row,
    canonical_e164: msgCanonical || row.canonical_e164,
    seller_phone: sellerPhone || row.seller_phone,
  })
  const source =
    asString(row['source_app'] ?? row['message_source'] ?? row['event_type'], '') ||
    asString(getNestedValue(row, 'metadata.source'), '') ||
    'textgrid'

  const developerMetaEntries = [
    ['template_id', asString(row['template_id'], '')],
    ['template_name', asString(row['template_name'], '')],
    ['use_case', asString(row['use_case'] ?? row['use_case_template'] ?? row['template_use_case'], '')],
    ['queue_id', asString(row['queue_id'], '')],
    ['provider_message_sid', asString(row['provider_message_sid'] ?? row['provider_message_id'], '')],
    ['provider_status', asString(row['provider_status'] ?? row['provider_delivery_status'], '')],
    ['event_type', asString(row['event_type'], '')],
    ['client_send_id', asString(getNestedValue(row, 'metadata.client_send_id') ?? row['client_send_id'], '')],
  ].filter(([, value]) => value)

  const developerMeta = developerMetaEntries.length > 0
    ? Object.fromEntries(developerMetaEntries)
    : undefined

  return {
    id: asString(row['message_event_id'] ?? row['id'], createdAt),
    threadKey: rowThreadKey,
    conversationThreadId,
    conversation_thread_id: conversationThreadId,
    direction,
    body: asString(row['body'] ?? row['message_body'] ?? row['rendered_message'], '') || getMessageBody(row),
    createdAt,
    timelineAt,
    sentAt: asIso(row['sent_at']),
    deliveredAt: asIso(row['delivered_at']),
    deliveryStatus,
    deliveryStatusDisplay: undefined,
    fromNumber: normalizePhone(row['from_number'] ?? row['from_phone_number']),
    toNumber: normalizePhone(row['to_number'] ?? row['to_phone_number']),
    ownerId: asString(row['master_owner_id'], ''),
    prospectId: asString(row['prospect_id'], ''),
    propertyId: asString(row['property_id'], ''),
    phoneNumber: sellerPhone,
    canonicalE164: msgCanonical,
    templateId: asString(row['template_id'], '') || null,
    templateName: null,
    agentId: asString(row['sms_agent_id'], '') || null,
    source,
    rawStatus: normalizeStatus(row['lifecycle_status'] ?? row['delivery_status'] ?? row['provider_status'] ?? row['provider_delivery_status'] ?? row['raw_carrier_status'] ?? row['queue_status']),
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
  const delivery = normalizeStatus(message.deliveryStatus)
  const provider = normalizeStatus(
    message.developerMeta?.provider_status ??
    (message.metadata as AnyRecord | undefined)?.provider_status ??
    (message.metadata as AnyRecord | undefined)?.provider_delivery_status,
  )
  const statusEvidence = [raw, delivery, provider].filter(Boolean)
  const hasDeliveredStatus = statusEvidence.some((status) => status.includes('deliver') && !status.includes('undeliv'))
  const hasQueuedStatus = statusEvidence.some((status) => status.includes('queue') || status.includes('pending') || status.includes('schedul') || status.includes('approval'))
  const queueFailed = raw.includes('fail') || raw.includes('undeliv') || delivery === 'failed'
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

  if (hasDeliveredStatus) return 'delivered'
  if (validDelivered) return 'delivered'
  if (hasDeliveredAt && sentAt !== null && deliveredAt !== null && deliveredAt < sentAt) {
    if (DEV) console.debug('[DeliveryDisplay] invalid_delivery_timestamp', { id: message.id, sentAt: message.sentAt, deliveredAt: message.deliveredAt, reason: 'invalid_delivery_timestamp' })
    return 'sent'
  }

  if (queueFailed && (providerSidExists || outboundEventExists || hasLaterInboundReply)) {
    return 'sent'
  }

  if (providerSidExists || outboundEventExists) return 'sent'
  if (terminalFailure && !providerSidExists && !outboundEventExists && !hasLaterInboundReply) return 'failed'
  if (hasQueuedStatus) return 'queued'
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


type ThreadLookupIdentity = {
  selectedThreadKey: string
  conversationThreadId: string
  legacyThreadKey: string
  latestMessageId: string
  normalizedPhone: string
  canonicalE164: string
  phone: string
  bestPhone: string
  sellerPhone: string
  phoneVariants: string[]
}

const getThreadLookupIdentity = (
  thread: InboxThread | InboxWorkflowThread,
): ThreadLookupIdentity => {
  const threadRecord = thread as unknown as AnyRecord
  const conversationThreadId = getConversationThreadIdForThread(threadRecord)
  const rowThreadKey = asString(threadRecord.thread_key ?? threadRecord.threadKey, '')
  const phoneLikeRowKey = rowThreadKey && !rowThreadKey.startsWith('ct:') ? rowThreadKey : ''
  const legacyThreadKey = asString(
    threadRecord.legacy_thread_key ?? threadRecord.legacyThreadKey ?? thread.threadKey,
    phoneLikeRowKey,
  )
  const selectedThreadKey = conversationThreadId || asString(thread.threadKey || thread.id, '')
  const canonicalE164 = normalizePhone(thread.canonicalE164)
  const phone = normalizePhone(thread.phoneNumber)
  const bestPhone = normalizePhone((thread as unknown as AnyRecord).bestPhone ?? (thread as unknown as AnyRecord).best_phone)
  const sellerPhone = normalizePhone(thread.sellerPhone)
  const normalizedPhone = toE164(threadRecord.normalizedPhone ?? threadRecord.normalized_phone ?? canonicalE164 ?? phone ?? bestPhone ?? sellerPhone) || canonicalE164 || phone || bestPhone || sellerPhone
  const latestMessageId = asString(getFirst(threadRecord, ['latestMessageId', 'latest_message_id', 'latestMessageEventId', 'latest_message_event_id', 'messageEventId', 'message_event_id']), '')

  return {
    selectedThreadKey,
    conversationThreadId,
    legacyThreadKey,
    latestMessageId,
    normalizedPhone,
    canonicalE164,
    phone,
    bestPhone,
    sellerPhone,
    phoneVariants: Array.from(new Set([
      ...buildPhoneVariants(normalizedPhone),
      ...buildPhoneVariants(canonicalE164),
      ...buildPhoneVariants(phone),
      ...buildPhoneVariants(bestPhone),
      ...buildPhoneVariants(sellerPhone),
    ])),
  }
}

export interface ThreadMessageFetchOptions {
  maxPages?: number
  maxMessages?: number
  offset?: number
  fetchAll?: boolean
  signal?: AbortSignal
}

export interface ThreadMessagePageResult {
  messages: ThreadMessage[]
  pagination: {
    offset: number
    limit: number
    total: number | null
    hasMore: boolean
    nextOffset: number | null
  }
  diagnostics: AnyRecord
}

export interface ThreadHydrationResult {
  messages: ThreadMessage[]
  pagination: ThreadMessagePageResult['pagination']
  dealContext: DealContext | null
  intelligence: ThreadIntelligenceRecord | null
  diagnostics: AnyRecord
  degradedParts: string[]
  raw: AnyRecord
}

// createAbortError helper removed

const getCanonicalThreadKey = (thread: Pick<InboxThread, 'threadKey' | 'id' | 'conversationThreadId' | 'conversation_thread_id'>): string =>
  asString(thread.conversationThreadId || thread.conversation_thread_id, '') || asString(thread.id, '') || asString(thread.threadKey, '')

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
    case 'pending':
      return 2
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

const emptyThreadMessagePage = (
  offset: number,
  limit: number,
  diagnostics: AnyRecord = {},
): ThreadMessagePageResult => ({
  messages: [],
  pagination: {
    offset,
    limit,
    total: 0,
    hasMore: false,
    nextOffset: null,
  },
  diagnostics,
})

export const getThreadMessagesPageForThread = async (
  thread: InboxThread | InboxWorkflowThread,
  options: ThreadMessageFetchOptions = {},
): Promise<ThreadMessagePageResult> => {
  const lookup = getThreadLookupIdentity(thread)
  const threadKey = lookup.selectedThreadKey
  const offset = Math.max(0, Number(options.offset ?? 0) || 0)
  const pageSize = MESSAGE_EVENTS_THREAD_PAGE_SIZE
  const limit = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : pageSize
  if (!threadKey) return emptyThreadMessagePage(offset, limit, { error_code: 'missing_thread_key' })

  try {
    const threadRecord = thread as unknown as AnyRecord
    const rowThreadKey = asString(threadRecord.thread_key ?? threadRecord.threadKey, '')
    const phoneLikeRowKey = rowThreadKey && !rowThreadKey.startsWith('ct:') ? rowThreadKey : ''
    const params = new URLSearchParams()
    if (options.fetchAll) {
      params.set('fetch_all', '1')
    } else {
      params.set('offset', String(offset))
      params.set('limit', String(limit))
    }
    if (lookup.conversationThreadId) params.set('conversation_thread_id', lookup.conversationThreadId)
    if (lookup.legacyThreadKey) params.set('legacy_thread_key', lookup.legacyThreadKey)
    else if (phoneLikeRowKey) params.set('legacy_thread_key', phoneLikeRowKey)
    if (lookup.normalizedPhone) params.set('normalized_phone', lookup.normalizedPhone)
    if (lookup.canonicalE164) params.set('canonical_e164', lookup.canonicalE164)
    if (lookup.phone) params.set('phone', lookup.phone)
    if (lookup.bestPhone) params.set('best_phone', lookup.bestPhone)
    if (lookup.sellerPhone) params.set('seller_phone', lookup.sellerPhone)
    // Conversation hydration must load the full thread — never scope to latest_message_id only.
    const propertyId = asString(threadRecord.propertyId ?? threadRecord.property_id, '')
    const prospectId = asString(threadRecord.prospectId ?? threadRecord.prospect_id, '')
    const masterOwnerId = asString(threadRecord.ownerId ?? threadRecord.master_owner_id ?? threadRecord.masterOwnerId, '')
    if (lookup.canonicalE164) params.set('phone_e164', lookup.canonicalE164)
    if (propertyId) params.set('property_id', propertyId)
    if (prospectId) params.set('prospect_id', prospectId)
    if (masterOwnerId) {
      params.set('master_owner_id', masterOwnerId)
      params.set('owner_id', masterOwnerId)
    }
    const result = await backendClient.fetchInboxThreadMessages(threadKey, params.toString(), options.signal)
    if (result.ok) {
      const payload = (result.data ?? {}) as AnyRecord
      const integrityBlocked = Boolean(payload.integrity_blocked || payload.integrityBlocked || (payload.diagnostics as AnyRecord | undefined)?.integrity_blocked)
      const rawMessagesEarly = (
        payload.messages ??
        ((payload.diagnostics as AnyRecord | undefined)?.messages) ??
        []
      ) as AnyRecord[]
      if (integrityBlocked && rawMessagesEarly.length === 0) {
        return emptyThreadMessagePage(offset, limit, asRecord(payload.diagnostics))
      }
      const diagnostics = (payload.diagnostics ?? {}) as AnyRecord
      const rawMessages = (
        payload.messages ??
        diagnostics.messages ??
        ((payload.data as AnyRecord | undefined)?.messages) ??
        []
      ) as AnyRecord[]
      const mappedMessages = applyDeliveryStatusDisplay(dedupeMessages(safeArray(rawMessages).map(toThreadMessage)))
      const rawPagination = asRecord(payload.pagination ?? diagnostics.pagination)
      const total = Number(rawPagination.total ?? mappedMessages.length)
      const hasMore = Boolean(rawPagination.has_more ?? rawPagination.hasMore ?? (Number.isFinite(total) ? offset + mappedMessages.length < total : false))
      const nextOffset = rawPagination.next_offset ?? rawPagination.nextOffset
      if (DEV) {
        console.log('[THREAD_MESSAGE_LOOKUP]', {
          selected_thread_key: asString(diagnostics.selected_thread_key ?? threadKey, ''),
          conversation_thread_id: asString(diagnostics.conversation_thread_id ?? lookup.conversationThreadId, ''),
          canonical_e164: asString(diagnostics.canonical_e164 ?? lookup.canonicalE164, ''),
          lookup_strategy_used: asString(diagnostics.lookup_strategy_used, 'not_reported'),
          message_count: Number(diagnostics.message_count ?? mappedMessages.length),
          fallback_used: Boolean(diagnostics.fallback_used),
        })
      }
      return {
        messages: mappedMessages,
        pagination: {
          offset,
          limit,
          total: Number.isFinite(total) ? total : null,
          hasMore,
          nextOffset: Number.isFinite(Number(nextOffset)) ? Number(nextOffset) : (hasMore ? offset + mappedMessages.length : null),
        },
        diagnostics,
      }
    }
    return emptyThreadMessagePage(offset, limit, {
      degraded: true,
      fetch_failed: true,
      network_unavailable: result.error === 'BACKEND_UNAVAILABLE' || result.status === 502,
      error_code: asString(result.error, 'thread_messages_failed'),
      error_message: asString(result.message, ''),
    })
  } catch (err) {
    if (options.signal?.aborted || (err as { name?: string })?.name === 'AbortError') throw err
    if (DEV) console.warn('[ThreadMessageHydration] cockpit thread-messages fetch failed; preserving cached messages', err)
    return emptyThreadMessagePage(offset, limit, {
      degraded: true,
      fetch_failed: true,
      network_unavailable: true,
      error_message: err instanceof Error ? err.message : String(err),
    })
  }

  return emptyThreadMessagePage(offset, limit, { degraded: true, fetch_failed: true })
}

export const getAllThreadMessagesForThread = async (
  thread: InboxThread | InboxWorkflowThread,
  options: ThreadMessageFetchOptions = {},
): Promise<ThreadMessagePageResult> => {
  const fullPage = await getThreadMessagesPageForThread(thread, { ...options, fetchAll: true })
  if (fullPage.messages.length > 0 && !fullPage.pagination.hasMore) {
    return fullPage
  }

  const pageSize = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : MESSAGE_EVENTS_THREAD_PAGE_SIZE
  const maxPages = Math.max(1, options.maxPages ?? 40)
  let offset = 0
  let combined: ThreadMessage[] = []
  let lastDiagnostics: AnyRecord = {}
  let hasMore = true
  let pages = 0

  while (hasMore && pages < maxPages) {
    if (options.signal?.aborted) break
    const page = await getThreadMessagesPageForThread(thread, { ...options, offset, maxMessages: pageSize, fetchAll: false })
    lastDiagnostics = asRecord(page.diagnostics)
    if (page.messages.length === 0) break
    combined = offset === 0
      ? page.messages
      : dedupeMessages([...page.messages, ...combined])
    hasMore = page.pagination.hasMore
    offset = Number(page.pagination.nextOffset ?? (offset + page.messages.length))
    pages += 1
    if (!hasMore) break
  }

  return {
    messages: combined,
    pagination: {
      offset: 0,
      limit: combined.length,
      total: combined.length,
      hasMore: false,
      nextOffset: null,
    },
    diagnostics: lastDiagnostics,
  }
}

export const getThreadMessagesForThread = async (
  thread: InboxThread | InboxWorkflowThread,
  options: ThreadMessageFetchOptions = {},
): Promise<ThreadMessage[]> => {
  const page = await getAllThreadMessagesForThread(thread, options)
  return page.messages
}

const buildThreadHydrationQueryParams = (
  thread: InboxThread | InboxWorkflowThread,
  lookup: ThreadLookupIdentity,
): URLSearchParams => {
  const threadRecord = thread as unknown as AnyRecord
  const params = new URLSearchParams()
  if (lookup.selectedThreadKey) params.set('thread_key', lookup.selectedThreadKey)
  if (lookup.conversationThreadId) params.set('conversation_thread_id', lookup.conversationThreadId)
  if (lookup.legacyThreadKey) params.set('legacy_thread_key', lookup.legacyThreadKey)
  if (lookup.normalizedPhone) params.set('normalized_phone', lookup.normalizedPhone)
  if (lookup.canonicalE164) params.set('canonical_e164', lookup.canonicalE164)
  if (lookup.phone) params.set('phone', lookup.phone)
  if (lookup.bestPhone) params.set('best_phone', lookup.bestPhone)
  if (lookup.sellerPhone) params.set('seller_phone', lookup.sellerPhone)
  const propertyId = asString(threadRecord.propertyId ?? threadRecord.property_id, '')
  const prospectId = asString(threadRecord.prospectId ?? threadRecord.prospect_id, '')
  const masterOwnerId = asString(threadRecord.ownerId ?? threadRecord.master_owner_id ?? threadRecord.masterOwnerId, '')
  if (propertyId) params.set('property_id', propertyId)
  if (prospectId) params.set('prospect_id', prospectId)
  if (masterOwnerId) {
    params.set('master_owner_id', masterOwnerId)
    params.set('owner_id', masterOwnerId)
  }
  return params
}

const buildIntelligenceFromHydration = (
  threadRecord: AnyRecord,
  payload: AnyRecord,
  dossier: AnyRecord,
): ThreadIntelligenceRecord => {
  const thread = asRecord(payload.thread)
  const prospect = asRecord(dossier.prospect || payload.prospect)
  const owner = asRecord(dossier.master_owner || payload.master_owner || payload.owner)
  const property = asRecord(dossier.property || payload.property)
  const dossierPhone = asRecord(dossier.phone)
  return {
    ...(threadRecord as ThreadIntelligenceRecord),
    ...(thread as ThreadIntelligenceRecord),
    ...(dossier as ThreadIntelligenceRecord),
    prospect_data: prospect,
    master_owner_data: owner,
    property_data: property,
    valuation_data: dossier.valuation || payload.valuation || {},
    buyer_match_data: dossier.buyer_match || dossier.buyer_matches || payload.buyer_match || {},
    acquisition_decision_data: dossier.acquisition_decision || dossier.decision_snapshot || {},
    thread_state_data: dossier.conversation || dossier.conversation_intelligence || {},
    prospect_full_name: asString(prospect.full_name || prospect.name || thread.prospect_full_name, ''),
    owner_display_name: asString(owner.full_name || owner.display_name || thread.owner_display_name, ''),
    owner_name: asString(owner.full_name || owner.display_name || thread.owner_name, ''),
    property_address_full: asString(property.full_address || property.address || thread.property_address_full, ''),
    market: asString(property.market || thread.market, ''),
    estimated_value: asNumber(property.estimated_value ?? property.value ?? thread.estimated_value, 0),
    prospect_best_phone: asString(prospect.prospect_best_phone || prospect.best_phone || dossierPhone.number, ''),
    prospect_best_email: asString(prospect.prospect_best_email || prospect.best_email, ''),
    prospect_contact_score: asNumber(prospect.prospect_contact_score ?? prospect.contact_score_final, 0),
    prospect_phone_score: asNumber(prospect.prospect_phone_score ?? prospect.phone_score_final, 0),
    est_household_income: asString(prospect.est_household_income || prospect.household_income, ''),
    net_asset_value: asString(prospect.net_asset_value, ''),
    occupation_group: asString(prospect.occupation_group || prospect.occupation, ''),
    gender: asString(prospect.gender, ''),
    marital_status: asString(prospect.marital_status, ''),
    education_model: asString(prospect.education_model || prospect.education, ''),
    person_flags_text: asString(prospect.person_flags_text || (Array.isArray(prospect.person_flags) ? prospect.person_flags.join(', ') : ''), ''),
    portfolio_total_value: asNumber(owner.portfolio_total_value ?? owner.portfolio_value, 0),
    portfolio_total_equity: asNumber(owner.portfolio_total_equity ?? owner.portfolio_equity, 0),
    property_count: asNumber(owner.portfolio_property_count ?? owner.property_count, 0),
    portfolio_total_units: asNumber(owner.portfolio_total_units ?? owner.total_units, 0),
    financial_pressure_score: asNumber(owner.financial_pressure_score, 0),
    owner_type_guess: asString(owner.owner_type || owner.owner_type_guess, ''),
    primary_owner_address: asString(owner.primary_owner_address || owner.mailing_address, ''),
  }
}

export type ThreadHydrationOptions = {
  /** Caller already fetched messages — skip duplicate thread-messages round-trip. */
  skipMessages?: boolean
  /** Caller loads full dossier via Deal Intelligence — skip heavy hydration payload. */
  skipDossier?: boolean
}

export const getThreadHydrationForThread = async (
  thread: InboxThread | InboxWorkflowThread,
  signal?: AbortSignal,
  options: ThreadHydrationOptions = {},
): Promise<ThreadHydrationResult> => {
  const hydrationStartedAt = dataLayerNow()
  const lookup = getThreadLookupIdentity(thread)
  const threadKey = lookup.selectedThreadKey
  const threadRecord = thread as unknown as AnyRecord
  const fallbackDealContext = normalizeDealContext(threadRecord)
  const degradedParts: string[] = []

  const hydrationParams = buildThreadHydrationQueryParams(thread, lookup)
  if (options.skipMessages) hydrationParams.set('include_messages', '0')
  if (options.skipDossier) hydrationParams.set('include_dossier', '0')
  const hydrationPromise = threadKey
    ? backendClient.fetchInboxThreadHydration(hydrationParams.toString(), signal).catch((err) => {
        if (!isAbortLikeError(err, signal)) {
          if (DEV) console.warn('[getThreadHydrationForThread] thread-hydration failed; falling back', err)
        }
        return { ok: false as const, data: null, status: 0, error: 'HYDRATION_FAILED', message: String(err) }
      })
    : Promise.resolve({ ok: false as const, data: null, status: 0, error: 'MISSING_THREAD_KEY', message: 'missing thread key' })

  const messagesPromise = options.skipMessages
    ? Promise.resolve(emptyThreadMessagePage(0, 50, { skipped_duplicate_fetch: true }))
    : getAllThreadMessagesForThread(thread, { signal })
  const dealContextPromise = threadKey && !options.skipDossier
    ? getDealContextByThread(threadKey, signal).catch(() => null)
    : Promise.resolve(null)

  const [hydrationResult, page, enrichedDealContext] = await Promise.all([
    hydrationPromise,
    messagesPromise,
    dealContextPromise,
  ])

  const diagnostics = asRecord(page.diagnostics)
  let integrityBlocked = Boolean(diagnostics.integrity_blocked || diagnostics.integrityBlocked)
  let fetchFailed = Boolean(diagnostics.fetch_failed || diagnostics.network_unavailable)
  let messages = integrityBlocked && page.messages.length === 0 ? [] : page.messages
  let pagination = page.pagination
  let dossierDealContext: DealContext | null = null
  let intelligence: ThreadIntelligenceRecord = threadRecord as ThreadIntelligenceRecord

  if (hydrationResult.ok) {
    const payload = asRecord(hydrationResult.data)
    const hydrationDiagnostics = asRecord(payload.diagnostics)
    const hydrationMessages = safeArray(payload.messages as AnyRecord[] | null | undefined)
    if (hydrationMessages.length > 0) {
      const mappedHydrationMessages = applyDeliveryStatusDisplay(
        dedupeMessages(hydrationMessages.map(toThreadMessage)),
      )
      if (mappedHydrationMessages.length >= messages.length) {
        messages = mappedHydrationMessages
        integrityBlocked = Boolean(payload.integrity_blocked || hydrationDiagnostics.integrity_blocked)
        fetchFailed = false
        pagination = {
          offset: 0,
          limit: mappedHydrationMessages.length,
          total: mappedHydrationMessages.length,
          hasMore: false,
          nextOffset: null,
        }
      }
    }

    const dossier = asRecord(payload.deal_context || payload.deal_intelligence)
    if (dossier.identity) {
      dossierDealContext = normalizeDealContext(dossier)
      intelligence = buildIntelligenceFromHydration(threadRecord, payload, dossier)
    } else if (DEV) {
      console.warn('[getThreadHydrationForThread] hydration returned without dossier identity', { threadKey })
      degradedParts.push('dossier')
    }

    Object.assign(diagnostics, hydrationDiagnostics, {
      hydration_degraded: payload.degraded,
      hydration_degraded_parts: payload.degradedParts,
      hydration_source: hydrationDiagnostics.sourceUsed || 'thread-hydration',
    })
  } else {
    degradedParts.push('dossier')
  }

  const mergedDealContext = dossierDealContext
    ? normalizeDealContext(fillEmptyFields(
      fillEmptyFields(fallbackDealContext as unknown as AnyRecord, dossierDealContext as unknown as AnyRecord),
      (enrichedDealContext || {}) as unknown as AnyRecord,
    ))
    : enrichedDealContext
      ? normalizeDealContext(fillEmptyFields(
        fallbackDealContext as unknown as AnyRecord,
        enrichedDealContext as unknown as AnyRecord,
      ))
      : fallbackDealContext

  if (!fetchFailed && messages.length > 0) {
    commitDashboardMessages(
      threadKey || asString(threadRecord.id ?? threadRecord.threadKey ?? threadRecord.thread_key, ''),
      messages as unknown as AnyRecord[],
      {
        phase: 'messages',
        source: dossierDealContext ? 'thread_hydration' : 'thread_messages',
        integrityBlocked,
        replace: true,
      },
    )
  }
  logHydrationPhaseDone('messages', hydrationStartedAt, {
    threadKey,
    messages: messages.length,
    dealContextEnriched: Boolean(dossierDealContext || enrichedDealContext),
    dossierHydrated: Boolean(dossierDealContext),
  })

  if (!dossierDealContext && !enrichedDealContext) degradedParts.push('deal_context')

  return {
    messages,
    pagination,
    dealContext: mergedDealContext,
    intelligence,
    diagnostics,
    degradedParts: [...new Set(degradedParts)],
    raw: diagnostics,
  }
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

export const getThreadIntelligence = async (thread: InboxWorkflowThread, signal?: AbortSignal): Promise<ThreadIntelligenceRecord | null> => {
  const threadKey = asString(thread.threadKey, '') || asString(thread.id, '')
  if (!threadKey) return null
  const baseRecord = thread as unknown as ThreadIntelligenceRecord

  try {
    const params = new URLSearchParams()
    params.set('thread_key', threadKey)
    const result = await backendClient.fetchInboxThreadDossier(params.toString(), signal)
    if (result.ok) {
      const payload = (result.data ?? {}) as AnyRecord
      const diagnostics = (payload.diagnostics ?? payload) as AnyRecord
      if (diagnostics?.selected_thread) {
        return {
          ...baseRecord,
          ...(diagnostics as ThreadIntelligenceRecord),
          ...((diagnostics.selected_thread as AnyRecord) ?? {}),
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return null
    if (DEV) console.warn('[getThreadIntelligence] cockpit thread-dossier failed; falling back', err)
  }

  try {
    const result = await backendClient.fetchDealContextByThread(threadKey, signal)
    if (result.ok) {
      const payload = (result.data ?? {}) as AnyRecord
      const record = (payload.data ?? payload) as AnyRecord
      const dc = normalizeDealContext(record)
      
      // Use fillEmptyFields to ensure valid thread fields aren't overwritten by "Unknown" or empty enrichment.
      const baseWithDc = fillEmptyFields(baseRecord as unknown as AnyRecord, dc as unknown as AnyRecord)
      
      return {
        ...baseWithDc,
        ...dc.raw,
        property_data: dc.property,
        master_owner_data: dc.masterOwner,
        prospect_data: dc.prospect,
        phone_data: dc.phoneData,
        email_data: dc.email,
        thread_state_data: dc.threadState,
        queue_data: dc.queue,
        campaign_data: dc.campaign,
        suppression_data: dc.suppression,
        valuation_data: dc.valuation,
        buyer_match_data: dc.buyerMatch,
        latest_message_event_data: dc.latestMessageEvent,
      } as ThreadIntelligenceRecord
    }
  } catch (err) {
    if (signal?.aborted) return null
    if (DEV) console.warn('[getThreadIntelligence] deal-context/thread failed; using selected thread', err)
  }

  if (DEV) console.log('[getThreadIntelligence] Falling back to thread row', { threadKey })
  return baseRecord
}


/** Instant thread context from row fields — never blocks on Supabase lookups. */
export const buildThreadContextFromThread = (thread: InboxThread): ThreadContext => {
  const threadRecord = thread as unknown as AnyRecord
  const propertyData = thread.property_data && typeof thread.property_data === 'object' ? thread.property_data as AnyRecord : {}
  const ownerData = thread.master_owner_data && typeof thread.master_owner_data === 'object' ? thread.master_owner_data as AnyRecord : {}
  const prospectData = thread.prospect_data && typeof thread.prospect_data === 'object' ? thread.prospect_data as AnyRecord : {}
  const phoneData = thread.phone_data && typeof thread.phone_data === 'object' ? thread.phone_data as AnyRecord : {}
  const emailData = thread.email_data && typeof thread.email_data === 'object' ? thread.email_data as AnyRecord : {}
  const queueData = thread.queue_data && typeof thread.queue_data === 'object' ? thread.queue_data as AnyRecord : {}
  const ownerId = asString(thread.ownerId || ownerData.id || ownerData.master_owner_id, '')
  const propertyId = asString(thread.propertyId || propertyData.id || propertyData.property_id, '')
  const ownerName = resolveInboxOwnerName(threadRecord)
  const propertyAddress = resolveInboxPropertyAddress(threadRecord) || asString(thread.propertyAddress || thread.subject, 'Unknown Address')
  const phone = asString(thread.phoneNumber || thread.sellerPhone || phoneData.phone_number || thread.canonicalE164, '') || null
  const hasEmbedded =
    Object.keys(propertyData).length > 0 ||
    Object.keys(ownerData).length > 0 ||
    Object.keys(prospectData).length > 0

  return {
    seller: ownerId || ownerName !== 'Unknown Owner'
      ? {
          id: ownerId,
          name: ownerName,
          market: asString(thread.market || propertyData.market || propertyData.market_name, ''),
        }
      : null,
    property: propertyId || propertyAddress
      ? {
          id: propertyId,
          address: propertyAddress,
          market: asString(thread.market || propertyData.market || propertyData.market_name, ''),
        }
      : null,
    phone,
    contactStack: [
      phone ? { type: 'phone', value: phone, status: 'known' } : null,
      asString(emailData.email || emailData.email_address, '')
        ? { type: 'email', value: asString(emailData.email || emailData.email_address, ''), status: 'known' }
        : null,
    ].filter(Boolean) as { type: string; value: string; status: string }[],
    dealContext: {
      stage: asString(
        threadRecord.stage || threadRecord.universalStage || (thread as { conversationStage?: string }).conversationStage,
        'unknown',
      ),
      nextAction: asString(threadRecord.nextSystemAction, ''),
    },
    aiContext: null,
    queueContext: Object.keys(queueData).length > 0
      ? {
          items: [{
            id: asString(queueData.id, ''),
            status: asString(queueData.queue_status || queueData.status, ''),
            scheduleAt: asIso(queueData.scheduled_for_utc ?? queueData.created_at),
          }],
        }
      : null,
    contextMatchQuality: hasEmbedded ? 'high' : 'medium',
    contextDebug: {
      resolvedPhoneTable: null,
      resolvedMasterOwnerTable: null,
      resolvedOwnerTable: null,
      resolvedPropertyTable: null,
      resolvedProspectTable: null,
      matchedOwnerBy: hasEmbedded ? 'deal_context' : 'thread_row',
      matchedProspectBy: hasEmbedded ? 'deal_context' : 'thread_row',
      matchedPropertyBy: hasEmbedded ? 'deal_context' : 'thread_row',
      matchedPhoneBy: hasEmbedded ? 'deal_context' : 'thread_row',
      matchedPhoneRowId: asString(phoneData.id, '') || null,
      matchedEmailBy: Object.keys(emailData).length > 0 ? 'deal_context' : null,
      matchedAiBrainBy: null,
      matchedQueueBy: Object.keys(queueData).length > 0 ? 'deal_context' : null,
      bridgedMasterOwnerId: ownerId || null,
      bridgedProspectId: asString(thread.prospectId || prospectData.id || prospectData.prospect_id, '') || null,
      bridgedPropertyId: propertyId || null,
    },
  }
}

export const getThreadContext = async (thread: InboxThread, signal?: AbortSignal): Promise<ThreadContext> => {
  const propertyData = thread.property_data && typeof thread.property_data === 'object' ? thread.property_data as AnyRecord : {}
  const ownerData = thread.master_owner_data && typeof thread.master_owner_data === 'object' ? thread.master_owner_data as AnyRecord : {}
  const prospectData = thread.prospect_data && typeof thread.prospect_data === 'object' ? thread.prospect_data as AnyRecord : {}
  const phoneData = thread.phone_data && typeof thread.phone_data === 'object' ? thread.phone_data as AnyRecord : {}
  const emailData = thread.email_data && typeof thread.email_data === 'object' ? thread.email_data as AnyRecord : {}
  const queueData = thread.queue_data && typeof thread.queue_data === 'object' ? thread.queue_data as AnyRecord : {}
  const hasDealContextBasics =
    Object.keys(propertyData).length > 0 ||
    Object.keys(ownerData).length > 0 ||
    Object.keys(prospectData).length > 0 ||
    Object.keys(phoneData).length > 0 ||
    Object.keys(emailData).length > 0 ||
    Object.keys(queueData).length > 0

  if (hasDealContextBasics) {
    return buildThreadContextFromThread(thread)
  }

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

    phoneRows = await runFilteredQuery('phones', uniquePhoneFilters, 8, signal)

    // ── Phase 1b: optional debug-only client-side broad scan ─────────────
    if (phoneRows.length === 0 && searchPhone && INBOX_DEBUG_LOOKUPS) {
      if (DEV) console.log('[Inbox phones] direct filter returned 0 — attempting broad client-side scan')
      const phonesTable = await resolveTable('phones')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let broadData: any = null
      let broadFailed = true
      if (phonesTable) {
        let query = supabase.from(phonesTable).select('*').limit(5000)
        if (signal) query = query.abortSignal(signal)
        const broadResult = await query
        if (!broadResult.error) { broadData = broadResult.data; broadFailed = false }
      }
      if (!broadFailed && broadData) {
        const broadRows = safeArray(broadData as AnyRecord[])
        if (DEV && broadRows.length > 0 && !_loggedPhoneSampleKeys) {
          _loggedPhoneSampleKeys = true
          console.log('[Inbox phones sample keys]', Object.keys(broadRows[0]!))
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
  const propertyFilters = propertyId
    ? [{ key: 'property_id', value: propertyId }]
    : [
      { key: 'owner_id', value: ownerId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'property_address', value: propertyAddress },
    ]

  const [masterowners, owners, prospects, properties, emails, aiRows, queueRows, offers] = await Promise.all([
    runFilteredQuery('masterOwners', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'owner_id', value: ownerId },
      { key: 'normalized_owner_key', value: ownerId },
    ], 5, signal),
    runFilteredQuery('owners', [
      { key: 'owner_id', value: ownerId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'normalized_owner_key', value: ownerId },
      { key: 'podio_item_id', value: ownerId },
    ], 5, signal),
    runFilteredQuery('prospects', [
      { key: 'prospect_id', value: prospectId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
    ], 5, signal),
    runFilteredQuery('properties', propertyFilters, 5, signal),
    runFilteredQuery('emails', [
      { key: 'owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
    ], 8, signal),
    runFilteredQuery('aiBrain', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
      { key: 'canonical_e164', value: canonical },
      { key: 'conversation_brain_id', value: asString(thread.queueId, '') },
    ], 5, signal),
    runFilteredQuery('send_queue', [
      { key: 'id', value: queueId },
      { key: 'master_owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'phone_number', value: searchPhone },
      { key: 'to_phone_number', value: searchPhone },
    ], 12, signal),
    runFilteredQuery('offers', [
      { key: 'master_owner_id', value: ownerId },
      { key: 'owner_id', value: ownerId },
      { key: 'prospect_id', value: prospectId },
      { key: 'property_id', value: propertyId },
      { key: 'property_address', value: propertyAddress },
    ], 8, signal),
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
  const canonicalPatch = normalizePatchToCanonical(patch)
  const mutationPayload: AnyRecord = {
    thread_key: threadKey,
    ...canonicalPatch,
  }
  const result = await persistUniversalLeadState(threadKey, canonicalPatch, { source_view: 'inbox' })
  if (result.ok) {
    return { ok: true, threadKey, mutationPayload, errorMessage: null }
  }
  return { ok: false, threadKey, mutationPayload, errorMessage: result.errorMessage }
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
export const checkSuppressionStatus = async (phone: string): Promise<{ suppressed: boolean; reason: string | null; degraded?: boolean; error?: string | null }> => {
  if (!phone) return { suppressed: false, reason: null }
  const supabase = getSupabaseClient()
  const variants = buildPhoneVariants(phone)

  // Check message_events for opt-out
  try {
    const { data: optOutRows, error: optOutError } = await supabase
      .from('message_events')
      .select('is_opt_out,opt_out_keyword')
      .or(
        variants.map(v => `from_phone_number.eq.${safeFilterValue(v)}`).concat(
          variants.map(v => `to_phone_number.eq.${safeFilterValue(v)}`),
        ).join(','),
      )
      .order('created_at', { ascending: false })
      .limit(10)

    if (optOutError) throw optOutError

    const rows = safeArray(optOutRows as AnyRecord[])
    const optedOut = rows.some((r) => asBoolean(r['is_opt_out'], false))
    if (optedOut) {
      const keywordRow = rows.find(r => r['opt_out_keyword'])
      const keyword = asString(keywordRow ? (keywordRow as AnyRecord)['opt_out_keyword'] : null, '')
      return { suppressed: true, reason: `Opted out${keyword ? ` (${keyword})` : ''}` }
    }
  } catch (error) {
    if (DEV) console.warn('[checkSuppressionStatus] message_events lookup degraded', mapErrorMessage(error))
  }

  // Actual live schema: phone_number / phone_e164 plus reason fields.
  // Lookup failure is degraded and must not block the send flow.
  for (const variant of variants) {
    try {
      const { data: suppRows, error: suppErr } = await supabase
        .from('sms_suppression_list')
        .select('id,phone_number,phone_e164,reason,suppression_reason,suppression_type,is_active,suppressed_at')
        .or(`phone_number.eq.${safeFilterValue(variant)},phone_e164.eq.${safeFilterValue(variant)}`)
        .eq('is_active', true)
        .limit(1)
      if (suppErr) throw suppErr
      if (safeArray(suppRows as AnyRecord[]).length > 0) {
        const suppRow = safeArray(suppRows as AnyRecord[])[0]!
        return { suppressed: true, reason: `Suppressed: ${asString(getFirst(suppRow, ['reason', 'suppression_reason', 'suppression_type']), 'on suppression list')}` }
      }
    } catch (error) {
      if (DEV) console.warn('[checkSuppressionStatus] sms_suppression_list degraded', mapErrorMessage(error))
      return { suppressed: false, reason: null, degraded: true, error: mapErrorMessage(error) }
    }
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
      outbound_sms_disabled: 'Outbound SMS is currently disabled.',
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
      provider_configuration_missing: 'SMS provider is not configured. Contact ops.',
      queue_insert_failure: 'Queue insertion failed before provider send could start.',
    }
    const sanitizedDetailReason = detailReason
      .replace(/\[textgrid\]\s*/gi, '')
      .replace(/missing required env vars:\s*[^.]+/gi, 'provider configuration incomplete')
      .replace(/textgrid_[a-z_]+/gi, 'provider credential')
      .trim()
    const friendlyMessage = messageMap[reason]
      || (reason === 'send_failed' && sanitizedDetailReason && !/provider credential|configuration incomplete/i.test(sanitizedDetailReason)
        ? sanitizedDetailReason
        : '')
      || sanitizedDetailReason
      || String(upstream?.message || sendResult?.message || 'Send failed').slice(0, 220)
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
  const sellerPhone = toE164(thread.sellerPhone || thread.canonicalE164 || thread.phoneNumber || toPhone)
  const threadRecord = thread as unknown as AnyRecord
  const threadStateData = (threadRecord.thread_state_data as AnyRecord) || {}
  const latestMessageEventData = (threadRecord.latest_message_event_data as AnyRecord) || {}
  const queueContextData = (threadRecord.queue_data as AnyRecord) || {}

  const preferredFromPhoneCandidate = toE164(
    options?.fromPhoneNumber ||
    thread.ourNumber ||
    thread.sender_phone ||
    threadRecord.our_number ||
    threadRecord.sender_phone ||
    threadStateData.our_number ||
    threadStateData.sender_phone ||
    queueContextData.from_phone_number ||
    null
  )

  let preferredFromPhone = isTextGridNumber(preferredFromPhoneCandidate) ? preferredFromPhoneCandidate : null
  
  if (!preferredFromPhone) {
     const inboundTo = toE164(latestMessageEventData.to_phone_number)
     const outboundFrom = toE164(latestMessageEventData.from_phone_number)
     if (isTextGridNumber(inboundTo)) preferredFromPhone = inboundTo
     else if (isTextGridNumber(outboundFrom)) preferredFromPhone = outboundFrom
  }

  const preferredTextgridNumberIdCandidate = asString(
    thread.textgridNumberId ||
    threadRecord.textgrid_number_id ||
    threadStateData.textgrid_number_id ||
    queueContextData.textgrid_number_id ||
    latestMessageEventData.textgrid_number_id,
    '',
  )
  const preferredTextgridNumberId = isValidUUID(preferredTextgridNumberIdCandidate)
    ? preferredTextgridNumberIdCandidate
    : null

  const resolveSendNowRoute = async (preferFreshRoute = false) => {
    return resolveOutboundTextgridNumber({
      marketId: thread.marketId,
      market: thread.market || thread.marketName,
      ourNumber: preferFreshRoute ? undefined : (preferredFromPhone || undefined),
      phoneNumber: sellerPhone,
      textgridNumberId: preferredTextgridNumberId || undefined,
      property_address_state: thread.property_address_state,
      propertyId: thread.propertyId,
      threadKey: thread.threadKey,
    }, false)
  }

  let routingResult = await resolveSendNowRoute(false)
  
  // If routing returned a number that equals the seller, we MUST reroute
  if (routingResult.ok && toE164(routingResult.from_phone_number) === sellerPhone) {
    routingResult = await resolveSendNowRoute(true)
  }

  let fromPhone = routingResult.ok ? toE164(routingResult.from_phone_number) : (preferredFromPhone || null)
  let textgridNumberId = routingResult.ok
    ? (routingResult.textgrid_number_id || null)
    : preferredTextgridNumberId

  let routingResolutionSource = routingResult.ok
    ? 'resolved_thread_context'
    : (fromPhone ? 'thread_context_fallback' : 'backend_thread_history_fallback')
  
  // Final safety guard: fromPhone cannot be sellerPhone
  if (fromPhone === sellerPhone) {
    fromPhone = null
    routingResolutionSource = 'backend_thread_history_fallback'
  }

  if (!fromPhone && !thread.threadKey) {
    return {
      ok: false,
      clientSendId: options?.clientSendId ?? null,
      queueId: null,
      messageEventId: null,
      providerMessageSid: null,
      deliveryStatus: null,
      errorMessage: 'No reply route was resolved for this thread.',
      guardReason: 'missing_routing',
      backendReason: null,
      insertPayloadKeys: [],
      suppressionBlocked: false,
      sendRouteUsed: 'none',
      queueProcessorEligible: false,
      proof: null,
    }
  }

  const canonicalThreadKey = resolveCanonicalThreadStateKey(thread as unknown as Record<string, unknown>)
    || sellerPhone
    || toPhone
  const routingThread: InboxThread = canonicalThreadKey && canonicalThreadKey !== thread.threadKey
    ? { ...thread, threadKey: canonicalThreadKey, id: canonicalThreadKey }
    : thread

  const now = new Date().toISOString()
  const queueKey = `inbox:send_now:${routingThread.threadKey ?? routingThread.id}:${Date.now()}`

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
    thread_key: routingThread.threadKey || sellerPhone,
    property_id: routingThread.propertyId || options?.threadContext?.property?.id || null,
    master_owner_id: routingThread.ownerId || options?.threadContext?.seller?.id || null,
    prospect_id: routingThread.prospectId || null,
    phone_number_id: thread.phoneNumberId || null,
    character_count: personalization.messageText.length,
    touch_number: 1,
    current_stage: 'manual_reply',
    message_type: 'manual_reply',
    use_case_template: templateAttachment.useCaseTemplate,
    metadata: {
      source: 'inbox',
      action: 'send_now',
      thread_key: routingThread.threadKey || sellerPhone,
      selected_thread_id: routingThread.id,
      created_from: 'leadcommand_inbox',
      our_number: fromPhone,
      seller_phone: sellerPhone,
      note: 'queued_ready_for_processor',
      ...(options?.clientSendId ? { client_send_id: options.clientSendId } : {}),
      ...buildQueueRoutingMetadata(routingThread),
      template_variables: personalization.renderVariables,
      candidate_snapshot: personalization.candidateSnapshot,
      personalization: personalization.personalizationMeta,
      ...SMS_ROUTE_METADATA,
      ...templateAttachment.metadata,
      resolution: {
        sellerPhone,
        resolvedFromPhone: fromPhone,
        resolutionSource: routingResolutionSource,
        fromEqualsTo: fromPhone === sellerPhone,
        routingReason: routingResult.routing_reason || routingResult.error || null,
        routingTier: routingResult.routing_tier ?? null,
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
  Object.assign(insertPayload, buildQueueRoutingColumns(routingThread))
  const requestPayload = {
    ...insertPayload,
    metadata: { ...((insertPayload.metadata as AnyRecord | undefined) || {}) },
  }


  const insertPayloadKeys = Object.keys(insertPayload)

  if (DEV) {
    console.log('[sendInboxMessageNow] routing to backend', { keys: insertPayloadKeys, toPhone, fromPhone, queueKey, canonicalThreadKey })
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
