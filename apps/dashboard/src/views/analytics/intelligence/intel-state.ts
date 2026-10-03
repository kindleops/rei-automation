/**
 * ANALYTICS 4.0 — the ONE analytical query state.
 *
 * Range, comparison, grain, filters, the breadcrumb (geography → campaign →
 * sender …, plus a seller cohort), the hero metric, its group-by, the view
 * and the lens all live in one object, mirrored into the URL as
 * `?lab=<base64url JSON>` so a link restores the exact analysis. Simple
 * handoff params are honoured on arrival — `/analytics?metric=reply_rate`,
 * `&lens=pipeline`, `&range=90d`, `&market=minneapolis-mn` — which is how
 * Home opens a metric here.
 *
 * In a SECONDARY split pane the URL belongs to the main pane: the Lab reads
 * its pane's location once and keeps state locally (writing would hijack the
 * main pane's address).
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { PaneRouteContext, replaceRoutePath, useRouteLocation } from '../../../app/router'
import type { LabCompareMode, LabContext, LabFilter, LabGrain, LabRangePreset, LabSegmentStep } from '../../../domain/analytics/analytics-lab-api'
import { decodeB64Url, encodeB64Url } from '../../../domain/analytics/analytics-lab-api'

export type Lens = 'overview' | 'acquisition' | 'pipeline' | 'campaigns' | 'communications' | 'geography' | 'automation' | 'financial' | 'buyers' | 'growth' | 'goals'
export type ChartView = 'line' | 'bars' | 'table'

export const LENSES: ReadonlyArray<{ key: Lens; label: string; short: string; question: string }> = [
  { key: 'overview', label: 'Overview', short: 'Overview', question: 'How is the machine performing?' },
  { key: 'acquisition', label: 'Acquisition', short: 'Acquisition', question: 'What is producing real opportunities?' },
  { key: 'pipeline', label: 'Pipeline', short: 'Pipeline', question: 'Where are deals getting stuck?' },
  { key: 'campaigns', label: 'Campaigns', short: 'Campaigns', question: 'Which campaign caused it?' },
  { key: 'communications', label: 'Communications', short: 'Comms', question: 'Where is delivery failing?' },
  { key: 'geography', label: 'Geography', short: 'Geography', question: 'Where is seller interest strongest?' },
  { key: 'automation', label: 'Automation', short: 'Automation', question: 'How autonomous is the system?' },
  { key: 'financial', label: 'Financial', short: 'Money', question: 'What is producing money?' },
  { key: 'buyers', label: 'Buyers', short: 'Buyers', question: 'Where is buyer demand strongest?' },
  { key: 'growth', label: 'Growth', short: 'Growth', question: 'What do outside sources say?' },
  { key: 'goals', label: 'Goals', short: 'Goals', question: 'Are we on pace for the targets we set?' },
]
const LENS_KEYS = new Set<string>(LENSES.map((l) => l.key))
const RANGE_KEYS = new Set<string>(['today', '7d', '30d', '90d', 'ytd', 'custom'])
const COMPARE_KEYS = new Set<string>(['previous', 'week', 'month', 'year', 'custom', 'none'])

export type IntelContext = {
  v: 1
  tz: string
  lens: Lens
  metric: string
  groupBy: string | null
  view: ChartView
  filters: LabFilter[]
  segment: LabSegmentStep[]
  range: { preset: LabRangePreset; start?: string; end?: string }
  compare: { mode: LabCompareMode; start?: string; end?: string }
  grain: LabGrain
}

const STORE = 'anx:intel:ctx:v1'
export const HISTORY_START = '2026-04-18'
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' } }

export const DEFAULT_CONTEXT: IntelContext = {
  v: 1, tz: 'America/Chicago', lens: 'overview', metric: 'reply_rate', groupBy: null, view: 'line',
  filters: [], segment: [], range: { preset: '30d' }, compare: { mode: 'previous' }, grain: 'auto',
}

type RawContext = Partial<IntelContext> & { mode?: string }

/** Defensive normalisation of anything read from a URL or storage. */
export function sanitize(raw: RawContext | null | undefined, tz = localTz()): IntelContext {
  const c = raw || {}
  const lens = (typeof c.lens === 'string' && LENS_KEYS.has(c.lens) ? c.lens : typeof c.mode === 'string' && LENS_KEYS.has(c.mode) ? c.mode : 'overview') as Lens
  const range = c.range && typeof c.range === 'object' && RANGE_KEYS.has(String(c.range.preset)) ? c.range : DEFAULT_CONTEXT.range
  const compare = c.compare && typeof c.compare === 'object' && COMPARE_KEYS.has(String(c.compare.mode)) ? c.compare : DEFAULT_CONTEXT.compare
  return {
    v: 1,
    tz: typeof c.tz === 'string' && c.tz ? c.tz : tz,
    lens,
    metric: typeof c.metric === 'string' && c.metric ? c.metric.slice(0, 64) : DEFAULT_CONTEXT.metric,
    groupBy: typeof c.groupBy === 'string' && c.groupBy ? c.groupBy.slice(0, 64) : null,
    view: c.view === 'bars' || c.view === 'table' ? c.view : 'line',
    filters: Array.isArray(c.filters) ? c.filters.slice(0, 24) : [],
    segment: Array.isArray(c.segment) ? c.segment.slice(0, 8) : [],
    range: range as IntelContext['range'],
    compare: compare as IntelContext['compare'],
    grain: (['auto', 'hour', 'day', 'week', 'month'] as string[]).includes(String(c.grain)) ? (c.grain as LabGrain) : 'auto',
  }
}

