import { useState, useEffect, useCallback, useRef, useReducer } from 'react'
import { inboxReducer, EMPTY_INBOX_STORE_STATE, type InboxStoreAction } from './inbox-store'
import type { CommandCenterStore } from '../../domain/types'
import { formatRelativeTime } from '../../shared/formatters'
import { buildConversationThreadIdFromRecord, fetchInboxModel, type InboxFetchOptions, type InboxSourceMode } from '../../lib/data/inboxData'
import * as backendClient from '../../lib/api/backendClient'
import type { InboxModel, InboxThread, InboxRealtimeStatus } from '../../domain/inbox/inbox-model-types'
export type { InboxModel, InboxThread, InboxRealtimeStatus } from '../../domain/inbox/inbox-model-types'
import { isDev, shouldUseSupabase } from '../../lib/data/shared'
import type { InboxWorkflowThread, InboxStatus, SellerStage, AutomationState } from '../../lib/data/inboxWorkflowData'
import { hasSupabaseEnv } from '../../lib/supabaseClient'
import { getSupabaseClient } from '../../lib/supabaseClient'
import {
  patchDashboardThread,
  setDashboardConnectionState,
} from '../../lib/data/dashboardEntityStore'
import {
  logRealtimeFallbackPolling,
  logRealtimePatchApplied,
  type DashboardConnectionState,
} from '../../lib/data/dashboardDataLayer'
import {
  createDegradedPollScheduler,
  POLL_INTERVAL_DEGRADED_MS,
} from '../../domain/inbox/inbox-poll-scheduler'
import {
  adjustFetchInFlight,
  markApiBootRequestStart,
  markApiBootResponse,
  markBucketSwitch,
  markDegradedPollTick,
  markDuplicateLiveRequestBlocked,
  markInboxLiveRequest,
  publishInboxProof,
} from '../../domain/inbox/inbox-proof-bridge'

const CACHE_KEY = 'leadcommand.liveInbox.lastGood.v2'
const CACHE_COUNTS_KEY = 'leadcommand.liveInbox.lastGoodCounts.v2'
type InboxTimeoutMode = NonNullable<InboxFetchOptions['_timeoutMode']>

export const isInboxDebugEnabled = (): boolean =>
  isDev && typeof localStorage !== 'undefined' && localStorage.getItem('nexus.inbox.debug') === '1'

const readCachedViewCounts = (): Record<string, number> => {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CACHE_COUNTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const counts: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric >= 0) counts[key] = numeric
    }
    return counts
  } catch {
    localStorage.removeItem(CACHE_COUNTS_KEY)
    return {}
  }
}

const writeCachedViewCounts = (counts: Record<string, number>) => {
  if (typeof localStorage === 'undefined') return
  try {
    if (!counts || Object.keys(counts).length === 0) return
    localStorage.setItem(CACHE_COUNTS_KEY, JSON.stringify(counts))
  } catch {
    /* ignore quota errors */
  }
}

const DEFAULT_BOOT_BUCKET_KEY = 'all_messages'
const COUNTS_REFRESH_DEBOUNCE_MS = 350

const refreshAuthoritativeViewCounts = (
  dispatch: React.Dispatch<InboxStoreAction>,
) => {
  void backendClient.fetchInboxCounts().then((res) => {
    if (!res.ok) return
    const payload = (res.data ?? {}) as Record<string, unknown>
    const rawCounts = (payload.counts ?? (payload.data as Record<string, unknown> | undefined)?.counts) as
      | Record<string, unknown>
      | undefined
    if (!rawCounts || Object.keys(rawCounts).length === 0) return
    const counts = mapAuthoritativeCounts(rawCounts)
    dispatch({ type: 'SET_VIEW_COUNTS', counts })
    writeCachedViewCounts(counts)
  }).catch(() => {})
}

const readCachedBootRows = (bucketKey: string = DEFAULT_BOOT_BUCKET_KEY): InboxThread[] => {
  if (typeof localStorage === 'undefined') return []
  const scopedCacheKey = `${CACHE_KEY}:${bucketKey}`
  try {
    const raw = localStorage.getItem(scopedCacheKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { threads?: InboxThread[] }
    return Array.isArray(parsed?.threads) ? parsed.threads : []
  } catch {
    localStorage.removeItem(scopedCacheKey)
    return []
  }
}

const buildBootStoreState = (): typeof EMPTY_INBOX_STORE_STATE => {
  const cachedCounts = readCachedViewCounts()
  const cachedRows = readCachedBootRows(DEFAULT_BOOT_BUCKET_KEY)
  const hasCachedCounts = Object.keys(cachedCounts).length > 0
  const hasCachedRows = cachedRows.length > 0
  if (!hasCachedCounts && !hasCachedRows) return EMPTY_INBOX_STORE_STATE

  return {
    ...EMPTY_INBOX_STORE_STATE,
    viewCounts: hasCachedCounts ? cachedCounts : EMPTY_INBOX_STORE_STATE.viewCounts,
    buckets: hasCachedRows
      ? {
          [DEFAULT_BOOT_BUCKET_KEY]: {
            rows: cachedRows,
            loading: false,
            error: null,
            lastRequestId: 'boot-cache',
            lastLoadedAt: new Date().toISOString(),
            scrollTop: 0,
            cursor: null,
            hasMore: true,
          },
        }
      : EMPTY_INBOX_STORE_STATE.buckets,
  }
}

const mapAuthoritativeCounts = (rawCounts: Record<string, unknown>): Record<string, number> => ({
  priority: Number(rawCounts.priority ?? rawCounts.hot_leads ?? 0),
  new_replies: Number(rawCounts.new_replies ?? rawCounts.new_inbound ?? 0),
  needs_review: Number(rawCounts.needs_review ?? 0),
  waiting: Number(rawCounts.waiting ?? rawCounts.waiting_on_seller ?? 0),
  follow_up: Number(rawCounts.follow_up ?? rawCounts.outbound_active ?? 0),
  cold: Number(rawCounts.cold ?? rawCounts.cold_no_response ?? 0),
  dead: Number(rawCounts.dead ?? 0),
  suppressed: Number(rawCounts.suppressed ?? rawCounts.dnc_opt_out ?? 0),
  all_messages: Number(rawCounts.all_messages ?? rawCounts.all ?? 0),
  all: Number(rawCounts.all ?? rawCounts.all_messages ?? 0),
  active: Number(rawCounts.active ?? 0),
  automated: Number(rawCounts.automated ?? 0),
})

const toDashboardConnectionState = (status: InboxRealtimeStatus): DashboardConnectionState => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  if (status === 'connected') return 'live'
  if (status === 'connecting') return 'reconnecting'
  if (status === 'disabled' || status === 'error') return 'degraded_polling'
  return 'reconnecting'
}

const LIVE_INBOX_TIMEOUT_MS_BY_MODE: Record<InboxTimeoutMode, number> = {
  initial_boot: 20_000,
  // Must stay >= API manual_bucket_switch budget so category tabs don't time out while all_threads succeeds.
  manual_bucket_switch: 20_000,
  auto_refresh: 12_000,
}

const DEFAULT_LIVE_INBOX_TIMEOUT_MODE: InboxTimeoutMode = 'manual_bucket_switch'

const resolveLiveInboxTimeoutMode = (options: InboxFetchOptions): InboxTimeoutMode => {
  if (options._timeoutMode) return options._timeoutMode
  if (options._automatic) return 'auto_refresh'
  return DEFAULT_LIVE_INBOX_TIMEOUT_MODE
}

const resolveLiveInboxTimeoutMs = (timeoutMode: InboxTimeoutMode): number =>
  LIVE_INBOX_TIMEOUT_MS_BY_MODE[timeoutMode] ?? LIVE_INBOX_TIMEOUT_MS_BY_MODE[DEFAULT_LIVE_INBOX_TIMEOUT_MODE]

