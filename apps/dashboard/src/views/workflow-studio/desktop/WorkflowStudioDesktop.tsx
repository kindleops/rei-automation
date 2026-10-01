import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCHoverCard, LCIconButton, LCLive, LCSkeleton, LCTabs, useLcReducedMotion } from '../../../shared/lc'
import { useClaimedKeys } from '../../../shared/lc/keys'
import { fetchExceptions, fetchRegistry } from './lib/api'
import { count } from './lib/format'
import { useResource } from './lib/resource'
import type { ExceptionsResponse, Period, RegistryResponse, RunsDrill } from './lib/types'
import { pref, readParam, savePref, writeParams } from './lib/url'
import { AutomationRail } from './overview/AutomationRail'
import { OverviewMode } from './overview/OverviewMode'
import { MODES, StudioContext, type Mode, type Studio } from './studio-context'
import './studio4.css'
import './canvas4.css'

const CanvasMode = lazy(() => import('./canvas-mode/CanvasMode').then((m) => ({ default: m.CanvasMode })))
const LiveMode = lazy(() => import('./live/LiveMode').then((m) => ({ default: m.LiveMode })))
const RunsMode = lazy(() => import('./runs/RunsMode').then((m) => ({ default: m.RunsMode })))
const ActivityMode = lazy(() => import('./activity/ActivityMode').then((m) => ({ default: m.ActivityMode })))
const AnalyticsMode = lazy(() => import('./analytics/AnalyticsMode').then((m) => ({ default: m.AnalyticsMode })))
const CreateWorkflow = lazy(() => import('./author/CreateWorkflow').then((m) => ({ default: m.CreateWorkflow })))

const isMode = (v: string | null): v is Mode => Boolean(v && MODES.some((m) => m.id === v))
const isPeriod = (v: string | null): v is Period => v === '24h' || v === '7d' || v === '30d'

/**
 * WORKFLOW STUDIO 4.0 — DESKTOP. The automation nervous system of LeadCommand.
 *
 *   Overview   the automation architecture: real system topology, exceptions, runtime health
 *   Canvas     one workflow as a spatial board — sections, semantic zoom, inspector, run focus + replay
 *   Live       the board animating REAL execution (one pulse per recorded traversal) + running now
 *   Runs       the run ledger (grid) → run inspector + path preview
 *   Activity   system-wide event history, grouped (never 100 rows for one burst)
 *   Analytics  how well automation runs — defined automation rate, interventions, latency, branches
 *
 * Studio workflows are authored on their canvas (validate · simulate · version
 * · publish · arm · pause); system workflows are read-only topology. Every
 * figure is read from the owning runtime's ledger.
 */
