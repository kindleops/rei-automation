import { useState, useEffect, useCallback, useRef, useReducer } from 'react'
import { inboxReducer, EMPTY_INBOX_STORE_STATE } from './inbox-store'
import type { CommandCenterStore } from '../../domain/types'
import { formatRelativeTime } from '../../shared/formatters'
import { fetchInboxModel, type InboxFetchOptions, type LiveInboxMapPin, type LiveInboxPagination, type InboxSourceMode } from '../../lib/data/inboxData'
import { isDev, shouldUseSupabase } from '../../lib/data/shared'
import type { InboxWorkflowThread, InboxStatus, SellerStage, AutomationState } from '../../lib/data/inboxWorkflowData'
import { hasSupabaseEnv } from '../../lib/supabaseClient'
import { getSupabaseClient } from '../../lib/supabaseClient'

const LIVE_INBOX_TIMEOUT_MS = 10000 // 10s timeout guard
const CACHE_KEY = 'leadcommand.liveInbox.lastGood'

const withTimeout = async <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  externalSignal?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  // Forward external abort immediately so the network request is actually cancelled,
  // not kept alive until the 10s timer fires.
  const forwardAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  try {
    timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    return await run(controller.signal)
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage)
    // External abort or real network error — re-throw as-is so runLoad can handle it.
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort)
  }
}

const emptyLiveErrorModel = (liveFetchError: string): InboxModel => {
  if (isDev) {
    console.log('[NexusInbox] Data source: fallback_error')
  }
  return {
    threads: [],
    unreadCount: 0,
    urgentCount: 0,
    totalCount: 0,
    aiDraftCount: 0,
    dataMode: 'mock_preview',
    liveFetchStatus: 'fallback_error',
    liveFetchError,
    messageEventsCount: null,
    messageEventsRawCount: null,
    groupedThreadCount: null,
    priorityInboxCount: null,
    activeInboxCount: null,
    waitingInboxCount: null,
    allInboxCount: null,
    unreadThreadsCount: null,
    sendQueueCount: null,
    archivedThreadsCount: null,
    hiddenThreadsCount: null,
    suppressedThreadsCount: null,
    deadThreadsCount: null,
    lastLiveFetchAt: new Date().toISOString(),
  }
}

export interface InboxThread {
  id: string
  leadId: string
  marketId: string
  ownerName: string
  sellerName?: string
  subject: string
  preview: string
  status: 'unread' | 'read' | 'replied' | 'archived'
  priority: 'urgent' | 'high' | 'normal' | 'low'
  sentiment: 'hot' | 'warm' | 'neutral' | 'cold'
  messageCount: number
  lastMessageLabel: string
  lastMessageIso: string
  unreadCount: number
  aiDraft: string | null
  labels: string[]
  threadKey?: string
  ownerId?: string
  prospectId?: string
  propertyId?: string
  phoneNumber?: string
  phoneNumberId?: string
  textgridNumberId?: string
  canonicalE164?: string
  sellerPhone?: string
  ourNumber?: string
  latestDirection?: string
  directionUsed?: string
  autoReplyStatus?: string
  deliveryStatus?: string
  latestDeliveryStatus?: string
  latestDeliveredAt?: string | null
  latestSentAt?: string | null
  latestProviderSid?: string
  lastDeliveredAt?: string | null
  failureReason?: string
  propertyAddress?: string
  propertyAddressFull?: string
  market?: string
  marketName?: string
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
  needsResponse?: boolean
  unread?: boolean
  uiIntent?: string
  priorityBucket?: string
  workflowStatus?: string
  workflowStage?: string
  threadWorkflowStatus?: string
  threadWorkflowStage?: string
  ownerDisplayName?: string
  latestMessageBody?: string
  latestMessageAt?: string
  lat?: number
  lng?: number
  ownerType?: string
  propertyType?: string
  propertyClass?: string
  finalAcquisitionScore?: number
  priorityScore?: number
  inboxCategory?: string
  matchedKeywords?: string[]
  groupingMethod?: string
  hydrationSource?: string
  queueId?: string
  needsReply?: boolean
  showInPriorityInbox?: boolean
  inbound_count?: number
  outbound_count?: number
  hydrationConfidence?: string
  groupingConfidence?: string
  latest_message_body?: string
  latest_message_direction?: string
  latest_activity_at?: string
  isStarred?: boolean
  isPinned?: boolean
  isHidden?: boolean
  isArchived?: boolean
  isSuppressed?: boolean
  threadIsPinned?: boolean
  threadIsStarred?: boolean
  threadIsHidden?: boolean
  threadIsSuppressed?: boolean
  isOptOut?: boolean
  thread_id?: string
  threadIsArchived?: boolean
  threadIsRead?: boolean
  latestMessage?: string
  display_phone?: string
  bestPhone?: string
  isRead?: boolean
  isDnc?: boolean
  beds?: string | number
  baths?: string | number
  sqft?: string | number
  yearBuilt?: string | number
  equityAmount?: number
  equityPercent?: number
  equity_percent?: number
  motivationScore?: number
  estimatedRepairCost?: number
  estimatedValue?: number | null
  contactLanguage?: string
  