const withTimeout = async <T,>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  externalSignal?: AbortSignal,
  trace: Record<string, unknown> = {},
): Promise<T> => {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  // Forward external abort immediately so the network request is actually cancelled,
  // not kept alive until the timeout timer fires.
  const forwardAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  try {
    timeoutId = setTimeout(() => {
      timedOut = true
      if (isInboxDebugEnabled()) {
        console.warn('[INBOX_TIMEOUT_FIRED]', {
          timeoutFired: true,
          timeoutMs,
          ...trace,
        })
      }
      controller.abort()
    }, timeoutMs)
    return await run(controller.signal)
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage)
    // External abort or real network error — re-throw as-is so runLoad can handle it.
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort)
    if (isInboxDebugEnabled()) {
      console.log('[INBOX_TIMEOUT_SETTLED]', {
        timeoutFired: timedOut,
        timeoutMs,
        ...trace,
      })
    }
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
  const advancedKey = options.filters?.advanced && Object.keys(options.filters.advanced).length > 0
    ? `:adv:${JSON.stringify(options.filters.advanced)}`
    : ''
  const filterKey = `${options.filters?.view ?? 'all_messages'}${advancedKey}`
  const scopedCacheKey = `${CACHE_KEY}:${filterKey}`
  const timeoutMode = resolveLiveInboxTimeoutMode(options)
  const timeoutMs = resolveLiveInboxTimeoutMs(timeoutMode)
  const fetchOptions: InboxFetchOptions = options._timeoutMode === timeoutMode
    ? options
    : { ...options, _timeoutMode: timeoutMode }

  if (isInboxDebugEnabled()) console.info('[INBOX_TIMEOUT_CONFIG]', {
    filterKey,
    timeoutMode,
    timeoutMs,
    automatic: options._automatic === true,
    refreshReason: options._refreshReason ?? null,
  })

  if (isDev) {
    console.log('[dashboard boot] live inbox fetch started', { options, filterKey, timeoutMode, timeoutMs })
  }

  if (!hasSupabaseEnv) {
    const liveFetchError = 'Live mode enabled but Supabase env vars are missing.'
    return { ...emptyLiveErrorModel(liveFetchError), _requestedFilter: filterKey }
  }

  try {
    const result = await withTimeout(
      (signal) => fetchInboxModel({ ...fetchOptions, signal }),
      timeoutMs,
      `Live Inbox request timed out after ${timeoutMs}ms (${timeoutMode})`,
      options.signal,
      {
        filterKey,
        timeoutMode,
        automatic: options._automatic === true,
        refreshReason: options._refreshReason ?? null,
      },
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
        propertyAddressFull: t.propertyAddressFull,
        propertyAddress: t.propertyAddress,
        market: t.market,
        propertyType: t.propertyType,
        queueStatus: t.queueStatus,
        estimatedValue: t.estimatedValue,
        bestPhone: t.bestPhone,
        canonicalE164: t.canonicalE164,
        propertyId: t.propertyId,
        prospectId: t.prospectId,
        latestMessageBody: t.latestMessageBody || (t as any).latest_message_body,
        latestMessageAt: t.latestMessageAt || (t as any).latest_message_at,
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

    if (isInboxDebugEnabled()) console.log('[INBOX_LOAD_RESPONSE_MODEL]', {
      filterKey,
      dataMode: result.dataMode,
      responseBodyCount: result.threads.length,
      totalCount: result.totalCount,
      liveDataSource: result.liveDataSource ?? result.liveDiagnostics?.source ?? null,
      fallbackUsed: result.fallbackUsed ?? result.liveDiagnostics?.fallbackUsed ?? false,
    })
    if (isDev) console.log('[dashboard boot] live inbox fetch success', { filterKey, count: result.threads.length })
    return { ...result, _requestedFilter: filterKey }
  } catch (error) {
    // Request was aborted by runLoad (superseded or component cleanup) — let the
    // catch in runLoad handle it silently via controller.signal.aborted check.
    // Do NOT commit fallback_error for an intentionally cancelled request.
    if (options.signal?.aborted) throw error

    const liveFetchError = error instanceof Error ? error.message : String(error)
    if (liveFetchError.includes('timed out')) {
      console.warn('[INBOX_TIMEOUT_HIT]', { filterKey, timeoutMode, timeoutMs, liveFetchError })
    }
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
  const row = t as InboxThread & {
    universal_stage?: string
    universalStage?: string
    seller_stage?: string
    sellerStage?: string
  }
  const conversationStage = (
    row.universal_stage
    || row.universalStage
    || row.seller_stage
    || row.sellerStage
    || t.threadWorkflowStage
    || 'ownership_check'
  ) as SellerStage

  return {
    ...t,
    threadKey: t.threadKey || t.id,
    conversationThreadId: t.conversationThreadId || t.conversation_thread_id || t.id,
    conversation_thread_id: t.conversation_thread_id || t.conversationThreadId || t.id,
    thread_id: t.thread_id || t.conversationThreadId || t.conversation_thread_id || t.threadKey || t.id,
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
    deliveryStatus: (t.latestDirection === 'inbound' || t.latest_message_direction === 'inbound') ? undefined : t.deliveryStatus,
    latestDeliveryStatus: (t.latestDirection === 'inbound' || t.latest_message_direction === 'inbound') ? undefined : (t.latestDeliveryStatus || t.deliveryStatus),
    providerDeliveryStatus: (t.latestDirection === 'inbound' || t.latest_message_direction === 'inbound') ? undefined : t.providerDeliveryStatus,
    latestProviderDeliveryStatus: (t.latestDirection === 'inbound' || t.latest_message_direction === 'inbound') ? undefined : (t.latestProviderDeliveryStatus || t.providerDeliveryStatus),
    latestDeliveredAt: t.latestDeliveredAt ?? t.latest_delivered_at ?? null,
    latest_delivered_at: t.latest_delivered_at ?? t.latestDeliveredAt ?? null,
    latestFailedAt: t.latestFailedAt ?? t.latest_failed_at ?? null,
    latest_failed_at: t.latest_failed_at ?? t.latestFailedAt ?? null,
    latestFailureReason: t.latestFailureReason ?? t.latest_failure_reason ?? t.failureReason,
    latest_failure_reason: t.latest_failure_reason ?? t.latestFailureReason ?? t.failureReason,
    latestSentAt: (t as { latestSentAt?: string | null }).latestSentAt ?? (t as { latest_sent_at?: string | null }).latest_sent_at ?? null,
    latest_sent_at: (t as { latest_sent_at?: string | null }).latest_sent_at ?? (t as { latestSentAt?: string | null }).latestSentAt ?? null,
    is_final_failure: (t as { is_final_failure?: boolean }).is_final_failure ?? (t as { isFinalFailure?: boolean }).isFinalFailure ?? false,
    isFinalFailure: (t as { isFinalFailure?: boolean }).isFinalFailure ?? (t as { is_final_failure?: boolean }).is_final_failure ?? false,
    queueStatus: t.queueStatus || t.queue_status || t.autoReplyStatus || (t.queueId ? 'queued' : null),
  } as InboxWorkflowThread
}

// ── Helper: extract view counts from InboxModel ───────────────────────────────

const extractViewCounts = (model: InboxModel): Record<string, number> => {
  const counts: Record<string, number> = {}
  if (model.counts) Object.assign(counts, model.counts)
  if (model.priorityInboxCount != null) counts.priority = model.priorityInboxCount
  if (model.activeInboxCount != null) counts.active = model.activeInboxCount
  if (model.waitingInboxCount != null) counts.waiting = model.waitingInboxCount
  if (model.allInboxCount != null) counts.all = model.allInboxCount
  if (model.unreadThreadsCount != null) counts.new_replies = model.unreadThreadsCount
  if (model.suppressedThreadsCount != null) counts.suppressed = model.suppressedThreadsCount
  if (model.deadThreadsCount != null) counts.dead = model.deadThreadsCount
  return counts
}

const normalizePhoneLike = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? `+${digits}` : raw
}

