import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  applySellerAutomationControl,
  loadSellerAutomationExecutionDetail,
  loadSellerAutomationHistory,
  loadSellerAutomationLive,
  loadSellerAutomationRegistry,
} from '../sellerAutomation.adapter'
import { subscribeSellerAutomationRealtime } from '../sellerAutomationRealtime'
import type {
  SellerAutomationExecutionStep,
  SellerAutomationRegistryEdge,
  SellerAutomationRegistryNode,
  SellerAutomationRegistryResponse,
  SellerExecutionStatus,
} from '../seller-automation.types'
import { SELLER_AUTOMATION_WORKFLOW_ID } from '../seller-automation.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const STATUS_CLASS: Record<SellerExecutionStatus, string> = {
  waiting: 'is-waiting',
  running: 'is-running',
  succeeded: 'is-succeeded',
  blocked: 'is-blocked',
  needs_review: 'is-needs-review',
  failed: 'is-failed',
  retrying: 'is-retrying',
  skipped: 'is-skipped',
}

const LIVE_POLL_MS = 2500
const NODE_WIDTH = 168
const NODE_HEIGHT = 56

export interface SellerAutomationFocus {
  propertyId?: string | null
  participantId?: string | null
  threadId?: string | null
  executionId?: string | null
}

interface SellerAutomationStudioPanelProps {
  focus: SellerAutomationFocus
  replayMode?: boolean
}

interface CanvasNode {
  id: string
  actionKey: string
  label: string
  x: number
  y: number
  status: SellerExecutionStatus
  color: string
}

function layoutRegistryNodes(
  nodes: SellerAutomationRegistryNode[],
  nodeStates: Record<string, { status: SellerExecutionStatus }>,
): CanvasNode[] {
  const cols = 4
  const xGap = 220
  const yGap = 110
  return nodes.map((node, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const state = nodeStates[node.node_type]
    return {
      id: node.node_type,
      actionKey: node.action_key,
      label: node.display_name,
      x: 40 + col * xGap,
      y: 40 + row * yGap,
      status: state?.status ?? 'waiting',
      color: node.color || '#6366f1',
    }
  })
}

