import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { pushRoutePath, replaceRoutePath } from '../../../app/router'
import { fetchOverview, type Overview, type SystemWorkflow } from './workflow-observatory-api'
import { fetchActivity, fetchLeads, fetchStudioWorkflows, type ActivityItem, type ActivityResponse, type Lead, type LeadState, type LeadsResponse, type StudioWorkflow, type StudioWorkflowsResponse } from './studio-api'
import { CountUp, FlowRibbon, LEAD_LABEL, LiquidBackdrop, Orb, PlusGlyph, ReachBadge, Segmented, StatusPill } from './StudioParts'
import { ago, beatLabel, domainIcon, human } from './workflow-format'
import './workflow-surface.css'
import './studio.css'

const WorkflowRoom = lazy(() => import('./WorkflowRoom').then((m) => ({ default: m.WorkflowRoom })))
const RunRoom = lazy(() => import('./RunRoom').then((m) => ({ default: m.RunRoom })))
const StudioWorkflowRoom = lazy(() => import('./StudioRooms').then((m) => ({ default: m.StudioWorkflowRoom })))
const StudioRunRoom = lazy(() => import('./StudioRooms').then((m) => ({ default: m.StudioRunRoom })))
const CreateRoom = lazy(() => import('./StudioCreate').then((m) => ({ default: m.CreateRoom })))

/**
 * WORKFLOW STUDIO — mobile. The automation layer of the company, live:
 *   Overview   what needs you, what just happened, the automations running
 *   Workflows  every automation — system, yours, templates — and Create
 *   Leads      every lead moving through a workflow, and the step it is on
 *   Activity   the live feed across all runtimes
 * Every number is read from a runtime's own records. Nothing is simulated.
 */

type Tab = 'overview' | 'workflows' | 'leads' | 'activity'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'leads', label: 'Leads' },
  { id: 'activity', label: 'Activity' },
]

type Open =
  | { kind: 'system'; key: string }
  | { kind: 'system-run'; key: string; id: string }
  | { kind: 'studio'; key: string }
  | { kind: 'studio-run'; key: string; id: string }
  | { kind: 'create' }
  | null

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k) } catch { return null } }
const writeParams = (patch: Record<string, string | null>) => {
  try {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
    const qs = url.searchParams.toString()
    replaceRoutePath(`${url.pathname}${qs ? `?${qs}` : ''}`)
  } catch { /* best effort */ }
}

const TONE_ICON: Record<string, IconName> = { inbound: 'message', milestone: 'check', stage: 'trending-up', attention: 'alert', held: 'pause', scheduled: 'clock', sent: 'send', failed: 'alert', campaign: 'layers', action: 'zap', step: 'activity', closing: 'key' }

