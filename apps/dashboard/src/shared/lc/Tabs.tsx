import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import { Icon, type IconName } from '../icons'
import { cx } from './cx'
import { LC_SPRING, useLcReducedMotion } from './motion'
import './lc-controls.css'

/**
 * LCTabs — app subnav and modes (Overview / Flow / Table …).
 *
 * A lens moves under the selected tab (shared layout animation, scoped per
 * tab set); arrows / Home / End move selection like a real tablist and only
 * the selected tab is a tab stop. Counts and a status dot are optional and
 * should carry real numbers only. Overflow scrolls inside itself with edge
 * fades, and the selected tab is always scrolled fully into view.
 * No capsule around every tab.
 */

export interface LCTabItem<V extends string = string> {
  id: V
  label: string
  icon?: IconName
  count?: number | null
  /** semantic dot: attn = something there needs the operator */
  tone?: 'exec' | 'ok' | 'attn' | 'crit' | 'flow'
  disabled?: boolean
  /** why it's disabled, as a tooltip */
  reason?: string
  /** id of the panel this tab controls, when there is one */
  controls?: string
}

export interface LCTabsProps<V extends string = string> {
  items: ReadonlyArray<LCTabItem<V>>
  value: V
  onChange: (id: V) => void
  label: string
  /** lens (default) or a thin line under the selected tab */
  variant?: 'lens' | 'line'
  className?: string
  /** prefetch hook: pointer/focus reached a tab before it was chosen */
  onIntent?: (id: V) => void
}

export function LCTabs<V extends string = string>({ items, value, onChange, label, variant = 'lens', className, onIntent }: LCTabsProps<V>) {
  const group = useId()
  const reduced = useLcReducedMotion()
  const track = useRef<HTMLDivElement>(null)
  const enabled = items.filter((t) => !t.disabled)
  const selectedIndex = Math.max(0, enabled.findIndex((t) => t.id === value))

  useLayoutEffect(() => {
    const node = track.current
    if (!node) return
    const edges = () => {
      const rest = node.scrollWidth - node.clientWidth - node.scrollLeft
      node.toggleAttribute('data-fade-start', node.scrollLeft > 1)
      node.toggleAttribute('data-fade-end', rest > 1)
    }
    edges()
    node.addEventListener('scroll', edges, { passive: true })
    const ro = new ResizeObserver(edges)
    ro.observe(node)
    return () => { node.removeEventListener('scroll', edges); ro.disconnect() }
  }, [items.length])

  const first = useRef(true)
  useEffect(() => {
    const node = track.current
    const btn = node?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!node || !btn || node.scrollWidth <= node.clientWidth) { first.current = false; return }
    const room = 22
    const start = btn.offsetLeft - room
    const end = btn.offsetLeft + btn.offsetWidth + room - node.clientWidth
    const left = node.scrollLeft > start ? start : node.scrollLeft < end ? end : node.scrollLeft
    if (left !== node.scrollLeft) node.scrollTo({ left: Math.max(0, left), behavior: first.current || reduced ? 'auto' : 'smooth' })
    first.current = false
  }, [value, reduced])

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = enabled.length - 1
    const next = e.key === 'ArrowRight' ? (selectedIndex >= last ? 0 : selectedIndex + 1)
      : e.key === 'ArrowLeft' ? (selectedIndex <= 0 ? last : selectedIndex - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (next < 0 || !enabled[next]) return
    e.preventDefault()
    onChange(enabled[next].id)
    track.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(enabled[next].id)}"]`)?.focus({ preventScroll: true })
  }

  return (
    <LayoutGroup id={group}>
      <div ref={track} role="tablist" aria-label={label} className={cx('lc-tabs', variant === 'line' && 'is-line', className)}>
        {items.map((t) => {
          const on = t.id === value
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={on}
              aria-controls={t.controls}
              aria-disabled={t.disabled || undefined}
              title={t.disabled ? t.reason : undefined}
              tabIndex={on ? 0 : -1}
              className="lc-tab"
              onClick={() => { if (!t.disabled) onChange(t.id) }}
              onKeyDown={onKeyDown}
              onPointerEnter={onIntent ? () => onIntent(t.id) : undefined}
              onFocus={onIntent ? () => onIntent(t.id) : undefined}
            >
              {on ? <motion.span className="lc-tab__lens" layoutId="lens" transition={reduced ? { duration: 0 } : LC_SPRING.snappy} aria-hidden="true" /> : null}
              {t.icon ? <Icon name={t.icon} size={14} aria-hidden="true" /> : null}
              <span>{t.label}</span>
              {typeof t.count === 'number' ? <span className="lc-tab__count">{t.count.toLocaleString('en-US')}</span> : null}
              {t.tone ? <span className="lc-tab__dot" data-tone={t.tone} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}

export interface LCSegmentOption<V extends string = string> {
  value: V
  label?: string
  icon?: IconName
  /** accessible name when the option is icon-only */
  title?: string
  accessory?: ReactNode
}

export interface LCSegmentedProps<V extends string = string> {
  options: ReadonlyArray<LCSegmentOption<V>>
  value: V
  onChange: (value: V) => void
  label: string
  size?: 'sm' | 'md'
  className?: string
  onIntent?: (value: V) => void
}

/** A small set of mutually exclusive view choices — never long navigation. */
export function LCSegmented<V extends string = string>({ options, value, onChange, label, size = 'md', className, onIntent }: LCSegmentedProps<V>) {
  const group = useId()
  const reduced = useLcReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (idx === last ? 0 : idx + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (idx === 0 ? last : idx - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (next < 0) return
    e.preventDefault()
    onChange(options[next].value)
    ref.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(options[next].value)}"]`)?.focus({ preventScroll: true })
  }
  return (
    <LayoutGroup id={group}>
      <div ref={ref} role="radiogroup" aria-label={label} className={cx('lc-seg', `is-${size}`, className)}>
        {options.map((o, i) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              data-seg={o.value}
              aria-checked={on}
              aria-label={o.label ? undefined : o.title}
              title={!o.label ? o.title : undefined}
              tabIndex={i === idx ? 0 : -1}
              className="lc-seg__opt"
              onClick={() => onChange(o.value)}
              onKeyDown={onKeyDown}
              onPointerEnter={onIntent ? () => onIntent(o.value) : undefined}
            >
              {on ? <motion.span className="lc-seg__lens" layoutId="seg" transition={reduced ? { duration: 0 } : LC_SPRING.snappy} aria-hidden="true" /> : null}
              {o.icon ? <Icon name={o.icon} size={13} aria-hidden="true" /> : null}
              {o.label ? <span>{o.label}</span> : null}
              {o.accessory}
            </button>
          )
        })}
      </div>
    </LayoutGroup>
  )
}