function buildActiveEdges(
  steps: SellerAutomationExecutionStep[],
  edges: SellerAutomationRegistryEdge[],
  nodeByAction: Map<string, string>,
): Array<{ from: string; to: string }> {
  const actionOrder = steps.map((step) => step.action_key)
  const out: Array<{ from: string; to: string }> = []
  for (let i = 1; i < actionOrder.length; i += 1) {
    const from = nodeByAction.get(actionOrder[i - 1])
    const to = nodeByAction.get(actionOrder[i])
    if (from && to) out.push({ from, to })
  }
  for (const edge of edges) {
    const fromIdx = actionOrder.indexOf(edge.from_action_key)
    const toIdx = actionOrder.indexOf(edge.to_action_key)
    if (fromIdx >= 0 && toIdx >= 0 && toIdx === fromIdx + 1) continue
    if (fromIdx >= 0 && toIdx > fromIdx) {
      const from = nodeByAction.get(edge.from_action_key)
      const to = nodeByAction.get(edge.to_action_key)
      if (from && to) out.push({ from, to })
    }
  }
  const seen = new Set<string>()
  return out.filter((edge) => {
    const key = `${edge.from}->${edge.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const SellerAutomationCanvasNode = memo(({
  node,
  onOpen,
  isOnPath,
}: {
  node: CanvasNode
  onOpen: () => void
  isOnPath: boolean
}) => (
  <button
    type="button"
    className={[
      'wfs2-seller-automation__node',
      STATUS_CLASS[node.status],
      isOnPath ? 'is-on-path' : '',
      node.status === 'running' ? 'is-active' : '',
    ].filter(Boolean).join(' ')}
    style={{ left: node.x, top: node.y, borderColor: node.color, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
    onClick={onOpen}
  >
    <span className="wfs2-seller-automation__node-label">{node.label}</span>
    <span className="wfs2-seller-automation__node-status">{node.status}</span>
  </button>
))

SellerAutomationCanvasNode.displayName = 'SellerAutomationCanvasNode'

export const SellerAutomationStudioPanel = ({
  focus,
  replayMode = false,
}: SellerAutomationStudioPanelProps) => {
  const [registry, setRegistry] = useState<SellerAutomationRegistryResponse | null>(null)
  const [liveSince, setLiveSince] = useState<string | null>(null)
  const [nodeStates, setNodeStates] = useState<Record<string, { status: SellerExecutionStatus }>>({})
  const [steps, setSteps] = useState<SellerAutomationExecutionStep[]>([])
  const [executionId, setExecutionId] = useState<string | null>(focus.executionId ?? null)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [inspector, setInspector] = useState<SellerAutomationExecutionStep | null>(null)
  const [history, setHistory] = useState<Array<{ id: string; started_at: string; status: string }>>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [realtimeStatus, setRealtimeStatus] = useState<'disabled' | 'connecting' | 'connected' | 'error'>('disabled')
  const detailCache = useRef<Map<string, SellerAutomationExecutionStep>>(new Map())
  const pollFallbackRef = useRef(false)

  const nodeByAction = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of registry?.nodes ?? []) map.set(node.action_key, node.node_type)
    return map
  }, [registry?.nodes])

  const canvasNodes = useMemo(
    () => layoutRegistryNodes(registry?.nodes ?? [], nodeStates),
    [registry?.nodes, nodeStates],
  )

  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    for (const node of canvasNodes) map.set(node.id, { x: node.x, y: node.y })
    return map
  }, [canvasNodes])

  const activeEdges = useMemo(
    () => buildActiveEdges(steps, registry?.edges ?? [], nodeByAction),
    [nodeByAction, registry?.edges, steps],
  )

  const applyStepPatch = useCallback((step: SellerAutomationExecutionStep) => {
    detailCache.current.set(step.id, step)
    setSteps((prev) => {
      const byId = new Map(prev.map((row) => [row.id, row]))
      byId.set(step.id, step)
      return [...byId.values()].sort((a, b) => a.started_at.localeCompare(b.started_at))
    })
    setNodeStates((prev) => ({
      ...prev,
      [step.node_id]: { status: step.execution_status },
    }))
    setLiveSince(step.started_at)
  }, [])

  const refreshRegistry = useCallback(async () => {
    const payload = await loadSellerAutomationRegistry()
    setRegistry(payload)
  }, [])

  const patchLive = useCallback(async () => {
    const live = await loadSellerAutomationLive({
      propertyId: focus.propertyId,
      participantId: focus.participantId,
      threadId: focus.threadId,
      executionId: executionId ?? focus.executionId,
      since: liveSince,
      replay: replayMode,
    })
    if (live.execution?.id) setExecutionId(live.execution.id)
    setNodeStates((prev) => {
      const next = { ...prev }
      for (const [nodeId, state] of Object.entries(live.node_states || {})) {
        next[nodeId] = { status: state.status }
      }
      return next
    })
    if (live.steps?.length) {
      setSteps((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]))
        for (const step of live.steps) {
          byId.set(step.id, step)
          detailCache.current.set(step.id, step)
        }
        return [...byId.values()].sort((a, b) => a.started_at.localeCompare(b.started_at))
      })
      setLiveSince(live.updated_at)
    }
  }, [executionId, focus.executionId, focus.participantId, focus.propertyId, focus.threadId, liveSince, replayMode])

  const refreshHistory = useCallback(async () => {
    const result = await loadSellerAutomationHistory({
      propertyId: focus.propertyId,
      participantId: focus.participantId,
      threadId: focus.threadId,
      limit: 40,
    })
    setHistory((result.executions as Array<{ id: string; started_at: string; status: string }>) ?? [])
  }, [focus.participantId, focus.propertyId, focus.threadId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void Promise.all([refreshRegistry(), patchLive(), refreshHistory()])
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Seller automation unavailable')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [focus.propertyId, focus.participantId, focus.threadId, focus.executionId, refreshHistory, refreshRegistry, patchLive])

  useEffect(() => {
    if (replayMode) return undefined
    return subscribeSellerAutomationRealtime(
      {
        executionId: executionId ?? focus.executionId,
        threadId: focus.threadId,
        propertyId: focus.propertyId,
      },
      {
        onStep: applyStepPatch,
        onStatus: setRealtimeStatus,
      },
    )
  }, [
    applyStepPatch,
    executionId,
    focus.executionId,
    focus.propertyId,
    focus.threadId,
    replayMode,
  ])

  useEffect(() => {
    if (replayMode) return undefined
    pollFallbackRef.current = realtimeStatus === 'error' || realtimeStatus === 'disabled'
    if (!pollFallbackRef.current) return undefined
    const timer = window.setInterval(() => { void patchLive() }, LIVE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [patchLive, realtimeStatus, replayMode])

  const openInspector = useCallback(async (step: SellerAutomationExecutionStep) => {
    setSelectedStepId(step.id)
    const cached = detailCache.current.get(step.id)
    if (cached) {
      setInspector(cached)
      return
    }
    if (executionId) {
      const detail = await loadSellerAutomationExecutionDetail(executionId)
      const match = detail.steps.find((s) => s.id === step.id) ?? step
      detailCache.current.set(match.id, match)
      setInspector(match)
      return
    }
    setInspector(step)
  }, [executionId])

  const runControl = useCallback(async (control: string) => {
    if (!executionId || replayMode) return
    await applySellerAutomationControl(executionId, control)
    await patchLive()
    await refreshHistory()
  }, [executionId, patchLive, refreshHistory, replayMode])

  const activePath = useMemo(() => new Set(steps.map((s) => s.node_id)), [steps])
  const canvasHeight = useMemo(() => {
    const maxY = canvasNodes.reduce((max, node) => Math.max(max, node.y), 0)
    return maxY + NODE_HEIGHT + 80
  }, [canvasNodes])
  const canvasWidth = useMemo(() => {
    const maxX = canvasNodes.reduce((max, node) => Math.max(max, node.x), 0)
    return maxX + NODE_WIDTH + 80
  }, [canvasNodes])

  return (
    <section className="wfs2-seller-automation" aria-label="Seller automation workflow">
      <header className="wfs2-seller-automation__header">
        <div>
          <strong>Seller Flow — Live Automation</strong>
          <p>
            {SELLER_AUTOMATION_WORKFLOW_ID}
            {focus.propertyId ? ` · property ${focus.propertyId}` : ''}
            {focus.threadId ? ` · thread ${focus.threadId.slice(0, 24)}` : ''}
          </p>
        </div>
        <div className="wfs2-seller-automation__header-meta">
          {realtimeStatus === 'connected' && <span className="wfs2-seller-automation__live">Live</span>}
          {replayMode && <span className="wfs2-seller-automation__badge">Replay mode (visual only)</span>}
        </div>
      </header>

      {error && <div className="wfs2-seller-automation__error"><Icon name="alert" /> {error}</div>}
      {loading && <div className="wfs2-seller-automation__muted">Loading seller automation skeleton…</div>}

      {steps.length > 0 ? (
        <div className="wfs2-seller-automation__timeline" aria-label="Live execution timeline">
          {steps.map((step) => (
            <button
              key={step.id}
              type="button"
              className={cls('wfs2-seller-automation__timeline-item', STATUS_CLASS[step.execution_status])}
              onClick={() => void openInspector(step)}
            >
              <span className="wfs2-seller-automation__timeline-status">{step.execution_status}</span>
              <strong>{step.action_key}</strong>
              <em>{step.duration_ms != null ? `${step.duration_ms}ms` : step.started_at}</em>
            </button>
          ))}
        </div>
      ) : null}

      <div className="wfs2-seller-automation__layout">
        <div className="wfs2-seller-automation__canvas-wrap">
          <div
            className="wfs2-seller-automation__canvas"
            role="img"
            aria-label="Seller automation canvas"
            style={{ width: canvasWidth, height: canvasHeight }}
          >
            <svg className="wfs2-seller-automation__edges" width={canvasWidth} height={canvasHeight} aria-hidden>
              {activeEdges.map((edge) => {
                const from = nodePositions.get(edge.from)
                const to = nodePositions.get(edge.to)
                if (!from || !to) return null
                const x1 = from.x + NODE_WIDTH / 2
                const y1 = from.y + NODE_HEIGHT
                const x2 = to.x + NODE_WIDTH / 2
                const y2 = to.y
                return (
                  <line
                    key={`${edge.from}-${edge.to}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className="wfs2-seller-automation__edge is-active"
                  />
                )
              })}
            </svg>
            {canvasNodes.map((node) => (
              <SellerAutomationCanvasNode
                key={node.id}
                node={node}
                isOnPath={activePath.has(node.id)}
                onOpen={() => {
                  const step = steps.find((s) => s.node_id === node.id)
                  if (step) void openInspector(step)
                }}
              />
            ))}
          </div>
        </div>

        <aside className="wfs2-seller-automation__rail">
          <div className="wfs2-seller-automation__controls">
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('pause_automation')}>Pause</button>
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('resume_automation')}>Resume</button>
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('approve_needs_review')}>Approve review</button>
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('retry_failed')}>Retry failed</button>
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('skip_optional')}>Skip</button>
            <button type="button" className="wfs2__btn is-ghost" disabled={replayMode} onClick={() => void runControl('run_next_eligible')}>Run next</button>
          </div>

          <div className="wfs2-seller-automation__history">
            <h4>Execution history</h4>
            <ul>
              {history.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={executionId === row.id ? 'is-selected' : ''}
                    onClick={() => {
                      setExecutionId(row.id)
                      setLiveSince(null)
                      void patchLive()
                    }}
                  >
                    <span>{new Date(row.started_at).toLocaleString()}</span>
                    <em>{row.status}</em>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {inspector && (
        <aside className="wfs2-seller-automation__inspector" role="dialog" aria-label="Execution inspector">
          <header>
            <strong>{inspector.action_key}</strong>
            <button type="button" className="wfs2__btn is-ghost" onClick={() => setInspector(null)}><Icon name="x" /></button>
          </header>
          <div className="wfs2-seller-automation__inspector-body">
            <p><span>Why</span><b>{inspector.block_reason ? `Blocked: ${inspector.block_reason}` : 'Seller-flow orchestration step'}</b></p>
            <p><span>Status</span><b>{inspector.execution_status}</b></p>
            <p><span>Duration</span><b>{inspector.duration_ms ?? '—'} ms</b></p>
            <p><span>Template</span><b>{inspector.selected_template ?? '—'}</b></p>
            <p><span>Queue</span><b>{inspector.queue_id ?? '—'}</b></p>
            <p><span>Provider</span><b>{inspector.provider_status ?? '—'}</b></p>
            <p><span>Block reason</span><b>{inspector.block_reason ?? '—'}</b></p>
            <p><span>Retries</span><b>{inspector.retry_count ?? 0}</b></p>
            <p><span>Next action</span><b>{inspector.next_action ?? '—'}</b></p>
            {inspector.rendered_response_preview && (
              <pre className="wfs2-seller-automation__preview">{inspector.rendered_response_preview}</pre>
            )}
            <details>
              <summary>Inputs</summary>
              <pre>{JSON.stringify(inspector.input_summary ?? {}, null, 2)}</pre>
            </details>
            <details>
              <summary>Outputs</summary>
              <pre>{JSON.stringify(inspector.output_summary ?? {}, null, 2)}</pre>
            </details>
            {inspector.error_details && (
              <details>
                <summary>Error details</summary>
                <pre>{JSON.stringify(inspector.error_details, null, 2)}</pre>
              </details>
            )}
          </div>
        </aside>
      )}

      {selectedStepId && !inspector && (
        <div className="wfs2-seller-automation__muted">Opening inspector…</div>
      )}
    </section>
  )
}