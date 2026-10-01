import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCConfirm, LCError, LCFacts, LCInspector, LCInspectorSection, LCSkeleton, LCStatus, LCTimeline, type LCTimelineItem } from '../../../../shared/lc'
import { pushRoutePath } from '../../../../app/router'
import { orchestratorAction } from '../lib/api'
import { ago, clockMs, dur, stamp, words } from '../lib/format'
import type { RegistryEntry, RunDetailResponse, Topology } from '../lib/types'
import { sound } from '../../../../shared/sound'

const TONE: Record<string, 'ok' | 'exec' | 'attn' | 'crit' | 'neutral' | 'flow'> = { good: 'ok', active: 'exec', held: 'attn', human: 'attn', bad: 'crit', muted: 'neutral' }
const STATUS_TONE: Record<string, 'ok' | 'exec' | 'attn' | 'crit' | 'neutral'> = { completed: 'ok', running: 'exec', waiting: 'exec', held: 'attn', needs_you: 'attn', failed: 'crit', cancelled: 'neutral' }
const STEP: Record<string, { icon: 'check' | 'activity' | 'pause' | 'user' | 'x' | 'slash'; word: string }> = {
  succeeded: { icon: 'check', word: 'done' }, passed: { icon: 'check', word: 'done' }, completed: { icon: 'check', word: 'done' }, resolved: { icon: 'check', word: 'done' }, delivered: { icon: 'check', word: 'done' },
  waiting: { icon: 'activity', word: 'here now' }, current: { icon: 'activity', word: 'here now' }, running: { icon: 'activity', word: 'here now' },
  blocked: { icon: 'pause', word: 'held' }, held: { icon: 'pause', word: 'held' }, needs_review: { icon: 'user', word: 'person' }, human: { icon: 'user', word: 'person' }, failed: { icon: 'x', word: 'failed' }, skipped: { icon: 'slash', word: 'skipped' },
}

/**
 * RUN INSPECTOR — any run answers: what triggered it, who it was about, which
 * version, which nodes ran, which branches it skipped, where it stopped, why
 * (structured facts — never a model's reasoning), what happened downstream and
 * what happens next.
 */
