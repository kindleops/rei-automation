import { useCallback, useEffect, useState } from 'react'
import { fetchOrchestrator, orchestratorAction, type OrchestratorAction, type OrchestratorState } from './workflow-observatory-api'
import { ago, human } from './workflow-format'

/**
 * Studio runtime — the durable orchestrator. Approvals and held runs are the
 * operator's controls; everything else is read-only. When the wf_* schema is
 * not installed the section says so instead of showing zero runs.
 */
export function OrchestratorSection() {
  const [state, setState] = useState<OrchestratorState | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try { setState(await fetchOrchestrator(signal)); setFailed(false) } catch (e) { if ((e as Error)?.name !== 'AbortError') setFailed(true) }
  }, [])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])

  const act = async (action: OrchestratorAction, fields: Record<string, string>, key: string) => {
    setBusy(key); setNote(null)
    const r = await orchestratorAction(action, fields)
    setBusy(null)
    if (!r.ok) setNote(`Not accepted: ${human(r.code || r.error || 'refused')}`)
    await load()
  }

  if (failed) return <section className="wf3-sec" aria-label="Studio runtime"><h2 className="wf3-h2">Studio runtime</h2><p className="wf3-note">Could not be read — nothing is shown rather than a guess.</p></section>
  if (!state) return null
  if (!state.available) {
    return (
      <section className="wf3-sec" aria-label="Studio runtime">
        <h2 className="wf3-h2">Studio runtime</h2>
        <p className="wf3-note">Not installed yet. Versioned workflows, durable waits and approvals need the orchestrator schema applied; until then no studio workflow runs.</p>
      </section>
    )
  }
  const held = state.live_runs.filter((r) => r.state === 'held')
  return (
    <section className="wf3-sec" aria-label="Studio runtime">
      <h2 className="wf3-h2">Studio runtime<span>{state.enabled ? 'on' : 'off'}</span></h2>
      <p className="wf3-note is-small">
        {state.workflows.filter((w) => w.status === 'armed').length} armed · {state.counts.waiting || 0} waiting · {state.counts.awaiting_approval || 0} awaiting approval
        {state.heartbeat_at ? ` · tick ${ago(state.heartbeat_at)}` : ' · never ticked'}
      </p>
      {state.approvals.length ? (
        <ul className="wf3-rows">
          {state.approvals.map((a) => (
            <li key={a.id}>
              <div className="wf3-srow is-approval">
                <span className="wf3-srow__main"><b>{a.title || 'Approval'}</b><small>{human(state.live_runs.find((r) => r.id === a.run_id)?.workflow_key || 'workflow')} · {a.subject_id || '—'} · asked {ago(a.created_at)}</small></span>
                <span className="wf3-srow__acts">
                  <button type="button" className="wf3-btn is-quiet" disabled={busy === a.id} onClick={() => void act('reject', { run_id: a.run_id, node_id: a.node_id }, a.id)}>Reject</button>
                  <button type="button" className="wf3-btn" disabled={busy === a.id} onClick={() => void act('approve', { run_id: a.run_id, node_id: a.node_id }, a.id)}>Approve</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {held.length ? (
        <ul className="wf3-rows">
          {held.map((r) => (
            <li key={r.id}>
              <div className="wf3-srow is-held">
                <span className="wf3-srow__main"><b>{human(r.workflow_key)} · held</b><small>{human((r.reason || '').split(':')[0])} · {r.subject_id} · v{r.version}</small></span>
                <span className="wf3-srow__acts">
                  <button type="button" className="wf3-btn is-quiet" disabled={busy === r.id} onClick={() => void act('cancel', { run_id: r.id }, r.id)}>Cancel</button>
                  <button type="button" className="wf3-btn" disabled={busy === r.id} onClick={() => void act('resume', { run_id: r.id }, r.id)}>Resume</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="wf3-note is-small" role="status">{note}</p> : null}
    </section>
  )
}
