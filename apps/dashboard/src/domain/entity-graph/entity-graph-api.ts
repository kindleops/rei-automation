import * as backendClient from '../../lib/api/backendClient'
import type { EntityGraphDossier, EntityGraphListResponse, EntityGraphTabCounts } from './entity-graph.types'
import type { UnsupportedFieldFilter } from './entity-graph-field-filters'

const dossierCache = new Map<string, { fetchedAt: number; data: EntityGraphDossier }>()
const DOSSIER_TTL_MS = 60_000

function dossierPath(type: string, id: string): string {
  switch (type) {
    case 'property':
      return `/api/cockpit/entity-graph/property/${encodeURIComponent(id)}`
    case 'master_owner':
    case 'owner':
      return `/api/cockpit/entity-graph/owner/${encodeURIComponent(id)}`
    case 'prospect':
      return `/api/cockpit/entity-graph/prospect/${encodeURIComponent(id)}`
    case 'phone':
    case 'email':
      return `/api/cockpit/entity-graph/contact/${type}/${encodeURIComponent(id)}`
    case 'organization':
      return `/api/cockpit/entity-graph/organization/${encodeURIComponent(id)}`
    case 'market':
      return `/api/cockpit/entity-graph/market/${encodeURIComponent(id)}`
    case 'zip':
      return `/api/cockpit/entity-graph/zip/${encodeURIComponent(id)}`
    default:
      return ''
  }
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  return qs.toString()
}

function normalizeListResponse(body: EntityGraphListResponse | null | undefined): EntityGraphListResponse {
  if (!body) {
    return {
      ok: false,
      results: [],
      pagination: { cursor: 0, pageSize: 25, total: 0, hasMore: false, nextCursor: null },
    }
  }
  return {
    ok: Boolean(body.ok),
    results: body.results ?? [],
    pagination: body.pagination ?? { cursor: 0, pageSize: 25, total: 0, hasMore: false, nextCursor: null },
  }
}

/**
 * A filter the backend cannot execute is a named error, not an empty list.
 *
 * The browse endpoint answers 422 `unsupported_entity_graph_filters` with the
 * offending field keys rather than quietly running the query without them. The
 * operator has to see WHICH filter failed -- an unexplained empty table and a
 * table that silently ignored a filter look identical, and one of them is a
 * cohort they might act on.
 */
export class EntityGraphFilterError extends Error {
  unsupportedFilters: UnsupportedFieldFilter[]

  constructor(message: string, unsupportedFilters: UnsupportedFieldFilter[]) {
    super(message)
    this.name = 'EntityGraphFilterError'
    this.unsupportedFilters = unsupportedFilters
  }
}

function unsupportedFiltersFromUpstream(upstream: unknown): UnsupportedFieldFilter[] {
  if (!upstream || typeof upstream !== 'object') return []
  const list = (upstream as { unsupported_filters?: unknown }).unsupported_filters
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is UnsupportedFieldFilter => Boolean(entry) && typeof entry === 'object')
}

