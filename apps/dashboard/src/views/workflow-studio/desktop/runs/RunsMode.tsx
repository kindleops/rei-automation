import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { fetchRun, fetchRuns, fetchWorkflow, type RunsFilter } from '../observatory-api'
import type { Period, RegistryEntry, RunDetailResponse, RunRow, RunStatus } from '../observatory-types'
import { StudioCanvas, type CanvasApi } from '../canvas/StudioCanvas'
import { RunPanel } from '../canvas/RunPanel'
import { fmtMs } from '../canvas/CanvasNode'
import { usePoll } from '../use-studio-data'
import { ReplayBar, useReplay } from './Replay'
import { ago, clock } from '../../mobile/workflow-format'

const STATUSES: Array<{ id: RunStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'needs_you', label: 'Needs you' }, { id: 'held', label: 'Held' }, { id: 'failed', label: 'Failed' },
  { id: 'waiting', label: 'Waiting' }, { id: 'running', label: 'Running' }, { id: 'completed', label: 'Completed' }, { id: 'cancelled', label: 'Stopped' },
]
const PERIODS: Period[] = ['24h', '7d', '30d']

export type Drill = Partial<Pick<RunsFilter, 'node' | 'reason' | 'version' | 'from' | 'to' | 'human'>> & { status?: RunStatus | 'all'; label?: string }

/**
 * RUNS — the ledger. Dense rows with only the statuses the runtime can
 * produce; a row opens the inspector: the executed path lit on a compact
 * board (skipped paths faded), WHY first, then facts, decisions, structured
 * AI output, timeline, links — and a replay of the recorded path.
 */
