/**
 * ANALYTICS LAB — THE QUERY CONTRACT.
 *
 *   { metric, metrics?, groupBy?, filters, segment, range, compare, grain, tz, limit, mode }
 *
 * Every request is normalised here before anything is read: unknown metrics,
 * dimensions, fields and operators are rejected (never ignored), values are
 * bounded, the period and its comparison are resolved to exact instants, the
 * grain is chosen (or validated) so a chart never has more than MAX_BUCKETS
 * points, and a stable cache key is derived from the WHOLE normalised context.
 * The client can only express what this contract accepts; there is no path
 * from a request to arbitrary SQL.
 */
import { DEFINITION_VERSION, DIMENSION_REGISTRY, FILTER_FIELDS, METRICS_BY_ID } from './metric-registry.js'

const DAY = 86_400_000
const HOUR = 3_600_000
/** First send_queue row in production. Windows before it are partial, never "zero". */
export const HISTORY_START = '2026-04-18T00:00:00.000Z'
export const MAX_SPAN_DAYS = 400
export const MAX_BUCKETS = 400
export const RANGE_PRESETS = ['today', '7d', '30d', '90d', 'ytd', 'custom']
export const COMPARE_MODES = ['previous', 'week', 'month', 'year', 'custom', 'none']
export const GRAINS = ['hour', 'day', 'week', 'month']
export const MODES = ['overview', 'acquisition', 'pipeline', 'campaigns', 'communications', 'geography', 'automation', 'buyers', 'financial']

export class ContractError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ContractError'
    this.status = 400
    this.detail = detail
  }
}

const clean = (v) => String(v ?? '').trim()
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const FIELD_BY_ID = Object.fromEntries(FILTER_FIELDS.map((x) => [x.id, x]))

/* ── time zones ───────────────────────────────────────────────────────────── */

const DTF = new Map()
function fmt(tz) {
  if (!DTF.has(tz)) {
    DTF.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }))
  }
  return DTF.get(tz)
}
export function validTimeZone(tz) {
  const t = clean(tz)
  if (!t || t.length > 64) return null
  try { fmt(t).format(0); return t } catch { return null }
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
/** Wall-clock parts of an instant in a zone (DST-correct via Intl). */
export function zonedParts(ms, tz) {
  const p = {}
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] }
}
/** Offset (ms) of a zone at an instant: local wall clock minus UTC. */
function offsetAt(ms, tz) {
  const z = zonedParts(ms, tz)
  return Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000
}
/** The instant a local wall-clock time occurs in a zone (the earlier one across a DST fold). */
export function zonedToUtc(y, mo, d, h = 0, mi = 0, tz = 'UTC') {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  let t = guess - offsetAt(guess, tz)
  const t2 = guess - offsetAt(t, tz)
  if (t2 !== t) t = Math.min(t, t2)
  return t
}
/** Start of the grain bucket containing `ms`, in the zone. Weeks start Monday. */
export function bucketStart(ms, grain, tz) {
  const z = zonedParts(ms, tz)
  if (grain === 'hour') return zonedToUtc(z.y, z.mo, z.d, z.h, 0, tz)
  if (grain === 'day') return zonedToUtc(z.y, z.mo, z.d, 0, 0, tz)
  if (grain === 'month') return zonedToUtc(z.y, z.mo, 1, 0, 0, tz)
  // week: back to Monday in local calendar arithmetic
  const back = (z.wd + 6) % 7
  const local = new Date(Date.UTC(z.y, z.mo - 1, z.d - back))
  return zonedToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), 0, 0, tz)
}
/** The bucket after `start`. */
export function nextBucket(start, grain, tz) {
  const z = zonedParts(start, tz)
  if (grain === 'hour') return start + HOUR
  if (grain === 'day') return zonedToUtc(z.y, z.mo, z.d + 1, 0, 0, tz)
  if (grain === 'week') return zonedToUtc(z.y, z.mo, z.d + 7, 0, 0, tz)
  return zonedToUtc(z.y, z.mo + 1, 1, 0, 0, tz)
}
export function bucketList(startMs, endMs, grain, tz) {
  const out = []
  for (let b = bucketStart(startMs, grain, tz); b < endMs && out.length <= MAX_BUCKETS; b = nextBucket(b, grain, tz)) out.push(b)
  return out
}

