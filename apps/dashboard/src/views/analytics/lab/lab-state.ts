/**
 * ANALYTICS LAB — the analytical context as state.
 *
 * The context (range, comparison, grain, filters, breadcrumb, group-by, mode,
 * metric) lives in the URL as `?lab=<base64url JSON>` so a link restores the
 * exact analysis. In a SECONDARY split pane the URL belongs to the main pane:
 * the Lab reads its pane's location once and keeps state locally (replace is
 * never intercepted for panes, so writing would hijack the main pane).
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { PaneRouteContext, replaceRoutePath, useRouteLocation } from '../../../app/router'
import type { LabContext, LabFilter, LabMode, LabSegmentStep } from '../../../domain/analytics/analytics-lab-api'
import { decodeB64Url, encodeB64Url } from '../../../domain/analytics/analytics-lab-api'

const STORE = 'anx:lab:ctx:v1'
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' } }

export const DEFAULT_CONTEXT: LabContext = {
  v: 1, tz: 'America/Chicago', mode: 'overview', metric: 'reply_rate', groupBy: null,
  filters: [], segment: [], range: { preset: '30d' }, compare: { mode: 'previous' }, grain: 'auto',
}

function sanitize(raw: Partial<LabContext> | null | undefined): LabContext {
  const c = raw || {}
  return {
    ...DEFAULT_CONTEXT,
    ...c,
    v: 1,
    tz: typeof c.tz === 'string' && c.tz ? c.tz : localTz(),
    filters: Array.isArray(c.filters) ? c.filters.slice(0, 24) : [],
    segment: Array.isArray(c.segment) ? c.segment.slice(0, 8) : [],
    range: c.range && typeof c.range === 'object' ? c.range : DEFAULT_CONTEXT.range,
    compare: c.compare && typeof c.compare === 'object' ? c.compare : DEFAULT_CONTEXT.compare,
  }
}

export function readContext(location: string): LabContext {
  const q = location.includes('?') ? location.slice(location.indexOf('?') + 1) : ''
  const lab = new URLSearchParams(q).get('lab')
  if (lab) {
    const decoded = decodeB64Url<Partial<LabContext>>(lab)
    if (decoded) return sanitize(decoded)
  }
  try {
    const stored = localStorage.getItem(STORE)
    if (stored) return sanitize(JSON.parse(stored))
  } catch { /* private mode */ }
  return sanitize({ tz: localTz() })
}

export const contextKey = (c: LabContext) => JSON.stringify([c.tz, c.mode, c.metric, c.groupBy, c.filters, c.segment, c.range, c.compare, c.grain])

export type LabActions = {
  set: (patch: Partial<LabContext> | ((c: LabContext) => Partial<LabContext>)) => void
  addFilter: (f: LabFilter) => void
  removeFilter: (index: number) => void
  pushSegment: (s: LabSegmentStep) => void
  popSegmentTo: (depth: number) => void
  setMode: (m: LabMode) => void
}

export function useLabContext(): [LabContext, LabActions, { inPane: boolean }] {
  const pane = useContext(PaneRouteContext)
  const location = useRouteLocation()
  const [ctx, setCtx] = useState<LabContext>(() => readContext(pane ? pane.location : location))
  const lastWritten = useRef<string>('')

  // back / forward in the main pane: follow the URL
  useEffect(() => {
    if (pane) return
    const next = readContext(location)
    if (contextKey(next) !== contextKey(ctx) && lastWritten.current !== location) setCtx(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, pane])

  // mirror into the URL (main pane only) and remember locally
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(ctx)) } catch { /* ignore */ }
    if (pane) return
    const t = window.setTimeout(() => {
      const href = `/analytics?lab=${encodeB64Url(ctx)}`
      if (`${window.location.pathname}${window.location.search}` === href) return
      if (!window.location.pathname.startsWith('/analytics')) return
      lastWritten.current = href
      replaceRoutePath(href)
    }, 180)
    return () => window.clearTimeout(t)
  }, [ctx, pane])

  const set = useCallback<LabActions['set']>((patch) => setCtx((c) => sanitize({ ...c, ...(typeof patch === 'function' ? patch(c) : patch) })), [])
  const actions: LabActions = {
    set,
    addFilter: (f) => set((c) => ({ filters: [...c.filters.filter((x) => !(x.field === f.field && x.op === f.op)), f] })),
    removeFilter: (i) => set((c) => ({ filters: c.filters.filter((_, k) => k !== i) })),
    pushSegment: (s) => set((c) => ({ segment: [...c.segment.filter((x) => x.dim !== s.dim), s] })),
    popSegmentTo: (depth) => set((c) => ({ segment: c.segment.slice(0, depth) })),
    setMode: (m) => set({ mode: m }),
  }
  return [ctx, actions, { inPane: Boolean(pane) }]
}

/** Fetch with abort + stale-while-revalidate: the previous result stays on screen while the next loads. */
export function useLabData<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; key: string | null }>({ data: null, error: null, loading: Boolean(key), key: null })
  const [nonce, setNonce] = useState(0)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  useEffect(() => {
    if (!key) { setState({ data: null, error: null, loading: false, key: null }); return }
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    fetchRef.current(ctl.signal)
      .then((data) => { if (!ctl.signal.aborted) setState({ data, error: null, loading: false, key }) })
      .catch((e) => { if (!ctl.signal.aborted) setState((s) => ({ ...s, error: String(e?.message || e), loading: false })) })
    return () => ctl.abort()
  }, [key, nonce])
  return { ...state, reload: () => setNonce((n) => n + 1) }
}

/** Width of an element (container-query-like decisions inside charts). */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect()
    if (!el) return
    ro.current = new ResizeObserver((entries) => { const cr = entries[0]?.contentRect; if (cr) setW(Math.round(cr.width)) })
    ro.current.observe(el)
    setW(Math.round(el.getBoundingClientRect().width))
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  return [ref, w]
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
