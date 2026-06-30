import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'

interface PipelineMobileDetailSheetProps {
  open: boolean
  title?: string
  subtitle?: string
  immersive?: boolean
  onClose: () => void
  children: ReactNode
}

export function PipelineMobileDetailSheet({
  open,
  title,
  subtitle,
  immersive = false,
  onClose,
  children,
}: PipelineMobileDetailSheetProps) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="plv-mobile-sheet-root" role="presentation">
      <button
        type="button"
        className="plv-mobile-sheet__backdrop"
        aria-label="Close deal detail"
        onClick={onClose}
      />
      <div className={`plv-mobile-sheet${immersive ? ' plv-mobile-sheet--immersive' : ''}`} role="dialog" aria-label={title ?? 'Deal detail'}>
        {!immersive && <div className="plv-mobile-sheet__handle" aria-hidden />}
        {!immersive && (
          <header className="plv-mobile-sheet__header">
            <div className="plv-mobile-sheet__titles">
              {title && <strong>{title}</strong>}
              {subtitle && <span>{subtitle}</span>}
            </div>
            <button type="button" className="plv-mobile-sheet__close" onClick={onClose} aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          </header>
        )}
        <div className="plv-mobile-sheet__body">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}