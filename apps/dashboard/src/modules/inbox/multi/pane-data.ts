/**
 * Production wiring of the Multi-Inbox data layer: one cache per page load,
 * reading the existing live route, fed by the existing Inbox realtime channel.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { fetchLiveInbox } from '../../../lib/data/inboxData'
import { toWorkflowThread } from '../inbox.adapter'
import { onSignalTouched } from '../desk/live-row-signals'
import { lensDef, type DeskLens } from '../desk/ledger-model'
import { serializeInboxFiltersForServer } from '../../../domain/inbox/inbox-filter-catalog-runtime'
import { hasActiveAdvancedFilters } from '../../../domain/inbox/inbox-advanced-filter-engine'
import { createPaneQueryCache, paneKeyOf, type PaneEntry, type PaneFetchKey, type PaneQueryCache } from './pane-query-cache'
import type { PaneQuery } from './multi-inbox-model'
import type { InboxViewSelectValue } from '../inbox-ui-helpers'

export const PANE_PAGE_SIZE = 30

/** The live-route filter for a pane's lens (same aliases the Inbox store uses). */
export function liveFilterForLens(lens: PaneQuery['lens']): string {
  if (lens === 'filtered' || lens === 'all_conversations') return 'all'
  return String(lensDef(lens as DeskLens).view)
}

export function fetchKeyForQuery(query: PaneQuery): PaneFetchKey {
  const filtered = query.lens === 'filtered' || hasActiveAdvancedFilters(query.advanced) || query.stage !== 'all_stages'
  const view = liveFilterForLens(query.lens)
  const advanced = filtered ? serializeInboxFiltersForServer(query.advanced, { stage: query.stage, view: (view === 'all' ? 'all_conversations' : view) as InboxViewSelectValue }) : null
  return { filter: view, q: query.q.trim(), advanced: advanced && Object.keys(advanced).length ? stableJson(advanced) : '' }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

let shared: PaneQueryCache | null = null
let unhookRealtime: (() => void) | null = null

export function getPaneQueryCache(): PaneQueryCache {
  if (shared) return shared
  shared = createPaneQueryCache({
    fetchPage: async (key, cursor, signal) => {
      const res = await fetchLiveInbox({
        filter: key.filter,
        q: key.q,
        cursor,
        limit: PANE_PAGE_SIZE,
        map: false,
        advanced: key.advanced ? JSON.parse(key.advanced) as Record<string, unknown> : undefined,
        timeoutMode: 'auto_refresh',
        refreshReason: 'multi_inbox_pane',
        // counts come from pane 1's canonical counts; never re-read per pane
        skipCounts: true,
        signal,
      })
      const pagination = res.pagination ?? { nextCursor: null, hasMore: false, total: null }
      return {
        threads: (res.threads ?? []).map(toWorkflowThread),
        nextCursor: pagination.nextCursor ?? null,
        hasMore: Boolean(pagination.hasMore),
        total: typeof pagination.total === 'number' ? pagination.total : null,
      }
    },
  })
  // ONE subscription: the existing Inbox channel's touched threads.
  unhookRealtime = onSignalTouched(() => shared?.invalidateSoon('realtime'))
  return shared
}

/** Test seam. */
export function __resetPaneQueryCache() {
  unhookRealtime?.()
  unhookRealtime = null
  shared?.dispose()
  shared = null
}

/** A pane's live view of its query. Mounting retains it; the key change re-reads. */
export function usePaneQuery(query: PaneQuery, enabled = true): { entry: PaneEntry; fetchKey: PaneFetchKey; loadMore: () => Promise<void> | null; retry: () => void } {
  const cache = getPaneQueryCache()
  const fetchKey = useMemo(() => fetchKeyForQuery(query), [query])
  const key = paneKeyOf(fetchKey)
  const entry = useSyncExternalStore(cache.subscribe, () => cache.get(key), () => cache.get(key))
  useEffect(() => {
    if (!enabled || query.lens === 'scheduled') return
    const release = cache.retain(fetchKey)
    void cache.ensure(fetchKey)
    return release
    // the key string is the identity of the question
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, enabled, key, query.lens])
  return {
    entry,
    fetchKey,
    loadMore: () => cache.loadMore(fetchKey),
    retry: () => { void cache.ensure(fetchKey) },
  }
}
