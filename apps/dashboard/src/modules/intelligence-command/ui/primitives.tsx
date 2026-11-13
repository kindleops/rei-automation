import type { ReactNode } from 'react'
import { cx } from '../../../shared/lc'
import type { PlaneFailure } from '../api/ic-client'

/** 16px stroke glyphs in the shell's stroke language (no oversized icons). */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
export type IcGlyphName = 'chat' | 'mission' | 'research' | 'finding' | 'approval' | 'activity' | 'workforce' | 'health' | 'send' | 'stop' | 'retry' | 'expand' | 'collapse' | 'close' | 'at' | 'web' | 'db' | 'model' | 'check' | 'cross' | 'dot' | 'open' | 'plus' | 'full' | 'diff' | 'clock'

export function IcGlyph({ name, size = 14 }: { name: IcGlyphName; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true as const, className: 'ic-g' }
  switch (name) {
    case 'chat': return <svg {...s}><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5" {...P} /></svg>
    case 'mission': return <svg {...s}><path d="M3 13.5V3M3 3.5h8.5l-1.8 2.6 1.8 2.6H3" {...P} /></svg>
    case 'research': return <svg {...s}><circle cx="7" cy="7" r="4" {...P} /><path d="m10 10 3.5 3.5" {...P} /></svg>
    case 'finding': return <svg {...s}><path d="M8 2.5 9.4 6l3.6.3-2.8 2.4.9 3.6L8 10.4l-3.1 1.9.9-3.6L3 6.3 6.6 6z" {...P} /></svg>
    case 'approval': return <svg {...s}><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" {...P} /><path d="m5.5 8.2 1.8 1.8 3.4-4" {...P} /></svg>
    case 'activity': return <svg {...s}><path d="M2 8h2.5l1.5-4 3 8 1.5-4H14" {...P} /></svg>
    case 'workforce': return <svg {...s}><rect x="2.5" y="3" width="4.5" height="4.5" rx="1.2" {...P} /><rect x="9" y="3" width="4.5" height="4.5" rx="1.2" {...P} /><rect x="2.5" y="9.5" width="4.5" height="4" rx="1.2" {...P} /><rect x="9" y="9.5" width="4.5" height="4" rx="1.2" {...P} /></svg>
    case 'health': return <svg {...s}><path d="M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 4.8a2.8 2.8 0 0 1 5.5 1.5C13.5 10.2 8 13.5 8 13.5z" {...P} /></svg>
    case 'send': return <svg {...s}><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" {...P} /></svg>
    case 'stop': return <svg {...s}><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
    case 'retry': return <svg {...s}><path d="M12.6 6.2A5 5 0 1 0 13 9.6" {...P} /><path d="M12.9 3.2v3.3H9.6" {...P} /></svg>
    case 'expand': return <svg {...s}><path d="m4.5 6 3.5 3.5L11.5 6" {...P} /></svg>
    case 'collapse': return <svg {...s}><path d="m4.5 10 3.5-3.5 3.5 3.5" {...P} /></svg>
    case 'close': return <svg {...s}><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" {...P} /></svg>
    case 'at': return <svg {...s}><circle cx="8" cy="8" r="2.6" {...P} /><path d="M10.6 8v1a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.6" {...P} /></svg>
    case 'web': return <svg {...s}><circle cx="8" cy="8" r="5.5" {...P} /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5z" {...P} /></svg>
    case 'db': return <svg {...s}><ellipse cx="8" cy="4" rx="4.5" ry="1.7" {...P} /><path d="M3.5 4v8c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7V4M3.5 8c0 .9 2 1.7 4.5 1.7s4.5-.8 4.5-1.7" {...P} /></svg>
    case 'model': return <svg {...s}><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3z" {...P} /></svg>
    case 'check': return <svg {...s}><path d="m3.5 8.5 3 3 6-7" {...P} /></svg>
    case 'cross': return <svg {...s}><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" {...P} /></svg>
    case 'dot': return <svg {...s}><circle cx="8" cy="8" r="2.2" fill="currentColor" /></svg>
    case 'open': return <svg {...s}><path d="M6 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5v-2M9 2.5h4.5V7M13.5 2.5 7.5 8.5" {...P} /></svg>
    case 'plus': return <svg {...s}><path d="M8 3.5v9M3.5 8h9" {...P} /></svg>
    case 'full': return <svg {...s}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" {...P} /></svg>
    case 'diff': return <svg {...s}><path d="M4 3v6M1 6h6M9.5 11.5h5" {...P} /></svg>
    case 'clock': return <svg {...s}><circle cx="8" cy="8" r="5.5" {...P} /><path d="M8 5v3.2l2 1.3" {...P} /></svg>
  }
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="ic-kbd">{children}</kbd>

/** A plane that could not be read: its true state and the supported next action. */
export function PlaneNotice({ failure, title, onRetry, compact = false }: { failure: PlaneFailure; title?: string; onRetry?: () => void; compact?: boolean }) {
  const head = title ?? (failure.state === 'not_enabled' ? 'Not enabled on this server' : failure.state === 'session' ? 'Session required' : failure.state === 'denied' ? 'Not authorized' : failure.state === 'locked' ? 'Locked by a server switch' : failure.state === 'unavailable' ? 'Unavailable' : 'Could not be read')
  return (
    <div className={cx('ic-notice', `is-${failure.state}`, compact && 'is-compact')} role="status">
      <div className="ic-notice__h"><span className="ic-notice__dot" aria-hidden="true" /><b>{head}</b><code>{failure.status ? `${failure.status} · ` : ''}{failure.code}</code></div>
      <p>{failure.next ?? failure.message}</p>
      {onRetry ? <button type="button" className="ic-link" onClick={onRetry}>Check again</button> : null}
    </div>
  )
}

/** Dot-separated spec line (facts, never pill rows). */
export function Spec({ items, className }: { items: Array<ReactNode | null | false | undefined>; className?: string }) {
  const parts = items.filter((x) => x !== null && x !== false && x !== undefined && x !== '')
  return <span className={cx('ic-spec', className)}>{parts.map((p, i) => <span key={i}>{p}</span>)}</span>
}

export function EmptyLine({ children }: { children: ReactNode }) { return <p className="ic-empty">{children}</p> }

export const usd = (n: number | null | undefined, d?: number) => (n == null || !Number.isFinite(n) ? '—' : `$${n.toFixed(d ?? (n !== 0 && Math.abs(n) < 0.1 ? 4 : 2))}`)
export const ms = (n: number | null | undefined) => (n == null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`)
export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso == null) return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}
export const clock = (iso: string | number | null | undefined) => { if (iso == null) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) }
