import { callBackend, type BackendResult } from '../../lib/api/backendClient'
import {
  classifyBackendFailure,
  opsError,
  opsSuccess,
  type OpsSurfaceResult,
} from '../../domain/ops/ops-surface-result'

export type WorkflowAutomationSource =
  | 'workflow_v2'
  | 'send_queue_followup'
  | 'seller_flow'
  | 'auto_reply'

export interface WorkflowAutomationActivityRow {
  id: string
  source: WorkflowAutomationSource | string
  status: string
  seller_stage?: string | null
  seller_status?: string | null
  seller_temperature?: string | null
  human_review_required?: boolean
  stopped_reason?: string | null
  next_scheduled_send?: string | null
  seller_label?: string | null
  property_label?: string | null
  touch_number?: number | null
  use_case?: string | null
  auto_reply_authority?: string | null
  workflow_definition_id?: string | null
  thread_key?: string | null
  updated_at?: string | null
}

export interface WorkflowAutomationActivityPayload {
  activity: WorkflowAutomationActivityRow[]
  counts: {
    workflow_enrollments: number
    workflow_scheduled_tasks: number
    send_queue_followups: number
    total: number
  }
  sources_present: Record<string, boolean>
}

function mapAutomationBackend(result: BackendResult<{ ok?: boolean; data?: WorkflowAutomationActivityPayload } | WorkflowAutomationActivityPayload>) {
  if (!result.ok) {
    const errorType = classifyBackendFailure(result)
    return opsError(
      {
        activity: [],
        counts: { workflow_enrollments: 0, workflow_scheduled_tasks: 0, send_queue_followups: 0, total: 0 },
        sources_present: {},
      },
      errorType,
      result.message || result.error || 'automation_activity_failed',
      { retryable: errorType !== 'auth_error', source: 'backend_api' },
    )
  }

  const body = result.data
  const payload = body && typeof body === 'object' && 'data' in body
    ? (body as { data: WorkflowAutomationActivityPayload }).data
    : body as WorkflowAutomationActivityPayload

  if (!payload?.activity) {
    return opsError(
      {
        activity: [],
        counts: { workflow_enrollments: 0, workflow_scheduled_tasks: 0, send_queue_followups: 0, total: 0 },
        sources_present: {},
      },
      'query_failed',
      'automation_activity_payload_missing',
      { source: 'backend_api' },
    )
  }

  return opsSuccess(payload, 'backend_api')
}

export async function loadWorkflowAutomationActivitySurface(
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<OpsSurfaceResult<WorkflowAutomationActivityPayload>> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  const result = await callBackend<{ ok?: boolean; data?: WorkflowAutomationActivityPayload }>(
    `/api/cockpit/workflows/automation-activity${qs ? `?${qs}` : ''}`,
  )
  return mapAutomationBackend(result)
}