export function StudioSurface() {
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === readParam('tab')) ? (readParam('tab') as Tab) : 'overview'))
  const [overview, setOverview] = useState<Overview | null>(null)
  const [leads, setLeads] = useState<LeadsResponse | null>(null)
  const [activity, setActivity] = useState<ActivityResponse | null>(null)
  const [studio, setStudio] = useState<StudioWorkflowsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>(() => {
    const wf = readParam('wf'); const run = readParam('run'); const sw = readParam('studio')
    if (sw && run) return { kind: 'studio-run', key: sw, id: run }
    if (sw) return { kind: 'studio', key: sw }
    if (wf && run) return { kind: 'system-run', key: wf, id: run }
    if (wf) return { kind: 'system', key: wf }
    return readParam('create') ? { kind: 'create' } : null
  })
  const scroller = useRef<HTMLDivElement>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    const results = await Promise.allSettled([fetchOverview(signal), fetchLeads(signal), fetchActivity(signal), fetchStudioWorkflows(signal)])
    const [o, l, a, s] = results
    if (o.status === 'fulfilled') setOverview(o.value)
    if (l.status === 'fulfilled') setLeads(l.value)
    if (a.status === 'fulfilled') setActivity(a.value)
    if (s.status === 'fulfilled') setStudio(s.value)
    const failed = results.filter((r) => r.status === 'rejected' && (r.reason as Error)?.name !== 'AbortError')
    setError(failed.length === results.length ? 'unavailable' : null)
  }, [])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible' || open) return
      fetchActivity().then(setActivity).catch(() => {})
      fetchLeads().then(setLeads).catch(() => {})
    }, 20_000)
    return () => clearInterval(t)
  }, [open])

  const go = (t: Tab) => {
    setTab(t); writeParams({ tab: t === 'overview' ? null : t })
    const el = scroller.current; const seg = el?.querySelector<HTMLElement>('.wfx-segwrap')
    if (el && seg && el.scrollTop > seg.offsetTop - 70) el.scrollTo({ top: seg.offsetTop - 70, behavior: 'smooth' })
  }
  const show = (o: Open) => {
    setOpen(o)
    if (!o) return writeParams({ wf: null, run: null, studio: null, create: null })
    if (o.kind === 'system') writeParams({ wf: o.key, run: null, studio: null, create: null })
    if (o.kind === 'system-run') writeParams({ wf: o.key, run: o.id, studio: null, create: null })
    if (o.kind === 'studio') writeParams({ studio: o.key, run: null, wf: null, create: null })
    if (o.kind === 'studio-run') writeParams({ studio: o.key, run: o.id, wf: null, create: null })
    if (o.kind === 'create') writeParams({ create: '1', wf: null, run: null, studio: null })
  }
  const openLead = (l: Lead) => {
    if (l.workflow === 'seller_inbound') return show({ kind: 'system-run', key: 'seller_inbound', id: l.run_id })
    if (l.studio) return show({ kind: 'studio-run', key: l.workflow, id: l.run_id })
    if (l.link) pushRoutePath(l.link)
  }
  const openActivity = (i: ActivityItem) => {
    if (i.studio && i.run_id) return show({ kind: 'studio-run', key: i.workflow, id: i.run_id })
    if (i.workflow === 'seller_inbound' && i.run_id) return show({ kind: 'system-run', key: 'seller_inbound', id: i.run_id })
    if (i.link) pushRoutePath(i.link)
  }

  const needsYou = leads?.counts.needs_you ?? overview?.counts.needs_you ?? 0
  const inFlight = leads ? leads.counts.all - leads.counts.done : 0
  const liveAutomations = (overview?.system.filter((w) => w.status === 'live').length || 0) + (studio?.workflows.filter((w) => w.status === 'armed').length || 0)
  const ready = overview || leads || activity

  return (
    <div className={`wf3 wfx${needsYou ? ' is-amb-attention' : ''}`} ref={scroller} data-testid="workflow-surface">
      <LiquidBackdrop attention={needsYou > 0} />

      <header className="wfx-hero">
        <span className="wfx-eyebrow"><i className="wfx-live" />Automation · live</span>
        <h1>Workflow Studio</h1>
        {ready ? (
          <p className="wfx-lede">
            <b>{inFlight}</b> lead{inFlight === 1 ? '' : 's'} moving through <b>{liveAutomations}</b> live automation{liveAutomations === 1 ? '' : 's'}
            {needsYou ? <> · <em>{needsYou} need{needsYou === 1 ? 's' : ''} you</em></> : <> · nothing waiting on you</>}
          </p>
        ) : <p className="wfx-lede is-loading"><i /></p>}
        <div className="wfx-stats">
          <button type="button" className="wfx-stat" onClick={() => go('leads')}><b>{leads ? <CountUp value={inFlight} /> : '—'}</b><span>In flight</span></button>
          <button type="button" className={`wfx-stat is-attention${needsYou ? '' : ' is-zero'}`} onClick={() => go('leads')}><b>{leads || overview ? <CountUp value={needsYou} /> : '—'}</b><span>Need you</span></button>
          <button type="button" className="wfx-stat is-live" onClick={() => go('activity')}><b>{activity ? <CountUp value={activity.pulse.last_24h} /> : '—'}</b><span>Events · 24h</span></button>
          <button type="button" className="wfx-stat" onClick={() => go('workflows')}><b>{overview ? <CountUp value={liveAutomations} /> : '—'}</b><span>Live automations</span></button>
        </div>
      </header>

      <div className="wfx-segwrap">
        <Segmented tabs={TABS} value={tab} onChange={go} badges={{ leads: needsYou || undefined }} />
      </div>

      {error && !ready ? (
        <section className="wfx-empty" role="alert"><Icon name="alert" /><strong>Workflow Studio is unavailable</strong><p>The runtimes could not be read. Nothing is shown rather than a guess.</p><button type="button" className="wfx-btn" onClick={() => void load()}>Try again</button></section>
      ) : !ready ? (
        <div className="wfx-skel" aria-busy="true">{[0, 1, 2, 3].map((i) => <span key={i} style={{ ['--i' as string]: i }}><i /><i /><i /></span>)}</div>
      ) : (
        <main className="wfx-body" key={tab}>
          {tab === 'overview' ? <OverviewTab overview={overview} leads={leads} activity={activity} studio={studio} onLead={openLead} onActivity={openActivity} onSystem={(k) => show({ kind: 'system', key: k })} onStudio={(k) => show({ kind: 'studio', key: k })} onCreate={() => show({ kind: 'create' })} go={go} /> : null}
          {tab === 'workflows' ? <WorkflowsTab overview={overview} studio={studio} leads={leads} onSystem={(k) => show({ kind: 'system', key: k })} onStudio={(k) => show({ kind: 'studio', key: k })} onCreate={() => show({ kind: 'create' })} /> : null}
          {tab === 'leads' ? <LeadsTab leads={leads} onLead={openLead} /> : null}
          {tab === 'activity' ? <ActivityTab activity={activity} onItem={openActivity} /> : null}
        </main>
      )}

      <button type="button" className="wfx-fab" onClick={() => show({ kind: 'create' })} aria-label="Create a workflow"><PlusGlyph /><span>Create</span></button>

      <Suspense fallback={<div className="wf3-room is-loading" />}>
        {open?.kind === 'system' ? <WorkflowRoom wfKey={open.key} summary={overview?.system.find((w) => w.key === open.key) ?? null} onClose={() => show(null)} onOpenRun={(id) => show({ kind: 'system-run', key: open.key, id })} /> : null}
        {open?.kind === 'system-run' ? <RunRoom wfKey={open.key} runId={open.id} onClose={() => show(null)} /> : null}
        {open?.kind === 'studio' ? <StudioWorkflowRoom wfKey={open.key} onClose={() => { show(null); void load() }} onOpenRun={(id) => show({ kind: 'studio-run', key: open.key, id })} /> : null}
        {open?.kind === 'studio-run' ? <StudioRunRoom wfKey={open.key} runId={open.id} onClose={() => show({ kind: 'studio', key: open.key })} /> : null}
        {open?.kind === 'create' ? <CreateRoom onClose={() => show(null)} onCreated={(key) => { void load(); show({ kind: 'studio', key }) }} /> : null}
      </Suspense>
    </div>
  )
}

