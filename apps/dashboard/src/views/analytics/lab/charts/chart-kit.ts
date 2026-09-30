/**
 * ANALYTICS LAB — chart kit: scales, ticks, bucket labels, semantic colours.
 *
 * Colours are ROLES, never library index colours. The outcome order
 * (primary cobalt → failure red → workflow violet → attention gold) was
 * validated for adjacent CVD separation in dark and light (dataviz
 * validate_palette: all checks pass; light gold needs visible labels, which
 * every Lab chart carries). Values live in analytics-lab.css as --lab-c-*.
 */

export const ROLE = {
  primary: 'var(--lab-c-primary)',
  compare: 'var(--lab-c-compare)',
  good: 'var(--lab-c-good)',
  bad: 'var(--lab-c-bad)',
  violet: 'var(--lab-c-violet)',
  gold: 'var(--lab-c-gold)',
  grid: 'var(--lab-grid)',
  axis: 'var(--lab-axis)',
} as const

/** Clean ticks from 0 (or min) to a rounded max. */
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
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step)
  return { ticks, lo, hi, step }
}

const DTF = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string, o: Intl.DateTimeFormatOptions) {
  const k = `${tz}|${JSON.stringify(o)}`
  if (!DTF.has(k)) DTF.set(k, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }))
  return DTF.get(k) as Intl.DateTimeFormat
}
export function fmtBucket(ms: number, grain: string, tz: string, long = false) {
  if (grain === 'hour') return fmt(tz, long ? { month: 'short', day: 'numeric', hour: 'numeric' } : { hour: 'numeric' }).format(ms)
  if (grain === 'week') return `${long ? 'Week of ' : ''}${fmt(tz, { month: 'short', day: 'numeric' }).format(ms)}`
  if (grain === 'month') return fmt(tz, { month: 'short', year: long ? 'numeric' : undefined }).format(ms)
  return fmt(tz, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }).format(ms)
}
export function fmtRangeShort(startIso: string | null | undefined, endIso: string | null | undefined, tz: string) {
  if (!startIso || !endIso) return '—'
  const s = Date.parse(startIso)
  const e = Date.parse(endIso) - 1
  const f = fmt(tz, { month: 'short', day: 'numeric' })
  const y = fmt(tz, { year: 'numeric' })
  const sameYear = y.format(s) === y.format(e)
  return `${f.format(s)} – ${f.format(e)}${sameYear ? '' : `, ${y.format(e)}`}`
}

/** Pick evenly spaced x-label indices that fit the width. */
export function labelIndices(n: number, width: number, minGap = 64) {
  if (n <= 1) return [0]
  const fit = Math.max(2, Math.floor(width / minGap))
  const every = Math.max(1, Math.ceil((n - 1) / (fit - 1)))
  const out: number[] = []
  for (let i = 0; i < n; i += every) out.push(i)
  if (out[out.length - 1] !== n - 1) {
    if (n - 1 - out[out.length - 1] < every / 2) out.pop()
    out.push(n - 1)
  }
  return out
}

/** Sequential single-hue ramp (cobalt), 0..1 → CSS colour via the theme's two poles. */
export const seqColor = (t: number) => `color-mix(in oklab, var(--lab-seq-hi) ${Math.round(Math.max(0, Math.min(1, t)) * 100)}%, var(--lab-seq-lo))`

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