const normalizeRealtimeDirection = (value: unknown): 'inbound' | 'outbound' | 'unknown' => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw.startsWith('in') || raw.includes('incoming') || raw.includes('received')) return 'inbound'
  if (raw.startsWith('out') || raw.includes('sent') || raw.includes('queued')) return 'outbound'
  return 'unknown'
}

const getRichnessScore = (threads: any[]): number => {
  if (!threads || threads.length === 0) return 0
  const t = threads[0]
  let score = 0
  if (t.propertyAddressFull || t.propertyAddress || t.displayAddress) score += 1
  if (t.ownerName || t.sellerDisplayName) score += 1
  if (t.canonicalE164 || t.bestPhone || t.sellerPhone || t.phone) score += 1
  if (t.latestMessageBody || t.preview || t.lastMessageBody || t.message_body) score += 1
  if (t.propertyId || t.property_id) score += 1
  if (t.market || t.propertyType || t.property_type) score += 1
  return score
}

const normalizeRealtimeStatus = (value: unknown): string => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw.includes('deliver')) return 'delivered'
  if (raw.includes('fail') || raw.includes('undeliv')) return 'failed'
  if (raw.includes('sent') || raw === 'success') return 'sent'
  if (raw.includes('queue') || raw === 'approval' || raw === 'scheduled') return 'queued'
  if (raw.includes('process') || raw === 'sending') return 'sending'
  return raw || 'pending'
}

const ACTIVE_COUNT_BUCKETS = new Set(['priority', 'new_replies', 'needs_review', 'follow_up'])

const normalizeRealtimeBucket = (value: unknown): string => {
  const raw = String(value ?? '').trim().toLowerCase()
  const aliases: Record<string, string> = {
    hot_leads: 'priority',
    positive_hot: 'priority',
    new_inbound: 'new_replies',
    needs_reply: 'new_replies',
    manual_review: 'needs_review',
    outbound_active: 'follow_up',
    follow_up_due: 'follow_up',
    waiting_on_seller: 'waiting',
    waiting: 'waiting',
    cold_no_response: 'cold',
    dnc_opt_out: 'suppressed',
    opt_out: 'suppressed',
    wrong_number: 'dead',
  }
  return aliases[raw] ?? raw
}

const resolveRealtimeThreadKey = (row: Record<string, unknown>, table: string): string => {
  if (table === 'operator_entity_preferences' && row.entity_type === 'thread') {
    const entityId = String(row.entity_id ?? '').trim()
    if (entityId) return entityId
  }
  const conversationThreadId = String(row.conversation_thread_id ?? row.conversationThreadId ?? '').trim()
  if (conversationThreadId) return conversationThreadId
  const explicit = String(row.thread_key ?? row.threadKey ?? '').trim()
  if (explicit) return explicit
  const direction = table === 'send_queue' ? 'outbound' : normalizeRealtimeDirection(row.direction)
  const sellerPhone = direction === 'inbound'
    ? normalizePhoneLike(row.from_phone_number)
    : normalizePhoneLike(row.to_phone_number)
  return sellerPhone || normalizePhoneLike(row.canonical_e164) || normalizePhoneLike(row.phone_number)
}

const rowBucket = (row: Record<string, unknown> | null | undefined): string => normalizeRealtimeBucket(
  row?.inbox_bucket ?? row?.inboxBucket ?? row?.inbox_category ?? row?.inboxCategory ?? row?.priorityBucket,
)

const rowDirection = (row: Record<string, unknown> | null | undefined): 'inbound' | 'outbound' | 'unknown' =>
  normalizeRealtimeDirection(row?.latest_message_direction ?? row?.latestMessageDirection ?? row?.latestDirection ?? row?.direction)

const isWaitingCount = (bucket: string, _direction: 'inbound' | 'outbound' | 'unknown'): boolean =>
  bucket === 'waiting'

const incrementCount = (counts: Record<string, number>, key: string, delta: number) => {
  if (!key || delta === 0) return
  counts[key] = (counts[key] ?? 0) + delta
}

const buildRealtimeCountDeltas = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Record<string, number> => {
  const deltas: Record<string, number> = {}
  const beforeBucket = rowBucket(before)
  const afterBucket = rowBucket(after)
  const beforeDirection = rowDirection(before)
  const afterDirection = rowDirection(after)

  if (!before) {
    incrementCount(deltas, 'all', 1)
    incrementCount(deltas, 'all_messages', 1)
    incrementCount(deltas, afterBucket, 1)
  } else if (beforeBucket && afterBucket && beforeBucket !== afterBucket) {
    incrementCount(deltas, beforeBucket, -1)
    incrementCount(deltas, afterBucket, 1)
  }

  const beforeActive = before ? ACTIVE_COUNT_BUCKETS.has(beforeBucket) : false
  const afterActive = ACTIVE_COUNT_BUCKETS.has(afterBucket)
  if (beforeActive !== afterActive) incrementCount(deltas, 'active', afterActive ? 1 : -1)

  const beforeWaiting = before ? isWaitingCount(beforeBucket, beforeDirection) : false
  const afterWaiting = isWaitingCount(afterBucket, afterDirection)
  if (beforeWaiting !== afterWaiting) {
    incrementCount(deltas, 'waiting', afterWaiting ? 1 : -1)
    incrementCount(deltas, 'waiting_on_seller', afterWaiting ? 1 : -1)
  }

  return deltas
}

const resolveRealtimeBucketForRow = (row: Record<string, unknown>, table: string): string => {
  const explicit = normalizeRealtimeBucket(row.inbox_bucket ?? row.inboxBucket ?? row.inbox_category ?? row.inboxCategory)
  if (explicit) return explicit
  const intent = String(row.detected_intent ?? row.primary_intent ?? '').toLowerCase()
  const body = String(row.message_body ?? row.message_text ?? '').toLowerCase()
  if (row.opt_out === true || row.is_opt_out === true || ['stop', 'opt_out', 'dnc'].some((token) => intent.includes(token) || body.includes(token))) return 'suppressed'
  if (row.wrong_number === true || row.not_interested === true || ['wrong_number', 'not_interested'].some((token) => intent.includes(token))) return 'dead'
  if (row.needs_review === true || intent.includes('manual_review')) return 'needs_review'
  if (table === 'send_queue') return 'follow_up'
  const direction = normalizeRealtimeDirection(row.direction)
  if (direction === 'inbound') return 'new_replies'
  if (direction === 'outbound') return 'follow_up'
  return 'cold'
}

