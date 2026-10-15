import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cx } from '../../../../shared/lc'
import { WebCitations } from '../../../agent/ask/ui/ResultBlocks'
import { runFailureOf, type ResultBlock, type WebCitation } from '../../../agent/ask/ask-model'
import { useAsk } from '../../../agent/ask/ask-store'
import { useRuns } from '../../../agent/runtime/agent-store'
import { machineState, runtimeHealth } from '../../../desktop/rail/rail-model'
import { appName, useRail } from '../../../desktop/rail/rail-store'
import { openApp } from '../../../desktop/workspace/workspace-store'
import { KNOWN_MISSION_KINDS, RESEARCH_MISSION_KIND, listApprovals, type CapabilityApproval, type PlaneFailure } from '../../api/ic-client'
import { createMission, inspect, openConversation, refreshApprovals, refreshCapabilities, refreshHealth, refreshMissions, refreshQuickScans, refreshShadow, useIc } from '../../store/ic-store'
import { DiffCard } from '../ActCard'
import { EmptyLine, IcGlyph, PlaneNotice, Spec, ago, clock, usd } from '../primitives'

const ACTIVE_LIVE = new Set(['starting', 'connecting', 'streaming', 'reconnecting'])

function SectionHead({ title, summary, children }: { title: string; summary?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ic-sec__h">
      <div><h2>{title}</h2>{summary ? <div className="ic-sec__sum">{summary}</div> : null}</div>
      {children ? <div className="ic-sec__tools">{children}</div> : null}
    </header>
  )
}

/* ── Missions (R2 runtime) ─────────────────────────────────────────────── */

