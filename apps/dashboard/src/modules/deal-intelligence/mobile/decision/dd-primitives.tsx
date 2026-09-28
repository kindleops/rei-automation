import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import type { IconName } from '../../../../shared/icons'

export const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Count a number up from its previous value. Instant under reduced motion. */
export function useCountUp(target: number | null, ms = 900): number | null {
  const [v, setV] = useState<number | null>(target)
  const from = useRef<number>(0)
  useEffect(() => {
    if (target === null) { setV(null); return }
    if (reducedMotion()) { setV(target); from.current = target; return }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms)
      const e = 1 - (1 - p) ** 4
      setV(a + (target - a) * e)
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

/** A collapsible card. The header must say something useful on its own. */
export function DdCard({
  id, title, icon, meta, children, defaultOpen = true, tone, action,
}: {
  id: string
  title: string
  icon: IconName
  meta?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  tone?: 'warn' | 'bad' | 'good'
  action?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cls('ddx-card', open && 'is-open', tone && `is-${tone}`)} data-dd-card={id}>
      <button type="button" className="ddx-card__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ddx-card__icon"><Icon name={icon} /></span>
        <span className="ddx-card__title">{title}</span>
        {meta ? <span className="ddx-card__meta">{meta}</span> : null}
        <Icon name="chevron-down" className="ddx-card__caret" />
      </button>
      {open ? <div className="ddx-card__body">{children}{action ? <div className="ddx-card__action">{action}</div> : null}</div> : null}
    </section>
  )
}

export const ProvenanceChip = ({ p }: { p: 'seller' | 'record' | 'system' | 'engine' | 'offer' | 'mls' | string }) => {
  const label = p === 'seller' ? 'Seller said' : p === 'record' ? 'Record' : p === 'system' || p === 'engine' ? 'System' : p === 'mls' ? 'MLS' : p === 'offer' ? 'Offer' : p
  return <span className={cls('ddx-prov', `is-${p}`)}>{label}</span>
}

export function DdLink({ icon, label, sub, onClick, disabled }: { icon: IconName; label: string; sub?: string | null; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="ddx-link" onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
      <span className="ddx-link__label">{label}{sub ? <small>{sub}</small> : null}</span>
      <Icon name="arrow-up-right" className="ddx-link__go" />
    </button>
  )
}

/** A thin meter. `value` 0–100. */
export const Meter = ({ value, tone }: { value: number | null; tone?: string }) => (
  <span className="ddx-meter" aria-hidden="true">
    <span className="ddx-meter__fill" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, ...(tone ? { background: tone } : {}) }} />
  </span>
)

/**
 * Reveal-on-scroll. Children rise, sharpen and fade in once as they enter the
 * viewport; reduced motion shows them immediately. One observer per element is
 * fine here — a decision surface has a few dozen blocks, not a feed.
 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(() => reducedMotion())
  useEffect(() => {
    if (shown) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); io.disconnect() }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [shown])
  return (
    <div ref={ref} className={cls('ddx-reveal', shown && 'is-in', className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

/** Circular gauge, 0–100. The arc draws in on mount. */
export function Ring({ value, size = 44, stroke = 4, tone, label }: { value: number | null; size?: number; stroke?: number; tone?: string; label?: ReactNode }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <span className="ddx-ring" style={{ width: size, height: size, ...(tone ? { ['--ring' as string]: tone } : {}) }} aria-label={value === null ? 'unknown' : `${Math.round(v)} of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="ddx-ring__track" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} className="ddx-ring__arc" strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ ['--c' as string]: c }} />
      </svg>
      <span className="ddx-ring__label">{label ?? (value === null ? '—' : Math.round(v))}</span>
    </span>
  )
}

/** Section chapter heading: index, title, a line that draws across. */
export const Chapter = ({ index, title, meta }: { index: string; title: string; meta?: ReactNode }) => (
  <div className="ddx-chapter">
    <span className="ddx-chapter__index">{index}</span>
    <span className="ddx-chapter__title">{title}</span>
    <span className="ddx-chapter__rule" aria-hidden="true" />
    {meta ? <span className="ddx-chapter__meta">{meta}</span> : null}
  </div>
)
