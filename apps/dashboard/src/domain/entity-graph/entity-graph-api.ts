import * as backendClient from '../../lib/api/backendClient'
import type { EntityGraphDossier, EntityGraphListResponse, EntityGraphTabCounts } from './entity-graph.types'

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