const buildRealtimeLeadStatePatch = (row: Record<string, unknown>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {}
  if (row.lifecycle_stage != null) {
    patch.lifecycle_stage = row.lifecycle_stage
    patch.lifecycleStage = row.lifecycle_stage
    patch.conversationStage = row.lifecycle_stage
    patch.seller_stage = row.seller_stage ?? row.lifecycle_stage
  }
  if (row.operational_status != null) {
    patch.operational_status = row.operational_status
    patch.operationalStatus = row.operational_status
    patch.conversation_status = row.conversation_status ?? row.operational_status
    patch.conversationStatus = row.conversation_status ?? row.operational_status
    patch.inboxStatus = row.operational_status
    patch.status = row.operational_status
  }
  if (row.lead_temperature != null) {
    patch.lead_temperature = row.lead_temperature
    patch.leadTemperature = row.lead_temperature
    patch.temperature = row.temperature ?? row.lead_temperature
  }
  if (row.disposition != null) patch.disposition = row.disposition
  if (row.contactability_status != null) {
    patch.contactability_status = row.contactability_status
    patch.contactabilityStatus = row.contactability_status
  }
  if (row.is_starred != null) patch.isStarred = row.is_starred
  if (row.is_pinned != null) patch.isPinned = row.is_pinned
  if (row.is_archived != null) {
    patch.isArchived = row.is_archived
    if (row.is_archived) patch.status = 'archived'
  }
  if (row.snoozed_until != null) patch.snoozedUntil = row.snoozed_until
  if (row.next_action != null) {
    patch.next_action = row.next_action
    patch.nextAction = row.next_action
  }
  if (row.manual_stage_lock != null) patch.manual_stage_lock = row.manual_stage_lock
  if (row.manual_temperature_lock != null) patch.manual_temperature_lock = row.manual_temperature_lock
  return patch
}

const buildRealtimePreferencePatch = (row: Record<string, unknown>): Record<string, unknown> => {
  const patch: Record<string, unknown> = {}
  if (row.is_starred != null) patch.isStarred = row.is_starred
  if (row.is_pinned != null) patch.isPinned = row.is_pinned
  return patch
}

const buildRealtimeLeadStateEventPatch = (row: Record<string, unknown>): Record<string, unknown> => {
  const field = String(row.field_name ?? '').trim()
  if (!field) return {}
  const value = row.new_value
  if (value == null) return { [field]: null }
  if (field === 'is_starred' || field === 'is_pinned' || field === 'is_archived' || field === 'manual_stage_lock' || field === 'manual_temperature_lock') {
    return { [field]: String(value).toLowerCase() === 'true' }
  }
  return { [field]: value }
}

const buildRealtimeThreadPatch = (
  row: Record<string, unknown>,
  table: string,
  threadKey: string,
): Record<string, unknown> => {
  const direction = table === 'send_queue' ? 'outbound' : normalizeRealtimeDirection(row.direction)
  const body = String(row.message_body ?? row.message_text ?? row.rendered_message ?? '').trim()
  const at = String(row.event_timestamp ?? row.message_created_at ?? row.sent_at ?? row.delivered_at ?? row.updated_at ?? row.created_at ?? new Date().toISOString())
  const bucket = resolveRealtimeBucketForRow(row, table)
  const deliveryStatus = normalizeRealtimeStatus(
    row.delivery_status ?? row.provider_delivery_status ?? row.raw_carrier_status ?? row.queue_status ?? row.status,
  )
  const providerDeliveryStatus = String(
    row.provider_delivery_status ?? row.raw_carrier_status ?? row.delivery_status ?? row.queue_status ?? '',
  ).trim() || deliveryStatus
  const latestDeliveredAt = row.delivered_at ?? null
  const latestFailedAt = row.failed_at ?? null
  const latestFailureReason = String(
    row.failure_reason ?? row.error_message ?? row.failed_reason ?? row.guard_reason ?? row.blocked_reason ?? row.paused_reason ?? '',
  ).trim() || null
  const queueStatus = String(row.queue_status ?? '').trim() || undefined
  const sellerPhone = direction === 'inbound'
    ? normalizePhoneLike(row.from_phone_number)
    : normalizePhoneLike(row.to_phone_number)
  const ourNumber = direction === 'inbound'
    ? normalizePhoneLike(row.to_phone_number)
    : normalizePhoneLike(row.from_phone_number)
  const conversationThreadId = buildConversationThreadIdFromRecord({
    ...row,
    seller_phone: sellerPhone,
    canonical_e164: sellerPhone || row.canonical_e164,
  })
  return {
    conversationThreadId,
    conversation_thread_id: conversationThreadId,
    threadKey,
    thread_key: threadKey,
    preview: body,
    latestMessageBody: body,
    latest_message_body: body,
    lastMessageBody: body,
    latestMessageAt: at,
    latest_message_at: at,
    latest_activity_at: at,
    lastMessageIso: at,
    lastMessageAt: at,
    latestDirection: direction,
    latestMessageDirection: direction,
    latest_message_direction: direction,
    directionUsed: direction,
    // Only surface delivery status when the latest conversational message is outbound.
    // Inbound threads must never show "Delivered".
    deliveryStatus: direction === 'outbound' ? deliveryStatus : '',
    delivery_status: direction === 'outbound' ? deliveryStatus : '',
    latestDeliveryStatus: direction === 'outbound' ? deliveryStatus : '',
    latest_delivery_status: direction === 'outbound' ? deliveryStatus : '',
    providerDeliveryStatus: direction === 'outbound' ? providerDeliveryStatus : '',
    provider_delivery_status: direction === 'outbound' ? providerDeliveryStatus : '',
    latestProviderDeliveryStatus: direction === 'outbound' ? providerDeliveryStatus : '',
    latest_provider_delivery_status: direction === 'outbound' ? providerDeliveryStatus : '',
    latestDeliveredAt,
    latest_delivered_at: latestDeliveredAt,
    lastDeliveredAt: latestDeliveredAt,
    latestFailedAt,
    latest_failed_at: latestFailedAt,
    latestFailureReason,
    latest_failure_reason: latestFailureReason,
    failureReason: latestFailureReason ?? undefined,
    latestSentAt: row.sent_at ?? (direction === 'outbound' ? at : null),
    queueStatus,
    queue_status: queueStatus,
    sellerPhone: sellerPhone || undefined,
    seller_phone: sellerPhone || undefined,
    phoneNumber: sellerPhone || undefined,
    canonicalE164: sellerPhone || undefined,
    canonical_e164: sellerPhone || undefined,
    ourNumber: ourNumber || undefined,
    inboxBucket: bucket,
    inbox_bucket: bucket,
    inboxCategory: bucket,
    inbox_category: bucket,
    priorityBucket: bucket,
    status: direction === 'inbound' ? 'unread' : 'replied',
    unreadCount: direction === 'inbound' ? 1 : 0,
    unread: direction === 'inbound',
    isRead: direction !== 'inbound',
    needsReply: direction === 'inbound',
    queueId: String(row.queue_id ?? row.id ?? '').trim() || undefined,
  }
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
  all_messages: 'all_messages',
  hot_leads: 'priority',
  positive_hot: 'priority',
  new_inbound: 'new_replies',
  new_inbounds: 'new_replies',
  needs_reply: 'new_replies',
  needs_response: 'new_replies',
  my_priority: 'priority',
  manual_review: 'needs_review',
  outbound_active: 'follow_up',
  follow_up_due: 'follow_up',
  waiting_on_seller: 'waiting',
  waiting: 'waiting',
  cold_no_response: 'cold',
  dnc_opt_out: 'suppressed',
  opt_out: 'suppressed',
  wrong_number: 'dead',
}

const normalizeBucketKey = (key: string): string => {
  const raw = String(key ?? '').trim().toLowerCase()
  return BUCKET_ALIAS_MAP[raw] ?? raw
}

const threadIdentityCandidates = (value: unknown): string[] => {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  if (raw.toLowerCase().startsWith('ct:')) return [raw]
  const candidates = new Set<string>([raw])
  const withoutPhonePrefix = raw.toLowerCase().startsWith('phone:') ? raw.slice(6).trim() : ''
  if (withoutPhonePrefix) candidates.add(withoutPhonePrefix)
  for (const candidate of [...candidates]) {
    if (candidate.includes('|')) continue
    const digits = candidate.replace(/\D/g, '')
    if (digits.length === 10) candidates.add(`+1${digits}`)
    else if (digits.length === 11 && digits.startsWith('1')) candidates.add(`+${digits}`)
    else if (candidate.startsWith('+') && digits.length >= 10) candidates.add(`+${digits}`)
  }
  return [...candidates].filter(Boolean)
}

