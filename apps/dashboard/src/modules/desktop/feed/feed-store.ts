import { useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import { appendPage, buildQuery, DEFAULT_FILTERS, mergeTail, tailSince, type EventsResponse, type FeedFilters, type PlatformEvent } from './feed-model'

/**
 * THE MACHINE FEED — store. One read of the event envelope, then a live tail
 * every ~15 s while the feed is on screen (paused when the window is hidden).
 * New rows land at the top only while the operator is AT the top; scrolled into
 * history, they wait behind an "N new" pill — the list never moves under them.
 */

export const TAIL_MS = 15_000
const PATH = '/api/cockpit/platform/events'

export interface FeedState {
  filters: FeedFilters
  status: 'idle' | 'loading' | 'ready' | 'error'
  events: PlatformEvent[]
  /** rows that arrived while the operator was reading history */
  pending: PlatformEvent[]
  fresh: ReadonlySet<string>
  cursor: string | null
  loadingMore: boolean
  meta: Pick<EventsResponse, 'sources' | 'degraded' | 'generated_at'> | null
  error: string | null
  atTop: boolean
  updatedAt: number | null
}

let state: FeedState = { filters: DEFAULT_FILTERS, status: 'idle', events: [], pending: [], fresh: new Set(), cursor: null, loadingMore: false, meta: null, error: null, atTop: true, updatedAt: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<FeedState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()) }
let gen = 0
let attached = 0
let timer: number | null = null
let tailing = false

async function read(qs: string): Promise<EventsResponse | string> {
  const res = await callBackend<EventsResponse>(`${PATH}?${qs}`, { timeoutMs: 45_000 })
  if (!res.ok) return res.status === 400 ? (res.message || 'That filter is not available.') : 'Machine activity could not be read right now.'
  const data = res.data as EventsResponse | undefined
  return data?.ok ? data : 'Machine activity could not be read right now.'
}

export async function loadFeed() {
  const g = ++gen
  set({ status: 'loading', error: null, pending: [], fresh: new Set() })
  const r = await read(buildQuery(state.filters, { now: Date.now() }))
  if (g !== gen) return
  if (typeof r === 'string') { set({ status: 'error', error: r }); return }
  set({ status: 'ready', events: r.events, cursor: r.next_cursor, meta: { sources: r.sources, degraded: r.degraded, generated_at: r.generated_at }, updatedAt: Date.now() })
}

export async function loadMore() {
  if (!state.cursor || state.loadingMore) return
  const g = gen
  set({ loadingMore: true })
  const r = await read(buildQuery(state.filters, { now: Date.now(), cursor: state.cursor }))
  if (g !== gen) return
  if (typeof r === 'string') { set({ loadingMore: false, error: r }); return }
  set({ loadingMore: false, events: appendPage(state.events, r.events), cursor: r.next_cursor })
}

async function tail() {
  if (tailing || state.status !== 'ready' || document.visibilityState === 'hidden') return
  tailing = true
  const g = gen
  try {
    const shown = state.pending.length ? [...state.pending, ...state.events] : state.events
    const r = await read(buildQuery(state.filters, { now: Date.now(), tailSince: tailSince(shown, Date.now()), limit: 100 }))
    if (g !== gen || typeof r === 'string') return
    // a stale head (sleep, lost connection) is never replayed as live: quietly re-read page one
    if (r.replay_suppressed) { void loadFeed(); return }
    const meta = { sources: r.sources, degraded: r.degraded, generated_at: r.generated_at }
    if (state.atTop) {
      const m = mergeTail([...state.pending, ...state.events], r.events)
      set({ events: m.events, pending: [], fresh: new Set(m.added), meta, updatedAt: Date.now() })
    } else {
      const inView = new Set(state.events.map((e) => e.event_id))
      const updated = mergeTail(state.events, r.events.filter((e) => inView.has(e.event_id))).events
      const pending = mergeTail(state.pending, r.events.filter((e) => !inView.has(e.event_id))).events
      set({ events: updated, pending, meta, updatedAt: Date.now() })
    }
  } finally { tailing = false }
}

function schedule() {
  if (timer !== null) window.clearTimeout(timer)
  timer = attached > 0 ? window.setTimeout(async () => { await tail(); schedule() }, TAIL_MS) : null
}

/** Mount: the feed reads (first time or after a while) and tails while on screen. */
export function attachFeed(): () => void {
  attached++
  if (state.status === 'idle' || state.status === 'error' || (state.updatedAt && Date.now() - state.updatedAt > 10 * 60_000)) void loadFeed()
  else void tail()
  schedule()
  return () => { attached = Math.max(0, attached - 1); schedule() }
}

export function setFeedFilters(patch: Partial<FeedFilters>) {
  set({ filters: { ...state.filters, ...patch } })
  void loadFeed()
}

export function setFeedAtTop(atTop: boolean) {
  if (atTop === state.atTop) return
  if (atTop && state.pending.length) {
    const m = mergeTail(state.events, state.pending)
    set({ atTop, events: m.events, pending: [], fresh: new Set(m.added) })
  } else set({ atTop })
}

/** "N new" pill: bring the waiting rows in (the caller scrolls to the top). */
export function revealPending() {
  const m = mergeTail(state.events, state.pending)
  set({ events: m.events, pending: [], fresh: new Set(m.added), atTop: true })
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useFeed = () => useSyncExternalStore(subscribe, () => state, () => state)

/** Test seam. */
export const __feedTest = { reset: () => { gen++; state = { filters: DEFAULT_FILTERS, status: 'idle', events: [], pending: [], fresh: new Set(), cursor: null, loadingMore: false, meta: null, error: null, atTop: true, updatedAt: null } }, read: () => state, tail }
