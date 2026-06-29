import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import type { CommandResult } from '../../domain/command-center/command.types'
import { useMobileKeyboardInset } from './useMobileKeyboardInset'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export interface MobileSearchOverlayProps {
  open: boolean
  query: string
  loading: boolean
  groups: Array<{ key: string; label: string; items: CommandResult[] }>
  activeIndex: number
  onQueryChange: (value: string) => void
  onActiveIndexChange: (index: number) => void
  onSubmit: (result: CommandResult | undefined) => void
  onClose: () => void
}

export const MobileSearchOverlay = ({
  open,
  query,
  loading,
  groups,
  activeIndex,
  onQueryChange,
  onActiveIndexChange,
  onSubmit,
  onClose,
}: MobileSearchOverlayProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const keyboardInset = useMobileKeyboardInset(open)
  const items = groups.flatMap((group) => group.items)
  const showResults = open && (loading || items.length > 0 || query.trim().length >= 2)

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <button type="button" className="nx-mobile-search-backdrop" aria-label="Close search" onClick={onClose} />
      <div
        className="nx-mobile-search-layer"
        role="search"
        style={keyboardInset > 0 ? {
          maxHeight: `calc(100dvh - var(--nx-mobile-chrome-top, 72px) - ${keyboardInset}px - 8px)`,
        } : undefined}
      >
        <div className="nx-mobile-search-layer__field nx-liquid-surface">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search sellers, buyers, addresses, conversations…"
            aria-label="Universal search"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                onActiveIndexChange(Math.min(activeIndex + 1, Math.max(items.length - 1, 0)))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                onActiveIndexChange(Math.max(activeIndex - 1, 0))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                onSubmit(items[activeIndex])
              }
            }}
          />
          <button type="button" className="nx-mobile-search-layer__close" onClick={onClose} aria-label="Close search">
            <Icon name="close" />
          </button>
        </div>

        {showResults ? (
          <div className="nx-mobile-search-layer__results nx-mobile-sheet is-height-half is-portrait-sheet">
            <header className="nx-mobile-sheet__header">
              <div className="nx-mobile-sheet__title-wrap">
                <strong>Universal Search</strong>
                <small>{loading ? 'Searching…' : `${items.length} matches`}</small>
              </div>
            </header>
            <div className="nx-mobile-sheet__body nx-search-results-list">
              {groups.map((group) => (
                <section key={group.key} className="nx-search-result-group">
                  <header className="nx-search-result-group__label">{group.label}</header>
                  {group.items.map((result) => {
                    const index = items.findIndex((item) => item.id === result.id)
                    return (
                      <button
                        key={result.id}
                        type="button"
                        className={cls('nx-search-result-item', index === activeIndex && 'is-active')}
                        onClick={() => onSubmit(result)}
                      >
                        <span className="nx-search-result-item__row">
                          <strong>{result.title}</strong>
                          {result.badge ? <em>{result.badge}</em> : null}
                        </span>
                        <small>{result.subtitle}</small>
                      </button>
                    )
                  })}
                </section>
              ))}
              {!loading && items.length === 0 ? (
                <div className="nx-search-results-empty">
                  <strong>No matches</strong>
                  <span>Try a seller, buyer, address, or queue status.</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  )
}