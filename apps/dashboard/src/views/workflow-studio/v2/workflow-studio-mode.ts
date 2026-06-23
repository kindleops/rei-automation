import type { Workflow, WorkflowDetail, WorkflowStudioMode } from '../workflow.types'

export function resolveWorkflowStudioMode(
  detail: WorkflowDetail | null,
  offlineDemo = false,
): WorkflowStudioMode {
  if (offlineDemo) return 'offline_demo'
  if (!detail?.workflow) return 'canonical'
  if (detail.is_legacy || detail.workflow.is_legacy || detail.canonical_model === 'workflows_legacy') {
    return 'legacy'
  }
  if (detail.workflow.status === 'archived' || detail.workflow.operational_mode === 'archived') {
    return 'archived'
  }
  if (detail.workflow.is_system_template || detail.workflow.is_locked) {
    return 'system'
  }
  return 'canonical'
}

export function studioModeLabel(mode: WorkflowStudioMode): string {
  switch (mode) {
    case 'legacy':
      return 'Legacy workflow — read only'
    case 'system':
      return 'System workflow — graph locked'
    case 'offline_demo':
      return 'Offline Demo — changes are not persisted'
    case 'archived':
      return 'Archived workflow — read only'
    default:
      return ''
  }
}

export function canMutateGraph(mode: WorkflowStudioMode, apiAvailable: boolean): boolean {
  return apiAvailable && mode === 'canonical'
}

export function workflowKindBadge(workflow: Workflow): string {
  if (workflow.is_legacy) return 'Legacy'
  if (workflow.is_system_template) return 'System'
  return 'Custom'
}