/** Context from a location string (`/analytics?lab=…&metric=…`), else storage, else defaults. */
export function readContext(location: string, stored: string | null = null, tz = localTz()): IntelContext {
  const q = new URLSearchParams(location.includes('?') ? location.slice(location.indexOf('?') + 1) : '')
  let base: IntelContext | null = null
  const lab = q.get('lab')
  if (lab) { const decoded = decodeB64Url<RawContext>(lab); if (decoded) base = sanitize(decoded, tz) }
  if (!base && stored) { try { base = sanitize(JSON.parse(stored), tz) } catch { base = null } }
  const ctx = base || sanitize({ tz }, tz)
  // simple handoff params win over whatever was there (Home → "metric=reply_rate")
  const metric = q.get('metric')
  const lens = q.get('lens') || q.get('mode')
  const range = q.get('range')
  const market = q.get('market')
  const compare = q.get('compare')
  return sanitize({
    ...ctx,
    ...(metric ? { metric } : null),
    ...(lens && LENS_KEYS.has(lens) ? { lens: lens as Lens } : null),
    ...(range && RANGE_KEYS.has(range) && range !== 'custom' ? { range: { preset: range as LabRangePreset }, grain: 'auto' as LabGrain } : null),
    ...(compare && COMPARE_KEYS.has(compare) && compare !== 'custom' ? { compare: { mode: compare as LabCompareMode } } : null),
    ...(market ? { segment: [...ctx.segment.filter((s) => s.dim !== 'market'), { dim: 'market', value: market, label: q.get('market_label') || null }] } : null),
  }, tz)
}

/** The context the SERVER reads: the lens is a client concern (the engine computes the same numbers for every lens). */
export function serverContext(ctx: IntelContext, over: Partial<LabContext> & { metrics?: string[]; limit?: number } = {}): LabContext & { metrics?: string[] } {
  return {
    v: 1, tz: ctx.tz, mode: 'overview', metric: ctx.metric, groupBy: ctx.groupBy, filters: ctx.filters, segment: ctx.segment,
    range: ctx.range, compare: ctx.compare, grain: ctx.grain, ...over,
  }
}

/** A stable identity for everything that changes the numbers (not the lens, view or hero metric). */
export const sliceKey = (c: IntelContext) => JSON.stringify([c.tz, c.filters, c.segment, c.range, c.compare, c.grain])

export const urlFor = (ctx: IntelContext) => `/analytics?lab=${encodeB64Url(ctx)}`

