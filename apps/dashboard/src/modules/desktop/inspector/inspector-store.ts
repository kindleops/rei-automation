import { useSyncExternalStore } from 'react'

/**
 * THE UNIVERSAL OBJECT INSPECTOR — which object is being inspected.
 *
 * One inspector for the whole OS: click a seller, property, buyer, campaign or
 * closing anywhere and the same plane explains it without leaving the
 * workspace. Inspecting a related object pushes it (Back returns); the plane
 * holds references only — never a copy of the entity — and reads the owning
 * app's existing endpoint each time (see ./inspector-registry).
 */

export type EntityType =
  | 'property'
  | 'seller'
  | 'buyer'
  | 'company'
  | 'campaign'
  | 'workflow'
  | 'closing'
  /** a pipeline opportunity (id = opportunity uuid) */
  | 'deal'
  | 'market'
  | 'search_page'
  | 'search_query'

export interface EntityRef {
  type: EntityType
  id: string
  /** what to call it before the read lands (an address, a name) */
  label?: string | null
  /** identifiers the caller already holds, so a renderer never guesses (thread_key, property_id …) */
  hint?: Readonly<Record<string, string | null | undefined>>
}

export const refKey = (r: EntityRef) => `${r.type}:${r.id}`

interface State { stack: EntityRef[]; pinned: boolean }

const MAX_DEPTH = 8
let state: State = { stack: [], pinned: false }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Inspect an object. Re-inspecting the current one is a no-op; a related object stacks (Back returns). */
export function openInspector(ref: EntityRef, opts: { replace?: boolean } = {}) {
  if (!ref?.id || !ref.type) return
  const top = state.stack[state.stack.length - 1]
  if (top && refKey(top) === refKey(ref)) return
  const stack = opts.replace || !top ? [ref] : [...state.stack, ref].slice(-MAX_DEPTH)
  state = { ...state, stack }
  emit()
}

export function inspectorBack() {
  if (state.stack.length < 2) return
  state = { ...state, stack: state.stack.slice(0, -1) }
  emit()
}

export function closeInspector() {
  if (!state.stack.length) return
  state = { stack: [], pinned: false }
  emit()
}

/** A pinned inspector stays open while the operator keeps working; unpinned it closes on Escape or outside. */
export function setInspectorPinned(pinned: boolean) {
  if (state.pinned === pinned) return
  state = { ...state, pinned }
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const read = () => state

export function useInspector(): { current: EntityRef | null; previous: EntityRef | null; depth: number; pinned: boolean } {
  const s = useSyncExternalStore(subscribe, read, read)
  return {
    current: s.stack[s.stack.length - 1] ?? null,
    previous: s.stack[s.stack.length - 2] ?? null,
    depth: s.stack.length,
    pinned: s.pinned,
  }
}

/** Test seam. */
export const __inspectorTest = { reset: () => { state = { stack: [], pinned: false }; emit() }, read }
