import { useEffect } from 'react'
import { Icon } from '../../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const CommandDrawer = ({
  open,
  title,
  onClose,
  children,
  className,
  fullWidth,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
  fullWidth?: boolean
}) => {
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  return (
    <>
      <button
        type="button"
        className="nx-command-drawer-backdrop"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <aside
        className={cls('nx-command-drawer nx-liquid-panel', fullWidth && 'is-full-width', className)}
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="nx-command-drawer__header">
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="nx-command-drawer__body">{children}</div>
      </aside>
    </>
  )
}