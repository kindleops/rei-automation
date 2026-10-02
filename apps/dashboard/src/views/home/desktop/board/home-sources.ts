import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { HomeLoad } from '../../home-signals'

/**
 * HOME DATA SOURCES — one shared, visibility-aware cache for every widget.
 *
 *   SHARED     two widgets reading the same thing (two Inbox widgets, three
 *              Analytics widgets on the same period) make ONE request
 *   LAZY       a source loads only while at least one widget reading it is
 *              on screen and the document is visible; offscreen widgets keep
 *              their last value and do not poll
 *   CADENCE    a source refreshes at the shortest cadence among the widgets
 *              actively reading it — never "poll everything"
 *   EVENTS     the Command Rail's ledger events (already polled once for the
 *              whole shell) refresh the sources of the app they belong to,
 *              early, debounced
 *   ISOLATED   a failed read keeps the last good value; a source that never
 *              loaded says why, and only its widgets show it
 */

type Loader<T> = (signal: AbortSignal) => Promise<T>

interface Sub { everyMs: number; active: boolean }

interface Entry {
  key: string
  state: HomeLoad<unknown>
  loader: Loader<unknown>
  apps: readonly string[]
  subs: Map<number, Sub>
  inflight: AbortController | null
  lastAt: number
  timer: ReturnType<typeof setTimeout> | null
  listeners: Set<() => void>
}

const entries = new Map<string, Entry>()
const TIMEOUT_MS = 45_000
const EVENT_DEBOUNCE_MS = 8_000
let subSeq = 0
const stats = { requests: 0, failures: 0, eventRefreshes: 0 }

const docVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

function entryFor(key: string, loader: Loader<unknown>, apps: readonly string[]): Entry {
  let e = entries.get(key)
  if (!e) {
    e = { key, state: { status: 'loading' }, loader, apps, subs: new Map(), inflight: null, lastAt: 0, timer: null, listeners: new Set() }
    entries.set(key, e)
  } else {
    e.loader = loader
    if (apps.length) e.apps = Array.from(new Set([...e.apps, ...apps]))
  }
  return e
}

const activeSubs = (e: Entry) => [...e.subs.values()].filter((s) => s.active)
const cadenceOf = (e: Entry) => Math.min(...activeSubs(e).map((s) => s.everyMs))

function emit(e: Entry) { e.listeners.forEach((l) => l()) }

function load(e: Entry) {
  if (e.inflight) return
  const ctl = new AbortController()
  e.inflight = ctl
  stats.requests += 1
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  e.loader(ctl.signal).then(
    (data) => {
      clearTimeout(timer)
      e.inflight = null
      e.lastAt = Date.now()
      e.state = { status: 'ready', data, at: e.lastAt }
      emit(e)
      schedule(e)
    },
    (error: unknown) => {
      clearTimeout(timer)
      e.inflight = null
      e.lastAt = Date.now()
      stats.failures += 1
      // a failed refresh never blanks what the operator is reading
      if (e.state.status !== 'ready') {
        e.state = { status: 'unavailable', reason: ctl.signal.aborted ? 'Timed out' : error instanceof Error ? error.message : 'Unavailable' }
        emit(e)
      }
      schedule(e)
    },
  )
}

function schedule(e: Entry) {
  if (e.timer) { clearTimeout(e.timer); e.timer = null }
  if (!activeSubs(e).length || !docVisible()) return
  const every = cadenceOf(e)
  const due = Math.max(0, e.lastAt + every - Date.now())
  e.timer = setTimeout(() => { e.timer = null; if (activeSubs(e).length && docVisible()) load(e) }, due)
}

/** Bring a source current for an active reader: load now if never loaded or stale, else wait for its cadence. */
function wake(e: Entry) {
  if (!activeSubs(e).length || !docVisible()) { schedule(e); return }
  const stale = !e.lastAt || Date.now() - e.lastAt >= cadenceOf(e)
  if (stale || e.state.status !== 'ready') load(e)
  else schedule(e)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { for (const e of entries.values()) wake(e) })
}

/**
 * Read a source. `key` identifies the data (same key = same request); `null`
 * reads nothing. `active` is the widget's visibility; `everyMs` its cadence.
 */
export function useHomeSource<T>(key: string | null, loader: Loader<T>, opts: { everyMs: number; active: boolean; apps?: readonly string[] }): { load: HomeLoad<T>; reload: () => void } {
  const [subId] = useState(() => ++subSeq)
  const loaderRef = useRef(loader)
  useEffect(() => { loaderRef.current = loader })
  const apps = opts.apps ?? EMPTY_APPS
  const appsKey = apps.join(',')

  useEffect(() => {
    if (!key) return
    const e = entryFor(key, (signal) => loaderRef.current(signal), appsKey ? appsKey.split(',') : [])
    e.subs.set(subId, { everyMs: Math.max(10_000, opts.everyMs), active: opts.active })
    wake(e)
    const mine = subId
    return () => {
      e.subs.delete(mine)
      if (!e.subs.size) {
        if (e.timer) clearTimeout(e.timer)
        e.timer = null
        // keep the value for a quick return; drop the entry later if nobody comes back
        setTimeout(() => { if (!e.subs.size && entries.get(key) === e) { e.inflight?.abort(); entries.delete(key) } }, 5 * 60_000)
      } else {
        schedule(e)
      }
    }
  }, [key, opts.everyMs, opts.active, appsKey, subId])

  const subscribe = useCallback((l: () => void) => {
    if (!key) return () => {}
    const e = entryFor(key, (signal) => loaderRef.current(signal), [])
    e.listeners.add(l)
    return () => { e.listeners.delete(l) }
  }, [key])
  const getSnapshot = useCallback(() => (key ? entries.get(key)?.state ?? LOADING : IDLE), [key])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as HomeLoad<T>

  const reload = useCallback(() => {
    const e = key ? entries.get(key) : null
    if (!e) return
    if (e.state.status === 'unavailable') { e.state = { status: 'loading' }; emit(e) }
    load(e)
  }, [key])

  return { load: state, reload }
}

const EMPTY_APPS: readonly string[] = []
const LOADING: HomeLoad<unknown> = { status: 'loading' }
const IDLE: HomeLoad<unknown> = { status: 'unavailable', reason: 'Not configured' }

/** A ledger event arrived for these apps (rail routes like '/inbox'): refresh their active sources early. */
export function refreshForApps(apps: readonly string[]) {
  const set = new Set(apps)
  for (const e of entries.values()) {
    if (!e.apps.some((a) => set.has(a))) continue
    if (!activeSubs(e).length || Date.now() - e.lastAt < EVENT_DEBOUNCE_MS) continue
    stats.eventRefreshes += 1
    load(e)
  }
}

/** Refresh every source a visible widget reads (the board's Refresh). */
export function refreshAllSources() {
  for (const e of entries.values()) if (activeSubs(e).length) load(e)
}

/** Measurement seam (performance pass): requests made, failures, entries live. */
export function homeSourceStats() {
  return { ...stats, entries: entries.size, active: [...entries.values()].filter((e) => activeSubs(e).length).length }
}
