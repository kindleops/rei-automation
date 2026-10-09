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

export function overviewQuery(filters: EntityGraphFieldFilter[], sections: string[]): string {
  const qs = new URLSearchParams({ tab: 'properties', sections: sections.join(',') })
  const ff = fieldFiltersToApiParams(filters).field_filters
  if (ff) qs.set('field_filters', ff)
  return qs.toString()
}

export async function fetchOverview(filters: EntityGraphFieldFilter[], sections: string[], signal?: AbortSignal): Promise<OverviewResponse> {
  // the unfiltered universe can take a cold scan the first time (cached after) — allow it
  const res = await callBackend<OverviewResponse>(`/api/cockpit/entity-graph/overview?${overviewQuery(filters, sections)}`, { signal, timeoutMs: filters.length ? 30_000 : 60_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string; message?: string } }).upstream
    throw new OverviewRequestError(upstream?.message || res.message || 'overview_failed', res.status, upstream?.error || res.error || null)
  }
  if (!res.data?.ok) throw new OverviewRequestError(res.data?.message || res.data?.error || 'overview_failed', 200, res.data?.error || null)
  return res.data
}

export async function fetchOverviewCatalog(signal?: AbortSignal): Promise<OverviewCatalog | null> {
  const res = await callBackend<OverviewCatalog>('/api/cockpit/entity-graph/overview/catalog?tab=properties', { signal })
  return res.ok && res.data?.ok ? res.data : null
}
