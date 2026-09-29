import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import { fetchWorkflow, type SystemWorkflow, type WorkflowDetail } from './workflow-observatory-api'
import { FAMILY_LABEL, RUN_LABEL, RUN_TONE, ago, beatLabel, human } from './workflow-format'

/**
 * WORKFLOW ROOM — what this automation is, what starts it, the steps it runs
 * (with how many runs passed through each, from its own ledger), and its
 * recent runs. The outline is generated from the topology, not written.
 */
const STATE_FILTERS = ['all', 'needs_operator', 'held', 'waiting', 'completed', 'failed'] as const

export function WorkflowRoom({ wfKey, summary, onClose, onOpenRun }: { wfKey: string; summary: SystemWorkflow | null; onClose: () => void; onOpenRun: (id: string) => void }) {
  const [d, setD] = useState<WorkflowDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof STATE_FILTERS)[number]>('all')
  useBackHandler(true, 'workflow-room', 'Close workflow', () => { onClose(); return true })
  useEffect(() => {
    const ac = new AbortController()
    fetchWorkflow(wfKey, {}, ac.signal).then(setD).catch((e) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) })
    return () => ac.abort()
  }, [wfKey])

  const nodes = useMemo(() => new Map((d?.workflow.nodes || []).map((n) => [n.id, n])), [d])
  const runs = useMemo(() => (d?.runs || []).filter((r) => filter === 'all' || r.state === filter), [d, filter])
  const top = useMemo(() => Math.max(1, ...Object.values(d?.aggregates || {}).map((a) => (a.passed || 0) + (a.blocked || 0) + (a.review || 0) + (a.failed || 0) + (a.waiting || 0))), [d])

  return createPortal(
    <div className="wf3-room" role="dialog" aria-modal="true" aria-label={d?.workflow.name || 'Workflow'} data-testid="workflow-room">
      <span className="wf3-field" aria-hidden><i /><i /><i /></span>
      <div className="wf3-room__scroll">
        <header className="wf3-bar">
          <button type="button" className="wf3-icon" aria-label="Back to Workflow Studio" onClick={onClose}><Icon name="chevron-left" /></button>
          <span className="wf3-eyebrow"><i />Workflow</span>
          <span className="wf3-lock">{summary?.lock === 'locked_core' ? 'System · locked core' : 'Studio'}</span>
        </header>
        {!d ? <div className="wf3-state">{err ? <><Icon name="alert" /><strong>Could not open this workflow</strong></> : <span className="wf3-skel"><span><i /><i /></span></span>}</div> : (
          <>
            <section className="wf3-title">
              <h1>{d.workflow.name}</h1>
              <p className="wf3-meta">{d.workflow.owner} · {d.workflow.version} · {summary?.status === 'live' ? 'Live' : human(summary?.status)}</p>
              <p className="wf3-meta is-soft">{summary ? beatLabel(summary.health) : ''}</p>
            </section>
            <p className="wf3-desc">{d.workflow.description}</p>
            <div className="wf3-trigger"><span className="wf3-fam is-trigger">Trigger</span><b>{d.workflow.trigger.label}</b><small>{d.workflow.trigger.source}</small></div>

            <section className="wf3-sec">
              <h2 className="wf3-h2">Steps{d.window_days ? <span>runs through each · last {d.window_days} days</span> : null}</h2>
              <ol className="wf3-outline">
                {d.workflow.outline.map((o, i, all) => {
                  const n = nodes.get(o.id)
                  const a = d.aggregates[o.id]
                  const total = a ? (a.passed || 0) + (a.blocked || 0) + (a.review || 0) + (a.failed || 0) + (a.waiting || 0) : 0
                  return (
                    <li key={o.id} data-lane={o.lane && o.lane !== all[i - 1]?.lane ? o.lane : undefined} className={`wf3-step is-${o.family}${n?.tone ? ` is-tone-${n.tone}` : ''}`} style={{ ['--d' as string]: o.depth }}>
                      <i className="wf3-step__dot" aria-hidden />
                      <span className="wf3-step__body">
                        <span className="wf3-step__head">{o.via ? <i className="wf3-via">if {o.via}</i> : null}<b>{o.label}</b><em>{FAMILY_LABEL[o.family]}</em></span>
                        {n?.summary ? <small>{n.summary}</small> : null}
                        {n?.loop ? <small className="is-loop">Up to {n.loop.max} follow-ups · every {n.loop.cadenceHours}h · stops when {n.loop.stop}</small> : null}
                        {o.branch ? <span className="wf3-exits">{o.branch.map((b) => <span key={b}>{b}</span>)}</span> : null}
                        {a && total ? (
                          <span className="wf3-meter" aria-label={`${total} runs`}>
                            <span className="wf3-meter__bar"><i className="is-pass" style={{ width: `${((a.passed || 0) / top) * 100}%` }} /><i className="is-held" style={{ width: `${((a.blocked || 0) / top) * 100}%` }} /><i className="is-review" style={{ width: `${((a.review || 0) / top) * 100}%` }} /><i className="is-fail" style={{ width: `${((a.failed || 0) / top) * 100}%` }} /></span>
                            <span className="wf3-meter__n">{a.passed ? <span>{a.passed} passed</span> : null}{a.blocked ? <span className="is-held">{a.blocked} held</span> : null}{a.review ? <span className="is-review">{a.review} review</span> : null}{a.failed ? <span className="is-fail">{a.failed} failed</span> : null}{a.waiting ? <span>{a.waiting} waiting</span> : null}</span>
                          </span>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </section>

            <section className="wf3-sec">
              <h2 className="wf3-h2">Recent runs<span>{d.runs.length}</span></h2>
              {d.note ? <p className="wf3-note">{d.note}</p> : null}
              {d.runs.length ? (
                <nav className="wf3-chips" role="tablist">
                  {STATE_FILTERS.map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={`wf3-chip${filter === f ? ' is-on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : RUN_LABEL[f]}</button>)}
                </nav>
              ) : null}
              <ul className="wf3-runs">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="wf3-run" onClick={() => (wfKey === 'seller_inbound' ? onOpenRun(r.id) : r.link ? pushRoutePath(r.link) : undefined)}>
                      <span className={`wf3-run__dot is-${RUN_TONE[r.state] || 'muted'}`} aria-hidden />
                      <span className="wf3-run__body">
                        <b>{r.subject.name || r.subject.address || human(r.subject.kind)}</b>
                        <small>{r.subject.name && r.subject.address ? `${r.subject.address} · ` : ''}{r.reason || r.label}</small>
                      </span>
                      <time>{ago(r.started_at)}</time>
                    </button>
                  </li>
                ))}
              </ul>
              {!runs.length && d.runs.length ? <p className="wf3-note">No runs in this state.</p> : null}
            </section>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
