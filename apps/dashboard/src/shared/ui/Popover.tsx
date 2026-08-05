import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './useFocusTrap'
import { useRoutePath } from '../../app/router'

/**
 * The single popover primitive — constitution §11.9–§11.12, surface level 4.
 *
 * Replaces the hand-rolled portals in `modules/shell/primitives/CommandPopover`
 * and `modules/shell/WorkspaceLauncher`, neither of which had any focus
 * handling, Esc, or route-change dismissal.
 *
 *  - anchored, collision aware: flips and shifts to stay in the viewport
 *  - closes on outside click, Esc, scroll of an ancestor container, route change
 *  - focus moves in on open and returns to the anchor on close
 *  - z-index comes from the single scale (`--lc-z-popover`), never a literal
 */

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PopoverProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  /** Accessible name — required, this is a labelled dialog surface. */
  label: string
  className?: string
  placement?: PopoverPlacement
  width?: number | string
  maxHeight?: string
  /** Cycle Tab within the popover. Menus want this; inline editors may not. */
  trapFocus?: boolean
  role?: 'dialog' | 'menu' | 'listbox'
}

const GAP = 8
const EDGE = 12

export const Popover = ({
  open,
  anchorRef,
  onClose,
  children,
  label,
  className,
  placement = 'bottom-start',
  width,
  maxHeight = 'min(72vh, 640px)',
  trapFocus = true,
  role = 'dialog',
}: PopoverProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const routePath = useRoutePath()
  const openRoute = useRef(routePath)

  // Reset the measured position on the open→closed transition during render
  // (the React-blessed derived-state pattern) rather than from an effect.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setPosition(null)
  }

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (!anchor) return
    const panel = panelRef.current

    const panelWidth =
      panel?.offsetWidth ||
      (typeof width === 'number' ? width : Number.parseFloat(String(width)) || 280)
    const panelHeight = panel?.offsetHeight || 0

    const alignEnd = placement.endsWith('end')
    let left = alignEnd ? anchor.right - panelWidth : anchor.left

    // shift within the viewport
    if (left + panelWidth > window.innerWidth - EDGE) {
      left = window.innerWidth - panelWidth - EDGE
    }
    if (left < EDGE) left = EDGE

    // flip vertically when the preferred side has no room
    const wantsTop = placement.startsWith('top')
    const belowSpace = window.innerHeight - anchor.bottom - GAP - EDGE
    const aboveSpace = anchor.top - GAP - EDGE
    const placeAbove = wantsTop
      ? aboveSpace > panelHeight || aboveSpace > belowSpace
      : panelHeight > belowSpace && aboveSpace > belowSpace

    const top = placeAbove
      ? Math.max(EDGE, anchor.top - GAP - panelHeight)
      : anchor.bottom + GAP

    setPosition({ top, left })
  }, [anchorRef, placement, width])

  useLayoutEffect(() => {
    if (!open) return
    openRoute.current = routePath
    updatePosition()
    // Re-measure once the panel has real dimensions.
    const raf = requestAnimationFrame(updatePosition)
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition, routePath])

  useEffect(() => {
    if (!open) return
    const handle = () => updatePosition()
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [open, updatePosition])

  // §11.10 — scroll of the anchor's container dismisses.
  useEffect(() => {
    if (!open) return
    const handleScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [open, onClose])

  // §11.10 — route change dismisses.
  useEffect(() => {
    if (!open) return
    if (routePath !== openRoute.current) onClose()
  }, [open, routePath, onClose])

  // §11.10 — outside click dismisses.
  useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open, onClose, anchorRef])

  useFocusTrap(panelRef, {
    open,
    onClose,
    trap: trapFocus,
    restoreFocusRef: anchorRef,
  })

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      className={['lc-ui', 'lc-popover', className].filter(Boolean).join(' ')}
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width,
        maxHeight,
        visibility: position ? 'visible' : 'hidden',
      }}
      role={role}
      aria-label={label}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
