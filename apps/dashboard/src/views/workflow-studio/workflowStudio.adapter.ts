import {
  callBackend,
  cloneWorkflowBackend,
  createWorkflowBackend,
  createWorkflowSenderPoolBackend,
  createWorkflowSenderPoolMemberBackend,
  createWorkflowStepBackend,
  createWorkflowTemplateSetBackend,
  createWorkflowTemplateVariantBackend,
  dryRunWorkflowBackend,
  getWorkflowBackend,
  listWorkflowsBackend,
  patchWorkflowBackend,
  pauseWorkflowBackend,
  patchWorkflowStepBackend,
  renderWorkflowTemplateVariantBackend,
  resumeWorkflowBackend,
  upsertWorkflowTemplateTranslationBackend,
} from '../../lib/api/backendClient'
import type { BackendResult } from '../../lib/api/backendClient'
import type {
  Workflow,
  WorkflowAnalyticsResponse,
  WorkflowConsoleResponse,
  WorkflowDetail,
  WorkflowDryRunResult,
  WorkflowLiveStateResponse,
  WorkflowNodeTypesResponse,
} from './workflow.types'

const WORKFLOW_ERROR_CODES: Record<string, string> = {
  WORKFLOW_NOT_FOUND: 'Workflow could not be loaded.',
  WORKFLOWS_LIST_FAILED: 'Workflow catalog could not be loaded.',
  NODE_REGISTRY_UNAVAILABLE: 'Node registry is unavailable.',
  WORKFLOW_GET_FAILED: 'Workflow detail could not be loaded.',
}

export class WorkflowApiRequestError extends Error {
  readonly code: string
  readonly status: number | null
  readonly retryable: boolean

