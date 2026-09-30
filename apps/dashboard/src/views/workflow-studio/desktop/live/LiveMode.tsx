import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { fetchLive, fetchRun, fetchWorkflow } from '../observatory-api'
import type { LiveResponse, RegistryEntry, RunDetailResponse } from '../observatory-types'
import { StudioCanvas, type CanvasApi } from '../canvas/StudioCanvas'
import { usePoll } from '../use-studio-data'
import { ago } from '../../mobile/workflow-format'

/**
 * LIVE — real current execution over the board. Tokens are the runs parked or
 * executing at each node right now (bounded: three dots and "+N ACTIVE");
 * each NEW run event since the last read gives its node one restrained
 * impulse. Choosing a run isolates it (everything else recedes). The cadence
 * is the honest one: these ledgers have no push channel, so the observatory
 * reads them every 15 seconds and says so.
 */
export function LiveMode({ workflows, wfKey, onWorkflow, still, onOpenRun }: {
  workflows: RegistryEntry[]
  wfKey: string
  onWorkflow: (k: string) => void
  still: boolean
  onOpenRun: (wf: string, run: string, node: string | null) => void
}) {
  const topo = usePoll((s) => fetchWorkflow(wfKey, '24h', s), [wfKey], 60_000)
  const [live, setLive] = useState<LiveResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [impulses, setImpulses] = useState<Record<string, number>>({})
  const [isolated, setIsolated] = useState<RunDetailResponse | null>(null)
  const [isoId, setIsoId] = useState<string | null>(null)
  const since = useRef<string | null>(null)
  const canvas = useRef<CanvasApi | null>(null)

  useEffect(() => {
    let stop = false
    let timer = 0
    const tick = async () => {
      try {
        const r = await fetchLive(since.current)
        if (stop) return
        const mine = r.recent.filter((e) => e.workflow_key === wfKey)
        if (since.current && mine.length) {
          const bump: Record<string, number> = {}
          // one impulse per NEW run: its latest node only
          const byRun = new Map<string, string>()
          for (const e of mine) if (e.node_key) byRun.set(e.run_id, e.node_key)
          for (const nk of byRun.values()) bump[nk] = Date.now() + Math.random()
          setImpulses((cur) => ({ ...cur, ...bump }))
        }
        since.current = r.now
        setLive(r); setError(null)
      } catch (e) { if (!stop) setError((e as Error)?.message || 'unavailable') }
      if (!stop) timer = window.setTimeout(tick, document.visibilityState === 'visible' ? (live?.cadence_ms || 15_000) : 60_000)
    }
    void tick()
    return () => { stop = true; window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfKey])

  useEffect(() => {
    if (!isoId) { setIsolated(null); return }
    const ac = new AbortController()
    fetchRun(wfKey, isoId, ac.signal).then((d) => { setIsolated(d); if (d.path.focus) canvas.current?.flyToNode(d.path.focus, 0.9) }).catch(() => setIsolated(null))
    return () => ac.abort()
  }, [isoId, wfKey])

  const active = useMemo(() => (live?.active || []).filter((a) => a.workflow_key === wfKey), [live, wfKey])
  const tokens = useMemo(() => { const m: Record<string, number> = {}; for (const a of active) if (a.node_key) m[a.node_key] = (m[a.node_key] || 0) + 1; return m }, [active])
  const topology = topo.data?.topology || null
  const liveWorkflows = workflows.filter((w) => w.supports.live && ['live', 'armed', 'off'].includes(w.status) && !w.test)
  const byWf = useMemo(() => { const m: Record<string, number> = {}; for (const a of live?.active || []) m[a.workflow_key] = (m[a.workflow_key] || 0) + 1; return m }, [live])
  const label = (k: string | null) => (k ? topology?.nodes.find((n) => n.key === k)?.label || k : '—')

  return (
    <div className="ws3-livemode">
      <div className="ws3-stage">
        {topology ? (
          <StudioCanvas
            ref={canvas}
            topology={topology}
            telemetry={topo.data?.telemetry || null}
            expanded={EMPTY}
            selected={null}
            onSelect={(k) => { if (k) canvas.current?.flyToNode(k) }}
            live={isolated ? null : tokens}
            impulses={isolated ? null : impulses}
            run={isolated ? { nodes: isolated.path.nodes, edges: isolated.path.edges, focus: isolated.path.focus, order: isolated.path.order } : null}
            reducedMotion={still}
          />
        ) : <div className="ws3-board is-empty"><p className="ws3-quiet"><i className="ws3-spin" />Reading the topology…</p></div>}
        <header className="ws3-tool is-top" data-no-pan>
          <label className="ws3-select is-title" title="Workflow">
            <Icon name="layers" />
            <select value={wfKey} onChange={(e) => { setIsoId(null); onWorkflow(e.target.value) }} aria-label="Workflow">
              {liveWorkflows.map((w) => <option key={w.workflow_key} value={w.workflow_key}>{w.name}{byWf[w.workflow_key] ? ` · ${byWf[w.workflow_key]} active` : ''}</option>)}
            </select>
          </label>
          <span className="ws3-tool__grow" />
          <span className="ws3-livebadge"><i className="ws3-livedot" aria-hidden />LIVE · {active.length} active</span>
        </header>
        {isolated ? (
          <footer className="ws3-tool is-bottom" data-no-pan>
            <span className="ws3-zoomword">Isolated</span>
            <span className="ws3-tool__spec">{isolated.run.subject.name || isolated.run.subject.id} · {isolated.run.status_label} · others receded</span>
            <button type="button" className="ws3-btn" onClick={() => setIsoId(null)}>Show every run</button>
          </footer>
        ) : null}
      </div>
      <aside className="ws3-liverail" aria-label="Live runs">
        <h3 className="ws3-h3"><i className="ws3-livedot" aria-hidden />In flight<em>{active.length}</em></h3>
        <p className="ws3-liverail__cadence">{live ? `${live.source}. Last read ${ago(live.now)}.` : error ? `Live read failed — ${error}` : 'Connecting…'}</p>
        <ol className="ws3-liverail__list">
          {active.slice(0, 120).map((a) => (
            <li key={`${a.run_id}:${a.node_key}`}>
              <button type="button" className={`ws3-liverow is-${a.status}${isoId === a.run_id ? ' is-on' : ''}`} onClick={() => (a.run_id.startsWith('queue:') ? undefined : setIsoId(isoId === a.run_id ? null : a.run_id))} onDoubleClick={() => !a.run_id.startsWith('queue:') && onOpenRun(wfKey, a.run_id, a.node_key)} disabled={a.run_id.startsWith('queue:')}>
                <i className={`ws3-dot is-${a.status}`} aria-hidden />
                <span><strong>{a.subject?.name || a.subject?.address || a.subject?.id || 'Run'}</strong><small>{label(a.node_key)}{a.detail ? ` · ${a.detail}` : ''}</small></span>
                <time>{ago(a.since)}</time>
              </button>
            </li>
          ))}
        </ol>
        {!active.length && live ? <p className="ws3-quiet">Nothing is executing in this workflow right now.</p> : null}
        {active.length > 120 ? <p className="ws3-quiet">+{active.length - 120} more in flight</p> : null}
      </aside>
    </div>
  )
}

const EMPTY: ReadonlySet<string> = new Set()