export function RunInspector({ run, error, loading, topology, workflow, next, onClose, onNode, onRetry, mode = 'float' }: {
  mode?: 'float' | 'dock'
  run: RunDetailResponse | null
  error: string | null
  loading: boolean
  topology: Topology | null
  workflow: RegistryEntry | null
  next: string[]
  onClose: () => void
  onNode: (key: string) => void
  onRetry: () => void
}) {
  const [tech, setTech] = useState(false)
  const [confirm, setConfirm] = useState<'resume' | 'cancel' | 'approve' | 'reject' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const label = (k: string | null | undefined) => (k ? topology?.nodes.find((n) => n.key === k)?.label || words(k) : '—')
  const r = run?.run
  const isStudio = workflow?.kind === 'studio'
  const studioState = run ? String(run.technical?.state || '') : ''

  const items: LCTimelineItem[] = (run?.timeline || []).map((e) => ({
    id: e.event_id,
    at: e.occurred_at ? Date.parse(e.occurred_at) : null,
    title: <><b>{label(e.node_key)}</b>{e.label ? <span className="ws4-tl__label"> · {e.label}</span> : null}</>,
    body: e.reason_code ? words(e.reason_code) : undefined,
    meta: <span className="ws4-tl__meta"><span className="lc-num">{clockMs(e.occurred_at)}</span>{e.duration_ms !== null ? <span>{dur(e.duration_ms)} measured</span> : null}<span>{e.source_ref || e.source_runtime}</span></span>,
    state: e.status === 'failed' ? 'failed' : ['blocked', 'held'].includes(e.status) ? 'blocked' : ['needs_review', 'human', 'waiting'].includes(e.status) ? 'waiting' : 'done',
    onOpen: e.node_key ? () => onNode(e.node_key!) : undefined,
  }))

  const act = async () => {
    if (!confirm || !r) return
    const res = await orchestratorAction(confirm, { run_id: r.run_id, node_id: r.current_node })
    if (!res.ok) sound.outcome.error()
    setNote(res.ok ? `${words(confirm)} recorded — the orchestrator acts on its next tick.` : `${words(confirm)} refused — ${res.error || res.code || 'unavailable'}`)
    setConfirm(null)
    onRetry()
  }

  return (
    <LCInspector
      open
      onClose={onClose}
      id="ws4-run"
      mode={mode}
      resizable={mode === 'float'}
      eyebrow={`${workflow?.short_name || 'Workflow'} · run${r?.version ? ` · ${r.version}` : ''}`}
      title={r ? r.subject.name || r.subject.address || r.subject.id || r.trigger || 'Run' : loading ? 'Reading the run…' : 'Run'}
      subtitle={r?.subject.name && r.subject.address ? r.subject.address : undefined}
      status={r ? (
        <span className="ws4-statusline">
          <LCStatus label={r.status_label} tone={STATUS_TONE[r.status] || 'neutral'} />
          <span className="lc-t-meta">started {ago(r.started_at)}{r.duration_ms !== null ? ` · ran ${dur(r.duration_ms)}` : ''}</span>
        </span>
      ) : null}
      contentKey={r?.run_id || 'loading'}
      width={420}
      footer={run ? (
        <div className="ws4-actions">
          {run.links.map((l) => <LCButton key={l.href} size="sm" icon="arrow-up-right" onClick={() => pushRoutePath(l.href)}>{l.label}</LCButton>)}
          {isStudio && studioState === 'held' ? <><LCButton size="sm" variant="primary" onClick={() => setConfirm('resume')}>Resume</LCButton><LCButton size="sm" variant="quiet" onClick={() => setConfirm('cancel')}>Cancel run</LCButton></> : null}
          {isStudio && studioState === 'awaiting_approval' ? <><LCButton size="sm" variant="primary" onClick={() => setConfirm('approve')}>Approve</LCButton><LCButton size="sm" variant="quiet" onClick={() => setConfirm('reject')}>Reject</LCButton></> : null}
          {isStudio && ['running', 'waiting'].includes(studioState) ? <LCButton size="sm" variant="quiet" onClick={() => setConfirm('cancel')}>Cancel run</LCButton> : null}
        </div>
      ) : null}
    >
      {error && !run ? <LCError what="This run could not be read" detail={error} onRetry={onRetry} compact /> : null}
      {!run && !error ? <LCSkeleton shape="rows" count={7} label="Reading the run" /> : null}
      {run && r ? (
        <>
          <section className="ws4-why" data-tone={TONE[run.why.tone] || 'neutral'}>
            <h4>{run.why.headline.charAt(0) + run.why.headline.slice(1).toLowerCase()}</h4>
            <ul>{run.why.lines.map((l, i) => <li key={i}>{l.charAt(0).toUpperCase() + l.slice(1)}</li>)}</ul>
            {run.path.focus ? <button type="button" className="lc-link" onClick={() => onNode(run.path.focus!)}><Icon name="target" size={12} />{label(run.path.focus)}</button> : null}
          </section>

          <LCInspectorSection title="Run">
            <LCFacts rows={[
              { label: 'Triggered by', value: r.trigger },
              { label: 'About', value: r.subject.name || r.subject.address || r.subject.id ? `${words(r.subject.kind)} · ${r.subject.name || r.subject.address || r.subject.id}` : null },
              { label: 'Started', value: stamp(r.started_at) },
              { label: 'Version', value: r.version ? `${r.version} (pinned)` : null },
              { label: r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled' ? 'Stopped at' : 'Now at', value: label(r.current_node || r.final_node) },
              { label: 'Outcome', value: r.result },
              ...(r.ingress?.latency_ms !== null && r.ingress?.latency_ms !== undefined ? [{ label: 'Reply → processed', value: `${dur(r.ingress.latency_ms)} (inbound ledger)`, hint: `Matched by ${r.ingress.matched_by}` }] : []),
            ]} />
          </LCInspectorSection>

          <LCInspectorSection title={`Path · ${run.path.order.length} steps`}>
            <ol className="ws4-path">
              {run.path.order.map((k) => {
                const st = run.path.nodes[k]
                const m = STEP[st?.status || 'succeeded'] || STEP.succeeded
                return (
                  <li key={k} data-status={st?.status}>
                    <button type="button" onClick={() => onNode(k)}>
                      <span className="ws4-path__mark" aria-label={m.word}><Icon name={m.icon} size={10} /></span>
                      <span className="ws4-path__name">{label(k)}</span>
                      {st?.label || st?.reason ? <span className="ws4-path__what">{st.label || words(st.reason)}</span> : null}
                    </button>
                  </li>
                )
              })}
              {next.filter((k) => !run.path.order.includes(k)).map((k) => (
                <li key={`next:${k}`} data-status="next"><button type="button" onClick={() => onNode(k)}><span className="ws4-path__mark" aria-label="possible next"><Icon name="arrow-up-right" size={10} /></span><span className="ws4-path__name">{label(k)}</span><span className="ws4-path__what">possible next</span></button></li>
              ))}
            </ol>
            {Object.entries(run.path.nodes).some(([, v]) => v.status === 'skipped') ? <p className="ws4-note">Skipped (optional, not needed this run): {Object.entries(run.path.nodes).filter(([, v]) => v.status === 'skipped').map(([k]) => label(k)).join(' · ')}</p> : null}
          </LCInspectorSection>

          {run.facts.length ? <KV title="Facts" rows={run.facts} /> : null}
          {run.decisions.length ? <KV title="Decisions" rows={run.decisions} /> : null}
          {run.ai.length ? <KV title="Classification · structured output" rows={run.ai.map((a) => ({ ...a, source: 'classifier' }))} /> : null}
          {run.inputs.length || run.outputs.length ? (
            <LCInspectorSection title="Inputs · outputs">
              <LCFacts rows={[...run.inputs.map((x) => ({ label: x.k, value: x.v })), ...run.outputs.map((x) => ({ label: x.k, value: x.v }))]} />
            </LCInspectorSection>
          ) : null}

          <LCInspectorSection title={`Timeline · ${run.timeline.length} recorded events`}>
            {run.timing ? <p className="ws4-note"><Icon name="clock" size={11} />{run.timing.note}</p> : null}
            <LCTimeline items={items} dense label="Recorded events" />
          </LCInspectorSection>

          <LCInspectorSection>
            <button type="button" className="ws4-disclose" onClick={() => setTech((v) => !v)} aria-expanded={tech}>Technical · ledger and lease<Icon name={tech ? 'chevron-up' : 'chevron-down'} size={12} /></button>
            {tech ? <LCFacts rows={[{ label: 'Run id', value: <code>{r.run_id}</code> }, { label: 'Topology', value: run.topology_version }, ...Object.entries(run.technical).filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object').map(([k, v]) => ({ label: words(k), value: <code>{String(v)}</code> }))]} /> : null}
          </LCInspectorSection>
          {note ? <p className="ws4-note" role="status">{note}</p> : null}
        </>
      ) : null}
      <LCConfirm
        open={Boolean(confirm)}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title={confirm ? `${words(confirm)} this run` : ''}
        tone={confirm === 'cancel' || confirm === 'reject' ? 'danger' : 'primary'}
        confirmLabel={confirm ? words(confirm) : 'Confirm'}
        effects={confirm === 'resume' ? [{ text: 'The run continues from the node it is held at, on its pinned version.', kind: 'stops' }] : confirm === 'cancel' ? [{ text: 'The run ends now. Nothing it already did is undone.', kind: 'danger' }] : confirm === 'approve' ? [{ text: 'The gated action runs through its canonical capability on the next tick.', kind: 'stops' }] : confirm === 'reject' ? [{ text: 'The run takes its Rejected branch; the gated action never runs.', kind: 'stops' }] : []}
        onConfirm={act}
      />
    </LCInspector>
  )
}

function KV({ title, rows }: { title: string; rows: Array<{ k: string; v: string; source?: string }> }) {
  return (
    <LCInspectorSection title={title}>
      <dl className="ws4-kv">
        {rows.map((x, i) => <div key={`${x.k}:${i}`}><dt>{x.k}</dt><dd>{x.v}{x.source ? <small>{x.source}</small> : null}</dd></div>)}
      </dl>
    </LCInspectorSection>
  )
}
