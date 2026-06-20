import * as backendClient from '../../lib/api/backendClient'
import type { EntityGraphDossier, EntityGraphSearchResponse } from './entity-graph.types'

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

export async function searchEntityGraph(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<EntityGraphSearchResponse> {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  const res = await backendClient.callBackend<EntityGraphSearchResponse>(
    `/api/cockpit/entity-graph/search?${qs}`,
    { signal },
  )
  if (!res.ok || !res.data) {
    throw new Error(res.message || res.error || 'entity_graph_search_failed')
  }
  return res.data
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