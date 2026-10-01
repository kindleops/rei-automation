/** Formatting for the studio: compact, tabular, honest about missing values. */

const ts = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** "just now" · "18m ago" · "3h ago" · "Sep 29" */
export function ago(v: string | number | null | undefined, now = Date.now()): string {
  const t = ts(v)
  if (t === null) return '—'
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 6) return `${Math.round(s / 86400)}d ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** age without "ago", for exception queues: "18m" · "3h" · "2d" */
export function age(v: string | number | null | undefined, now = Date.now()): string {
  const t = ts(v)
  if (t === null) return '—'
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** "2:47 PM" */
export const clock = (v: string | number | null | undefined) => { const t = ts(v); return t === null ? '—' : new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }

/** "14:47:55.001" — recorded precision for replay */
export const clockMs = (v: string | number | null | undefined) => {
  const t = ts(v)
  if (t === null) return '—'
  const d = new Date(t)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** "Sep 30 · 2:00 PM" */
export const stamp = (v: string | number | null | undefined) => {
  const t = ts(v)
  if (t === null) return '—'
  const d = new Date(t)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

/** "522 ms" · "1.2 s" · "38 s" · "4m" · "3h 14m" · "3.2d" */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) { const h = Math.floor(ms / 3_600_000); const m = Math.round((ms % 3_600_000) / 60_000); return m ? `${h}h ${m}m` : `${h}h` }
  return `${(ms / 86_400_000).toFixed(ms < 864_000_000 ? 1 : 0)}d`
}

/** 1,208 · 12.4k */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100_000) return `${Math.round(n / 1000)}k`
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString('en-US')
}

/** 82.4% (one decimal under 100, none for whole) */
export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—'
  const v = x * 100
  return `${v === 0 || v === 100 ? v.toFixed(0) : v.toFixed(digits)}%`
}

export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/** snake_case → Sentence case */
export const words = (v: string | null | undefined) => {
  const s = String(v ?? '').replace(/[_:]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}
