import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { ViewLayoutMode, ViewWidthPercent } from '../../domain/inbox/view-layout'
import WorkflowStudioV2 from './v2/WorkflowStudioV2'
import {
  cloneWorkflowDraft,
  createWorkflowDraft,
  createWorkflowSenderPool,
  createWorkflowSenderPoolMember,
  createWorkflowStep,
  createWorkflowTemplateSet,
  createWorkflowTemplateVariant,
  loadWorkflowDetail,
  loadWorkflowStudio,
  pauseWorkflowDraft,
  renderWorkflowTemplateVariant,
  resumeWorkflowDraft,
  runWorkflowDryRun,
  updateWorkflowStep,
  upsertWorkflowTranslation,
} from './workflowStudio.adapter'
import { buildWorkflowStepPayload, WorkflowBuilder } from './WorkflowBuilder'
import { WorkflowList } from './WorkflowList'
import type { WorkflowNodeLibraryItem } from './WorkflowList'
import type { Workflow, WorkflowDetail, WorkflowDryRunResult } from './workflow.types'
import './workflow-studio.css'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const friendlyWorkflowError = (err: unknown) => {
  const raw = err instanceof Error ? err.message : String(err || 'Workflow request failed')
  const status = raw.match(/\[(\d{3})\]/)?.[1]
  if (raw.includes('/api/cockpit/workflows')) {
    return `${status ? `[${status}] ` : ''}Workflow API unavailable. Studio preview remains in dry-run guarded mode.`
  }
  if (raw.includes('<!DOCTYPE') || raw.includes('<html')) {
    return `${status ? `[${status}] ` : ''}Workflow API returned an HTML error response.`
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw
}

interface WorkflowStudioProps {
  data?: { workflows?: Workflow[] } | null
  paneWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
}

type UtilityDrawerTab = 'Dry Run' | 'Run Log' | 'Audit'

const WorkflowStudioLegacy = ({
  data,
  paneWidth = '100',
  layoutMode = 'full',
}: WorkflowStudioProps) => {
  const [workflows, setWorkflows] = useState<Workflow[]>(data?.workflows ?? [])
  const [selected, setSelected] = useState<WorkflowDetail | null>(null)
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRunResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [utilityDrawerOpen, setUtilityDrawerOpen] = useState(false)
  const [utilityDrawerTab, setUtilityDrawerTab] = useState<UtilityDrawerTab>('Dry Run')

  const selectedId = selected?.workflow.id ?? null
  const draftCount = useMemo(
    () => workflows.filter((workflow) => workflow.status === 'draft').length,
    [workflows],
  )

  const refreshList = useCallback(async () => {
    const model = await loadWorkflowStudio()
    setWorkflows(model.workflows)
    return model.workflows
  }, [])

  const loadSelected = useCallback(async (workflowId: string) => {
    setLoading(true)
    setError('')
    try {
      const detail = await loadWorkflowDetail(workflowId)
      setSelected(detail)
      setDryRunResult(null)
    } catch (err) {
      setError(friendlyWorkflowError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    refreshList()
      .then((rows) => {
        if (cancelled) return
        const first = rows[0]
        if (first && !selected) void loadSelected(first.id)
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyWorkflowError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const withBusy = async (task: () => Promise<void>, success: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await task()
      setNotice(success)
      await refreshList()
    } catch (err) {
      setError(friendlyWorkflowError(err))
    } finally {
      setBusy(false)
    }
  }

  const withSilentBusy = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (err) {
      setError(friendlyWorkflowError(err))
    } finally {
      setBusy(false)
    }
  }

  const requireWorkflow = () => {
    if (!selected?.workflow.id) throw new Error('Select a workflow')
    return selected.workflow.id
  }

  const openUtilityDrawer = (tab: UtilityDrawerTab) => {
    setUtilityDrawerTab(tab)
    setUtilityDrawerOpen(true)
  }

  const addNodeFromRail = (item: WorkflowNodeLibraryItem) => {
    void withBusy(async () => {
      const workflowId = requireWorkflow()
      const maxOrder = Math.max(0, ...(selected?.steps ?? []).map((step) => Number(step.step_order) || 0))
      const index = selected?.steps.length ?? 0
      const x = Math.min(1780, 140 + (index * 64))
      const y = 170 + ((index % 4) * 76)
      const detail = await createWorkflowStep(workflowId, buildWorkflowStepPayload(item, { x, y }, maxOrder + 10))
      setSelected(detail)
    }, `${item.label} node added`)
  }

  return (
    <section className={cls('wfs', `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
      <header className="wfs-topbar">
        <div>
          <span className="wfs-kicker">Inbox</span>
          <h1>Workflow Studio</h1>
        </div>
        <div className="wfs-topbar__metrics">
          <span><strong>{workflows.length}</strong> workflows</span>
          <span><strong>{draftCount}</strong> draft</span>
          <span><strong>0</strong> live sends</span>
        </div>
      </header>

      {(notice || error) && (
        <div className={cls('wfs-banner', error && 'is-error')}>
          <Icon name={error ? 'alert' : 'check'} />
          <span>{error || notice}</span>
        </div>
      )}

      <div className="wfs-shell">
        <WorkflowList
          workflows={workflows}
          detail={selected}
          dryRunResult={dryRunResult}
          selectedId={selectedId}
          loading={loading}
          busy={busy}
          onSelect={(workflowId) => void loadSelected(workflowId)}
          onAddNode={addNodeFromRail}
          onCreateTemplateSet={(payload) => withBusy(async () => {
            const detail = await createWorkflowTemplateSet(requireWorkflow(), payload)
            setSelected(detail)
          }, 'Template set added')}
          onCreateTemplateVariant={(templateSetId, payload) => withBusy(async () => {
            const detail = await createWorkflowTemplateVariant(requireWorkflow(), templateSetId, payload)
            setSelected(detail)
          }, 'Template variant saved')}
          onRenderVariant={renderWorkflowTemplateVariant}
          onSaveTranslation={(variantId, payload) => withBusy(async () => {
            const detail = await upsertWorkflowTranslation(requireWorkflow(), variantId, payload)
            setSelected(detail)
          }, 'Translation saved')}
          onCreateSenderPool={(payload) => withBusy(async () => {
            const detail = await createWorkflowSenderPool(requireWorkflow(), payload)
            setSelected(detail)
          }, 'Sender pool added')}
          onCreateSenderMember={(senderPoolId, payload) => withBusy(async () => {
            const detail = await createWorkflowSenderPoolMember(requireWorkflow(), senderPoolId, payload)
            setSelected(detail)
          }, 'Sender added')}
          onDryRun={(payload) => withBusy(async () => {
            const result = await runWorkflowDryRun(requireWorkflow(), payload)
            setDryRunResult(result)
            openUtilityDrawer('Dry Run')
          }, 'Dry run complete')}
          onOpenUtilityDrawer={openUtilityDrawer}
        />
        <WorkflowBuilder
          detail={selected}
          busy={busy}
          dryRunResult={dryRunResult}
          utilityDrawerOpen={utilityDrawerOpen}
          utilityDrawerTab={utilityDrawerTab}
          onOpenUtilityDrawer={openUtilityDrawer}
          onCloseUtilityDrawer={() => setUtilityDrawerOpen(false)}
          onCreate={(payload) => withBusy(async () => {
            const detail = await createWorkflowDraft(payload)
            setSelected(detail)
          }, 'Draft workflow created')}
          onClone={() => withBusy(async () => {
            const detail = await cloneWorkflowDraft(requireWorkflow())
            setSelected(detail)
          }, 'Workflow cloned')}
          onPause={() => withBusy(async () => {
            const detail = await pauseWorkflowDraft(requireWorkflow())
            setSelected(detail)
          }, 'Workflow paused')}
          onResume={() => withBusy(async () => {
            const detail = await resumeWorkflowDraft(requireWorkflow())
            setSelected(detail)
          }, 'Workflow resumed')}
          onCreateStep={(payload) => withBusy(async () => {
            const detail = await createWorkflowStep(requireWorkflow(), payload)
            setSelected(detail)
          }, 'Step added')}
          onUpdateStep={(stepId, payload) => withSilentBusy(async () => {
            const detail = await updateWorkflowStep(requireWorkflow(), stepId, payload)
            setSelected(detail)
          })}
          onCreateTemplateSet={(payload) => withBusy(async () => {
            const detail = await createWorkflowTemplateSet(requireWorkflow(), payload)
            setSelected(detail)
          }, 'Template set added')}
          onCreateTemplateVariant={(templateSetId, payload) => withBusy(async () => {
            const detail = await createWorkflowTemplateVariant(requireWorkflow(), templateSetId, payload)
            setSelected(detail)
          }, 'Template variant saved')}
          onRenderVariant={renderWorkflowTemplateVariant}
          onSaveTranslation={(variantId, payload) => withBusy(async () => {
            const detail = await upsertWorkflowTranslation(requireWorkflow(), variantId, payload)
            setSelected(detail)
          }, 'Translation saved')}
          onCreateSenderPool={(payload) => withBusy(async () => {
            const detail = await createWorkflowSenderPool(requireWorkflow(), payload)
            setSelected(detail)
          }, 'Sender pool added')}
          onCreateSenderMember={(senderPoolId, payload) => withBusy(async () => {
            const detail = await createWorkflowSenderPoolMember(requireWorkflow(), senderPoolId, payload)
            setSelected(detail)
          }, 'Sender added')}
          onDryRun={(payload) => withBusy(async () => {
            const result = await runWorkflowDryRun(requireWorkflow(), payload)
            setDryRunResult(result)
            openUtilityDrawer('Dry Run')
          }, 'Dry run complete')}
        />
      </div>
    </section>
  )
}

/** @deprecated Legacy Workflow Studio V1 — retained for diagnostics only. */
export const WorkflowStudio = (props: WorkflowStudioProps) => {
  return <WorkflowStudioV2 {...props} />
}

export default WorkflowStudio
