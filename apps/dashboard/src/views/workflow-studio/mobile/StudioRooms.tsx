import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useBackHandler } from '../../../domain/navigation/useBackHandler'
import { fetchStudioRun, fetchStudioWorkflow, setStudioStatus, type StudioRunDetail, type StudioWorkflowDetail } from './studio-api'
import { orchestratorAction } from './workflow-observatory-api'
import { LiquidBackdrop, Orb, ReachBadge, REACH_LABEL, StatusPill } from './StudioParts'
import { ago, human } from './workflow-format'

const KIND_LABEL: Record<string, string> = { action: 'Action', condition: 'Decision', wait: 'Wait', approval: 'Approval', follow_up_loop: 'Follow-up loop', transform: 'Transform', terminate: 'Outcome', trigger: 'Trigger' }
const TRIGGER_LABEL: Record<string, string> = {
  seller_reply_received: 'A seller replies', seller_needs_review: 'A seller conversation needs review', seller_asking_price_captured: 'Asking price captured',
  seller_ownership_confirmed: 'A seller confirms ownership', seller_not_interested: 'A seller says not interested', message_failed: 'An outbound message fails',
  opportunity_stage_changed: 'A lead changes stage', offer_sent: 'An offer is sent', contract_fully_executed: 'A contract is fully executed', title_issue_opened: 'Title opens an issue', manual: 'Started by an operator',
}
const RUN_STATE: Record<string, string> = { running: 'Running', waiting: 'Waiting', awaiting_approval: 'Awaiting approval', held: 'Held', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' }
/** Reasons may embed ISO instants ("until 2026-09-29T22:15:56Z") — show them as local times. */
const prettyReason = (r: string) => r.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (m) => new Date(m).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())
const runTone = (s: string) => (s === 'awaiting_approval' || s === 'held' ? 'needs_you' : s === 'failed' ? 'failed' : s === 'completed' || s === 'cancelled' ? 'done' : 'waiting')

