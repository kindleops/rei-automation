/**
 * MULTI-INBOX DATA LAYER — one shared cache for every secondary pane.
 *
 * Why it exists (RC 8.3.2, 2026-10-04): independent per-pane loaders would be a
 * linear N× load on a database that had just fallen over under repeated Inbox
 * reads. So panes never fetch on their own:
 *
 *   - a query is a KEY (lens · search · filters); two panes asking the same
 *     question share one entry and one request (merged, not repeated)
 *   - an identical in-flight request is joined, never re-issued
 *   - at most `maxConcurrent` page reads run at once; the rest queue
 *   - a fresh entry (< ttlMs) is served from cache
 *   - live updates come from the ONE existing Inbox realtime channel (pane 1's
 *     adapter → live-row-signals `onSignalTouched`); a burst of touched threads
 *     becomes ONE trailing re-read of the queries that are on screen, no more
 *     often than `minRefreshMs` — no second subscription forest
 *   - a 60 s safety re-read of mounted queries (the same floor pane 1 keeps)
 *
 * Counts are NOT fetched here: every pane shows pane 1's canonical counts.
 * Rendering a row never writes anything (read state included).
 */
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'

export interface PaneFetchKey {
  /** the live-route filter (bucket) */
  filter: string
  q: string
  /** serialized advanced filters (stable JSON) or '' */
  advanced: string
}

export interface PageResult {
  threads: InboxWorkflowThread[]
  nextCursor: string | null
  hasMore: boolean
  total: number | null
}

export type PageFetcher = (key: PaneFetchKey, cursor: string | null, signal: AbortSignal) => Promise<PageResult>

export interface PaneEntry {
  key: string
  rows: InboxWorkflowThread[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** a load-more or refresh is running while rows are on screen */
  refreshing: boolean
  error: string | null
  nextCursor: string | null
  hasMore: boolean
  total: number | null
  loadedAt: number
}

export interface PaneCacheStats {
  requests: number
  joined: number
  cacheHits: number
  peakInFlight: number
  refreshes: number
}

export function paneKeyOf(key: PaneFetchKey): string {
  return `${key.filter}\u0001${key.q.trim().toLowerCase()}\u0001${key.advanced}`
}

const EMPTY: Omit<PaneEntry, 'key'> = { rows: [], status: 'idle', refreshing: false, error: null, nextCursor: null, hasMore: false, total: null, loadedAt: 0 }

const threadKeyOf = (t: InboxWorkflowThread) => {
  const row = t as unknown as Record<string, unknown>
  return String(t.threadKey ?? row.thread_key ?? t.id ?? '').trim()
}
const tenDigits = (value: string) => {
  const d = value.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

export interface PaneQueryCache {
  get(key: string): PaneEntry
  /** load if absent or stale; returns the in-flight promise when one runs */
  ensure(key: PaneFetchKey): Promise<void> | null
  loadMore(key: PaneFetchKey): Promise<void> | null
  /** mounted queries are kept live; returns a release */
  retain(key: PaneFetchKey): () => void
  subscribe(listener: () => void): () => void
  /** schedule one trailing re-read of mounted queries (realtime burst) */
  invalidateSoon(reason?: string): void
  /** drop threads from every entry at once (e.g. archived), then re-read */
  removeThreads(threadKeys: readonly string[]): void
  stats(): PaneCacheStats
  dispose(): void
}

export function createPaneQueryCache({
  fetchPage,
  ttlMs = 15_000,
  maxConcurrent = 2,
  minRefreshMs = 10_000,
  debounceMs = 3_000,
  safetyMs = 60_000,
  now = () => Date.now(),
  setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clearTimer = (id: number) => clearTimeout(id),
}: {
  fetchPage: PageFetcher
  ttlMs?: number
  maxConcurrent?: number
  minRefreshMs?: number
  debounceMs?: number
  safetyMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}): PaneQueryCache {
  const entries = new Map<string, PaneEntry>()
  const fetchKeys = new Map<string, PaneFetchKey>()
  const inFlight = new Map<string, Promise<void>>()
  const retained = new Map<string, number>()
  const listeners = new Set<() => void>()
  const stats: PaneCacheStats = { requests: 0, joined: 0, cacheHits: 0, peakInFlight: 0, refreshes: 0 }
  const queue: Array<() => void> = []
  let running = 0
  let debounceTimer: number | null = null
  let safetyTimer: number | null = null
  let lastRefreshAt = Number.NEGATIVE_INFINITY

  const emit = () => listeners.forEach((l) => l())
  const put = (key: string, patch: Partial<PaneEntry>) => {
    const prev = entries.get(key) ?? { key, ...EMPTY }
    entries.set(key, { ...prev, ...patch, key })
  }

  const slot = <T,>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const run = () => {
      running += 1
      stats.peakInFlight = Math.max(stats.peakInFlight, running)
      task().then(resolve, reject).finally(() => {
        running -= 1
        const next = queue.shift()
        if (next) next()
      })
    }
    if (running < maxConcurrent) run()
    else queue.push(run)
  })

