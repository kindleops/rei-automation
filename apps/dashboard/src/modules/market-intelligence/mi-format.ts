import type { MiMetric, MiUnit, MiValue } from './mi-types'

/**
 * Formatting. A number is printed ONLY for status 'ok'; every other status
 * prints its honest word. No false precision: money to 3 significant figures,
 * shares to whole percents (one decimal under 10%), counts exact.
 */
const nf = new Intl.NumberFormat('en-US')

export function fmtUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e4) return `$${Math.round(v / 1e3)}K`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${Math.round(v)}`
}

export function fmtPct(v: number, signed = false): string {
  const p = v * 100
  const s = Math.abs(p) < 10 && Math.abs(p) > 0 ? p.toFixed(1) : String(Math.round(p))
  return `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${s.replace('-', '')}%`
}

export function fmtCount(v: number): string { return nf.format(Math.round(v)) }

export function fmtUnit(unit: MiUnit, v: number, opts: { signed?: boolean } = {}): string {
  switch (unit) {
    case 'usd': return fmtUsd(v)
    case 'pct': return fmtPct(v, opts.signed)
    case 'pct100': return `${Math.round(v)}%`
    case 'year': return String(Math.round(v))
    case 'number': return v >= 100 ? fmtCount(v) : v.toFixed(v >= 10 ? 0 : 1)
    default: return fmtCount(v)
  }
}

export const STATUS_WORD: Record<string, string> = { insufficient: 'Thin sample', unavailable: 'Unavailable', not_loaded: 'Not loaded' }

/** Display text for a value under its metric. */
export function fmtValue(metric: Pick<MiMetric, 'unit' | 'id'> | undefined, v: MiValue | undefined): string {
  if (!v) return '—'
  if (v.status !== 'ok' || v.value === null || v.value === undefined) return STATUS_WORD[v.status] ?? '—'
  return fmtUnit(metric?.unit ?? 'count', v.value, { signed: metric?.id === 'sales_growth' })
}

/** The sample line under a value: "n 337" / "of 40 with a buyer · 10% recorded". */
export function fmtSample(metric: Pick<MiMetric, 'id' | 'unit' | 'aggregation'> | undefined, v: MiValue | undefined): string {
  if (!v) return ''
  if (v.status === 'insufficient' || v.status === 'unavailable' || v.status === 'not_loaded') return v.reason ?? ''
  const parts: string[] = []
  if (metric && (metric.aggregation === 'median' || metric.aggregation === 'ratio' || metric.aggregation === 'mean')) parts.push(`n ${fmtCount(v.n)}`)
  if (typeof v.coverage === 'number') parts.push(`${fmtPct(v.coverage)} recorded`)
  if (v.basis && metric?.aggregation !== 'count') parts.push(v.basis)
  return parts.join(' · ')
}

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export const fmtMonth = (label: string): string => {
  const [y, m] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}
