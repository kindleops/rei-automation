import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * War room hooks. Written for the React Compiler rules: nothing impure in
 * render (the clock is an external store), no synchronous setState in an
 * effect body (loading is derived from "the key I have" vs "the key I
 * want"), no ref reads in render.
 */

/* ── clock ─────────────────────────────────────────────────────────────── */

type Clock = { subscribe: (cb: () => void) => () => void; get: () => number }

function makeClock(ms: number): Clock {
  let now = Date.now()
  let timer = 0
  const subs = new Set<() => void>()
  return {
    subscribe(cb) {
      subs.add(cb)
      if (!timer) {
        now = Date.now()
        timer = window.setInterval(() => { now = Date.now(); subs.forEach((s) => s()) }, ms)
      }
      return () => {
        subs.delete(cb)
        if (!subs.size) { window.clearInterval(timer); timer = 0 }
      }
    },
    get: () => now,
  }
}

/** Seconds — countdowns ("in 38s"). Mount it only in the small leaf that shows one. */
export const SECOND_CLOCK = makeClock(1_000)
/** Half-minutes — state that depends on the time (window open, overdue). */
export const COARSE_CLOCK = makeClock(30_000)

/** The current time from a shared clock, re-rendering on its tick while mounted. */
export function useNow(clock: Clock = COARSE_CLOCK): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get)
}

/* ── resources ─────────────────────────────────────────────────────────── */

type Entry<T> = { data: T; at: number }
const caches = new Map<string, Map<string, Entry<unknown>>>()

function cacheFor<T>(name: string): Map<string, Entry<T>> {
  let c = caches.get(name)
  if (!c) { c = new Map(); caches.set(name, c) }
  return c as Map<string, Entry<T>>
}

export type Resource<T> = {
  data: T | null
  /** the data is for an earlier poll of the same key (refreshing) or another key (switching) */
  stale: boolean
  loading: boolean
  error: string | null
  at: number | null
  refresh: () => void
}

/**
 * Load `fetcher(key)` whenever the key changes, poll it while the page is
 * visible, and keep the last good answer per key so switching back is
 * instant. A failed refresh keeps the last good data on screen and says so.
 */
export function useResource<T>(
  name: string,
  key: string | null,
  fetcher: (key: string, signal: AbortSignal) => Promise<T>,
  { pollMs = 0, enabled = true }: { pollMs?: number; enabled?: boolean } = {},
): Resource<T> {
  const cache = cacheFor<T>(name)
  const [state, setState] = useState<{ key: string | null; data: T | null; at: number | null; error: string | null; errorKey: string | null }>(() => {
    const hit = key ? cache.get(key) : undefined
    return { key: hit ? key : null, data: hit ? hit.data : null, at: hit ? hit.at : null, error: null, errorKey: null }
  })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!key || !enabled) return
    const ctl = new AbortController()
    fetcher(key, ctl.signal).then(
      (data) => {
        if (ctl.signal.aborted) return
        const at = Date.now()
        cache.set(key, { data, at })
        setState({ key, data, at, error: null, errorKey: null })
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return
        const message = err instanceof Error && err.message ? err.message : 'unavailable'
        setState((s) => ({ ...s, error: message, errorKey: key }))
      },
    )
    return () => ctl.abort()
  }, [key, tick, enabled, fetcher, cache])

  useEffect(() => {
    if (!key || !enabled || !pollMs) return
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') setTick((n) => n + 1) }, pollMs)
    return () => window.clearInterval(id)
  }, [key, enabled, pollMs])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const mine = state.key === key
  const cached = !mine && key ? cache.get(key) ?? null : null
  const data = mine ? state.data : cached ? cached.data : null
  const error = state.errorKey === key ? state.error : null
  return {
    data,
    stale: !mine && cached !== null,
    loading: Boolean(key) && enabled && !mine && !error,
    error,
    at: mine ? state.at : cached ? cached.at : null,
    refresh,
  }
}

/* ── measuring ─────────────────────────────────────────────────────────── */

/** An element's content width, from a ResizeObserver (0 until measured). */
export function useWidth<E extends HTMLElement>(): [React.RefObject<E>, number] {
  const ref = useRef<E>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/**
 * Remembers the previous value of `v` across renders and reports whether it
 * increased — the trigger for one restrained pulse when real counts rise.
 * Returns a key that changes only when the value goes up.
 */
export function useRiseKey(v: number | null | undefined): number {
  const [state, setState] = useState<{ last: number | null; key: number }>({ last: v ?? null, key: 0 })
  if ((v ?? null) !== state.last) {
    const rose = v !== null && v !== undefined && state.last !== null && v > state.last
    setState({ last: v ?? null, key: rose ? state.key + 1 : state.key })
  }
  return state.key
}
