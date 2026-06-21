import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { ViewLayoutMode, ViewWidthPercent } from '../../../domain/inbox/view-layout'
import { buildWorkflowStepPayload } from '../WorkflowBuilder'
import type { WorkflowNodeLibraryItem } from '../WorkflowList'
import type { Workflow, WorkflowConsoleEvent, WorkflowDetail, WorkflowDryRunResult } from '../workflow.types'
import {
  archiveWorkflow,
  cloneWorkflowDraft,
  createWorkflowDraft,
  createWorkflowStep,
  deleteWorkflowDraft,
  enableWorkflowLive,
  insertNodeOnEdge,
  loadAnalytics,
  loadWorkflowDetail,
  loadWorkflowStudio,
  pauseWorkflowDraft,
  publishWorkflow,
  renameWorkflow,
  restoreWorkflow,
  resumeWorkflowDraft,
  runWorkflowDryRun,
} from '../workflowStudio.adapter'
import { WorkflowCanvasV2, buildCanvasNodes, type WorkflowCanvasV2Handle } from './WorkflowCanvasV2'
import { WorkflowCommandBarV2 } from './WorkflowCommandBarV2'
import { WorkflowConsoleV2 } from './WorkflowConsoleV2'
import { WorkflowInspectorV2 } from './WorkflowInspectorV2'
import { WorkflowLiveModeV2 } from './WorkflowLiveModeV2'
import { WorkflowNavigatorV2, type NavigatorAction } from './WorkflowNavigatorV2'
import { WorkflowNodePaletteV2 } from './WorkflowNodePaletteV2'
import { useWorkflowStudioPrefs, useWorkflowStudioShortcuts } from './workflow-studio-state'
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
  const canvasRef = useRef<WorkflowCanvasV2Handle | null>(null)
  const { prefs, toggleLeftRail, toggleRightRail, toggleFocusMode } = useWorkflowStudioPrefs()

  const [workflows, setWorkflows] = useState<Workflow[]>(data?.workflows ?? [])
  const [selected, setSelected] = useState<WorkflowDetail | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRunResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [railSection, setRailSection] = useState<RailSection>('workflows')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [liveMode, setLiveMode] = useState(false)
  const [layoutRevision, setLayoutRevision] = useState(0)

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
      setSelectedNodeIds([])
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

  useEffect(() => {
    setLayoutRevision((value) => value + 1)
  }, [prefs.leftRailCollapsed, prefs.rightRailCollapsed, prefs.focusMode])

  useWorkflowStudioShortcuts({
    onToggleLeftRail: toggleLeftRail,
    onToggleRightRail: toggleRightRail,
    onToggleFocusMode: toggleFocusMode,
    onUndo: () => canvasRef.current?.undo(),
    onRedo: () => canvasRef.current?.redo(),
  })

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

  const fallbackConsoleEvents = useMemo<WorkflowConsoleEvent[]>(() => {
    if (!dryRunResult) return []
    return dryRunResult.steps.map((step, index) => ({
      id: step.step_id ?? step.step_key ?? `dry-${index}`,
      timestamp: new Date().toISOString(),
      seller: String(sampleDryRunContext.context.seller_display_name),
      property: String(sampleDryRunContext.context.property_address),
      workflow: selected?.workflow.name,
      node: step.label,
      transition: step.status,
      duration_ms: 120 + index * 40,
      blocker: step.live_send_blocked ? 'live_send_blocked' : null,
      trace_id: `dry-run-${index + 1}`,
      status: step.status,
    }))
  }, [dryRunResult, selected?.workflow.name])

  const addNodeFromPalette = (
    item: WorkflowNodeLibraryItem,
    position?: { x: number; y: number },
  ) => {
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

  const insertOnEdge = async (
    item: WorkflowNodeLibraryItem,
    connection: { from: { id: string; key: string }; to: { id: string; key: string }; kind: string },
    position: { x: number; y: number },
  ) => {
    const workflowId = requireWorkflow()
    const payload = {
      node_type: item.type,
      label: item.label,
      position,
      edge: {
        from_step_id: connection.from.id,
        to_step_id: connection.to.id,
        kind: connection.kind,
      },
      step_payload: buildWorkflowStepPayload(item, position, (selected?.steps.length ?? 0) * 10 + 10),
    }

    try {
      const detail = await insertNodeOnEdge(workflowId, payload)
      setSelected(detail)
      setNotice(`${item.label} inserted on edge`)
      await refreshList()
    } catch {
      addNodeFromPalette(item, position)
    }
  }

  const handleNavigatorAction = (workflow: Workflow, action: NavigatorAction) => {
    if (action === 'open') {
      void loadSelected(workflow.id)
      return
    }

    if (action === 'rename') {
      const nextName = window.prompt('Rename workflow', workflow.name)
      if (!nextName?.trim()) return
      void withBusy(async () => {
        const detail = await renameWorkflow(workflow.id, nextName.trim())
        if (selectedId === workflow.id) setSelected(detail)
      }, 'Workflow renamed')
      return
    }

    if (action === 'duplicate') {
      void withBusy(async () => {
        const detail = await cloneWorkflowDraft(workflow.id)
        setSelected(detail)
      }, 'Workflow duplicated')
      return
    }

    if (action === 'view-runs') {
      void loadSelected(workflow.id)
      setConsoleOpen(true)
      return
    }

    if (action === 'view-analytics') {
      void withBusy(async () => {
        await loadAnalytics(workflow.id)
        setNotice(`Analytics loaded for ${workflow.name}`)
      }, 'Analytics refreshed')
      return
    }

    if (action === 'version-history') {
      setNotice(`Version history for ${workflow.name} (v${workflow.version ?? '1'})`)
      return
    }

    if (action === 'enable') {
      void withBusy(async () => {
        const detail = await enableWorkflowLive(workflow.id)
        if (selectedId === workflow.id) setSelected(detail)
      }, 'Workflow enabled')
      return
    }

    if (action === 'pause') {
      void withBusy(async () => {
        const detail = await pauseWorkflowDraft(workflow.id)
        if (selectedId === workflow.id) setSelected(detail)
      }, 'Workflow paused')
      return
    }

    if (action === 'archive') {
      void withBusy(async () => {
        const detail = await archiveWorkflow(workflow.id)
        if (selectedId === workflow.id) setSelected(detail)
      }, 'Workflow archived')
      return
    }

    if (action === 'restore') {
      void withBusy(async () => {
        const detail = await restoreWorkflow(workflow.id)
        if (selectedId === workflow.id) setSelected(detail)
      }, 'Workflow restored')
      return
    }

    if (action === 'delete-draft') {
      if (workflow.is_system_template || workflow.status !== 'draft') {
        setError('Only custom drafts can be deleted.')
        return
      }
      if (!window.confirm(`Delete draft "${workflow.name}"?`)) return
      void withBusy(async () => {
        await deleteWorkflowDraft(workflow.id)
        if (selectedId === workflow.id) setSelected(null)
      }, 'Draft deleted')
    }
  }

  const runDryRun = () => {
    void withBusy(async () => {
      const result = await runWorkflowDryRun(requireWorkflow(), sampleDryRunContext)
      setDryRunResult(result)
      setConsoleOpen(true)
    }, 'Dry run complete')
  }

  return (
    <section
      className={cls(
        'wfs2',
        `is-width-${paneWidth}`,
        `is-layout-${layoutMode}`,
        prefs.focusMode && 'is-focus-mode',
        prefs.leftRailCollapsed && 'is-left-collapsed',
        prefs.rightRailCollapsed && 'is-right-collapsed',
      )}
    >
      <WorkflowCommandBarV2
        detail={selected}
        busy={busy}
        validationCount={validationCount}
        consoleOpen={consoleOpen}
        liveMode={liveMode}
        onToggleConsole={() => setConsoleOpen((open) => !open)}
        onToggleLiveMode={() => setLiveMode((value) => !value)}
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
        onPublish={() => withBusy(async () => {
          const detail = await publishWorkflow(requireWorkflow(), { validate: true })
          setSelected(detail)
        }, 'Workflow published')}
        onGoLive={() => withBusy(async () => {
          const detail = await enableWorkflowLive(requireWorkflow())
          setSelected(detail)
          setLiveMode(true)
        }, 'Workflow live mode armed')}
      />

      {(notice || error) && (
        <div className={cls('wfs2__banner', error && 'is-error')}>
          <Icon name={error ? 'alert' : 'check'} />
          <span>{error || notice}</span>
        </div>
      )}

      <div className="wfs2__body">
        {!prefs.focusMode && !prefs.leftRailCollapsed && (
          <aside className="wfs2__rail wfs2__rail--left">
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
              <button
                type="button"
                className="wfs2__rail-collapse"
                onClick={toggleLeftRail}
                title="Collapse left rail (⌘B)"
              >
                <Icon name="chevron-left" />
              </button>
            </div>

            <div className="wfs2__rail-body">
              {railSection === 'workflows' ? (
                <WorkflowNavigatorV2
                  workflows={workflows}
                  selectedId={selectedId}
                  loading={loading}
                  busy={busy}
                  onSelect={(workflowId) => void loadSelected(workflowId)}
                  onCreate={() => withBusy(async () => {
                    const detail = await createWorkflowDraft(defaultCreatePayload)
                    setSelected(detail)
                  }, 'Draft workflow created')}
                  onAction={handleNavigatorAction}
                />
              ) : (
                <WorkflowNodePaletteV2 onAddNode={addNodeFromPalette} disabled={busy || !selected} />
              )}
            </div>
          </aside>
        )}

        {(prefs.focusMode || prefs.leftRailCollapsed) && (
          <button
            type="button"
            className="wfs2__rail-reveal is-left"
            onClick={toggleLeftRail}
            title="Show left rail (⌘B)"
          >
            <Icon name="chevron-right" />
          </button>
        )}

        <div className="wfs2__canvas-host">
          <WorkflowCanvasV2
            ref={canvasRef}
            detail={selected}
            dryRunResult={dryRunResult}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            onSelectNode={setSelectedNodeId}
            onSelectNodes={setSelectedNodeIds}
            busy={busy}
            layoutRevision={layoutRevision}
            onDropNode={addNodeFromPalette}
            onDropOnNode={(item, target, placement) => {
              const offset =
                placement === 'insert-before' ? { x: target.x - 120, y: target.y } :
                placement === 'add-branch' ? { x: target.x, y: target.y + 160 } :
                placement === 'replace' ? { x: target.x, y: target.y } :
                { x: target.x + 120, y: target.y }
              addNodeFromPalette(item, offset)
            }}
            onDropOnEdge={(item, connection, position) => {
              void insertOnEdge(item, connection, position)
            }}
            onCreateDraft={() => withBusy(async () => {
              const detail = await createWorkflowDraft(defaultCreatePayload)
              setSelected(detail)
            }, 'Draft workflow created')}
            liveOverlay={(
              <WorkflowLiveModeV2
                workflowId={selectedId}
                enabled={liveMode}
                nodes={canvasNodes}
              />
            )}
          />
        </div>

        {!prefs.focusMode && !prefs.rightRailCollapsed && (
          <div className="wfs2__inspector-wrap">
            <button
              type="button"
              className="wfs2__rail-collapse is-right"
              onClick={toggleRightRail}
              title="Collapse right rail (⌘I)"
            >
              <Icon name="chevron-right" />
            </button>
            <WorkflowInspectorV2
              node={selectedCanvasNode}
              detail={selected}
              dryRunStep={selectedDryRunStep}
              dryRunResult={dryRunResult}
            />
          </div>
        )}

        {(prefs.focusMode || prefs.rightRailCollapsed) && (
          <button
            type="button"
            className="wfs2__rail-reveal is-right"
            onClick={toggleRightRail}
            title="Show right rail (⌘I)"
          >
            <Icon name="chevron-left" />
          </button>
        )}
      </div>

      <WorkflowConsoleV2
        workflowId={selectedId}
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        fallbackEvents={fallbackConsoleEvents}
      />

      {prefs.focusMode && (
        <button
          type="button"
          className="wfs2__focus-exit"
          onClick={toggleFocusMode}
          title="Exit focus mode (⌘⇧F)"
        >
          <Icon name="maximize" /> Exit Focus
        </button>
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