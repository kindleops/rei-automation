import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { LeadState, Reach, StudioNode } from './studio-api'

/* Shared visual language for Workflow Studio (.wfx): liquid colour field,
   counting numerals, identity orbs, a flow ribbon with travelling light,
   a sliding segmented control. Motion respects prefers-reduced-motion (CSS). */

/** Morphing colour bodies behind the glass; tinted gold when something needs you. */
export function LiquidBackdrop({ attention = false }: { attention?: boolean }) {
  return (
    <span className={`wfx-liquid${attention ? ' is-attention' : ''}`} aria-hidden>
      <i /><i /><i /><i />
    </span>
  )
}

/** Numerals that count up to their value once, then follow changes. */
export function CountUp({ value, ms = 900 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setShown(value); from.current = value; return }
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      const e = 1 - Math.pow(1 - p, 3)
      setShown(Math.round(a + (value - a) * e))
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return <>{shown.toLocaleString('en-US')}</>
}

const initials = (name: string | null | undefined, fallback = '•') => {
  const n = String(name || '').replace(/&/g, ' ').trim()
  if (!n) return fallback
  return n.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || fallback
}

/** Identity orb: initials inside a state-coloured liquid ring; breathes when it needs you. */
export function Orb({ name, state, size = 'md' }: { name: string | null | undefined; state: LeadState | 'studio' | 'system'; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`wfx-orb is-${state} is-${size}`} aria-hidden><b>{initials(name)}</b></span>
}

/** A workflow as a ribbon of steps with light travelling along it. */
export function FlowRibbon({ nodes, active = false, compact = false }: { nodes: Array<Pick<StudioNode, 'id' | 'kind' | 'label'>>; active?: boolean; compact?: boolean }) {
  const shown = nodes.filter((n) => n.kind !== 'annotation').slice(0, compact ? 5 : 8)
  return (
    <span className={`wfx-ribbon${active ? ' is-active' : ''}${compact ? ' is-compact' : ''}`} aria-hidden>
      <i className="wfx-ribbon__line" />
      <i className="wfx-ribbon__light" />
      <span className="wfx-ribbon__trigger" />
      {shown.map((n, i) => <span key={n.id} className={`wfx-ribbon__node is-${n.kind}`} style={{ ['--i' as string]: i }} />)}
    </span>
  )
}

/** Segmented control with a liquid indicator that slides between tabs. */
export function Segmented<T extends string>({ tabs, value, onChange, badges = {} }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void; badges?: Partial<Record<T, number>> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-tab="${value}"]`)
    if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth })
  }, [value, tabs.length])
  return (
    <div className="wfx-seg" ref={ref} role="tablist">
      {pill ? <i className="wfx-seg__pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden /> : null}
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} data-tab={t.id} className={value === t.id ? 'is-on' : ''} onClick={() => onChange(t.id)}>
          {t.label}{badges[t.id] ? <em>{badges[t.id]}</em> : null}
        </button>
      ))}
    </div>
  )
}

export const REACH_LABEL: Record<Reach, string> = { operator: 'Alerts you', internal: 'Internal only', seller: 'Seller-facing' }
export function ReachBadge({ reach }: { reach: Reach }) {
  return <span className={`wfx-reach is-${reach}`}>{REACH_LABEL[reach]}</span>
}

export function StatusPill({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`wfx-status is-${status}`}><i />{children ?? status}</span>
}

export function PlusGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
}

export const LEAD_LABEL: Record<LeadState, string> = { needs_you: 'Needs you', failed: 'Failed', waiting: 'Waiting', held: 'Held', running: 'In progress', done: 'Handled' }
