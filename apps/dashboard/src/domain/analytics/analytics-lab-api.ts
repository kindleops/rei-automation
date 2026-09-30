/**
 * ANALYTICS LAB — client for /api/cockpit/analytics/lab/*.
 *
 * The server owns the metric registry, every number, every comparison and
 * every cohort. This client only encodes the analytical context, fetches, and
 * formats: it never aggregates, never derives a rate, never fills a gap.
 */
import { callBackend } from '../../lib/api/backendClient'

export type LabRangePreset = 'today' | '7d' | '30d' | '90d' | 'ytd' | 'custom'
export type LabCompareMode = 'previous' | 'week' | 'month' | 'year' | 'custom' | 'none'
export type LabGrain = 'auto' | 'hour' | 'day' | 'week' | 'month'
export type LabMode = 'overview' | 'acquisition' | 'pipeline' | 'campaigns' | 'communications' | 'geography' | 'automation' | 'buyers' | 'financial'
export type LabFilter = { field: string; op: string; value: unknown }
export type LabSegmentStep = { dim: string; value: string | null; label?: string | null }

export type LabContext = {
  v: 1
  tz: string
  mode: LabMode
  metric: string
  groupBy: string | null
  filters: LabFilter[]
  segment: LabSegmentStep[]
  range: { preset: LabRangePreset; start?: string; end?: string }
  compare: { mode: LabCompareMode; start?: string; end?: string }
  grain: LabGrain
  limit?: number
}

/* ── registry ── */
export type MetricDef = {
  id: string; version: string; family: string; entity: string; label: string; short: string; description: string
  unit: 'count' | 'rate' | 'ratio' | 'duration_min'; polarity: 'up' | 'down' | 'neutral'; comparison: string
  numerator: { label: string; def?: string; metric?: string }; denominator?: { label: string; def?: string; metric?: string }
  time_basis: string; sources: string[]; exclusions: string[]; min_sample: number | null; null_behavior: string; caveat?: string
  freshness: { kind: string; note: string }; dimensions: string[]; additive_over_time?: boolean
  v1: { status: 'same' | 'changed' | 'new'; note: string }
  availability?: { requires: string; min_records_ever: number; reason: string }
}
export type DimensionDef = { label: string; family: string; kind: string; source: string }
export type FilterFieldDef = { id: string; family: string; label: string; type: 'category' | 'number' | 'boolean' | 'time'; operators: string[]; applies: string[]; coverage: string; source: string; viability: string; unit?: string; system?: boolean }
export type LabRegistry = {
  version: string; historyStart: string; generatedAt: string
  metrics: MetricDef[]; dimensions: Record<string, DimensionDef>; filters: FilterFieldDef[]
  entities: Record<string, { label: string; plural: string; key: string; note?: string }>
  timeBases: Record<string, { label: string; column: string; why: string }>
  nonViable: Array<{ field: string; reason: string }>
  changes: Array<{ metric: string; label: string; note: string }>
  replica?: { ready: boolean; rows: number } | null
}

/* ── values ── */
export type MetricStatus = 'ok' | 'no_data' | 'insufficient_sample' | 'unavailable' | 'not_applicable'
export type Dist = { n: number; p25: number | null; p50: number | null; p75: number | null; p90: number | null; min: number | null; max: number | null }
export type MetricValue = {
  id: string; kind?: 'count' | 'rate' | 'ratio' | 'duration'; status: MetricStatus; value: number | null
  num?: number; den?: number; n?: number; ci?: { low: number; high: number } | null; dist?: Dist; minSample?: number; reason?: string; notApplicable?: string[]
}
export type MetricChange = {
  comparable: boolean; kind?: string; delta?: number; pct?: number | null; pts?: number; ciPts?: [number, number] | null
  p?: number | null; significant?: boolean; reason?: string | null; lengthAdjusted?: boolean
}
export type MetricPair = { id: string; cur: MetricValue; prev: MetricValue | null; change: MetricChange }
export type SeriesPoint = { start: number; end: number; value: number | null; num?: number; den?: number; n?: number; ci?: { low: number; high: number } | null; p75?: number | null }

