import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import {
  getThreadContext,
  getThreadHydrationForThread,
  getThreadMessagesPageForThread,
  type ThreadContext,
  type ThreadIntelligenceRecord,
  type ThreadMessage,
} from '../../lib/data/inboxData'
import { normalizeDealContext, type DealContext } from '../../lib/data/dealContext'
import { fetchDealIntelligenceDossier } from '../../lib/api/backendClient'
import {
  measureCachedThreadOpen,
  readCachedThreadMessages,
  resolveThreadMessageCacheKey,
} from './thread-selection-cache'
import { markUncachedMessagesMs } from './inbox-proof-bridge'

export type ThreadSelectFetchKind = 'messages' | 'hydration' | 'thread_context' | 'dossier' | 'participants'

export interface ThreadSelectFetchPlan {
  kind: ThreadSelectFetchKind
  parallelGroup: 'primary'
}

export interface ThreadSelectImmediateState {
  cacheKey: string
  cachedMessages: readonly ThreadMessage[]
  messagesLoading: boolean
  contextLoading: boolean
  selectedMessages: ThreadMessage[]
  dealContextFallback: DealContext | null
  threadContextSeed: ThreadContext | null
  intelligenceSeed: ThreadIntelligenceRecord | null
}

export interface ThreadSelectTelemetry {
  cacheHit: boolean
  cacheApplyMs: number
  plannedParallelCount: number
  cacheKey: string
  selectedAtMs: number
}

export interface ThreadSelectPlan {
  cacheKey: string
  clearMessageCache: boolean
  immediate: ThreadSelectImmediateState
  fetches: ThreadSelectFetchPlan[]
  telemetry: ThreadSelectTelemetry
}

export interface ThreadSelectOrchestratorInput {
  thread: InboxWorkflowThread | null
  selectedKey: string | null
  conversationThreadId?: string | null
  messageRefetchKey: number
  messageCache: Record<string, ThreadMessage[]>
  dealContextFallback?: DealContext | null
  threadContextSeed?: ThreadContext | null
  intelligenceSeed?: ThreadIntelligenceRecord | null
  nowMs?: number
}

export function resolveThreadCacheKey(
  thread: InboxWorkflowThread | null | undefined,
  fallbackId = '',
  conversationThreadId?: string | null,
): string {
  if (!thread) return String(fallbackId || '').trim()
  return resolveThreadMessageCacheKey({
    conversationThreadId: conversationThreadId ?? null,
    threadKey: thread.threadKey || thread.id,
    id: thread.id,
  })
}

export function buildIsStillSelected(
  expectedKey: string,
  getActiveKey: () => string | null,
  isCancelled: () => boolean,
): () => boolean {
  return () => !isCancelled() && getActiveKey() === expectedKey
}

export function planThreadSelect(input: ThreadSelectOrchestratorInput): ThreadSelectPlan | null {
  const { thread, selectedKey, messageRefetchKey, messageCache } = input
  if (!thread || !selectedKey) return null

  const cacheKey = resolveThreadCacheKey(thread, selectedKey, input.conversationThreadId)
  const clearMessageCache = messageRefetchKey > 0
  const cacheProbe = measureCachedThreadOpen(messageCache, clearMessageCache ? '' : cacheKey)
  const cachedMessages = clearMessageCache
    ? []
    : (readCachedThreadMessages(messageCache, cacheKey) ?? [])

  const fetches: ThreadSelectFetchPlan[] = [
    { kind: 'messages', parallelGroup: 'primary' },
    { kind: 'hydration', parallelGroup: 'primary' },
    { kind: 'dossier', parallelGroup: 'primary' },
    { kind: 'thread_context', parallelGroup: 'primary' },
  ]

  return {
    cacheKey,
    clearMessageCache,
    immediate: {
      cacheKey,
      cachedMessages,
      messagesLoading: cachedMessages.length === 0,
      contextLoading: true,
      selectedMessages: cachedMessages.length > 0 ? [...cachedMessages] : [],
      dealContextFallback: input.dealContextFallback ?? null,
      threadContextSeed: input.threadContextSeed ?? null,
      intelligenceSeed: input.intelligenceSeed ?? null,
    },
    fetches,
    telemetry: {
      cacheHit: cachedMessages.length > 0,
      cacheApplyMs: cacheProbe.applyMs,
      plannedParallelCount: fetches.length,
      cacheKey,
      selectedAtMs: input.nowMs ?? Date.now(),
    },
  }
}

export type ThreadSelectFetchResult =
  | { kind: 'messages'; messages: ThreadMessage[]; hasMore: boolean; fetchFailed?: boolean; integrityBlocked?: boolean }
  | { kind: 'hydration'; messages: ThreadMessage[]; hasMore: boolean; dealContext?: DealContext | null; intelligence?: ThreadIntelligenceRecord | null }
  | { kind: 'dossier'; dealContext?: DealContext | null; intelligence?: ThreadIntelligenceRecord | null }
  | { kind: 'thread_context'; context: ThreadContext | null }
  | { kind: 'participants'; ok: boolean }

export interface ThreadSelectFetchHandlers {
  messages: (signal: AbortSignal) => Promise<ThreadSelectFetchResult>
  hydration: (signal: AbortSignal) => Promise<ThreadSelectFetchResult>
  dossier: (signal: AbortSignal) => Promise<ThreadSelectFetchResult>
  thread_context: (signal: AbortSignal) => Promise<ThreadSelectFetchResult>
  participants?: (signal: AbortSignal) => Promise<ThreadSelectFetchResult>
}

