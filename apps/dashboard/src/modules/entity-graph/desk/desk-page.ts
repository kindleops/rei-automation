/**
 * ENTITY GRAPH DESK · ONE COMPLETE PAGE (owner, 2026-10-08: "the grid only
 * loads field values for rows currently on screen — you scroll and cells fill
 * in afterward"; "sorting doesn't show everything").
 *
 *   - a page is requested WITH the visible columns' fields and the outreach
 *     state (browse attaches both server-side), so the rows render complete;
 *   - what arrived is absorbed into the column / outreach caches, so the
 *     lazy hooks have nothing left to fetch for those rows (no pop-in);
 *   - the next page is prefetched in the background as soon as a page lands.
 * Pure parts here; tested in desk-page.test.ts.
 */
import type { EntityGraphListResponse, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { storeColumnValues } from '../mobile/use-entity-graph-columns'
import { storeOutreach, type OutreachState } from './desk-outreach'

/** The browse params that make a page complete: the visible enrichment fields + outreach. */
export function completePageParams(fields: readonly string[], outreach: boolean): Record<string, string> {
  return {
    ...(fields.length ? { fields: [...fields].join(',') } : {}),
    ...(outreach ? { outreach: '1' } : {}),
  }
}

const propertyIdOf = (r: EntitySearchResult): string | null => (r.entityType === 'property' ? r.entityId || r.contextIds?.propertyId || null : null)

/** Store what the page carried, so no lazy hook re-reads it. Returns how many rows were absorbed. */
export function absorbPageAttachments(res: Pick<EntityGraphListResponse, 'results' | 'attached'>, now = Date.now()): number {
  const att = res.attached
  if (!att) return 0
  const fields = att.fieldsLoaded ?? []
  const outreachOk = att.outreach && !att.errors.some((e) => e.source === 'outreach')
  let n = 0
  const states: Record<string, OutreachState> = {}
  const outIds: string[] = []
  for (const r of res.results) {
    const id = propertyIdOf(r)
    if (!id) continue
    n += 1
    if (fields.length) storeColumnValues([id], fields, { [id]: (r.details?.row ?? {}) as Record<string, unknown> }, now)
    if (outreachOk && r.details && 'outreach' in r.details) {
      outIds.push(id)
      if (r.details.outreach) states[id] = r.details.outreach as OutreachState
    }
  }
  if (outIds.length) storeOutreach(outIds, states, now)
  return n
}

/** The key a prefetched page is filed under: the list signature + where it starts. */
export const pageKey = (signature: string, cursor: number, after: string | null) => `${signature}#${cursor}#${after ?? ''}`