export type LabEnvelope = {
  version: string
  context: LabContext
  period: { start: string; end: string; days: number; preset: string; coverage: 'full' | 'partial' | 'none'; historyStart: string }
  compare: { mode: LabCompareMode; available: boolean; reason: string | null; partial: boolean; start: string | null; end: string | null }
  grain: { grain: 'hour' | 'day' | 'week' | 'month'; auto: boolean; buckets: number }
  generatedAt?: string; dataAsOf?: string; timing?: { loadMs: number; computeMs: number }
}
export type WhatChanged = {
  id: string; label: string; kind: string; cur: number | null; prev: number | null; num: number | null; den: number | null; prevNum: number | null; prevDen: number | null
  delta: number | null; pct: number | null; pts: number | null; ciPts: [number, number] | null; p: number; polarity: 'up' | 'down' | 'neutral'; drill: string[]
  top: null | { dim: string; dimLabel: string; key: string; label: string; value: number; share: number; kind: string }
}
export type BreakdownRow = { key: string; label: string; test?: boolean; value: number | null; n: number; num?: number; den?: number; ci?: { low: number; high: number } | null; insufficient?: boolean; dist?: Dist; prev?: BreakdownRow | null }
export type LabOverview = LabEnvelope & {
  narrative: Array<{ text: string; refs: string[]; parts?: Array<{ text: string; metric?: string }> }>
  strip: MetricPair[]
  metrics: Record<string, MetricPair>
  trend: { metric: string; grain: string; current: SeriesPoint[]; comparison: SeriesPoint[] | null; options: string[] }
  thePeriod: {
    cohort: { sellers: number | null; messages: number; replies: number; transitions: number; runs: number }
    exclusions: Record<string, number>
    unresolved: { market: number }
    freshness: { dataAsOf: string; live: string[]; note: string }
    caveats: string[]
  }
  changes: WhatChanged[]
  funnel: {
    steps: Array<{ id: string; label: string; value: number | null; base: number | null; conversion: number | null; note?: string }>
    events: Array<{ id: string; label: string; value: number | null; status?: MetricStatus; caveat?: string | null }>
    note: string
  }
  geo: { metric: string; dim: string; rows: BreakdownRow[]; unresolved: number }
}
export type ContributionRow = { key: string; label: string; test?: boolean; cur: number | { num: number; den: number; rate: number | null }; prev: number | { num: number; den: number; rate: number | null }; contribution?: number; contributionPts?: number; rateEffectPts?: number; mixEffectPts?: number }
export type LabQuery = LabEnvelope & {
  view: string
  metric: MetricPair
  result: null | {
    dim?: string; rows?: BreakdownRow[] | ContributionRow[]; total?: number; truncated?: boolean
    grain?: string; current?: unknown; comparison?: unknown
    kind?: string; available?: boolean; reason?: string; totalPts?: number; others?: number; language?: string
  }
}
export type HeatCell = { num: number; den: number; n: number; value: number | null; ci?: { low: number; high: number } | null }
export type Heatmap = { weekdays: string[]; cells: HeatCell[][]; unresolved: number; basis: string }
export type Histogram = { bins: Array<{ from: number; to: number; count: number }>; dist: Dist }

export type RecordColumn = { id: string; label: string; type: 'text' | 'number' | 'time' | 'bool' }
export type LabRecords = LabEnvelope & {
  metric: string; part: 'numerator' | 'denominator'; window: 'current' | 'comparison'; entity: string
  total: number; page: number; pageSize: number; pages: number; sort: string | null; dir: 'asc' | 'desc'
  columns: RecordColumn[]; rows: Array<Record<string, unknown> & { key: string }>
  status?: MetricStatus; reason?: string
  handoff: { threads: string[]; propertyIds: string[]; points: Array<{ lat: number; lng: number; id?: string; label?: string | null }>; opportunityIds: string[] }
}
export type RecordCohort = { metric: string; part?: 'numerator' | 'denominator'; window?: 'current' | 'comparison'; group?: { dim: string; key: string; label?: string }; bucket?: { start: string; end: string }; cell?: { weekday: number; hour: number } }
export type FilterOptions = LabEnvelope & { field: string; type: string; values: Array<{ value: string; label: string; n: number; test?: boolean }>; truncated?: boolean }
export type SavedViews = { store: 'server' | 'unavailable'; reason?: string; migration?: string; views: Array<{ id: string; label: string; context: LabContext; is_pinned?: boolean; updated_at?: string }> }

