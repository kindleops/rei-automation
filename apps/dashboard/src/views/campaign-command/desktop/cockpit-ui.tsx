import type { ReactNode } from 'react'
import type { ExecState } from './cockpit-model'

export const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const STATE_GLYPH: Record<ExecState['key'], string> = {
  running: '●',
  waiting: '◐',
  degraded: '▲',
  needs_you: '!',
  paused: 'Ⅱ',
  scheduled: '◷',
  ready: '○',
  draft: '○',
  completed: '✓',
  archived: '▫',
}

/** Status is never colour alone: a glyph and a word ride with the tone. */
export function StateChip({ state, size = 'md' }: { state: ExecState; size?: 'sm' | 'md' }) {
  return (
    <span className={cls('cpk-state', `is-${state.tone}`, `is-${state.key}`, size === 'sm' && 'is-sm')}>
      <span className="cpk-state__glyph" aria-hidden="true">{STATE_GLYPH[state.key]}</span>
      <span className="cpk-state__label">{state.label}</span>
    </span>
  )
}

export function Section({ title, meta, children, className, action }: { title: string; meta?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cls('cpk-sec', className)}>
      <header className="cpk-sec__head">
        <h3 className="cpk-sec__title">{title}</h3>
        {meta ? <span className="cpk-sec__meta">{meta}</span> : null}
        {action ? <span className="cpk-sec__action">{action}</span> : null}
      </header>
      {children}
    </section>
  )
}

/** A label/value line. `value` null reads "Unavailable", never 0. */
export function Spec({ label, value, sub, tone, mono }: { label: string; value: ReactNode | null; sub?: ReactNode; tone?: string | null; mono?: boolean }) {
  return (
    <div className={cls('cpk-spec', tone && `is-${tone}`)}>
      <dt className="cpk-spec__label">{label}</dt>
      <dd className={cls('cpk-spec__value', mono && 'is-mono')}>
        {value === null || value === undefined ? <span className="cpk-na">Unavailable</span> : value}
        {sub ? <span className="cpk-spec__sub">{sub}</span> : null}
      </dd>
    </div>
  )
}

export function Unavailable({ what }: { what: string }) {
  return <p className="cpk-unavail">{what} unavailable — the read did not answer. Nothing is assumed.</p>
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="cpk-skel" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${92 - i * 17}%` }} />)}
    </div>
  )
}

export function Bar({ pct, tone = 'exec' }: { pct: number; tone?: string }) {
  const v = Math.max(0, Math.min(100, pct))
  return (
    <span className={cls('cpk-bar', `is-${tone}`)} role="presentation">
      <span className="cpk-bar__fill" style={{ width: `${v}%` }} />
    </span>
  )
}

export function formatPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (d.length !== 10) return String(raw ?? '—') || '—'
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}
