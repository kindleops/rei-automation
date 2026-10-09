/**
 * ENTITY GRAPH DESK · PERSISTENT SELECTION (owner, 2026-10-09: exact-property
 * campaign selection).
 *
 * The operator's checked rows survive what used to clear them: loading more
 * rows, changing filters or the search, switching scope and back, a reload.
 * Each scope keeps its own set of row keys (`${entityType}:${entityId}`), so
 * "select three properties across three different searches" is one set.
 *
 * The grid only knows the rows it has loaded: its header checkbox and Cmd+A
 * replace the selection with the visible rows. mergeGridSelection lets the grid
 * own the visible rows and leaves every off-screen selection alone.
 *
 * Pure (no React): tested in desk-selection.test.ts.
 */
import type { EntityScope } from '../mobile/entity-graph-mobile-format'

export const DESK_SELECTION_KEY = 'lc.entityGraph.desk.selection.v1'
/** Matches the server's per-property preview bound × 10; Add to Campaign refuses past its own limit. */
export const DESK_SELECTION_MAX = 5000

export type DeskSelection = Partial<Record<EntityScope, string[]>>

/** The grid changed the selection of the rows it shows; keep everything it cannot see. */
export function mergeGridSelection(previous: ReadonlySet<string>, visibleKeys: readonly string[], fromGrid: ReadonlySet<string>): Set<string> {
  const visible = new Set(visibleKeys)
  const next = new Set<string>()
  for (const key of previous) if (!visible.has(key)) next.add(key)
  for (const key of fromGrid) next.add(key)
  return next
}

/** Row key → entity id (the part after the first ':'). */
export function entityIdsOf(keys: Iterable<string>): string[] {
  const out: string[] = []
  for (const key of keys) {
    const i = key.indexOf(':')
    const id = (i >= 0 ? key.slice(i + 1) : key).trim()
    if (id) out.push(id)
  }
  return [...new Set(out)]
}

export function readDeskSelection(storage: Pick<Storage, 'getItem'> | null = safeSession()): DeskSelection {
  try {
    const parsed = JSON.parse(storage?.getItem(DESK_SELECTION_KEY) || 'null') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: DeskSelection = {}
    for (const [scope, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue
      const clean = [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.includes(':')))].slice(0, DESK_SELECTION_MAX)
      if (clean.length) out[scope as EntityScope] = clean
    }
    return out
  } catch {
    return {}
  }
}

export function writeDeskSelection(selection: DeskSelection, storage: Pick<Storage, 'setItem'> | null = safeSession()): void {
  try { storage?.setItem(DESK_SELECTION_KEY, JSON.stringify(selection)) } catch { /* private mode / full: the selection stays in memory */ }
}

export function withScopeSelection(selection: DeskSelection, scope: EntityScope, keys: ReadonlySet<string>): DeskSelection {
  const next: DeskSelection = { ...selection }
  if (keys.size) next[scope] = [...keys].slice(0, DESK_SELECTION_MAX)
  else delete next[scope]
  return next
}

function safeSession(): Storage | null {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null } catch { return null }
}
