import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../icons'
import { LCIconButton } from './Button'
import { LCTabs, type LCTabItem } from './Tabs'
import { cx } from './cx'
import { LC_DUR, LC_SPRING, lcEase, useLcReducedMotion } from './motion'
import './lc-inspector.css'

/**
 * LCInspector — the one contextual inspector.
 *
 * The same spatial component is a property, a buyer, a campaign stage, a
 * workflow node, a calendar event, a closing blocker, a metric, an entity,
 * a queue failure — only the content changes. It floats above the
 * workspace (or docks into the app's grid), keeps the selection visible
 * behind it, and never steals focus from the list that opened it, so arrow
 * keys keep moving through rows while the inspector follows.
 *
 * Selection → object sharpens → inspector emerges from the right edge.
 * Nested detail is a stack with a back step, not a new page.
 */

export interface LCInspectorProps {
  open: boolean
  onClose: () => void
  /** stable id: persists the operator's width */
  id: string
  title: ReactNode
  eyebrow?: ReactNode
  subtitle?: ReactNode
  /** a status mark for the object (LCStatus) */
  status?: ReactNode
  /** header actions: only ones that exist */
  actions?: ReactNode
  tabs?: { items: ReadonlyArray<LCTabItem>; value: string; onChange: (id: string) => void }
  /** changing this crossfades the body (new object, new tab, deeper level) */
  contentKey?: string
  /** nested detail: show a back step to the previous level */
  back?: { label: string; onBack: () => void }
  mode?: 'float' | 'dock'
  width?: number
  minWidth?: number
  maxWidth?: number
  resizable?: boolean
  footer?: ReactNode
  children: ReactNode
  className?: string
  /** accessible name when the title is not plain text */
  label?: string
}

const readWidth = (id: string, fallback: number) => {
  try {
    const v = Number(localStorage.getItem(`lc.inspector.${id}.w`))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch { return fallback }
}

export function LCInspector({
  open, onClose, id, title, eyebrow, subtitle, status, actions, tabs, contentKey, back, mode = 'float',
  width = 420, minWidth = 340, maxWidth = 640, resizable = true, footer, children, className, label,
}: LCInspectorProps) {
  const reduced = useLcReducedMotion()
  const [w, setW] = useState(() => readWidth(id, width))
  const drag = useRef<{ x: number; w: number } | null>(null)
  const rootRef = useRef<HTMLElement>(null)

  const clamp = useCallback((v: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, v))), [minWidth, maxWidth])
  const persist = useCallback((v: number) => { try { localStorage.setItem(`lc.inspector.${id}.w`, String(v)) } catch { /* private mode */ } }, [id])

  // Esc closes the inspector — unless a menu, popover or dialog above it is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-radix-popper-content-wrapper], .lc-dialog[data-state="open"], .lc-sheet[data-state="open"]')) return
      const t = e.target as HTMLElement | null
      if (t && t.closest('input, textarea, [contenteditable="true"]') && !rootRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!resizable) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setW(clamp(drag.current.w + (drag.current.x - e.clientX)))
  }
  const onPointerUp = () => { if (drag.current) { drag.current = null; persist(w) } }
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = clamp(w + step)
    if (e.key === 'ArrowRight') next = clamp(w - step)
    if (e.key === 'Home') next = maxWidth
    if (e.key === 'End') next = minWidth
    if (next !== null) { e.preventDefault(); setW(next); persist(next) }
  }
  const reset = () => { setW(width); persist(width) }

  const name = label ?? (typeof title === 'string' ? title : 'Inspector')

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          ref={rootRef}
          key="lc-inspector"
          role="complementary"
          aria-label={name}
          className={cx('lc-insp', `is-${mode}`, className)}
          style={{ ['--lc-insp-w' as string]: `${w}px` }}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 26, scale: 0.985 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: LC_DUR.fast } } : { opacity: 0, x: 18, transition: { duration: LC_DUR.fast, ease: lcEase('exit') } }}
          transition={reduced ? { duration: LC_DUR.fast } : { ...LC_SPRING.surface, opacity: { duration: LC_DUR.surface, ease: lcEase('enter') } }}
        >
          {resizable ? (
            <div
              className="lc-insp__grip lc-resize-x"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize inspector"
              aria-valuenow={w}
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onHandleKey}
              onDoubleClick={reset}
              title="Drag to resize · double-click to reset"
            />
          ) : null}
          <header className="lc-insp__head">
            {back ? (
              <button type="button" className="lc-insp__back" onClick={back.onBack}>
                <Icon name="chevron-left" size={13} />
                <span>{back.label}</span>
              </button>
            ) : null}
            <div className="lc-insp__titlebar">
              <div className="lc-insp__titles">
                {eyebrow ? <span className="lc-eyebrow lc-insp__eyebrow">{eyebrow}</span> : null}
                <h2 className="lc-insp__title">{title}</h2>
                {subtitle ? <p className="lc-insp__sub">{subtitle}</p> : null}
              </div>
              <div className="lc-insp__actions">
                {actions}
                <LCIconButton icon="x" label="Close" size="sm" shortcut={['Esc']} onClick={onClose} />
              </div>
            </div>
            {status ? <div className="lc-insp__status">{status}</div> : null}
            {tabs ? <LCTabs items={tabs.items} value={tabs.value} onChange={tabs.onChange} label={`${name} sections`} variant="line" className="lc-insp__tabs" /> : null}
          </header>
          <div className="lc-insp__body lc-scroll">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={contentKey ?? 'body'}
                className="lc-insp__content"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.09 } }}
                transition={{ duration: reduced ? LC_DUR.fast : LC_DUR.select, ease: lcEase('enter') }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
          {footer ? <footer className="lc-insp__foot">{footer}</footer> : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

/** A labelled group inside an inspector body. */
export function LCInspectorSection({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('lc-insp__sec', className)}>
      {title || aside ? (
        <header className="lc-insp__sechead">
          {title ? <span className="lc-eyebrow">{title}</span> : <span />}
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/** Label / value facts, aligned, numbers tabular. Missing values say so. */
export function LCFacts({ rows, className }: { rows: ReadonlyArray<{ label: string; value: ReactNode; hint?: string }>; className?: string }) {
  return (
    <dl className={cx('lc-facts', className)}>
      {rows.map((r) => (
        <div key={r.label} className="lc-facts__row" title={r.hint}>
          <dt>{r.label}</dt>
          <dd className="lc-num">{r.value === null || r.value === undefined || r.value === '' ? <span className="lc-facts__none">Not recorded</span> : r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