export function WorkflowStudioDesktop() {
  const still = useLcReducedMotion()
  const root = useRef<HTMLDivElement | null>(null)
  const [mode, setModeState] = useState<Mode>(() => (isMode(readParam('mode')) ? (readParam('mode') as Mode) : 'overview'))
  const [wfKey, setWfKey] = useState<string>(() => readParam('wf') || 'seller_inbound')
  const [runId, setRunId] = useState<string | null>(() => readParam('run'))
  const [nodeKey, setNodeKey] = useState<string | null>(() => readParam('node'))
  const [period, setPeriodState] = useState<Period>(() => (isPeriod(readParam('period')) ? (readParam('period') as Period) : '7d'))
  const [drill, setDrill] = useState<RunsDrill | null>(null)
  const [width, setWidth] = useState(0)
  const [focused, setFocused] = useState(false)
  const [railPref, setRailPref] = useState<boolean | null>(() => pref<boolean | null>('rail.open', null))
  const [railW, setRailW] = useState<number>(() => pref('rail.w', 272))

  const registry = useResource<RegistryResponse>('registry', (s) => fetchRegistry(s), { interval: 30_000 })
  const exceptions = useResource<ExceptionsResponse>('exceptions', (s) => fetchExceptions(s), { interval: 30_000 })

  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const narrow = width > 0 && width < 1180
  // the rail yields first: shown by default only on a wide pane; an explicit choice is remembered
  const railShown = width >= 900 && (railPref ?? width >= 1600)

  const setMode = useCallback((m: Mode) => { setModeState(m); writeParams({ mode: m === 'overview' ? null : m }) }, [])
  const setWorkflow = useCallback((k: string) => { setWfKey(k); setRunId(null); setNodeKey(null); writeParams({ wf: k, run: null, node: null }) }, [])
  const setRun = useCallback((id: string | null) => { setRunId(id); writeParams({ run: id }) }, [])
  const setNode = useCallback((k: string | null) => { setNodeKey(k); writeParams({ node: k }) }, [])
  const setPeriod = useCallback((p: Period) => { setPeriodState(p); writeParams({ period: p === '7d' ? null : p }) }, [])
  const openRun = useCallback((wf: string, run: string, node?: string | null) => {
    setWfKey(wf); setRunId(run); setNodeKey(node ?? null); setModeState('canvas')
    writeParams({ mode: 'canvas', wf, run, node: node ?? null })
  }, [])
  const openRuns = useCallback((wf: string, d: RunsDrill | null) => {
    setWfKey(wf); setRunId(null); setNodeKey(null); setDrill(d); if (d?.period) setPeriodState(d.period); setModeState('runs')
    writeParams({ mode: 'runs', wf, run: null, node: null, period: d?.period && d.period !== '7d' ? d.period : null })
  }, [])

  const workflows = useMemo(() => registry.data?.workflows ?? [], [registry.data])
  const studio: Studio = useMemo(() => ({
    mode, setMode, workflows, registry: { ...registry }, exceptions: { ...exceptions }, wfKey, setWorkflow, runId, nodeKey, setRun, setNode,
    period, setPeriod, openRun, openRuns, drill, setDrill, still, narrow, width,
  }), [mode, setMode, workflows, registry, exceptions, wfKey, setWorkflow, runId, nodeKey, setRun, setNode, period, setPeriod, openRun, openRuns, drill, still, narrow, width])

  // keys are claimed only while the studio has focus, so other panes keep theirs
  useClaimedKeys(['1', '2', '3', '4', '5', '6'], focused)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return
    const m = MODES.find((x) => x.key === e.key)
    if (m) { e.preventDefault(); setMode(m.id) }
  }

  // rail resize (pointer + keyboard), remembered locally
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: railW } }
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) setRailW(Math.round(Math.min(380, Math.max(220, drag.current.w + e.clientX - drag.current.x)))) }
  const onGripUp = () => { if (drag.current) { drag.current = null; savePref('rail.w', railW) } }
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16
    const next = e.key === 'ArrowLeft' ? railW - step : e.key === 'ArrowRight' ? railW + step : null
    if (next !== null) { e.preventDefault(); const v = Math.min(380, Math.max(220, next)); setRailW(v); savePref('rail.w', v) }
  }
  const [creating, setCreating] = useState(false)
  const toggleRail = () => { const next = !railShown; setRailPref(next); savePref('rail.open', next) }

  const excByWf = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of exceptions.data?.items || []) m[it.workflow_key] = (m[it.workflow_key] || 0) + 1
    return m
  }, [exceptions.data])
  const t = registry.data?.telemetry
  const modeItems = MODES.map((m) => ({ id: m.id, label: m.label, count: m.id === 'live' && t?.executing_now ? t.executing_now : null, tone: m.id === 'live' ? ('exec' as const) : undefined }))

  return (
    <StudioContext.Provider value={studio}>
      <div
        ref={root}
        className={`ws4${still ? ' is-still' : ''}${railShown ? ' has-rail' : ''}`}
        data-mode={mode}
        data-testid="workflow-studio-desktop"
        style={{ ['--ws4-rail-w' as string]: `${railW}px` }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}
      >
        <header className="ws4-head">
          <div className="ws4-head__id">
            <LCIconButton icon="layout-split" label={railShown ? 'Hide the automation rail' : 'Show the automation rail'} size="sm" selected={railShown} onClick={toggleRail} disabled={width > 0 && width < 900} />
            <h1>Workflow Studio</h1>
          </div>
          <Telemetry registry={registry.data} exceptions={exceptions.data} at={registry.at} error={registry.error} stale={registry.stale} onMode={setMode} />
          <LCTabs items={modeItems} value={mode} onChange={setMode} label="Studio mode" className="ws4-modes" />
        </header>
        <div className="ws4-body">
          {railShown ? (
            <div className="ws4-railwrap">
              {registry.data ? <AutomationRail workflows={workflows} selected={wfKey} onSelect={(k) => { setWorkflow(k); if (mode === 'overview') return }} exceptionsByWorkflow={excByWf} onCollapse={toggleRail} onCreate={() => setCreating(true)} /> : registry.error ? <p className="ws4-quiet is-error">The workflow registry could not be read — {registry.error}</p> : <LCSkeleton shape="rows" count={9} label="Reading the automation registry" />}
              <div className="ws4-railwrap__grip lc-resize-x" role="separator" aria-orientation="vertical" aria-label="Resize the automation rail" aria-valuenow={railW} aria-valuemin={220} aria-valuemax={380} tabIndex={0} onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} onKeyDown={onGripKey} onDoubleClick={() => { setRailW(272); savePref('rail.w', 272) }} />
            </div>
          ) : null}
          {creating ? <Suspense fallback={null}><CreateWorkflow open={creating} onOpenChange={setCreating} onCreated={(k) => { registry.reload(); setWorkflow(k); setMode('canvas') }} /></Suspense> : null}
          <main className="ws4-main" id="ws4-main">
            {mode === 'overview' ? <OverviewMode /> : null}
            <Suspense fallback={<div className="ws4-loading"><LCSkeleton shape="chart" height={320} label="Opening" /></div>}>
              {mode === 'canvas' ? <CanvasMode /> : null}
              {mode === 'live' ? <LiveMode /> : null}
              {mode === 'runs' ? <RunsMode /> : null}
              {mode === 'activity' ? <ActivityMode /> : null}
              {mode === 'analytics' ? <AnalyticsMode /> : null}
            </Suspense>
          </main>
        </div>
      </div>
    </StudioContext.Provider>
  )
}

