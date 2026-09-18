/**
 * ONE BACK BEHAVIOUR FOR THE WHOLE MOBILE PRODUCT (§4).
 *
 * A phone application without a reliable Back is unusable, and this one had no
 * Back at all: the top bar never rendered one, so every nested state — a thread,
 * a comp detail, a buyer, a campaign setup step, a workflow inspector, a closing
 * record — was somewhere the operator could get into and not out of.
 *
 * WHY NOT JUST `history.back()`. Most of those nested states are COMPONENT
 * state, not routes. Opening a comp detail or a campaign step pushes nothing, so
 * a browser back from inside one leaves the route intact and dismisses nothing —
 * or, worse, walks out of the application entirely because `history.length`
 * counts entries from before the app ever loaded. §4 calls this out directly.
 *
 * WHAT THIS IS INSTEAD. A stack of explicit dismiss handlers. A surface that
 * opens a nested state registers how to leave it; Back runs the most recently
 * registered one. Only when nothing is registered does Back fall through to
 * route history, and only when that is empty too does it offer the launcher.
 * Resolution order, most specific first:
 *
 *   1. the innermost registered handler   — restore the actual prior product state
 *   2. in-app route history               — but only our own pushes (getRouteDepth)
 *   3. the launcher                       — never a dead end, never a trap
 *
 * Registration is a stack rather than a single slot because these genuinely
 * nest: a comp detail inside Comp Intelligence inside a property context.
 */
import { getRouteDepth } from '../../app/router'

export interface BackEntry {
  id: string
  /** What leaving this state does. Return false to decline (guard an unsaved edit). */
  handler: () => boolean | void
  /** Names the destination, for the control's accessible label. */
  label: string
}

const stack: BackEntry[] = []
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

export const subscribeBackStack = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Register a dismiss handler while a nested state is open.
 *
 * Re-registering the same id REPLACES rather than stacks, so a component that
 * re-renders with a new closure does not pile up duplicates — the common case,
 * and the one that would otherwise need several taps of Back to escape.
 */
export function pushBackHandler(entry: BackEntry): () => void {
  const existing = stack.findIndex((item) => item.id === entry.id)
  if (existing >= 0) stack.splice(existing, 1)
  stack.push(entry)
  notify()
  return () => {
    const index = stack.findIndex((item) => item.id === entry.id)
    if (index >= 0) {
      stack.splice(index, 1)
      notify()
    }
  }
}

/** What Back would do right now, for the control that renders it. */
export function peekBack(): { kind: 'handler' | 'route' | 'none'; label: string } {
  const top = stack[stack.length - 1]
  if (top) return { kind: 'handler', label: top.label }
  if (getRouteDepth() > 0) return { kind: 'route', label: 'Back' }
  return { kind: 'none', label: 'Applications' }
}

export const canGoBack = (): boolean => peekBack().kind !== 'none'

/**
 * Go back. Returns false only when there was nowhere to go, which is the
 * caller's cue to open the launcher instead — §4: if no meaningful destination
 * exists, offer navigation rather than a dead control.
 */
export function goBack(): boolean {
  const top = stack[stack.length - 1]
  if (top) {
    const result = top.handler()
    // A handler may decline (an unsaved edit guarding itself). It stays
    // registered; it is responsible for whatever it showed instead.
    if (result === false) return true
    const index = stack.findIndex((item) => item.id === top.id)
    if (index >= 0) {
      stack.splice(index, 1)
      notify()
    }
    return true
  }

  if (getRouteDepth() > 0) {
    window.history.back()
    return true
  }

  return false
}

/** Test seam — the stack is module state and would otherwise leak between cases. */
export function resetBackStack(): void {
  stack.length = 0
  notify()
}