  constructor(code: string, message: string, status: number | null = null, retryable = false) {
    super(message)
    this.name = 'WorkflowApiRequestError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

const unwrap = <T,>(result: BackendResult<T>): T => {
  if (!result.ok) {
    const code = String(result.error ?? 'WORKFLOW_REQUEST_FAILED')
    const message = result.message || WORKFLOW_ERROR_CODES[code] || 'Workflow request failed'
    throw new WorkflowApiRequestError(code, message, result.status ?? null, result.status >= 500)
  }
  return result.data as T
}

function normalizeWorkflowEnvelope<T extends Record<string, unknown>>(body: T): T {
  if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
    return body.data as T
  }
  return body
}

function toWorkflowApiError(err: unknown): WorkflowApiRequestError {
  if (err instanceof WorkflowApiRequestError) return err
  const raw = err instanceof Error ? err.message : String(err || 'Workflow request failed')
  if (raw.includes('<!DOCTYPE') || raw.includes('<html')) {
    return new WorkflowApiRequestError(
      'WORKFLOW_API_HTML_ERROR',
      'Workflow API returned an HTML error page.',
      Number(raw.match(/\[(\d{3})\]/)?.[1] ?? null) || 500,
      true,
    )
  }
  const status = Number(raw.match(/\[(\d{3})\]/)?.[1] ?? null) || null
  return new WorkflowApiRequestError('WORKFLOW_REQUEST_FAILED', raw, status, status === null || status >= 500)
}

const unwrapWorkflowResponse = <T,>(result: BackendResult<Record<string, unknown>>): T => {
  const body = normalizeWorkflowEnvelope(unwrap(result as unknown as BackendResult<Record<string, unknown>>))
  return body as T
}

const catalogCache = {
  data: null as { workflows: Workflow[] } | null,
  at: 0,
}
const detailCache = new Map<string, { data: WorkflowDetail; at: number }>()
const nodeRegistryCache = new Map<string, { data: WorkflowNodeTypesResponse; at: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

export const loadWorkflowStudio = async (options: { force?: boolean; signal?: AbortSignal } = {}): Promise<{ workflows: Workflow[] }> => {
  if (!options.force && catalogCache.data && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache.data
  }
  try {
    const response = unwrapWorkflowResponse<{ workflows: Workflow[] }>(
      await listWorkflowsBackend({ summary: true, include_stats: false }, options.signal),
    )
    const model = { workflows: response.workflows ?? [] }
    catalogCache.data = model
    catalogCache.at = Date.now()
    return model
  } catch (err) {
    throw toWorkflowApiError(err)
  }
}

export const loadWorkflowDetail = async (
  workflowId: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<WorkflowDetail> => {
  const cached = detailCache.get(workflowId)
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data
  }
  try {
    const detail = unwrapWorkflowResponse<WorkflowDetail>(
      await getWorkflowBackend(workflowId, { include_analytics: false }, options.signal),
    )
    detailCache.set(workflowId, { data: detail, at: Date.now() })
    return detail
  } catch (err) {
    throw toWorkflowApiError(err)
  }
}

export const createWorkflowDraft = async (payload: Record<string, unknown>): Promise<WorkflowDetail> => {
  const created = unwrapWorkflowResponse<{ workflow_id: string }>(await createWorkflowBackend(payload))
  return loadWorkflowDetail(created.workflow_id)
}

export const cloneWorkflowDraft = async (workflowId: string): Promise<WorkflowDetail> => {
  const result = unwrapWorkflowResponse<WorkflowDetail>(await cloneWorkflowBackend(workflowId))
  return result.workflow?.id ? result : loadWorkflowDetail(workflowId)
}

export const pauseWorkflowDraft = async (workflowId: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(await pauseWorkflowBackend(workflowId))
  return loadWorkflowDetail(workflowId)
}

export const resumeWorkflowDraft = async (workflowId: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(await resumeWorkflowBackend(workflowId))
  return loadWorkflowDetail(workflowId)
}

export const createWorkflowStep = async (workflowId: string, payload: Record<string, unknown>) => {
  unwrapWorkflowResponse(await createWorkflowStepBackend(workflowId, payload))
  return loadWorkflowDetail(workflowId)
}

export const updateWorkflowStep = async (
  workflowId: string,
  stepId: string,
  payload: Record<string, unknown>,
) => {
  unwrapWorkflowResponse(await patchWorkflowStepBackend(stepId, payload))
  return loadWorkflowDetail(workflowId)
}

export const createWorkflowTemplateSet = async (workflowId: string, payload: Record<string, unknown>) => {
  unwrapWorkflowResponse(await createWorkflowTemplateSetBackend(workflowId, payload))
  return loadWorkflowDetail(workflowId)
}

export const createWorkflowTemplateVariant = async (
  workflowId: string,
  templateSetId: string,
  payload: Record<string, unknown>,
) => {
  unwrapWorkflowResponse(await createWorkflowTemplateVariantBackend(templateSetId, payload))
  return loadWorkflowDetail(workflowId)
}

export const renderWorkflowTemplateVariant = async (
  variantId: string,
  payload: Record<string, unknown>,
) => {
  return unwrapWorkflowResponse<Record<string, unknown>>(await renderWorkflowTemplateVariantBackend(variantId, payload))
}

export const upsertWorkflowTranslation = async (
  workflowId: string,
  variantId: string,
  payload: Record<string, unknown>,
) => {
  unwrapWorkflowResponse(await upsertWorkflowTemplateTranslationBackend(variantId, payload))
  return loadWorkflowDetail(workflowId)
}

export const createWorkflowSenderPool = async (workflowId: string, payload: Record<string, unknown>) => {
  unwrapWorkflowResponse(await createWorkflowSenderPoolBackend(workflowId, payload))
  return loadWorkflowDetail(workflowId)
}

export const createWorkflowSenderPoolMember = async (
  workflowId: string,
  senderPoolId: string,
  payload: Record<string, unknown>,
) => {
  unwrapWorkflowResponse(await createWorkflowSenderPoolMemberBackend(senderPoolId, payload))
  return loadWorkflowDetail(workflowId)
}

export const runWorkflowDryRun = async (
  workflowId: string,
  payload: Record<string, unknown>,
): Promise<WorkflowDryRunResult> => {
  return unwrapWorkflowResponse<WorkflowDryRunResult>(await dryRunWorkflowBackend(workflowId, payload))
}

export const publishWorkflow = async (workflowId: string, payload: Record<string, unknown> = {}) => {
  const result = await callBackend<WorkflowDetail>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/publish`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Publish failed')
  return unwrapWorkflowResponse<WorkflowDetail>(result as unknown as BackendResult<Record<string, unknown>>)
}

export const loadConsole = async (
  workflowId: string,
  filters: Record<string, unknown> = {},
): Promise<WorkflowConsoleResponse> => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString() ? `?${params.toString()}` : ''
  const result = await callBackend<WorkflowConsoleResponse>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/console${qs}`,
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Console load failed')
  return result.data
}

export const loadLiveState = async (workflowId: string): Promise<WorkflowLiveStateResponse> => {
  const result = await callBackend<WorkflowLiveStateResponse>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/live`,
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Live state load failed')
  return result.data
}

export const loadAnalytics = async (workflowId: string): Promise<WorkflowAnalyticsResponse> => {
  const result = await callBackend<WorkflowAnalyticsResponse>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/analytics`,
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Analytics load failed')
  return result.data
}

export const cleanupWorkflows = async (payload: Record<string, unknown> = {}) => {
  const result = await callBackend<Record<string, unknown>>('/api/cockpit/workflows/cleanup', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (!result.ok) throw new Error(result.message || result.error || 'Cleanup failed')
  return result.data
}

export const insertNodeOnEdge = async (
  workflowId: string,
  payload: Record<string, unknown>,
): Promise<WorkflowDetail> => {
  return mutateWorkflowGraph(workflowId, { operation: 'insert-on-edge', ...payload })
}

export type GraphMutationOperation =
  | 'insert-before'
  | 'insert-after'
  | 'add-branch'
  | 'replace'
  | 'insert-on-edge'

export const mutateWorkflowGraph = async (
  workflowId: string,
  payload: Record<string, unknown>,
): Promise<WorkflowDetail> => {
  const result = await callBackend<WorkflowDetail>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/graph/mutate`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Graph mutation failed')
  return unwrapWorkflowResponse<WorkflowDetail>(result as unknown as BackendResult<Record<string, unknown>>)
}

export const listNodeTypes = async (
  grouped = true,
  includeInternal = false,
  options: { force?: boolean } = {},
): Promise<WorkflowNodeTypesResponse> => {
  const cacheKey = `${grouped}:${includeInternal}`
  const cached = nodeRegistryCache.get(cacheKey)
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data
  }

  const params = new URLSearchParams()
  if (!grouped) params.set('grouped', 'false')
  if (includeInternal) params.set('include_internal', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  try {
    const result = await callBackend<WorkflowNodeTypesResponse>(
      `/api/cockpit/workflows/node-registry${qs}`,
    )
    const body = normalizeWorkflowEnvelope(unwrap(result as unknown as BackendResult<Record<string, unknown>>))
    const payload = body as unknown as WorkflowNodeTypesResponse
    nodeRegistryCache.set(cacheKey, { data: payload, at: Date.now() })
    return payload
  } catch (err) {
    throw toWorkflowApiError(err)
  }
}

export const cloneLegacyWorkflow = async (workflowId: string): Promise<WorkflowDetail> => {
  const result = await callBackend<WorkflowDetail>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}/clone-legacy`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Legacy clone failed')
  return unwrapWorkflowResponse<WorkflowDetail>(result as unknown as BackendResult<Record<string, unknown>>)
}

export const renameWorkflow = async (workflowId: string, name: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(await patchWorkflowBackend(workflowId, { name }))
  return loadWorkflowDetail(workflowId)
}

export const archiveWorkflow = async (workflowId: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(await patchWorkflowBackend(workflowId, { status: 'archived' }))
  return loadWorkflowDetail(workflowId)
}

export const restoreWorkflow = async (workflowId: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(await patchWorkflowBackend(workflowId, { status: 'draft' }))
  return loadWorkflowDetail(workflowId)
}

export const deleteWorkflowDraft = async (workflowId: string) => {
  const result = await callBackend<Record<string, unknown>>(
    `/api/cockpit/workflows/${encodeURIComponent(workflowId)}`,
    { method: 'DELETE' },
  )
  if (!result.ok) throw new Error(result.message || result.error || 'Delete failed')
  return result.data
}

export const enableWorkflowLive = async (workflowId: string): Promise<WorkflowDetail> => {
  unwrapWorkflowResponse(
    await patchWorkflowBackend(workflowId, {
      status: 'active',
      live_send_enabled: true,
      operational_mode: 'live',
    }),
  )
  return loadWorkflowDetail(workflowId)
}