  // DealContext nested objects
  property_data?: any
  master_owner_data?: any
  prospect_data?: any
  phone_data?: any
  email_data?: any
  thread_state_data?: any
  campaign_data?: any
  queue_data?: any
  suppression_data?: any
  valuation_data?: any
  buyer_match_data?: any
  contact_stack_json?: any

  // UNIVERSAL SELLER WORK ITEM FIELDS
  is_uncontacted?: boolean
  has_conversation?: boolean
  has_queue?: boolean
  has_message_event?: boolean
  seller_state?: string
  seller_status?: string
  execution_state?: string
  pipeline_stage?: string

  // PROSPECT
  canonical_prospect_id?: string
  cnam?: string
  gender?: string
  marital_status?: string
  education_model?: string
  occupation_group?: string
  occupation?: string
  est_household_income?: string
  net_asset_value?: string
  buying_power?: string
  likely_owner?: boolean
  likely_renting?: boolean
  matching_flags?: string
  person_flags_text?: string
  person_flags_json?: any
  prospect_contact_score?: number
  prospect_phone_score?: number
  prospect_best_phone?: string
  prospect_best_email?: string
  sms_eligible?: boolean
  email_eligible?: boolean

  // DealContext flat fields
  deal_context_id?: string
  context_type?: string
  seller_phone?: string
  sender_phone?: string
  owner_name?: string
  display_name?: string
  property_address_full?: string
  market_name?: string
  universal_status?: string
  universal_stage?: string
  inbox_bucket?: string
  reply_intent?: string
  lead_temperature?: string
  prospect_name?: string
  full_name?: string
  first_name?: string
  latitude?: number
  longitude?: number
  property_type?: string
  property_class?: string
  estimated_value?: number
  estimated_arv?: number
  cash_offer?: number
  final_acquisition_score?: number
  priority_score?: number
  campaign_name?: string
  queue_status?: string

  // OWNER
  primary_owner_address?: string
  owner_type_guess?: string
  routing_market?: string
  routing_timezone?: string
  best_channel?: string
  best_contact_window?: string
  best_language?: string
  contactability_score?: number
  financial_pressure_score?: number
  urgency_score?: number
  owner_priority_tier?: string
  follow_up_cadence?: string
  best_phone_1?: string
  best_phone_2?: string
  best_phone_3?: string
  best_email_1?: string
  best_email_2?: string
  portfolio_total_value?: number
  portfolio_total_equity?: number
  portfolio_total_loan_balance?: number
  portfolio_total_units?: number
  seller_tags_text?: string
  seller_tags_json?: any
  agent_persona?: string
  agent_family?: string
  joined_property_ids_json?: any
  property_count?: number
  tax_delinquent_count?: number
  oldest_tax_delinquent_year?: number
  active_lien_count?: number

  // PROPERTY
  property_address_city?: string
  property_address_state?: string
  property_address_zip?: string
  property_county_name?: string
  market_region?: string
  estimated_repair_cost?: number
  estimated_repair_cost_per_sqft?: number
  deal_strength_score?: number
  equity_amount?: number
  total_loan_amt?: number
  total_loan_balance?: number
  total_loan_payment?: number
  property_tax_delinquent?: boolean
  property_tax_delinquent_year?: number
  tax_amt?: number
  tax_year?: number
  property_active_lien?: boolean
  ownership_years?: number
  units_count?: number
  building_square_feet?: number
  total_bedrooms?: number
  total_baths?: number
  year_built?: number
  effective_year_built?: number
  lot_acreage?: number
  lot_square_feet?: number
  lot_size_depth_feet?: number
  lot_size_frontage_feet?: number
  building_condition?: string
  building_quality?: string
  rehab_level?: string
  podio_tags?: string
  property_flags_text?: string
  property_flags_json?: any
  streetview_image?: string
  satellite_image?: string
  map_image?: string
  style?: string
  stories?: number
  sum_buildings_nbr?: number
  avg_sqft_per_unit?: number
  beds_per_unit?: number
  sqft_range?: string
  construction_type?: string
  exterior_walls?: string
  floor_cover?: string
  basement?: string
  other_rooms?: string
  num_of_fireplaces?: number
  patio?: string
  porch?: string
  deck?: string
  driveway?: string
  garage?: string
  sum_garage_sqft?: number
  air_conditioning?: string
  heating_type?: string
  heating_fuel_type?: string
  interior_walls?: string
  roof_cover?: string
  roof_type?: string
  pool?: string
  sewer?: string
  water?: string
  zoning?: string
  flood_zone?: string
  legal_description?: string
  subdivision_name?: string
  school_district_name?: string
  assd_total_value?: number
  assd_land_value?: number
  assd_improvement_value?: number
  calculated_total_value?: number
  calculated_land_value?: number
  calculated_improvement_value?: number
  sale_price?: number
  sale_date?: string
  recording_date?: string
  last_sale_doc_type?: string
  past_due_amount?: number
  ai_score?: number

