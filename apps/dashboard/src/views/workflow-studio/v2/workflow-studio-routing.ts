import { useCallback, useEffect, useState } from 'react'
import { replaceRoutePath } from '../../../app/router'
import { getUniversalEntityContextSnapshot, patchUniversalEntityContextSnapshot } from '../../../domain/entity-graph/universal-entity-context-store'

export const WORKFLOW_STUDIO_CANONICAL_PATH = '/workflow-studio'

export const WORKFLOW_STUDIO_LEGACY_ALIASES = [
  '/workflows-v2',
  '/workflows',
  '/workflow-studio-v1',
] as const

const CONTEXT_QUERY_KEYS = [
  'workflow',
  'workflow_id',
  'campaign_id',
  'thread_key',
  'master_owner_id',
  'property_id',
  'prospect_id',
  'queue_id',
  'template_id',
  'stage_code',
  'touch',
  'execution_id',
  'seller_automation',
  'seller_replay',
] as const

export type WorkflowStudioContextParams = Partial<Record<typeof CONTEXT_QUERY_KEYS[number], string>>

/** Migrate saved operator prefs so Workflow Studio V2 is always canonical. */
export function migrateLegacyWorkflowStudioDestination(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem('WORKFLOW_STUDIO_V2', 'true')
    const savedWorkspace = localStorage.getItem('nx.inbox.selected-workspace')
    if (savedWorkspace === 'workflow_studio_v1' || savedWorkspace === 'workflows_v1') {
      localStorage.setItem('nx.inbox.selected-workspace', 'workflow_studio')
    }
  } catch {
    // ignore storage failures
  }
}

export function isWorkflowStudioV2Canonical(): boolean {
  migrateLegacyWorkflowStudioDestination()
  return true
}

export function readWorkflowIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  return params.get('workflow') || params.get('workflow_id')
}

export function readWorkflowStudioContextFromLocation(): WorkflowStudioContextParams {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const out: WorkflowStudioContextParams = {}
  for (const key of CONTEXT_QUERY_KEYS) {
    const value = params.get(key)
    if (value) out[key] = value
  }
  return out
}

export function buildWorkflowStudioPath(
  workflowId?: string | null,
  context: WorkflowStudioContextParams = {},
): string {
  const params = new URLSearchParams()
  if (workflowId) params.set('workflow', workflowId)
  for (const [key, value] of Object.entries(context)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `${WORKFLOW_STUDIO_CANONICAL_PATH}?${qs}` : WORKFLOW_STUDIO_CANONICAL_PATH
}

export function syncWorkflowStudioUrl(workflowId: string | null, context: WorkflowStudioContextParams = {}): void {
  if (typeof window === 'undefined') return
  const next = buildWorkflowStudioPath(workflowId, {
    ...readWorkflowStudioContextFromLocation(),
    ...context,
    workflow: workflowId ?? undefined,
    workflow_id: undefined,
  })
  const current = `${window.location.pathname}${window.location.search}`
  if (current !== next) replaceRoutePath(next)
}

export function resolveInitialWorkflowId(
  workflows: Array<{ id: string }>,
  preferredId?: string | null,
): string | null {
  if (preferredId && workflows.some((row) => row.id === preferredId)) return preferredId
  return workflows[0]?.id ?? null
}

/** Preserve universal Nexus entity context when opening Workflow Studio from entity-aware surfaces. */
export function applyUniversalContextToWorkflowStudio(): WorkflowStudioContextParams {
  const fromLocation = readWorkflowStudioContextFromLocation()
  const universal = getUniversalEntityContextSnapshot()
  const merged: WorkflowStudioContextParams = { ...fromLocation }

  if (!merged.property_id && universal.propertyId) merged.property_id = universal.propertyId
  if (!merged.master_owner_id && universal.masterOwnerId) merged.master_owner_id = universal.masterOwnerId
  if (!merged.prospect_id && universal.prospectId) merged.prospect_id = universal.prospectId
  if (!merged.thread_key && universal.threadKey) merged.thread_key = universal.threadKey

  return merged
}

export function isSellerAutomationStudioMode(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return params.get('seller_automation') === '1' || params.get('workflow') === 'seller-inbound-v1'
}

export function buildSellerAutomationStudioPath(input: {
  propertyId?: string | null
  participantId?: string | null
  threadKey?: string | null
  executionId?: string | null
  replay?: boolean
} = {}): string {
  const params = new URLSearchParams()
  params.set('seller_automation', '1')
  params.set('workflow', 'seller-inbound-v1')
  if (input.propertyId) params.set('property_id', input.propertyId)
  if (input.participantId) params.set('prospect_id', input.participantId)
  if (input.threadKey) params.set('thread_key', input.threadKey)
  if (input.executionId) params.set('execution_id', input.executionId)
  if (input.replay) params.set('seller_replay', '1')
  return `${WORKFLOW_STUDIO_CANONICAL_PATH}?${params.toString()}`
}

export function openSellerAutomationStudio(input: {
  propertyId?: string | null
  participantId?: string | null
  threadKey?: string | null
  executionId?: string | null
  replay?: boolean
} = {}): void {
  if (typeof window === 'undefined') return
  replaceRoutePath(buildSellerAutomationStudioPath(input))
}

/** Keep current pathname (e.g. /inbox) while focusing seller automation query params. */
export function syncSellerAutomationStudioUrl(input: {
  propertyId?: string | null
  participantId?: string | null
  threadKey?: string | null
  executionId?: string | null
  replay?: boolean
} = {}): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  params.set('seller_automation', '1')
  params.set('workflow', 'seller-inbound-v1')
  if (input.propertyId) params.set('property_id', input.propertyId)
  else params.delete('property_id')
  if (input.participantId) {
    params.set('prospect_id', input.participantId)
    params.delete('master_owner_id')
  } else {
    params.delete('prospect_id')
  }
  if (input.threadKey) params.set('thread_key', input.threadKey)
  else params.delete('thread_key')
  if (input.executionId) params.set('execution_id', input.executionId)
  else params.delete('execution_id')
  if (input.replay) params.set('seller_replay', '1')
  else params.delete('seller_replay')
  replaceRoutePath(`${window.location.pathname}?${params.toString()}`)
}

