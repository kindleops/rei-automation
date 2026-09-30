import { useSyncExternalStore } from 'react'
import { resolveAppForRoute } from '../../domain/app-registry/app-registry'
import { pushRoutePath } from '../../app/router'

/**
 * SPLIT WORKSPACE — up to four applications side by side.
 *
 * The MAIN pane is the URL (the router renders it exactly as before). Up to
 * three SECONDARY panes each hold their own path; a surface inside one reads
 * that path (PaneRouteContext) and its navigation lands back in its own pane
 * (the router's navigation interceptor, below). No pane is ever narrower than
 * a quarter of the workspace, and one application is never mounted twice —
 * asking for an app that is already open focuses the pane that has it.
 */

export const MAX_PANES = 4
export const MIN_FRACTION = 0.25
export const MAIN = 'main'

export interface SplitPane { id: string; path: string }
export interface SplitState {
  /** Secondary panes, left to right after the main pane. */
  panes: SplitPane[]
  /** Fractions for [main, ...panes]; always sums to 1, each ≥ MIN_FRACTION. */
  sizes: number[]
  focused: string
}

const KEY = 'nexus.desktop.split'
const EVT = 'nexus:split-workspace'
const EMPTY: SplitState = { panes: [], sizes: [1], focused: MAIN }

function equal(n: number) { return Array.from({ length: n }, () => 1 / n) }

export function normalizeSizes(sizes: number[], n: number): number[] {
  if (sizes.length !== n || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return equal(n)
  const total = sizes.reduce((a, b) => a + b, 0)
  let out = sizes.map((s) => s / total)
  // Lift anything under the floor, taking the difference from the widest.
  for (let guard = 0; guard < 8 && out.some((s) => s < MIN_FRACTION - 1e-6); guard++) {
    const need = out.map((s) => Math.max(0, MIN_FRACTION - s)).reduce((a, b) => a + b, 0)
    out = out.map((s) => Math.max(s, MIN_FRACTION))
    const spare = out.map((s) => s - MIN_FRACTION)
    const pool = spare.reduce((a, b) => a + b, 0)
    out = out.map((s, i) => (pool > 0 ? s - (spare[i] / pool) * need : s))
  }
  const t = out.reduce((a, b) => a + b, 0)
  return out.map((s) => s / t)
}

function read(): SplitState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as SplitState | null
    if (!raw || !Array.isArray(raw.panes)) return EMPTY
    const panes = raw.panes.filter((p) => p && typeof p.id === 'string' && typeof p.path === 'string').slice(0, MAX_PANES - 1)
    const focused = raw.focused === MAIN || panes.some((p) => p.id === raw.focused) ? raw.focused : MAIN
    return { panes, sizes: normalizeSizes(raw.sizes || [], panes.length + 1), focused }
  } catch {
    return EMPTY
  }
}

let state: SplitState = typeof window === 'undefined' ? EMPTY : read()
const listeners = new Set<() => void>()
function commit(next: SplitState) {
  state = { ...next, sizes: normalizeSizes(next.sizes, next.panes.length + 1) }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private mode */ }
  listeners.forEach((l) => l())
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVT))
}

export const getSplitState = () => state
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
/** Tear-free: a layout applied before a subscriber mounted is still seen. */
export function useSplitWorkspace(): SplitState {
  return useSyncExternalStore(subscribe, getSplitState, getSplitState)
}

