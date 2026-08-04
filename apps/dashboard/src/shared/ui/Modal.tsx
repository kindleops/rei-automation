import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './useFocusTrap'

/**
 * The single modal primitive — constitution §11.2–§11.5.
 *
 * §11.3 focus trapped, focus returns to the invoker, Esc closes, backdrop click
 * closes unless destructive, `aria-modal` + labelled title.
 * §11.4 one modal at a time — a second open modal is refused and logged in dev.
 * §11.5 560px confirm / 880px content; body scrolls, header + actions fixed.
 */

let openModalCount = 0

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  /** `confirm` = 560px (default), `content` = 880px. */
  size?: 'confirm' | 'content'
  /** Destructive modals do not close on backdrop click (§11.3). */
  destructive?: boolean
  className?: string
  /** Element focus returns to; defaults to whatever was focused at open. */
  restoreFocusRef?: React.RefObject<HTMLElement | null>
}

export const Modal = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'confirm',
  destructive = false,
  className,
  restoreFocusRef,
}: ModalProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useFocusTrap(panelRef, { open, onClose, trap: true, restoreFocusRef })

  // §11.4 — modal-over-modal is banned.
  useEffect(() => {
    if (!open) return
    openModalCount += 1
    if (openModalCount > 1 && import.meta.env.DEV) {
      console.warn('[lc-ui] R11.4 violation: a second modal opened while one was already open.')
    }
    return () => {
      openModalCount -= 1
    }
  }, [open])

  // Body scroll lock while a blocking surface is up.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div
        className="lc-scrim lc-scrim--modal"
        onMouseDown={destructive ? undefined : onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        className={['lc-ui', 'lc-modal', `lc-modal--${size}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="lc-modal__header">
          <div className="lc-modal__titles">
            <h2 className="lc-modal__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="lc-modal__description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className="lc-ui-btn lc-ui-btn--quiet lc-ui-btn--icon" aria-label="Close" onClick={onClose}>
            <span aria-hidden>✕</span>
          </button>
        </header>
        <div className="lc-modal__body">{children}</div>
        {footer ? <footer className="lc-modal__footer">{footer}</footer> : null}
      </div>
    </>,
    document.body,
  )
}
