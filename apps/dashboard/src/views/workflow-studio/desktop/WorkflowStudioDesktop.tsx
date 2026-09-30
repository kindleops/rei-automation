import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { fetchActivity, fetchNeedsYou, fetchRegistry, fetchWorkflow } from './observatory-api'
import type { ActivityGroup, NeedsYouItem, Period, RegistryEntry } from './observatory-types'
import type { Drill } from './runs/RunsMode'
import { CanvasMode } from './canvas/CanvasMode'
import { LibraryRail } from './overview/LibraryRail'
import { MiniLiveGraph } from './overview/MiniLiveGraph'
import { LiveActivity, NeedsYouRail } from './overview/NeedsYouRail'
import { readParam, usePoll, useReducedMotion } from './use-studio-data'
import { ago } from '../mobile/workflow-format'
import './canvas/canvas.css'
import './studio3.css'

const LiveMode = lazy(() => import('./live/LiveMode').then((m) => ({ default: m.LiveMode })))
const RunsMode = lazy(() => import('./runs/RunsMode').then((m) => ({ default: m.RunsMode })))
const ActivityMode = lazy(() => import('./activity/ActivityMode').then((m) => ({ default: m.ActivityMode })))
const AnalyticsMode = lazy(() => import('./analytics/AnalyticsMode').then((m) => ({ default: m.AnalyticsMode })))
const DesignMode = lazy(() => import('./design/DesignMode').then((m) => ({ default: m.DesignMode })))

export type Mode = 'overview' | 'canvas' | 'live' | 'runs' | 'activity' | 'analytics' | 'design'
const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'canvas', label: 'Canvas' }, { id: 'live', label: 'Live' },
  { id: 'runs', label: 'Runs' }, { id: 'activity', label: 'Activity' }, { id: 'analytics', label: 'Analytics' },
]

const isMode = (v: string | null): v is Mode => Boolean(v && [...MODES.map((m) => m.id), 'design'].includes(v as Mode))

/** Write the studio's own URL state — only while the studio owns the window URL (never another pane's). */
function writeParams(patch: Record<string, string | null>) {
  try {
    if (!window.location.pathname.startsWith('/workflow-studio')) return
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(patch)) { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k) }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
  } catch { /* best effort */ }
}

/**
 * WORKFLOW STUDIO 3.0 — DESKTOP. The visual nervous system of LeadCommand.
 *   Overview   the first frame says THIS IS AUTOMATION: library, a live
 *              pipeline, what needs you, what just happened
 *   Canvas     the crown jewel — a spatial board of any workflow
 *   Live       real execution overlaid on the board
 *   Runs       the run ledger + inspector + replay
 *   Activity   domain events grouped per run
 *   Analytics  runs, resolution, bottlenecks, versions — every chart drills to runs
 *   Design     studio workflows only (system workflows stay read-only)
 * Every figure is read from the owning runtime's ledger; nothing is simulated
 * unless it says SIMULATION.
 */
