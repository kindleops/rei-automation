import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { Icon, type IconName } from '../icons'
import { cx } from './cx'
import { LC_DUR, LC_SPRING, lcEase, useLcReducedMotion } from './motion'
import './lc-overlay.css'

/**
 * LCSelect — a choice among a few known options (metric, view, sort,
 * group-by, map mode, time range).
 *
 * The trigger MORPHS rather than snaps: the shown value rolls in the
 * direction of the list (a later option rises from below, an earlier one
 * drops from above) and the trigger's width springs to the new label —
 * Arc's free Select/Dropdown recipes (MIT), on Radix Select for listbox
 * semantics, typeahead and collision handling. Lists past ~30 options or
 * ones that need search belong in LCCombobox, not here.
 */

export interface LCSelectOption<V extends string = string> {
  value: V
  label: string
  hint?: string
  icon?: IconName | ReactNode
  disabled?: boolean
  /** options sharing a group render under one quiet heading */
  group?: string
}

export interface LCSelectProps<V extends string = string> {
  value: V | null | undefined
  onChange: (value: V) => void
  options: ReadonlyArray<LCSelectOption<V>>
  /** accessible name; also the visible prefix for `quiet` triggers unless `prefix` is set */
  label: string
  /** visible text before the value, e.g. "Group by" */
  prefix?: string
  placeholder?: string
  variant?: 'field' | 'quiet' | 'chip'
  size?: 'sm' | 'md'
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  className?: string
  /** minimum width of the list surface */
  menuWidth?: number
}

const iconOf = (icon: IconName | ReactNode | undefined) =>
  icon === undefined || icon === null ? null : typeof icon === 'string' ? <Icon name={icon as IconName} size={14} /> : icon

/** the value rolls in the direction of the list; reduced motion crossfades */
const ROLL: Variants = {
  enter: (d: number) => ({ opacity: 0, y: `${d * 0.42}em`, filter: 'blur(3px)' }),
  center: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: LC_DUR.select + 0.04, ease: lcEase('enter') } },
  exit: (d: number) => ({ opacity: 0, y: `${d * -0.36}em`, filter: 'blur(2px)', transition: { duration: LC_DUR.fast, ease: lcEase('standard') } }),
}
const FADE: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: LC_DUR.fast } },
  exit: { opacity: 0, transition: { duration: 0 } },
}

function RollingValue({ text, index }: { text: string; index: number }) {
  const reduced = useLcReducedMotion()
  const [prevIndex, setPrevIndex] = useState(index)
  const [dir, setDir] = useState(1)
  if (prevIndex !== index) {
    setPrevIndex(index)
    setDir(index >= prevIndex ? 1 : -1)
  }
  const measure = useRef<HTMLSpanElement>(null)
  const seen = useRef<string | null>(null)
  const [w, setW] = useState<{ width: number | 'auto'; animate: boolean }>({ width: 'auto', animate: false })
  useLayoutEffect(() => {
    const node = measure.current
    if (!node) return
    const ro = new ResizeObserver(([entry]) => {
      const current = node.textContent
      const animate = seen.current !== null && seen.current !== current
      seen.current = current
      setW({ width: Math.ceil(entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth), animate })
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [])
  return (
    <motion.span className="lc-select__value" initial={false} animate={{ width: w.width }} transition={w.animate && !reduced ? LC_SPRING.morph : { duration: 0 }}>
      <span ref={measure} className="lc-select__measure" aria-hidden="true">{text}</span>
      <AnimatePresence initial={false} custom={dir}>
        <motion.span
          key={text}
          className="lc-select__text"
          custom={dir}
          variants={reduced ? FADE : ROLL}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  )
}

export function LCSelect<V extends string = string>({
  value, onChange, options, label, prefix, placeholder = 'Choose…', variant = 'field', size = 'md', disabled, align = 'start', className, menuWidth,
}: LCSelectProps<V>) {
  const reduced = useLcReducedMotion()
  const index = options.findIndex((o) => o.value === value)
  const current = index >= 0 ? options[index] : null
  const [hl, setHl] = useState<{ top: number; height: number; glide: boolean } | null>(null)
  const pointer = useRef(false)
  const groups: Array<{ name: string | null; items: Array<LCSelectOption<V>> }> = []
  for (const o of options) {
    const g = o.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.name === g) last.items.push(o)
    else groups.push({ name: g, items: [o] })
  }
  const shownPrefix = prefix ?? (variant === 'quiet' ? label : null)
  return (
    <SelectPrimitive.Root value={value ?? undefined} onValueChange={(v) => onChange(v as V)} disabled={disabled} onOpenChange={(o) => { if (o) setHl(null) }}>
      <SelectPrimitive.Trigger
        className={cx('lc-select', `is-${variant}`, `is-${size}`, !current && 'is-empty', className)}
        aria-label={label}
      >
        {shownPrefix ? <span className="lc-select__prefix">{shownPrefix}</span> : null}
        {current?.icon ? <span className="lc-select__icon" aria-hidden="true">{iconOf(current.icon)}</span> : null}
        <span className="lc-sr-only"><SelectPrimitive.Value placeholder={placeholder} /></span>
        <span aria-hidden="true" className="lc-select__shown">
          <RollingValue text={current ? current.label : placeholder} index={index} />
        </span>
        <SelectPrimitive.Icon className="lc-select__chev"><Icon name="chevron-down" size={13} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="lc-menu is-select"
          position="popper"
          side="bottom"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          style={menuWidth ? { minWidth: menuWidth } : undefined}
          onPointerMoveCapture={() => { pointer.current = true }}
          onKeyDownCapture={() => { pointer.current = false }}
          onFocus={(e) => {
            const item = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-lc-row]') : null
            if (!item) return
            const glide = pointer.current
            setHl((cur) => ({ top: item.offsetTop, height: item.offsetHeight, glide: glide && cur !== null }))
          }}
        >
          <SelectPrimitive.ScrollUpButton className="lc-menu__scroll"><Icon name="chevron-up" size={13} /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="lc-menu__viewport">
            <motion.span
              className="lc-menu__hl"
              aria-hidden="true"
              initial={false}
              animate={hl ? { y: hl.top, height: hl.height, opacity: 1 } : { opacity: 0 }}
              transition={{ default: hl?.glide && !reduced ? LC_SPRING.snappy : { duration: 0 }, opacity: { duration: reduced ? 0 : 0.08 } }}
            />
            {groups.map((g, gi) => (
              <SelectPrimitive.Group key={`${g.name ?? 'g'}-${gi}`}>
                {g.name ? <SelectPrimitive.Label className="lc-menu__label">{g.name}</SelectPrimitive.Label> : null}
                {g.items.map((o, i) => (
                  <SelectPrimitive.Item
                    key={o.value}
                    value={o.value}
                    disabled={o.disabled}
                    className={cx('lc-menu__row', o.hint && 'has-hint')}
                    data-lc-row=""
                    style={{ ['--i' as string]: i }}
                  >
                    <span className="lc-menu__icon" aria-hidden="true">{iconOf(o.icon)}</span>
                    <span className="lc-menu__text">
                      <SelectPrimitive.ItemText><span className="lc-menu__name">{o.label}</span></SelectPrimitive.ItemText>
                      {o.hint ? <span className="lc-menu__hint">{o.hint}</span> : null}
                    </span>
                    <SelectPrimitive.ItemIndicator className="lc-menu__check"><Icon name="check" size={14} /></SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="lc-menu__scroll"><Icon name="chevron-down" size={13} /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
