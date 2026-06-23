import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Icon } from '../../../shared/icons'
import { loadLiveState } from '../workflowStudio.adapter'
import type { WorkflowLiveToken } from '../workflow.types'
import type { CanvasNodeV2 } from './WorkflowCanvasV2'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const MAX_ANIMATED_TOKENS = 12
const TOKEN_STATUS_CLASS: Record<string, string> = {
  progressing: 'is-progressing',
  waiting: 'is-waiting',
  blocked: 'is-blocked',
  failed: 'is-failed',
  completed: 'is-completed',
}

interface WorkflowLiveModeV2Props {
  workflowId: string | null
  enabled: boolean
  demoMode?: boolean
  nodes: CanvasNodeV2[]
}

interface LiveRunDrawerState {
  token: WorkflowLiveToken
}

function prefersReducedMotion() {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const WorkflowLiveModeV2 = ({
  workflowId,
  enabled,
  demoMode = false,
  nodes,
}: WorkflowLiveModeV2Props) => {
  const [tokens, setTokens] = useState<WorkflowLiveToken[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<LiveRunDrawerState | null>(null)
  const reducedMotion = useMemo(() => prefersReducedMotion(), [])

  const refresh = useCallback(async () => {
    if (!enabled && !demoMode) return
    if (demoMode) {
      const demoTokens = nodes.slice(0, 3).map((node, index) => ({
        id: `demo-${node.id}`,
        step_id: node.id,
        step_key: node.key,
        label: node.label,
        status: index === 0 ? 'progressing' : index === 1 ? 'waiting' : 'blocked',
        seller: 'Demo Seller',
        property: '123 Demo St',
        run_id: `demo-run-${index + 1}`,
        trace_id: `demo-trace-${index + 1}`,
      })) as WorkflowLiveToken[]
      setTokens(demoTokens)
      setError('')
      setLoading(false)
      return
    }
    if (!workflowId) return
    setLoading(true)
    setError('')
    try {
      const response = await loadLiveState(workflowId)
      const next = response.tokens ?? []
      const fromNodes = (response.nodes ?? []).flatMap((node) =>
        (node.tokens ?? []).map((token) => ({
          ...token,
          step_id: token.step_id ?? node.step_id,
          status: token.status ?? node.status,
        })),
      )
      setTokens(next.length ? next : fromNodes)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Live overlay unavailable')
      setTokens([])
    } finally {
      setLoading(false)
    }
  }, [demoMode, enabled, nodes, workflowId])

  useEffect(() => {
    if (!enabled && !demoMode) {
      setTokens([])
      return undefined
    }

    void refresh()
    if (demoMode) return undefined
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [demoMode, enabled, refresh, workflowId])

  const tokensByNode = useMemo(() => {
    const map = new Map<string, WorkflowLiveToken[]>()
    for (const token of tokens) {
      const key = token.step_id ?? token.step_key ?? ''
      if (!key) continue
      map.set(key, [...(map.get(key) ?? []), token])
    }
    return map
  }, [tokens])

  if (!enabled && !demoMode) return null

  return (
    <div className={cls('wfs2-live', reducedMotion && 'is-reduced-motion', demoMode && 'is-demo')} aria-hidden={false}>
      {demoMode && (
        <div className="wfs2-live__banner is-muted">Demo Animation — not real persisted activity</div>
      )}

      {error && (
        <div className="wfs2-live__banner">
          <Icon name="alert" /> {error}
        </div>
      )}

      {loading && tokens.length === 0 && (
        <div className="wfs2-live__banner is-muted">Syncing live tokens…</div>
      )}

      {!loading && !demoMode && tokens.length === 0 && (
        <div className="wfs2-live__banner is-muted">No active runs in this workflow</div>
      )}

      {nodes.map((node) => {
        const nodeTokens = [
          ...(tokensByNode.get(node.id) ?? []),
          ...(tokensByNode.get(node.key) ?? []),
        ]
        if (!nodeTokens.length) return null

        const animated = nodeTokens.slice(0, MAX_ANIMATED_TOKENS)
        const overflow = Math.max(0, nodeTokens.length - animated.length)

        return (
          <div
            key={`live-${node.id}`}
            className="wfs2-live__node-overlay"
            style={{
              left: node.x,
              top: node.y,
              width: 380,
              height: 160,
            }}
          >
            {animated.map((token, index) => (
              <button
                key={token.id}
                type="button"
                className={cls(
                  'wfs2-live__token',
                  TOKEN_STATUS_CLASS[token.status] ?? 'is-waiting',
                  !reducedMotion && 'is-animated',
                )}
                style={{
                  '--wfs2-token-delay': `${(index % 6) * 0.35}s`,
                } as CSSProperties}
                title={`${token.label ?? token.node_type ?? 'Run'} · ${token.status}`}
                onClick={() => setDrawer({ token })}
              >
                <span className="wfs2-live__token-core" />
              </button>
            ))}

            {overflow > 0 && (
              <span className="wfs2-live__overflow" title={`${overflow} more active runs`}>
                +{overflow}
              </span>
            )}
          </div>
        )
      })}

      {drawer && (
        <aside className="wfs2-live__drawer" role="dialog" aria-label="Live run details">
          <header>
            <strong>{drawer.token.label ?? drawer.token.node_type ?? 'Live run'}</strong>
            <button type="button" className="wfs2__btn is-ghost" onClick={() => setDrawer(null)}>
              <Icon name="x" />
            </button>
          </header>
          <div className="wfs2-live__drawer-body">
            <p><span>Status</span><b>{drawer.token.status}</b></p>
            <p><span>Seller</span><b>{drawer.token.seller ?? '—'}</b></p>
            <p><span>Property</span><b>{drawer.token.property ?? '—'}</b></p>
            <p><span>Run ID</span><b>{drawer.token.run_id ?? '—'}</b></p>
            <p><span>Started</span><b>{drawer.token.started_at ?? '—'}</b></p>
          </div>
        </aside>
      )}
    </div>
  )
}