export function RunsMode({ workflows, wfKey, onWorkflow, period, onPeriod, still, onOpenRun, drill = null, onDrill }: {
  workflows: RegistryEntry[]
  wfKey: string
  onWorkflow: (k: string) => void
  period: Period
  onPeriod: (p: Period) => void
  still: boolean
  onOpenRun: (wf: string, run: string, node: string | null) => void
  /** a drill-down handed over by Analytics or the canvas (node · reason · version · time bucket) */
  drill?: Drill | null
  onDrill: (d: Drill | null) => void
}) {
  const [status, setStatus] = useState<RunStatus | 'all'>(() => drill?.status || 'all')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [pages, setPages] = useState<RunRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetailResponse | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const canvas = useRef<CanvasApi | null>(null)

  useEffect(() => { const t = window.setTimeout(() => setDebounced(q), 280); return () => window.clearTimeout(t) }, [q])
  useEffect(() => { if (drill?.status) setStatus(drill.status) }, [drill])

  const filter: RunsFilter = { period, status, q: debounced, limit: 80, node: drill?.node, reason: drill?.reason, version: drill?.version, from: drill?.from, to: drill?.to, human: drill?.human }
  const runs = usePoll((s) => fetchRuns(wfKey, filter, s), [wfKey, period, status, debounced, JSON.stringify(drill)], 45_000)
  const topo = usePoll((s) => fetchWorkflow(wfKey, period, s), [wfKey], null)
  useEffect(() => { setPages([]); setCursor(null); setOpenId(null) }, [wfKey, period, status, debounced, drill])

  const rows = useMemo(() => [...(runs.data?.runs || []), ...pages], [runs.data, pages])
  const loadMore = async () => {
    const next = cursor || runs.data?.next_cursor
    if (!next) return
    const r = await fetchRuns(wfKey, { ...filter, cursor: next })
    setPages((p) => [...p, ...r.runs]); setCursor(r.next_cursor)
  }

  useEffect(() => {
    if (!openId) { setDetail(null); return }
    const ac = new AbortController()
    setDetail(null); setDetailErr(null)
    fetchRun(wfKey, openId, ac.signal).then((d) => { setDetail(d); if (d.path.focus) window.setTimeout(() => canvas.current?.flyToNode(d.path.focus!, 0.8), 80) }).catch((e) => { if (e?.name !== 'AbortError') setDetailErr(e?.message || 'unavailable') })
    return () => ac.abort()
  }, [openId, wfKey])

  const replay = useReplay(detail?.path.order.length ?? 0)
  const topology = topo.data?.topology || null
  const allOpen = useMemo(() => new Set((topology?.groups || []).map((g) => g.key)), [topology])
  const runnable = workflows.filter((w) => w.supports.runs && !w.test && w.group !== 'not_running')
  const counts = runs.data?.counts || {}
  const label = (k: string | null) => (k ? topology?.nodes.find((n) => n.key === k)?.label || k.replace(/_/g, ' ') : '—')

  return (
    <div className={`ws3-runs${openId ? ' has-insp' : ''}`}>
      <section className="ws3-runs__ledger">
        <div className="ws3-bar">
          <label className="ws3-select" title="Workflow">
            <Icon name="layers" />
            <select value={wfKey} onChange={(e) => onWorkflow(e.target.value)} aria-label="Workflow">
              {runnable.map((w) => <option key={w.workflow_key} value={w.workflow_key}>{w.name}</option>)}
            </select>
          </label>
          <div className="ws3-seg" role="tablist" aria-label="Period">{PERIODS.map((p) => <button key={p} type="button" className={period === p ? 'is-on' : ''} aria-selected={period === p} role="tab" onClick={() => onPeriod(p)}>{p}</button>)}</div>
          <div className="ws3-find is-inline"><Icon name="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Seller, property, run id, reason…" aria-label="Search runs" /></div>
        </div>
        <div className="ws3-chips" role="tablist" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={status === s.id} className={`ws3-chip is-${s.id}${status === s.id ? ' is-on' : ''}`} onClick={() => setStatus(s.id)}>
              {s.label}<b>{s.id === 'all' ? counts.all ?? '—' : counts[s.id] ?? 0}</b>
            </button>
          ))}
          {drill ? <button type="button" className="ws3-chip is-drill is-on" onClick={() => onDrill(null)}>{drill.label || 'Drill-down'}<Icon name="close" /></button> : null}
        </div>
        <div className="ws3-table" role="table" aria-label="Runs">
          <div className="ws3-tr is-head" role="row">
            <span role="columnheader">Started</span><span role="columnheader">Subject</span><span role="columnheader">Trigger</span><span role="columnheader">Status</span><span role="columnheader">Node</span><span role="columnheader">Duration</span><span role="columnheader">Result</span>
          </div>
          {runs.loading && !rows.length ? <div className="ws3-skel-rows" aria-busy="true">{Array.from({ length: 10 }, (_, i) => <span key={i} />)}</div> : null}
          {runs.error && !rows.length ? <p className="ws3-quiet is-error">Runs could not be read — {runs.error}.</p> : null}
          {!runs.loading && !runs.error && !rows.length ? <p className="ws3-quiet">No run matches in the last {period}.</p> : null}
          {rows.map((r) => (
            <button key={r.run_id} type="button" role="row" className={`ws3-tr is-${r.status}${openId === r.run_id ? ' is-on' : ''}`} onClick={() => setOpenId(r.run_id === openId ? null : r.run_id)} data-run={r.run_id}>
              <span role="cell" title={clock(r.started_at)}>{ago(r.started_at)}</span>
              <span role="cell" className="is-subject"><b>{r.subject.name || r.subject.address || r.subject.id || '—'}</b>{r.subject.name && r.subject.address ? <small>{r.subject.address}</small> : null}</span>
              <span role="cell" className="is-dim">{r.trigger || '—'}</span>
              <span role="cell"><i className={`ws3-dot is-${r.status}`} aria-hidden />{r.status_label}{r.human ? <em className="ws3-human" title="A person intervened">person</em> : null}</span>
              <span role="cell" className="is-dim">{label(r.current_node || r.final_node)}</span>
              <span role="cell" className="is-num">{r.duration_ms !== null ? fmtMs(r.duration_ms) : '—'}</span>
              <span role="cell" className="is-result">{r.result || '—'}{r.reason && r.status !== 'completed' ? <small>{r.reason}</small> : null}</span>
            </button>
          ))}
          {(cursor || runs.data?.next_cursor) ? <button type="button" className="ws3-btn is-more" onClick={() => void loadMore()}>Load older runs</button> : null}
        </div>
      </section>
      {openId ? (
        <section className="ws3-runs__insp">
          <div className="ws3-runs__board">
            {topology ? (
              <StudioCanvas
                ref={canvas}
                topology={topology}
                telemetry={null}
                expanded={allOpen}
                selected={null}
                onSelect={() => undefined}
                run={detail ? { nodes: detail.path.nodes, edges: detail.path.edges, focus: detail.path.focus, order: detail.path.order, revealed: replay.active ? replay.index ?? undefined : undefined } : null}
                reducedMotion={still}
                showMiniMap={false}
              />
            ) : null}
            <button type="button" className="ws3-btn is-float" onClick={() => onOpenRun(wfKey, openId, detail?.path.focus || null)}><Icon name="maximize" />Open on canvas</button>
          </div>
          <RunPanel run={detail} error={detailErr} topology={topology} onClose={() => setOpenId(null)} onNode={(k) => canvas.current?.flyToNode(k, 0.9)} onOpenRun={onOpenRun} replay={detail ? <ReplayBar replay={replay} length={detail.path.order.length} current={replay.active && replay.index ? label(detail.path.order[replay.index - 1]) : null} /> : null} />
        </section>
      ) : null}
    </div>
  )
}
