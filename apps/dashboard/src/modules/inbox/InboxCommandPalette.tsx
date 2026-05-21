/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export type InboxCmdCategory =
  | 'Navigation'
  | 'Layout'
  | 'Map'
  | 'Reply'
  | 'Schedule'
  | 'AI'
  | 'Seller'
  | 'Property'
  | 'Status'
  | 'Filters'

export interface InboxCmd {
  id: string
  label: string
  category: InboxCmdCategory
  shortcut?: string
  keywords?: string[]
  requiresThread?: boolean
  action: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  hasThread: boolean
  commands: InboxCmd[]
}

const CATEGORY_ORDER: InboxCmdCategory[] = [
  'Navigation',
  'Layout',
  'Map',
  'Reply',
  'Schedule',
  'AI',
  'Seller',
  'Property',
  'Status',
  'Filters',
]

export function InboxCommandPalette({ open, onClose, hasThread, commands }: Props) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Scroll active item into view — must be above early return to satisfy Rules of Hooks
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  if (!open) return null

  const q = query.toLowerCase().trim()

  const filtered = commands.filter(cmd => {
    if (!q) return true
    return (
      cmd.label.toLowerCase().includes(q) ||
      cmd.category.toLowerCase().includes(q) ||
      (cmd.keywords?.some(k => k.toLowerCase().includes(q)) ?? false)
    )
  })

  const grouped: Partial<Record<InboxCmdCategory, InboxCmd[]>> = {}
  for (const cat of CATEGORY_ORDER) {
    const items = filtered.filter(c => c.category === cat)
    if (items.length) grouped[cat] = items
  }

  const flat = CATEGORY_ORDER.flatMap(cat => grouped[cat] ?? [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = flat[activeIdx]
      if (cmd && !(cmd.requiresThread && !hasThread)) {
        cmd.action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="nx-icp-overlay" onClick={onClose}>
      <div
        className="nx-icp"
        role="dialog"
        aria-label="Inbox command palette"
        onClick={e => e.stopPropagation()}
      >
        <div className="nx-icp__search">
          <Icon name="search" className="nx-icp__search-icon" />
          <input
            ref={inputRef}
            className="nx-icp__input"
            placeholder="Search commands…"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={handleKeyDown}
            aria-label="Search inbox commands"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="nx-icp__esc-hint" aria-hidden="true">Esc</span>
        </div>

        {!hasThread && (
          <p className="nx-icp__context-hint">No thread selected — thread actions are disabled</p>
        )}

        <div className="nx-icp__list" ref={listRef} role="listbox" aria-label="Commands">
          {CATEGORY_ORDER.map(cat => {
            const items = grouped[cat]
            if (!items?.length) return null
            return (
              <div key={cat} className="nx-icp__group" role="group" aria-label={cat}>
                <div className="nx-icp__group-label">{cat}</div>
                {items.map(cmd => {
                  const idx = flat.indexOf(cmd)
                  const disabled = !!(cmd.requiresThread && !hasThread)
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      role="option"
                      aria-selected={idx === activeIdx}
                      aria-disabled={disabled}
                      data-idx={idx}
                      className={cls(
                        'nx-icp__item',
                        idx === activeIdx && 'is-active',
                        disabled && 'is-disabled',
                      )}
                      onMouseEnter={() => { if (!disabled) setActiveIdx(idx) }}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (!disabled) { cmd.action(); onClose() }
                      }}
                      tabIndex={-1}
                    >
                      <span className="nx-icp__item-label">{cmd.label}</span>
                      {cmd.shortcut && <kbd className="nx-icp__shortcut">{cmd.shortcut}</kbd>}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {flat.length === 0 && (
            <p className="nx-icp__empty">No commands match "{query}"</p>
          )}
        </div>
      </div>
    </div>
  )
}