/* ── encoding ── */
export function encodeB64Url(value: unknown): string {
  const json = JSON.stringify(value)
  const bytes = new TextEncoder().encode(json)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeB64Url<T>(s: string): T | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

/* ── transport ── */
async function get<T>(path: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
  const res = await callBackend<{ ok: boolean; data: T; error?: string; errorType?: string }>(path, { signal, timeoutMs })
  if (!res.ok) {
    const body = (res as { data?: { error?: string } }).data
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(body?.error || upstream?.error || res.error || 'analytics_lab_failed')
  }
  if (!res.data?.ok) throw new Error(res.data?.error || 'analytics_lab_failed')
  return res.data.data
}
const ctxParam = (ctx: LabContext) => `ctx=${encodeB64Url(ctx)}`

export const fetchLabRegistry = (signal?: AbortSignal) => get<LabRegistry>('/api/cockpit/analytics/lab/registry', signal)
export const fetchLabOverview = (ctx: LabContext, signal?: AbortSignal) => get<LabOverview>(`/api/cockpit/analytics/lab/overview?${ctxParam(ctx)}`, signal, 90_000)
export type LabView = 'metric' | 'breakdown' | 'series' | 'heatmap' | 'histogram' | 'contribution' | 'table' | 'stages' | 'orchestrator' | 'buyers'
export const fetchLabQuery = (ctx: LabContext & { metrics?: string[] }, view: LabView, signal?: AbortSignal) =>
  get<LabQuery>(`/api/cockpit/analytics/lab/query?${ctxParam(ctx)}&view=${view}`, signal, 90_000)
export const fetchLabRecords = (ctx: LabContext, cohort: RecordCohort, paging: { page: number; pageSize: number; sort?: string | null; dir?: 'asc' | 'desc' }, signal?: AbortSignal) =>
  get<LabRecords>(`/api/cockpit/analytics/lab/records?${ctxParam(ctx)}&cohort=${encodeB64Url(cohort)}&page=${paging.page}&pageSize=${paging.pageSize}${paging.sort ? `&sort=${encodeURIComponent(paging.sort)}` : ''}&dir=${paging.dir || 'desc'}`, signal)
export const fetchLabFilterOptions = (ctx: LabContext, field: string, signal?: AbortSignal) => get<FilterOptions>(`/api/cockpit/analytics/lab/options?${ctxParam(ctx)}&field=${encodeURIComponent(field)}`, signal)
export const fetchSavedViews = (signal?: AbortSignal) => get<SavedViews>('/api/cockpit/analytics/lab/views', signal)

/* ── formatting: tabular, explicit units, never a fabricated zero ── */
const NF = new Intl.NumberFormat('en-US')
export const fmtCount = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : NF.format(Math.round(n)))
export const fmtRate = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits)}%`)
export const fmtMinutes = (m: number | null | undefined) => {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—'
  if (m < 1) return `${Math.round(m * 60)}s`
  if (m < 90) return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`
  const h = m / 60
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`
  return `${(h / 24).toFixed(1)} d`
}
export function fmtMetric(def: MetricDef | undefined, v: number | null | undefined) {
  if (!def) return fmtCount(v)
  if (def.unit === 'rate') return fmtRate(v)
  if (def.unit === 'duration_min') return fmtMinutes(v)
  if (def.unit === 'ratio') return v === null || v === undefined ? '—' : `${v.toFixed(1)}×`
  return fmtCount(v)
}
/** Rates change in POINTS; counts in absolute and (on a base ≥ 10) percent. */
export function fmtChange(_def: MetricDef | undefined, c: MetricChange | undefined): string | null {
  if (!c?.comparable) return null
  if (c.kind === 'rate' && typeof c.pts === 'number') return `${c.pts > 0 ? '+' : c.pts < 0 ? '−' : '±'}${Math.abs(c.pts).toFixed(1)} pts`
  if (c.kind === 'duration' && typeof c.delta === 'number') return `${c.delta > 0 ? '+' : c.delta < 0 ? '−' : '±'}${fmtMinutes(Math.abs(c.delta))}`
  if (c.kind === 'ratio' && typeof c.delta === 'number') return `${c.delta > 0 ? '+' : c.delta < 0 ? '−' : '±'}${Math.abs(c.delta).toFixed(1)}×`
  if (typeof c.delta === 'number') {
    const abs = `${c.delta > 0 ? '+' : c.delta < 0 ? '−' : '±'}${NF.format(Math.abs(c.delta))}`
    return c.pct !== null && c.pct !== undefined ? `${abs} · ${c.pct > 0 ? '+' : c.pct < 0 ? '−' : ''}${Math.abs(c.pct * 100).toFixed(Math.abs(c.pct) >= 1 ? 0 : 1)}%` : abs
  }
  return null
}
export function changeTone(def: MetricDef | undefined, c: MetricChange | undefined): 'good' | 'bad' | 'neutral' {
  if (!c?.comparable || !def || def.polarity === 'neutral') return 'neutral'
  const d = c.kind === 'rate' ? c.pts ?? 0 : c.delta ?? 0
  if (!d) return 'neutral'
  return (d > 0) === (def.polarity === 'up') ? 'good' : 'bad'
}
export const fmtP = (p: number | null | undefined) => (p === null || p === undefined ? null : p < 0.001 ? 'p < 0.001' : `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`)
