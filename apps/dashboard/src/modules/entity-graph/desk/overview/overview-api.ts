/**
 * Overview reads (read-only). Sections are fetched separately (viewport
 * order, max 2 at a time, aborted on a filter change — DeskOverview.tsx); the
 * server answers each from one scan of the cohort.
 */
import { callBackend } from '../../../../lib/api/backendClient'
import { fieldFiltersToApiParams } from '../../../../domain/entity-graph/entity-graph-workspace-state'
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import type { OverviewCatalog, OverviewResponse } from './overview-types'

export class OverviewRequestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'OverviewRequestError'
    this.status = status
    this.code = code
  }
}

export function overviewQuery(filters: EntityGraphFieldFilter[], sections: string[], tab = 'properties'): string {
  const qs = new URLSearchParams({ tab, sections: sections.join(',') })
  const ff = fieldFiltersToApiParams(filters).field_filters
  if (ff) qs.set('field_filters', ff)
  return qs.toString()
}

export async function fetchOverview(filters: EntityGraphFieldFilter[], sections: string[], signal?: AbortSignal, tab = 'properties'): Promise<OverviewResponse> {
  // every statement has an 8 s budget server-side; the unfiltered universe is the snapshot's (never scanned live)
  const res = await callBackend<OverviewResponse>(`/api/cockpit/entity-graph/overview?${overviewQuery(filters, sections, tab)}`, { signal, timeoutMs: 30_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string; message?: string } }).upstream
    throw new OverviewRequestError(upstream?.message || res.message || 'overview_failed', res.status, upstream?.error || res.error || null)
  }
  if (!res.data?.ok) throw new OverviewRequestError(res.data?.message || res.data?.error || 'overview_failed', 200, res.data?.error || null)
  return res.data
}

export async function fetchOverviewCatalog(signal?: AbortSignal, tab = 'properties'): Promise<OverviewCatalog | null> {
  const res = await callBackend<OverviewCatalog>(`/api/cockpit/entity-graph/overview/catalog?tab=${encodeURIComponent(tab)}`, { signal })
  return res.ok && res.data?.ok ? res.data : null
}

/** The campaign scope chip's label + exact counts (GET /entity-graph/campaign-scope). */
export type CampaignScopeSummary = {
  id: string
  name: string
  status: string | null
  mode: 'built' | 'explicit' | 'definition' | 'empty'
  targets: number
  properties: number | null
  owners: number | null
  people: number | null
  queue: { rows: number; sent: number; delivered: number; failed: number; waiting: number }
  definition: { clauses: number; foreign: Array<{ domain: string; field_key: string }> } | null
  basis: string
}

export async function fetchCampaignScope(campaignId: string, signal?: AbortSignal): Promise<CampaignScopeSummary | null> {
  const res = await callBackend<{ ok: boolean; scope?: CampaignScopeSummary }>(`/api/cockpit/entity-graph/campaign-scope?campaign_id=${encodeURIComponent(campaignId)}`, { signal })
  return res.ok && res.data?.ok && res.data.scope ? res.data.scope : null
}