const rowIdentityValues = (row: Record<string, unknown>): string[] => Array.from(new Set([
  row.conversationThreadId,
  row.conversation_thread_id,
  row.threadKey,
  row.thread_key,
  row.id,
  row.canonicalE164,
  row.canonical_e164,
  row.sellerPhone,
  row.seller_phone,
  row.bestPhone,
  row.best_phone,
  row.phoneNumber,
  row.phone_number,
  row.phone,
].flatMap(threadIdentityCandidates)))

const rowIdentityMatches = (row: Record<string, unknown>, threadKey: string): boolean => {
  const needles = threadIdentityCandidates(threadKey)
  if (needles.length === 0) return false
  const identities = new Set(rowIdentityValues(row))
  return needles.some((needle) => identities.has(needle))
}

export const useInboxData = (options: { initialSourceMode?: InboxSourceMode; paused?: boolean } = {}) => {
  const { initialSourceMode = 'conversations', paused = false } = options
  const [sourceMode, setSourceMode] = useState<InboxSourceMode>(initialSourceMode)
  const [storeState, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STORE_STATE, () => buildBootStoreState())

  // Sync ref so async callbacks can read latest state without stale closures.
  const stateRef = useRef(storeState)
  stateRef.current = storeState

  const [error, setError] = useState<unknown>(null)
  const [recentlyUpdatedThreadIds, setRecentlyUpdatedThreadIds] = useState<Set<string>>(new Set())
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  // Non-row metadata from the last successful API response (counts, map pins, etc.)
  const metaRef = useRef<Partial<InboxModel>>({})

  const lastFetchRef = useRef<InboxFetchOptions>({ sourceMode: initialSourceMode })
  const abortByBucketRef = useRef<Record<string, AbortController>>({})
  const latestRequestIdByBucketRef = useRef<Record<string, string>>({})
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countsRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAtRef = useRef<string | null>(null)
  const realtimeBatchRef = useRef<{ tables: Set<string>; threadKeys: Set<string>; eventCount: number }>({
    tables: new Set(), threadKeys: new Set(), eventCount: 0,
  })

  const realtimeEnabled = String(import.meta.env.VITE_INBOX_REALTIME_ENABLED ?? 'true').toLowerCase() !== 'false'
  const minRefreshMs = 15_000

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

    const existingController = abortByBucketRef.current[bucketKey]
    const sameBucketInFlight = Boolean(existingController && !existingController.signal.aborted)
    if (sameBucketInFlight) {
      const forceMaySupersede = options._force === true && options._timeoutMode !== 'initial_boot'
      const appendMaySupersede = mode === 'append'
      if (!forceMaySupersede && !appendMaySupersede) {
        if (isInboxDebugEnabled()) console.log('[INBOX_FETCH_SKIPPED]', {
          bucketKey,
          mode,
          refresh_skipped_reason: options._timeoutMode === 'initial_boot' ? 'boot_fetch_already_in_flight' : 'already_in_flight',
          inFlightRequestId: latestRequestIdByBucketRef.current[bucketKey] ?? null,
          requestedTimeoutMode: options._timeoutMode ?? null,
          requestedForce: options._force === true,
        })
        markDuplicateLiveRequestBlocked()
        return null
      }

      if (isInboxDebugEnabled()) console.log('[INBOX_FETCH_SUPERSEDE]', {
        bucketKey,
        mode,
        previousRequestId: latestRequestIdByBucketRef.current[bucketKey] ?? null,
        nextRequestId: requestId,
        reason: appendMaySupersede ? 'append' : 'forced_refresh',
      })
      existingController?.abort()
    }
    
    const controller = new AbortController()
    abortByBucketRef.current[bucketKey] = controller
    latestRequestIdByBucketRef.current[bucketKey] = requestId

    dispatch({ type: 'BUCKET_FETCH_START', bucketKey, requestId })
    adjustFetchInFlight(1)
    markInboxLiveRequest()
    if (normalizedOptions._timeoutMode === 'initial_boot') markApiBootRequestStart()
    if (isInboxDebugEnabled()) console.log('[INBOX_FETCH_START]', {
      bucketKey,
      requestId,
      mode,
      timeoutMode: normalizedOptions._timeoutMode ?? null,
      refreshReason: normalizedOptions._refreshReason ?? null,
      force: normalizedOptions._force === true,
    })

    const fetchStart = performance.now()
    try {
      const model = await loadInbox({ ...normalizedOptions, signal: controller.signal })
      const fetchMs = Math.round(performance.now() - fetchStart)
      if (isInboxDebugEnabled()) console.log('[INBOX_FETCH_DONE]', {
        bucketKey,
        requestId,
        responseBodyCount: model?.threads?.length ?? 0,
        dataMode: model?.dataMode ?? null,
        fetchMs,
      })

      const latestRequestId = latestRequestIdByBucketRef.current[bucketKey] ?? null
      const staleGuardPassed = latestRequestId === requestId && abortByBucketRef.current[bucketKey] === controller && !controller.signal.aborted
      if (isInboxDebugEnabled()) {
        console.log('[INBOX_STALE_GUARD]', {
          bucketKey,
          requestId,
          latestRequestId,
          staleGuardPassed,
          staleGuardResult: staleGuardPassed ? 'commit_allowed' : 'stale_response_ignored',
        })
      }
      if (!staleGuardPassed) {
        if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
        return model
      }

      const currentBucket = stateRef.current.buckets[bucketKey]
      const currentRowsCount = currentBucket?.rows?.length ?? 0
      const hasThreadRows = (model.threads?.length ?? 0) > 0

      // Protection Rule: only block a degraded response when it has no rows to show.
      // If threads exist, commit them and preserve the last good counts instead.
      if (model.dataMode !== 'live' && !hasThreadRows) {
        if (currentRowsCount === 0) {
          console.warn('[INBOX_DEGRADED_INITIAL_BLOCKED]', { bucketKey, rowCount: model.threads.length, dataMode: model.dataMode })
        } else {
          console.warn(`[Inbox Protection] Ignoring degraded/fallback response. Preserving ${currentRowsCount} existing rows.`)
        }
        dispatch({
          type: 'BUCKET_FETCH_ERROR',
          bucketKey,
          requestId,
          error: model.liveFetchError ?? 'inbox_load_failed'
        })
        if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
        return model
      }

      if (model.dataMode === 'fallback_error' && hasThreadRows && currentRowsCount > 0) {
        const currentScore = getRichnessScore(currentBucket.rows)
        const incomingScore = getRichnessScore(model.threads)
        if (incomingScore < currentScore) {
          console.warn(`[Inbox Protection] Ignoring fallback_error response. Preserving ${currentRowsCount} richer existing rows (score: ${currentScore} vs ${incomingScore}).`)
          dispatch({
            type: 'BUCKET_FETCH_ERROR',
            bucketKey,
            requestId,
            error: model.liveFetchError ?? 'inbox_load_failed'
          })
          if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
          return model
        }
      }

      if (model.dataMode !== 'live' && hasThreadRows) {
        console.warn('[INBOX_DEGRADED_ROWS_COMMITTED]', {
          bucketKey,
          rowCount: model.threads.length,
          dataMode: model.dataMode,
          liveFetchError: model.liveFetchError ?? null,
        })
      }

      if (mode === 'append') {
        // Protection Rule: Load-more failure with zero rows shouldn't overwrite anything.
        if (model.dataMode !== 'live' && !hasThreadRows) {
           console.warn('[Inbox Protection] Ignoring degraded load-more response.')
           dispatch({
             type: 'BUCKET_FETCH_ERROR',
             bucketKey,
             requestId,
             error: model.liveFetchError ?? 'inbox_load_failed'
           })
           if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
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
      if (isInboxDebugEnabled()) console.log('[INBOX_COMMIT_DONE]', {
        bucketKey,
        requestId,
        mode,
        finalCommittedThreadCount: mode === 'append'
          ? (() => {
              const seen = new Set<string>()
              let count = 0
              for (const row of [...(currentBucket?.rows ?? []), ...model.threads]) {
                const record = row as Record<string, unknown>
                const key = String(record.threadKey ?? record.thread_key ?? record.id ?? '').trim()
                if (key) {
                  if (seen.has(key)) continue
                  seen.add(key)
                }
                count += 1
              }
              return count
            })()
          : model.threads.length,
        responseThreadCount: model.threads.length,
      })

      // Counts are isolated: SET_VIEW_COUNTS never touches bucket rows.
      // Protection Rule: only update counts when the response includes healthy counts.
      if (model.dataMode === 'live' && model.countsDegraded !== true) {
        const counts = extractViewCounts(model)
        if (Object.keys(counts).length > 0) {
          dispatch({ type: 'SET_VIEW_COUNTS', counts })
          writeCachedViewCounts(counts)
        }
      } else if (model.countsApproximate === true) {
        const counts = Object.fromEntries(
          Object.entries(extractViewCounts(model)).filter(([, value]) => Number(value) > 0),
        )
        if (Object.keys(counts).length > 0) {
          console.log('[INBOX_COUNTS_APPROXIMATE_APPLIED]', {
            bucketKey,
            counts_source: model.countsSource ?? model.liveDiagnostics?.countsSource ?? 'visible_rows_approximate',
            count_preserved_reason: model.countPreservedReason ?? model.liveDiagnostics?.countPreservedReason ?? 'approximate_counts_fill_missing_only',
          })
          dispatch({ type: 'SET_VIEW_COUNTS', counts, preserveExisting: true, reason: model.countPreservedReason ?? 'counts_approximate' })
        }
      } else if (model.countsDegraded === true) {
        console.log('[INBOX_COUNTS_PRESERVED]', {
          bucketKey,
          count_preserved_reason: model.countPreservedReason ?? model.liveDiagnostics?.countPreservedReason ?? 'counts_degraded_no_replacement',
        })
      }

      if (
        model.countPreservedReason === 'counts_skipped_by_request'
        || model.countsSource === 'skipped'
      ) {
        void backendClient.fetchInboxCounts().then((res) => {
          if (!res.ok) return
          const payload = (res.data ?? {}) as Record<string, unknown>
          const rawCounts = (payload.counts ?? (payload.data as Record<string, unknown> | undefined)?.counts) as Record<string, number> | undefined
          if (!rawCounts || Object.keys(rawCounts).length === 0) return
          const counts = mapAuthoritativeCounts(rawCounts as Record<string, unknown>)
          dispatch({ type: 'SET_VIEW_COUNTS', counts })
          writeCachedViewCounts(counts)
        }).catch(() => {})
      }

      // Store secondary metadata (mapPins, pagination, debug counts) separately.
      if (model.dataMode === 'live' || hasThreadRows) {
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
          dataMode: model.dataMode,
          countsDegraded: model.countsDegraded,
          countsApproximate: model.countsApproximate,
          countsSource: model.countsSource,
          countPreservedReason: model.countPreservedReason,
          liveDiagnostics: model.liveDiagnostics,
          liveDataSource: model.liveDataSource,
          fallbackUsed: model.fallbackUsed,
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
      if (normalizedOptions._timeoutMode === 'initial_boot') {
        markApiBootResponse()
      }
      publishInboxProof({ activeBucketKey: bucketKey })
      if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
      return model
    } catch (err) {
      if (abortByBucketRef.current[bucketKey] === controller) delete abortByBucketRef.current[bucketKey]
      if (controller.signal.aborted) return null
      const latestRequestId = latestRequestIdByBucketRef.current[bucketKey] ?? null
      const staleGuardPassed = latestRequestId === requestId
      console.log('[INBOX_STALE_GUARD]', {
        bucketKey,
        requestId,
        latestRequestId,
        staleGuardPassed,
        staleGuardResult: staleGuardPassed ? 'error_commit_allowed' : 'stale_error_ignored',
      })
      if (!staleGuardPassed) return null
      const errMsg = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'BUCKET_FETCH_ERROR', bucketKey, requestId, error: errMsg })
      setError(err)
      if (isDev) console.error('[NEXUS] useInboxData load failed', err)
      return null
    } finally {
      adjustFetchInFlight(-1)
    }
  }, [])

  // ── Refresh ───────────────────────────────────────────────────────────────

  const refresh = useCallback(async (options: InboxFetchOptions = {}) => {
    const rawBucketKey = (options.filters?.view ?? stateRef.current.activeBucketKey) as string
    const bucketKey = normalizeBucketKey(rawBucketKey)

    if (options._automatic && !options._force) {
      if (document.hidden) {
        if (isDev) console.log('[INBOX_REFRESH_SKIPPED]', { bucketKey, refresh_skipped_reason: 'document_hidden' })
        return null
      }
      
      // Implement paused check from props or options
      if (pausedRef.current || options.paused) {
        if (isDev) console.log('[INBOX_REFRESH_SKIPPED]', { bucketKey, refresh_skipped_reason: 'paused' })
        return null
      }

      const now = Date.now()
      const last = lastRefreshAtRef.current ? new Date(lastRefreshAtRef.current).getTime() : 0

      // When realtime has flapped to CHANNEL_ERROR/TIMED_OUT (status 'error') or fully
      // disconnected, back off polling to >=30s so a degraded socket can't trigger an
      // inbox/live request storm. Healthy/connecting states keep the normal 15s cadence.
      const realtimeStatus = stateRef.current.realtimeStatus
      const realtimeDegradedNow = realtimeStatus === 'error' || realtimeStatus === 'disconnected'
      const effectiveMinRefreshMs = realtimeDegradedNow ? 30_000 : minRefreshMs

      // Lightweight polling fallback while the tab is focused.
      if (now - last < effectiveMinRefreshMs) {
        if (isDev) console.log('[INBOX_REFRESH_SKIPPED]', { bucketKey, refresh_skipped_reason: 'min_interval_not_met', elapsed: now - last, min: effectiveMinRefreshMs, realtimeStatus })
        return null
      }

      // If active bucket already has live rows and last successful live fetch was recent, skip refresh.
      const currentBucket = stateRef.current.buckets[bucketKey]
      if (currentBucket && currentBucket.rows.length > 0 && (now - last < effectiveMinRefreshMs)) {
         if (isDev) console.log('[INBOX_REFRESH_SKIPPED]', { bucketKey, refresh_skipped_reason: 'bucket_recently_loaded' })
         return null
      }
    }

    const bucketSwitchFrom = stateRef.current.activeBucketKey
    const bucketSwitchStartedAt = (!options._automatic && bucketKey !== bucketSwitchFrom)
      ? performance.now()
      : null

    // Switch bucket immediately — shows cached rows or empty, never other bucket's rows.
    if (!options._automatic && bucketKey !== stateRef.current.activeBucketKey) {
      dispatch({ type: 'SWITCH_BUCKET', bucketKey })
      publishInboxProof({ activeBucketKey: bucketKey })
      if (bucketSwitchStartedAt != null) {
        const switchFrom = bucketSwitchFrom
        const switchTo = bucketKey
        const switchStarted = bucketSwitchStartedAt
        const markSwitch = () => markBucketSwitch(switchFrom, switchTo, performance.now() - switchStarted)
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(markSwitch)
        else markSwitch()
      }
    }

    lastFetchRef.current = {
      ...lastFetchRef.current,
      ...options,
      sourceMode,
      filters: options.filters !== undefined ? options.filters : lastFetchRef.current.filters,
      cursor: options.cursor ?? null,
    }
    delete lastFetchRef.current._automatic
    delete lastFetchRef.current._force
    delete lastFetchRef.current._timeoutMode
    delete lastFetchRef.current._refreshReason
    delete lastFetchRef.current.paused

    const requestOptions: InboxFetchOptions = {
      ...lastFetchRef.current,
      _automatic: options._automatic,
      _force: options._force,
      _timeoutMode: options._timeoutMode,
      _refreshReason: options._refreshReason,
      paused: options.paused,
      signal: options.signal,
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)
    const query = requestOptions.filters?.query ?? ''
    const delay = query.trim() ? 250 : 0
    const finishBucketSwitch = (model: InboxModel | null) => model

    if (delay === 0) return runLoad(requestOptions, 'refresh').then(finishBucketSwitch)
    return await new Promise<InboxModel | null>((resolve) => {
      debounceRef.current = setTimeout(() => {
        void runLoad(requestOptions, 'refresh').then(finishBucketSwitch).then(resolve)
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

    void refresh({ _timeoutMode: 'initial_boot', _refreshReason: 'initial_boot', limit: 25 })

    let channel: ReturnType<ReturnType<typeof getSupabaseClient>['channel']> | null = null

    const degradedPollScheduler = createDegradedPollScheduler({
      intervalMs: POLL_INTERVAL_DEGRADED_MS,
      getRealtimeStatus: () => stateRef.current.realtimeStatus,
      isCancelled: () => cancelled,
      isDocumentHidden: () => typeof document !== 'undefined' && document.hidden,
      onTick: () => {
        markDegradedPollTick()
        refreshAuthoritativeViewCounts(dispatch)
        void refresh({
          _automatic: true,
          _refreshReason: 'fallback_polling',
        })
      },
    })

    const handleOffline = () => {
      dispatch({ type: 'SET_REALTIME_STATUS', status: 'disconnected' })
      setDashboardConnectionState('offline', { reason: 'browser_offline' })
      logRealtimeFallbackPolling('browser_offline', { fallbackMode: 'polling' })
    }

    const handleOnline = () => {
      dispatch({ type: 'SET_REALTIME_STATUS', status: 'connecting' })
      setDashboardConnectionState('reconnecting', { reason: 'browser_online' })
      void refresh({ _automatic: true, _force: true, _refreshReason: 'browser_online' })
    }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

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

    const enterPollingMode = (reason: string, detail?: unknown) => {
      dispatch({ type: 'SET_REALTIME_STATUS', status: 'error' })
      setDashboardConnectionState('degraded_polling', { reason })
      logRealtimeFallbackPolling(reason, {
        detail: detail instanceof Error ? detail.message : detail ?? null,
        fallbackMode: 'polling',
      })
      console.warn('[INBOX_REALTIME_DEGRADED]', {
        reason,
        detail: detail instanceof Error ? detail.message : detail ?? null,
        fallbackMode: 'polling',
      })
    }

    if (shouldUseSupabase() && realtimeEnabled) {
      dispatch({ type: 'SET_REALTIME_STATUS', status: 'connecting' })
      setDashboardConnectionState('reconnecting', { reason: 'subscribe_start' })
      const findStoredThread = (threadKey: string): Record<string, unknown> | null => {
        for (const bucket of Object.values(stateRef.current.buckets)) {
          const found = bucket.rows.find((candidate) => {
            const row = candidate as Record<string, unknown>
            return rowIdentityMatches(row, threadKey)
          }) as Record<string, unknown> | undefined
          if (found) return found
        }
        return null
      }

      const triggerRefresh = (payload: { table?: string; eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
        const table = payload?.table ?? 'unknown'
        const row = (payload?.new ?? payload?.old ?? {}) as Record<string, unknown>
        const threadKey = resolveRealtimeThreadKey(row, table)
        let patchApplied = false

        if (threadKey) {
          markRecentlyUpdated(threadKey)

          if ((table === 'message_events' || table === 'send_queue') && payload.new) {
            const before = findStoredThread(threadKey)
            const patch = buildRealtimeThreadPatch(payload.new, table, threadKey)
            const beforeBucket = rowBucket(before)
            const afterBucket = rowBucket(patch)
            const countDeltas = buildRealtimeCountDeltas(before, patch)
            const currentMessageCount = Number(before?.messageCount ?? 0)
            const currentUnreadCount = Number(before?.unreadCount ?? 0)
            if (table === 'message_events') {
              patch.messageCount = currentMessageCount + (payload.eventType === 'INSERT' ? 1 : 0)
              patch.unreadCount = patch.latestDirection === 'inbound'
                ? Math.max(1, currentUnreadCount + (payload.eventType === 'INSERT' ? 1 : 0))
                : 0
            }

            console.log('[INBOX_REALTIME_EVENT_APPLIED]', {
              realtime_event_applied: true,
              table,
              eventType: payload.eventType ?? null,
              threadKey,
              bucket_before: beforeBucket || null,
              bucket_after: afterBucket || null,
              countDeltas,
            })

            dispatch({
              type: 'REALTIME_PATCH_THREAD',
              threadKey,
              patch,
              targetBucketKey: afterBucket,
              upsert: true,
              countDeltas,
              diagnostics: {
                realtime_event_applied: true,
                bucket_before: beforeBucket || null,
                bucket_after: afterBucket || null,
              },
            })
            patchDashboardThread(threadKey, patch, {
              source: 'realtime',
              table,
              eventType: payload.eventType ?? null,
            })
            logRealtimePatchApplied({
              table,
              eventType: payload.eventType ?? null,
              threadKey,
              patchKeys: Object.keys(patch),
              countDeltas,
            })
            patchApplied = true
          }

          if (table === 'operator_thread_state' && payload.new) {
            if (isDev) console.log('[SMOOTH_REALTIME_PATCH]', { table, threadKey, type: 'thread_state' })
            const row = payload.new as Record<string, unknown>
            const patch: Record<string, unknown> = {}
            if (row.inbox_category != null) patch.inboxCategory = row.inbox_category
            if (row.inbox_category != null) patch.inbox_bucket = normalizeRealtimeBucket(row.inbox_category)
            if (row.detected_intent != null || row.ui_intent != null) patch.uiIntent = row.detected_intent || row.ui_intent
            if (row.thread_stage != null) patch.workflowStage = row.thread_stage
            if (row.is_archived != null) patch.status = row.is_archived ? 'archived' : (row.is_read ? 'read' : undefined)
            if (row.is_read != null) { patch.unreadCount = row.is_read ? 0 : undefined; patch.isRead = row.is_read }
            const before = findStoredThread(threadKey)
            const beforeBucket = rowBucket(before)
            const afterBucket = rowBucket({ ...(before ?? {}), ...patch })
            const countDeltas = buildRealtimeCountDeltas(before, { ...(before ?? {}), ...patch })
            console.log('[INBOX_REALTIME_EVENT_APPLIED]', {
              realtime_event_applied: true,
              table,
              eventType: payload.eventType ?? null,
              threadKey,
              bucket_before: beforeBucket || null,
              bucket_after: afterBucket || null,
              countDeltas,
            })
            dispatch({ type: 'REALTIME_PATCH_THREAD', threadKey, patch, targetBucketKey: afterBucket, upsert: false, countDeltas })
            patchDashboardThread(threadKey, patch, {
              source: 'realtime',
              table,
              eventType: payload.eventType ?? null,
            })
            logRealtimePatchApplied({
              table,
              eventType: payload.eventType ?? null,
              threadKey,
              patchKeys: Object.keys(patch),
              countDeltas,
            })
            patchApplied = true
          }

          if (table === 'inbox_thread_state' && payload.new) {
            const row = payload.new as Record<string, unknown>
            const patch = buildRealtimeLeadStatePatch(row)
            if (Object.keys(patch).length > 0) {
              const before = findStoredThread(threadKey)
              const beforeBucket = rowBucket(before)
              const merged = { ...(before ?? {}), ...patch }
              const afterBucket = rowBucket(merged)
              const countDeltas = buildRealtimeCountDeltas(before, merged)
              console.log('[INBOX_REALTIME_EVENT_APPLIED]', {
                realtime_event_applied: true,
                table,
                eventType: payload.eventType ?? null,
                threadKey,
                bucket_before: beforeBucket || null,
                bucket_after: afterBucket || null,
                countDeltas,
              })
              dispatch({
                type: 'REALTIME_PATCH_THREAD',
                threadKey,
                patch,
                targetBucketKey: afterBucket,
                upsert: false,
                countDeltas,
              })
              patchDashboardThread(threadKey, patch, {
                source: 'realtime',
                table,
                eventType: payload.eventType ?? null,
              })
              logRealtimePatchApplied({
                table,
                eventType: payload.eventType ?? null,
                threadKey,
                patchKeys: Object.keys(patch),
                countDeltas,
              })
              patchApplied = true
            }
          }

          if (table === 'operator_entity_preferences' && payload.new) {
            const row = payload.new as Record<string, unknown>
            if (row.entity_type === 'thread') {
              const patch = buildRealtimePreferencePatch(row)
              if (Object.keys(patch).length > 0) {
                dispatch({ type: 'REALTIME_PATCH_THREAD', threadKey, patch, upsert: false })
                patchDashboardThread(threadKey, patch, {
                  source: 'realtime',
                  table,
                  eventType: payload.eventType ?? null,
                })
                logRealtimePatchApplied({
                  table,
                  eventType: payload.eventType ?? null,
                  threadKey,
                  patchKeys: Object.keys(patch),
                })
                patchApplied = true
              }
            }
          }

          if (table === 'universal_lead_state_events' && payload.new) {
            const row = payload.new as Record<string, unknown>
            const patch = buildRealtimeLeadStateEventPatch(row)
            if (Object.keys(patch).length > 0) {
              dispatch({ type: 'REALTIME_PATCH_THREAD', threadKey, patch, upsert: false })
              patchDashboardThread(threadKey, patch, {
                source: 'realtime',
                table,
                eventType: payload.eventType ?? null,
              })
              logRealtimePatchApplied({
                table,
                eventType: payload.eventType ?? null,
                threadKey,
                patchKeys: Object.keys(patch),
              })
              patchApplied = true
            }
          }
        }

        realtimeBatchRef.current.tables.add(table)
        if (threadKey) realtimeBatchRef.current.threadKeys.add(threadKey)
        realtimeBatchRef.current.eventCount += 1
        if (countsRefreshDebounceRef.current) clearTimeout(countsRefreshDebounceRef.current)
        countsRefreshDebounceRef.current = setTimeout(() => {
          refreshAuthoritativeViewCounts(dispatch)
        }, COUNTS_REFRESH_DEBOUNCE_MS)
        if (!patchApplied && isDev) {
          console.log('[INBOX_REALTIME_PATCH_SKIPPED]', {
            table,
            eventType: payload.eventType ?? null,
            threadKey: threadKey || null,
            reason: threadKey ? 'no_supported_patch' : 'missing_thread_key',
          })
        }
      }

      try {
        const supabase = getSupabaseClient()
        channel = supabase
          .channel('nexus-inbox-realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, triggerRefresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, triggerRefresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_map_pins' }, triggerRefresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_thread_state' }, triggerRefresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_thread_state' }, triggerRefresh)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'universal_lead_state_events' }, triggerRefresh)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_entity_preferences' }, triggerRefresh)
          .subscribe((status) => {
            if (cancelled) return
            const normalizedStatus: InboxRealtimeStatus =
              status === 'SUBSCRIBED' ? 'connected'
              : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'error'
              : status === 'CLOSED' ? 'disconnected'
              : 'connecting'
            dispatch({ type: 'SET_REALTIME_STATUS', status: normalizedStatus })
            const connectionState = toDashboardConnectionState(normalizedStatus)
            setDashboardConnectionState(connectionState, {
              reason: 'subscribe_status',
              realtimeStatus: normalizedStatus,
              rawStatus: status,
            })
            console.log('[INBOX_REALTIME_STATUS]', {
              status,
              normalizedStatus,
              connectionState,
              fallbackMode: normalizedStatus === 'connected' || normalizedStatus === 'connecting' ? 'realtime' : 'polling',
            })
            if (normalizedStatus === 'error' || normalizedStatus === 'disconnected') {
              logRealtimeFallbackPolling('subscribe_status', {
                status,
                normalizedStatus,
                connectionState,
                fallbackMode: 'polling',
              })
              console.warn('[INBOX_REALTIME_DEGRADED]', {
                reason: 'subscribe_status',
                status,
                fallbackMode: 'polling',
              })
            }
          })

        if (isDev) console.log('[useInboxData] realtime subscriptions active')
      } catch (error) {
        enterPollingMode('realtime_setup_failed', error)
      }
    } else {
      dispatch({ type: 'SET_REALTIME_STATUS', status: 'disabled' })
      setDashboardConnectionState('degraded_polling', { reason: 'realtime_disabled' })
      logRealtimeFallbackPolling('realtime_disabled', {
        realtimeEnabled,
        shouldUseSupabase: shouldUseSupabase(),
      })
      if (isDev) console.log('[useInboxData] realtime disabled', { realtimeEnabled, shouldUseSupabase: shouldUseSupabase() })
    }

    return () => {
      cancelled = true
      Object.values(abortByBucketRef.current).forEach((c) => c?.abort())
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (countsRefreshDebounceRef.current) clearTimeout(countsRefreshDebounceRef.current)
      degradedPollScheduler.stop()
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
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
  const loading = activeBucket?.loading ?? ((activeBucket?.rows?.length ?? 0) === 0)
  const realtimeStatus = storeState.realtimeStatus
  const realtimeDegraded = realtimeStatus === 'error' || realtimeStatus === 'disconnected'
  const connectionState = toDashboardConnectionState(realtimeStatus)

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
    activeInboxCount: (storeState.viewCounts.active ?? null) as number | null,
    waitingInboxCount: (storeState.viewCounts.waiting ?? null) as number | null,
    unreadThreadsCount: (storeState.viewCounts.new_replies ?? null) as number | null,
    suppressedThreadsCount: (storeState.viewCounts.suppressed ?? null) as number | null,
    deadThreadsCount: (storeState.viewCounts.dead ?? null) as number | null,

    // Connection status
    realtimeConnected: realtimeStatus === 'connected',
    realtimeStatus,
    connectionState,
    realtimeDegraded,
    refreshMode: realtimeStatus === 'disabled' ? 'disabled' : realtimeDegraded ? 'polling' : 'realtime',

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
    countsDegraded: metaRef.current.countsDegraded ?? false,
    countsApproximate: metaRef.current.countsApproximate ?? false,
    countsSource: metaRef.current.countsSource ?? null,
    countPreservedReason: metaRef.current.countPreservedReason ?? null,
    liveDiagnostics: metaRef.current.liveDiagnostics,
    liveDataSource: metaRef.current.liveDataSource ?? null,
    fallbackUsed: metaRef.current.fallbackUsed ?? false,
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
