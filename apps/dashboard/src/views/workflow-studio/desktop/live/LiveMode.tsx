import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCEmpty, LCError, LCLive, LCSegmented, LCSkeleton } from '../../../../shared/lc'
import { CanvasMode } from '../canvas-mode/CanvasMode'
import { fetchLive } from '../lib/api'
import { WORKFLOW_FAMILY } from '../lib/families'
import { age, count, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { LiveActive, LiveResponse, WorkflowFamily } from '../lib/types'
import { findWorkflow, useStudio } from '../studio-context'

const STATUS: Record<string, { word: string; tone: string; rank: number }> = {
  running: { word: 'Executing', tone: 'exec', rank: 0 },
  needs_you: { word: 'Needs you', tone: 'gold', rank: 1 },
  held: { word: 'Held', tone: 'attn', rank: 2 },
  waiting: { word: 'Waiting', tone: 'neutral', rank: 3 },
}

/**
 * LIVE — the board animating REAL execution: nodes executing sharpen, parked
 * runs show at the node they wait at, one pulse per recorded traversal. The
 * Running-now plane lists every execution the runtimes report right now;
 * choosing one focuses its exact run on the board.
 */
export function LiveMode() {
  const s = useStudio()
  const all = useResource<LiveResponse>('live:all', (sig) => fetchLive(null, null, sig), { interval: 20_000 })
  return (
    <div className="ws4-livemode">
      <CanvasMode liveDefault />
      <aside className="ws4-side" aria-label="Running now">
        <RunningNow read={all} onOpen={(a) => {
          const target = a.open || (a.run_id && !a.run_id.startsWith('queue:') ? { workflow_key: a.workflow_key, run_id: a.run_id } : null)
          if (!target) { s.setWorkflow(a.workflow_key); return }
          if (target.workflow_key !== s.wfKey) s.setWorkflow(target.workflow_key)
          s.setRun(target.run_id)
          s.setNode(a.open ? null : a.node_key)
        }} />
      </aside>
    </div>
  )
}

function RunningNow({ read, onOpen }: { read: ReturnType<typeof useResource<LiveResponse>>; onOpen: (a: LiveActive) => void }) {
  const s = useStudio()
  const [family, setFamily] = useState<WorkflowFamily | 'ALL'>('ALL')
  const active = useMemo(() => read.data?.active ?? [], [read.data])
  const famOf = (wf: string) => findWorkflow(s.workflows, wf)?.family || 'SYSTEM'
  const fams = useMemo(() => {
    const m = new Map<WorkflowFamily, number>()
    for (const a of active) { const f = famOf(a.workflow_key); m.set(f, (m.get(f) || 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, s.workflows])
  const rows = active
    .filter((a) => family === 'ALL' || famOf(a.workflow_key) === family)
    .sort((a, b) => (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9) || String(b.since || '').localeCompare(String(a.since || '')))
  const byWf = new Map<string, LiveActive[]>()
  for (const a of rows) (byWf.get(a.workflow_key) || byWf.set(a.workflow_key, []).get(a.workflow_key)!).push(a)
  const executing = active.filter((a) => a.status === 'running').length
  return (
    <section className="ws4-running">
      <header className="ws4-panelhead">
        <span className="ws4-panelhead__title">Running now<b className="lc-num">{read.data ? count(active.length) : '—'}</b></span>
        <LCLive live={!read.error} stale={read.stale} updatedAt={read.at} />
      </header>
      <p className="ws4-running__sum lc-t-meta">
        {read.data ? <><b className="lc-num">{count(executing)}</b> executing · <b className="lc-num">{count(active.length - executing)}</b> parked (waiting · held · needs you) · read every {Math.round((read.data.cadence_ms || 15000) / 1000)} s</> : 'Reading every runtime…'}
      </p>
      {fams.length > 1 ? (
        <LCSegmented size="sm" className="ws4-running__filter" label="Filter running executions by family" value={family} onChange={setFamily} options={[{ value: 'ALL' as const, label: `All ${active.length}` }, ...fams.map(([f, n]) => ({ value: f, label: `${WORKFLOW_FAMILY[f].label} ${n}` }))]} />
      ) : null}
      {read.loading ? <LCSkeleton shape="rows" count={6} label="Reading what is running" /> : null}
      {read.error && !read.data ? <LCError what="Live state could not be read" detail={read.error} onRetry={read.reload} compact /> : null}
      {read.data && !rows.length ? <LCEmpty title="No live runs" body="The system is idle — nothing is executing or parked right now." icon="check" tone="calm" compact /> : null}
      <div className="ws4-running__scroll lc-scroll">
        {[...byWf.entries()].map(([wf, list]) => {
          const w = findWorkflow(s.workflows, wf)
          return (
            <section key={wf} className="ws4-running__wf">
              <h4><Icon name={w ? WORKFLOW_FAMILY[w.family].icon : 'cpu'} size={12} />{w?.short_name || words(wf)}<em className="lc-num">{list.length}</em></h4>
              <ol>
                {list.slice(0, 40).map((a, i) => {
                  const st = STATUS[a.status] || { word: words(a.status), tone: 'neutral' }
                  const openable = Boolean(a.open || (a.run_id && !a.run_id.startsWith('queue:')))
                  return (
                    <li key={`${a.run_id}:${a.node_key}:${i}`}>
                      <button type="button" className={`ws4-runrow${s.runId && (s.runId === a.run_id || s.runId === a.open?.run_id) ? ' is-on' : ''}`} data-tone={st.tone} onClick={() => onOpen(a)} title={openable ? 'Focus this run on the board' : 'Open its workflow'}>
                        <i aria-hidden />
                        <span className="ws4-runrow__main">
                          <strong>{a.subject?.name || a.subject?.address || a.subject?.id || 'Run'}</strong>
                          <small><span className="is-state">{st.word}</span>{a.node_key ? <span>{words(a.node_key)}</span> : null}{a.detail ? <span>{a.detail}</span> : null}</small>
                        </span>
                        <time className="lc-t-stamp" title={a.since || ''}>{age(a.since)}</time>
                      </button>
                    </li>
                  )
                })}
              </ol>
              {list.length > 40 ? <p className="ws4-quiet">+{list.length - 40} more</p> : null}
            </section>
          )
        })}
      </div>
      {read.data?.source ? <p className="ws4-note">{read.data.source}</p> : null}
    </section>
  )
}
