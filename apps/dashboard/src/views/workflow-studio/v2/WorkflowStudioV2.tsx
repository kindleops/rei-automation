import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { ViewLayoutMode, ViewWidthPercent } from '../../../domain/inbox/view-layout'
import { buildWorkflowStepPayload } from '../WorkflowBuilder'
import type { WorkflowNodeLibraryItem } from '../WorkflowList'
import type { Workflow, WorkflowDetail, WorkflowDryRunResult } from '../workflow.types'
import {
  cloneWorkflowDraft,
  createWorkflowDraft,
  createWorkflowStep,
  loadWorkflowDetail,
  loadWorkflowStudio,
  pauseWorkflowDraft,
  resumeWorkflowDraft,
  runWorkflowDryRun,
} from '../workflowStudio.adapter'
import { WorkflowCanvasV2, buildCanvasNodes } from './WorkflowCanvasV2'
import { WorkflowCommandBarV2 } from './WorkflowCommandBarV2'
import { WorkflowInspectorV2 } from './WorkflowInspectorV2'
import { WorkflowNodePaletteV2 } from './WorkflowNodePaletteV2'
import './workflow-studio-v2.css'

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

const defaultCreatePayload = {
  name: 'Owner Acquisition Follow-Up',
  channel: 'sms',
  workflow_type: 'outbound',
  status: 'draft',
  live_send_enabled: false,
  market_scope: ['default'],
  state_scope: ['TX'],
  language_scope: ['en'],
  daily_cap: 75,
  hourly_cap: 15,
  timezone: 'America/Chicago',
}

const sampleDryRunContext = {
  write_audit: true,
  context: {
    conversation_thread_id: 'workflow-studio-preview',
    first_name: 'Jordan',
    seller_display_name: 'Jordan Seller',
    property_address: '123 Main St',
    market: 'default',
    state: 'TX',
    city: 'Austin',
    zip: '78701',
    agent_name: 'Nexus Operator',
    property_type: 'SFR',
    unit_count: '1',
    asking_price: '$250,000',
    offer_price: '$210,000',
    language: 'en',
  },
}

type RailSection = 'workflows' | 'nodes'

interface WorkflowStudioV2Props {
  data?: { workflows?: Workflow[] } | null
  paneWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
}