function RoomShell({ label, testid, onClose, children, attention = false }: { label: string; testid: string; onClose: () => void; children: React.ReactNode; attention?: boolean }) {
  useBackHandler(true, testid, `Close ${label}`, () => { onClose(); return true })
  return createPortal(
    <div className="wf3-room wfx wfx-room" role="dialog" aria-modal="true" aria-label={label} data-testid={testid}>
      <LiquidBackdrop attention={attention} />
      <div className="wf3-room__scroll wfx-room__scroll">
        <header className="wfx-bar">
          <button type="button" className="wfx-iconbtn" aria-label="Back" onClick={onClose}><Icon name="chevron-left" /></button>
          <span className="wfx-eyebrow"><i className="wfx-live" />{label}</span>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/* ── studio workflow ──────────────────────────────────────────────────────── */

export function StudioWorkflowRoom({ wfKey, onClose, onOpenRun }: { wfKey: string; onClose: () => void; onOpenRun: (id: string) => void }) {
  const [d, setD] = useState<StudioWorkflowDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirmArm, setConfirmArm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback((signal?: AbortSignal) => fetchStudioWorkflow(wfKey, signal).then(setD).catch((e) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) }), [wfKey])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])

  const w = d?.workflow
  const live = useMemo(() => (d?.runs || []).filter((r) => ['running', 'waiting', 'awaiting_approval', 'held'].includes(r.state)), [d])
  const done = useMemo(() => (d?.runs || []).filter((r) => !['running', 'waiting', 'awaiting_approval', 'held'].includes(r.state)), [d])
  const outcomes = useMemo(() => done.reduce<Record<string, number>>((a, r) => { const k = r.outcome || r.state; a[k] = (a[k] || 0) + 1; return a }, {}), [done])

  const toggle = async (action: 'arm' | 'pause') => {
    setBusy(true); setNote(null)
    const r = await setStudioStatus(wfKey, action)
    setBusy(false); setConfirmArm(false)
    if (!r.ok) setNote(`Not accepted: ${human(r.code || r.error || 'refused')}`)
    await load()
  }

  return (
    <RoomShell label="Workflow" testid="studio-workflow-room" onClose={onClose}>
      {!w ? <div className="wfx-empty">{err ? <><Icon name="alert" /><strong>Could not open this workflow</strong><p>{human(err)}</p></> : <span className="wfx-skel"><span><i /><i /><i /></span></span>}</div> : (
        <>
          <section className="wfx-roomhero">
            <span className="wfx-glyph is-studio is-lg"><Icon name="spark" /></span>
            <h1>{w.name}</h1>
            <p className="wfx-roomhero__meta"><StatusPill status={w.status === 'armed' ? 'live' : w.status}>{w.status === 'armed' ? 'Armed · running on real events' : w.status === 'draft' ? 'Draft · not running' : human(w.status)}</StatusPill><ReachBadge reach={w.reach} /><span>v{w.version}</span></p>
            <p className="wfx-roomhero__desc">{w.description}</p>
            <div className="wfx-roomhero__acts">
              {w.status === 'armed'
                ? <button type="button" className="wfx-btn is-quiet" disabled={busy} onClick={() => void toggle('pause')}><Icon name="pause" />Pause</button>
                : <button type="button" className="wfx-btn" disabled={busy} onClick={() => setConfirmArm(true)}><Icon name="play" />Arm workflow</button>}
            </div>
            {confirmArm ? (
              <div className="wfx-confirm" role="alertdialog" aria-label="Arm this workflow">
                <strong>Arm “{w.name}”?</strong>
                <p>It starts on the next real “{TRIGGER_LABEL[w.trigger || ''] || human(w.trigger)}” event. {w.reach === 'seller' ? 'It can cause seller-facing messages through the canonical senders, under every brake.' : w.reach === 'operator' ? 'It can only notify you — it never contacts a seller.' : 'It only updates internal records — it never contacts anyone.'}</p>
                <span><button type="button" className="wfx-btn is-quiet" onClick={() => setConfirmArm(false)}>Not now</button><button type="button" className="wfx-btn" disabled={busy} onClick={() => void toggle('arm')}>Arm it</button></span>
              </div>
            ) : null}
            {note ? <p className="wfx-note" role="status">{note}</p> : null}
          </section>

          <div className="wfx-kpis">
            <span><b>{live.length}</b>in flight</span>
            <span><b>{done.length}</b>finished</span>
            {Object.entries(outcomes).slice(0, 2).map(([k, v]) => <span key={k}><b>{v}</b>{human(k).toLowerCase()}</span>)}
          </div>

          <section className="wfx-sec" aria-label="How it works">
            <h2 className="wfx-h2">How it works</h2>
            <FlowDiagram trigger={w.trigger} graph={w.graph} />
          </section>

          <section className="wfx-sec" aria-label="Leads in this workflow">
            <h2 className="wfx-h2"><i className="wfx-live" />Leads in this workflow<span>{d.runs.length}</span></h2>
            {d.runs.length ? (
              <ul className="wfx-leads">
                {[...live, ...done].map((r, i) => (
                  <li key={r.id} style={{ ['--i' as string]: Math.min(i, 12) }}>
                    <button type="button" className={`wfx-lead is-${runTone(r.state)}`} onClick={() => onOpenRun(r.id)}>
                      <Orb name={r.subject.name} state={runTone(r.state) as never} />
                      <span className="wfx-lead__main">
                        <strong>{r.subject.name || r.subject.address || r.subject.id}</strong>
                        {r.subject.name && r.subject.address ? <small>{r.subject.address}</small> : null}
                        <span className="wfx-lead__step"><i /> {r.state === 'waiting' && r.wake_at ? `${r.step} · until ${new Date(r.wake_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : r.state === 'completed' ? `Finished · ${human(r.outcome || '')}` : r.reason ? human(r.reason.split(':')[0]) : r.step}</span>
                      </span>
                      <span className="wfx-lead__side"><span className={`wfx-tag is-${runTone(r.state)}`}>{RUN_STATE[r.state] || human(r.state)}</span><small>{ago(r.finished_at || r.started_at)}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="wfx-quiet">{w.status === 'armed' ? 'Armed and listening — no event has started it yet.' : 'Not armed — nothing will start it until you arm it.'}</p>}
          </section>

          <section className="wfx-sec" aria-label="What it can do">
            <h2 className="wfx-h2">What it can do</h2>
            <div className="wfx-panel wfx-caps">
              {w.capabilities.map((c) => <span key={c.key}><Icon name={c.policy === 'APPROVAL' ? 'shield' : 'zap'} /><b>{c.label}</b><small>{c.policy === 'APPROVAL' ? 'needs your approval' : 'automatic'}</small></span>)}
              <p>{REACH_LABEL[w.reach]}. Every action goes through the domain’s own authority — suppression, contact windows, lifecycle rules and send brakes still apply.</p>
            </div>
          </section>

          <section className="wfx-sec" aria-label="Versions">
            <h2 className="wfx-h2">Versions<span>{d.versions.length}</span></h2>
            <ol className="wfx-versions">
              {d.versions.map((v) => <li key={v.version} className={v.version === w.version ? 'is-live' : ''}><b>v{v.version}{v.version === w.version ? ' · live' : ''}</b><small>{v.note || 'Published'} · {ago(v.published_at)}</small></li>)}
            </ol>
          </section>
        </>
      )}
    </RoomShell>
  )
}

/** Vertical flow: trigger → steps, branches labelled, light travelling down the spine. */
export function FlowDiagram({ trigger, graph, path }: { trigger: string | null; graph: StudioWorkflowDetail['workflow']['graph']; path?: Record<string, string> }) {
  if (!graph) return null
  // Depth-first from the trigger: each branch's steps stay under the branch that leads to them.
  const order: Array<{ id: string; depth: number; via: string | null }> = []
  const seen = new Set<string>()
  const visit = (id: string, depth: number, via: string | null) => {
    if (seen.has(id)) return
    seen.add(id)
    if (id !== 'trigger') order.push({ id, depth, via })
    const out = graph.edges.filter((x) => x.from === id)
    const branching = out.length > 1
    for (const e of out) visit(e.to, branching ? depth + 1 : depth, branching && e.exit && e.exit !== 'Next' ? e.exit : null)
  }
  visit('trigger', 0, null)
  return (
    <ol className="wfx-flow">
      <li className="wfx-flow__n is-trigger" style={{ ['--i' as string]: 0 }}><i className="wfx-flow__dot" /><span><small>When</small><b>{TRIGGER_LABEL[trigger || ''] || human(trigger)}</b></span></li>
      {order.map(({ id, depth, via }, i) => {
        const n = graph.nodes.find((x) => x.id === id)
        if (!n || n.kind === 'annotation') return null
        const st = path?.[id]
        return (
          <li key={id} className={`wfx-flow__n is-${n.kind}${st ? ` is-st-${st}` : ''}${depth ? ' is-branch' : ''}`} style={{ ['--i' as string]: i + 1, ['--depth' as string]: depth }}>
            <i className="wfx-flow__dot" />
            <span>{via ? <em className="wfx-flow__via">if {via.toLowerCase()}</em> : null}<small>{KIND_LABEL[n.kind] || human(n.kind)}</small><b>{n.label}</b></span>
          </li>
        )
      })}
    </ol>
  )
}

/* ── studio run ───────────────────────────────────────────────────────────── */

export function StudioRunRoom({ wfKey, runId, onClose }: { wfKey: string; runId: string; onClose: () => void }) {
  const [d, setD] = useState<StudioRunDetail & { waits?: Array<{ node_id: string; kind: string; status: string; title: string | null }> } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback((signal?: AbortSignal) => fetchStudioRun(wfKey, runId, signal).then(setD).catch((e) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) }), [wfKey, runId])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  const approval = d?.waits?.find((w) => w.kind === 'approval' && w.status === 'open')
  const act = async (action: 'approve' | 'reject' | 'resume' | 'cancel') => {
    setBusy(true); setNote(null)
    const r = await orchestratorAction(action, action === 'approve' || action === 'reject' ? { run_id: runId, node_id: approval?.node_id || '' } : { run_id: runId })
    setBusy(false)
    if (!r.ok) setNote(`Not accepted: ${human(r.code || r.error || 'refused')}`)
    else setNote(action === 'approve' ? 'Approved — the run continues on the next tick.' : action === 'resume' ? 'Resumed — it runs on the next tick.' : action === 'reject' ? 'Rejected.' : 'Cancelled.')
    await load()
  }
  const tone = d ? runTone(d.run.state) : 'waiting'
  return (
    <RoomShell label="Run" testid="studio-run-room" onClose={onClose} attention={tone === 'needs_you'}>
      {!d ? <div className="wfx-empty">{err ? <><Icon name="alert" /><strong>Could not open this run</strong><p>{human(err)}</p></> : <span className="wfx-skel"><span><i /><i /><i /></span></span>}</div> : (
        <>
          <section className="wfx-roomhero is-run">
            <Orb name={d.subject.name} state={tone as never} size="lg" />
            <h1>{d.subject.name || d.subject.address || 'Run'}</h1>
            {d.subject.name && d.subject.address ? <p className="wfx-roomhero__addr">{d.subject.address}</p> : null}
            <p className="wfx-roomhero__meta"><span className={`wfx-tag is-${tone}`}>{RUN_STATE[d.run.state] || human(d.run.state)}</span>{d.run.outcome ? <span>{human(d.run.outcome)}</span> : null}<span>v{d.run.version}</span><span>started {ago(d.run.started_at)}</span></p>
            {d.run.state === 'waiting' && d.run.wake_at ? <p className="wfx-roomhero__desc">Next step {new Date(d.run.wake_at) > new Date() ? `at ${new Date(d.run.wake_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'on the next tick'}.</p> : null}
            {d.run.reason ? <p className="wfx-roomhero__desc">Held: {human(d.run.reason.split(':')[0])}{d.run.reason.includes(':') ? ` — ${human(d.run.reason.split(':').slice(1).join(':'))}` : ''}</p> : null}
            <div className="wfx-roomhero__acts">
              {approval ? <><button type="button" className="wfx-btn is-quiet" disabled={busy} onClick={() => void act('reject')}>Reject</button><button type="button" className="wfx-btn" disabled={busy} onClick={() => void act('approve')}><Icon name="check" />Approve</button></> : null}
              {d.run.state === 'held' ? <><button type="button" className="wfx-btn is-quiet" disabled={busy} onClick={() => void act('cancel')}>Cancel run</button><button type="button" className="wfx-btn" disabled={busy} onClick={() => void act('resume')}><Icon name="play" />Resume</button></> : null}
              {d.links.conversation ? <button type="button" className="wfx-btn is-quiet" onClick={() => pushRoutePath(d.links.conversation!)}><Icon name="message" />Conversation</button> : null}
            </div>
            {approval ? <p className="wfx-roomhero__desc">Waiting for your decision: <b>{approval.title}</b></p> : null}
            {note ? <p className="wfx-note" role="status">{note}</p> : null}
          </section>

          <section className="wfx-sec" aria-label="Path">
            <h2 className="wfx-h2">Path</h2>
            <ol className="wfx-flow is-run">
              {d.path.map((p, i) => (
                <li key={p.id} className={`wfx-flow__n is-${p.kind} is-st-${p.status}`} style={{ ['--i' as string]: i }}>
                  <i className="wfx-flow__dot" />
                  <span>
                    <small>{KIND_LABEL[p.kind] || human(p.kind)}{p.at ? ` · ${ago(p.at)}` : ''}</small>
                    <b>{p.label}</b>
                    {p.exit ? <em className="wfx-flow__exit">→ {p.exit}</em> : null}
                    {p.status === 'current' ? <em className="wfx-flow__exit is-now">here now</em> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="wfx-sec" aria-label="Timeline">
            <h2 className="wfx-h2">Timeline<span>{d.timeline.length}</span></h2>
            <div className="wfx-panel">
              <ol className="wfx-feed">
                {d.timeline.map((t, i) => (
                  <li key={`${t.node}-${i}`} className={`wfx-fi is-${t.status === 'succeeded' ? 'good' : t.status === 'held' || t.status === 'failed' || t.status === 'blocked' ? 'gold' : 'teal'}`} style={{ ['--i' as string]: Math.min(i, 12) }}>
                    <div className="wfx-fi__static">
                      <span className="wfx-fi__glyph"><Icon name={t.status === 'succeeded' ? 'check' : t.status === 'waiting' ? 'clock' : 'activity'} /></span>
                      <span className="wfx-fi__main">
                        <span className="wfx-fi__title"><strong>{t.label}</strong><time>{new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></span>
                        <span className="wfx-fi__detail">{human(t.status)}{t.exit ? ` → ${t.exit}` : ''}{t.reason ? ` · ${prettyReason(String(t.reason))}` : ''}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
          {d.description ? <p className="wfx-prov">{d.description}</p> : null}
        </>
      )}
    </RoomShell>
  )
}
