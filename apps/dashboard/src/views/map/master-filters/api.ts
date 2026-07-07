import { callBackend } from '../../../lib/api/backendClient'
import type {
  MapFilterBounds,
  MapFilterPresetsResponse,
  MapFilterPreviewRequest,
  MapFilterPreviewResponse,
  MapFilterQueryParams,
  MapFilterRegistryResponse,
  MapFilterTokenRequest,
  MapFilterTokenResponse,
  MapFilterSavedFilter,
  MapFilterSavedListResponse,
  AdvancedMapFilterGroup,
} from './types'

const REGISTRY_ROUTE = '/api/internal/dashboard/ops/map/filters/registry'
const PREVIEW_ROUTE = '/api/internal/dashboard/ops/map/filters/preview'
const TOKEN_ROUTE = '/api/internal/dashboard/ops/map/filters/token'
const OPTIONS_ROUTE = '/api/internal/dashboard/ops/map/filters/options'
const PRESETS_ROUTE = '/api/internal/dashboard/ops/map/filters/presets'
const SAVED_ROUTE = '/api/internal/dashboard/ops/map/filters/saved'

export interface MapFilterOption {
  value: string
  label: string
  count: number
}

interface ApiEnvelope<T> {
  ok: boolean
  route?: string
  data?: T
  error?: string
  message?: string
  issues?: unknown[]
}

export function buildMapFilterQueryParams(
  token: string | null | undefined,
): MapFilterQueryParams {
  if (!token) return {}
  return { filter: token }
}

export function appendFilterParam(url: string, token: string | null | undefined): string {
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}filter=${encodeURIComponent(token)}`
}

export async function fetchMapFilterRegistry(q?: string) {
  const params = new URLSearchParams({ catalog: 'operator' })
  if (q?.trim()) params.set('q', q.trim())
  const result = await callBackend<ApiEnvelope<MapFilterRegistryResponse>>(`${REGISTRY_ROUTE}?${params}`)
  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'registry_fetch_failed',
      message: result.data?.message || 'Failed to load filter registry',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function previewMapFilter(
  expressionOrPayload: AdvancedMapFilterGroup | {
    inboxFilters: Record<string, unknown>
    mapStatus?: string
  },
  bounds?: MapFilterBounds | null,
) {
  const body: MapFilterPreviewRequest = 'inboxFilters' in expressionOrPayload
    ? { inboxFilters: expressionOrPayload.inboxFilters, mapStatus: expressionOrPayload.mapStatus }
    : { expression: expressionOrPayload }
  if (bounds) body.bounds = bounds

  const result = await callBackend<ApiEnvelope<MapFilterPreviewResponse>>(PREVIEW_ROUTE, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'preview_failed',
      message: result.data?.message || 'Failed to preview filter counts',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function createMapFilterToken(
  expressionOrPayload: AdvancedMapFilterGroup | {
    inboxFilters: Record<string, unknown>
    mapStatus?: string
  },
  ttlHours?: number,
) {
  const body: MapFilterTokenRequest = 'inboxFilters' in expressionOrPayload
    ? { inboxFilters: expressionOrPayload.inboxFilters, mapStatus: expressionOrPayload.mapStatus }
    : { expression: expressionOrPayload }
  if (ttlHours != null) body.ttlHours = ttlHours

  const result = await callBackend<ApiEnvelope<MapFilterTokenResponse>>(TOKEN_ROUTE, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'token_failed',
      message: result.data?.message || 'Failed to create filter token',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function fetchMapFilterOptions(
  field: string,
  context: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ field })
  if (context.advanced) params.set('advanced', JSON.stringify(context.advanced))
  const result = await callBackend<ApiEnvelope<{
    field: string
    options: MapFilterOption[]
    totalDistinct: number
    source: string
  }>>(`${OPTIONS_ROUTE}?${params}`, { signal })

  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'options_fetch_failed',
      message: result.data?.message || 'Failed to load filter options',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data.options ?? [] }
}

export async function fetchMapFilterPresets() {
  const result = await callBackend<ApiEnvelope<MapFilterPresetsResponse>>(PRESETS_ROUTE)
  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'presets_fetch_failed',
      message: result.data?.message || 'Failed to load filter presets',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function fetchMapFilterSavedFilters() {
  const result = await callBackend<ApiEnvelope<MapFilterSavedListResponse>>(SAVED_ROUTE)
  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'saved_list_failed',
      message: result.data?.message || 'Failed to load saved filters',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function saveMapFilterStack(payload: {
  name: string
  description?: string
  expression: AdvancedMapFilterGroup
  isFavorite?: boolean
  scope?: 'personal' | 'organization'
  lastKnownPropertyCount?: number | null
}) {
  const result = await callBackend<ApiEnvelope<{ savedFilter: MapFilterSavedFilter }>>(SAVED_ROUTE, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (!result.ok) return result
  if (!result.data?.ok || !result.data.data?.savedFilter) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'saved_create_failed',
      message: result.data?.message || 'Failed to save filter',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data.savedFilter }
}

export async function updateMapFilterSaved(
  id: string,
  patch: Partial<{
    name: string
    description: string
    isFavorite: boolean
    scope: 'personal' | 'organization'
    expression: AdvancedMapFilterGroup
    lastKnownPropertyCount: number | null
    action: 'duplicate' | 'record_use'
  }>,
) {
  const result = await callBackend<ApiEnvelope<{ savedFilter?: MapFilterSavedFilter }>>(
    `${SAVED_ROUTE}/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  )
  if (!result.ok) return result
  if (!result.data?.ok) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'saved_update_failed',
      message: result.data?.message || 'Failed to update saved filter',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status, data: result.data.data }
}

export async function deleteMapFilterSaved(id: string) {
  const result = await callBackend<ApiEnvelope<Record<string, never>>>(
    `${SAVED_ROUTE}/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
  if (!result.ok) return result
  if (!result.data?.ok) {
    return {
      ok: false as const,
      status: result.status,
      error: result.data?.error || 'saved_delete_failed',
      message: result.data?.message || 'Failed to delete saved filter',
      upstream: result.data,
    }
  }
  return { ok: true as const, status: result.status }
}