export async function browseEntityGraph(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<EntityGraphListResponse> {
  const qs = buildQueryString(params)
  const res = await backendClient.callBackend<EntityGraphListResponse>(
    `/api/cockpit/entity-graph/browse?${qs}`,
    { signal },
  )
  if (!res.ok) {
    const unsupported = unsupportedFiltersFromUpstream(res.upstream)
    if (unsupported.length) {
      throw new EntityGraphFilterError('unsupported_entity_graph_filters', unsupported)
    }
    throw new Error(res.message || res.error || 'entity_graph_browse_failed')
  }
  return normalizeListResponse(res.data)
}

export async function searchEntityGraph(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<EntityGraphListResponse> {
  const qs = buildQueryString(params)
  const res = await backendClient.callBackend<EntityGraphListResponse>(
    `/api/cockpit/entity-graph/search?${qs}`,
    { signal },
  )
  if (!res.ok) {
    throw new Error(res.message || res.error || 'entity_graph_search_failed')
  }
  return normalizeListResponse(res.data)
}

export async function fetchEntityGraphList(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<EntityGraphListResponse> {
  const query = String(params.q ?? params.query ?? '').trim()
  if (query) return searchEntityGraph({ ...params, q: query }, signal)
  return browseEntityGraph(params, signal)
}

export type EntityGraphLensBucket = {
  key: string
  label: string
  /** null = not counted yet (deep facet pending) or the count failed. Never a guess. */
  value: number | null
  min?: number | null
  max?: number | null
}

export type EntityGraphLensDimension = {
  key: string
  label: string
  filterKey?: string
  pending?: boolean
  buckets: EntityGraphLensBucket[]
}

export type EntityGraphLens = {
  scope: string
  part: 'fast' | 'deep'
  total?: number | null
  headline?: Array<{ key: string; label: string; value: number | null }>
  dimensions: EntityGraphLensDimension[]
}

/**
 * The lens endpoint is NOT DEPLOYED.
 *
 * `/api/cockpit/entity-graph/lens` has no route in apps/api — the entity-graph
 * directory contains browse, contact, counts, filter-catalog, market,
 * organization, owner, property, prospect, search and zip, and no lens. Every
 * call 404s, and the mobile Entity Graph fires TWO of them (fast + deep) on every
 * scope, subtype or filter change.
 *
 * The UI already fails correctly — EntityGraphUniverseLens renders nothing rather
 * than shimmering — so this latch is about the requests, not the pixels: once the
 * route has answered 404 we stop asking for the rest of the session. It is a
 * per-session latch rather than a permanent flag so that deploying the endpoint
 * makes the lens work on the next load with no client change.
 *
 * Saved cohorts and the compare sheet are built on the lens payload, so they are
 * unreachable until that endpoint exists. That is a backend gap, not a mobile one,
 * and removing the UI here would delete the operator capability rather than
 * uncover it.
 */
let lensRouteAbsent = false

export async function fetchEntityGraphLens(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<EntityGraphLens> {
  if (lensRouteAbsent) throw new Error('entity_graph_lens_not_deployed')

  const qs = buildQueryString(params)
  const res = await backendClient.callBackend<{ ok: boolean; lens: EntityGraphLens }>(
    `/api/cockpit/entity-graph/lens?${qs}`,
    { signal },
  )
  if (res.status === 404) {
    lensRouteAbsent = true
    throw new Error('entity_graph_lens_not_deployed')
  }
  if (!res.ok || !res.data?.lens) {
    throw new Error(res.ok ? 'entity_graph_lens_failed' : (res.message || res.error || 'entity_graph_lens_failed'))
  }
  return res.data.lens
}

export async function fetchEntityGraphTabCounts(signal?: AbortSignal): Promise<EntityGraphTabCounts> {
  const res = await backendClient.callBackend<{ ok: boolean; counts: EntityGraphTabCounts }>(
    '/api/cockpit/entity-graph/counts',
    { signal },
  )
  if (!res.ok || !res.data?.counts) {
    const message = res.ok ? 'entity_graph_counts_failed' : (res.message || res.error || 'entity_graph_counts_failed')
    throw new Error(message)
  }
  return res.data.counts
}

export async function fetchEntityGraphDossier(
  type: string,
  id: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<EntityGraphDossier | null> {
  const cacheKey = `${type}:${id}`
  const cached = dossierCache.get(cacheKey)
  if (!options.force && cached && Date.now() - cached.fetchedAt < DOSSIER_TTL_MS) {
    return cached.data
  }

  const path = dossierPath(type, id)
  if (!path) return null

  const res = await backendClient.callBackend<{ ok: boolean; data: EntityGraphDossier }>(path, {
    signal: options.signal,
  })
  if (!res.ok || !res.data?.data) return null

  dossierCache.set(cacheKey, { fetchedAt: Date.now(), data: res.data.data })
  return res.data.data
}

export function clearEntityGraphDossierCache(): void {
  dossierCache.clear()
}