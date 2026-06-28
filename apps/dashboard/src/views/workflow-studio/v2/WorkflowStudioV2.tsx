import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { ViewLayoutMode, ViewWidthPercent } from '../../../domain/inbox/view-layout'
import { buildWorkflowStepPayload } from '../WorkflowBuilder'
import type { WorkflowNodeLibraryItem } from '../WorkflowList'
import type { Workflow, WorkflowConsoleEvent, WorkflowDetail, WorkflowDryRunResult } from '../workflow.types'
import {
  archiveWorkflow,
  cloneLegacyWorkflow,
  cloneWorkflowDraft,
  createWorkflowDraft,
  createWorkflowStep,
  deleteWorkflowDraft,
  enableWorkflowLive,
  insertNodeOnEdge,
  loadAnalytics,
  loadWorkflowDetail,
  loadWorkflowStudio,
  mutateWorkflowGraph,
  pauseWorkflowDraft,
  publishWorkflow,
  renameWorkflow,
  restoreWorkflow,
  resumeWorkflowDraft,
  runWorkflowDryRun,
  type GraphMutationOperation,
} from '../workflowStudio.adapter'
import { WorkflowCanvasV2, buildCanvasNodes, type WorkflowCanvasV2Handle } from './WorkflowCanvasV2'
import { WorkflowCommandBarV2 } from './WorkflowCommandBarV2'
import { WorkflowConsoleV2 } from './WorkflowConsoleV2'
import { WorkflowInspectorV2 } from './WorkflowInspectorV2'
import { WorkflowLiveModeV2 } from './WorkflowLiveModeV2'
import { WorkflowNavigatorV2, type NavigatorAction } from './WorkflowNavigatorV2'
import { WorkflowNodePaletteV2 } from './WorkflowNodePaletteV2'
import { useWorkflowStudioPrefs, useWorkflowStudioShortcuts } from './workflow-studio-state'
import { WorkflowApiErrorPanel } from './WorkflowApiErrorPanel'
import { WorkflowCreateModal, type WorkflowCreatePayload } from './WorkflowCreateModal'
import { WorkflowGlassModal } from './WorkflowGlassModal'
import {
  canMutateGraph,
  resolveWorkflowStudioMode,
  studioModeLabel,
} from './workflow-studio-mode'
import {
  applyUniversalContextToWorkflowStudio,
  useSellerAutomationStudioLocation,
} from './workflow-studio-routing'
import { SellerAutomationStudioPanel } from './SellerAutomationStudioPanel'
import { UniversalLeadStateControls } from '../../../domain/lead-state/UniversalLeadStateControls'
import './workflow-studio-v2.css'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const parseWorkflowError = (err: unknown) => {
  const raw = err instanceof Error ? err.message : String(err || 'Workflow request failed')
  const status = raw.match(/\[(\d{3})\]/)?.[1] ?? null
  const traceMatch = raw.match(/trace[_-]?id[:\s]+([a-f0-9-]{8,})/i)
  return {
    message: raw,
    status,
    traceId: traceMatch?.[1] ?? null,
    apiFailure: raw.includes('/api/cockpit/workflows'),
  }
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
  const [liveMode, setLiveMode] = useState<'off' | 'live' | 'demo'>('off')
  const [layoutRevision, setLayoutRevision] = useState(0)
  const [apiAvailable, setApiAvailable] = useState(true)
  const [apiError, setApiError] = useState<{ message: string; traceId?: string | null } | null>(null)
  const [offlineDemo, setOfflineDemo] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Workflow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null)

  const selectedId = selected?.workflow.id ?? null
  const studioContext = useMemo(() => applyUniversalContextToWorkflowStudio(), [])
  const contextThreadKey = studioContext.thread_key ?? null
  const { sellerAutomationMode, focus: sellerFocus } = useSellerAutomationStudioLocation()

  useEffect(() => {
    if (sellerAutomationMode) setRailSection('nodes')
  }, [sellerAutomationMode])

  const refreshList = useCallback(async () => {
    const model = await loadWorkflowStudio()
    setWorkflows(model.workflows)
    setApiAvailable(true)
    setApiError(null)
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
      const parsed = parseWorkflowError(err)
      if (parsed.apiFailure) {
        setApiAvailable(false)
        setApiError({ message: parsed.message, traceId: parsed.traceId })
      }
      setError(parsed.message)
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
        if (cancelled) return
        const parsed = parseWorkflowError(err)
        if (parsed.apiFailure) {
          setApiAvailable(false)
          setApiError({ message: parsed.message, traceId: parsed.traceId })
        }
        setError(parsed.message)
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
      const parsed = parseWorkflowError(err)
      if (parsed.apiFailure) {
        setApiAvailable(false)
        setApiError({ message: parsed.message, traceId: parsed.traceId })
      }
      setError(parsed.message)
    } finally {
      setBusy(false)
    }
  }

  const requireWorkflow = () => {
    if (!selected?.workflow.id) throw new Error('Select a workflow')
    return selected.workflow.id
  }

  const studioMode = useMemo(
    () => resolveWorkflowStudioMode(selected, offlineDemo),
    [offlineDemo, selected],
  )
  const graphMutable = canMutateGraph(studioMode, apiAvailable)
  const modeBanner = studioModeLabel(studioMode)

  const canvasNodes = useMemo(
    () => buildCanvasNodes(selected, { offlineDemo }),
    [offlineDemo, selected],
  )
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

  const buildMutationPayload = (
    item: WorkflowNodeLibraryItem,
    position: { x: number; y: number },
    maxOrder: number,
  ) => ({
    node_type: item.type,
    label: item.label,
    position_x: position.x,
    position_y: position.y,
    step_payload: buildWorkflowStepPayload(item, position, maxOrder),
  })

  const applyGraphPlacement = (
    item: WorkflowNodeLibraryItem,
    target: { id: string; x: number; y: number },
    placement: GraphMutationOperation,
    position?: { x: number; y: number },
  ) => {
    if (!graphMutable) {
      setError('Graph editing is disabled for this workflow mode.')
      return
    }
    void withBusy(async () => {
      const workflowId = requireWorkflow()
      const maxOrder = Math.max(0, ...(selected?.steps ?? []).map((step) => Number(step.step_order) || 0))
      const coords = position ?? { x: target.x, y: target.y }
      const detail = await mutateWorkflowGraph(workflowId, {
        operation: placement,
        target_node_id: target.id,
        source_node_id: target.id,
        branch_kind: placement === 'add-branch' ? 'true' : undefined,
        ...buildMutationPayload(item, coords, maxOrder + 10),
      })
      setSelected(detail)
      canvasRef.current?.syncFromDetail(detail)
    }, `${item.label} ${placement.replace(/-/g, ' ')}`)
  }

  const addNodeFromPalette = (
    item: WorkflowNodeLibraryItem,
    position?: { x: number; y: number },
  ) => {
    if (!graphMutable) {
      setError('Graph editing is disabled for this workflow mode.')
      return
    }
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

  const insertOnEdge = (
    item: WorkflowNodeLibraryItem,
    connection: { id: string; from: { id: string }; to: { id: string }; kind: string },
    position: { x: number; y: number },
  ) => {
    if (!graphMutable) {
      setError('Graph editing is disabled for this workflow mode.')
      return
    }
    void withBusy(async () => {
      const workflowId = requireWorkflow()
      const maxOrder = Math.max(0, ...(selected?.steps ?? []).map((step) => Number(step.step_order) || 0))
      const detail = await insertNodeOnEdge(workflowId, {
        edge_id: connection.id,
        edge: {
          from_step_id: connection.from.id,
          to_step_id: connection.to.id,
          kind: connection.kind,
        },
        ...buildMutationPayload(item, position, maxOrder + 10),
      })
      setSelected(detail)
      canvasRef.current?.syncFromDetail(detail)
    }, `${item.label} inserted on edge`)
  }

  const handleNavigatorAction = (workflow: Workflow, action: NavigatorAction) => {
    if (action === 'open') {
      void loadSelected(workflow.id)
      return
    }

    if (action === 'rename') {
      setRenameTarget(workflow)
      setRenameValue(workflow.name)
      return
    }

    if (action === 'clone-legacy') {
      void withBusy(async () => {
        const detail = await cloneLegacyWorkflow(workflow.id)
        setSelected(detail)
      }, 'Legacy workflow cloned to V2')
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
      setDeleteTarget(workflow)
    }
  }

  const submitCreateWorkflow = (payload: WorkflowCreatePayload) => {
    void withBusy(async () => {
      const detail = await createWorkflowDraft({
        name: payload.name,
        description: payload.description,
        channel: payload.channel,
        workflow_type: payload.workflow_type,
        trigger_type: payload.trigger_type,
        operational_mode: payload.operational_mode,
        market_scope: payload.market_scope,
        state_scope: payload.state_scope,
        language_scope: payload.language_scope,
        asset_scope: payload.asset_scope,
        start_from: payload.start_from,
        status: 'draft',
        live_send_enabled: false,
      })
      setCreateOpen(false)
      setSelected(detail)
    }, 'Draft workflow created')
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
        liveMode={liveMode !== 'off'}
        onToggleConsole={() => setConsoleOpen((open) => !open)}
        onToggleLiveMode={() => setLiveMode((value) => (value === 'off' ? 'live' : value === 'live' ? 'demo' : 'off'))}
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
          setLiveMode('live')
        }, 'Workflow live mode armed')}
      />

      {!apiAvailable && apiError ? (
        <WorkflowApiErrorPanel
          message={apiError.message}
          traceId={apiError.traceId}
          onRetry={() => {
            setLoading(true)
            void refreshList()
              .then((rows) => {
                const first = rows[0]
                if (first) return loadSelected(first.id)
              })
              .finally(() => setLoading(false))
          }}
          onOfflineDemo={() => {
            setOfflineDemo(true)
            setApiError(null)
            setError('')
          }}
        />
      ) : null}

      {modeBanner ? (
        <div className={cls('wfs2__banner', studioMode !== 'canonical' && 'is-warning')}>
          <Icon name="alert" />
          <span>{modeBanner}</span>
        </div>
      ) : null}

      {(notice || (error && apiAvailable)) && (
        <div className={cls('wfs2__banner', error && 'is-error')}>
          <Icon name={error ? 'alert' : 'check'} />
          <span>{error || notice}</span>
        </div>
      )}

      {contextThreadKey ? (
        <div className="wfs2__lead-state-strip">
          <UniversalLeadStateControls
            thread={{ threadKey: contextThreadKey, id: contextThreadKey }}
            sourceView="workflow_studio"
            compact
          />
        </div>
      ) : null}

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
                  onCreate={() => setCreateOpen(true)}
                  onAction={handleNavigatorAction}
                />
              ) : (
                <WorkflowNodePaletteV2
                  onAddNode={addNodeFromPalette}
                  disabled={busy || !selected || !graphMutable}
                  offlineDemo={offlineDemo}
                  sellerAutomationMode={sellerAutomationMode}
                />
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
          {sellerAutomationMode && (
            <SellerAutomationStudioPanel
              focus={{
                propertyId: sellerFocus.propertyId,
                participantId: sellerFocus.participantId,
                threadId: sellerFocus.threadId ?? contextThreadKey,
                executionId: sellerFocus.executionId,
              }}
              replayMode={sellerFocus.replayMode}
            />
          )}
          {!sellerAutomationMode && (
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
              applyGraphPlacement(item, target, placement, offset)
            }}
            readOnly={!graphMutable}
            offlineDemo={offlineDemo}
            onDropOnEdge={(item, connection, position) => {
              void insertOnEdge(item, connection, position)
            }}
            onCreateDraft={() => setCreateOpen(true)}
            liveOverlay={(
              <WorkflowLiveModeV2
                workflowId={selectedId}
                enabled={liveMode === 'live'}
                demoMode={liveMode === 'demo'}
                nodes={canvasNodes}
              />
            )}
          />
          )}
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
              readOnly={!graphMutable}
              studioMode={studioMode}
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
        dryRunEvents={fallbackConsoleEvents}
        apiAvailable={apiAvailable}
      />

      <WorkflowCreateModal
        open={createOpen}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onSubmit={submitCreateWorkflow}
      />

      <WorkflowGlassModal
        open={Boolean(renameTarget)}
        title="Rename workflow"
        onClose={() => setRenameTarget(null)}
        footer={(
          <>
            <button type="button" className="wfs2__btn is-ghost" onClick={() => setRenameTarget(null)}>Cancel</button>
            <button
              type="button"
              className="wfs2__btn is-primary"
              disabled={!renameValue.trim() || busy}
              onClick={() => {
                if (!renameTarget) return
                void withBusy(async () => {
                  const detail = await renameWorkflow(renameTarget.id, renameValue.trim())
                  if (selectedId === renameTarget.id) setSelected(detail)
                  setRenameTarget(null)
                }, 'Workflow renamed')
              }}
            >
              Save
            </button>
          </>
        )}
      >
        <label className="wfs2-modal__field">
          <span>Workflow name</span>
          <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        </label>
      </WorkflowGlassModal>

      <WorkflowGlassModal
        open={Boolean(deleteTarget)}
        title="Delete draft"
        subtitle="Only custom drafts without run history can be deleted."
        onClose={() => setDeleteTarget(null)}
        footer={(
          <>
            <button type="button" className="wfs2__btn is-ghost" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button
              type="button"
              className="wfs2__btn is-danger"
              disabled={busy}
              onClick={() => {
                if (!deleteTarget) return
                void withBusy(async () => {
                  await deleteWorkflowDraft(deleteTarget.id)
                  if (selectedId === deleteTarget.id) setSelected(null)
                  setDeleteTarget(null)
                }, 'Draft deleted')
              }}
            >
              Delete draft
            </button>
          </>
        )}
      >
        <p>Delete draft &quot;{deleteTarget?.name}&quot;? This cannot be undone.</p>
      </WorkflowGlassModal>

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