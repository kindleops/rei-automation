import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/**
 * READS — one small external store per request key.
 *
 *  · the first read shows a calm loading state; a later failed read keeps the
 *    last good answer on screen and marks it STALE (never blanks the surface)
 *  · polling is bounded and visibility-aware; a hidden tab slows to a minute
 *  · two surfaces asking for the same key share one request in flight
 *  · switching modes and back is instant: the last answer is still there,
 *    labelled with when it was read
 *
 * React state never changes synchronously inside an effect: the store is
 * external (useSyncExternalStore) and only async reads publish into it.
 */

export interface ResourceState<T> {
  data: T | null
  error: string | null
  at: number | null
  loading: boolean
}

interface Entry {
  snap: ResourceState<unknown>
  listeners: Set<() => void>
  inflight: Promise<void> | null
}

const store = new Map<string, Entry>()
const EMPTY: ResourceState<never> = Object.freeze({ data: null, error: null, at: null, loading: false })

function entry(key: string): Entry {
  let e = store.get(key)
  if (!e) { e = { snap: { data: null, error: null, at: null, loading: false }, listeners: new Set(), inflight: null }; store.set(key, e) }
  return e
}

function publish(key: string, patch: Partial<ResourceState<unknown>>) {
  const e = entry(key)
  e.snap = { ...e.snap, ...patch }
  e.listeners.forEach((l) => l())
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : typeof err === 'string' ? err : 'unavailable') || 'unavailable'

/**
 * Read once (joining a read already in flight for the same key). A shared read
 * is never aborted by one surface unmounting — it lands in the cache.
 */
export function load<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>): Promise<void> {
  const e = entry(key)
  if (e.inflight) return e.inflight
  const ac = new AbortController()
  publish(key, { loading: true })
  e.inflight = fetcher(ac.signal)
    .then((data) => publish(key, { data, error: null, at: Date.now(), loading: false }))
    .catch((err) => {
      if ((err as Error)?.name === 'AbortError') { publish(key, { loading: false }); return }
      publish(key, { error: messageOf(err), loading: false })
    })
    .finally(() => { e.inflight = null })
  return e.inflight
}

/** The last answer for a key, if any (for placeholders while another key loads). */
export function peek<T>(key: string): ResourceState<T> | null {
  const e = store.get(key)
  return e ? (e.snap as ResourceState<T>) : null
}

/** Write an answer read elsewhere (e.g. a page fetched by the runs ledger). */
export function prime<T>(key: string, data: T) { publish(key, { data, error: null, at: Date.now(), loading: false }) }

export interface UseResourceOptions {
  /** poll cadence; null = read once per key */
  interval?: number | null
  /** while this key has no answer yet, show the answer of another key (marked placeholder) */
  placeholderKey?: string | null
  /** an answer younger than this is not re-read on mount (ms) */
  fresh?: number
}

export function useResource<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, { interval = null, placeholderKey = null, fresh = 4_000 }: UseResourceOptions = {}) {
  const fetchRef = useRef(fetcher)
  useLayoutEffect(() => { fetchRef.current = fetcher })

  const subscribe = useCallback((cb: () => void) => {
    if (!key) return () => undefined
    const e = entry(key)
    e.listeners.add(cb)
    return () => { e.listeners.delete(cb) }
  }, [key])
  const snap = useSyncExternalStore(subscribe, () => (key ? (entry(key).snap as ResourceState<T>) : EMPTY))
  const placeholder = useSyncExternalStore(
    useCallback((cb: () => void) => {
      if (!placeholderKey) return () => undefined
      const e = entry(placeholderKey)
      e.listeners.add(cb)
      return () => { e.listeners.delete(cb) }
    }, [placeholderKey]),
    () => (placeholderKey ? (entry(placeholderKey).snap as ResourceState<T>) : EMPTY),
  )

  useEffect(() => {
    if (!key) return
    const ac = new AbortController()
    let timer = 0
    const tick = () => {
      void load(key, (s) => fetchRef.current(s)).then(() => {
        if (ac.signal.aborted || !interval) return
        timer = window.setTimeout(tick, document.visibilityState === 'visible' ? interval : Math.max(interval, 60_000))
      })
    }
    const at = entry(key).snap.at
    const wait = at && Date.now() - at < fresh ? Math.max(0, (interval ?? fresh) - (Date.now() - at)) : 0
    if (wait > 0 && interval) timer = window.setTimeout(tick, wait)
    else if (wait === 0) tick()
    const onVisible = () => { if (document.visibilityState === 'visible' && interval) { window.clearTimeout(timer); tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { ac.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [key, interval, fresh])

  const reload = useCallback(() => { if (key) void load(key, (s) => fetchRef.current(s)) }, [key])
  const usePlaceholder = !snap.data && Boolean(placeholder.data)
  return {
    data: (snap.data ?? (usePlaceholder ? placeholder.data : null)) as T | null,
    placeholder: usePlaceholder,
    error: snap.error,
    /** an answer is on screen but the latest read failed */
    stale: Boolean(snap.data && snap.error),
    at: snap.at,
    loading: !snap.data && !snap.error,
    refreshing: snap.loading,
    reload,
  }
}

/**
 * Subscribe to a key's answers (for effects that react to NEW data — pulses,
 * arrival highlights). The callback runs outside render; setting state in it
 * is a subscription update, not a cascading effect.
 */
export function subscribeKey<T>(key: string, cb: (state: ResourceState<T>) => void): () => void {
  const e = entry(key)
  const l = () => cb(e.snap as ResourceState<T>)
  e.listeners.add(l)
  return () => { e.listeners.delete(l) }
}
