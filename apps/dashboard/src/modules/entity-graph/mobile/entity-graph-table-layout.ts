/**
 * The operator's own Entity Graph table layout — visible columns and the
 * header sort, per scope — persisted per signed-in operator (same pattern as
 * the Pipeline table's `nexus.pipeline.desk.columns.v1:<uid>`).
 */
import { useCallback, useState } from 'react'
import { useAuth } from '../../../components/auth/AuthProvider'
import type { EntityScope } from './entity-graph-mobile-format'
import { SCOPE_TABLE_COLUMNS, type HeaderSort } from './entity-graph-table-columns'

const LAYOUT_KEY = 'nexus.entityGraph.table.v1'
/** Header-sort key of the pinned identity column. */
export const IDENTITY_COLUMN_KEY = '__identity'

export type EntityGraphTableLayout = {
  columns: Partial<Record<EntityScope, string[]>>
  sort: Partial<Record<EntityScope, HeaderSort | null>>
}

const EMPTY: EntityGraphTableLayout = { columns: {}, sort: {} }

/**
 * LAYOUT VERSIONS (owner, 2026-10-08: "stale saved layouts must not shift
 * values under the wrong header"). Header and cell always resolve from the
 * SAME key (DataGrid renders both from one column list), so a value can only
 * sit under the wrong header if a KEY changes meaning. v2 (8.5.1 correctness):
 *   - 'stage' / 'status' now mean the PIPELINE deal only; the conversation's
 *     stage moved to its own 'convoStage' (inserted next to it)
 *   - 'liens' now lists liens only; other recorded documents → 'filings' (inserted)
 *   - coordinates leave a saved first screen ('latitude' / 'longitude' → Advanced)
 *   - removed keys (vendor repair figures, Podio-era contact copies, legacy-derived
 *     sqft range / per-unit figures) drop out because the catalog no longer has them
 */
export const TABLE_LAYOUT_VERSION = 2

export function migrateLayoutColumns(scope: EntityScope, cols: readonly string[], fromVersion: number): string[] {
  let out = [...cols]
  if (fromVersion < 2 && scope === 'properties') {
    out = out.filter((k) => k !== 'latitude' && k !== 'longitude')
    const after = (anchor: string, key: string) => {
      const i = out.indexOf(anchor)
      if (i >= 0 && !out.includes(key)) out.splice(i + 1, 0, key)
    }
    after('stage', 'convoStage')
    after('liens', 'filings')
  }
  return out
}

/** Drops keys the catalog no longer has, so a stale layout can't hide or break a column; migrates old versions. */
export function normalizeTableLayout(raw: unknown): EntityGraphTableLayout {
  if (!raw || typeof raw !== 'object') return { columns: {}, sort: {} }
  const input = raw as { columns?: Record<string, unknown>; sort?: Record<string, unknown>; version?: unknown }
  const version = typeof input.version === 'number' ? input.version : 1
  const out: EntityGraphTableLayout = { columns: {}, sort: {} }
  for (const scope of Object.keys(SCOPE_TABLE_COLUMNS) as EntityScope[]) {
    const known = new Set(SCOPE_TABLE_COLUMNS[scope].map((c) => c.key))
    const cols = input.columns?.[scope]
    if (Array.isArray(cols)) out.columns[scope] = migrateLayoutColumns(scope, cols.filter((k): k is string => typeof k === 'string'), version).filter((k) => known.has(k))
    const s = input.sort?.[scope] as { key?: unknown; dir?: unknown } | null | undefined
    if (s && typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc') && (known.has(s.key) || s.key === IDENTITY_COLUMN_KEY)) {
      out.sort[scope] = { key: s.key, dir: s.dir }
    }
  }
  return out
}

function read(key: string): EntityGraphTableLayout {
  try {
    return normalizeTableLayout(JSON.parse(window.localStorage.getItem(key) || 'null'))
  } catch {
    return EMPTY
  }
}

export function useEntityGraphTableLayout() {
  const uid = useAuth().user?.id || 'local'
  const key = `${LAYOUT_KEY}:${uid}`
  const [state, setState] = useState<{ key: string; v: EntityGraphTableLayout }>(() => ({ key, v: read(key) }))
  const layout = state.key === key ? state.v : read(key)
  const update = useCallback((fn: (current: EntityGraphTableLayout) => EntityGraphTableLayout) => {
    setState((cur) => {
      const next = fn(cur.key === key ? cur.v : read(key))
      try { window.localStorage.setItem(key, JSON.stringify({ ...next, version: TABLE_LAYOUT_VERSION })) } catch { /* private mode */ }
      return { key, v: next }
    })
  }, [key])
  const setColumns = useCallback((scope: EntityScope, next: string[]) => {
    update((cur) => ({ ...cur, columns: { ...cur.columns, [scope]: next } }))
  }, [update])
  const setSort = useCallback((scope: EntityScope, next: HeaderSort | null) => {
    update((cur) => ({ ...cur, sort: { ...cur.sort, [scope]: next } }))
  }, [update])
  return { layout, setColumns, setSort }
}
