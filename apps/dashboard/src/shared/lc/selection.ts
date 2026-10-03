/**
 * LC SELECTION — one multi-select model for every list that can act on many
 * rows at once (Inbox desk, Pipeline table, Campaign list, …).
 *
 * The grammar matches LCDataGrid and the universal object click grammar:
 *   checkbox click         toggle the row (sets the range anchor)
 *   ⇧-click (checkbox)     select the range from the anchor
 *   ⌘/Ctrl-click (row)     toggle the row          } only while a selection is
 *   ⇧-click (row)          extend the range          } active — with nothing
 *                                                       selected a modified row click
 *                                                       keeps its object meaning
 *                                                       (⇧ inspect · ⌘ open beside)
 *   select all in view     every row the list is showing (never rows it has not loaded)
 *   Esc                    clear (the surface calls `onKeyDown`; no window listener)
 *
 * The model is pure (tested without React); `useLcSelection` keeps the
 * selection pruned to the rows in view so a selection can never act on a row
 * the operator can no longer see.
 */
import { useCallback, useMemo, useState } from 'react'

export interface SelectionState {
  selected: ReadonlySet<string>
  anchor: string | null
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({ selected: new Set<string>(), anchor: null }) as SelectionState

export type SelectionGesture = 'toggle' | 'range'

interface ModifierLike { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }

/**
 * What a ROW click means for the selection. Null = not a selection gesture
 * (the row's own click grammar applies). A checkbox click is always a gesture.
 */
export function rowSelectionGesture(e: ModifierLike | null | undefined, selectionActive: boolean, onCheckbox = false): SelectionGesture | null {
  const shift = Boolean(e?.shiftKey)
  const mod = Boolean(e?.metaKey || e?.ctrlKey)
  if (onCheckbox) return shift ? 'range' : 'toggle'
  if (!selectionActive) return null
  if (shift) return 'range'
  if (mod) return 'toggle'
  return null
}

export function toggleKey(state: SelectionState, key: string): SelectionState {
  const next = new Set(state.selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return { selected: next, anchor: key }
}

/** Add every key between the anchor and `key` (inclusive) in view order. No anchor → toggle. */
export function rangeTo(state: SelectionState, key: string, order: readonly string[]): SelectionState {
  const a = state.anchor ? order.indexOf(state.anchor) : -1
  const b = order.indexOf(key)
  if (a < 0 || b < 0) return toggleKey(state, key)
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const next = new Set(state.selected)
  for (let i = lo; i <= hi; i += 1) next.add(order[i])
  return { selected: next, anchor: state.anchor }
}

export function applyGesture(state: SelectionState, gesture: SelectionGesture, key: string, order: readonly string[]): SelectionState {
  return gesture === 'range' ? rangeTo(state, key, order) : toggleKey(state, key)
}

export function selectAllInView(order: readonly string[]): SelectionState {
  return { selected: new Set(order), anchor: order[0] ?? null }
}

/** Drop keys that are no longer in view. Returns the same object when nothing changed. */
export function pruneToView(state: SelectionState, order: readonly string[]): SelectionState {
  if (!state.selected.size) return state
  const inView = new Set(order)
  let dropped = false
  const next = new Set<string>()
  for (const key of state.selected) {
    if (inView.has(key)) next.add(key)
    else dropped = true
  }
  if (!dropped) return state
  return { selected: next, anchor: state.anchor && inView.has(state.anchor) ? state.anchor : null }
}

/** Selected keys in view order (bulk actions run in the order the operator sees). */
export function orderedSelection(state: SelectionState, order: readonly string[]): string[] {
  return order.filter((key) => state.selected.has(key))
}

export type AllState = 'none' | 'some' | 'all'
export function allState(state: SelectionState, order: readonly string[]): AllState {
  if (!order.length || !state.selected.size) return 'none'
  let hits = 0
  for (const key of order) if (state.selected.has(key)) hits += 1
  return hits === 0 ? 'none' : hits === order.length ? 'all' : 'some'
}

export interface LcSelection {
  /** selected keys still in view */
  selected: ReadonlySet<string>
  count: number
  active: boolean
  ids: string[]
  all: AllState
  isSelected: (key: string) => boolean
  /** apply a gesture; returns true when it was a selection gesture (caller stops its own click) */
  onRowClick: (key: string, e: ModifierLike | null | undefined, onCheckbox?: boolean) => boolean
  toggle: (key: string) => void
  selectAll: () => void
  /** select all ↔ clear, for the header checkbox */
  toggleAll: () => void
  clear: () => void
  /** replace the selection (LCDataGrid's onSelectedChange) */
  set: (next: Iterable<string>) => void
  /** Esc clears; returns true when it consumed the key */
  onKeyDown: (e: { key: string; defaultPrevented?: boolean; preventDefault?: () => void }) => boolean
}

export function useLcSelection(order: readonly string[]): LcSelection {
  const [raw, setRaw] = useState<SelectionState>(EMPTY_SELECTION)
  const state = useMemo(() => pruneToView(raw, order), [raw, order])

  const onRowClick = useCallback((key: string, e: ModifierLike | null | undefined, onCheckbox = false) => {
    const gesture = rowSelectionGesture(e, state.selected.size > 0, onCheckbox)
    if (!gesture) return false
    setRaw((prev) => applyGesture(pruneToView(prev, order), gesture, key, order))
    return true
  }, [order, state.selected.size])

  const toggle = useCallback((key: string) => setRaw((prev) => toggleKey(pruneToView(prev, order), key)), [order])
  const selectAll = useCallback(() => setRaw(selectAllInView(order)), [order])
  const clear = useCallback(() => setRaw(EMPTY_SELECTION), [])
  const set = useCallback((next: Iterable<string>) => setRaw((prev) => ({ selected: new Set(next), anchor: prev.anchor })), [])
  const all = allState(state, order)
  const toggleAll = useCallback(() => {
    setRaw((prev) => (allState(pruneToView(prev, order), order) === 'all' ? EMPTY_SELECTION : selectAllInView(order)))
  }, [order])
  const onKeyDown = useCallback((e: { key: string; defaultPrevented?: boolean; preventDefault?: () => void }) => {
    if (e.key !== 'Escape' || e.defaultPrevented || state.selected.size === 0) return false
    e.preventDefault?.()
    setRaw(EMPTY_SELECTION)
    return true
  }, [state.selected.size])

  const ids = useMemo(() => orderedSelection(state, order), [state, order])
  return {
    selected: state.selected,
    count: ids.length,
    active: ids.length > 0,
    ids,
    all,
    isSelected: (key: string) => state.selected.has(key),
    onRowClick,
    toggle,
    selectAll,
    toggleAll,
    clear,
    set,
    onKeyDown,
  }
}