  // DISPLAY
  displayName?: string
  displayAddress?: string
  displayPhone?: string
  displayMarket?: string
  displayStatus?: string
  displayScore?: number

  // FILTERS
  filterState?: string
  filterCity?: string
  filterZip?: string
  filterMarket?: string
  filterPropertyType?: string
  filterOwnerType?: string
  filterLanguage?: string
  filterAgentPersona?: string
  filterPriorityTier?: string
}
export interface InboxModel {
  threads: InboxThread[]
  /** Non-archived threads where `is_read` is false (notification bell). */
  unreadCount: number
  urgentCount: number
  totalCount: number
  aiDraftCount: number
  dataMode: 'live' | 'mock_preview' | 'fallback_error'
  liveFetchStatus: 'active' | 'error' | 'disabled' | 'fallback_error'
  liveFetchError: string | null
  /** Internal: tracks which filter was used to load these threads — prevents stale rows bleeding across filter switches */
  _requestedFilter?: string
  messageEventsCount: number | null
  messageEventsRawCount: number | null
  groupedThreadCount: number | null
  priorityInboxCount: number | null
  activeInboxCount: number | null
  waitingInboxCount: number | null
  allInboxCount: number | null
  unreadThreadsCount: number | null
  sendQueueCount: number | null
  archivedThreadsCount: number | null
  hiddenThreadsCount: number | null
  suppressedThreadsCount: number | null
  deadThreadsCount?: number | null
  lastLiveFetchAt: string | null

  counts?: Record<string, number | null | undefined>
  mapPins?: LiveInboxMapPin[]
  pagination?: LiveInboxPagination | null
  loadedCount?: number
  fullyHydratedCount?: number
  partiallyHydratedCount?: number
  orphanCount?: number
  latestFetchMs?: number
  realtimeConnected?: boolean
}

export const adaptInboxModel = (store: CommandCenterStore): InboxModel => {
  const threads: InboxThread[] = store.inboxThreadIds.map((id) => {
    const raw = store.inboxThreadsById[id]!
    return {
      ...raw,
      lastMessageLabel: formatRelativeTime(raw.lastMessageIso),
    }
  })

  // Sort: by timestamp desc
  threads.sort((a, b) => {
    return new Date(b.lastMessageIso).getTime() - new Date(a.lastMessageIso).getTime()
  })


  const unreadThreads = threads.filter((t) => t.unreadCount > 0).length
  const priorityThreads = threads.filter((t) => Boolean(t.showInPriorityInbox)).length
  const waitingThreads = threads.filter((t) => t.uiIntent === 'outbound_waiting').length
  const activeThreads = threads.filter((t) => (
    t.status !== 'archived' &&
    t.priorityBucket !== 'hidden' &&
    t.priorityBucket !== 'suppressed' &&
    t.uiIntent !== 'outbound_waiting'
  )).length
  const archivedThreads = threads.filter((t) => t.status === 'archived').length
  const hiddenThreads = threads.filter((t) => t.priorityBucket === 'hidden').length
  const suppressedThreads = threads.filter((t) => t.priorityBucket === 'suppressed').length
  const deadThreads = threads.filter((t) => t.priorityBucket === 'dead' || t.inboxCategory === 'dead').length

  return {
    threads,
    unreadCount: unreadThreads,
    urgentCount: threads.filter((t) => t.priority === 'urgent').length,
    totalCount: threads.length,
    aiDraftCount: threads.filter((t) => t.aiDraft !== null).length,
    dataMode: 'mock_preview',
    liveFetchStatus: 'disabled',
    liveFetchError: null,
    messageEventsCount: activeThreads,
    messageEventsRawCount: waitingThreads,
    groupedThreadCount: threads.length,
    priorityInboxCount: priorityThreads,
    activeInboxCount: activeThreads,
    waitingInboxCount: waitingThreads,
    allInboxCount: threads.length,
    unreadThreadsCount: unreadThreads,
    sendQueueCount: null,
    archivedThreadsCount: archivedThreads,
    hiddenThreadsCount: hiddenThreads,
    suppressedThreadsCount: suppressedThreads,
    deadThreadsCount: deadThreads,
    lastLiveFetchAt: null,
  }
}


