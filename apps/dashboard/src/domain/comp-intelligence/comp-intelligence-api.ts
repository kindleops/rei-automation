import { callBackend } from '../../lib/api/backendClient'
import type { CompIntelligencePayload, CanonicalSubjectProperty } from './types'

export async function fetchCanonicalSubjectProperty(
  propertyId: string,
  params: { threadKey?: string | null; opportunityId?: string | null } = {},
  signal?: AbortSignal,
): Promise<CanonicalSubjectProperty | null> {
  const query = new URLSearchParams()
  if (params.threadKey) query.set('thread_key', params.threadKey)
  if (params.opportunityId) query.set('opportunity_id', params.opportunityId)
  const suffix = query.toString() ? `?${query.toString()}` : ''

  const result = await callBackend<{ data: CanonicalSubjectProperty }>(
    `/api/cockpit/properties/${encodeURIComponent(propertyId)}/subject${suffix}`,
    { method: 'GET', signal },
  )

  if (!result.ok) return null
  const data = (result.data as { data?: CanonicalSubjectProperty } | null)?.data
  return data ?? null
}

export async function fetchCompIntelligence(
  propertyId: string,
  params: {
    radius?: number
    monthsBack?: number
    assetClass?: string
    threadKey?: string | null
    opportunityId?: string | null
    masterOwnerId?: string | null
  } = {},
  signal?: AbortSignal,
): Promise<CompIntelligencePayload | null> {
  const query = new URLSearchParams()
  if (params.radius) query.set('radius', String(params.radius))
  if (params.monthsBack) query.set('monthsBack', String(params.monthsBack))
  if (params.assetClass) query.set('assetClass', params.assetClass)
  if (params.threadKey) query.set('thread_key', params.threadKey)
  if (params.opportunityId) query.set('opportunity_id', params.opportunityId)
  if (params.masterOwnerId) query.set('master_owner_id', params.masterOwnerId)

  const suffix = query.toString() ? `?${query.toString()}` : ''
  const result = await callBackend<{ data: CompIntelligencePayload }>(
    `/api/cockpit/properties/${encodeURIComponent(propertyId)}/comp-intelligence${suffix}`,
    { method: 'GET', signal },
  )

  if (!result.ok) return null
  const data = (result.data as { data?: CompIntelligencePayload } | null)?.data
  return data ?? null
}