/* ── periods ──────────────────────────────────────────────────────────────── */

function shiftMonths(ms, months, tz) {
  const z = zonedParts(ms, tz)
  const lastDay = new Date(Date.UTC(z.y, z.mo - 1 + months + 1, 0)).getUTCDate()
  return zonedToUtc(z.y, z.mo + months, Math.min(z.d, lastDay), z.h, z.mi, tz)
}

/**
 * Resolve the period. `now` is floored to the minute so every request inside
 * the same minute shares a cache key and an identical window.
 */
export function resolveRange(range = {}, { now = Date.now(), tz = 'UTC' } = {}) {
  const preset = RANGE_PRESETS.includes(range.preset) ? range.preset : '30d'
  const nowMs = Math.floor(now / 60_000) * 60_000
  let start
  let end = nowMs
  if (preset === 'today') {
    const z = zonedParts(nowMs, tz)
    start = zonedToUtc(z.y, z.mo, z.d, 0, 0, tz)
  } else if (preset === 'ytd') {
    start = zonedToUtc(zonedParts(nowMs, tz).y, 1, 1, 0, 0, tz)
  } else if (preset === 'custom') {
    start = Date.parse(range.start)
    end = Date.parse(range.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new ContractError('custom range needs ISO start and end')
    end = Math.min(end, nowMs)
    if (start >= end) throw new ContractError('custom range start must be before end')
  } else {
    start = nowMs - ({ '7d': 7, '30d': 30, '90d': 90 }[preset]) * DAY
  }
  if ((end - start) / DAY > MAX_SPAN_DAYS) throw new ContractError(`range longer than ${MAX_SPAN_DAYS} days`)
  const history = Date.parse(HISTORY_START)
  return {
    preset,
    start,
    end,
    days: Math.round(((end - start) / DAY) * 10) / 10,
    coverage: end <= history ? 'none' : start < history ? 'partial' : 'full',
    historyStart: HISTORY_START,
  }
}

export function resolveCompare(compare = {}, period, { tz = 'UTC' } = {}) {
  const mode = COMPARE_MODES.includes(compare.mode) ? compare.mode : 'previous'
  if (mode === 'none') return { mode, start: null, end: null, available: false, reason: 'No comparison selected.' }
  let start
  let end
  if (mode === 'previous') { end = period.start; start = period.start - (period.end - period.start) }
  else if (mode === 'week') { start = period.start - 7 * DAY; end = period.end - 7 * DAY }
  else if (mode === 'month') { start = shiftMonths(period.start, -1, tz); end = shiftMonths(period.end, -1, tz) }
  else if (mode === 'year') { start = shiftMonths(period.start, -12, tz); end = shiftMonths(period.end, -12, tz) }
  else {
    start = Date.parse(compare.start)
    end = Date.parse(compare.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new ContractError('custom comparison needs ISO start < end')
    if ((end - start) / DAY > MAX_SPAN_DAYS) throw new ContractError(`comparison longer than ${MAX_SPAN_DAYS} days`)
  }
  const history = Date.parse(HISTORY_START)
  // A comparison window that ends before any recorded traffic is not a
  // comparison: it would report every metric as "+100%".
  if (end <= history) {
    return { mode, start, end, available: false, reason: `History begins ${HISTORY_START.slice(0, 10)}; the ${mode === 'year' ? 'prior-year' : 'comparison'} window has no recorded traffic.` }
  }
  return {
    mode, start, end, available: true,
    partial: start < history,
    reason: start < history ? `The comparison window starts before history (${HISTORY_START.slice(0, 10)}); it covers ${Math.round((end - history) / DAY)} of ${Math.round((end - start) / DAY)} days.` : null,
    lengthRatio: (end - start) / (period.end - period.start),
  }
}

export function autoGrain(period) {
  const days = (period.end - period.start) / DAY
  if (period.preset === 'today' || days <= 2) return 'hour'
  if (days <= 45) return 'day'
  if (days <= 120) return 'week'
  return 'week'
}
export function resolveGrain(grain, period, tz) {
  const g = GRAINS.includes(grain) ? grain : autoGrain(period)
  const n = bucketList(period.start, period.end, g, tz).length
  if (n > MAX_BUCKETS) throw new ContractError(`grain ${g} gives more than ${MAX_BUCKETS} points for this range`)
  return { grain: g, auto: !GRAINS.includes(grain), buckets: n }
}

/* ── filters ──────────────────────────────────────────────────────────────── */

const MAX_VALUES = 200
function normValue(field, op, value) {
  if (op === 'exists' || op === 'missing' || op === 'is_true' || op === 'is_false') return null
  if (field.type === 'number') {
    if (op === 'between') {
      const [a, b] = Array.isArray(value) ? value.map(Number) : [NaN, NaN]
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ContractError(`${field.id}: between needs two numbers`)
      return [Math.min(a, b), Math.max(a, b)]
    }
    const n = Number(value)
    if (!Number.isFinite(n)) throw new ContractError(`${field.id}: ${op} needs a number`)
    return n
  }
  if (field.type === 'time') {
    const vals = (Array.isArray(value) ? value : [value]).map((v) => Date.parse(v))
    if (!vals.length || vals.some((v) => !Number.isFinite(v))) throw new ContractError(`${field.id}: needs ISO time(s)`)
    return op === 'between' ? [Math.min(...vals), Math.max(...vals)] : vals[0]
  }
  // category
  const list = (Array.isArray(value) ? value : [value]).map((v) => clean(v).slice(0, 120)).filter(Boolean)
  if (!list.length) throw new ContractError(`${field.id}: ${op} needs at least one value`)
  if (list.length > MAX_VALUES) throw new ContractError(`${field.id}: at most ${MAX_VALUES} values`)
  return op === 'eq' || op === 'neq' ? list[0] : [...new Set(list)].sort()
}
export function normalizeFilters(filters = []) {
  if (!Array.isArray(filters)) throw new ContractError('filters must be a list')
  if (filters.length > 24) throw new ContractError('at most 24 filters')
  return filters.map((raw) => {
    const field = FIELD_BY_ID[clean(raw?.field)]
    if (!field) throw new ContractError(`unknown filter field "${clean(raw?.field)}"`)
    const op = clean(raw?.op)
    if (!field.operators.includes(op)) throw new ContractError(`operator "${op}" is not valid for ${field.id} (${field.operators.join(', ')})`)
    return { field: field.id, op, value: normValue(field, op, raw?.value) }
  }).sort((a, b) => (a.field + a.op).localeCompare(b.field + b.op))
}

/** The breadcrumb path (ALL → Atlanta → Campaign X → Sender → failure class) as equality filters. */
export function normalizeSegment(segment = []) {
  const list = Array.isArray(segment) ? segment : isObj(segment) ? Object.entries(segment).map(([dim, value]) => ({ dim, value })) : []
  if (list.length > 8) throw new ContractError('at most 8 breadcrumb steps')
  return list.map((s) => {
    const dim = clean(s?.dim)
    if (!DIMENSION_REGISTRY[dim]) throw new ContractError(`unknown dimension "${dim}" in breadcrumb`)
    const value = s?.value === null ? null : clean(s?.value).slice(0, 120)
    return { dim, value, label: clean(s?.label).slice(0, 120) || null }
  })
}

/* ── the contract ─────────────────────────────────────────────────────────── */

export function normalizeContext(raw = {}, { now = Date.now() } = {}) {
  if (!isObj(raw)) throw new ContractError('context must be an object')
  const tz = validTimeZone(raw.tz) || 'America/Chicago'
  const metricId = clean(raw.metric) || 'reply_rate'
  if (!METRICS_BY_ID[metricId]) throw new ContractError(`unknown metric "${metricId}"`)
  const metrics = Array.isArray(raw.metrics) ? raw.metrics.map(clean).filter(Boolean) : []
  for (const id of metrics) if (!METRICS_BY_ID[id]) throw new ContractError(`unknown metric "${id}"`)
  if (metrics.length > 24) throw new ContractError('at most 24 metrics per request')
  const groupBy = clean(raw.groupBy) || null
  if (groupBy && !DIMENSION_REGISTRY[groupBy]) throw new ContractError(`unknown dimension "${groupBy}"`)
  if (groupBy && !METRICS_BY_ID[metricId].dimensions.includes(groupBy)) {
    throw new ContractError(`${METRICS_BY_ID[metricId].label} cannot be grouped by ${DIMENSION_REGISTRY[groupBy].label}`, { metric: metricId, groupBy, valid: METRICS_BY_ID[metricId].dimensions })
  }
  const mode = MODES.includes(raw.mode) ? raw.mode : 'overview'
  const range = isObj(raw.range) ? raw.range : { preset: clean(raw.range) || '30d' }
  const period = resolveRange(range, { now, tz })
  const compare = resolveCompare(isObj(raw.compare) ? raw.compare : { mode: clean(raw.compare) || 'previous' }, period, { tz })
  const grain = resolveGrain(clean(raw.grain), period, tz)
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(raw.limit) || 50)))
  return {
    v: 1,
    version: DEFINITION_VERSION,
    tz,
    mode,
    metric: metricId,
    metrics: [...new Set(metrics)],
    groupBy,
    filters: normalizeFilters(raw.filters || []),
    segment: normalizeSegment(raw.segment || []),
    range: { preset: period.preset, ...(period.preset === 'custom' ? { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() } : {}) },
    period,
    compare,
    grain,
    limit,
  }
}

