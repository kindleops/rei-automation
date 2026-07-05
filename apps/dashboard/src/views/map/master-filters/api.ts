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
  AdvancedMapFilterGroup,
} from './types'

const REGISTRY_ROUTE = '/api/internal/dashboard/ops/map/filters/registry'
const PREVIEW_ROUTE = '/api/internal/dashboard/ops/map/filters/preview'
const TOKEN_ROUTE = '/api/internal/dashboard/ops/map/filters/token'
const PRESETS_ROUTE = '/api/internal/dashboard/ops/map/filters/presets'

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
  const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  const result = await callBackend<ApiEnvelope<MapFilterRegistryResponse>>(`${REGISTRY_ROUTE}${qs}`)
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
  expression: AdvancedMapFilterGroup,
  bounds?: MapFilterBounds | null,
) {
  const body: MapFilterPreviewRequest = { expression }
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

export async function createMapFilterToken(expression: AdvancedMapFilterGroup, ttlHours?: number) {
  const body: MapFilterTokenRequest = { expression }
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