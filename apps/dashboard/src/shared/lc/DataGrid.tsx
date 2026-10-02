import {
  useCallback, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from 'react'
import { Icon } from '../icons'
import { LCIconButton } from './Button'
import { LCContextMenu, LCMenu } from './Menu'
import type { LCMenuEntry } from './menu-model'
import { LCEmpty, LCError, LCSkeleton } from './States'
import { cx } from './cx'
import './lc-data.css'

/**
 * LCDataGrid — the shared grid for records people scan, compare and act on
 * (Entity Graph, campaign targets, Queue, analytics cohorts, buyer activity,
 * comps, workflow runs, email activity).
 *
 * Arc's Data Grid is a Pro component this project does not license, so this
 * is LeadCommand's own implementation. It renders what it is given: sorting
 * is reported to the caller (server or client decides), selection is the
 * caller's state, and no cell decides eligibility, readiness or conversion.
 *
 * · windowed rendering (only visible rows mount) with a sticky frosted header
 *   in the same scroller, so horizontal scroll never desyncs
 * · resizable columns (drag the header edge; double-click resets; widths
 *   persist per grid), column visibility, dense / standard / comfortable
 * · keyboard: the grid is one tab stop; ↑ ↓ Home End PgUp PgDn move, Enter
 *   opens (inspector), Space selects, Shift extends
 * · row grouping, context menu per row, infinite loading at the end
 */

export interface LCColumn<R> {
  id: string
  header: string
  /** fixed px width; omit for a flexible column */
  width?: number
  minWidth?: number
  /** numeric columns align right with tabular figures */
  align?: 'left' | 'right' | 'center'
  sortable?: boolean
  /** can be hidden from the columns menu */
  hideable?: boolean
  hiddenByDefault?: boolean
  render: (row: R) => ReactNode
  /** text for the header tooltip: definition / unit */
  hint?: string
}

export type LCSort = { id: string; dir: 'asc' | 'desc' } | null

/** The DOM event that activated a row: a click or an Enter keypress. */
export type LCRowActivationEvent = MouseEvent<Element> | KeyboardEvent<Element>

export interface LCDataGridProps<R> {
  /** persists widths / visibility */
  id: string
  label: string
  rows: ReadonlyArray<R>
  rowKey: (row: R) => string
  columns: ReadonlyArray<LCColumn<R>>
  sort?: LCSort
  onSortChange?: (sort: LCSort) => void
  /** the row the inspector shows */
  activeKey?: string | null
  /**
   * A row was activated. `event` is the click or the Enter keypress that did it, so
   * consumers can read modifiers (⇧-click inspect, ⌘/Ctrl-click open beside). It is
   * absent when the activation is the inspector following the keyboard focus.
   */
  onActivate?: (row: R, event?: LCRowActivationEvent) => void
  /** multi-select (checkbox column) */
  selected?: ReadonlySet<string>
  onSelectedChange?: (next: Set<string>) => void
  density?: 'dense' | 'standard' | 'comfortable'
  groupBy?: (row: R) => string
  groupLabel?: (group: string, count: number) => ReactNode
  rowMenu?: (row: R) => LCMenuEntry[]
  rowTone?: (row: R) => 'crit' | 'attn' | 'ok' | 'exec' | 'flow' | null | undefined
  /** expanded detail under a row (non-windowed grids only) */
  renderExpanded?: (row: R) => ReactNode
  loading?: boolean
  error?: { what: string; onRetry?: () => void; staleSince?: number | null } | null
  empty?: { title: string; body?: ReactNode }
  onEndReached?: () => void
  loadingMore?: boolean
  /** total rows the source has — "Showing 1,240 of 18,249" */
  total?: number | null
  height?: number | string
  className?: string
}

const ROW_H = { dense: 30, standard: 36, comfortable: 44 } as const
const GROUP_H = 30
const WINDOW_AFTER = 80
const OVERSCAN = 8

type Item<R> = { kind: 'group'; key: string; label: ReactNode } | { kind: 'row'; key: string; row: R; index: number }

function readPrefs(id: string): { widths: Record<string, number>; hidden: string[] | null } {
  try {
    const v = JSON.parse(localStorage.getItem(`lc.grid.${id}`) || '{}')
    return { widths: v.widths || {}, hidden: Array.isArray(v.hidden) ? v.hidden : null }
  } catch { return { widths: {}, hidden: null } }
}

export function LCDataGrid<R>({
  id, label, rows, rowKey, columns, sort, onSortChange, activeKey, onActivate, selected, onSelectedChange,
  density = 'standard', groupBy, groupLabel, rowMenu, rowTone, renderExpanded, loading, error, empty, onEndReached,
  loadingMore, total, height = '100%', className,
}: LCDataGridProps<R>) {
  const domId = useId()
  const scroller = useRef<HTMLDivElement>(null)
  const [prefs, setPrefs] = useState(() => readPrefs(id))
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const rowH = ROW_H[density]
  const selectable = Boolean(selected && onSelectedChange)

  const hidden = useMemo(() => new Set(prefs.hidden ?? columns.filter((c) => c.hiddenByDefault).map((c) => c.id)), [prefs.hidden, columns])
  const visibleCols = columns.filter((c) => !hidden.has(c.id))
  const template = [
    selectable ? '36px' : null,
    ...visibleCols.map((c) => {
      const w = prefs.widths[c.id] ?? c.width
      return w ? `${w}px` : `minmax(${c.minWidth ?? 120}px, 1fr)`
    }),
    rowMenu ? '36px' : null,
  ].filter(Boolean).join(' ')
  const minInner = (selectable ? 36 : 0) + (rowMenu ? 36 : 0) + visibleCols.reduce((s, c) => s + (prefs.widths[c.id] ?? c.width ?? c.minWidth ?? 120), 0)

  const savePrefs = useCallback((next: typeof prefs) => {
    setPrefs(next)
    try { localStorage.setItem(`lc.grid.${id}`, JSON.stringify(next)) } catch { /* private mode */ }
  }, [id])

  const items = useMemo<Item<R>[]>(() => {
    if (!groupBy) return rows.map((row, index) => ({ kind: 'row', key: rowKey(row), row, index }))
    const order: string[] = []
    const byGroup = new Map<string, R[]>()
    rows.forEach((r) => {
      const g = groupBy(r)
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g) }
      byGroup.get(g)!.push(r)
    })
    const out: Item<R>[] = []
    let index = 0
    for (const g of order) {
      const list = byGroup.get(g)!
      out.push({ kind: 'group', key: `group:${g}`, label: groupLabel ? groupLabel(g, list.length) : `${g} · ${list.length}` })
      for (const row of list) out.push({ kind: 'row', key: rowKey(row), row, index: index++ })
    }
    return out
  }, [rows, rowKey, groupBy, groupLabel])

  const rowItems = useMemo(() => items.filter((i): i is Extract<Item<R>, { kind: 'row' }> => i.kind === 'row'), [items])
  const windowed = items.length > WINDOW_AFTER && !renderExpanded
  const heightOf = (it: Item<R>) => (it.kind === 'group' ? GROUP_H : rowH)
  const offsets = useMemo(() => {
    const o = new Array(items.length + 1)
    o[0] = 0
    for (let i = 0; i < items.length; i += 1) o[i + 1] = o[i] + heightOf(items[i])
    return o as number[]
  }, [items, rowH]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setViewport({ top: el.scrollTop, height: el.clientHeight })
    if (onEndReached && !loadingMore && el.scrollTop + el.clientHeight > el.scrollHeight - rowH * 4) onEndReached()
  }

  // windowed range (binary search on offsets)
  const headerH = rowH
  let start = 0
  let end = items.length
  if (windowed) {
    const top = Math.max(0, viewport.top - headerH)
    let lo = 0
    let hi = items.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= top) lo = mid + 1; else hi = mid }
    start = Math.max(0, lo - OVERSCAN)
    let e2 = lo
    while (e2 < items.length && offsets[e2] < top + viewport.height) e2 += 1
    end = Math.min(items.length, e2 + OVERSCAN)
  }

  const scrollToKey = (key: string) => {
    const el = scroller.current
    if (!el) return
    const i = items.findIndex((it) => it.key === key)
    if (i < 0) return
    const top = offsets[i] + headerH
    const bottom = offsets[i + 1] + headerH
    if (top - headerH < el.scrollTop) el.scrollTop = top - headerH
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }

  const current = focusKey ?? activeKey ?? null
  const currentIndex = current ? rowItems.findIndex((r) => r.key === current) : -1

  const toggle = (key: string, range: boolean) => {
    if (!selectable || !selected || !onSelectedChange) return
    const next = new Set(selected)
    if (range && anchor.current) {
      const a = rowItems.findIndex((r) => r.key === anchor.current)
      const b = rowItems.findIndex((r) => r.key === key)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i += 1) next.add(rowItems[i].key)
        onSelectedChange(next)
        return
      }
    }
    if (next.has(key)) next.delete(key); else next.add(key)
    anchor.current = key
    onSelectedChange(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rowItems.length) return
    const page = Math.max(1, Math.floor((viewport.height - headerH) / rowH) - 1)
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(rowItems.length - 1, currentIndex + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rowItems.length - 1
    else if (e.key === 'PageDown') next = Math.min(rowItems.length - 1, currentIndex + page)
    else if (e.key === 'PageUp') next = Math.max(0, currentIndex - page)
    else if (e.key === 'Enter' && currentIndex >= 0) { e.preventDefault(); onActivate?.(rowItems[currentIndex].row, e); return }
    else if (e.key === ' ' && currentIndex >= 0 && selectable) { e.preventDefault(); toggle(rowItems[currentIndex].key, e.shiftKey); return }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && selectable && onSelectedChange) { e.preventDefault(); onSelectedChange(new Set(rowItems.map((r) => r.key))); return }
    if (next < 0) return
    e.preventDefault()
    const key = rowItems[next].key
    if (e.shiftKey && selectable && selected && onSelectedChange) {
      const s = new Set(selected); s.add(key); if (currentIndex >= 0) s.add(rowItems[currentIndex].key); onSelectedChange(s)
    }
    setFocusKey(key)
    scrollToKey(key)
    // an open inspector follows the keyboard
    if (activeKey && onActivate) onActivate(rowItems[next].row)
  }

  const [focusFor, setFocusFor] = useState(activeKey)
  if (focusFor !== activeKey) {
    setFocusFor(activeKey)
    if (activeKey) setFocusKey(activeKey)
  }

  const onHeaderSort = (c: LCColumn<R>) => {
    if (!c.sortable || !onSortChange) return
    const dir = sort?.id === c.id ? (sort.dir === 'desc' ? 'asc' : null) : 'desc'
    onSortChange(dir ? { id: c.id, dir } : null)
  }

  // column resize
  const resize = useRef<{ id: string; x: number; w: number } | null>(null)
  const onResizeDown = (c: LCColumn<R>, e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault(); e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).parentElement
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resize.current = { id: c.id, x: e.clientX, w: th ? th.getBoundingClientRect().width : (c.width ?? 160) }
  }
  const onResizeMove = (c: LCColumn<R>, e: PointerEvent<HTMLSpanElement>) => {
    if (!resize.current || resize.current.id !== c.id) return
    const w = Math.max(c.minWidth ?? 64, Math.round(resize.current.w + e.clientX - resize.current.x))
    setPrefs((p) => ({ ...p, widths: { ...p.widths, [c.id]: w } }))
  }
  const onResizeUp = () => { if (resize.current) { resize.current = null; savePrefs(prefs) } }
  const resetWidth = (c: LCColumn<R>) => { const widths = { ...prefs.widths }; delete widths[c.id]; savePrefs({ ...prefs, widths }) }

  const colsMenu: LCMenuEntry[] = columns.filter((c) => c.hideable).map((c) => ({
    id: c.id,
    label: c.header,
    checked: !hidden.has(c.id),
    onSelect: () => {
      const next = new Set(hidden)
      if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
      savePrefs({ ...prefs, hidden: [...next] })
    },
  }))

  const allSelected = selectable && selected && rowItems.length > 0 && rowItems.every((r) => selected.has(r.key))
  const someSelected = selectable && selected && !allSelected && rowItems.some((r) => selected.has(r.key))

  const renderRow = (it: Extract<Item<R>, { kind: 'row' }>, style?: CSSProperties) => {
    const isActive = it.key === activeKey
    const isFocus = it.key === current
    const isSel = selected?.has(it.key)
    const tone = rowTone?.(it.row)
    const isOpen = expanded.has(it.key)
    const node = (
      <div
        key={it.key}
        id={`${domId}-r-${it.index}`}
        role="row"
        aria-rowindex={it.index + 2}
        aria-selected={selectable ? Boolean(isSel) : isActive}
        className={cx('lc-grid__row', isActive && 'is-active', isFocus && 'is-focus', isSel && 'is-selected', tone && `is-${tone}`)}
        data-tone={tone || undefined}
        style={{ ...style, gridTemplateColumns: template, minWidth: minInner }}
        onClick={(e: MouseEvent) => {
          setFocusKey(it.key)
          if (selectable && (e.metaKey || e.ctrlKey || e.shiftKey)) { toggle(it.key, e.shiftKey); return }
          if (renderExpanded) setExpanded((s) => { const n = new Set(s); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n })
          onActivate?.(it.row, e)
        }}
      >
        {selectable ? (
          <span role="gridcell" className="lc-grid__cell is-check" onClick={(e) => { e.stopPropagation(); toggle(it.key, e.shiftKey) }}>
            <span className={cx('lc-check', isSel && 'is-on')} role="checkbox" aria-checked={Boolean(isSel)} aria-label="Select row" />
          </span>
        ) : null}
        {visibleCols.map((c) => (
          <span key={c.id} role="gridcell" className={cx('lc-grid__cell', c.align === 'right' && 'is-num', c.align === 'center' && 'is-center')}>
            {c.render(it.row)}
          </span>
        ))}
        {rowMenu ? (
          <span role="gridcell" className="lc-grid__cell is-menu" onClick={(e) => e.stopPropagation()}>
            <LCMenu trigger={<button type="button" className="lc-grid__more" aria-label="Row actions"><Icon name="more" size={14} /></button>} items={rowMenu(it.row)} label="Row actions" />
          </span>
        ) : null}
      </div>
    )
    const withMenu = rowMenu ? <LCContextMenu key={it.key} items={rowMenu(it.row)} label="Row actions">{node}</LCContextMenu> : node
    if (renderExpanded && isOpen) {
      return (
        <div key={it.key} className="lc-grid__expand-wrap">
          {withMenu}
          <div className="lc-grid__expanded" role="row"><div role="gridcell">{renderExpanded(it.row)}</div></div>
        </div>
      )
    }
    return withMenu
  }

  const body = loading && !rows.length ? (
    <div className="lc-grid__state"><LCSkeleton shape="rows" count={8} /></div>
  ) : error && !rows.length ? (
    <div className="lc-grid__state"><LCError what={error.what} onRetry={error.onRetry} staleSince={error.staleSince} /></div>
  ) : !rows.length ? (
    <div className="lc-grid__state"><LCEmpty title={empty?.title ?? 'No records'} body={empty?.body} compact /></div>
  ) : windowed ? (
    <div className="lc-grid__space" style={{ height: offsets[items.length], minWidth: minInner }}>
      {items.slice(start, end).map((it, k) => {
        const i = start + k
        const style: CSSProperties = { position: 'absolute', top: offsets[i], left: 0, right: 0, height: heightOf(it) }
        return it.kind === 'group'
          ? <div key={it.key} className="lc-grid__group" style={{ ...style, minWidth: minInner }} role="row"><span role="gridcell">{it.label}</span></div>
          : renderRow(it, style)
      })}
    </div>
  ) : (
    <div className="lc-grid__flow" style={{ minWidth: minInner }}>
      {items.map((it) => (it.kind === 'group'
        ? <div key={it.key} className="lc-grid__group" role="row"><span role="gridcell">{it.label}</span></div>
        : renderRow(it, { height: rowH })))}
    </div>
  )

  return (
    <div className={cx('lc-grid', className)} data-lc-density={density} style={{ height }}>
      <div
        ref={scroller}
        className="lc-grid__scroller lc-scroll"
        role="grid"
        aria-label={label}
        aria-rowcount={total ?? rowItems.length}
        aria-multiselectable={selectable || undefined}
        aria-activedescendant={currentIndex >= 0 ? `${domId}-r-${rowItems[currentIndex].index}` : undefined}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="lc-grid__head" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template, minWidth: minInner, height: headerH }}>
          {selectable ? (
            <span role="columnheader" className="lc-grid__th is-check">
              <span
                className={cx('lc-check', allSelected && 'is-on', someSelected && 'is-mixed')}
                role="checkbox"
                aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
                aria-label="Select all"
                tabIndex={-1}
                onClick={() => onSelectedChange?.(allSelected ? new Set() : new Set(rowItems.map((r) => r.key)))}
              />
            </span>
          ) : null}
          {visibleCols.map((c) => {
            const dir = sort?.id === c.id ? sort.dir : null
            return (
              <span
                key={c.id}
                role="columnheader"
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : c.sortable ? 'none' : undefined}
                className={cx('lc-grid__th', c.align === 'right' && 'is-num', c.align === 'center' && 'is-center', c.sortable && 'is-sortable', dir && 'is-sorted')}
                title={c.hint}
              >
                {c.sortable && onSortChange ? (
                  <button type="button" className="lc-grid__sort" onClick={() => onHeaderSort(c)} aria-label={`Sort by ${c.header}${dir ? `, currently ${dir === 'asc' ? 'ascending' : 'descending'}` : ''}`}>
                    <span>{c.header}</span>
                    <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={11} className="lc-grid__sorticon" />
                  </button>
                ) : <span className="lc-grid__thtext">{c.header}</span>}
                <span
                  className="lc-grid__resize lc-resize-x"
                  aria-hidden="true"
                  onPointerDown={(e) => onResizeDown(c, e)}
                  onPointerMove={(e) => onResizeMove(c, e)}
                  onPointerUp={onResizeUp}
                  onPointerCancel={onResizeUp}
                  onDoubleClick={() => resetWidth(c)}
                />
              </span>
            )
          })}
          {rowMenu ? <span role="columnheader" className="lc-grid__th is-menu" aria-label="Actions" /> : null}
        </div>
        {body}
        {loadingMore ? <div className="lc-grid__more-loading" style={{ minWidth: minInner }}><LCSkeleton shape="rows" count={2} /></div> : null}
      </div>
      {(colsMenu.length || typeof total === 'number') && rows.length ? (
        <div className="lc-grid__foot">
          {typeof total === 'number' ? (
            <span className="lc-t-meta lc-num">
              {total > rows.length ? `Showing ${rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : `${total.toLocaleString('en-US')} ${total === 1 ? 'record' : 'records'}`}
              {selectable && selected?.size ? ` · ${selected.size.toLocaleString('en-US')} selected` : ''}
            </span>
          ) : <span />}
          {colsMenu.length ? <LCMenu trigger={<LCIconButton icon="grid" label="Columns" size="sm" />} items={colsMenu} label="Columns" title="Columns" /> : null}
        </div>
      ) : null}
    </div>
  )
}
