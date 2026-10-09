/**
 * ENTITY GRAPH → AGENT · the row selection, published (contract owned by
 * modules/agent/context/agent-context.ts — this file only writes it):
 *
 *   window.dispatchEvent(new CustomEvent('lc:entity-graph-selection', { detail }))
 *   sessionStorage['lc.entityGraph.selection.v1'] = JSON.stringify(detail)
 *   detail = { v: 1, scope, property_ids (≤ 200), count, focused: { property_id, address } | null, instance_id, at }
 *
 * Property rows only (other scopes publish an empty list with their scope).
 * Pure builder + a writer that never throws (private mode, quota).
 */
export const ENTITY_GRAPH_SELECTION_EVENT = 'lc:entity-graph-selection'
export const ENTITY_GRAPH_SELECTION_KEY = 'lc.entityGraph.selection.v1'
export const SELECTION_MAX_IDS = 200

export type SelectionDetail = {
  v: 1
  scope: string
  property_ids: string[]
  count: number
  focused: { property_id: string; address: string | null } | null
  instance_id: string | null
  at: number
}

export function buildSelectionDetail(input: { scope: string; selectedPropertyIds: readonly string[]; focused: { property_id: string; address: string | null } | null; instanceId: string | null; now?: number }): SelectionDetail {
  const ids = [...new Set(input.selectedPropertyIds.map(String).filter(Boolean))]
  return {
    v: 1,
    scope: input.scope,
    property_ids: input.scope === 'properties' ? ids.slice(0, SELECTION_MAX_IDS) : [],
    count: input.scope === 'properties' ? ids.length : 0,
    focused: input.focused,
    instance_id: input.instanceId,
    at: input.now ?? Date.now(),
  }
}

/** A stable key for "did anything the agent reads change" (ignores `at`). */
export const selectionSignature = (d: SelectionDetail) => JSON.stringify([d.scope, d.property_ids, d.count, d.focused, d.instance_id])

export function publishSelection(detail: SelectionDetail, w: (Pick<Window, 'dispatchEvent'> & { sessionStorage?: Pick<Storage, 'setItem'> }) | null = typeof window !== 'undefined' ? window : null): void {
  if (!w) return
  try { w.sessionStorage?.setItem(ENTITY_GRAPH_SELECTION_KEY, JSON.stringify(detail)) } catch { /* private mode / quota */ }
  try { w.dispatchEvent(new CustomEvent(ENTITY_GRAPH_SELECTION_EVENT, { detail })) } catch { /* no CustomEvent */ }
}
