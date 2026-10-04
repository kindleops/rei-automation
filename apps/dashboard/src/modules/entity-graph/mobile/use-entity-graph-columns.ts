/**
 * ENTITY GRAPH TABLE · COLUMN ENRICHMENT (client) — the property fields the
 * visible columns need, for the rows loaded, merged onto `details.row`.
 *
 * Same contract as the Pipeline table (use-pipeline-enrichment.ts):
 *   - nothing is read unless a visible column needs it;
 *   - only (id, column) pairs not already cached are requested, BATCH ids per
 *     keyed request (one request covers every needed column);
 *   - one cache per tab, entries live TTL_MS; a failed batch leaves its cells
 *     "—", reports an error, and is retried on the next change, never in a loop.
 */
import { useEffect, useMemo, useState } from 'react'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { fetchEntityGraphColumns, type EntityGraphColumnValues } from '../../../domain/entity-graph/entity-graph-api'

export const BATCH = 300
const TTL_MS = 10 * 60_000
const DEBOUNCE_MS = 200

type Entry = { values: Record<string, unknown>; cols: Set<string>; at: number }
const cache = new Map<string, Entry>()

const propertyIdOf = (r: EntitySearchResult): string | null =>
  r.entityType === 'property' ? r.entityId || r.contextIds?.propertyId || null : null

/** Which property ids still need any of `fields`. Pure over the cache — exported for tests. */
export function planColumnReads(rows: readonly EntitySearchResult[], fields: readonly string[], now = Date.now()): string[] {
  if (!fields.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const id = propertyIdOf(r)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const e = cache.get(id)
    if (e && now - e.at < TTL_MS && fields.every((f) => e.cols.has(f))) continue
    out.push(id)
  }
  return out
}

export function storeColumnValues(ids: readonly string[], fields: readonly string[], data: EntityGraphColumnValues, now = Date.now()) {
  for (const id of ids) {
    const prev = cache.get(id)
    const fresh = prev && now - prev.at < TTL_MS
    cache.set(id, {
      values: { ...(fresh ? prev.values : {}), ...(data[id] ?? {}) },
      cols: new Set([...(fresh ? prev.cols : []), ...fields]),
      at: fresh ? prev.at : now,
    })
  }
}

/** For tests. */
export const __columnCacheTest = { reset: () => cache.clear() }

/** Merge cached values onto `details.row` (property rows only). */
export function withColumnValues(rows: readonly EntitySearchResult[]): EntitySearchResult[] {
  return rows.map((r) => {
    const id = propertyIdOf(r)
    const values = id ? cache.get(id)?.values : undefined
    if (!values) return r
    return { ...r, details: { ...(r.details ?? {}), row: { ...(r.details?.row ?? {}), ...values } } }
  })
}

export function useEntityGraphColumns(rows: readonly EntitySearchResult[], fields: readonly string[], enabled: boolean) {
  const fieldsKey = fields.join(',')
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ key: string; loading: boolean; error: string | null }>({ key: '', loading: false, error: null })
  const active = enabled && fields.length > 0 && rows.length > 0

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const ids = planColumnReads(rows, fields)
      if (!ids.length) return
      setState({ key: fieldsKey, loading: true, error: null })
      void (async () => {
        try {
          for (let i = 0; i < ids.length; i += BATCH) {
            const part = ids.slice(i, i + BATCH)
            const data = await fetchEntityGraphColumns({ fields: fieldsKey, property_ids: part.join(',') }, controller.signal)
            storeColumnValues(part, fields, data)
            if (!controller.signal.aborted) setVersion((v) => v + 1)
          }
          if (!controller.signal.aborted) setState({ key: fieldsKey, loading: false, error: null })
        } catch (error) {
          if (!controller.signal.aborted) {
            setState({ key: fieldsKey, loading: false, error: error instanceof Error ? error.message : 'columns_failed' })
          }
        }
      })()
    }, DEBOUNCE_MS)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [rows, fieldsKey, active]) // eslint-disable-line react-hooks/exhaustive-deps -- fieldsKey encodes fields

  const merged = useMemo(() => {
    void version
    return active ? withColumnValues(rows) : (rows as EntitySearchResult[])
  }, [rows, version, active])

  const current = state.key === fieldsKey
  return {
    rows: merged,
    loading: active && current && state.loading,
    error: active && current ? state.error : null,
  }
}
