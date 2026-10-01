/**
 * ANALYTICS 4.0 — formatting and scales. Tabular where numbers align,
 * explicit units always, an honest dash for a missing value (never a zero).
 */

const NF = new Intl.NumberFormat('en-US')
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : NF.format(Math.round(n)))
export const fmtCompact = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.abs(n) < 10_000 ? NF.format(Math.round(n)) : COMPACT.format(n))
export const fmtPct = (r: number | null | undefined, digits = 1) => (r === null || r === undefined || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits)}%`)
export const fmtPts = (pts: number | null | undefined, digits = 1) => (pts === null || pts === undefined || !Number.isFinite(pts) ? '—' : `${pts > 0 ? '+' : pts < 0 ? '−' : '±'}${Math.abs(pts).toFixed(digits)} pts`)
export const fmtSigned = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${NF.format(Math.abs(Math.round(n)))}`)

/** Money with no false precision: $663.8K, $84.2M. A missing or zero sum is a dash; the caller says why. */
export function fmtMoney(n: number | null | undefined, { zero = '—' }: { zero?: string } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n === 0) return zero
  const a = Math.abs(n)
  const s = n < 0 ? '−' : ''
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`
  return `${s}$${NF.format(Math.round(a))}`
}

export function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—'
  if (m < 1) return `${Math.round(m * 60)}s`
  if (m < 90) return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`
  const h = m / 60
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`
  return `${(h / 24).toFixed(1)} d`
}
export const fmtDays = (minutes: number | null | undefined) => (minutes === null || minutes === undefined || !Number.isFinite(minutes) ? '—' : minutes < 60 * 24 ? `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h` : `${(minutes / 1440).toFixed(1)} d`)

/** "updated 2m ago" — the age of the data the screen shows. */
export function fmtAge(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const DTF = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string, o: Intl.DateTimeFormatOptions) {
  const k = `${tz}|${JSON.stringify(o)}`
  let f = DTF.get(k)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }); DTF.set(k, f) }
  return f
}
export function fmtBucket(ms: number, grain: string, tz: string, long = false) {
  if (grain === 'hour') return dtf(tz, long ? { month: 'short', day: 'numeric', hour: 'numeric' } : { hour: 'numeric' }).format(ms)
  if (grain === 'week') return `${long ? 'Week of ' : ''}${dtf(tz, { month: 'short', day: 'numeric' }).format(ms)}`
  if (grain === 'month') return dtf(tz, { month: 'short', year: long ? 'numeric' : undefined }).format(ms)
  return dtf(tz, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }).format(ms)
}
/** "Sep 1 – Sep 30" (the end instant is exclusive, so the last day shown is end − 1 ms). */
export function fmtRange(startIso: string | null | undefined, endIso: string | null | undefined, tz: string) {
  if (!startIso || !endIso) return '—'
  const s = Date.parse(startIso)
  const e = Date.parse(endIso) - 1
  const f = dtf(tz, { month: 'short', day: 'numeric' })
  const y = dtf(tz, { year: 'numeric' })
  const sameYear = y.format(s) === y.format(e)
  return `${f.format(s)} – ${f.format(e)}${sameYear ? '' : `, ${y.format(e)}`}`
}
export const fmtDay = (ms: number, tz: string) => dtf(tz, { month: 'short', day: 'numeric' }).format(ms)
export const fmtDateTime = (iso: string, tz: string) => dtf(tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso))
export const fmtTime = (ms: number, tz?: string) => dtf(tz || 'America/Chicago', { hour: 'numeric', minute: '2-digit' }).format(ms)

/** Clean ticks from min to a rounded max (1 / 2 / 2.5 / 5 steps). */
export function niceTicks(min: number, max: number, count = 4) {
  if (!(max > min)) max = min + 1
  const span = max - min
  const rawStep = span / count
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const n = rawStep / mag
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Number((Math.round(v / step) * step).toPrecision(12)))
  return { ticks, lo, hi, step }
}

/** Evenly spaced axis-label indices that fit `width`, always keeping the newest. */
export function labelIndices(n: number, width: number, minGap = 70) {
  if (n <= 1) return [0]
  const fit = Math.max(2, Math.floor(width / minGap))
  const every = Math.max(1, Math.ceil((n - 1) / (fit - 1)))
  const out: number[] = []
  for (let i = n - 1; i >= 0; i -= every) out.unshift(i)
  if (out[0] !== 0 && out[0] >= every / 2) out.unshift(0)
  else if (out[0] !== 0) out[0] = 0
  return out
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Single-hue sequential ramp (exec cyan), 0..1 → a CSS colour between the theme's two poles. */
export const seqColor = (t: number) => `color-mix(in oklab, var(--ix-seq-hi) ${Math.round(clamp(t, 0, 1) * 100)}%, var(--ix-seq-lo))`

export const cx = (...t: Array<string | false | null | undefined | 0>) => t.filter(Boolean).join(' ')