export function WorkflowStudioDesktop() {
  const [mode, setModeState] = useState<Mode>(() => (isMode(readParam('mode')) ? (readParam('mode') as Mode) : 'overview'))
  const [wfKey, setWfKey] = useState<string>(() => readParam('wf') || 'seller_inbound')
  const [runId, setRunId] = useState<string | null>(() => readParam('run'))
  const [nodeKey, setNodeKey] = useState<string | null>(() => readParam('node'))
  const [period, setPeriod] = useState<Period>(() => (['24h', '7d', '30d'].includes(readParam('period') || '') ? (readParam('period') as Period) : '7d'))
  const still = useReducedMotion()
  const [drill, setDrill] = useState<Drill | null>(null)

  const registry = usePoll((s) => fetchRegistry(s), [], 30_000)
  const needs = usePoll((s) => fetchNeedsYou(s), [], 30_000)

  const setMode = useCallback((m: Mode) => { setModeState(m); writeParams({ mode: m === 'overview' ? null : m }) }, [])
  const setWorkflow = useCallback((k: string) => { setWfKey(k); setRunId(null); setNodeKey(null); writeParams({ wf: k, run: null, node: null }) }, [])
  const setRun = useCallback((id: string | null) => { setRunId(id); writeParams({ run: id }) }, [])
  const setNode = useCallback((k: string | null) => { setNodeKey(k); writeParams({ node: k }) }, [])
  const setPer = useCallback((p: Period) => { setPeriod(p); writeParams({ period: p === '7d' ? null : p }) }, [])

  /** Open a run anywhere: the canvas, centred on the node that holds it. */
  const openRun = useCallback((wf: string, run: string, node: string | null) => {
    setWfKey(wf); setRunId(run); setNodeKey(node); setModeState('canvas')
    writeParams({ mode: 'canvas', wf, run, node })
  }, [])

  const workflows = registry.data?.workflows || []
  const t = registry.data?.telemetry
  const selected = workflows.find((w) => w.workflow_key === wfKey) || null
  const canDesign = selected?.kind === 'studio' && selected.status !== 'not_running'

  useEffect(() => {
    if (mode === 'design' && selected && !canDesign) setMode('canvas')
  }, [canDesign, mode, selected, setMode])

  return (
    <div className={`ws3${still ? ' is-still' : ''}`} data-mode={mode} data-testid="workflow-studio-desktop">
      <header className="ws3-head">
        <div className="ws3-head__title">
          <h1>Workflow Studio</h1>
          <p className="ws3-spec" aria-live="polite">
            {t ? (
              <>
                <span><b>{t.in_flight}</b> in flight</span>
                <span className={t.needs_you ? 'is-needs' : ''}><b>{t.needs_you}</b> need you</span>
                <span><b>{t.live_automations}</b> live automations</span>
                <span><b>{t.events_today}</b> runs today</span>
              </>
            ) : registry.error ? <span className="is-error">Runtimes could not be read — {registry.error}</span> : <span className="ws3-skel-text" />}
          </p>
        </div>
        <nav className="ws3-modes" role="tablist" aria-label="Studio mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'is-on' : ''} onClick={() => setMode(m.id)}>
              {m.label}{m.id === 'live' ? <i className="ws3-livedot" aria-hidden /> : null}
            </button>
          ))}
          {canDesign ? <button type="button" role="tab" aria-selected={mode === 'design'} className={`is-design${mode === 'design' ? ' is-on' : ''}`} onClick={() => setMode('design')}><Icon name="spark" />Design</button> : null}
        </nav>
        <div className="ws3-head__side">
          <span className="ws3-fresh" title="Read from each runtime's own ledger">{registry.at ? `Updated ${ago(new Date(registry.at).toISOString())}` : 'Reading…'}</span>
        </div>
      </header>

      <main className="ws3-main">
        {mode === 'overview' ? (
          <OverviewMode
            workflows={workflows}
            loading={registry.loading}
            error={registry.error}
            selected={wfKey}
            onSelect={setWorkflow}
            needs={needs.data?.items || []}
            needsTotal={needs.data?.total || 0}
            needsLoading={needs.loading}
            needsError={needs.error}
            still={still}
            onOpenCanvas={(node) => { if (node) setNode(node); setMode('canvas') }}
            onOpenRun={openRun}
          />
        ) : null}
        {mode === 'canvas' ? (
          <CanvasMode workflows={workflows} wfKey={wfKey} onWorkflow={setWorkflow} period={period} onPeriod={setPer} nodeKey={nodeKey} onNode={setNode} runId={runId} onRun={setRun} still={still} onOpenRun={openRun} onRunsThrough={(node, label) => { setDrill({ node, label: `Through ${label}` }); setMode('runs') }} />
        ) : null}
        <Suspense fallback={<div className="ws3-loading"><i className="ws3-spin" />Opening…</div>}>
          {mode === 'live' ? <LiveMode workflows={workflows} wfKey={wfKey} onWorkflow={setWorkflow} still={still} onOpenRun={openRun} /> : null}
          {mode === 'runs' ? <RunsMode workflows={workflows} wfKey={wfKey} onWorkflow={setWorkflow} period={period} onPeriod={setPer} still={still} onOpenRun={openRun} drill={drill} onDrill={setDrill} /> : null}
          {mode === 'activity' ? <ActivityMode workflows={workflows} onOpenRun={openRun} /> : null}
          {mode === 'analytics' ? <AnalyticsMode workflows={workflows} wfKey={wfKey} onWorkflow={setWorkflow} period={period} onPeriod={setPer} onOpenRun={openRun} onDrill={(f) => { setDrill(f); setMode('runs') }} /> : null}
          {mode === 'design' && canDesign ? <DesignMode workflow={selected!} onDone={() => { void registry.reload(); setMode('canvas') }} /> : null}
        </Suspense>
      </main>
    </div>
  )
}