export const WorkflowStudioV2 = ({
  data,
  paneWidth = '100',
  layoutMode = 'full',
}: WorkflowStudioV2Props) => {
  const [workflows, setWorkflows] = useState<Workflow[]>(data?.workflows ?? [])
  const [selected, setSelected] = useState<WorkflowDetail | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRunResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [railSection, setRailSection] = useState<RailSection>('workflows')
  const [workflowQuery, setWorkflowQuery] = useState('')
  const [consoleOpen, setConsoleOpen] = useState(false)

  const selectedId = selected?.workflow.id ?? null

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
      setSelectedNodeId(null)
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

  const requireWorkflow = () => {
    if (!selected?.workflow.id) throw new Error('Select a workflow')
    return selected.workflow.id
  }

  const filteredWorkflows = useMemo(() => {
    const needle = workflowQuery.trim().toLowerCase()
    if (!needle) return workflows
    return workflows.filter(
      (workflow) =>
        workflow.name.toLowerCase().includes(needle) ||
        workflow.workflow_key.toLowerCase().includes(needle) ||
        workflow.status.toLowerCase().includes(needle),
    )
  }, [workflowQuery, workflows])

  const canvasNodes = useMemo(() => buildCanvasNodes(selected), [selected])
  const selectedCanvasNode = canvasNodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedDryRunStep = selectedCanvasNode
    ? dryRunResult?.steps.find(
        (step) =>
          step.step_id === selectedCanvasNode.id ||
          step.step_key === selectedCanvasNode.key,
      )
    : undefined

  const validationCount =
    (selected?.validation?.errors?.length ?? 0) + (selected?.validation?.warnings?.length ?? 0)

const addNodeFromPalette = (item: WorkflowNodeLibraryItem, position?: { x: number; y: number }) => {
  void withBusy(async () => {
    const workflowId = requireWorkflow()
    const maxOrder = Math.max(0, ...(selected?.steps ?? []).map((step) => Number(step.step_order) || 0))
    const index = selected?.steps.length ?? 0
    const x = position?.x ?? Math.min(1780, 140 + (index * 64))
    const y = position?.y ?? 170 + ((index % 4) * 76)

    const detail = await createWorkflowStep(
      workflowId,
      buildWorkflowStepPayload(item, { x, y }, maxOrder + 10),
    )

    setSelected(detail)
  }, `${item.label} node added`)
}

  const runDryRun = () => {
    void withBusy(async () => {
      const result = await runWorkflowDryRun(requireWorkflow(), sampleDryRunContext)
      setDryRunResult(result)
      setConsoleOpen(true)
    }, 'Dry run complete')
  }

  return (
    <section className={cls('wfs2', `is-width-${paneWidth}`, `is-layout-${layoutMode}`)}>
      <WorkflowCommandBarV2
        detail={selected}
        busy={busy}
        validationCount={validationCount}
        consoleOpen={consoleOpen}
        onToggleConsole={() => setConsoleOpen((open) => !open)}
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
        onDryRun={runDryRun}
      />

      {(notice || error) && (
        <div className={cls('wfs2__banner', error && 'is-error')}>
          <Icon name={error ? 'alert' : 'check'} />
          <span>{error || notice}</span>
        </div>
      )}

      <div className="wfs2__body">
        <aside className="wfs2__rail">
          <div className="wfs2__rail-tabs">
            <button
              type="button"
              className={cls('wfs2__rail-tab', railSection === 'workflows' && 'is-active')}
              onClick={() => setRailSection('workflows')}
            >
              Workflows
            </button>
            <button
              type="button"
              className={cls('wfs2__rail-tab', railSection === 'nodes' && 'is-active')}
              onClick={() => setRailSection('nodes')}
            >
              Nodes
            </button>
          </div>

          <div className="wfs2__rail-body">
            {railSection === 'workflows' ? (
              <>
                <input
                  className="wfs2__search"
                  type="search"
                  placeholder="Search workflows…"
                  value={workflowQuery}
                  onChange={(event) => setWorkflowQuery(event.target.value)}
                />
                <button
                  type="button"
                  className="wfs2__btn is-primary"
                  style={{ width: '100%', marginBottom: '0.55rem' }}
                  disabled={busy}
                  onClick={() => withBusy(async () => {
                    const detail = await createWorkflowDraft(defaultCreatePayload)
                    setSelected(detail)
                  }, 'Draft workflow created')}
                >
                  <Icon name="grid" /> New Workflow
                </button>
                <div className="wfs2__workflow-list">
                  {loading && filteredWorkflows.length === 0 ? (
                    <div className="wfs2__empty">Loading workflows…</div>
                  ) : filteredWorkflows.length === 0 ? (
                    <div className="wfs2__empty">No workflows found.</div>
                  ) : (
                    filteredWorkflows.map((workflow) => (
                      <button
                        key={workflow.id}
                        type="button"
                        className={cls('wfs2__workflow-row', selectedId === workflow.id && 'is-selected')}
                        onClick={() => void loadSelected(workflow.id)}
                      >
                        <span className={cls('wfs2__badge', `is-${workflow.status}`)}>{workflow.status}</span>
                        <strong>{workflow.name}</strong>
                        <small>{workflow.workflow_key} · {workflow.channel}</small>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <WorkflowNodePaletteV2 onAddNode={addNodeFromPalette} disabled={busy || !selected} />
            )}
          </div>

          <footer className="wfs2__rail-footer">
            <button type="button" className="wfs2__future-link" disabled>Template Library (coming soon)</button>
            <button type="button" className="wfs2__future-link" disabled>Sender Control (coming soon)</button>
            <button type="button" className="wfs2__future-link" disabled>Execution Center (coming soon)</button>
          </footer>
        </aside>

        <WorkflowCanvasV2
          detail={selected}
          dryRunResult={dryRunResult}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          busy={busy}
          onDropNode={addNodeFromPalette}
          onCreateDraft={() => withBusy(async () => {
            const detail = await createWorkflowDraft(defaultCreatePayload)
            setSelected(detail)
          }, 'Draft workflow created')}
        />

        <WorkflowInspectorV2
          node={selectedCanvasNode}
          detail={selected}
          dryRunStep={selectedDryRunStep}
          dryRunResult={dryRunResult}
        />
      </div>

      {consoleOpen && (
        <section className="wfs2-console">
          <header className="wfs2-console__head">
            <strong>Execution Console</strong>
            <span>{dryRunResult ? `${dryRunResult.steps.length} steps` : 'No dry run yet'}</span>
          </header>
          <div className="wfs2-console__body">
            {!dryRunResult ? (
              <p>Run a dry-run simulation to see node-level execution proof. Live sends remain blocked.</p>
            ) : (
              <>
                <p>
                  <Icon name="shield" /> no_outbound_messages_sent=
                  {dryRunResult.no_outbound_messages_sent ? 'true' : 'false'} · live_send_blocked=
                  {dryRunResult.live_send_blocked ? 'true' : 'false'}
                </p>
                {dryRunResult.steps.map((step, index) => (
                  <div key={step.step_id ?? step.step_key ?? `${step.node_type}-${index}`} className="wfs2-console__step">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{step.label}</strong>
                      <div>{step.node_type} / {step.status}</div>
                    </div>
                    <em>{step.live_send_blocked ? 'Blocked' : 'OK'}</em>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      )}
    </section>
  )
}

export default WorkflowStudioV2

export function isWorkflowStudioV2Enabled(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('workflow_v2') === '1') return true
  try {
    return localStorage.getItem('WORKFLOW_STUDIO_V2') === 'true'
  } catch {
    return false
  }
}
