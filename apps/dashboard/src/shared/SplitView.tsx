/**
 * SplitView — NEXUS Context Split Panel
 *
 * Slides open from the right edge, occupying ~45% of the stage width.
 * Provides focus-mode detail for threads, leads, alerts, or any entity
 * without losing the parent surface context behind it.
 *
 * Keyboard: `Escape` closes, `Z` toggles full-width mode.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './icons'
import { playSound } from './sounds'

export type SplitViewSize = 'narrow' | 'standard' | 'wide'

interface SplitViewProps {
  open: boolean
  title: string
  subtitle?: string
  size?: SplitViewSize
  badge?: ReactNode
  children: ReactNode
  onClose: () => void
}

const sizeClass: Record<SplitViewSize, string> = {
  narrow: 'nx-split--narrow',
  standard: 'nx-split--standard',
  wide: 'nx-split--wide',
}

export const SplitView = ({
  open,
  title,
  subtitle,
  size = 'standard',
  badge,
  children,
  onClose,
}: SplitViewProps) => {
  const [fullWidth, setFullWidth] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const handleClose = useCallback(() => {
    playSound('ui-tap')
    setFullWidth(false)
    onClose()
  }, [onClose])

  const toggleFullWidth = useCallback(() => {
    setFullWidth((prev) => !prev)
    playSound('ui-tap')
  }, [])

  useEffect(() => {
    if (!open) {
      setFullWidth(false)
      return
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleClose()
      }
      if (e.key === 'z' || e.key === 'Z') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
          e.preventDefault()
          toggleFullWidth()
        }
      }
    }

    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [open, handleClose, toggleFullWidth])

  // Focus trap — scroll to top on open
  useEffect(() => {
    if (open) {
      panelRef.current?.scrollTo({ top: 0 })
      playSound('ui-confirm')
    }
  }, [open])

  if (!open) return null

  return (
    <div className="nx-split-overlay">
      <button className="nx-split-scrim" type="button" onClick={handleClose} aria-label="Close split view" />
      <aside
        className={`nx-split ${sizeClass[size]} ${fullWidth ? 'nx-split--full' : ''}`}
        ref={panelRef}
        role="dialog"
        aria-label={title}
      >
        <header className="nx-split__header">
          <div className="nx-split__title-group">
            <h2 className="nx-split__title">{title}</h2>
            {subtitle && <span className="nx-split__subtitle">{subtitle}</span>}
            {badge}
          </div>
          <div className="nx-split__controls">
            <button
              type="button"
              className="nx-split__btn"
              onClick={toggleFullWidth}
              title="Toggle full width (Z)"
            >
              <Icon name="maximize" className="nx-split__btn-icon" />
            </button>
            <button
              type="button"
              className="nx-split__btn"
              onClick={handleClose}
              title="Close (Escape)"
            >
              <Icon name="close" className="nx-split__btn-icon" />
            </button>
          </div>
        </header>
        <div className="nx-split__body">
          {children}
        </div>
      </aside>
    </div>
  )
}
