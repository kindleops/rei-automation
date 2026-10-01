import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { List, useListRef, type RowComponentProps } from 'react-window'
import { Icon, type IconName } from '../icons'
import { cx } from './cx'
import './lc-overlay.css'

/**
 * LCCombobox — search and pick one object: seller, property, market,
 * campaign, workflow, buyer, entity, title company.
 *
 * Focus never leaves the input (role=combobox + aria-activedescendant), so
 * typing and arrowing are one gesture. Static lists filter locally; `load`
 * searches the server with a debounce and aborts the previous request.
 * Long result sets are virtualized (react-window) — the list stays at 60fps
 * with thousands of rows. Interaction after Arc's free Combobox (MIT);
 * the async + virtual parts are LeadCommand's.
 */

export interface LCComboOption {
  value: string
  label: string
  /** second line: "Seller · 3831 Sheridan Ave N" */
  sub?: string
  /** short object kind for the glyph tile: Seller, Property, Campaign… */
  kind?: string
  icon?: IconName | ReactNode
  /** right-aligned quiet fact (count, stage, market) */
  meta?: string
  group?: string
  disabled?: boolean
  keywords?: string[]
}

export interface LCComboboxProps {
  label: string
  value?: string | null
  onChange: (value: string, option: LCComboOption) => void
  options?: ReadonlyArray<LCComboOption>
  load?: (query: string, signal: AbortSignal) => Promise<LCComboOption[]>
  /** characters before an async search runs */
  minQuery?: number
  /** shown when the query is empty */
  recent?: ReadonlyArray<LCComboOption>
  /** label of the current value when it isn't in `options` (async pickers) */
  selectedLabel?: string
  placeholder?: string
  icon?: IconName
  emptyText?: string
  clearable?: boolean
  onClear?: () => void
  autoFocus?: boolean
  className?: string
  disabled?: boolean
}

type Row = { type: 'group'; label: string } | { type: 'option'; option: LCComboOption; index: number }

const VIRTUAL_AFTER = 60
const ROW_H = 36
const ROW_H_SUB = 46

const matches = (o: LCComboOption, q: string) => {
  if (!q) return true
  const needle = q.toLocaleLowerCase()
  return [o.label, o.sub ?? '', o.meta ?? '', ...(o.keywords ?? [])].some((t) => t.toLocaleLowerCase().includes(needle))
}

