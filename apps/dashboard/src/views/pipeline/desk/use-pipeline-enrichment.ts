/**
 * PIPELINE TABLE · ENRICHMENT — property / owner / engine fields for the
 * visible columns, for the deals in view.
 *
 *   - nothing is read unless a visible column needs it;
 *   - only the (id, column) pairs not already cached are requested, in
 *     batches of BATCH ids (one keyed request covers every needed column of a
 *     source group);
 *   - one cache per tab, shared by every Pipeline instance, entries live
 *     TTL_MS; a failed batch leaves its cells "—" and is retried on the next
 *     change, never in a loop.
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchDeskEnrichment, type DeskCard } from './pipeline-desk-api'
import { neededFields, type EnrichSource, type RowEnrichment } from './pipeline-columns'

export const BATCH = 300
const TTL_MS = 10 * 60_000
const DEBOUNCE_MS = 220

type Entry = { values: Record<string, unknown>; cols: Set<string>; at: number }
const cache: Record<EnrichSource, Map<string, Entry>> = { property: new Map(), owner: new Map(), scores: new Map() }

const idOf = (src: EnrichSource, c: DeskCard) => (src === 'owner' ? c.masterOwnerId : c.propertyId) || null

/** Which ids still need which columns, per source. Pure over the cache — exported for tests. */
export function plan(rows: readonly DeskCard[], need: Record<EnrichSource, string[]>, now = Date.now()) {
  const out: Record<EnrichSource, { ids: string[]; cols: string[] }> = { property: { ids: [], cols: need.property }, owner: { ids: [], cols: need.owner }, scores: { ids: [], cols: need.scores } }
  for (const src of ['property', 'owner', 'scores'] as const) {
    if (!need[src].length) continue
    const seen = new Set<string>()
    for (const c of rows) {
      const id = idOf(src, c)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const e = cache[src].get(id)
      if (e && now - e.at < TTL_MS && need[src].every((k) => e.cols.has(k))) continue
      out[src].ids.push(id)
    }
  }
  return out
}

function store(src: EnrichSource, ids: string[], cols: string[], data: Record<string, Record<string, unknown>>, now: number) {
  for (const id of ids) {
    const prev = cache[src].get(id)
    const fresh = prev && now - prev.at < TTL_MS
    const values = { ...(fresh ? prev.values : {}), ...(data[id] ?? {}) }
    const have = new Set([...(fresh ? prev.cols : []), ...cols])
    cache[src].set(id, { values, cols: have, at: fresh ? prev.at : now })
  }
}

/** For tests. */
export const __enrichmentTest = { reset: () => { for (const m of Object.values(cache)) m.clear() }, store }

export function usePipelineEnrichment(rows: readonly DeskCard[] | null, visible: readonly string[]) {
  const need = useMemo(() => neededFields(visible), [visible])
  const needKey = `${need.property.join(',')}|${need.owner.join(',')}|${need.scores.join(',')}`
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const anyNeed = need.property.length + need.owner.length + need.scores.length > 0

  useEffect(() => {
    if (!rows?.length || !anyNeed) return
    const c = new AbortController()
    const t = window.setTimeout(() => {
      const p = plan(rows, need)
      // property + engine scores share the property key; owners have their own
      const propIds = [...new Set([...p.property.ids, ...p.scores.ids])]
      const needProp = new Set(p.property.ids)
      const needScores = new Set(p.scores.ids)
      const n = Math.max(propIds.length, p.owner.ids.length)
      if (!n) return
      setState({ loading: true, error: null })
      void (async () => {
        try {
          for (let i = 0; i < n; i += BATCH) {
            const pids = propIds.slice(i, i + BATCH)
            const oids = p.owner.ids.slice(i, i + BATCH)
            const bp = pids.filter((id) => needProp.has(id))
            const bs = pids.filter((id) => needScores.has(id))
            const fields = [
              ...(bp.length ? p.property.cols.map((k) => `property.${k}`) : []),
              ...(oids.length ? p.owner.cols.map((k) => `owner.${k}`) : []),
              ...(bs.length ? p.scores.cols.map((k) => `scores.${k}`) : []),
            ].join(',')
            if (!fields) continue
            const res = await fetchDeskEnrichment({ fields, property_ids: pids.join(','), owner_ids: oids.join(',') }, c.signal)
            const now = Date.now()
            if (bp.length) store('property', bp, p.property.cols, res.property, now)
            if (oids.length) store('owner', oids, p.owner.cols, res.owner, now)
            if (bs.length) store('scores', bs, p.scores.cols, res.scores, now)
            if (!c.signal.aborted) setVersion((v) => v + 1)
          }
          if (!c.signal.aborted) setState({ loading: false, error: null })
        } catch (e) {
          if (!c.signal.aborted) setState({ loading: false, error: e instanceof Error ? e.message : 'enrichment_failed' })
        }
      })()
    }, DEBOUNCE_MS)
    return () => { window.clearTimeout(t); c.abort() }
  }, [rows, needKey, anyNeed]) // eslint-disable-line react-hooks/exhaustive-deps -- needKey encodes need

  /** Per-row lookup. `version` re-derives it as batches land. */
  const lookup = useMemo(() => {
    void version
    return (c: DeskCard): RowEnrichment => ({
      property: c.propertyId ? cache.property.get(c.propertyId)?.values ?? null : null,
      owner: c.masterOwnerId ? cache.owner.get(c.masterOwnerId)?.values ?? null : null,
      scores: c.propertyId ? cache.scores.get(c.propertyId)?.values ?? null : null,
    })
  }, [version])

  return { lookup, loading: anyNeed && state.loading, error: anyNeed ? state.error : null }
}
