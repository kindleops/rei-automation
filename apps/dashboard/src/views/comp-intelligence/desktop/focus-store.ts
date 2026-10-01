import { useSyncExternalStore } from 'react'

/**
 * ONE evidence focus for the whole workstation (§62–63). The map, the comp
 * rows, every chart and the compare matrix read and write the same object,
 * so hovering a chart point lights its marker and its row, and selecting a
 * row is what every view shows as selected.
 *
 * A tiny external store rather than React state: a hover moves dozens of
 * times a second, and only the views whose answer changes should render —
 * a row asks "am I hot?", the map applies feature-state without rendering.
 */
export type FocusSource = 'map' | 'list' | 'chart' | 'matrix' | 'inspector'

export interface FocusState {
  hover: string | null
  hoverSource: FocusSource | null
  selected: string | null
}

export interface FocusStore {
  get: () => FocusState
  subscribe: (listener: () => void) => () => void
  hover: (key: string | null, source: FocusSource | null) => void
  select: (key: string | null) => void
}

export function createFocusStore(): FocusStore {
  let state: FocusState = { hover: null, hoverSource: null, selected: null }
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  return {
    get: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    hover: (key, source) => {
      if (state.hover === key && state.hoverSource === source) return
      state = { ...state, hover: key, hoverSource: key ? source : null }
      emit()
    },
    select: (key) => {
      if (state.selected === key) return
      state = { ...state, selected: key }
      emit()
    },
  }
}

/** The whole focus — for charts and the map legend. */
export function useFocus(store: FocusStore): FocusState {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Is this key the hovered or selected evidence? Renders only when the answer changes. */
export function useFocusOf(store: FocusStore, key: string): { hot: boolean; selected: boolean } {
  const hot = useSyncExternalStore(store.subscribe, () => store.get().hover === key, () => false)
  const selected = useSyncExternalStore(store.subscribe, () => store.get().selected === key, () => false)
  return { hot, selected }
}
