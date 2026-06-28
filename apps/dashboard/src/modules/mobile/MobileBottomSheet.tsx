import { useCallback, useRef, useState, type ReactNode } from 'react'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type BottomSheetSnap = 'collapsed' | 'half' | 'expanded'

interface MobileBottomSheetProps {
  open: boolean
  title?: string
  snap?: BottomSheetSnap
  onSnapChange?: (snap: BottomSheetSnap) => void
  onClose?: () => void
  children: ReactNode
  className?: string
}

const SNAP_OFFSET: Record<BottomSheetSnap, string> = {
  collapsed: '22vh',
  half: '48vh',
  expanded: '78vh',
}

export const MobileBottomSheet = ({
  open,
  title,
  snap: controlledSnap,
  onSnapChange,
  onClose,
  children,
  className,
}: MobileBottomSheetProps) => {
  const [internalSnap, setInternalSnap] = useState<BottomSheetSnap>('half')
  const snap = controlledSnap ?? internalSnap
  const dragRef = useRef<{ startY: number; startSnap: BottomSheetSnap } | null>(null)

  const setSnap = useCallback((next: BottomSheetSnap) => {
    if (onSnapChange) onSnapChange(next)
    else setInternalSnap(next)
  }, [onSnapChange])

  const cycleSnap = useCallback(() => {
    const order: BottomSheetSnap[] = ['collapsed', 'half', 'expanded']
    const idx = order.indexOf(snap)
    setSnap(order[(idx + 1) % order.length])
  }, [setSnap, snap])

  if (!open) return null

  return (
    <>
      {onClose ? (
        <button type="button" className="nx-mobile-sheet-backdrop" aria-label="Close sheet" onClick={onClose} />
      ) : null}
      <aside
        className={cls('nx-mobile-bottom-sheet', `is-${snap}`, className)}
        style={{ maxHeight: SNAP_OFFSET[snap] }}
        role="dialog"
        aria-label={title || 'Details'}
      >
        <div
          className="nx-mobile-bottom-sheet__handle"
          role="button"
          tabIndex={0}
          aria-label="Resize sheet"
          onClick={cycleSnap}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSnap() } }}
          onPointerDown={(e) => {
            dragRef.current = { startY: e.clientY, startSnap: snap }
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            const drag = dragRef.current
            dragRef.current = null
            if (!drag) return
            const delta = e.clientY - drag.startY
            if (delta > 40) {
              if (snap === 'expanded') setSnap('half')
              else if (snap === 'half') setSnap('collapsed')
              else onClose?.()
            } else if (delta < -40) {
              if (snap === 'collapsed') setSnap('half')
              else if (snap === 'half') setSnap('expanded')
            }
          }}
        />
        {title ? <header className="nx-mobile-bottom-sheet__title">{title}</header> : null}
        <div className="nx-mobile-bottom-sheet__body">{children}</div>
      </aside>
    </>
  )
}