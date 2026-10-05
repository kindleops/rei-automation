/**
 * PIPELINE · LINKED CONTEXT — which deal (if any) a linked property names.
 *
 * Read-only. Resolution order, cheapest first:
 *   1. the locator already names the deal (a selection made from a deal)
 *   2. a loaded row carries that property / thread
 *   3. one read of the canonical opportunities list filtered by property
 *      (or, without a property, by thread) — the same endpoint and filters
 *      the board already uses (`primary_property_id` / `primary_thread_key`)
 * Nothing found is an honest `none`: the desk says so quietly and creates
 * nothing.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type { PropertyLocator } from '../../../domain/locator/property-locator'
import type { DeskCard } from './pipeline-desk-api'

export interface OpportunityRef { id: string; status: string | null }

export type PipelineLinkResult =
  | { kind: 'open'; id: string; seed: DeskCard | null }
  | { kind: 'none' }
  | { kind: 'unresolvable' }

export interface PipelineLinkDeps {
  rows: DeskCard[] | null
  fetchOpportunities: (filter: { property_id?: string; thread_key?: string }, signal: AbortSignal) => Promise<OpportunityRef[]>
}

const CLOSED = /closed|dead|lost|suppress|archiv/i

/** A live deal outranks a closed one for the same property. */
export function pickOpportunity(refs: OpportunityRef[]): OpportunityRef | null {
  return refs.find((r) => !CLOSED.test(r.status ?? '')) ?? refs[0] ?? null
}

export async function resolvePipelineItem(loc: PropertyLocator, deps: PipelineLinkDeps, signal: AbortSignal): Promise<PipelineLinkResult> {
  const rows = deps.rows ?? []
  if (loc.opportunityId) {
    return { kind: 'open', id: loc.opportunityId, seed: rows.find((r) => r.id === loc.opportunityId) ?? null }
  }
  if (!loc.propertyId && !loc.threadKey) return { kind: 'unresolvable' }
  const loaded = rows.find((r) => (loc.propertyId ? r.propertyId === loc.propertyId : r.threadKey === loc.threadKey))
  if (loaded) return { kind: 'open', id: loaded.id, seed: loaded }
  const refs = await deps.fetchOpportunities(loc.propertyId ? { property_id: loc.propertyId } : { thread_key: loc.threadKey! }, signal)
  const hit = pickOpportunity(refs)
  return hit ? { kind: 'open', id: hit.id, seed: rows.find((r) => r.id === hit.id) ?? null } : { kind: 'none' }
}

/** GET /api/cockpit/pipeline/opportunities?property_id=…|thread_key=… (body: { ok, data: rows }). */
export async function fetchOpportunityRefs(filter: { property_id?: string; thread_key?: string }, signal: AbortSignal): Promise<OpportunityRef[]> {
  const q = new URLSearchParams({ ...filter, limit: '5' } as Record<string, string>)
  const res = await callBackend<{ ok: boolean; data: Array<Record<string, unknown>> }>(`/api/cockpit/pipeline/opportunities?${q}`, { signal })
  if (!res.ok) throw new Error(res.message || 'pipeline_lookup_failed')
  const rows = Array.isArray(res.data?.data) ? res.data.data : []
  return rows
    .map((r) => ({ id: String(r.id ?? '').trim(), status: r.opportunity_status == null ? null : String(r.opportunity_status) }))
    .filter((r) => r.id)
}

/**
 * The locator a deal click publishes (board beads, table rows, overview
 * planes — every deal surface funnels through PipelineDesk.openDeal). It
 * carries the property AND the thread, so the Map can fly and the Inbox can
 * open that deal's conversation (navigation: never a read).
 */
export function dealLocator(seed: Pick<DeskCard, 'id' | 'propertyId' | 'threadKey' | 'masterOwnerId' | 'address'> | null, id: string): Partial<PropertyLocator> {
  if (!seed) return { opportunityId: id }
  return { propertyId: seed.propertyId, threadKey: seed.threadKey, masterOwnerId: seed.masterOwnerId, opportunityId: seed.id, address: seed.address }
}
