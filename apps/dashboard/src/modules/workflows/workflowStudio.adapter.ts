import {
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
  pauseWorkflowBackend,
  patchWorkflowStepBackend,
  renderWorkflowTemplateVariantBackend,
  resumeWorkflowBackend,
  upsertWorkflowTemplateTranslationBackend,
} from '../../lib/api/backendClient'
import type { BackendResult } from '../../lib/api/backendClient'
import type {
  Workflow,
  WorkflowDetail,
  WorkflowDryRunResult,
} from './workflow.types'

const unwrap = <T,>(result: BackendResult<T>): T => {
  if (!result.ok) throw new Error(result.message || result.error || 'Workflow request failed')
  return result.data as T
}

const unwrapWorkflowResponse = <T,>(result: BackendResult<Record<string, unknown>>): T => {
  return unwrap(result as unknown as BackendResult<T>)
}

export const loadWorkflowStudio = async (): Promise<{ workflows: Workflow[] }> => {
  const response = unwrapWorkflowResponse<{ ok: boolean; workflows: Workflow[] }>(await listWorkflowsBackend())
  return { workflows: response.workflows ?? [] }
}

export const loadWorkflowDetail = async (workflowId: string): Promise<WorkflowDetail> => {
  return unwrapWorkflowResponse<WorkflowDetail>(await getWorkflowBackend(workflowId))
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
