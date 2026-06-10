import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { CommandResult, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { useGlobalCommandSearch } from './useGlobalCommandSearch'
import './global-command.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

type Props = {
  open: boolean
  initialQuery?: string
  context: GlobalCommandSearchContext
  onClose: () => void
  onExecute: (result: CommandResult) => void
}

const themeClassFor = (theme: string | null | undefined): string | null => {
  if (!theme) return null
  return `map-theme-${theme.replace(/_/g, '-')}`
}

export const GlobalCommandOverlay = ({
  open,
  initialQuery = '',
  context,
  onClose,
  onExecute,
}: Props) => {
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const { results, loading, groupedResults } = useGlobalCommandSearch(query, context)

  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setActiveIndex(0)
    window.setTimeout(() => inputRef.current?.focus(), 32)
  }, [initialQuery, open])

  useEffect(() => {
    if (!open) return
    const active = listRef.current?.querySelector(`[data-command-index="${activeIndex}"]`) as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const displayGroups = useMemo(() => {
    const bestIds = new Set(groupedResults.bestMatches.map((item) => item.id))
    return groupedResults.groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => !bestIds.has(item.id)),
    })).filter((group) => group.items.length > 0)
  }, [groupedResults.bestMatches, groupedResults.groups])
  const orderedResults = useMemo(
    () => [...groupedResults.bestMatches, ...displayGroups.flatMap((group) => group.items)],
    [displayGroups, groupedResults.bestMatches],
  )

  if (!open) return null

  const activeResult = orderedResults[activeIndex] ?? groupedResults.bestMatches[0] ?? null

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(orderedResults.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const next = orderedResults[activeIndex]
      if (next && !next.meta?.disabled) onExecute(next)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let runningIndex = -1

  return (
    <div className={cls('gcc-overlay', themeClassFor(context.activeMapTheme))} onClick={onClose}>
      <div className="gcc-shell" role="dialog" aria-modal aria-label="Global command center" onClick={(event) => event.stopPropagation()}>
        <div className="gcc-shell__chrome" />
        <div className="gcc-search">
          <div className="gcc-search__icon"><Icon name="command" /></div>
          <div className="gcc-search__copy">
            <span className="gcc-search__label">Inbox Command</span>
            <input
              ref={inputRef}
              className="gcc-search__input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search sellers, buyers, addresses, locations, markets, actions…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search inbox sellers, buyers, properties, markets, filters, actions"
            />
          </div>
          <div className="gcc-search__meta">
            {loading ? <span className="gcc-search__loading">Searching…</span> : null}
            <kbd>ESC</kbd>
          </div>
        </div>

        <div className="gcc-layout">
          <div className="gcc-results" ref={listRef}>
            {groupedResults.bestMatches.length > 0 ? (
              <section className="gcc-group">
                <header className="gcc-group__header">Best Matches</header>
                <div className="gcc-group__items">
                  {groupedResults.bestMatches.map((result) => {
                    runningIndex += 1
                    const isActive = runningIndex === activeIndex
                    return (
                      <button
                        key={result.id}
                        type="button"
                        className={cls('gcc-item', isActive && 'is-active', result.meta?.disabled && 'is-disabled')}
                        data-command-index={runningIndex}
                        onMouseEnter={() => setActiveIndex(runningIndex)}
                        onClick={() => onExecute(result)}
                      >
                        <span className="gcc-item__icon"><Icon name={result.icon || 'command'} /></span>
                        <span className="gcc-item__copy">
                          <strong>{result.title}</strong>
                          <small>{result.subtitle}</small>
                        </span>
                        <span className="gcc-item__meta">
                          {result.badge ? <b>{result.badge}</b> : null}
                          <em>{result.meta?.hint || (result.route ? 'Open' : 'Run')}</em>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ) : null}

            {displayGroups.map((group) => (
              <section key={group.key} className="gcc-group">
                <header className="gcc-group__header">{group.label}</header>
                <div className="gcc-group__items">
                  {group.items.map((result) => {
                    runningIndex += 1
                    const isActive = runningIndex === activeIndex
                    return (
                      <button
                        key={result.id}
                        type="button"
                        className={cls('gcc-item', isActive && 'is-active', result.meta?.disabled && 'is-disabled')}
                        data-command-index={runningIndex}
                        onMouseEnter={() => setActiveIndex(runningIndex)}
                        onClick={() => onExecute(result)}
                      >
                        <span className="gcc-item__icon"><Icon name={result.icon || 'command'} /></span>
                        <span className="gcc-item__copy">
                          <strong>{result.title}</strong>
                          <small>{result.subtitle}</small>
                        </span>
                        <span className="gcc-item__meta">
                          {result.badge ? <b>{result.badge}</b> : null}
                          <em>{result.meta?.hint || (result.route ? 'Enter' : 'Run')}</em>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}

            {!loading && results.length === 0 ? (
              <div className="gcc-empty">
                <strong>No matches yet</strong>
                <span>Try a seller, buyer, market, address, queue state, or map theme.</span>
              </div>
            ) : null}
          </div>

          <aside className="gcc-preview">
            <div className="gcc-preview__eyebrow">{activeResult?.preview?.eyebrow || 'Preview'}</div>
            <h3>{activeResult?.preview?.title || 'Command Center'}</h3>
            <p>{activeResult?.preview?.summary || 'Search Inbox and its associated workspaces for sellers, buyers, markets, properties, queue context, and safe actions.'}</p>
            <div className="gcc-preview__details">
              {(activeResult?.preview?.details ?? []).map((detail) => (
                <div key={`${detail.label}-${detail.value}`} className="gcc-preview__detail">
                  <span>{detail.label}</span>
                  <strong>{detail.value}</strong>
                </div>
              ))}
            </div>
            {activeResult ? (
              <div className="gcc-preview__footer">
                <span>{activeResult.type.replace(/_/g, ' ')}</span>
                <b>{activeResult.route || activeResult.action?.label || 'Execute'}</b>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  )
}
