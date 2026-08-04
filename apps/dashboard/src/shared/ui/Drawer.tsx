import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './useFocusTrap'

/**
 * The single drawer/sheet primitive — constitution §11.6–§11.8.
 *
 * Desktop: right edge. Mobile: bottom sheet with a visible drag handle.
 * §11.7 non-blocking by default — the workspace stays interactive and no scrim
 * is painted unless `modal` is set.
 * §11.8 one drawer per side is the caller's contract; this primitive never
 * stacks its own.
 */

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  side?: 'right' | 'left' | 'bottom'
  /** Paint a scrim and trap focus. Default false (§11.7). */
  modal?: boolean
  className?: string
  restoreFocusRef?: React.RefObject<HTMLElement | null>
}

export const Drawer = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'right',
  modal = false,
  className,
  restoreFocusRef,
}: DrawerProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useFocusTrap(panelRef, { open, onClose, trap: modal, restoreFocusRef })

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      {modal ? (
        <div className="lc-scrim lc-scrim--drawer" onMouseDown={onClose} aria-hidden />
      ) : null}
      <aside
        ref={panelRef}
        className={['lc-ui', 'lc-drawer', `lc-drawer--${side}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        {side === 'bottom' ? <span className="lc-drawer__handle" aria-hidden /> : null}
        <header className="lc-drawer__header">
          <div className="lc-drawer__titles">
            <h2 className="lc-drawer__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="lc-drawer__description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className="lc-ui-btn lc-ui-btn--quiet lc-ui-btn--icon" aria-label="Close" onClick={onClose}>
            <span aria-hidden>✕</span>
          </button>
        </header>
        <div className="lc-drawer__body">{children}</div>
        {footer ? <footer className="lc-drawer__footer">{footer}</footer> : null}
      </aside>
    </>,
    document.body,
  )
}