/* ── OVERVIEW ─────────────────────────────────────────────────────────────── */

function OverviewMode({ workflows, loading, error, selected, onSelect, needs, needsTotal, needsLoading, needsError, still, onOpenCanvas, onOpenRun }: {
  workflows: RegistryEntry[]
  loading: boolean
  error: string | null
  selected: string
  onSelect: (k: string) => void
  needs: NeedsYouItem[]
  needsTotal: number
  needsLoading: boolean
  needsError: string | null
  still: boolean
  onOpenCanvas: (node: string | null) => void
  onOpenRun: (wf: string, run: string, node: string | null) => void
}) {
  const detail = usePoll((s) => fetchWorkflow(selected, '24h', s), [selected], 30_000)
  const activity = usePoll((s) => fetchActivity({ hours: 24, limit: 40 }, s), [], 20_000)
  const wf = workflows.find((w) => w.workflow_key === selected) || null
  const arrivals = useMemo(() => (activity.data?.groups || []).filter((g) => g.workflow_key === selected).slice(0, 6).map((g) => ({ run_id: g.run_id, node_key: g.focus_node })), [activity.data, selected])
  const openActivity = (g: ActivityGroup) => onOpenRun(g.workflow_key, g.run_id, g.focus_node)
  // an ultrawide desk shows the whole real topology on the first frame
  const shell = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = shell.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= 2600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const openNeed = (it: NeedsYouItem) => (it.run_id.startsWith('queue:') ? (it.href ? pushRoutePath(it.href) : undefined) : onOpenRun(it.workflow_key, it.run_id, it.node_key))
  return (
    <div className={`ws3-overview${wide ? ' is-wide' : ''}`} ref={shell}>
      <aside className="ws3-overview__lib">
        {loading && !workflows.length ? <div className="ws3-skel-rows is-lib" aria-busy="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} />)}</div> : null}
        {error && !workflows.length ? <p className="ws3-quiet is-error">The workflow registry could not be read — {error}.</p> : null}
        {workflows.length ? <LibraryRail workflows={workflows} selected={selected} onSelect={onSelect} /> : null}
      </aside>
      <div className="ws3-overview__mini">
        <MiniLiveGraph
          workflow={detail.data?.workflow || wf}
          topology={detail.data?.topology || null}
          telemetry={detail.data?.telemetry || null}
          arrivals={arrivals}
          still={still}
          onOpenCanvas={() => onOpenCanvas(null)}
          onOpenNode={(k) => onOpenCanvas(k)}
          wide={wide}
        />
        {detail.error && !detail.data ? <p className="ws3-quiet is-error">{wf?.name || 'This workflow'} could not be read — {detail.error}.</p> : null}
      </div>
      <div className="ws3-overview__act"><LiveActivity groups={activity.data?.groups || []} loading={activity.loading} error={activity.error} onOpen={openActivity} limit={30} /></div>
      <aside className="ws3-overview__needs">
        <NeedsYouRail items={needs} total={needsTotal} loading={needsLoading} error={needsError} onOpen={openNeed} />
      </aside>
    </div>
  )
}
