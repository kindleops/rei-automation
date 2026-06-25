import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type Placement = 'bottom-start' | 'bottom-end'

type AnchorPosition = {
  top: number
  left: number
}

export const CommandPopover = ({
  open,
  anchorRef,
  onClose,
  children,
  className,
  placement = 'bottom-start',
  maxHeight = 'min(72vh, 640px)',
  width,
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: React.ReactNode
  className?: string
  placement?: Placement
  maxHeight?: string
  width?: number | string
}) => {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<AnchorPosition | null>(null)
  const [flipLeft, setFlipLeft] = useState(false)

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const panel = popoverRef.current
    if (!anchor) return

    const panelWidth = panel?.offsetWidth
      || (typeof width === 'number' ? width : Number.parseFloat(String(width)) || 320)
    const gap = 8
    let left = placement === 'bottom-end' ? anchor.right - panelWidth : anchor.left
    const overflowRight = left + panelWidth > window.innerWidth - 12

    if (overflowRight && placement === 'bottom-start') {
      left = Math.max(12, anchor.right - panelWidth)
      setFlipLeft(true)
    } else {
      setFlipLeft(false)
    }

    if (left < 12) left = 12

    setPosition({
      top: anchor.bottom + gap,
      left,
    })
  }, [anchorRef, placement, width])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handleViewportChange = () => updatePosition()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open, onClose, anchorRef])

  if (!open || !position) return null

  const popover = (
    <div
      ref={popoverRef}
      className={cls(
        'nx-command-popover nx-liquid-popover nx-shell-popover-portal',
        placement === 'bottom-end' && 'is-anchor-end',
        flipLeft && 'is-flip-left',
        className,
      )}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        maxHeight,
        width,
        zIndex: 13000,
      }}
      role="dialog"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(popover, document.body) : null
}