import { useEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface WorkflowGlassModalProps {
  open: boolean
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: 'sm' | 'md' | 'lg'
}

export const WorkflowGlassModal = ({
  open,
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 'md',
}: WorkflowGlassModalProps) => {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  return createPortal(
    <div className="wfs2-modal-root" role="presentation" onClick={onClose}>
      <section
        className={cls('wfs2-modal', `is-${width}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wfs2-modal__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="wfs2__btn is-ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="wfs2-modal__body">{children}</div>
        {footer ? <footer className="wfs2-modal__foot">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  )
}