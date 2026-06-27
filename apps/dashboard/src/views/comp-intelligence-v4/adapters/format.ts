/**
 * Comp Intelligence V4 — the single canonical formatter set.
 *
 * One money formatter for the whole workspace (Section 9: $90K, $287K, $1.2M,
 * $12.4M — never clipped, never partial).
 */

export function fmtMoneyShort(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = Math.round(value)
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000
    return `${sign}$${trim(m, m >= 10 ? 1 : 2)}M`
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs / 1_000)}K`
  }
  return `${sign}$${abs}`
}

export function fmtMoneyFull(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtSqft(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value).toLocaleString('en-US')} sf`
}

export function fmtMiles(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${trim(value, 2)} mi`
}

export function fmtPpsf(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${Math.round(value)}/sf`
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function daysAgo(value: string | null | undefined): number | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return Math.round((Date.now() - d.getTime()) / 86_400_000)
}

function trim(n: number, digits: number): string {
  return Number(n.toFixed(digits)).toString()
}