export const loadInbox = async (options: InboxFetchOptions = {}): Promise<InboxModel> => {
  const filterKey = options.filters?.view ?? 'all_messages'
  const scopedCacheKey = `${CACHE_KEY}:${filterKey}`

  if (isDev) {
    console.log('[dashboard boot] live inbox fetch started', { options, filterKey })
  }

  if (!hasSupabaseEnv) {
    const liveFetchError = 'Live mode enabled but Supabase env vars are missing.'
    return { ...emptyLiveErrorModel(liveFetchError), _requestedFilter: filterKey }
  }

  try {
    const result = await withTimeout(
      (signal) => fetchInboxModel({ ...options, signal }),
      LIVE_INBOX_TIMEOUT_MS,
      `Live Inbox request timed out after ${LIVE_INBOX_TIMEOUT_MS}ms`,
      options.signal,
    )

    // Save lightweight cache scoped to this filter key so different filters never bleed
    try {
      const lightweightThreads = result.threads.slice(0, 25).map(t => ({
        id: t.id,
        threadKey: t.threadKey,
        ownerName: t.ownerName,
        subject: t.subject,
        preview: t.preview,
        status: t.status,
        lastMessageIso: t.lastMessageIso,
        unreadCount: t.unreadCount,
        priority: t.priority,
        inboxCategory: t.inboxCategory,
        uiIntent: t.uiIntent,
      }))

      const cachePayload = JSON.stringify({
        ...result,
        threads: lightweightThreads,
        lastLiveFetchAt: new Date().toISOString(),
        dataMode: 'mock_preview',
        _requestedFilter: filterKey,
      })

      localStorage.setItem(scopedCacheKey, cachePayload)
    } catch (cacheError) {
      console.warn('[Inbox] Failed to save lightweight cache', cacheError)
      localStorage.removeItem(scopedCacheKey)
    }

    if (isDev) console.log('[dashboard boot] live inbox fetch success', { filterKey, count: result.threads.length })
    return { ...result, _requestedFilter: filterKey }
  } catch (error) {
    // Request was aborted by runLoad (superseded or component cleanup) — let the
    // catch in runLoad handle it silently via controller.signal.aborted check.
    // Do NOT commit fallback_error for an intentionally cancelled request.
    if (options.signal?.aborted) throw error

    const liveFetchError = error instanceof Error ? error.message : String(error)
    if (isDev) {
      console.error('[NEXUS] Inbox live load failed.', { filterKey, error })
    }

    // Only return cache for the SAME filter — never substitute a different filter's cache
    const cached = localStorage.getItem(scopedCacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        return {
          ...parsed,
          _requestedFilter: filterKey,
          dataMode: 'fallback_error',
          liveFetchStatus: 'fallback_error',
          liveFetchError,
        }
      } catch {
        localStorage.removeItem(scopedCacheKey)
      }
    }

    return { ...emptyLiveErrorModel(liveFetchError), _requestedFilter: filterKey }
  }
}

export const toWorkflowThread = (t: InboxThread): InboxWorkflowThread => {
  const lastAt = t.lastMessageIso || new Date().toISOString()
  const inboxStatus = (t.threadWorkflowStatus || (t.status === 'unread' ? 'new_reply' : 'waiting')) as InboxStatus
  const conversationStage = (t.threadWorkflowStage || 'ownership_check') as SellerStage

  return {
    ...t,
    threadKey: t.threadKey || t.id,
    thread_id: t.thread_id || t.threadKey || t.id,
    inboxStatus,
    conversationStage,
    inboxStage: conversationStage,
    automationState: (t.threadIsArchived || t.threadIsSuppressed ? 'completed' : 'active') as AutomationState,
    nextSystemAction: 'Review thread for system recommended next steps.',
    isArchived: t.threadIsArchived ?? (t.status === 'archived' || t.isArchived) ?? false,
    isRead: t.threadIsRead ?? (t.status === 'read' || t.unreadCount === 0) ?? true,
    isPinned: t.threadIsPinned ?? t.isPinned ?? false,
    isStarred: t.threadIsStarred ?? t.isStarred ?? false,
    isHidden: t.threadIsHidden ?? t.isHidden ?? false,
    isSuppressed: t.threadIsSuppressed ?? t.isSuppressed ?? t.isOptOut ?? false,
    priority: t.priority as InboxWorkflowThread['priority'],
    lastInboundAt: t.lastInboundAt ?? null,
    lastOutboundAt: t.lastOutboundAt ?? null,
    lastMessageAt: lastAt,
    lastMessageBody: t.latestMessageBody || t.preview,
    lastDirection: (t.latestDirection === 'inbound' || t.latestDirection === 'outbound' ? t.latestDirection : (t.directionUsed === 'inbound' || t.directionUsed === 'outbound' ? t.directionUsed : 'unknown')),
    latestDirection: t.latestDirection ?? t.directionUsed,
    latest_message_body: t.latest_message_body ?? t.latestMessageBody ?? t.preview,
    latest_message_direction: t.latest_message_direction ?? t.latestDirection ?? t.directionUsed,
    latest_activity_at: t.latest_activity_at ?? lastAt,
    inbound_count: t.inbound_count ?? 0,
    outbound_count: t.outbound_count ?? 0,
    hydrationConfidence: t.hydrationConfidence ?? t.groupingConfidence ?? 'medium',
    hydrationSource: t.hydrationSource ?? t.groupingMethod ?? 'live_inbox',
    autoReplyStatus: t.autoReplyStatus,
    matchedKeywords: t.matchedKeywords,
    updatedAt: lastAt,
    queueStatus: t.autoReplyStatus || (t.queueId ? 'queued' : null),
  } as InboxWorkflowThread
}

// ── Helper: extract view counts from InboxModel ───────────────────────────────

