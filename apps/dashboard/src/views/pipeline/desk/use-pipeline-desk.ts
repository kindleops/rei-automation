/**
 * PIPELINE DESK — data hooks. Read-only.
 *
 * Every read keeps its last good frame while the next one loads (no skeleton
 * flash on refresh), and state is only ever set from an async result, never
 * synchronously inside an effect. Movement that arrives while the page is open
 * is diffed against the previous frame of the SAME query, so a period switch
 * or a filter change never reads as movement.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { fetchPipelineDealStory, fetchPipelineFeed, fetchPipelineOverview, type PipelineCommandParams, type PipelineDealStory } from '../../../domain/pipeline/pipeline-command-api'
import { subscribeToTableChanges } from '../../../lib/data/realtime'
import { fetchDeskFlow, fetchDeskOffers, type DeskCard, type DeskFlow, type DeskMove, type DeskOffers, type DeskOverview, type FlowPeriod } from './pipeline-desk-api'

type Remote<T> = { key: string; data: T | null; error: string | null; at: number }
export type RemoteView<T> = { data: T | null; error: string | null; loading: boolean; stale: boolean; at: number | null; retry: () => void }

const message = (e: unknown) => (e instanceof Error ? e.message : 'failed')

/**
 * One sensible automatic retry for a failed GET (reads are safe to repeat):
 * the first attempt often warms the server's scope memo, so the second lands.
 * After that the error stays on screen with its own Retry.
 */
function useAutoRetry(): (key: string, again: () => void) => void {
  const retried = useRef<Set<string>>(new Set())
  return (key, again) => {
    if (retried.current.has(key)) return
    retried.current.add(key)
    window.setTimeout(again, 2500)
  }
}

/**
 * A keyed GET. `key` encodes every input of `load`; `tick` re-runs it
 * (live refresh). The previous frame stays on screen until the next lands.
 */
function useRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, tick: number): RemoteView<T> {
  const [state, setState] = useState<Remote<T> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const autoRetry = useAutoRetry()
  useEffect(() => {
    if (!key) return
    const c = new AbortController()
    load(c.signal).then(
      (data) => setState({ key, data, error: null, at: Date.now() }),
      (e: unknown) => {
        if (c.signal.aborted) return
        setState((cur) => ({ key, data: cur?.data ?? null, error: message(e), at: cur?.at ?? 0 }))
        autoRetry(key, () => setAttempt((a) => a + 1))
      },
    )
    return () => c.abort()
  }, [key, tick, attempt]) // eslint-disable-line react-hooks/exhaustive-deps -- `key` encodes every input of `load`
  const current = state && state.key === key ? state : null
  return {
    data: state?.data ?? null,
    error: current?.error ?? null,
    loading: !current,
    stale: Boolean(state && state.key !== key),
    at: state?.at || null,
    retry: () => setAttempt((a) => a + 1),
  }
}

/** One refresh clock: realtime changes (coalesced) plus a slow poll. */
export function useLiveTick(enabled = true, pollMs = 60_000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let timer: number | null = null
    const bump = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTick((n) => n + 1), 2000)
    }
    const subs = ['inbox_thread_state', 'message_events'].map((t) => subscribeToTableChanges(t, bump))
    const poll = window.setInterval(() => setTick((n) => n + 1), pollMs)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.clearInterval(poll)
      subs.forEach((s) => s.unsubscribe())
    }
  }, [enabled, pollMs])
  return tick
}

export function useDeskOverview(params: PipelineCommandParams, tick: number): RemoteView<DeskOverview> {
  const key = JSON.stringify(params)
  return useRemote(key, (signal) => fetchPipelineOverview(params, signal) as unknown as Promise<DeskOverview>, tick)
}

export type FlowView = RemoteView<DeskFlow> & { arrivals: DeskMove[]; arrivedAt: number | null }

/**
 * The period flow, with the movement that arrived since the previous frame of
 * the same query (the first frame seeds and never pulses).
 */