export function MissionsSection() {
  const ic = useIc()
  const [kind, setKind] = useState<string>(KNOWN_MISSION_KINDS[0])
  // every visit re-reads the planes (a plane can be switched on or off at any time)
  useEffect(() => { void refreshMissions(); void refreshCapabilities() }, [])
  const canCreate = ic.capabilities.phase === 'ready' && Boolean(ic.capabilities.data?.some((c) => c.id === 'missions.create'))
  const rt = ic.runtime.data
  return (
    <section className="ic-sec">
      <SectionHead title="Missions" summary={<Spec items={['Persistent jobs on the server runtime (agent.research_job · agent.job_event)', 'they keep running with the browser closed']} />}>
        <select className="ic-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Mission kind">
          {KNOWN_MISSION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          <option value={RESEARCH_MISSION_KIND} disabled>{RESEARCH_MISSION_KIND} — handler not in this build</option>
        </select>
        <button type="button" className="ic-btn" disabled={!canCreate} onClick={() => void createMission(kind)} title={canCreate ? 'missions.create → agent.runtime_enqueue' : 'needs the actions plane (missions.create)'}>Queue mission</button>
      </SectionHead>
      {ic.missionNote ? <p className="ic-note" role="status">{ic.missionNote}</p> : null}
      {ic.capabilities.phase === 'failed' && ic.capabilities.failure ? <PlaneNotice failure={ic.capabilities.failure} title="Mission creation unavailable (actions plane)" compact /> : null}
      {ic.runtime.phase === 'failed' && ic.runtime.failure ? <PlaneNotice failure={ic.runtime.failure} onRetry={() => void refreshMissions()} /> : null}
      {rt ? (
        <div className="ic-grid3">
          <Fact k="Runtime" v={rt.limits ? (rt.limits.emergency_stop ? 'emergency stop' : rt.limits.runtime_enabled ? 'armed' : 'disarmed') : 'unknown'} tone={rt.limits?.emergency_stop ? 'bad' : rt.limits?.runtime_enabled ? 'ok' : 'warn'} />
          <Fact k="Open" v={Object.entries(rt.open).map(([s, n]) => `${n} ${s}`).join(' · ') || '0'} />
          <Fact k="Ended 24h" v={Object.entries(rt.ended_24h).map(([s, n]) => `${n} ${s}`).join(' · ') || '0'} />
        </div>
      ) : null}
      {ic.missions.phase === 'ready' ? (
        ic.missions.data?.length ? (
          <ul className="ic-rows">
            {ic.missions.data.map((m) => (
              <li key={m.job_id}><button type="button" className={cx('ic-row', ic.inspector?.kind === 'mission' && ic.inspector.id === m.job_id && 'is-on')} onClick={() => inspect({ kind: 'mission', id: m.job_id })}>
                <span className={cx('ic-state', `is-${m.state}`)}>{m.state.replace(/_/g, ' ')}</span>
                <b>{m.kind}</b>
                <Spec items={[`attempt ${m.attempt}/${m.max_attempts}`, m.trigger_kind, m.budget_cap_usd ? `cap ${usd(m.budget_cap_usd)}` : '$0', `updated ${ago(m.updated_at)}`]} />
              </button></li>
            ))}
          </ul>
        ) : <EmptyLine>No runtime missions yet.</EmptyLine>
      ) : ic.missions.phase === 'loading' ? <EmptyLine>Reading the runtime…</EmptyLine> : null}
    </section>
  )
}

function Fact({ k, v, tone }: { k: string; v: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return <div className={cx('ic-fact', tone && `is-${tone}`)}><span>{k}</span><b>{v}</b></div>
}

/* ── Research: ask runs + live Quick Scans ─────────────────────────────── */

export function ResearchSection() {
  const a = useAsk()
  const ic = useIc()
  useEffect(() => { void refreshQuickScans() }, [])
  const turns = a.threads.flatMap((t) => t.turns.map((u) => ({ t, u }))).sort((x, y) => y.u.sentAt - x.u.sentAt)
  return (
    <section className="ic-sec">
      <SectionHead title="Research" summary={<Spec items={[`${turns.length} research run${turns.length === 1 ? '' : 's'} in this tab's index`, 'Quick Scan history from the live agent']} />} />
      <h3 className="ic-sub">Research runs</h3>
      {turns.length ? (
        <ul className="ic-rows">
          {turns.slice(0, 40).map(({ t, u }) => {
            const fail = u.run ? runFailureOf(u.run) : null
            return (
              <li key={u.id}><button type="button" className="ic-row" onClick={() => { openConversation(t.id); inspect({ kind: 'turn', threadId: t.id, turnId: u.id }) }}>
                <span className={cx('ic-state', `is-${u.phase}`)}>{u.phase === 'done' ? (u.run?.state ?? 'done') : u.phase}</span>
                <b>{u.text || t.title}</b>
                <Spec items={[ic.turnModes[u.id] === 'plan' ? 'plan' : 'ask', u.run ? usd(u.run.cost_usd) : null, u.run?.counters.tool_calls != null ? `${u.run.counters.tool_calls} reads` : null, u.run?.counters.web_searches ? `${u.run.counters.web_searches} web` : null, fail ? fail.title : null, ago(u.sentAt)]} />
              </button></li>
            )
          })}
        </ul>
      ) : <EmptyLine>No research runs yet — ask from the composer.</EmptyLine>}
      <h3 className="ic-sub">Quick Scans</h3>
      {ic.quickScans.phase === 'failed' && ic.quickScans.failure ? <PlaneNotice failure={ic.quickScans.failure} compact onRetry={() => void refreshQuickScans()} />
        : ic.quickScans.data?.length ? (
          <ul className="ic-rows">{ic.quickScans.data.map((r) => (
            <li key={r.run_id}><div className="ic-row is-static"><span className={cx('ic-state', `is-${r.state}`)}>{r.state ?? '—'}</span><b>{r.title ?? r.run_id}</b><Spec items={[`${r.property_count} propert${r.property_count === 1 ? 'y' : 'ies'}`, ago(r.created_at)]} /></div></li>
          ))}</ul>
        ) : ic.quickScans.phase === 'ready' ? <EmptyLine>No live Quick Scans for this operator.</EmptyLine> : <EmptyLine>Reading Quick Scan history…</EmptyLine>}
    </section>
  )
}

/* ── Findings: typed results of real runs ─────────────────────────────── */

type PR = Extract<ResultBlock, { kind: 'property_research' }>
export function FindingsSection() {
  const a = useAsk()
  const found = useMemo(() => {
    const props: Array<{ b: PR; threadId: string; turnId: string; at: number }> = []
    const web = new Map<string, WebCitation>()
    for (const t of a.threads) for (const u of t.turns) {
      for (const b of u.run?.result?.blocks ?? []) if (b.kind === 'property_research') props.push({ b: b as PR, threadId: t.id, turnId: u.id, at: u.sentAt })
      for (const c of u.run?.result?.evidence.public_web ?? []) web.set(c.url, c)
    }
    return { props: props.sort((x, y) => y.at - x.at), web: [...web.values()] }
  }, [a.threads])
  return (
    <section className="ic-sec">
      <SectionHead title="Findings" summary={<Spec items={['Typed results of the runs in this tab (lc.ask.result v1)', 'persistent agent.finding rows need the runtime read route']} />} />
      {found.props.length ? (
        <div className="ic-cards">
          {found.props.map(({ b, threadId, turnId }, i) => (
            <button key={`${turnId}:${i}`} type="button" className="ic-card" onClick={() => { openConversation(threadId); inspect({ kind: 'turn', threadId, turnId }) }}>
              <span className="ic-card__k"><IcGlyph name="db" size={11} />Property research</span>
              <b>{b.address_label || b.title}</b>
              {b.summary ? <p>{b.summary}</p> : null}
              <Spec items={[`${b.facts.filter((f) => f.evidence === 'internal').length} LeadCommand facts`, `${b.facts.filter((f) => f.evidence === 'public_web').length} public-web facts`, b.gaps.length ? `${b.gaps.length} gaps` : null, b.listing_status ? `listing · ${b.listing_status.status}` : null]} />
            </button>
          ))}
        </div>
      ) : <EmptyLine>No typed findings yet. Property research results land here as runs complete.</EmptyLine>}
      {found.web.length ? <><h3 className="ic-sub">Public-web sources cited</h3><WebCitations citations={found.web} /></> : null}
    </section>
  )
}

/* ── Approvals ─────────────────────────────────────────────────────────── */

export function ApprovalsSection() {
  const ic = useIc()
  const [all, setAll] = useState<{ phase: 'idle' | 'ready' | 'failed'; items: CapabilityApproval[]; failure: PlaneFailure | null }>({ phase: 'idle', items: [], failure: null })
  const [showAll, setShowAll] = useState(false)
  useEffect(() => { void refreshApprovals() }, [])
  useEffect(() => {
    if (!showAll) return
    let live = true
    void listApprovals('all').then((r) => { if (live) setAll(r.ok ? { phase: 'ready', items: r.data, failure: null } : { phase: 'failed', items: [], failure: r }) })
    return () => { live = false }
  }, [showAll, ic.approvals.at])
  const items = showAll ? all.items : ic.approvals.data ?? []
  const failure = showAll ? all.failure : ic.approvals.failure
  return (
    <section className="ic-sec">
      <SectionHead title="Approvals" summary={<Spec items={[ic.approvals.phase === 'ready' ? `${ic.approvals.data?.length ?? 0} pending` : null, 'the agent only prepares; a human decides here', 'decide sends the exact approval id + payload hash shown']} />}>
        <div className="ic-seg"><button type="button" className={cx(!showAll && 'is-on')} onClick={() => setShowAll(false)}>Pending</button><button type="button" className={cx(showAll && 'is-on')} onClick={() => setShowAll(true)}>All</button></div>
        <button type="button" className="ic-btn is-quiet" onClick={() => void refreshApprovals()}><IcGlyph name="retry" size={12} />Refresh</button>
      </SectionHead>
      {failure ? <PlaneNotice failure={failure} title={failure.state === 'not_enabled' ? 'Actions plane not enabled' : undefined} onRetry={() => void refreshApprovals()} /> : null}
      {!failure && (ic.approvals.phase === 'ready' || showAll) ? (items.length ? <div className="ic-stack">{items.map((ap) => <DiffCard key={ap.approval_id} approval={ap} />)}</div> : <EmptyLine>{showAll ? 'No approvals recorded.' : 'Nothing is waiting on you.'}</EmptyLine>) : null}
      {ic.approvals.phase === 'loading' ? <EmptyLine>Reading approvals…</EmptyLine> : null}
    </section>
  )
}

/* ── Activity: machine events (shell telemetry) + agent run events ────── */

export function ActivitySection() {
  const rail = useRail()
  const a = useAsk()
  const agentEvents = useMemo(() => a.threads.flatMap((t) => t.turns.flatMap((u) => (u.events ?? []).filter((e) => e.type === 'tool_end' || e.type === 'web_search' || e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled').map((e) => ({ key: `${u.id}:${e.seq}`, at: String(e.at ?? ''), text: e.type === 'tool_end' ? `Read ${String(e.tool)} · ${String(e.rows ?? 0)} rows · ${String(e.outcome)}` : e.type === 'web_search' ? `Searched the public web · ${String(e.searches ?? 0)}` : `Run ${e.type}`, q: u.text })))).sort((x, y) => (y.at < x.at ? -1 : 1)).slice(0, 60), [a.threads])
  return (
    <section className="ic-sec">
      <SectionHead title="Activity" summary={<Spec items={['Machine events from shell telemetry (ledger-backed)', 'agent events from runs streamed in this tab']} />} />
      <div className="ic-two">
        <div>
          <h3 className="ic-sub">Machine</h3>
          {rail.error && !rail.telemetry ? <PlaneNotice failure={{ ok: false, state: 'unavailable', status: 0, code: 'TELEMETRY_UNREACHABLE', message: 'Shell telemetry is unreachable from this browser.', next: null }} compact /> : null}
          {rail.recent.length ? <ol className="ic-feed">{rail.recent.map((e) => <li key={e.id}><time>{clock(e.occurred_at)}</time><span className="ic-feed__app">{appName(e.app)}</span><span>{e.text ?? e.label ?? e.kind}</span></li>)}</ol> : <EmptyLine>No machine events since this page opened (history is never replayed as new).</EmptyLine>}
        </div>
        <div>
          <h3 className="ic-sub">Agent</h3>
          {agentEvents.length ? <ol className="ic-feed">{agentEvents.map((e) => <li key={e.key}><time>{clock(e.at)}</time><span className="ic-feed__app">Agent</span><span>{e.text}</span></li>)}</ol> : <EmptyLine>No agent events in this tab yet.</EmptyLine>}
        </div>
      </div>
    </section>
  )
}

/* ── Workforce: only real runtimes and runs ───────────────────────────── */

export function WorkforceSection() {
  const rail = useRail()
  const a = useAsk()
  const runs = useRuns()
  const ic = useIc()
  useEffect(() => { void refreshMissions() }, [])
  const now = Date.now()
  const asking = a.threads.flatMap((t) => t.turns.filter((u) => u.phase === 'running' || u.phase === 'sending').map((u) => ({ t, u })))
  const scans = runs.filter((r) => r.mode === 'live' && r.live && ACTIVE_LIVE.has(r.live.status))
  const runtimes = rail.telemetry?.runtimes ?? []
  return (
    <section className="ic-sec">
      <SectionHead title="Agent workforce" summary={<Spec items={['Only runtimes the shell telemetry reports and runs the agent APIs hold', 'nothing here is simulated']} />} />
      <h3 className="ic-sub">Agents working now</h3>
      {asking.length || scans.length ? (
        <ul className="ic-rows">
          {asking.map(({ t, u }) => <li key={u.id}><button type="button" className="ic-row" onClick={() => { openConversation(t.id); inspect({ kind: 'turn', threadId: t.id, turnId: u.id }) }}><span className="ic-state is-running">running</span><b>Research agent</b><Spec items={[u.text.slice(0, 80), u.runId ? <code key="r">{u.runId}</code> : 'sending', `since ${ago(u.sentAt)}`]} /></button></li>)}
          {scans.map((r) => <li key={r.runId}><div className="ic-row is-static"><span className="ic-state is-running">{r.live!.status}</span><b>Quick Scan</b><Spec items={[`${r.live!.propertyIds.length} propert${r.live!.propertyIds.length === 1 ? 'y' : 'ies'}`, r.live!.serverRunId ? <code key="s">{r.live!.serverRunId}</code> : null, `since ${ago(r.createdAt)}`]} /></div></li>)}
        </ul>
      ) : <EmptyLine>No agent is running right now.</EmptyLine>}
      <h3 className="ic-sub">Platform runtimes</h3>
      {!rail.telemetry ? (rail.error ? <PlaneNotice failure={{ ok: false, state: 'unavailable', status: 0, code: 'TELEMETRY_UNREACHABLE', message: 'Shell telemetry is unreachable from this browser.', next: null }} compact /> : <EmptyLine>Reading shell telemetry…</EmptyLine>) : (
        <div className="ic-table" role="table" aria-label="Runtimes">
          <div className="ic-table__h" role="row"><span>Runtime</span><span>Heartbeat</span><span>Cadence</span><span>24h runs</span><span>In flight</span><span>Needs you</span></div>
          {runtimes.map((r) => {
            const h = runtimeHealth(r, now)
            return (
              <div key={r.key} className="ic-table__r" role="row">
                <span><i className={cx('ic-hb', `is-${h}`)} aria-hidden="true" />{r.owner_href ? <button type="button" className="ic-link" onClick={() => openApp(r.owner_href!, 'beside')}>{r.name}</button> : r.name}</span>
                <span>{h === 'off' ? 'off' : r.heartbeat_at ? ago(r.heartbeat_at, now) : r.heartbeat_state.replace(/_/g, ' ')}</span>
                <span>{r.cadence ?? '—'}</span>
                <span>{r.runs_24h ?? '—'}</span>
                <span>{r.in_flight}</span>
                <span>{r.needs_you || '—'}</span>
              </div>
            )
          })}
        </div>
      )}
      {ic.runtime.data?.heartbeats.length ? (<><h3 className="ic-sub">Agent runtime workers</h3><ul className="ic-rows">{ic.runtime.data.heartbeats.map((h) => <li key={h.worker_id}><div className="ic-row is-static"><span className="ic-state">{h.ticks} ticks</span><b>{h.worker_id}</b><Spec items={[`last tick ${ago(h.last_tick_at)}`]} /></div></li>)}</ul></>) : null}
    </section>
  )
}

/* ── System health ────────────────────────────────────────────────────── */

export function HealthSection() {
  const rail = useRail()
  const a = useAsk()
  const ic = useIc()
  useEffect(() => { void refreshCapabilities(); void refreshShadow(); void refreshMissions(); void refreshQuickScans() }, [])
  useEffect(() => { if (ic.capabilities.phase === 'ready' && ic.health.phase === 'idle' && ic.capabilities.data?.some((c) => c.id === 'platform.health')) void refreshHealth() }, [ic.capabilities.phase, ic.health.phase, ic.capabilities.data])
  const m = machineState(rail.telemetry, Date.now())
  const st = a.status
  const planes: Array<{ id: string; label: string; state: 'ok' | 'off' | 'bad' | 'pending'; detail: string }> = [
    { id: 'ask', label: 'Research agent (ask)', state: st.phase === 'ready' ? (st.data?.models.ok ? 'ok' : 'bad') : st.phase === 'failed' ? (st.failure?.kind === 'disabled' ? 'off' : 'bad') : 'pending', detail: st.phase === 'ready' ? `models ${st.data?.models.ok ? 'resolved' : `unresolved (${st.data?.models.code ?? '—'})`} · ${st.data?.tools.length ?? 0} read tools · ${st.data?.runs_today ?? 0}/${st.data?.daily_run_cap ?? '—'} runs today` : st.failure ? `${st.failure.message} (${st.failure.code})` : 'reading…' },
    planeRow('actions', 'Actions + approvals', ic.capabilities.phase, ic.capabilities.failure, ic.capabilities.data ? `${ic.capabilities.data.length} capabilities · ${ic.capabilities.data.filter((c) => c.tier === 'requires_explicit_approval').length} need approval` : ''),
    planeRow('shadow', 'Conversation AI · shadow', ic.shadow.phase, ic.shadow.failure, ic.shadow.data ? (ic.shadow.data.available ? `${ic.shadow.data.records.length} recent decisions (read only)` : `table not applied (${ic.shadow.data.code ?? '—'})`) : '', ic.shadow.data && !ic.shadow.data.available ? 'off' : undefined),
    planeRow('runtime', 'Missions runtime (R2)', ic.runtime.phase, ic.runtime.failure, ic.runtime.data ? `runtime ${ic.runtime.data.limits?.runtime_enabled ? 'armed' : 'disarmed'}` : ''),
    planeRow('qs', 'Quick Scan (live agent)', ic.quickScans.phase, ic.quickScans.failure, ic.quickScans.data ? `${ic.quickScans.data.length} recent scans` : ''),
    { id: 'telemetry', label: 'Shell telemetry', state: rail.telemetry ? (m.state === 'degraded' ? 'bad' : 'ok') : rail.error ? 'bad' : 'pending', detail: rail.telemetry ? `${m.state}${m.reason ? ` · ${m.reason}` : ''} · ${rail.telemetry.runtimes.length} runtimes${rail.telemetry.degraded.length ? ` · degraded sources: ${rail.telemetry.degraded.join(', ')}` : ''}` : rail.error ? 'unreachable' : 'reading…' },
  ]
  const h = ic.health.data?.result as Record<string, unknown> | null | undefined
  const heartbeats = Array.isArray(h?.heartbeats) ? (h!.heartbeats as Array<Record<string, unknown>>) : []
  const findings = Array.isArray((h?.watchdog as Record<string, unknown> | null)?.findings) ? ((h!.watchdog as Record<string, unknown>).findings as Array<Record<string, unknown>>) : []
  return (
    <section className="ic-sec">
      <SectionHead title="System health" summary={<Spec items={[`Machine ${m.state}`, m.reason, m.needYou ? `${m.needYou} workflow holds need you` : null]} />}>
        <button type="button" className="ic-btn is-quiet" disabled={ic.capabilities.phase !== 'ready'} onClick={() => void refreshHealth()} title="platform.health (read capability)"><IcGlyph name="retry" size={12} />Read platform health</button>
      </SectionHead>
      <div className="ic-table" role="table" aria-label="Intelligence planes">
        <div className="ic-table__h is-3" role="row"><span>Plane</span><span>State</span><span>Detail</span></div>
        {planes.map((p) => <div key={p.id} className="ic-table__r is-3" role="row"><span>{p.label}</span><span><i className={cx('ic-hb', p.state === 'ok' ? 'is-current' : p.state === 'bad' ? 'is-delayed' : p.state === 'off' ? 'is-off' : 'is-never')} aria-hidden="true" />{p.state === 'ok' ? 'on' : p.state === 'off' ? 'not enabled' : p.state === 'bad' ? 'problem' : 'reading'}</span><span className="ic-table__d">{p.detail}</span></div>)}
      </div>
      <h3 className="ic-sub">Platform health · platform.health</h3>
      {ic.health.phase === 'failed' && ic.health.failure ? <PlaneNotice failure={ic.health.failure} compact /> : ic.capabilities.phase === 'failed' ? <EmptyLine>Needs the actions plane (read capability platform.health).</EmptyLine> : ic.health.data && !ic.health.data.ok ? <EmptyLine>Refused: {ic.health.data.code ?? ic.health.data.status}</EmptyLine> : h ? (
        <div className="ic-two">
          <div>
            <h4 className="ic-sub2">Scheduler heartbeats</h4>
            <ul className="ic-rows">{heartbeats.map((x, i) => <li key={i}><div className="ic-row is-static"><span className={cx('ic-state', `is-${String(x.status)}`)}>{String(x.status ?? '—')}</span><b>{String(x.key ?? '—')}</b><Spec items={[x.age_seconds != null ? `${Math.round(Number(x.age_seconds) / 60)} min old` : null, x.threshold_seconds != null ? `limit ${Math.round(Number(x.threshold_seconds) / 60)} min` : null, x.observed_at ? clock(String(x.observed_at)) : null]} /></div></li>)}</ul>
          </div>
          <div>
            <h4 className="ic-sub2">Watchdog findings</h4>
            {findings.length ? <ul className="ic-rows">{findings.map((f, i) => <li key={i}><div className="ic-row is-static"><span className={cx('ic-state', `is-${String(f.severity)}`)}>{String(f.severity)}</span><b>{String(f.code)}</b><Spec items={[String(f.summary ?? '')]} /></div></li>)}</ul> : <EmptyLine>No watchdog findings.</EmptyLine>}
          </div>
        </div>
      ) : <EmptyLine>{ic.health.phase === 'loading' ? 'Reading…' : 'Not read yet.'}</EmptyLine>}
      {ic.health.data?.result ? <p className="ic-note">Read {ago(ic.health.at)} through the capability plane (audited).</p> : null}
    </section>
  )
}

function planeRow(id: string, label: string, phase: string, failure: PlaneFailure | null, ok: string, force?: 'off') {
  return { id, label, state: force ?? (phase === 'ready' ? 'ok' : phase === 'failed' ? (failure?.state === 'not_enabled' ? 'off' : 'bad') : 'pending'), detail: phase === 'ready' ? ok : failure ? (failure.state === 'not_enabled' ? failure.next ?? failure.message : `${failure.message} (${failure.code})`) : 'reading…' } as const
}

/* ── Seller conversation AI (shadow, read-only) ───────────────────────── */

export function ShadowSection() {
  const ic = useIc()
  useEffect(() => { void refreshShadow() }, [])
  const d = ic.shadow.data
  return (
    <section className="ic-sec">
      <SectionHead title="Seller conversation AI · shadow" summary={<Spec items={['Decisions the conversation engine would have made', 'read only — nothing here can send', 'masked text only']} />}>
        <button type="button" className="ic-btn is-quiet" onClick={() => void refreshShadow()}><IcGlyph name="retry" size={12} />Refresh</button>
      </SectionHead>
      {ic.shadow.phase === 'failed' && ic.shadow.failure ? <PlaneNotice failure={ic.shadow.failure} onRetry={() => void refreshShadow()} /> : null}
      {d && !d.available ? <PlaneNotice failure={{ ok: false, state: 'not_enabled', status: 200, code: d.code ?? 'SHADOW_UNAVAILABLE', message: '', next: d.code === 'SHADOW_TABLE_NOT_APPLIED' ? 'Conversation AI shadow table not applied: PROPOSED_20261013160000_conversation_ai_shadow.' : 'The shadow read failed on the server.' }} /> : null}
      {d?.available ? (d.records.length ? (
        <ul className="ic-rows">{d.records.map((r) => (
          <li key={r.inbound_message_id}><button type="button" className={cx('ic-row', ic.inspector?.kind === 'shadow' && ic.inspector.id === r.inbound_message_id && 'is-on')} onClick={() => inspect({ kind: 'shadow', id: r.inbound_message_id })}>
            <span className={cx('ic-state', `is-${(r.outcome ?? '').toLowerCase()}`)}>{(r.outcome ?? '—').replace(/_/g, ' ').toLowerCase()}</span>
            <b>{r.seller_message_masked ?? '(no text)'}</b>
            <Spec items={[r.intent, r.stage, r.confidence != null ? `${Math.round(r.confidence * 100)}%` : null, r.cost_usd != null ? usd(r.cost_usd) : null, ago(r.created_at)]} />
          </button></li>
        ))}</ul>
      ) : <EmptyLine>No shadow decisions recorded yet.</EmptyLine>) : null}
    </section>
  )
}
