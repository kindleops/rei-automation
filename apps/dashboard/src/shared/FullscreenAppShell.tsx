import type { ReactNode } from 'react'
import './fullscreen-app-shell.css'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export interface FullscreenAppShellProps {
  children: ReactNode
  className?: string
  viewId?: string
}

export function FullscreenAppShell({ children, className, viewId }: FullscreenAppShellProps) {
  return (
    <div
      className={cls(
        'nx-fullscreen-app-shell',
        viewId && `is-view-${viewId}`,
        className,
      )}
    >
      {children}
    </div>
  )
}