export function useDeskFlow(params: PipelineCommandParams, period: FlowPeriod, tick: number): FlowView {
  const key = JSON.stringify({ ...params, period })
  const [state, setState] = useState<(Remote<DeskFlow> & { arrivals: DeskMove[]; arrivedAt: number | null }) | null>(null)
  const [attempt, setAttempt] = useState(0)
  const autoRetry = useAutoRetry()
  useEffect(() => {
    const c = new AbortController()
    fetchDeskFlow({ ...params, period }, c.signal).then(
      (data) => setState((prev) => {
        const sameQuery = prev && prev.key === key && prev.data
        const seen = sameQuery ? new Set(prev!.data!.movement.map((m) => m.id)) : null
        const fresh = seen ? data.movement.filter((m) => !seen.has(m.id) && Date.parse(m.at) > Date.now() - 6 * 3_600_000) : []
        return { key, data, error: null, at: Date.now(), arrivals: fresh, arrivedAt: fresh.length ? Date.now() : (sameQuery ? prev!.arrivedAt : null) }
      }),
      (e: unknown) => {
        if (c.signal.aborted) return
        setState((cur) => ({ key, data: cur?.data ?? null, error: message(e), at: cur?.at ?? 0, arrivals: [], arrivedAt: cur?.arrivedAt ?? null }))
        autoRetry(key, () => setAttempt((a) => a + 1))
      },
    )
    return () => c.abort()
  }, [key, tick, attempt]) // eslint-disable-line react-hooks/exhaustive-deps -- `key` encodes params + period
  const current = state && state.key === key ? state : null
  return {
    data: state?.data ?? null,
    error: current?.error ?? null,
    loading: !current,
    stale: Boolean(state && state.key !== key),
    at: state?.at || null,
    retry: () => setAttempt((a) => a + 1),
    arrivals: current?.arrivals ?? [],
    arrivedAt: current?.arrivedAt ?? null,
  }
}

export function useDeskOffers(params: PipelineCommandParams, enabled: boolean, tick: number): RemoteView<DeskOffers> {
  const key = enabled ? JSON.stringify(params) : null
  return useRemote(key, (signal) => fetchDeskOffers(params, signal), tick)
}

const PAGE = 100
const MAX_PAGES = 8

/** Every deal in scope (dormant included — the views decide what to show). */
export function useDeskRows(params: PipelineCommandParams, tick: number, view: 'all' | 'nurture' | 'archived' = 'all', enabled = true): RemoteView<DeskCard[]> & { total: number; complete: boolean } {
  const key = JSON.stringify({ ...params, view })
  const [state, setState] = useState<(Remote<DeskCard[]> & { total: number; complete: boolean }) | null>(null)
  const [attempt, setAttempt] = useState(0)
  const autoRetry = useAutoRetry()
  useEffect(() => {
    if (!enabled) return
    const c = new AbortController()
    void (async () => {
      try {
        let rows: DeskCard[] = []
        let cursor = 0
        let total = 0
        let complete = false
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const f = await fetchPipelineFeed({ ...params, view, limit: PAGE, cursor: cursor || undefined }, c.signal)
          rows = page === 0 ? (f.rows as unknown as DeskCard[]) : [...rows, ...(f.rows as unknown as DeskCard[])]
          total = f.total
          if (f.nextCursor === null) { complete = true; break }
          cursor = f.nextCursor
        }
        if (!c.signal.aborted) setState({ key, data: rows, error: null, at: Date.now(), total, complete })
      } catch (e) {
        if (!c.signal.aborted) {
          setState((cur) => ({ key, data: cur?.data ?? null, error: message(e), at: cur?.at ?? 0, total: cur?.total ?? 0, complete: cur?.complete ?? false }))
          autoRetry(key, () => setAttempt((a) => a + 1))
        }
      }
    })()
    return () => c.abort()
  }, [key, tick, attempt, enabled]) // eslint-disable-line react-hooks/exhaustive-deps -- `key` encodes params + view
  const current = state && state.key === key ? state : null
  return {
    data: state?.data ?? null,
    error: current?.error ?? null,
    loading: !current,
    stale: Boolean(state && state.key !== key),
    at: state?.at || null,
    retry: () => setAttempt((a) => a + 1),
    total: state?.total ?? 0,
    complete: state?.complete ?? false,
  }
}

export function useDealStory(id: string | null): RemoteView<PipelineDealStory> {
  return useRemote(id, (signal) => fetchPipelineDealStory(id as string, signal), 0)
}

/** The element's inline size, from a ResizeObserver (never the window's). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0)
      setW((cur) => (Math.abs(cur - next) >= 1 ? next : cur))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** A clock for relative times, so "4m ago" stays true without a refetch. */
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

/** Persisted UI choice (localStorage), read once. */
export function usePersistedChoice<T extends string>(storageKey: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = window.localStorage.getItem(storageKey) as T | null
      return v && allowed.includes(v) ? v : fallback
    } catch { return fallback }
  })
  const set = (v: T) => {
    setValue(v)
    try { window.localStorage.setItem(storageKey, v) } catch { /* private mode */ }
  }
  return [value, set]
}

/** Stable id-set of deals that moved in the last 24 h (from the movement read). */
export function useMovedToday(flow: DeskFlow | null, now: number): Set<string> {
  return useMemo(() => {
    const out = new Set<string>()
    for (const m of flow?.movement ?? []) if (now - Date.parse(m.at) < 86_400_000) out.add(m.opportunityId)
    return out
  }, [flow, now])
}
