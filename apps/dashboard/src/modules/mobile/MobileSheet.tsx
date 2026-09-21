import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import { useBreakpoint } from './useBreakpoint'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type MobileSheetHeight = 'compact' | 'half' | 'full' | 'auto'

export interface MobileSheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
  height?: MobileSheetHeight
  showHandle?: boolean
  subtitle?: string
  headerActions?: React.ReactNode
  /**
   * §11/§13 — a STICKY action footer, pinned above the home indicator while the
   * body scrolls under it. Filters need "Apply" reachable without scrolling to
   * the end of a long option list, and a detail sheet needs its primary action
   * to stay put. Sheets without actions simply omit it and render nothing.
   */
  footer?: React.ReactNode
}

export const MobileSheet = ({
  open,
  title,
  onClose,
  children,
  className,
  height = 'half',
  showHandle = true,
  subtitle,
  headerActions,
  footer,
}: MobileSheetProps) => {
  const { isMobile } = useBreakpoint()

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const sheet = (
    <>
      <button
        type="button"
        className="nx-mobile-sheet-backdrop"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <aside
        className={cls(
          'nx-mobile-sheet',
          `is-height-${height}`,
          isMobile && 'is-portrait-sheet',
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        {showHandle ? (
          <button type="button" className="nx-mobile-sheet__handle" aria-hidden tabIndex={-1} />
        ) : null}
        <header className="nx-mobile-sheet__header">
          <div className="nx-mobile-sheet__title-wrap">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          <div className="nx-mobile-sheet__header-actions">
            {headerActions}
            <button type="button" className="nx-mobile-sheet__close" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className={cls('nx-mobile-sheet__body', Boolean(footer) && 'has-footer')}>{children}</div>
        {footer ? <div className="nx-mobile-sheet__footer">{footer}</div> : null}
      </aside>
    </>
  )

  return createPortal(sheet, document.body)
}