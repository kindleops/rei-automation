import { useState, type ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import { pushRoutePath } from '../../../../app/router'
import type { RunDetailResponse, Topology } from '../observatory-types'
import { ago, clock } from '../../mobile/workflow-format'
import { fmtMs } from './CanvasNode'

/**
 * RUN INSPECTOR (Level 3). WHY first, in business language, then the canonical
 * facts, the decisions with the policy that made them, structured AI output
 * (never a chain of thought), inputs and outputs, the timeline, and the way
 * into the owning app. Technical detail is folded away by default.
 */
export function RunPanel({ run, error, topology, onClose, onNode, onOpenRun: _onOpenRun, replay }: {
  run: RunDetailResponse | null
  error: string | null
  topology: Topology | null
  onClose: () => void
  onNode: (key: string) => void
  onOpenRun: (wf: string, run: string, node: string | null) => void
  replay?: ReactNode
}) {
  const [tech, setTech] = useState(false)
  if (error) return <aside className="ws3-insp is-run"><header className="ws3-insp__head"><span className="ws3-insp__title"><small>Run</small><strong>Could not be read</strong></span><button type="button" className="ws3-iconbtn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header><p className="ws3-quiet is-error">{error}</p></aside>
  if (!run) return <aside className="ws3-insp is-run" aria-busy="true"><div className="ws3-skel-rows">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} />)}</div></aside>
  const r = run.run
  const label = (k: string | null) => (k ? topology?.nodes.find((n) => n.key === k)?.label || k.replace(/_/g, ' ') : '—')
  return (
    <aside className={`ws3-insp is-run is-${run.why.tone}`} aria-label="Run inspector">
      <header className="ws3-insp__head">
        <span className={`ws3-insp__glyph is-${run.why.tone}`}><Icon name={r.status === 'failed' ? 'alert' : r.status === 'needs_you' ? 'user' : r.status === 'held' ? 'pause' : r.status === 'completed' ? 'check' : 'activity'} /></span>
        <span className="ws3-insp__title">
          <small>{r.status_label} · {ago(r.started_at)}{r.duration_ms !== null ? ` · ${fmtMs(r.duration_ms)}` : ''}</small>
          <strong>{r.subject.name || r.subject.address || r.subject.id || 'Run'}</strong>
        </span>
        <button type="button" className="ws3-iconbtn" onClick={onClose} aria-label="Close run"><Icon name="close" /></button>
      </header>
      {r.subject.name && r.subject.address ? <p className="ws3-insp__spec">{r.subject.address}</p> : null}

      <section className={`ws3-why is-${run.why.tone}`}>
        <h4>{run.why.headline}</h4>
        <p>{run.why.lines.join(' · ')}</p>
        {run.path.focus ? <button type="button" className="ws3-textbtn" onClick={() => onNode(run.path.focus!)}><Icon name="target" />{label(run.path.focus)}</button> : null}
      </section>

      {replay}

      {run.facts.length ? <KV title="Facts" rows={run.facts} /> : null}
      {run.decisions.length ? <KV title="Decisions" rows={run.decisions} /> : null}
      {run.ai.length ? <KV title="AI output · structured" rows={run.ai.map((a) => ({ ...a, source: 'classifier' }))} /> : null}
      {run.inputs.length || run.outputs.length ? (
        <section className="ws3-insp__sec ws3-io">
          {run.inputs.length ? <div><h4>Inputs</h4><dl className="ws3-insp__dl">{run.inputs.map((x) => <FragmentKV key={x.k} k={x.k} v={x.v} />)}</dl></div> : null}
          {run.outputs.length ? <div><h4>Outputs</h4><dl className="ws3-insp__dl">{run.outputs.map((x) => <FragmentKV key={x.k} k={x.k} v={x.v} />)}</dl></div> : null}
        </section>
      ) : null}

      <section className="ws3-insp__sec">
        <h4>Timeline<em>{run.timeline.length}</em></h4>
        <ol className="ws3-tl">
          {run.timeline.map((e) => (
            <li key={e.event_id} className={`is-${e.status}`}>
              <button type="button" onClick={() => e.node_key && onNode(e.node_key)}>
                <i className={`ws3-dot is-${e.status}`} aria-hidden />
                <span><b>{label(e.node_key)}</b>{e.label ? <small>{e.label}</small> : null}{e.reason_code ? <small className="is-reason">{e.reason_code.replace(/_/g, ' ')}</small> : null}</span>
                <time title={e.occurred_at || ''}>{clock(e.occurred_at)}</time>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {run.links.length ? (
        <footer className="ws3-insp__foot">
          {run.links.map((l) => <button key={l.href} type="button" className="ws3-btn" onClick={() => pushRoutePath(l.href)}><Icon name="arrow-up-right" />{l.label}</button>)}
        </footer>
      ) : null}

      <section className="ws3-insp__sec is-tech">
        <button type="button" className="ws3-disclose" onClick={() => setTech((v) => !v)} aria-expanded={tech}>Technical details<Icon name={tech ? 'chevron-up' : 'chevron-down'} /></button>
        {tech ? <pre className="ws3-pre">{JSON.stringify({ run_id: r.run_id, version: r.version, topology_version: run.topology_version, ...run.technical }, null, 2)}</pre> : null}
      </section>
    </aside>
  )
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return <><dt>{k}</dt><dd>{v}</dd></>
}

function KV({ title, rows }: { title: string; rows: Array<{ k: string; v: string; source?: string }> }) {
  return (
    <section className="ws3-insp__sec">
      <h4>{title}</h4>
      <dl className="ws3-insp__dl">
        {rows.map((x, i) => <FragmentKVS key={`${x.k}:${i}`} k={x.k} v={x.v} source={x.source} />)}
      </dl>
    </section>
  )
}

function FragmentKVS({ k, v, source }: { k: string; v: string; source?: string }) {
  return <><dt>{k}</dt><dd>{v}{source ? <small title="Source">{source}</small> : null}</dd></>
}