const extractViewCounts = (model: InboxModel): Record<string, number> => {
  const counts: Record<string, number> = {}
  if (model.counts) Object.assign(counts, model.counts)
  if (model.priorityInboxCount != null) counts.priority = model.priorityInboxCount
  if (model.activeInboxCount != null) counts.automated = model.activeInboxCount
  if (model.waitingInboxCount != null) counts.cold = model.waitingInboxCount
  if (model.allInboxCount != null) counts.all = model.allInboxCount
  if (model.unreadThreadsCount != null) counts.new_replies = model.unreadThreadsCount
  if (model.suppressedThreadsCount != null) counts.suppressed = model.suppressedThreadsCount
  if (model.deadThreadsCount != null) counts.dead = model.deadThreadsCount
  return counts
}

// ── useInboxData — reducer-based, bucket-isolated ────────────────────────────
//
// State is managed by inboxReducer. Each bucket owns its own rows, loading state,
// error, and requestId. Stale responses are ignored inside the reducer — there is
// no shared mutable ref that async callbacks can race against.
//
// KPI counts live in state.viewCounts — fully isolated from bucket rows.
// Realtime patches dispatch REALTIME_PATCH_THREAD, updating a single row
// in whichever bucket contains it.

const BUCKET_ALIAS_MAP: Record<string, string> = {
  all: 'all_messages',
  all_conversations: 'all_messages',
  new_inbounds: 'new_replies',
  my_priority: 'priority',
}

const normalizeBucketKey = (key: string): string => BUCKET_ALIAS_MAP[key] ?? key

