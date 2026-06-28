import { callBackend, type BackendResult } from '../../lib/api/backendClient'
import type {
  SellerAutomationExecutionDetail,
  SellerAutomationLiveState,
  SellerAutomationRegistryResponse,
} from './seller-automation.types'

const unwrap = <T,>(result: BackendResult<{ ok: boolean; data: T } | T>): T => {
  if (!result.ok) throw new Error(result.message || result.error || 'Seller automation request failed')
  const body = result.data as { ok?: boolean; data?: T } | T
  if (body && typeof body === 'object' && 'data' in body && (body as { ok?: boolean }).ok !== false) {
    return (body as { data: T }).data
  }
  return body as T
}

export async function loadSellerAutomationRegistry(): Promise<SellerAutomationRegistryResponse> {
  const result = await callBackend<{ ok: boolean; data: SellerAutomationRegistryResponse }>(
    '/api/cockpit/seller-automation/registry',
  )
  return unwrap(result)
}

export async function loadSellerAutomationLive(params: {
  propertyId?: string | null
  participantId?: string | null
  threadId?: string | null
  executionId?: string | null
  since?: string | null
  replay?: boolean
}): Promise<SellerAutomationLiveState> {
  const qs = new URLSearchParams()
  if (params.propertyId) qs.set('property_id', params.propertyId)
  if (params.participantId) qs.set('participant_id', params.participantId)
  if (params.threadId) qs.set('thread_id', params.threadId)
  if (params.executionId) qs.set('execution_id', params.executionId)
  if (params.since) qs.set('since', params.since)
  if (params.replay) qs.set('replay', '1')
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const result = await callBackend<{ ok: boolean; data: SellerAutomationLiveState }>(
    `/api/cockpit/seller-automation/live${suffix}`,
  )
  return unwrap(result)
}

export async function loadSellerAutomationExecutionDetail(
  executionId: string,
): Promise<SellerAutomationExecutionDetail> {
  const result = await callBackend<{ ok: boolean; data: SellerAutomationExecutionDetail }>(
    `/api/cockpit/seller-automation/executions/${encodeURIComponent(executionId)}`,
  )
  return unwrap(result)
}

export async function loadSellerAutomationHistory(params: {
  propertyId?: string | null
  participantId?: string | null
  threadId?: string | null
  stage?: string | null
  actionKey?: string | null
  status?: string | null
  executionId?: string | null
  automatic?: boolean | null
  success?: boolean | null
  from?: string | null
  to?: string | null
  limit?: number
  offset?: number
}) {
  const qs = new URLSearchParams()
  if (params.propertyId) qs.set('property_id', params.propertyId)
  if (params.participantId) qs.set('participant_id', params.participantId)
  if (params.threadId) qs.set('thread_id', params.threadId)
  if (params.stage) qs.set('stage', params.stage)
  if (params.actionKey) qs.set('action_key', params.actionKey)
  if (params.status) qs.set('status', params.status)
  if (params.executionId) qs.set('execution_id', params.executionId)
  if (params.automatic === true) qs.set('automatic', 'true')
  if (params.automatic === false) qs.set('automatic', 'false')
  if (params.success === true) qs.set('success', 'true')
  if (params.success === false) qs.set('success', 'false')
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const result = await callBackend<{ ok: boolean; data: { executions: unknown[]; total: number } }>(
    `/api/cockpit/seller-automation/executions${suffix}`,
  )
  return unwrap(result)
}

export async function applySellerAutomationControl(
  executionId: string,
  control: string,
  payload: Record<string, unknown> = {},
) {
  const result = await callBackend<{ ok: boolean; data: Record<string, unknown> }>(
    `/api/cockpit/seller-automation/executions/${encodeURIComponent(executionId)}/control`,
    {
      method: 'POST',
      body: JSON.stringify({ control, payload }),
    },
  )
  return unwrap(result)
}