/** Stable JSON: sorted keys, so equal contexts always produce equal keys. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
export function cacheKey(ctx, kind = 'query') {
  const { period, compare, grain } = ctx
  return `${kind}|${stableStringify({
    version: ctx.version, tz: ctx.tz, metric: ctx.metric, metrics: ctx.metrics, groupBy: ctx.groupBy,
    filters: ctx.filters, segment: ctx.segment.map((s) => [s.dim, s.value]), limit: ctx.limit, mode: ctx.mode,
    p: [period.start, period.end], c: [compare.mode, compare.start, compare.end], g: grain.grain,
  })}`
}

/* ── URL encoding (the client mirrors this) ───────────────────────────────── */

export function encodeContext(raw) {
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url')
}
export function decodeContext(param) {
  const s = clean(param)
  if (!s) return {}
  if (s.length > 8000) throw new ContractError('context too long')
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw new ContractError('context is not valid base64url JSON')
  }
}

/** A context as the client sees it: the parts it may round-trip into a URL. */
export function publicContext(ctx) {
  return {
    v: ctx.v, version: ctx.version, tz: ctx.tz, mode: ctx.mode, metric: ctx.metric, metrics: ctx.metrics, groupBy: ctx.groupBy,
    filters: ctx.filters, segment: ctx.segment, range: ctx.range, limit: ctx.limit,
    compare: { mode: ctx.compare.mode, ...(ctx.compare.mode === 'custom' ? { start: new Date(ctx.compare.start).toISOString(), end: new Date(ctx.compare.end).toISOString() } : {}) },
    grain: ctx.grain.auto ? 'auto' : ctx.grain.grain,
  }
}