/* ── Overview ─────────────────────────────────────────────────────────────── */

function OverviewTab({ overview, leads, activity, studio, onLead, onActivity, onSystem, onStudio, onCreate, go }: {
  overview: Overview | null; leads: LeadsResponse | null; activity: ActivityResponse | null; studio: StudioWorkflowsResponse | null
  onLead: (l: Lead) => void; onActivity: (i: ActivityItem) => void; onSystem: (k: string) => void; onStudio: (k: string) => void; onCreate: () => void; go: (t: Tab) => void
}) {
  const needs = (leads?.leads || []).filter((l) => l.state === 'needs_you' || l.state === 'failed').slice(0, 8)
  const live = (activity?.items || []).slice(0, 6)
  const leadCount = (wf: string) => leads?.by_workflow.find((b) => b.workflow === wf)?.active || 0
  return (
    <>
      {needs.length ? (
        <section className="wfx-sec" aria-label="Needs you">
          <SecHead title="Needs you" count={leads?.counts.needs_you} tone="attention" action={{ label: 'All leads', onClick: () => go('leads') }} />
          <div className="wfx-rail">
            {needs.map((l, i) => (
              <button key={l.id} type="button" className={`wfx-needcard is-${l.state}`} style={{ ['--i' as string]: i }} onClick={() => onLead(l)}>
                <span className="wfx-needcard__top"><Orb name={l.subject.name} state={l.state} /><span className="wfx-needcard__wf">{l.workflow_name}</span></span>
                <strong>{l.subject.name || l.subject.address || 'Unknown seller'}</strong>
                <small>{l.subject.name ? l.subject.address : null}</small>
                <p>{l.reason || l.label}</p>
                <span className="wfx-needcard__foot"><span>{ago(l.at)}</span><span className="wfx-go">Open <Icon name="arrow-up-right" /></span></span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="wfx-sec" aria-label="Live now">
        <SecHead title="Live now" live action={{ label: 'All activity', onClick: () => go('activity') }} />
        <div className="wfx-panel">
          {live.length ? <ol className="wfx-feed is-compact">{live.map((i, n) => <FeedItem key={i.id} item={i} index={n} onOpen={onActivity} />)}</ol> : <p className="wfx-quiet">No activity in the last 48 hours.</p>}
        </div>
      </section>

      <section className="wfx-sec" aria-label="Automations">
        <SecHead title="Automations" count={(overview?.system.length || 0) + (studio?.workflows.length || 0)} action={{ label: 'All workflows', onClick: () => go('workflows') }} />
        <div className="wfx-rail is-wide">
          {(overview?.system || []).map((w, i) => <SystemCard key={w.key} w={w} leads={leadCount(w.key)} needs={leads ? leads.by_workflow.find((b) => b.workflow === w.key)?.needs_you ?? 0 : null} index={i} onOpen={() => onSystem(w.key)} />)}
          {(studio?.workflows || []).filter((w) => w.status !== 'archived').map((w, i) => <StudioCard key={w.key} w={w} index={i + 4} onOpen={() => onStudio(w.key)} />)}
          <button type="button" className="wfx-createcard" onClick={onCreate}><span className="wfx-createcard__plus"><PlusGlyph /></span><strong>New workflow</strong><small>Start from a blueprint</small></button>
        </div>
      </section>

      {overview ? (
        <section className="wfx-sec" aria-label="Runtime health">
          <SecHead title="Runtime health" />
          <div className="wfx-health">
            <Beat label="Outbound queue" state={overview.runtime.queue_runner.state} text={beatLabel(overview.runtime.queue_runner)} />
            <Beat label="Seller reconcile" state={overview.runtime.seller_reconcile.state} text={beatLabel(overview.runtime.seller_reconcile)} />
            {overview.system.filter((w) => w.health.state !== 'event_driven').map((w) => <Beat key={w.key} label={w.name.split(' · ')[0]} state={w.status === 'off' ? 'off' : w.health.state} text={w.status === 'off' ? 'Off' : beatLabel(w.health)} />)}
          </div>
        </section>
      ) : null}
      <p className="wfx-prov">Read from each runtime’s own records{activity ? ` · updated ${ago(activity.generated_at)}` : ''}</p>
    </>
  )
}

function Beat({ label, state, text }: { label: string; state: string; text: string }) {
  return <span className={`wfx-beat is-${state}`}><i /><b>{label}</b><small>{text}</small></span>
}

function SecHead({ title, count, tone, live, action }: { title: string; count?: number; tone?: string; live?: boolean; action?: { label: string; onClick: () => void } }) {
  return (
    <h2 className={`wfx-h2${tone ? ` is-${tone}` : ''}`}>
      {live ? <i className="wfx-live" /> : null}{title}{count !== undefined ? <span>{count}</span> : null}
      {action ? <button type="button" className="wfx-h2__act" onClick={action.onClick}>{action.label}<Icon name="chevron-right" /></button> : null}
    </h2>
  )
}

function SystemCard({ w, leads, needs, index, onOpen }: { w: SystemWorkflow; leads: number; needs: number | null; index: number; onOpen: () => void }) {
  const l: Record<string, number> = { ...(w.live || {}), ...(needs !== null ? { needs_you: needs } : {}) }
  const stat = w.key === 'seller_inbound' ? [l.runs_24h || 0, 'runs today'] : w.key === 'closing_execution' ? [l.running || 0, 'coordinating'] : w.key === 'campaign_execution' ? [l.running || 0, 'campaigns live'] : [l.waiting || 0, 'waiting']
  return (
    <button type="button" className={`wfx-wcard is-${w.domain}${w.status !== 'live' ? ' is-off' : ''}`} style={{ ['--i' as string]: index }} onClick={onOpen} data-wf={w.key}>
      <span className="wfx-wcard__top">
        <span className={`wfx-glyph is-${w.domain}`}><Icon name={domainIcon(w.domain)} /></span>
        <StatusPill status={w.status === 'live' ? 'live' : w.status}>{w.status === 'live' ? 'Live' : w.status === 'not_deployed' ? 'Not deployed' : human(w.status)}</StatusPill>
      </span>
      <strong>{w.name.split(' · ')[0]}</strong>
      <small>{w.trigger.label}</small>
      <FlowRibbon nodes={w.steps || []} active={w.status === 'live'} compact />
      <span className="wfx-wcard__stats"><span><b>{stat[0]}</b>{stat[1]}</span>{leads ? <span><b>{leads}</b>leads active</span> : null}{l.needs_you ? <span className="is-attention"><b>{l.needs_you}</b>need you</span> : null}</span>
    </button>
  )
}

function StudioCard({ w, index, onOpen }: { w: StudioWorkflow; index: number; onOpen: () => void }) {
  return (
    <button type="button" className={`wfx-wcard is-studio is-${w.status}`} style={{ ['--i' as string]: index }} onClick={onOpen} data-studio={w.key}>
      <span className="wfx-wcard__top">
        <span className="wfx-glyph is-studio"><Icon name="spark" /></span>
        <StatusPill status={w.status === 'armed' ? 'live' : w.status}>{w.status === 'armed' ? 'Armed' : human(w.status)}</StatusPill>
      </span>
      <strong>{w.name}</strong>
      <small><ReachBadge reach={w.reach} /> v{w.version}</small>
      <FlowRibbon nodes={w.nodes} active={w.status === 'armed'} compact />
      <span className="wfx-wcard__stats"><span><b>{w.runs.live}</b>in flight</span><span><b>{w.runs.completed_30d}</b>finished · 30d</span></span>
    </button>
  )
}

/* ── Workflows ────────────────────────────────────────────────────────────── */

function WorkflowsTab({ overview, studio, leads, onSystem, onStudio, onCreate }: { overview: Overview | null; studio: StudioWorkflowsResponse | null; leads: LeadsResponse | null; onSystem: (k: string) => void; onStudio: (k: string) => void; onCreate: () => void }) {
  const [showTemplates, setShowTemplates] = useState(false)
  const templates = (overview?.studio || []).filter((w) => !w.test)
  const leadCount = (wf: string) => leads?.by_workflow.find((b) => b.workflow === wf)?.active || 0
  return (
    <>
      <button type="button" className="wfx-createhero" onClick={onCreate}>
        <span className="wfx-createhero__glow" aria-hidden />
        <span className="wfx-createhero__plus"><PlusGlyph /></span>
        <span className="wfx-createhero__text"><strong>Create a workflow</strong><small>Pick a blueprint, tune it, preview exactly what it will do — then arm it.</small></span>
        <Icon name="chevron-right" />
      </button>

      <section className="wfx-sec" aria-label="Your workflows">
        <SecHead title="Your workflows" count={studio?.workflows.length || 0} />
        {studio && !studio.available ? <p className="wfx-quiet">The studio runtime is not installed yet.</p> : null}
        {studio?.workflows.length ? (
          <ul className="wfx-list">
            {studio.workflows.map((w, i) => (
              <li key={w.key} style={{ ['--i' as string]: i }}>
                <button type="button" className="wfx-row is-studio" onClick={() => onStudio(w.key)}>
                  <span className="wfx-glyph is-studio"><Icon name="spark" /></span>
                  <span className="wfx-row__main">
                    <strong>{w.name}</strong>
                    <small>{w.description}</small>
                    <FlowRibbon nodes={w.nodes} active={w.status === 'armed'} />
                    <span className="wfx-row__meta"><ReachBadge reach={w.reach} /><span>v{w.version}</span><span>{w.runs.live} in flight</span>{w.runs.needs_you ? <span className="is-attention">{w.runs.needs_you} need you</span> : null}</span>
                  </span>
                  <StatusPill status={w.status === 'armed' ? 'live' : w.status}>{w.status === 'armed' ? 'Armed' : human(w.status)}</StatusPill>
                </button>
              </li>
            ))}
          </ul>
        ) : studio?.available ? <p className="wfx-quiet">No workflows of your own yet — create one from a blueprint.</p> : null}
      </section>

      <section className="wfx-sec" aria-label="System automations">
        <SecHead title="Running the business" count={overview?.system.length || 0} />
        <ul className="wfx-list">
          {(overview?.system || []).map((w, i) => (
            <li key={w.key} style={{ ['--i' as string]: i }}>
              <button type="button" className={`wfx-row is-${w.domain}${w.status !== 'live' ? ' is-off' : ''}`} onClick={() => onSystem(w.key)} data-wf={w.key}>
                <span className={`wfx-glyph is-${w.domain}`}><Icon name={domainIcon(w.domain)} /></span>
                <span className="wfx-row__main">
                  <strong>{w.name.split(' · ')[0]}</strong>
                  <small>{w.trigger.label} · {w.owner}</small>
                  <FlowRibbon nodes={w.steps || []} active={w.status === 'live'} />
                  <span className="wfx-row__meta"><span>{beatLabel(w.health)}</span>{leadCount(w.key) ? <span>{leadCount(w.key)} leads active</span> : null}{(leads ? leads.by_workflow.find((b) => b.workflow === w.key)?.needs_you ?? 0 : w.live?.needs_you) ? <span className="is-attention">{leads ? leads.by_workflow.find((b) => b.workflow === w.key)?.needs_you : w.live?.needs_you} need you</span> : null}</span>
                </span>
                <StatusPill status={w.status === 'live' ? 'live' : w.status}>{w.status === 'live' ? 'Live' : w.status === 'not_deployed' ? 'Not deployed' : human(w.status)}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {templates.length ? (
        <section className="wfx-sec" aria-label="Templates">
          <button type="button" className="wfx-disclose" onClick={() => setShowTemplates((v) => !v)} aria-expanded={showTemplates}>
            <span><strong>Templates</strong><small>{templates.length} built, not armed — no production event starts them</small></span>
            <Icon name={showTemplates ? 'chevron-up' : 'chevron-down'} />
          </button>
          {showTemplates ? (
            <ul className="wfx-tpls">
              {templates.map((w) => <li key={w.id}><b>{w.name}</b><small>{w.trigger ? human(w.trigger.replace(/^trigger\./, '')) : 'No trigger'}</small></li>)}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

/* ── Leads ────────────────────────────────────────────────────────────────── */

const LEAD_FILTERS: Array<{ id: 'all' | LeadState; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'needs_you', label: 'Need you' }, { id: 'waiting', label: 'Waiting' }, { id: 'held', label: 'Held' }, { id: 'failed', label: 'Failed' }, { id: 'done', label: 'Handled' },
]

function LeadsTab({ leads, onLead }: { leads: LeadsResponse | null; onLead: (l: Lead) => void }) {
  const [state, setState] = useState<'all' | LeadState>('all')
  const [wf, setWf] = useState<string>('all')
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (leads?.leads || []).filter((l) => (state === 'all' || l.state === state) && (wf === 'all' || l.workflow === wf) && (!needle || `${l.subject.name} ${l.subject.address} ${l.workflow_name}`.toLowerCase().includes(needle)))
  }, [leads, state, wf, q])
  if (!leads) return <p className="wfx-quiet">Leads could not be read.</p>
  return (
    <>
      <div className="wfx-search"><Icon name="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search leads, addresses, workflows" aria-label="Search leads" /></div>
      <div className="wfx-chips" role="tablist" aria-label="Lead state">
        {LEAD_FILTERS.map((f) => (
          <button key={f.id} type="button" className={`wfx-chip is-${f.id}${state === f.id ? ' is-on' : ''}`} onClick={() => setState(f.id)} aria-pressed={state === f.id}>
            {f.label}<b>{f.id === 'all' ? leads.counts.all : leads.counts[f.id] || 0}</b>
          </button>
        ))}
      </div>
      <div className="wfx-chips is-soft" aria-label="Workflow">
        <button type="button" className={`wfx-chip${wf === 'all' ? ' is-on' : ''}`} onClick={() => setWf('all')}>Every workflow</button>
        {leads.by_workflow.map((b) => <button key={b.workflow} type="button" className={`wfx-chip${wf === b.workflow ? ' is-on' : ''}`} onClick={() => setWf(b.workflow)}>{b.name}<b>{b.total}</b></button>)}
      </div>
      <ul className="wfx-leads">
        {rows.map((l, i) => (
          <li key={l.id} style={{ ['--i' as string]: Math.min(i, 14) }}>
            <button type="button" className={`wfx-lead is-${l.state}`} onClick={() => onLead(l)}>
              <Orb name={l.subject.name} state={l.state} />
              <span className="wfx-lead__main">
                <span className="wfx-lead__eyebrow">{l.workflow_name}</span>
                <strong>{l.subject.name || l.subject.address || 'Unknown seller'}</strong>
                {l.subject.name && l.subject.address ? <small>{l.subject.address}</small> : null}
                <span className="wfx-lead__step"><i /> {l.state === 'needs_you' && l.reason ? l.reason : l.step || l.label}</span>
              </span>
              <span className="wfx-lead__side"><span className={`wfx-tag is-${l.state}`}>{LEAD_LABEL[l.state]}</span><small>{ago(l.at)}</small></span>
            </button>
          </li>
        ))}
      </ul>
      {!rows.length ? <p className="wfx-quiet">No leads match.</p> : null}
      <p className="wfx-prov">Latest run per conversation over {leads.window_days} days · studio runs · live closings{leads.degraded.length ? ` · could not read: ${leads.degraded.join(', ')}` : ''}</p>
    </>
  )
}

/* ── Activity ─────────────────────────────────────────────────────────────── */

const ACT_FILTERS: Array<{ id: string; label: string; test: (i: ActivityItem) => boolean }> = [
  { id: 'all', label: 'Everything', test: () => true },
  { id: 'seller', label: 'Sellers', test: (i) => i.workflow === 'seller_inbound' },
  { id: 'studio', label: 'Your workflows', test: (i) => Boolean(i.studio) },
  { id: 'sends', label: 'Sends', test: (i) => ['sent', 'failed', 'campaign'].includes(i.kind) },
  { id: 'attention', label: 'Attention', test: (i) => ['attention', 'failed'].includes(i.kind) },
]

function groupOf(at: string, now = Date.now()) {
  const t = Date.parse(at)
  if (now - t < 3600e3) return 'Last hour'
  const d = new Date(t); const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return 'Today'
  const y = new Date(now - 86400e3)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return 'Earlier'
}

function ActivityTab({ activity, onItem }: { activity: ActivityResponse | null; onItem: (i: ActivityItem) => void }) {
  const [f, setF] = useState('all')
  const seen = useRef<Set<string>>(new Set())
  const items = useMemo(() => (activity?.items || []).filter(ACT_FILTERS.find((x) => x.id === f)!.test), [activity, f])
  const fresh = useMemo(() => {
    const s = new Set<string>()
    if (seen.current.size) for (const i of activity?.items || []) if (!seen.current.has(i.id)) s.add(i.id)
    for (const i of activity?.items || []) seen.current.add(i.id)
    return s
  }, [activity])
  if (!activity) return <p className="wfx-quiet">Activity could not be read.</p>
  const groups: Array<[string, ActivityItem[]]> = []
  for (const i of items) { const g = groupOf(i.at); const last = groups[groups.length - 1]; if (last && last[0] === g) last[1].push(i); else groups.push([g, [i]]) }
  return (
    <>
      <div className="wfx-pulsebar"><i className="wfx-live" /><span><b>{activity.pulse.last_hour}</b> last hour</span><span><b>{activity.pulse.last_24h}</b> in 24h</span><span className="wfx-pulsebar__auto">Live</span></div>
      <div className="wfx-chips">
        {ACT_FILTERS.map((x) => <button key={x.id} type="button" className={`wfx-chip${f === x.id ? ' is-on' : ''}`} onClick={() => setF(x.id)}>{x.label}</button>)}
      </div>
      {groups.map(([g, list]) => (
        <section key={g} className="wfx-sec" aria-label={g}>
          <h3 className="wfx-h3">{g}<span>{list.length}</span></h3>
          <div className="wfx-panel"><ol className="wfx-feed">{list.map((i, n) => <FeedItem key={i.id} item={i} index={n} fresh={fresh.has(i.id)} onOpen={onItem} />)}</ol></div>
        </section>
      ))}
      {!items.length ? <p className="wfx-quiet">Nothing in the last {activity.window_hours} hours.</p> : null}
      <p className="wfx-prov">Seller brain · real send outcomes · your workflows · closings{activity.degraded.length ? ` · could not read: ${activity.degraded.join(', ')}` : ''}</p>
    </>
  )
}

function FeedItem({ item, index, fresh = false, onOpen }: { item: ActivityItem; index: number; fresh?: boolean; onOpen: (i: ActivityItem) => void }) {
  return (
    <li className={`wfx-fi is-${item.tone}${fresh ? ' is-fresh' : ''}`} style={{ ['--i' as string]: Math.min(index, 12) }}>
      <button type="button" onClick={() => onOpen(item)}>
        <span className="wfx-fi__glyph"><Icon name={TONE_ICON[item.kind] || 'activity'} /></span>
        <span className="wfx-fi__main">
          <span className="wfx-fi__title"><strong>{item.title}</strong><time>{ago(item.at)}</time></span>
          {item.detail ? <span className="wfx-fi__detail">{item.detail}</span> : null}
          <span className="wfx-fi__who">{item.subject.name || item.subject.address || item.workflow_name}{item.subject.name && item.subject.address ? <em> · {item.subject.address}</em> : null}</span>
          <span className="wfx-fi__wf">{item.workflow_name}</span>
        </span>
      </button>
    </li>
  )
}