export interface ThreadSelectExecutionCallbacks {
  onMessages: (result: Extract<ThreadSelectFetchResult, { kind: 'messages' }>) => void
  onHydration: (result: Extract<ThreadSelectFetchResult, { kind: 'hydration' }>) => void
  onDossier: (result: Extract<ThreadSelectFetchResult, { kind: 'dossier' }>) => void
  onThreadContext: (result: Extract<ThreadSelectFetchResult, { kind: 'thread_context' }>) => void
  onParticipants?: (result: Extract<ThreadSelectFetchResult, { kind: 'participants' }>) => void
  onTelemetry?: (event: { phase: string; ms: number; stillSelected: boolean }) => void
}

export interface CreateThreadSelectHandlersOptions {
  cachedMessages?: ThreadMessage[]
  onDossierStart?: () => void
  shouldMeasureUncached?: () => boolean
}

export function createThreadSelectHandlers(
  thread: InboxWorkflowThread,
  options: CreateThreadSelectHandlersOptions = {},
): ThreadSelectFetchHandlers {
  const cachedMessages = options.cachedMessages ?? []
  const threadRecord = thread as unknown as Record<string, unknown>
  const masterOwnerId = String(threadRecord.masterOwnerId ?? threadRecord.master_owner_id ?? '').trim()

  return {
    messages: async (signal) => {
      const fetchStarted = performance.now()
      const page = await getThreadMessagesPageForThread(thread, { signal, maxMessages: 50 })
      if (options.shouldMeasureUncached?.()) {
        markUncachedMessagesMs(Math.round(performance.now() - fetchStarted))
      }
      const diagnostics = (page.diagnostics as Record<string, unknown> | undefined) ?? {}
      const integrityBlocked = Boolean(diagnostics.integrity_blocked)
      const fetchFailed = Boolean(diagnostics.fetch_failed || diagnostics.network_unavailable)
      let resolvedMessages = integrityBlocked && page.messages.length === 0 ? [] : page.messages
      if (fetchFailed && resolvedMessages.length === 0 && cachedMessages.length > 0) {
        resolvedMessages = [...cachedMessages]
      }
      return {
        kind: 'messages' as const,
        messages: resolvedMessages,
        hasMore: page.pagination.hasMore,
        fetchFailed,
        integrityBlocked,
      }
    },
    hydration: async (signal) => {
      const hydration = await getThreadHydrationForThread(thread, signal, { skipMessages: true, skipDossier: true })
      return {
        kind: 'hydration' as const,
        messages: hydration.messages,
        hasMore: hydration.pagination.hasMore,
        dealContext: hydration.dealContext,
        intelligence: hydration.intelligence as ThreadIntelligenceRecord | null,
      }
    },
    dossier: async (signal) => {
      options.onDossierStart?.()
      const qs = new URLSearchParams()
      if (thread.propertyId) qs.set('property_id', thread.propertyId)
      if (thread.prospectId) qs.set('prospect_id', thread.prospectId)
      if (masterOwnerId) qs.set('master_owner_id', masterOwnerId)
      if (thread.canonicalE164) qs.set('canonical_e164', thread.canonicalE164)
      const threadKey = thread.threadKey || thread.id
      const result = await fetchDealIntelligenceDossier(threadKey, qs.toString(), signal)
      if (!result.ok) return { kind: 'dossier' as const, dealContext: null, intelligence: null }
      const payload = result.data as { ok?: boolean; data?: Record<string, unknown> }
      const data = payload?.data
      return {
        kind: 'dossier' as const,
        dealContext: data ? normalizeDealContext(data) : null,
        intelligence: data as ThreadIntelligenceRecord | null,
      }
    },
    thread_context: async (signal) => {
      const context = await getThreadContext(thread, signal).catch(() => null)
      return { kind: 'thread_context' as const, context }
    },
  }
}

export async function executeThreadSelectFetches(
  plan: ThreadSelectPlan,
  handlers: ThreadSelectFetchHandlers,
  isStillSelected: () => boolean,
  signal: AbortSignal,
  callbacks: ThreadSelectExecutionCallbacks,
): Promise<{ parallelStarted: number; applied: string[]; rejected: string[] }> {
  const kinds = plan.fetches.map((f) => f.kind)
  const applied: string[] = []
  const rejected: string[] = []

  const runKind = async (kind: ThreadSelectFetchKind) => {
    const handler = handlers[kind]
    if (!handler) return
    const kindStarted = performance.now()
    try {
      const result = await handler(signal)
      const still = isStillSelected()
      callbacks.onTelemetry?.({ phase: kind, ms: Math.round(performance.now() - kindStarted), stillSelected: still })
      if (!still) {
        rejected.push(kind)
        return
      }
      switch (result.kind) {
        case 'messages':
          callbacks.onMessages(result)
          applied.push(kind)
          break
        case 'hydration':
          callbacks.onHydration(result)
          applied.push(kind)
          break
        case 'dossier':
          callbacks.onDossier(result)
          applied.push(kind)
          break
        case 'thread_context':
          callbacks.onThreadContext(result)
          applied.push(kind)
          break
        case 'participants':
          callbacks.onParticipants?.(result)
          applied.push(kind)
          break
        default:
          break
      }
    } catch {
      if (!isStillSelected()) rejected.push(kind)
    }
  }

  const otherKinds = kinds.filter((kind) => kind !== 'messages')
  if (kinds.includes('messages')) {
    await runKind('messages')
  }
  if (otherKinds.length > 0) {
    await Promise.all(otherKinds.map((kind) => runKind(kind)))
  }
  return { parallelStarted: kinds.length, applied, rejected }
}