export function openSellerAutomationStudioFromEntity(input: {
  propertyId?: string | null
  participantId?: string | null
  prospectId?: string | null
  masterOwnerId?: string | null
  threadKey?: string | null
  executionId?: string | null
  replay?: boolean
  preservePath?: boolean
} = {}): void {
  const participantId = input.participantId || input.prospectId || input.masterOwnerId || null
  const payload = {
    propertyId: input.propertyId ?? null,
    participantId,
    threadKey: input.threadKey ?? null,
    executionId: input.executionId ?? null,
    replay: input.replay ?? false,
  }
  if (input.preservePath) syncSellerAutomationStudioUrl(payload)
  else openSellerAutomationStudio(payload)
}

/** React to replaceRoutePath / popstate updates for seller automation focus params. */
export function useSellerAutomationStudioLocation(): {
  sellerAutomationMode: boolean
  focus: {
    propertyId: string | null
    participantId: string | null
    threadId: string | null
    executionId: string | null
    replayMode: boolean
  }
} {
  const [revision, setRevision] = useState(0)
  const bump = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const sync = () => bump()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [bump])

  void revision
  return {
    sellerAutomationMode: isSellerAutomationStudioMode(),
    focus: readSellerAutomationFocusFromLocation(),
  }
}

export function readSellerAutomationFocusFromLocation(): {
  propertyId: string | null
  participantId: string | null
  threadId: string | null
  executionId: string | null
  replayMode: boolean
} {
  const ctx = readWorkflowStudioContextFromLocation()
  return {
    propertyId: ctx.property_id ?? null,
    participantId: ctx.prospect_id ?? ctx.master_owner_id ?? null,
    threadId: ctx.thread_key ?? null,
    executionId: ctx.execution_id ?? null,
    replayMode: ctx.seller_replay === '1',
  }
}

export function publishWorkflowNodeEntityContext(nodeConfig: Record<string, unknown> = {}): void {
  const patch: Record<string, string | null> = {}
  if (typeof nodeConfig.property_id === 'string') patch.propertyId = nodeConfig.property_id
  if (typeof nodeConfig.master_owner_id === 'string') patch.masterOwnerId = nodeConfig.master_owner_id
  if (typeof nodeConfig.prospect_id === 'string') patch.prospectId = nodeConfig.prospect_id
  if (typeof nodeConfig.thread_key === 'string') patch.threadKey = nodeConfig.thread_key
  if (typeof nodeConfig.campaign_id === 'string') patch.opportunityId = nodeConfig.campaign_id
  if (Object.keys(patch).length === 0) return
  patchUniversalEntityContextSnapshot(patch)
}