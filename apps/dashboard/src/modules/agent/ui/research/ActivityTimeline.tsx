import { memo, useMemo, useState } from 'react'
import { LCButton, cx } from '../../../../shared/lc'
import type { AgentEvent } from '../../contracts/contracts'
import { bucketSummary, EXCEPTION_LABEL, groupActivity, rowKind, type ActivityFilter, type Bucket } from '../../model/activity-groups'
import { evidenceClassOf, sourceClass, type SourceRef } from '../../model/evidence-class'
import { timelineState, type DecisionView, type FindingView, type ResearchView, type TaskRow } from '../../model/research-model'
import { controlRun, setUi, useAgentUi, useAgentVersion, visibleEvents, type RunMode } from '../../runtime/agent-store'
import { isExpanded, toggleExpanded, useExpandedVersion } from '../../runtime/ui-memory'
import { fmtClock, fmtDur, fmtUsd, reasonLabel, TIMELINE_LABEL, authorityLabel } from '../format'
import { ClassTag, Favicon, Shimmer, SimTag, StateGlyph } from '../primitives'

type View = 'grouped' | 'log'

/**
 * ACTIVITY (S3 P3 + owner 10-09) — two views of the same events:
 *
 *  GROUPED (default): per phase, routine reads fold into one line per
 *    property × tool family ("Recorded documents · 3 reads completed ·
 *    2 findings unavailable"). Blockers, failures, unavailable reads,
 *    questions, running work, discoveries, conflicts, contradictions and
 *    retries are NEVER folded — they render as their own rows under their
 *    group. Open a group to see every read in it.
 *  FULL LOG: every event the run emitted, in order — server time, seq,
 *    event id, type, property, task and what it said. Nothing is hidden.
 *
 * Row kinds stay distinct: RECORDED (solid, server timestamps) · PLANNED
 * (hollow dashed, no time) · NO VALUE (hatched, with the reason).
 */