/** LIVE HEADER — the first-frame answers: what is live, what runs now, what needs a person, are the runtimes healthy. */
function Telemetry({ registry, exceptions, at, error, stale, onMode }: { registry: RegistryResponse | null; exceptions: ExceptionsResponse | null; at: number | null; error: string | null; stale: boolean; onMode: (m: Mode) => void }) {
  if (!registry) return <div className="ws4-telemetry">{error ? <span className="is-error"><Icon name="alert" size={12} />Runtimes could not be read — {error}</span> : <span className="ws4-telemetry__skel" />}</div>
  const t = registry.telemetry
  const beats = registry.runtimes || []
  const degraded = beats.filter((b) => b.state === 'stale' && !b.switched_off).length
  const current = beats.filter((b) => !b.external && b.state === 'current' && !b.switched_off).length
  const off = beats.filter((b) => b.switched_off).length
  const needs = exceptions ? exceptions.total : t.needs_you
  const byWf = Object.entries(t.by_workflow_today || {}).sort((a, b) => b[1] - a[1])
  const names = new Map(registry.workflows.map((w) => [w.workflow_key, w.short_name]))
  return (
    <div className="ws4-telemetry" aria-live="polite">
      <LCLive live={!error || Boolean(registry)} stale={stale} updatedAt={at} />
      <button type="button" className="ws4-tm" onClick={() => onMode('overview')}><b className="lc-num">{count(t.live_automations)}</b><span>automations live</span></button>
      <button type="button" className={`ws4-tm${t.executing_now ? ' is-exec' : ''}`} onClick={() => onMode('live')} title="Runs with runtime evidence of work in progress right now"><b className="lc-num">{count(t.executing_now ?? 0)}</b><span>executing now</span></button>
      <button type="button" className="ws4-tm" onClick={() => onMode('live')} title="Scheduled, healthy waits (queued sends, studio waits)"><b className="lc-num">{count(t.waiting_now ?? 0)}</b><span>waiting</span></button>
      <button type="button" className={`ws4-tm${needs ? ' is-needs' : ''}`} onClick={() => onMode('overview')}><b className="lc-num">{count(needs)}</b><span>need you</span></button>
      <button type="button" className={`ws4-tm${degraded ? ' is-crit' : ''}`} onClick={() => onMode('overview')} title="Each runtime’s own heartbeat">
        <b className="lc-num">{degraded ? count(degraded) : count(current)}</b><span>{degraded ? 'runtimes degraded' : `runtimes current${off ? ` · ${off} off` : ''}`}</span>
      </button>
      <LCHoverCard side="bottom" align="end" width={300} trigger={
        <button type="button" className="ws4-tm" onClick={() => onMode('activity')}><b className="lc-num">{count(t.runs_today ?? t.events_today)}</b><span>runs today</span></button>
      }>
        <div className="ws4-hover">
          <p className="lc-eyebrow">Runs today · by workflow</p>
          <ul>{byWf.map(([k, n]) => <li key={k}><span>{names.get(k) || k}</span><b className="lc-num">{count(n)}</b></li>)}</ul>
          {t.campaign_passes_today ? <p className="ws4-note">{count(t.campaign_passes_today)} are campaign scheduler passes — {count(t.campaign_passes_placed_today ?? 0)} placed rows; the rest found their targets blocked.</p> : null}
          <p className="ws4-note">Local day. Test fixtures never count.</p>
        </div>
      </LCHoverCard>
    </div>
  )
}
