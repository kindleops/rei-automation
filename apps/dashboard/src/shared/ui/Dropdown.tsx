import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover, type PopoverPlacement } from './Popover'

/**
 * The single dropdown/menu primitive — constitution §11.9–§11.12.
 *
 * Full keyboard support (R11.11): Up/Down, Home/End, type-ahead, Enter, Esc.
 * Search appears automatically above ~8 options (R11.12).
 */

export interface DropdownItem {
  id: string
  label: string
  /** Right-aligned secondary text (count, shortcut, unit). Tabular figures. */
  meta?: string
  icon?: ReactNode
  active?: boolean
  disabled?: boolean
  /** Non-selectable section heading. */
  group?: string
  onSelect?: () => void
}

export interface DropdownProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  items: DropdownItem[]
  label: string
  placement?: PopoverPlacement
  width?: number | string
  /** Force the search field on/off. Default: auto above 8 items. */
  searchable?: boolean
  searchPlaceholder?: string
  /** Rendered above the item list (e.g. a header). */
  header?: ReactNode
  /** Rendered below the item list. */
  footer?: ReactNode
  emptyLabel?: string
}

const SEARCH_THRESHOLD = 8

export const Dropdown = ({
  open,
  anchorRef,
  onClose,
  items,
  label,
  placement = 'bottom-end',
  width = 260,
  searchable,
  searchPlaceholder = 'Search…',
  header,
  footer,
  emptyLabel = 'Nothing here yet.',
}: DropdownProps) => {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const typeAhead = useRef({ buffer: '', at: 0 })
  const listRef = useRef<HTMLDivElement | null>(null)

  const showSearch = searchable ?? items.length > SEARCH_THRESHOLD

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) => item.label.toLowerCase().includes(q))
  }, [items, query])

  const selectable = useMemo(() => filtered.filter((item) => !item.disabled), [filtered])

  /** Position of each rendered item within `selectable`, so the highlighted row
   *  can be resolved without mutating a counter during render. */
  const selectableIndex = useMemo(() => {
    const map = new Map<string, number>()
    let cursor = 0
    for (const item of filtered) {
      if (item.disabled) continue
      map.set(item.id, cursor)
      cursor += 1
    }
    return map
  }, [filtered])

  // Reset on the closed→open transition during render (derived state), not from
  // an effect — an effect here causes a cascading render on every open.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setQuery('')
    const activeIndex = open ? selectable.findIndex((item) => item.active) : -1
    setHighlight(activeIndex >= 0 ? activeIndex : 0)
  }

  const commit = useCallback(
    (item: DropdownItem) => {
      if (item.disabled) return
      item.onSelect?.()
      onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!open) return

    const handleKey = (event: KeyboardEvent) => {
      if (selectable.length === 0) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((i) => (i + 1) % selectable.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((i) => (i - 1 + selectable.length) % selectable.length)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        setHighlight(0)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        setHighlight(selectable.length - 1)
        return
      }
      if (event.key === 'Enter') {
        const item = selectable[highlight]
        if (item) {
          event.preventDefault()
          commit(item)
        }
        return
      }

      // Type-ahead — only when the search field is not handling the keystroke.
      if (
        !showSearch &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const now = Date.now()
        typeAhead.current.buffer =
          now - typeAhead.current.at > 700 ? event.key : typeAhead.current.buffer + event.key
        typeAhead.current.at = now
        const prefix = typeAhead.current.buffer.toLowerCase()
        const index = selectable.findIndex((item) => item.label.toLowerCase().startsWith(prefix))
        if (index >= 0) setHighlight(index)
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, selectable, highlight, commit, showSearch])

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>('.lc-menu__item.is-highlighted')
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      label={label}
      placement={placement}
      width={width}
      role="dialog"
    >
      {header}
      {showSearch ? (
        <div className="lc-popover__search">
          <input
            type="search"
            value={query}
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlight(0)
            }}
          />
        </div>
      ) : null}
      <div className="lc-menu" role="menu" aria-label={label} ref={listRef}>
        {filtered.length === 0 ? (
          <p className="lc-menu__label">{emptyLabel}</p>
        ) : null}
        {filtered.map((item, index) => {
          const previousGroup = index === 0 ? undefined : filtered[index - 1].group
          const showGroup = item.group && item.group !== previousGroup
          const isHighlighted = !item.disabled && selectableIndex.get(item.id) === highlight

          return (
            <div key={item.id}>
              {showGroup ? <div className="lc-menu__label">{item.group}</div> : null}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                aria-current={item.active ? 'true' : undefined}
                className={[
                  'lc-menu__item',
                  item.active && 'is-active',
                  isHighlighted && 'is-highlighted',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => commit(item)}
                style={{ width: '100%' }}
              >
                {item.icon ? <span aria-hidden>{item.icon}</span> : null}
                <span className="lc-menu__item-label">{item.label}</span>
                {item.meta ? <span className="lc-menu__item-meta">{item.meta}</span> : null}
              </button>
            </div>
          )
        })}
      </div>
      {footer}
    </Popover>
  )
}