const pathnameOf = (path: string) => path.split('?')[0].split('#')[0] || '/'
const appIdOf = (path: string) => resolveAppForRoute(pathnameOf(path)).id
const mainPath = () => (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`)
let seq = 0
const newId = () => `p${Date.now().toString(36)}${(++seq).toString(36)}`

/** Which pane currently shows this application, if any. */
export function paneForApp(path: string): string | null {
  const app = appIdOf(path)
  if (appIdOf(mainPath()) === app) return MAIN
  return state.panes.find((p) => appIdOf(p.path) === app)?.id ?? null
}

export type OpenResult = 'opened' | 'focused' | 'full'

export function openInSplit(path: string): OpenResult {
  const existing = paneForApp(path)
  if (existing) { focusPane(existing); return 'focused' }
  if (state.panes.length >= MAX_PANES - 1) return 'full'
  const id = newId()
  const panes = [...state.panes, { id, path }]
  commit({ panes, sizes: equal(panes.length + 1), focused: id })
  return 'opened'
}

export function closePane(id: string) {
  if (id === MAIN) {
    // Closing the main pane promotes the first secondary pane into it.
    const first = state.panes[0]
    if (!first) return
    promoteToMain(first.id, { dropOldMain: true })
    return
  }
  const i = state.panes.findIndex((p) => p.id === id)
  if (i < 0) return
  const panes = state.panes.filter((p) => p.id !== id)
  const sizes = state.sizes.filter((_, k) => k !== i + 1)
  commit({ panes, sizes, focused: state.focused === id ? MAIN : state.focused })
}

export function focusPane(id: string) {
  if (state.focused === id) return
  commit({ ...state, focused: id })
}

export function navigatePane(id: string, path: string) {
  commit({ ...state, panes: state.panes.map((p) => (p.id === id ? { ...p, path } : p)), focused: id })
}

export function setPaneSizes(sizes: number[]) {
  commit({ ...state, sizes })
}

/** Swap a secondary pane into the main (URL) slot; the old main takes its place. */
export function promoteToMain(id: string, opts: { dropOldMain?: boolean } = {}) {
  const pane = state.panes.find((p) => p.id === id)
  if (!pane) return
  const oldMain = mainPath()
  const panes = opts.dropOldMain
    ? state.panes.filter((p) => p.id !== id)
    : state.panes.map((p) => (p.id === id ? { ...p, path: oldMain } : p))
  const sizes = opts.dropOldMain ? state.sizes.filter((_, k) => k !== state.panes.indexOf(pane) + 1) : state.sizes
  commit({ panes, sizes, focused: MAIN })
  bypassNext = true
  pushRoutePath(pane.path)
}

/** Replace the whole workspace: main stays, secondary panes become `paths`. */
export function applyLayout(paths: string[]) {
  const main = appIdOf(mainPath())
  const seen = new Set([main])
  const panes: SplitPane[] = []
  for (const p of paths) {
    const app = appIdOf(p)
    if (seen.has(app) || panes.length >= MAX_PANES - 1) continue
    seen.add(app)
    panes.push({ id: newId(), path: p })
  }
  commit({ panes, sizes: equal(panes.length + 1), focused: MAIN })
}

export function clearSplit() { commit(EMPTY) }

/* ── navigation attribution ────────────────────────────────────────────────
   A navigation belongs to a secondary pane only when the operator just acted
   inside it (pointer or key, within a short window). URL-state `replace` calls
   are never taken — they are a surface syncing its own view, which must not
   switch another pane's application. */

let lastInteraction: { paneId: string; at: number } | null = null
let bypassNext = false
const WINDOW_MS = 2500

export function markPaneInteraction(paneId: string) { lastInteraction = { paneId, at: Date.now() } }

export function interceptNavigation(path: string, mode: 'push' | 'replace'): boolean {
  if (bypassNext) { bypassNext = false; return false }
  if (mode !== 'push' || state.panes.length === 0) return false
  const recent = lastInteraction && Date.now() - lastInteraction.at < WINDOW_MS ? lastInteraction.paneId : null
  if (!recent || recent === MAIN) return false
  if (!state.panes.some((p) => p.id === recent)) return false
  // Already open elsewhere: that pane takes it (the main pane via the URL).
  const holder = paneForApp(path)
  if (holder === MAIN) { markPaneInteraction(MAIN); return false }
  navigatePane(holder && holder !== recent ? holder : recent, path)
  return true
}
