/**
 * ANALYTICS LAB — small UI primitives (desktop): popover, menu, segmented
 * control, status mark, value + delta. Popovers are Level 3 glass anchored
 * inside the Lab root, so they stay inside the pane that owns them.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, RefObject } from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import type { MetricChange, MetricDef, MetricStatus } from '../../../domain/analytics/analytics-lab-api'
import { changeTone, fmtChange, fmtP } from '../../../domain/analytics/analytics-lab-api'

export const cls = (...t: Array<string | false | null | undefined | 0>) => t.filter(Boolean).join(' ')

/** Close on outside pointer / Escape. */
export function useDismiss(open: boolean, onClose: () => void, refs: Array<RefObject<HTMLElement | null>>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!refs.some((r) => r.current?.contains(e.target as Node))) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose])
}

/** A trigger + an anchored Level-3 panel. The panel keeps inside the Lab root. */
export function Popover({ label, icon, active, children, className, width = 280, align = 'start', title, disabled }: {
  label: ReactNode; icon?: IconName; active?: boolean; children: (close: () => void) => ReactNode; className?: string; width?: number; align?: 'start' | 'end'; title?: string; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number; w: number } | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useDismiss(open, () => setOpen(false), [btn, panel])
  // close when the workspace scrolls: the panel is anchored to where the trigger was
  useEffect(() => {
    if (!open) return
    const scroller = btn.current?.closest('.alab__main')
    const close = () => setOpen(false)
    scroller?.addEventListener('scroll', close, { passive: true })
    return () => scroller?.removeEventListener('scroll', close)
  }, [open])
  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const root = btn.current.closest('.alab') as HTMLElement | null
    setHost(root)
    const rb = btn.current.getBoundingClientRect()
    const rr = root?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, right: window.innerWidth, bottom: window.innerHeight }
    const w = Math.min(width, rr.width - 16)
    let left = (align === 'end' ? rb.right - w : rb.left) - rr.left
    left = Math.max(8, Math.min(left, rr.width - w - 8))
    const top = rb.bottom - rr.top + 6
    setPos({ left, top, maxH: Math.max(160, rr.height - top - 12), w })
  }, [open, width, align])
  return (
    <span className={cls('lab-pop', className)}>
      <button ref={btn} type="button" className={cls('lab-ctl', (active || open) && 'is-on')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={title} disabled={disabled}>
        {icon ? <Icon name={icon} /> : null}{label}<Icon name="chevron-down" className="lab-ctl__chev" />
      </button>
      {open && pos && host ? createPortal(
        <div ref={panel} className={cls('lab-pop__panel', className && `${className}__panel`)} role="dialog" style={{ left: pos.left, top: pos.top, width: pos.w, maxHeight: pos.maxH }}>
          {children(() => setOpen(false))}
        </div>,
        host,
      ) : null}
    </span>
  )
}

export type MenuItem = { key: string; label: ReactNode; hint?: ReactNode; disabled?: boolean; reason?: string; checked?: boolean }
export function Menu({ items, onPick }: { items: MenuItem[]; onPick: (key: string) => void }) {
  return (
    <ul className="lab-menu" role="listbox">
      {items.map((it) => (
        <li key={it.key}>
          <button type="button" role="option" aria-selected={Boolean(it.checked)} disabled={it.disabled} onClick={() => onPick(it.key)} title={it.disabled ? it.reason : undefined}>
            <span className="lab-menu__check">{it.checked ? <Icon name="check" /> : null}</span>
            <span className="lab-menu__label">{it.label}{it.disabled && it.reason ? <small>{it.reason}</small> : it.hint ? <small>{it.hint}</small> : null}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ key: T; label: ReactNode; disabled?: boolean; title?: string }>; onChange: (k: T) => void; label: string }) {
  return (
    <div className="lab-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" role="tab" aria-selected={value === o.key} className={cls(value === o.key && 'is-on')} disabled={o.disabled} title={o.title} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  )
}

const STATUS_TEXT: Record<MetricStatus, string> = {
  ok: '', no_data: 'No data', insufficient_sample: 'Small sample', unavailable: 'Unavailable', not_applicable: 'Not filterable',
}
export function StatusMark({ status, reason, n }: { status: MetricStatus; reason?: string; n?: number }) {
  if (status === 'ok') return null
  return <span className={cls('lab-status', `s-${status}`)} title={reason}>{STATUS_TEXT[status]}{status === 'insufficient_sample' && n !== undefined ? ` · n=${n}` : ''}</span>
}

/** Delta: sign + arrow + tone (never colour alone), p-value on hover. */
export function Delta({ def, change, compact }: { def?: MetricDef; change?: MetricChange; compact?: boolean }) {
  if (!change) return null
  if (!change.comparable) return <span className="lab-delta is-muted" title={change.reason || undefined}>{compact ? 'not compared' : change.reason ? 'not compared' : '—'}</span>
  const text = fmtChange(def, change)
  if (!text) return null
  const tone = changeTone(def, change)
  const d = change.kind === 'rate' ? change.pts ?? 0 : change.delta ?? 0
  const p = fmtP(change.p)
  return (
    <span className={cls('lab-delta', `t-${tone}`, change.significant && 'is-sig')} title={[p, change.significant ? 'statistically meaningful (p < 0.05)' : 'within normal variation', change.ciPts ? `95% CI ${change.ciPts[0].toFixed(1)} to ${change.ciPts[1].toFixed(1)} pts` : null].filter(Boolean).join(' · ')}>
      <i aria-hidden="true">{d > 0 ? '▲' : d < 0 ? '▼' : '•'}</i>{text}{!compact && change.significant ? <em className="lab-sig">sig.</em> : null}
    </span>
  )
}

export function Empty({ icon = 'database', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="lab-empty">
      <Icon name={icon} />
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  )
}
