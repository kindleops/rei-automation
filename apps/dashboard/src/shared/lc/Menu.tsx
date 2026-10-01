import { useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as ContextPrimitive from '@radix-ui/react-context-menu'
import { motion } from 'framer-motion'
import { Icon, type IconName } from '../icons'
import type { LCMenuEntry } from './menu-model'
import { cx } from './cx'
import { LC_SPRING, useLcReducedMotion } from './motion'
import './lc-overlay.css'

/**
 * LCMenu / LCContextMenu — one menu grammar for actions.
 *
 * Radix owns the behaviour that makes a menu trustworthy (roving focus,
 * typeahead, submenus, Esc, focus return, collision-aware placement). The
 * feel is Arc's free Dropdown/Context Menu recipe (MIT), re-made for
 * LeadCommand: one highlight that GLIDES between rows for the pointer and
 * jumps instantly for the keyboard, rows that settle in a short stagger,
 * and a surface that grows from its trigger.
 *
 * Product rules the item model enforces:
 * · only actions that exist — a row that cannot run says WHY (`reason`)
 *   instead of being a dead control;
 * · destructive rows are red; nothing else is.
 */

type Prims = typeof DropdownPrimitive | typeof ContextPrimitive

const renderIcon = (icon: IconName | ReactNode | undefined) =>
  icon === undefined || icon === null ? null : typeof icon === 'string' ? <Icon name={icon as IconName} size={15} /> : icon

/** One highlight per surface. Pointer → glide; keyboard → jump. */
function useGlide() {
  const reduced = useLcReducedMotion()
  const [hl, setHl] = useState<{ top: number; height: number; danger: boolean; glide: boolean } | null>(null)
  const pointer = useRef(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const item = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-lc-row]') : null
    window.clearTimeout(timer.current)
    if (!item) {
      timer.current = window.setTimeout(() => setHl(null), pointer.current ? 70 : 0)
      return
    }
    const next = { top: item.offsetTop, height: item.offsetHeight, danger: item.dataset.tone === 'danger' }
    const glide = pointer.current
    setHl((cur) => ({ ...next, glide: glide && cur !== null }))
  }
  const highlight = (
    <motion.span
      className="lc-menu__hl"
      data-tone={hl?.danger ? 'danger' : undefined}
      aria-hidden="true"
      initial={false}
      animate={hl ? { y: hl.top, height: hl.height, opacity: 1 } : { opacity: 0 }}
      transition={{ default: hl?.glide && !reduced ? LC_SPRING.snappy : { duration: 0 }, opacity: { duration: reduced ? 0 : 0.08 } }}
    />
  )
  return {
    highlight,
    surfaceProps: {
      onFocus,
      onPointerMoveCapture: () => { pointer.current = true },
      onKeyDownCapture: () => { pointer.current = false },
    },
    reset: () => { window.clearTimeout(timer.current); setHl(null) },
  }
}

function Rows({ P, entries }: { P: Prims; entries: LCMenuEntry[] }) {
  let i = 0
  return (
    <>
      {entries.map((e) => {
        if (e.kind === 'separator') return <P.Separator key={e.id} className="lc-menu__sep" />
        if (e.kind === 'label') return <P.Label key={e.id} className="lc-menu__label">{e.label}</P.Label>
        if (e.kind === 'sub') {
          return (
            <P.Sub key={e.id}>
              <P.SubTrigger className="lc-menu__row" data-lc-row="" style={{ ['--i' as string]: i++ }}>
                <span className="lc-menu__icon" aria-hidden="true">{renderIcon(e.icon)}</span>
                <span className="lc-menu__text"><span className="lc-menu__name">{e.label}</span></span>
                <Icon name="chevron-right" size={13} className="lc-menu__more" aria-hidden="true" />
              </P.SubTrigger>
              <P.Portal>
                <SubSurface P={P} entries={e.items} />
              </P.Portal>
            </P.Sub>
          )
        }
        const idx = i++
        const body = (
          <>
            <span className="lc-menu__icon" aria-hidden="true">
              {e.checked !== undefined ? (e.checked ? <Icon name="check" size={14} /> : null) : renderIcon(e.icon)}
            </span>
            <span className="lc-menu__text">
              <span className="lc-menu__name">{e.label}</span>
              {e.disabled && e.reason ? <span className="lc-menu__hint is-reason">{e.reason}</span> : e.hint ? <span className="lc-menu__hint">{e.hint}</span> : null}
            </span>
            {e.shortcut ? <kbd className="lc-kbd lc-menu__kbd">{e.shortcut}</kbd> : null}
          </>
        )
        const common = {
          className: cx('lc-menu__row', e.tone === 'danger' && 'is-danger', e.hint || (e.disabled && e.reason) ? 'has-hint' : null),
          'data-lc-row': '',
          'data-tone': e.tone,
          disabled: e.disabled,
          style: { ['--i' as string]: idx },
        }
        return e.checked !== undefined ? (
          <P.CheckboxItem key={e.id} {...common} checked={e.checked} onCheckedChange={() => e.onSelect?.()} onSelect={(ev) => ev.preventDefault()}>
            {body}
          </P.CheckboxItem>
        ) : (
          <P.Item key={e.id} {...common} onSelect={() => e.onSelect?.()}>
            {body}
          </P.Item>
        )
      })}
    </>
  )
}

function SubSurface({ P, entries }: { P: Prims; entries: LCMenuEntry[] }) {
  const g = useGlide()
  return (
    <P.SubContent className="lc-menu is-sub" sideOffset={4} collisionPadding={12} {...g.surfaceProps}>
      {g.highlight}
      <Rows P={P} entries={entries} />
    </P.SubContent>
  )
}

export interface LCMenuProps {
  trigger: ReactElement
  items: LCMenuEntry[]
  /** accessible name of the menu */
  label?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** a quiet heading inside the surface, e.g. the object the actions apply to */
  title?: ReactNode
}

export function LCMenu({ trigger, items, label, side = 'bottom', align = 'end', width, open, onOpenChange, title }: LCMenuProps) {
  const g = useGlide()
  return (
    <DropdownPrimitive.Root open={open} onOpenChange={(next) => { if (next) g.reset(); onOpenChange?.(next) }}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          className="lc-menu"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          loop
          aria-label={label}
          style={width ? { width } : undefined}
          {...g.surfaceProps}
        >
          {title ? <div className="lc-menu__title">{title}</div> : null}
          {g.highlight}
          <Rows P={DropdownPrimitive} entries={items} />
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  )
}

export interface LCContextMenuProps {
  /** the object that owns the menu (a row, a node, a card) */
  children: ReactElement
  items: LCMenuEntry[]
  label?: string
  title?: ReactNode
  disabled?: boolean
}

/** Right-click (or Shift+F10 / the Menu key) on the object opens its actions at the pointer. */
export function LCContextMenu({ children, items, label, title, disabled }: LCContextMenuProps) {
  const g = useGlide()
  if (disabled || !items.length) return children
  return (
    <ContextPrimitive.Root onOpenChange={(next) => { if (next) g.reset() }}>
      <ContextPrimitive.Trigger asChild>{children}</ContextPrimitive.Trigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.Content className="lc-menu is-context" collisionPadding={12} loop aria-label={label} {...g.surfaceProps}>
          {title ? <div className="lc-menu__title">{title}</div> : null}
          {g.highlight}
          <Rows P={ContextPrimitive} entries={items} />
        </ContextPrimitive.Content>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Root>
  )
}
