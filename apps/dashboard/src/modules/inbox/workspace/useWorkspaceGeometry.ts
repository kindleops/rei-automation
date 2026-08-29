/**
 * useWorkspaceGeometry — the workspace layout slice, lifted out of InboxPage.
 *
 * InboxPage.tsx is a 5,632-line component with ~70 useState hooks. This is the
 * one slice that is cleanly separable: pane width state plus its persistence.
 * It replaces the old pair
 *
 *   useState<Partial<Record<view, ViewWidthPercent>>>   (InboxPage:720)
 *   useEffect -> localStorage['nx.inbox.workspace-width-overrides']  (:2813)
 *
 * with continuous, collapsible, per-user + per-route geometry (R12.3).
 *
 * Storage shape
 * -------------
 *   nx.workspace.geometry.v1
 *   └── <userKey>            "local" when signed out
 *       └── <routeKey>       "/inbox", "/inbox:fullscreen", ...
 *           └── <paneSetKey> "deal_intelligence|sms_thread|thread"
 *               └── { panes: { id: { basis, collapsed, restoreBasis } }, maximized }
 *
 * Keying by pane set means opening a different workspace preset does not
 * inherit a layout that was tuned for a different set of panes, and coming back
 * restores exactly what you left.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  evenLayout,
  expandPane,
  isLayoutEqual,
  layoutFromBases,
  normalizeLayout,
  resizePair,
  toggleCollapse,
  toggleMaximize,
  type WorkspaceLayout,
} from '../../../shared/workspace/pane-geometry'

const STORAGE_KEY = 'nx.workspace.geometry.v1'

type PersistedRoot = Record<string, Record<string, Record<string, WorkspaceLayout>>>

export const paneSetKey = (order: string[]): string => [...order].sort().join('|')

const readRoot = (): PersistedRoot => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PersistedRoot) : {}
  } catch {
    return {}
  }
}

const readPersisted = (
  userKey: string,
  routeKey: string,
  order: string[],
): WorkspaceLayout | null => {
  if (typeof window === 'undefined' || order.length === 0) return null
  const stored = readRoot()[userKey]?.[routeKey]?.[paneSetKey(order)]
  if (!stored || typeof stored !== 'object' || !stored.panes) return null
  // Only accept a layout that still describes exactly this pane set.
  const storedIds = Object.keys(stored.panes)
  if (storedIds.length !== order.length || !order.every((id) => storedIds.includes(id))) return null
  return normalizeLayout(order, stored)
}

const writePersisted = (
  userKey: string,
  routeKey: string,
  order: string[],
  layout: WorkspaceLayout,
): void => {
  if (typeof window === 'undefined' || order.length === 0) return
  try {
    const root = readRoot()
    const byRoute = root[userKey] ?? (root[userKey] = {})
    const bySet = byRoute[routeKey] ?? (byRoute[routeKey] = {})
    bySet[paneSetKey(order)] = layout
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
  } catch {
    /* quota or private mode — geometry is a preference, never a hard failure */
  }
}

export interface UseWorkspaceGeometryArgs {
  /** Ordered pane ids currently rendered. */
  order: string[]
  /** Stable identity for per-user persistence. */
  userKey: string
  /** Stable identity for per-route persistence. */
  routeKey: string
  /**
   * Legacy flex bases (from `resolveWorkspaceFlexBases`). Used only to seed a
   * pane set that has never been dragged, so the first paint is identical to
   * what the pill presets produced.
   */
  seedBases: Partial<Record<string, number>>
  /** Skip all persistence and normalization (mobile single-pane flow). */
  disabled?: boolean
}

export interface WorkspaceGeometryApi {
  layout: WorkspaceLayout
  /** Commit a divider move. `nextLeftBasis` is in percent of the workspace. */
  commitResize: (leftId: string, rightId: string, nextLeftBasis: number, snap?: boolean) => void
  collapse: (paneId: string) => void
  expand: (paneId: string) => void
  maximize: (paneId: string) => void
  reset: () => void
  /** Replace the whole layout — used when a width preset pill is clicked. */
  applyBases: (bases: Partial<Record<string, number>>) => void
}

export function useWorkspaceGeometry({
  order,
  userKey,
  routeKey,
  seedBases,
  disabled = false,
}: UseWorkspaceGeometryArgs): WorkspaceGeometryApi {
  const orderKey = order.join('|')
  const setKey = paneSetKey(order)

  // Latest-value refs are synced in an effect, never written during render.
  const seedRef = useRef(seedBases)
  useEffect(() => { seedRef.current = seedBases }, [seedBases])

  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    if (typeof window === 'undefined' || order.length === 0) return { panes: {}, maximized: null }
    return readPersisted(userKey, routeKey, order) ?? layoutFromBases(order, seedBases)
  })

  // Re-seed when the pane set changes: restore that set's saved geometry, or
  // fall back to whatever the legacy preset resolver produced for it.
  const lastSetRef = useRef(`${userKey}::${routeKey}::${setKey}`)
  useEffect(() => {
    if (disabled || order.length === 0) return
    const identity = `${userKey}::${routeKey}::${setKey}`
    if (identity === lastSetRef.current) return
    lastSetRef.current = identity
    setLayout(readPersisted(userKey, routeKey, order) ?? layoutFromBases(order, seedRef.current))
    // `order` is covered by orderKey; seedBases is read through a ref on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, userKey, routeKey, setKey, orderKey])

  // Keep the layout describing exactly the panes on screen.
  useEffect(() => {
    if (disabled || order.length === 0) return
    setLayout((current) => {
      const ids = Object.keys(current.panes)
      const matches = ids.length === order.length && order.every((id) => ids.includes(id))
      if (matches) return current
      const next = readPersisted(userKey, routeKey, order) ?? layoutFromBases(order, seedRef.current)
      return isLayoutEqual(current, next) ? current : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, orderKey, userKey, routeKey])

  // R12.3 — persist per user, per route.
  const persistReadyRef = useRef(false)
  useEffect(() => {
    if (disabled || order.length === 0) return
    if (!persistReadyRef.current) {
      persistReadyRef.current = true
      return
    }
    writePersisted(userKey, routeKey, order, layout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, layout, orderKey, userKey, routeKey])

  const orderRef = useRef(order)
  useEffect(() => { orderRef.current = order }, [order])

  const commitResize = useCallback((leftId: string, rightId: string, nextLeftBasis: number, snap = true) => {
    setLayout((current) => resizePair(orderRef.current, current, leftId, rightId, nextLeftBasis, { snap }).layout)
  }, [])

  const collapse = useCallback((paneId: string) => {
    setLayout((current) => toggleCollapse(orderRef.current, current, paneId))
  }, [])

  const expand = useCallback((paneId: string) => {
    setLayout((current) => expandPane(orderRef.current, current, paneId))
  }, [])

  const maximize = useCallback((paneId: string) => {
    setLayout((current) => toggleMaximize(orderRef.current, current, paneId))
  }, [])

  const reset = useCallback(() => {
    setLayout(layoutFromBases(orderRef.current, seedRef.current))
  }, [])

  const applyBases = useCallback((bases: Partial<Record<string, number>>) => {
    setLayout(layoutFromBases(orderRef.current, bases))
  }, [])

  const safeLayout = useMemo(
    () => (order.length === 0 ? { panes: {}, maximized: null } : normalizeLayout(order, layout)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, orderKey],
  )

  return { layout: safeLayout, commitResize, collapse, expand, maximize, reset, applyBases }
}

export { evenLayout }
