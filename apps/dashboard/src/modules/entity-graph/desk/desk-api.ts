/**
 * Desk-only reads (read-only). The header KPIs come from
 * GET /api/cockpit/entity-graph/kpis; on an API that predates it (404) the
 * desk falls back to the tab counts it already has and leaves the rest
 * "not available" — never invented.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type { EntityGraphTabCounts } from '../../../domain/entity-graph/entity-graph.types'
import type { DeskKpis } from './desk-model'

export async function fetchDeskKpis(signal?: AbortSignal): Promise<DeskKpis | null> {
  const res = await callBackend<{ ok: boolean; kpis?: DeskKpis }>('/api/cockpit/entity-graph/kpis', { signal })
  if (!res.ok || !res.data?.kpis) return null
  return res.data.kpis
}

/** The tab counts as partial KPIs (the fields counts can answer; the rest stay null). */
export function kpisFromCounts(counts: EntityGraphTabCounts | null): DeskKpis | null {
  if (!counts) return null
  return {
    properties: counts.properties ?? null,
    owners: counts.master_owners ?? null,
    entities: counts.organizations ?? null,
    linkedProperties: null,
    portfolioOwners: null,
    ownersWithPhone: null,
  }
}
