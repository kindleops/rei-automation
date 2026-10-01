/**
 * Formatting for the decision room. Numbers render what they are given:
 * null is an honest dash, never $0.
 */
export function usd(n: number | null | undefined, opts: { exact?: boolean; signed?: boolean } = {}): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : opts.signed && n > 0 ? '+' : ''
  if (opts.exact) return `${sign}$${Math.round(a).toLocaleString('en-US')}`
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e5) return `${sign}$${Math.round(a / 1e3)}K`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return `${sign}$${Math.round(a)}`
}

export const dash = (s: string | null | undefined) => s ?? '—'

export function pct(n: number | null | undefined, digits = 0): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return `${n.toFixed(digits)}%`
}

export function int(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return Math.round(n).toLocaleString('en-US')
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** "Sep 30" this year, "Sep 30, 2024" otherwise. Date-only strings stay on their calendar day. */
export function dateShort(iso: string | null | undefined, now?: number): string | null {
  const t = parse(iso)
  if (t === null) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso))
  const d = new Date(t)
  const year = dateOnly ? d.getUTCFullYear() : d.getFullYear()
  const sameYear = now ? new Date(now).getFullYear() === year : false
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...(dateOnly ? { timeZone: 'UTC' } : {}) })
}

export function dateTime(iso: string | null | undefined): string | null {
  const t = parse(iso)
  if (t === null) return null
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** "3m ago", "5h ago", "2d ago", "4mo ago" — relative to a supplied clock (render stays pure). */
export function ago(iso: string | null | undefined, now: number): string | null {
  const t = parse(iso)
  if (t === null) return null
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  if (d < 45) return `${d}d ago`
  if (d < 365) return `${Math.round(d / 30.4)}mo ago`
  return `${(d / 365).toFixed(1)}y ago`
}

/** Future-facing: "in 3h", "in 2d", or ago() when already past. */
export function until(iso: string | null | undefined, now: number): string | null {
  const t = parse(iso)
  if (t === null) return null
  const s = (t - now) / 1000
  if (s <= 0) return ago(iso, now)
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `in ${Math.round(s / 3600)}h`
  return `in ${Math.round(s / 86400)}d`
}

export function minutes(m: number | null | undefined): string | null {
  if (m === null || m === undefined || !Number.isFinite(m)) return null
  if (m < 1) return '<1m'
  if (m < 60) return `${Math.round(m)}m`
  if (m < 1440) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`
  return `${Math.round(m / 1440)}d`
}

/** snake_case / kebab → "Sentence case". */
export function humanize(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  return s.replace(/[_-]+/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

/** +16122756497 → (612) 275-6497 for US numbers; anything else as given. */
export function phone(e164: string | null | undefined): string | null {
  const s = String(e164 ?? '').trim()
  if (!s) return null
  const d = s.replace(/\D/g, '')
  const us = d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null
  return us ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : s
}

/** "3635 Emerson Ave N, Minneapolis, Mn 55412" → street + locality. */
export function splitAddress(full: string | null | undefined): { street: string | null; locality: string | null } {
  const s = String(full ?? '').trim()
  if (!s) return { street: null, locality: null }
  const [street, ...rest] = s.split(',')
  const locality = rest.join(',').trim().replace(/\b([A-Z][a-z])\b(?=\s+\d{5})/, (m) => m.toUpperCase())
  return { street: street.trim() || null, locality: locality || null }
}