  const load = (fk: PaneFetchKey, mode: 'replace' | 'append'): Promise<void> => {
    const key = paneKeyOf(fk)
    const flightKey = `${key}\u0002${mode}`
    const existing = inFlight.get(flightKey)
    if (existing) { stats.joined += 1; return existing }
    fetchKeys.set(key, fk)
    const before = entries.get(key) ?? { key, ...EMPTY }
    if (mode === 'append' && !before.nextCursor) return Promise.resolve()
    put(key, before.rows.length ? { refreshing: true, error: null } : { status: 'loading', error: null })
    emit()
    const controller = new AbortController()
    const promise = slot(async () => {
      stats.requests += 1
      const page = await fetchPage(fk, mode === 'append' ? before.nextCursor : null, controller.signal)
      const current = entries.get(key) ?? before
      let rows = page.threads
      if (mode === 'append') {
        const seen = new Set(current.rows.map(threadKeyOf))
        rows = [...current.rows, ...page.threads.filter((t) => !seen.has(threadKeyOf(t)))]
      }
      put(key, { rows, status: 'ready', refreshing: false, error: null, nextCursor: page.nextCursor, hasMore: page.hasMore && Boolean(page.nextCursor), total: page.total, loadedAt: now() })
    }).catch((error: unknown) => {
      // a failed refresh keeps the rows on screen and says so; never a false empty
      put(key, { status: (entries.get(key)?.rows.length ?? 0) > 0 ? 'ready' : 'error', refreshing: false, error: error instanceof Error ? error.message : 'This list did not load' })
    }).finally(() => {
      inFlight.delete(flightKey)
      emit()
    })
    inFlight.set(flightKey, promise)
    return promise
  }

  const refreshMounted = () => {
    lastRefreshAt = now()
    stats.refreshes += 1
    for (const [key, n] of retained) {
      const fk = fetchKeys.get(key)
      if (n > 0 && fk) void load(fk, 'replace')
    }
  }

  const armSafety = () => {
    if (safetyTimer !== null || safetyMs <= 0) return
    safetyTimer = setTimer(() => {
      safetyTimer = null
      if ([...retained.values()].some((n) => n > 0)) {
        refreshMounted()
        armSafety()
      }
    }, safetyMs)
  }

  return {
    get(key) {
      // a stable snapshot per key (useSyncExternalStore needs referential stability)
      let entry = entries.get(key)
      if (!entry) { entry = { key, ...EMPTY }; entries.set(key, entry) }
      return entry
    },
    ensure(fk) {
      const key = paneKeyOf(fk)
      fetchKeys.set(key, fk)
      const entry = entries.get(key)
      const pending = inFlight.get(`${key}\u0002replace`)
      if (pending) { stats.joined += 1; return pending }
      if (entry && entry.status === 'ready' && now() - entry.loadedAt < ttlMs) { stats.cacheHits += 1; return null }
      return load(fk, 'replace')
    },
    loadMore: (fk) => {
      const entry = entries.get(paneKeyOf(fk))
      return entry?.nextCursor ? load(fk, 'append') : null
    },
    retain(fk) {
      const key = paneKeyOf(fk)
      fetchKeys.set(key, fk)
      retained.set(key, (retained.get(key) ?? 0) + 1)
      armSafety()
      let released = false
      return () => {
        if (released) return
        released = true
        const n = (retained.get(key) ?? 1) - 1
        if (n <= 0) retained.delete(key)
        else retained.set(key, n)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    invalidateSoon() {
      if (debounceTimer !== null) clearTimer(debounceTimer)
      const wait = Math.max(debounceMs, minRefreshMs - (now() - lastRefreshAt))
      debounceTimer = setTimer(() => {
        debounceTimer = null
        refreshMounted()
      }, wait)
    },
    removeThreads(threadKeys) {
      const gone = new Set(threadKeys.map((k) => tenDigits(String(k))).filter(Boolean))
      if (!gone.size) return
      for (const [key, entry] of entries) {
        const rows = entry.rows.filter((t) => !gone.has(tenDigits(threadKeyOf(t))))
        if (rows.length !== entry.rows.length) entries.set(key, { ...entry, rows, total: entry.total != null ? Math.max(0, entry.total - (entry.rows.length - rows.length)) : null })
      }
      emit()
      this.invalidateSoon('removed')
    },
    stats: () => ({ ...stats }),
    dispose() {
      if (debounceTimer !== null) clearTimer(debounceTimer)
      if (safetyTimer !== null) clearTimer(safetyTimer)
      listeners.clear()
    },
  }
}
