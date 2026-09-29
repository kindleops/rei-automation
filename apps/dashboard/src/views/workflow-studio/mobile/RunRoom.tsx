import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import { fetchRun, fetchWorkflow, type RunDetail, type WorkflowDetail } from './workflow-observatory-api'
import { RUN_LABEL, RUN_TONE, clock, human } from './workflow-format'

/**
 * RUN INSPECTOR — the path this run actually took (unvisited steps subdued),
 * why it did what it did, and its timeline, with the real seller and property
 * attached. One of the best debugging surfaces in LeadCommand.
 */
export function RunRoom({ wfKey, runId, onClose }: { wfKey: string; runId: string; onClose: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [wf, setWf] = useState<WorkflowDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<'path' | 'timeline'>('path')
  useBackHandler(true, 'run-room', 'Close run', () => { onClose(); return true })
  useEffect(() => {
    const ac = new AbortController()
    Promise.all([fetchRun(wfKey, runId, ac.signal), fetchWorkflow(wfKey, {}, ac.signal)])
      .then(([r, w]) => { setRun(r); setWf(w) })
      .catch((e) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) })
    return () => ac.abort()
  }, [wfKey, runId])

  const outline = wf?.workflow.outline || []
  const lastVisited = useMemo(() => { const ids = outline.filter((o) => run?.path[o.id]).map((o) => o.id); return ids[ids.length - 1] || null }, [outline, run])
  const r = run?.run

  return createPortal(
    <div className={`wf3-room is-run is-${r ? RUN_TONE[r.state] || 'muted' : 'muted'}`} role="dialog" aria-modal="true" aria-label="Run" data-testid="run-room">
      <span className="wf3-field" aria-hidden><i /><i /><i /></span>
      <div className="wf3-room__scroll">
        <header className="wf3-bar">
          <button type="button" className="wf3-icon" aria-label="Back" onClick={onClose}><Icon name="chevron-left" /></button>
          <span className="wf3-eyebrow"><i />Run</span>
          <span className="wf3-lock">{run?.workflow.version || ''}</span>
        </header>
        {!run || !r ? <div className="wf3-state">{err ? <><Icon name="alert" /><strong>Could not open this run</strong></> : <span className="wf3-skel"><span><i /><i /></span></span>}</div> : (
          <>
            <section className="wf3-title">
              <p className="wf3-meta is-soft">{run.workflow.name}</p>
              <h1>{r.subject.name || 'Seller'}</h1>
              {r.subject.address ? <p className="wf3-meta">{r.subject.address}{r.stage ? ` · ${human(r.stage)}` : ''}</p> : null}
              <p className={`wf3-runstate is-${RUN_TONE[r.state] || 'muted'}`}><i aria-hidden />{RUN_LABEL[r.state] || human(r.state)}{r.reason ? <span> · {r.reason}</span> : null}</p>
              <p className="wf3-meta is-soft">Started {clock(r.started_at)}</p>
            </section>

            {run.inbound || run.preview ? (
              <section className="wf3-msgs">
                {run.inbound ? <div className="wf3-msg is-in"><small>Seller</small><p>{run.inbound}</p></div> : null}
                {run.preview ? <div className="wf3-msg is-out"><small>{r.state === 'completed' ? 'LeadCommand replied' : 'Reply prepared'}</small><p>{run.preview}</p></div> : null}
              </section>
            ) : null}

            <section className="wf3-why">
              <h2 className="wf3-h2">Why</h2>
              <dl>{run.why.map((w, i) => <div key={i}><dt>{w.k}</dt><dd>{w.v}</dd></div>)}</dl>
            </section>

            <nav className="wf3-chips" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'path'} className={`wf3-chip${tab === 'path' ? ' is-on' : ''}`} onClick={() => setTab('path')}>Execution path</button>
              <button type="button" role="tab" aria-selected={tab === 'timeline'} className={`wf3-chip${tab === 'timeline' ? ' is-on' : ''}`} onClick={() => setTab('timeline')}>Timeline</button>
            </nav>

            {tab === 'path' ? (
              <ol className="wf3-outline is-path">
                {outline.map((o, i, all) => {
                  const p = run.path[o.id]
                  const st = !p ? 'skipped' : p.status === 'succeeded' ? 'done' : p.status === 'blocked' ? 'held' : p.status === 'needs_review' ? 'review' : p.status === 'failed' ? 'fail' : p.status
                  return (
                    <li key={o.id} data-lane={o.lane && o.lane !== all[i - 1]?.lane ? o.lane : undefined} className={`wf3-step is-${o.family} is-${st}${o.id === lastVisited ? ' is-last' : ''}`} style={{ ['--d' as string]: o.depth }}>
                      <i className="wf3-step__dot" aria-hidden>{st === 'done' ? <Icon name="check" /> : null}</i>
                      <span className="wf3-step__body">
                        <span className="wf3-step__head">{o.via ? <i className="wf3-via">if {o.via}</i> : null}<b>{p?.label || o.label}</b>{p?.at ? <em>{clock(p.at).split(', ').pop()}</em> : null}</span>
                        {p?.reason ? <small>{human(p.reason)}</small> : null}
                      </span>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <ol className="wf3-timeline">
                {run.timeline.map((t, i) => (
                  <li key={i} className={`is-${t.status}`}><time>{clock(t.at).split(', ').pop()}</time><b>{t.label}</b>{t.reason ? <small>{human(t.reason)}</small> : null}</li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
      {run ? (
        <nav className="wf3-actionbar">
          {run.links.conversation ? <button type="button" onClick={() => pushRoutePath(run.links.conversation!)}><Icon name="message" />Open conversation</button> : null}
          {run.links.deal ? <button type="button" onClick={() => pushRoutePath(run.links.deal!)}><Icon name="target" />Deal</button> : null}
        </nav>
      ) : null}
    </div>,
    document.body,
  )
}

