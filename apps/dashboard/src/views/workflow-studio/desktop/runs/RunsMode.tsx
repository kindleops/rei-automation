import { useCallback, useMemo, useRef, useState } from 'react'
import { LCButton, LCDataGrid, LCFilterBar, LCSearch, LCSegmented, LCSelect, LCStatus, LCToolbar, type LCColumn } from '../../../../shared/lc'
import type { GraphCanvasApi } from '../canvas/GraphCanvas'
import { layoutTopology } from '../canvas/layout'
import { WorkflowBoard } from '../canvas/WorkflowBoard'
import { RunInspector } from '../canvas-mode/RunInspector'
import { fetchRun, fetchRuns, fetchWorkflow, type RunsQuery } from '../lib/api'
import { ago, clock, dur, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { Period, RunDetailResponse, RunRow, RunsResponse, RunStatus, WorkflowDetailResponse } from '../lib/types'
import { findWorkflow, useStudio } from '../studio-context'

const STATUSES: Array<{ value: RunStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'needs_you', label: 'Needs you' }, { value: 'held', label: 'Held' }, { value: 'failed', label: 'Failed' },
  { value: 'waiting', label: 'Waiting' }, { value: 'running', label: 'Running' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Withdrawn' },
]
const TONE: Record<RunStatus, 'ok' | 'exec' | 'attn' | 'crit' | 'neutral'> = { completed: 'ok', running: 'exec', waiting: 'exec', held: 'attn', needs_you: 'attn', failed: 'crit', cancelled: 'neutral' }
const ROW_TONE: Partial<Record<RunStatus, 'crit' | 'attn' | 'exec'>> = { failed: 'crit', needs_you: 'attn', held: 'attn', running: 'exec' }

/**
 * RUNS — the execution explorer. One dense, windowed grid per workflow; the
 * filters it accepts are the ones the ledger can answer (status, node, branch,
 * reason, version, time, human intervention, free text). A row opens the run
 * inspector beside a preview of its path; counts are the ledger's own.
 */
export function RunsMode() {
  const s = useStudio()
  const wf = s.wfKey
  const workflow = findWorkflow(s.workflows, wf)
  const [status, setStatus] = useState<RunStatus | 'all'>('all')
  const [q, setQ] = useState('')
  const [humanOnly, setHumanOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [more, setMore] = useState<{ sig: string; rows: RunRow[]; cursor: string | null; loading: boolean }>({ sig: '', rows: [], cursor: null, loading: false })
  const preview = useRef<GraphCanvasApi | null>(null)

  const drill = s.drill
  const query: RunsQuery = { period: s.period, status, q: q.trim() || undefined, limit: 80, node: drill?.node, edge: drill?.edge, reason: drill?.reason, version: drill?.version, from: drill?.from, to: drill?.to, human: humanOnly || drill?.human || undefined }
  const sig = JSON.stringify([wf, query])
  const runs = useResource<RunsResponse>(`runs:${sig}`, (sig2) => fetchRuns(wf, query, sig2), { interval: 45_000 })
  const extra = more.sig === sig ? more : { sig, rows: [], cursor: null, loading: false }
  const rows = useMemo(() => [...(runs.data?.runs ?? []), ...extra.rows], [runs.data, extra.rows])
  const cursor = extra.cursor ?? (extra.rows.length ? null : runs.data?.next_cursor ?? null)
  const loadMore = useCallback(async () => {
    if (!cursor || extra.loading) return
    setMore({ ...extra, loading: true })
    try {
      const r = await fetchRuns(wf, { ...query, cursor })
      setMore({ sig, rows: [...extra.rows, ...r.runs], cursor: r.next_cursor, loading: false })
    } catch { setMore({ ...extra, loading: false }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, extra, sig, wf])

  const topo = useResource<WorkflowDetailResponse>(`wf:${wf}:${s.period}`, (sig2) => fetchWorkflow(wf, s.period, sig2), { placeholderKey: `wf:${wf}:7d` })
  const topology = topo.data?.topology ?? null
  const label = useCallback((k: string | null) => (k ? topology?.nodes.find((n) => n.key === k)?.label || words(k) : '—'), [topology])
  const detail = useResource<RunDetailResponse>(open ? `run:${wf}:${open}` : null, (sig2) => fetchRun(wf, open!, sig2))
  const run = detail.data && detail.data.run.run_id === open ? detail.data : null
  const allOpen = useMemo(() => new Set((topology?.groups || []).map((g) => g.key)), [topology])
  const layout = useMemo(() => (topology ? layoutTopology(topology, allOpen, { direction: 'LR' }) : null), [allOpen, topology])

  const runnable = s.workflows.filter((w) => w.supports.runs && !w.test && w.group !== 'not_running')
  const counts = runs.data?.counts || {}
  const columns: LCColumn<RunRow>[] = [
    { id: 'started', header: 'Started', width: 112, sortable: false, render: (r) => <span title={r.started_at || ''}><b className="lc-num">{clock(r.started_at)}</b> <span className="lc-t-meta">{ago(r.started_at)}</span></span> },
    { id: 'subject', header: 'Subject', minWidth: 180, render: (r) => <span className="ws4-cell-subject"><b>{r.subject.name || r.subject.id || '—'}</b>{r.trigger ? <small>{r.trigger}</small> : null}</span> },
    { id: 'property', header: 'Property', minWidth: 160, hideable: true, render: (r) => r.subject.address || <span className="lc-t-meta">—</span> },
    { id: 'status', header: 'Status', width: 140, render: (r) => <LCStatus label={r.status_label} tone={TONE[r.status]} /> },
    { id: 'node', header: 'Current · final node', minWidth: 170, hideable: true, render: (r) => label(r.current_node || r.final_node) },
    { id: 'outcome', header: 'Outcome', minWidth: 200, render: (r) => <span className="ws4-cell-outcome">{r.result || '—'}{r.reason && r.status !== 'completed' ? <small>{r.reason}</small> : null}</span> },
    { id: 'duration', header: 'Duration', width: 92, align: 'right', hint: 'started → finished, from the runtime’s own run row', render: (r) => <span className="lc-num">{dur(r.duration_ms)}</span> },
    { id: 'human', header: 'Person', width: 78, align: 'center', hint: 'a person intervened (review, approval, release)', render: (r) => (r.human ? <span className="ws4-human">person</span> : null) },
    { id: 'version', header: 'Version', width: 150, hideable: true, hiddenByDefault: true, render: (r) => <span className="lc-t-mono">{r.version || '—'}</span> },
    { id: 'id', header: 'Run id', width: 120, hideable: true, hiddenByDefault: true, render: (r) => <span className="lc-t-mono" title={r.run_id}>{r.run_id.slice(0, 8)}</span> },
  ]

  const filters = [
    ...(drill?.label ? [{ id: 'drill', value: drill.label, onRemove: () => s.setDrill(null) }] : []),
    ...(humanOnly ? [{ id: 'human', field: 'Intervention', value: 'a person intervened', onRemove: () => setHumanOnly(false) }] : []),
    ...(status !== 'all' ? [{ id: 'status', field: 'Status', value: STATUSES.find((x) => x.value === status)?.label, onRemove: () => setStatus('all') }] : []),
  ]

  return (
    <div className={`ws4-runs${open ? ' has-insp' : ''}`}>
      <section className="ws4-runs__ledger">
        <LCToolbar
          search={<LCSearch value={q} onChange={setQ} label="Search runs" placeholder="Seller, property, run id, reason…" />}
          filters={<>
            <LCSelect size="sm" variant="chip" label="Workflow" prefix="Workflow" value={wf} onChange={(k) => { setOpen(null); s.setDrill(null); s.setWorkflow(k) }} options={runnable.map((w) => ({ value: w.workflow_key, label: w.name }))} />
            <LCSegmented size="sm" label="Period" value={s.period} onChange={(p: Period) => s.setPeriod(p)} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} />
          </>}
          controls={<LCSegmented size="sm" label="Status" value={status} onChange={setStatus} options={STATUSES.map((x) => ({ value: x.value, label: `${x.label}${x.value === 'all' ? ` ${counts.all ?? ''}` : counts[x.value] ? ` ${counts[x.value]}` : ''}` }))} />}
          actions={<LCButton size="sm" variant={humanOnly ? 'primary' : 'secondary'} icon="user" onClick={() => setHumanOnly((v) => !v)}>Human intervention</LCButton>}
          below={filters.length ? <LCFilterBar filters={filters} onClearAll={() => { s.setDrill(null); setHumanOnly(false); setStatus('all') }} count={counts.all ?? null} countNoun="runs" /> : null}
        />
        <div className="ws4-runs__grid">
          <LCDataGrid
            id="ws4-runs"
            label={`${workflow?.name || 'Workflow'} runs`}
            rows={rows}
            rowKey={(r) => r.run_id}
            columns={columns}
            activeKey={open}
            onActivate={(r) => setOpen(r.run_id === open ? null : r.run_id)}
            rowTone={(r) => ROW_TONE[r.status] || null}
            density="standard"
            loading={runs.loading}
            error={runs.error && !runs.data ? { what: 'Runs could not be read', onRetry: runs.reload } : null}
            empty={{ title: 'No run matches', body: `Nothing in the last ${s.period} matches these filters.` }}
            onEndReached={cursor ? () => void loadMore() : undefined}
            loadingMore={extra.loading}
            total={counts.all ?? null}
          />
        </div>
      </section>
      {open ? (
        <aside className="ws4-runs__side">
          <div className="ws4-runs__preview">
            {topology && layout ? (
              <WorkflowBoard
                ref={preview}
                topology={topology}
                layout={layout}
                telemetry={null}
                onSelect={() => undefined}
                run={run ? { path: run.path } : null}
                focus={run ? new Set(run.path.order.map((k) => layout.owner.get(k) || k)) : null}
                reducedMotion={s.still}
                viewKey={null}
                minimap={false}
                fitMode="contain"
                label="Path preview"
              >
                <LCButton size="sm" variant="secondary" icon="maximize" className="ws4-runs__open" onClick={() => s.openRun(wf, open, run?.path.focus || null)}>Open on canvas</LCButton>
              </WorkflowBoard>
            ) : null}
          </div>
          <div className="ws4-runs__insp">
            <RunInspector mode="dock" run={run} error={detail.error} loading={detail.loading} topology={topology} workflow={workflow} next={[]} onClose={() => setOpen(null)} onNode={(k) => s.openRun(wf, open, k)} onRetry={detail.reload} />
          </div>
        </aside>
      ) : null}
    </div>
  )
}
