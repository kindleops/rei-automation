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

/** Drops keys the catalog no longer has, so a stale layout can't hide or break a column. */
export function normalizeTableLayout(raw: unknown): EntityGraphTableLayout {
  if (!raw || typeof raw !== 'object') return { columns: {}, sort: {} }
  const input = raw as { columns?: Record<string, unknown>; sort?: Record<string, unknown> }
  const out: EntityGraphTableLayout = { columns: {}, sort: {} }
  for (const scope of Object.keys(SCOPE_TABLE_COLUMNS) as EntityScope[]) {
    const known = new Set(SCOPE_TABLE_COLUMNS[scope].map((c) => c.key))
    const cols = input.columns?.[scope]
    if (Array.isArray(cols)) out.columns[scope] = cols.filter((k): k is string => typeof k === 'string' && known.has(k))
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
      try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
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