export const useInboxData = (options: { initialSourceMode?: InboxSourceMode; paused?: boolean } = {}) => {
  const { initialSourceMode = 'conversations', paused = false } = options
  const [sourceMode, setSourceMode] = useState<InboxSourceMode>(initialSourceMode)
  const [storeState, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STORE_STATE)

  // Sync ref so async callbacks can read latest state without stale closures.
  const stateRef = useRef(storeState)
  stateRef.current = storeState

  const [error, setError] = useState<unknown>(null)
  const [recentlyUpdatedThreadIds, setRecentlyUpdatedThreadIds] = useState<Set<string>>(new Set())

  // Non-row metadata from the last successful API response (counts, map pins, etc.)
  const metaRef = useRef<Partial<InboxModel>>({})

  const lastFetchRef = useRef<InboxFetchOptions>({ sourceMode: initialSourceMode })
  const abortByBucketRef = useRef<Record<string, AbortController>>({})
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAtRef = useRef<string | null>(null)
  const realtimeBatchRef = useRef<{ tables: Set<string>; threadKeys: Set<string>; eventCount: number }>({
    tables: new Set(), threadKeys: new Set(), eventCount: 0,
  })

  const realtimeEnabled = String(import.meta.env.VITE_INBOX_REALTIME_ENABLED ?? 'true').toLowerCase() !== 'false'
  const minRefreshMs = 120_000 // 2 minutes

  if (isDev) {
    // Log on first render only (conditional render logging, not an effect).
  }

  // ── Core fetch ────────────────────────────────────────────────────────────

  const runLoad = useCallback(async (options: InboxFetchOptions, mode: 'refresh' | 'append') => {
    const rawBucketKey = (options.filters?.view ?? stateRef.current.activeBucketKey) as string
    const bucketKey = normalizeBucketKey(rawBucketKey)
    // Normalize the filter view so backend and cache always use canonical key
    const normalizedOptions: InboxFetchOptions = options.filters?.view && options.filters.view !== bucketKey
      ? { ...options, filters: { ...options.filters, view: bucketKey as any } }
      : options
    const requestId = `${bucketKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`

    // Never start a new refresh if same bucket fetch is already in flight.
    if (abortByBucketRef.current[bucketKey] && mode === 'refresh') {
      if (isDev) console.log(`[InboxRefreshSkip] Already in flight for bucket: ${bucketKey}`)
      return null
    }

    // Abort previous in-flight request for this specific bucket (only for append, or if we really want to supersede).
    if (mode === 'append') {
      abortByBucketRef.current[bucketKey]?.abort()
    }
    
    const controller = new AbortController()
    abortByBucketRef.current[bucketKey] = controller

    dispatch({ type: 'BUCKET_FETCH_START', bucketKey, requestId })
    console.log('[INBOX_FETCH_START]', bucketKey, requestId)

    const fetchStart = performance.now()
    try {
      const model = await loadInbox({ ...normalizedOptions, signal: controller.signal })
      const fetchMs = Math.round(performance.now() - fetchStart)
      console.log('[INBOX_FETCH_DONE]', bucketKey, model?.threads?.length ?? 0, `${fetchMs}ms`)

      const currentBucket = stateRef.current.buckets[bucketKey]
      const currentRowsCount = currentBucket?.rows?.length ?? 0

      // Protection Rule: Only allow live data into bucket rows. Fallback/degraded
      // data is blocked regardless of current row count.
      // On initial boot (0 rows) with degraded data, log and show empty state.
      if (model.dataMode !== 'live') {
        if (currentRowsCount === 0) {
          console.warn('[INBOX_DEGRADED_INITIAL_BLOCKED]', { bucketKey, rowCount: model.threads.length, dataMode: model.dataMode })
        } else {
          console.warn(`[Inbox Protection] Ignoring degraded/fallback response. Preserving ${currentRowsCount} existing rows.`)
        }
        dispatch({
          type: 'BUCKET_FETCH_ERROR',
          bucketKey,
          requestId,
          error: model.liveFetchError ?? 'Data mode degraded. Inbox will retry on next poll.'
        })
        delete abortByBucketRef.current[bucketKey]
        return model
      }

      if (mode === 'append') {
        // Protection Rule: Load-more failure (0 rows but not live) shouldn't overwrite anything.
        if (model.dataMode !== 'live' && (model.threads?.length ?? 0) === 0) {
           console.warn('[Inbox Protection] Ignoring degraded load-more response.')
           dispatch({
             type: 'BUCKET_FETCH_ERROR',
             bucketKey,
             requestId,
             error: model.liveFetchError ?? 'Load more degraded.'
           })
           delete abortByBucketRef.current[bucketKey]
           return model
        }

        dispatch({
          type: 'BUCKET_APPEND_ROWS',
          bucketKey,
          requestId,
          rows: model.threads,
          cursor: model.pagination?.nextCursor ?? null,
          hasMore: Boolean(model.pagination?.hasMore),
        })
      } else {
        dispatch({
          type: 'BUCKET_FETCH_DONE',
          bucketKey,
          requestId,
          rows: model.threads,
          cursor: model.pagination?.nextCursor ?? null,
          hasMore: Boolean(model.pagination?.hasMore),
        })
      }

      // Counts are isolated: SET_VIEW_COUNTS never touches bucket rows.
      // Protection Rule: Only update counts if the response is fully healthy.
      if (model.dataMode === 'live') {
        const counts = extractViewCounts(model)
        if (Object.keys(counts).length > 0) {
          dispatch({ type: 'SET_VIEW_COUNTS', counts })
        }
      }

      // Store secondary metadata (mapPins, pagination, debug counts) separately.
      if (model.dataMode === 'live') {
        metaRef.current = {
          unreadCount: model.unreadCount,
          urgentCount: model.urgentCount,
          totalCount: model.totalCount,
          aiDraftCount: model.aiDraftCount,
          mapPins: model.mapPins,
          pagination: model.pagination,
          loadedCount: model.loadedCount,
          fullyHydratedCount: model.fullyHydratedCount,
          partiallyHydratedCount: model.partiallyHydratedCount,
          orphanCount: model.orphanCount,
          latestFetchMs: fetchMs,
          lastLiveFetchAt: new Date().toISOString(),
          dataMode: 'live' as const,
        }
      }

      lastRefreshAtRef.current = new Date().toISOString()
      setError(null)
      if (isDev) {
        console.log('[useInboxData] refresh complete', {
          bucketKey,
          rowCount: model.threads.length,
          totalCount: model.totalCount,
          dataMode: model.dataMode,
        })
      }
      delete abortByBucketRef.current[bucketKey]
      return model
    } catch (err) {
      delete abortByBucketRef.current[bucketKey]
      if (controller.signal.aborted) return null
      const errMsg = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'BUCKET_FETCH_ERROR', bucketKey, requestId, error: errMsg })
      setError(err)
      if (isDev) console.error('[NEXUS] useInboxData load failed', err)
      return null
    }
  }, [])

  // ── Refresh ───────────────────────────────────────────────────────────────

  const refresh = useCallback(async (options: InboxFetchOptions = {}) => {
    const rawBucketKey = (options.filters?.view ?? stateRef.current.activeBucketKey) as string
    const bucketKey = normalizeBucketKey(rawBucketKey)

    if (options._automatic) {
      if (document.hidden) {
        if (isDev) console.log('[InboxRefreshSkip] document hidden')
        return null
      }
      
      // Implement paused check from props or options
      if (paused || options.paused) {
        if (isDev) console.log('[InboxRefreshSkip] paused (messages loading or heavy load)')
        return null
      }

      const now = Date.now()
      const last = lastRefreshAtRef.current ? new Date(lastRefreshAtRef.current).getTime() : 0
      
      // Implement 2min minimum interval for auto-refresh
      if (now - last < minRefreshMs) {
        if (isDev) console.log('[InboxRefreshSkip] min interval not met', { elapsed: now - last, min: minRefreshMs })
        return null
      }

      // If active bucket already has live rows and last successful live fetch was <2 min ago, skip refresh.
      const currentBucket = stateRef.current.buckets[bucketKey]
      if (currentBucket && currentBucket.rows.length > 0 && (now - last < minRefreshMs)) {
         if (isDev) console.log(`[InboxRefreshSkip] bucket ${bucketKey} already has live data`)
         return null
      }
    }

    // Switch bucket immediately — shows cached rows or empty, never other bucket's rows.
    if (!options._automatic && bucketKey !== stateRef.current.activeBucketKey) {
      dispatch({ type: 'SWITCH_BUCKET', bucketKey })
    }

    lastFetchRef.current = {
      ...lastFetchRef.current,
      ...options,
      sourceMode,
      filters: options.filters !== undefined ? options.filters : lastFetchRef.current.filters,
      cursor: options.cursor ?? null,
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    const query = lastFetchRef.current.filters?.query ?? ''
    const delay = query.trim() ? 250 : 0
    if (delay === 0) return runLoad(lastFetchRef.current, 'refresh')
    return await new Promise<InboxModel | null>((resolve) => {
      debounceRef.current = setTimeout(() => {
        void runLoad(lastFetchRef.current, 'refresh').then(resolve)
      }, delay)
    })
  }, [runLoad, sourceMode, minRefreshMs])

  // ── Load More ─────────────────────────────────────────────────────────────

  const loadMore = useCallback(async (options: InboxFetchOptions = {}) => {
    const activeBucket = stateRef.current.buckets[stateRef.current.activeBucketKey]
    if (activeBucket?.loading) return null
    const cursor = activeBucket?.cursor ?? null
    const offset = cursor ? undefined : (activeBucket?.rows.length ?? 0)
    return runLoad({
      ...lastFetchRef.current,
      ...options,
      sourceMode,
      cursor,
      offset,
      maxRows: options.maxRows ?? 50,
      limit: options.limit ?? options.maxRows ?? 50,
    }, 'append')
  }, [runLoad, sourceMode])

  // ── Realtime subscription + polling heartbeat ─────────────────────────────

  useEffect(() => {
    let cancelled = false
    void refresh()

    let channel: ReturnType<ReturnType<typeof getSupabaseClient>['channel']> | null = null
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null

    const POLL_INTERVAL_MS = realtimeEnabled ? 60_000 : 30_000
    const pollInterval = window.setInterval(() => {
      if (!cancelled) void refresh({ _automatic: true })
    }, POLL_INTERVAL_MS)

    const markRecentlyUpdated = (threadId: string) => {
      setRecentlyUpdatedThreadIds((prev) => new Set([...prev, threadId]))
      setTimeout(() => {
        setRecentlyUpdatedThreadIds((prev) => {
          const next = new Set(prev)
          next.delete(threadId)
          return next
        })
      }, 5000)
    }

    if (shouldUseSupabase() && realtimeEnabled) {
      const supabase = getSupabaseClient()
      const triggerRefresh = (payload: { table?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
        const table = payload?.table ?? 'unknown'
        const rawKey = payload?.new?.thread_key || payload?.old?.thread_key
        const threadKey = typeof rawKey === 'string' ? rawKey : ''

        if (threadKey) {
          markRecentlyUpdated(threadKey)

          if (table === 'message_events' && payload.new) {
            if (isDev) console.log('[SMOOTH_REALTIME_PATCH]', { table, threadKey, type: 'message' })
            const row = payload.new as Record<string, unknown>
            const direction = (row.direction as string) || 'inbound'
            const body = (row.message_body as string) || (row.rendered_message as string) || ''
            const at = (row.message_created_at as string) || (row.event_timestamp as string) || new Date().toISOString()
            // Find current row to compute incremented counts
            let currentMessageCount = 0
            let currentUnreadCount = 0
            for (const bucket of Object.values(stateRef.current.buckets)) {
              const found = bucket.rows.find((r) => {
                const t = r as Record<string, unknown>
                return t.threadKey === threadKey || t.id === threadKey
              }) as Record<string, unknown> | undefined
              if (found) {
                currentMessageCount = (found.messageCount as number) || 0
                currentUnreadCount = (found.unreadCount as number) || 0
                break
              }
            }
            dispatch({
              type: 'REALTIME_PATCH_THREAD',
              threadKey,
              patch: {
                preview: body,
                lastMessageIso: at,
                lastMessageLabel: at,
                latestMessageBody: body,
                latestMessageAt: at,
                latestDirection: direction,
                messageCount: currentMessageCount + 1,
                status: direction === 'inbound' ? 'unread' : 'replied',
                unreadCount: direction === 'inbound' ? currentUnreadCount + 1 : 0,
                needsReply: direction === 'inbound',
                isRead: direction !== 'inbound',
              },
            })
          }

          if (table === 'operator_thread_state' && payload.new) {
            if (isDev) console.log('[SMOOTH_REALTIME_PATCH]', { table, threadKey, type: 'thread_state' })
            const row = payload.new as Record<string, unknown>
            const patch: Record<string, unknown> = {}
            if (row.inbox_category != null) patch.inboxCategory = row.inbox_category
            if (row.detected_intent != null || row.ui_intent != null) patch.uiIntent = row.detected_intent || row.ui_intent
            if (row.thread_stage != null) patch.workflowStage = row.thread_stage
            if (row.is_archived != null) patch.status = row.is_archived ? 'archived' : (row.is_read ? 'read' : undefined)
            if (row.is_read != null) { patch.unreadCount = row.is_read ? 0 : undefined; patch.isRead = row.is_read }
            dispatch({ type: 'REALTIME_PATCH_THREAD', threadKey, patch })
          }
        }

        realtimeBatchRef.current.tables.add(table)
        if (threadKey) realtimeBatchRef.current.threadKeys.add(threadKey)
        realtimeBatchRef.current.eventCount += 1

        if (refreshTimeout) clearTimeout(refreshTimeout)
        refreshTimeout = setTimeout(() => {
          if (!cancelled) {
            if (isDev) {
              console.log('[useInboxData] background refresh sync', {
                refreshReason: 'realtime',
                tables: Array.from(realtimeBatchRef.current.tables),
                threadKeys: Array.from(realtimeBatchRef.current.threadKeys),
                eventCount: realtimeBatchRef.current.eventCount,
              })
            }
            realtimeBatchRef.current = { tables: new Set(), threadKeys: new Set(), eventCount: 0 }
            void refresh({ _automatic: true })
          }
        }, 5000)
      }

      channel = supabase
        .channel('nexus-inbox-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, triggerRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, triggerRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_map_pins' }, triggerRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_thread_state' }, triggerRefresh)
        .subscribe((status) => {
          dispatch({ type: 'SET_REALTIME_STATUS', status: status === 'SUBSCRIBED' ? 'connected' : 'disconnected' })
        })

      if (isDev) console.log('[useInboxData] realtime subscriptions active')
    } else {
      if (isDev) console.log('[useInboxData] realtime disabled', { realtimeEnabled, shouldUseSupabase: shouldUseSupabase() })
    }

    return () => {
      cancelled = true
      Object.values(abortByBucketRef.current).forEach((c) => c?.abort())
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (refreshTimeout) clearTimeout(refreshTimeout)
      window.clearInterval(pollInterval)
      if (channel) void getSupabaseClient().removeChannel(channel)
    }
  }, [refresh, realtimeEnabled])

  const setMode = useCallback((mode: InboxSourceMode) => {
    setSourceMode(mode)
    void runLoad({ ...lastFetchRef.current, sourceMode: mode, cursor: null }, 'refresh')
  }, [runLoad])

  // ── Build InboxModel from store state ─────────────────────────────────────
  // Consumers get the same InboxModel shape as before; the underlying state model
  // is now bucket-isolated and reducer-managed.

  const activeBucketKey = storeState.activeBucketKey
  const activeBucket = storeState.buckets[activeBucketKey]
  const loading = activeBucket?.loading ?? true

  const data: InboxModel = {
    // Bucket rows — ONLY from the active bucket, never from another bucket's cache.
    threads: (activeBucket?.rows ?? []) as InboxThread[],
    liveFetchError: activeBucket?.error ?? null,
    liveFetchStatus: activeBucket?.error ? 'fallback_error' : 'active',
    dataMode: activeBucket?.error ? 'fallback_error' : 'live',

    // Counts isolated from bucket rows — a counts failure never poisons these rows.
    counts: storeState.viewCounts,
    allInboxCount: (storeState.viewCounts.all ?? null) as number | null,
    priorityInboxCount: (storeState.viewCounts.priority ?? null) as number | null,
    activeInboxCount: (storeState.viewCounts.automated ?? null) as number | null,
    waitingInboxCount: (storeState.viewCounts.cold ?? null) as number | null,
    unreadThreadsCount: (storeState.viewCounts.new_replies ?? null) as number | null,
    suppressedThreadsCount: (storeState.viewCounts.suppressed ?? null) as number | null,
    deadThreadsCount: (storeState.viewCounts.dead ?? null) as number | null,

    // Connection status
    realtimeConnected: storeState.realtimeStatus === 'connected',

    // Metadata from last successful fetch (map pins, pagination, debug fields)
    unreadCount: metaRef.current.unreadCount ?? 0,
    urgentCount: metaRef.current.urgentCount ?? 0,
    totalCount: metaRef.current.totalCount ?? 0,
    aiDraftCount: metaRef.current.aiDraftCount ?? 0,
    mapPins: metaRef.current.mapPins,
    pagination: metaRef.current.pagination,
    loadedCount: metaRef.current.loadedCount ?? 0,
    fullyHydratedCount: metaRef.current.fullyHydratedCount ?? 0,
    partiallyHydratedCount: metaRef.current.partiallyHydratedCount ?? 0,
    orphanCount: metaRef.current.orphanCount ?? 0,
    latestFetchMs: metaRef.current.latestFetchMs ?? 0,
    lastLiveFetchAt: metaRef.current.lastLiveFetchAt ?? null,
    messageEventsCount: null,
    messageEventsRawCount: null,
    groupedThreadCount: null,
    sendQueueCount: null,
    archivedThreadsCount: null,
    hiddenThreadsCount: null,
  }

  return { data, loading, error, refresh, loadMore, recentlyUpdatedThreadIds, sourceMode, setSourceMode: setMode }
}
