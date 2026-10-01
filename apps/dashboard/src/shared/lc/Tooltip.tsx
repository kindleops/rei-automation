import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import './lc-overlay.css'

/**
 * LCTooltip — the one tooltip.
 *
 * Interaction after Arc's free Tooltip (MIT): the first tooltip waits a
 * beat, and while any tooltip is open — and for a short window after the
 * last one closes — the next opens instantly, so sweeping across a toolbar
 * reads every label without a delay each time. Radix supplies the
 * accessibility: aria-describedby, hover AND keyboard focus, Esc.
 * LeadCommand supplies the look and the keyboard hint.
 */

const DELAY = 320
const SKIP_WINDOW = 360

let warm = false
let openCount = 0
let coolTimer = 0
const listeners = new Set<() => void>()
const warmth = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  get: () => warm,
  set(next: boolean) { if (warm === next) return; warm = next; listeners.forEach((l) => l()) },
  opened() { openCount += 1; window.clearTimeout(coolTimer); warmth.set(true) },
  closed() {
    openCount = Math.max(0, openCount - 1)
    if (openCount) return
    window.clearTimeout(coolTimer)
    coolTimer = window.setTimeout(() => warmth.set(false), SKIP_WINDOW)
  },
}

export interface LCTooltipProps {
  content: ReactNode
  children: ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** keys shown as a hint, e.g. ['⌘', 'K'] */
  shortcut?: string[]
  disabled?: boolean
  /** override the first-open delay (ms) */
  delay?: number
}

export function LCTooltip({ content, children, side = 'top', align = 'center', shortcut, disabled, delay = DELAY }: LCTooltipProps) {
  const isWarm = useSyncExternalStore(warmth.subscribe, warmth.get, () => false)
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  useEffect(() => {
    if (!open) return
    warmth.opened()
    return warmth.closed
  }, [open])
  if (disabled || content === null || content === undefined || content === '') return children
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={0}>
      <TooltipPrimitive.Root
        open={open}
        delayDuration={isWarm ? 0 : delay}
        onOpenChange={(next) => { if (next) setInstant(warmth.get()); setOpen(next) }}
      >
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="lc-tip"
            data-instant={instant || undefined}
            side={side}
            align={align}
            sideOffset={8}
            collisionPadding={12}
          >
            <span className="lc-tip__text">{content}</span>
            {shortcut?.length ? (
              <span className="lc-tip__keys" aria-hidden="true">
                {shortcut.map((k) => <kbd key={k} className="lc-kbd">{k}</kbd>)}
              </span>
            ) : null}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