export function ActivityTimeline({ view, sources, propertyId, arrivalFloor, runId, mode }: { view: ResearchView; sources: Record<string, SourceRef>; propertyId: string | null; arrivalFloor: number; runId: string; mode: RunMode }) {
  const ui = useAgentUi()
  useExpandedVersion()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [tab, setTab] = useState<View>(() => (isExpanded(`${runId}:view:log`) ? 'log' : 'grouped'))
  const scoped = useMemo(() => view.tasks.filter((t) => !propertyId || t.property_id === propertyId), [view.tasks, propertyId])
  const counts = useMemo(() => {
    const c = { recorded: 0, planned: 0, noval: 0 }
    for (const t of scoped) c[rowKind(t)] += 1
    return c
  }, [scoped])
  const groups = useMemo(() => groupActivity(view, sources, { propertyId, filter }), [view, sources, propertyId, filter])
  const terminalRun = view.state === 'completed' || view.state === 'completed_partial' || view.state === 'cancelled' || view.state === 'failed'
  const setView = (v: View) => { setTab(v); toggleExpanded(`${runId}:view:log`, v === 'log') }

  const line = (t: TaskRow, why?: string) => {
    const key = t.source_id ? `${t.task_id}:${t.source_id}` : t.task_id
    const memKey = `${runId}:${t.task_id}`
    return (
      <TaskLine key={t.task_id} task={t} mode={mode} why={why} source={t.source_id ? sources[t.source_id] ?? null : null} sources={sources} findings={view.findings} open={isExpanded(memKey) || t.state === 'needs_input'} selected={ui.selectedSourceKey === key}
        arrival={t.first_event_id > arrivalFloor}
        onToggle={() => toggleExpanded(memKey)}
        onInspect={(findingId?: string) => setUi({ selectedSourceKey: key, selectedFindingId: findingId ?? t.finding_ids[0] ?? null, inspectorTab: 'evidence', rightCollapsed: false })}
        onAnswer={(option) => controlRun(runId, 'answer', { task_id: t.task_id, option })}
        terminalRun={terminalRun} />
    )
  }

  return (
    <div className="agx-tlw">
      <div className="agx-tl__legend" role="toolbar" aria-label="Activity view">
        <span className="agx-tl__seg" role="tablist" aria-label="Activity view">
          <button type="button" role="tab" aria-selected={tab === 'grouped'} className={cx('agx-tl__lg', tab === 'grouped' && 'is-on')} onClick={() => setView('grouped')}>Grouped</button>
          <button type="button" role="tab" aria-selected={tab === 'log'} className={cx('agx-tl__lg', tab === 'log' && 'is-on')} onClick={() => setView('log')}>Full log<small>{view.event_count}</small></button>
        </span>
        {tab === 'grouped' ? ([['all', 'All', scoped.length], ['recorded', 'Recorded', counts.recorded], ['planned', 'Planned', counts.planned], ['noval', 'No value', counts.noval]] as Array<[ActivityFilter, string, number]>).map(([id, label, n]) => (
          <button key={id} type="button" className={cx('agx-tl__lg', `is-${id}`, filter === id && 'is-on')} onClick={() => setFilter(id)} aria-pressed={filter === id} disabled={id !== 'all' && !n}>
            {id !== 'all' ? <i aria-hidden="true" /> : null}{label}<small>{n}</small>
          </button>
        )) : null}
      </div>
      {tab === 'log' ? <EventLog runId={runId} propertyId={propertyId} /> : !groups.length ? <p className="agx-empty">{scoped.length ? 'Nothing matches this filter.' : 'No operations yet. Rows appear as the run reports them — nothing is shown before it happens.'}</p> : (
        <div className="agx-tl" role="list" aria-label="Activity timeline">
          {groups.map((g) => {
            const buckets = g.entries.filter((e): e is Bucket => e.kind === 'bucket')
            const exc = buckets.reduce((n, b) => n + b.exceptions.length, 0)
            const decisions = g.entries.filter((x) => x.kind === 'decision').length
            const skipped = g.entries.filter((x) => x.kind === 'skipped').length
            return (
              <section key={g.phase} className={cx('agx-tl__group', g.phase === 'next' && 'is-next')} aria-label={g.label}>
                <header className="agx-tl__phase">
                  <span>{g.label}</span>
                  <small>{[g.taskCount ? `${g.taskCount} operation${g.taskCount === 1 ? '' : 's'}` : null, buckets.length > 1 ? `${buckets.length} groups` : null, exc ? `${exc} need${exc === 1 ? 's' : ''} attention` : null, skipped ? `${skipped} reused fresh` : null, decisions ? `${decisions} decision${decisions === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</small>
                </header>
                {g.entries.map((e) => {
                  if (e.kind === 'decision') return <DecisionLine key={e.key} d={e.decision} arrival={e.decision.event_id > arrivalFloor} />
                  if (e.kind === 'skipped') return (
                    <div key={e.key} className="agx-tl__row is-skipped is-recorded" role="listitem">
                      <span className="agx-tl__rail"><StateGlyph state="skipped" /></span>
                      <div className="agx-tl__main"><span className="agx-tl__label">{e.label}</span><span className="agx-tl__meta">Fresh until {e.fresh_until ?? '—'} · $0 · no new lookup</span></div>
                    </div>
                  )
                  // a group of one routine read is just the read
                  if (e.tasks.length === 1) return line(e.tasks[0], e.exceptions[0] ? EXCEPTION_LABEL[e.exceptions[0].why] : undefined)
                  const gKey = `${runId}:grp:${e.key}`
                  const open = isExpanded(gKey) || filter !== 'all'
                  const pid = e.property_id
                  return (
                    <div key={e.key} className={cx('agx-tl__bucket', open && 'is-open', g.phase === 'next' && 'is-planned')} role="listitem">
                      <button type="button" className="agx-tl__bhead" onClick={() => toggleExpanded(gKey)} aria-expanded={open}>
                        <span className="agx-tl__bglyph" aria-hidden="true"><i /><i /><i /></span>
                        <span className="agx-tl__btitle"><b>{e.family}</b>{pid ? <small>{propLabel(view, pid)}</small> : null}</span>
                        <span className="agx-tl__bsum">{bucketSummary(e)}</span>
                        <span className="agx-tl__bmore">{open ? 'Fold' : e.routine.length ? `Show ${e.routine.length}` : 'Show'}</span>
                      </button>
                      {e.exceptions.length ? <div className="agx-tl__bexc">{e.exceptions.map(({ task, why }) => line(task, EXCEPTION_LABEL[why]))}</div> : null}
                      {open && e.routine.length ? <div className="agx-tl__broutine">{e.routine.map((t) => line(t))}</div> : null}
                    </div>
                  )
                })}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

const propLabel = (view: ResearchView, pid: string) => {
  const a = view.properties[pid]?.display_address
  return a && a !== pid ? a : `Property ••${pid.replace(/[^a-z0-9]/gi, '').slice(-4)}`
}

/** Every event, in order — the complete record behind the grouped view. */
function EventLog({ runId, propertyId }: { runId: string; propertyId: string | null }) {
  useAgentVersion()
  const [family, setFamily] = useState<string>('all')
  const all = visibleEvents(runId)
  const events = propertyId ? all.filter((e) => !e.property_id || e.property_id === propertyId) : all
  const families = useMemo(() => { const m = new Map<string, number>(); for (const e of events) { const f = e.type.split('.')[0]; m.set(f, (m.get(f) ?? 0) + 1) } return [...m.entries()] }, [events])
  const shown = family === 'all' ? events : events.filter((e) => e.type.split('.')[0] === family)
  return (
    <div className="agx-log">
      <div className="agx-log__fam" role="toolbar" aria-label="Event family">
        <button type="button" className={cx('agx-tl__lg', family === 'all' && 'is-on')} onClick={() => setFamily('all')}>All<small>{events.length}</small></button>
        {families.map(([f, n]) => <button key={f} type="button" className={cx('agx-tl__lg', family === f && 'is-on')} onClick={() => setFamily(f)}>{f}<small>{n}</small></button>)}
      </div>
      <div className="agx-log__t" role="table" aria-label="Event log">
        <div className="agx-log__tr is-head" role="row"><span role="columnheader">Time</span><span role="columnheader">Seq</span><span role="columnheader">Event</span><span role="columnheader">Type</span><span role="columnheader">What it said</span></div>
        {shown.map((e) => (
          <div key={e.event_id} className={cx('agx-log__tr', `is-${e.type.split('.')[0]}`, /blocked|failed|unavailable|conflict/.test(e.type) && 'is-attn')} role="row">
            <span role="cell" className="agx-log__time" title={e.at}>{fmtTimeMs(e.at)}</span>
            <span role="cell" className="agx-log__seq">{e.seq}{e.attempt > 1 ? <em>·a{e.attempt}</em> : null}</span>
            <span role="cell" className="agx-log__id" title={[e.task_id && `task ${e.task_id}`, e.tool_call_id && `tool call ${e.tool_call_id}`, e.property_id && `property ${e.property_id}`].filter(Boolean).join(' · ')}>{e.event_id}</span>
            <span role="cell" className="agx-log__type">{e.type}</span>
            <span role="cell" className="agx-log__what">{eventSummary(e)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const fmtTimeMs = (iso: string) => { const d = new Date(iso); return `${d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}` }

function eventSummary(e: AgentEvent): string {
  const p = e.payload as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const f = p.finding as Record<string, unknown> | undefined
  switch (e.type) {
    case 'plan.task_added': case 'task.started': case 'tool.started': return s(p.label)
    case 'task.completed': return `done · ${p.duration_ms ?? '—'} ms · ${p.observation_count ?? 0} observation(s) · $${Number(p.cost_usd ?? 0).toFixed(2)}`
    case 'task.unavailable': case 'task.blocked': return `${reasonLabel(s(p.reason)) || s(p.reason)}${p.retry_at ? ` · retry ${fmtClock(s(p.retry_at))}` : ''}`
    case 'task.failed': return s(p.error_code)
    case 'source.retrieved': case 'source.searched': case 'source.opened': return `${s(p.source_id)} · ${s(p.purpose)}${p.http_class ? ` · ${s(p.http_class)}` : ''}`
    case 'source.blocked': case 'source.failed': return `${s(p.source_id)} · ${reasonLabel(s(p.reason)) || s(p.reason)}`
    case 'observation.extracted': return s(p.display_value)
    case 'finding.upserted': return f ? `${s(f.finding_type)} · ${s(f.evidence_status)} · ${s(f.display_value) || 'no value'}` : ''
    case 'finding.conflict': return `${s(p.finding_type)} · ${s(p.resolution_state)} · ${s(p.rule)}`
    case 'job.phase': return s(p.phase)
    case 'job.property_state': return `${s(p.state)}${p.display_address ? ` · ${s(p.display_address)}` : ''}`
    case 'brief.section': return `${s(p.label)} · ${Array.isArray(p.claims) ? p.claims.length : 0} claim(s)`
    case 'brief.completed': return `opportunity ${s(p.opportunity_class)} · readiness ${s(p.contact_readiness_class)}`
    case 'run.state': return `${s(p.from)} → ${s(p.to)}`
    case 'decision': case 'job.completed': case 'run.completed': case 'job.cancelled': case 'run.cancelled': return s(p.summary)
    default: return Object.keys(p).slice(0, 4).join(', ')
  }
}

function DecisionLine({ d, arrival }: { d: DecisionView; arrival: boolean }) {
  return (
    <div className={cx('agx-tl__decision', arrival && 'is-arrival')} role="listitem">
      <span className="agx-tl__why">Why</span>
      <p>{d.summary}</p>
      <time>{fmtClock(d.at)}</time>
    </div>
  )
}

const TaskLine = memo(function TaskLine({ task: t, mode, why, source, sources, findings, open, selected, arrival, onToggle, onInspect, onAnswer, terminalRun }: {
  task: TaskRow; mode: RunMode; why?: string; source: SourceRef | null; sources: Record<string, SourceRef>; findings: Record<string, FindingView>; open: boolean; selected: boolean; arrival: boolean
  onToggle: () => void; onInspect: (findingId?: string) => void; onAnswer: (option: string) => void; terminalRun: boolean
}) {
  const state = timelineState(t.state)
  const kind = rowKind(t)
  const fs = t.finding_ids.map((id) => findings[id]).filter(Boolean)
  const isTool = t.task_id.startsWith('tool:')
  const srcCls = sourceClass(source)
  const noValueCopy = t.message ?? reasonLabel(t.reason) ?? ''
  return (
    <div className={cx('agx-tl__row', `is-${state}`, `is-${kind}`, open && 'is-open', selected && 'is-selected', arrival && 'is-arrival')} role="listitem">
      <span className="agx-tl__rail"><StateGlyph state={state} /></span>
      <div className="agx-tl__main">
        <button type="button" className="agx-tl__head" onClick={onToggle} aria-expanded={open}>
          <span className="agx-tl__label"><Shimmer active={state === 'running'}>{t.label}</Shimmer></span>
          {why && why !== TIMELINE_LABEL[state] && why !== 'Running' && why !== 'Retried' ? <span className={cx('agx-tl__why-tag', `is-${why.toLowerCase().replace(/\s+/g, '-')}`)}>{why}</span> : null}
          <span className="agx-tl__state">{kind === 'planned' ? 'Planned' : TIMELINE_LABEL[state]}{t.attempt > 1 ? ` · attempt ${t.attempt}` : ''}</span>
        </button>
        <div className="agx-tl__meta">
          {isTool ? <span className="agx-tl__tool"><code>{t.tool ?? 'read'}</code><b className="agx-tier-pill">T0</b></span> : null}
          {source ? <span className="agx-tl__src"><Favicon source={source} size={14} />{source.name}<SimTag mode={mode} /></span> : null}
          {kind !== 'planned' && t.started_at ? <time dateTime={t.started_at} title="Server time">{fmtClock(t.started_at)}</time> : null}
          {kind === 'planned' && t.depends_on.length ? <span>waits on {t.depends_on.length} operation{t.depends_on.length === 1 ? '' : 's'}</span> : null}
          {t.duration_ms !== null && state !== 'running' && kind !== 'planned' ? <span>{fmtDur(t.duration_ms)}</span> : null}
          {t.rows !== null ? <span>{t.rows} row{t.rows === 1 ? '' : 's'}</span> : null}
          {t.cost_usd ? <span>{fmtUsd(t.cost_usd)}</span> : null}
          {t.attempt > 1 && t.prior_failure ? <span className="agx-tl__retry">retried after {reasonLabel(t.prior_failure).toLowerCase() || t.prior_failure}</span> : null}
          {t.after_cancel ? <span className="agx-tl__flag">settled after cancel</span> : null}
        </div>
        {t.result_summary && kind === 'recorded' ? <p className="agx-tl__sum">{t.result_summary}</p> : null}
        {fs.length ? (
          <div className="agx-tl__chips">
            {fs.map((f) => {
              const cls = evidenceClassOf(f, f.source_id ? sources[f.source_id] ?? null : source)
              return (
                <button key={f.finding_id} type="button" className={cx('agx-chip', `is-c-${cls}`, f.is_discovery && 'is-discovery', f.contradicted_by && 'is-contradicted')} onClick={() => onInspect(f.finding_id)} title={f.citation ?? undefined}>
                  <ClassTag cls={cls} compact />
                  <span>{f.display_value ?? (f.evidence_status === 'blocked' ? 'Blocked — no value' : 'Unavailable — no value')}</span>
                </button>
              )
            })}
          </div>
        ) : null}
        {kind === 'noval' && state !== 'needs_input' ? (
          <div className={cx('agx-blocked', state !== 'blocked' && 'is-failed')}>
            <p><b>{source?.name ?? (isTool ? t.tool ?? 'The read' : 'Source')}</b> — {noValueCopy || TIMELINE_LABEL[state].toLowerCase()}</p>
            <p className="agx-blocked__absence">No value read. Not evidence of absence{state === 'blocked' ? ' — no retry loop, no workaround' : ''}.</p>
            {t.alternatives.length ? <p className="agx-blocked__alt">Continuing via {t.alternatives.join(' · ')}</p> : null}
            {t.retry_at ? <p className="agx-blocked__alt">Retry scheduled {fmtClock(t.retry_at)}</p> : null}
          </div>
        ) : null}
        {state === 'needs_input' ? (
          <div className="agx-input" role="group" aria-label={t.question ?? 'Needs input'}>
            <p>{t.question}</p>
            <div className="agx-input__opts">
              {t.options.map((o) => <LCButton key={o} size="sm" variant="secondary" disabled={terminalRun || mode === 'live'} onClick={() => onAnswer(o)}>{o}</LCButton>)}
            </div>
            {terminalRun ? <small>The run finished without this answer — choose in a new pass.</small> : <small>The run continues other operations while it waits.</small>}
          </div>
        ) : null}
        {open && state !== 'needs_input' ? (
          <div className="agx-tl__detail">
            <dl>
              {source ? <div><dt>Source</dt><dd>{source.name} · {authorityLabel(source)}{source.host ? ` · ${source.host}` : ''}{srcCls ? <> · <ClassTag cls={srcCls} compact /></> : null}</dd></div> : null}
              {isTool ? <div><dt>Tool</dt><dd><code>{t.tool}</code> · T0 read · {t.operation}</dd></div> : null}
              <div><dt>Recorded</dt><dd>{kind === 'planned' ? `Planned at ${fmtClock(t.planned_at)} · not started` : <>{t.started_at ? `Started ${fmtClock(t.started_at)}` : ''}{t.ended_at ? ` · ended ${fmtClock(t.ended_at)}` : state === 'running' ? ' · running' : ''}</>}</dd></div>
              <div><dt>Data</dt><dd>{mode === 'live' ? (source?.authority_class === 'internal' || isTool ? 'Internal read — nothing leaves LeadCommand' : 'Read through the authorized source adapter') : 'Simulated — nothing was fetched'}</dd></div>
              {t.depends_on.length ? <div><dt>Waits on</dt><dd>{t.depends_on.join(', ')}</dd></div> : null}
              {t.retry_at ? <div><dt>Retry</dt><dd>{fmtClock(t.retry_at)} (scheduled — never automatic for a blocked source)</dd></div> : null}
            </dl>
            {t.steps.length ? (
              <ol className="agx-steps">
                {t.steps.map((s) => <li key={s.event_id} className={`is-${s.status}`}><span>{s.status}</span><time>{fmtClock(s.at)}</time>{s.detail ? <em>{s.detail}</em> : null}</li>)}
              </ol>
            ) : null}
            {t.observations.length ? (
              <ul className="agx-obs">
                {t.observations.map((o, i) => <li key={i}><b>{o.display_value}</b>{o.citation ? <cite>{o.citation}</cite> : null}</li>)}
              </ul>
            ) : null}
            {kind !== 'planned' ? <button type="button" className="agx-link" onClick={() => onInspect()}>Inspect evidence →</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
})
