import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type Placement = 'bottom-start' | 'bottom-end'

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
  const [flipLeft, setFlipLeft] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current?.getBoundingClientRect()
    const panel = popoverRef.current
    if (!anchor || !panel) return
    const panelWidth = panel.offsetWidth || 320
    const overflowRight = anchor.left + panelWidth > window.innerWidth - 12
    setFlipLeft(overflowRight && placement === 'bottom-start')
  }, [open, anchorRef, placement])

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

  if (!open) return null

  return (
    <div
      ref={popoverRef}
      className={cls(
        'nx-command-popover nx-liquid-popover',
        placement === 'bottom-end' && 'is-anchor-end',
        flipLeft && 'is-flip-left',
        className,
      )}
      style={{ maxHeight, width }}
      role="dialog"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}