export type IntelActions = {
  set: (patch: Partial<IntelContext> | ((c: IntelContext) => Partial<IntelContext>)) => void
  setLens: (lens: Lens) => void
  setMetric: (id: string, opts?: { groupBy?: string | null }) => void
  setRange: (preset: LabRangePreset, custom?: { start: string; end: string }) => void
  setCompare: (mode: LabCompareMode, custom?: { start: string; end: string }) => void
  addFilter: (f: LabFilter & { labels?: string[] }) => void
  removeFilter: (index: number) => void
  pushSegment: (s: LabSegmentStep) => void
  removeSegment: (index: number) => void
  popSegmentTo: (depth: number) => void
  setCohort: (key: string | null, label?: string) => void
  clearSlice: () => void
}

export function makeActions(set: IntelActions['set']): IntelActions {
  return {
    set,
    setLens: (lens) => set({ lens }),
    setMetric: (id, opts) => set((c) => ({ metric: id, groupBy: opts && 'groupBy' in opts ? opts.groupBy ?? null : c.groupBy })),
    setRange: (preset, custom) => set(preset === 'custom' && custom ? { range: { preset, start: custom.start, end: custom.end }, grain: 'auto' } : { range: { preset }, grain: 'auto' }),
    setCompare: (mode, custom) => set({ compare: mode === 'custom' && custom ? { mode, start: custom.start, end: custom.end } : { mode } }),
    addFilter: (f) => set((c) => ({ filters: [...c.filters.filter((x) => !(x.field === f.field && x.op === f.op)), f] })),
    removeFilter: (i) => set((c) => ({ filters: c.filters.filter((_, k) => k !== i) })),
    pushSegment: (s) => set((c) => ({ segment: [...c.segment.filter((x) => x.dim !== s.dim), s] })),
    removeSegment: (i) => set((c) => ({ segment: c.segment.filter((_, k) => k !== i) })),
    popSegmentTo: (depth) => set((c) => ({ segment: c.segment.slice(0, depth) })),
    setCohort: (key, label) => set((c) => ({ segment: [...c.segment.filter((x) => x.dim !== 'cohort'), ...(key ? [{ dim: 'cohort', value: key, label: label || null }] : [])] })),
    clearSlice: () => set({ filters: [], segment: [] }),
  }
}

function readStored(): string | null {
  try { return localStorage.getItem(STORE) } catch { return null }
}

/**
 * The context hook. Back / forward in the main pane re-reads the URL; every
 * change is remembered locally and (main pane only) written back to the URL.
 */
export function useIntelContext(): [IntelContext, IntelActions, { inPane: boolean }] {
  const pane = useContext(PaneRouteContext)
  const location = useRouteLocation()
  const [state, setState] = useState(() => {
    const ctx = readContext(pane ? pane.location : location, readStored())
    return { ctx, location: pane ? null : location, written: urlFor(ctx) }
  })
  // The address moved (back / forward / a handoff link) and it is not the one
  // we wrote: re-read it. Derived during render, not in an effect.
  if (!pane && location !== state.location) {
    const fromUrl = location.startsWith('/analytics') && location !== state.written ? readContext(location, null) : state.ctx
    setState({ ctx: fromUrl, location, written: state.written })
  }
  const ctx = state.ctx

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(ctx)) } catch { /* private mode */ }
    if (pane) return
    const href = urlFor(ctx)
    const t = window.setTimeout(() => {
      if (!window.location.pathname.startsWith('/analytics')) return
      if (`${window.location.pathname}${window.location.search}` === href) return
      replaceRoutePath(href)
    }, 180)
    return () => window.clearTimeout(t)
  }, [ctx, pane])

  const set = useCallback<IntelActions['set']>((patch) => {
    setState((s) => {
      const next = sanitize({ ...s.ctx, ...(typeof patch === 'function' ? patch(s.ctx) : patch) }, s.ctx.tz)
      return { ...s, ctx: next, written: urlFor(next) }
    })
  }, [])
  const actions = useMemo(() => makeActions(set), [set])
  return [ctx, actions, { inPane: Boolean(pane) }]
}