export function LCCombobox({
  label, value, onChange, options, load, minQuery, recent, selectedLabel, placeholder = 'Search…', icon = 'search',
  emptyText = 'No matches', clearable = true, onClear, autoFocus, className, disabled,
}: LCComboboxProps) {
  const id = useId()
  const listId = `${id}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useListRef(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const [result, setResult] = useState<{ key: string; rows: LCComboOption[]; error: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const min = minQuery ?? (load ? 2 : 0)
  const trimmed = query.trim()
  // the request the list should be showing; loading = it hasn't answered yet
  const requestKey = load && open && trimmed.length >= min ? `${trimmed}\u0000${attempt}` : null
  const settled = result && result.key === requestKey ? result : null
  const loading = requestKey !== null && !settled
  const error = settled?.error ?? null

  const current = useMemo(() => {
    if (!value) return null
    return options?.find((o) => o.value === value) ?? recent?.find((o) => o.value === value) ?? (selectedLabel ? { value, label: selectedLabel } : null)
  }, [value, options, recent, selectedLabel])

  // async search: debounce, abort the previous request, one automatic retry
  useEffect(() => {
    if (!load || requestKey === null) return
    const key = requestKey
    const q = key.split('\u0000')[0]
    const ctl = new AbortController()
    const t = window.setTimeout(async () => {
      for (let tryNo = 0; tryNo < 2; tryNo += 1) {
        try {
          const rows = await load(q, ctl.signal)
          if (ctl.signal.aborted) return
          setResult({ key, rows, error: null })
          return
        } catch {
          if (ctl.signal.aborted) return
          if (tryNo === 1) setResult({ key, rows: [], error: 'Search didn’t respond' })
          else await new Promise((r) => window.setTimeout(r, 400))
        }
      }
    }, 160)
    return () => { ctl.abort(); window.clearTimeout(t) }
  }, [load, requestKey])

  const shown = useMemo<LCComboOption[]>(() => {
    const q = query.trim()
    if (!q && recent?.length) return [...recent]
    if (load) return settled?.rows ?? (result?.rows ?? [])
    return (options ?? []).filter((o) => matches(o, q))
  }, [query, recent, load, settled, result, options])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    let last: string | undefined
    const recentMode = !query.trim() && Boolean(recent?.length)
    shown.forEach((option, index) => {
      const g = recentMode ? 'Recent' : option.group
      if (g && g !== last) { out.push({ type: 'group', label: g }); last = g }
      out.push({ type: 'option', option, index })
    })
    return out
  }, [shown, query, recent])
  const optionRows = useMemo(() => rows.flatMap((r, i) => (r.type === 'option' ? [i] : [])), [rows])
  const hasSub = shown.some((o) => o.sub)
  const rowH = hasSub ? ROW_H_SUB : ROW_H
  const virtual = rows.length > VIRTUAL_AFTER

  const [activeFor, setActiveFor] = useState(optionRows)
  if (activeFor !== optionRows) {
    setActiveFor(optionRows)
    setActive(optionRows.length ? 0 : -1)
  }

  const scrollToRow = useCallback((rowIndex: number) => {
    if (rowIndex < 0) return
    if (virtual) { listRef.current?.scrollToRow({ index: rowIndex, align: 'auto' }); return }
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-row="${rowIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [virtual, listRef])

  const choose = (o: LCComboOption) => {
    if (o.disabled) return
    onChange(o.value, o)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = optionRows.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (!n) return
      const next = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n
      setActive(next)
      scrollToRow(optionRows[next])
    } else if (e.key === 'Home' && open && n) { e.preventDefault(); setActive(0); scrollToRow(optionRows[0]) }
    else if (e.key === 'End' && open && n) { e.preventDefault(); setActive(n - 1); scrollToRow(optionRows[n - 1]) }
    else if (e.key === 'PageDown' && open && n) { e.preventDefault(); const next = Math.min(n - 1, active + 8); setActive(next); scrollToRow(optionRows[next]) }
    else if (e.key === 'PageUp' && open && n) { e.preventDefault(); const next = Math.max(0, active - 8); setActive(next); scrollToRow(optionRows[next]) }
    else if (e.key === 'Enter') {
      if (open && active >= 0) {
        e.preventDefault()
        const r = rows[optionRows[active]]
        if (r && r.type === 'option') choose(r.option)
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
      else if (query) { e.preventDefault(); setQuery('') }
    } else if (e.key === 'Tab') setOpen(false)
  }

  const activeRow = active >= 0 ? optionRows[active] : -1
  const optionId = (rowIndex: number) => `${id}-opt-${rowIndex}`
  const q = query.trim()
  const needMore = Boolean(load) && q.length < min && !(recent?.length && !q)

  const renderRow = (r: Row, rowIndex: number, style?: CSSProperties) => {
    if (r.type === 'group') return <div key={`g-${rowIndex}`} className="lc-combo__group" style={style} role="presentation">{r.label}</div>
    const o = r.option
    const selected = o.value === value
    return (
      <div
        key={o.value}
        id={optionId(rowIndex)}
        data-row={rowIndex}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled || undefined}
        className={cx('lc-combo__opt', rowIndex === activeRow && 'is-active')}
        style={style}
        onPointerMove={() => { const k = optionRows.indexOf(rowIndex); if (k !== active) setActive(k) }}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => choose(o)}
      >
        {o.kind || o.icon ? (
          <span className="lc-combo__kind" aria-hidden="true">
            {o.icon ? (typeof o.icon === 'string' ? <Icon name={o.icon as IconName} size={13} /> : o.icon) : o.kind?.slice(0, 1)}
          </span>
        ) : null}
        <span className="lc-combo__text">
          <span className="lc-combo__label">{o.label}</span>
          {o.sub ? <span className="lc-combo__sub">{o.kind ? `${o.kind} · ${o.sub}` : o.sub}</span> : null}
        </span>
        {o.meta ? <span className="lc-combo__meta">{o.meta}</span> : null}
        {selected ? <Icon name="check" size={13} className="lc-menu__check" aria-hidden="true" /> : null}
      </div>
    )
  }

  return (
    <PopoverPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div className={cx('lc-combo', className)}>
          <div className="lc-combo__field">
            <span className="lc-combo__glyph" aria-hidden="true"><Icon name={icon} size={14} /></span>
            <input
              ref={inputRef}
              className="lc-combo__input"
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && activeRow >= 0 ? optionId(activeRow) : undefined}
              placeholder={current && !open ? current.label : placeholder}
              value={open ? query : current?.label ?? query}
              autoFocus={autoFocus}
              disabled={disabled}
              onFocus={() => setOpen(true)}
              onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            {clearable && (query || current) ? (
              <button
                type="button"
                className="lc-combo__clear"
                aria-label={query ? 'Clear search' : `Clear ${label}`}
                onClick={() => { if (query) setQuery(''); else onClear?.(); inputRef.current?.focus() }}
              >
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="lc-combo__list"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (e.target instanceof Node && inputRef.current?.parentElement?.parentElement?.contains(e.target)) e.preventDefault() }}
        >
          <div id={listId} role="listbox" aria-label={label}>
            {needMore ? <p className="lc-combo__state">Type {min - q.length} more character{min - q.length === 1 ? '' : 's'} to search</p> : null}
            {!needMore && loading && !shown.length ? <p className="lc-combo__state">Searching…</p> : null}
            {!needMore && error ? (
              <p className="lc-combo__state is-error">{error} · <button type="button" className="lc-link" onClick={() => setAttempt((n) => n + 1)}>Retry</button></p>
            ) : null}
            {!needMore && !loading && !error && !shown.length ? <p className="lc-combo__state">{q ? `${emptyText} for “${q}”` : emptyText}</p> : null}
            {shown.length ? (
              virtual ? (
                <List
                  listRef={listRef}
                  className="lc-combo__scroller"
                  rowCount={rows.length}
                  rowHeight={rowH}
                  rowComponent={VirtualRow}
                  rowProps={{ rows, render: renderRow }}
                  style={{ height: Math.min(360, rows.length * rowH) }}
                  overscanCount={6}
                />
              ) : (
                <div ref={scrollerRef} className="lc-combo__scroller">
                  {rows.map((r, i) => renderRow(r, i, r.type === 'option' ? { minHeight: rowH } : undefined))}
                </div>
              )
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function VirtualRow({ index, style, rows, render }: RowComponentProps<{ rows: Row[]; render: (r: Row, i: number, s?: CSSProperties) => ReactNode }>) {
  return <>{render(rows[index], index, style)}</>
}
