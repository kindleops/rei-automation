import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCError, LCIconButton, LCSearch, LCSegmented, LCSelect, LCSkeleton, LCTooltip } from '../../../../shared/lc'
import { useClaimedKeys } from '../../../../shared/lc/keys'
import type { GraphCanvasApi } from '../canvas/GraphCanvas'
import { branchOf, layoutTopology, type Direction } from '../canvas/layout'
import { useTraversalPulses } from '../canvas/pulses'
import type { Tier } from '../canvas/usePanZoom'
import { WorkflowBoard } from '../canvas/WorkflowBoard'
import type { Metric } from '../canvas/WorkflowNode'
import { fetchCatalog, fetchRun, fetchWorkflow, type StudioCatalog } from '../lib/api'
import { count } from '../lib/format'
import { useResource } from '../lib/resource'
import type { LiveResponse, Period, RunDetailResponse, WorkflowDetailResponse } from '../lib/types'
import { pref, savePref } from '../lib/url'
import { replayStepsOf, useReplay } from '../runs/replay'
import { sound } from '../../../../shared/sound'
import { findWorkflow, useStudio } from '../studio-context'
import { EdgeInspector } from './EdgeInspector'
import { liveFetcher, liveOverlayOf } from './live-data'
import { NodeInspector } from './NodeInspector'
import { ReplayBar } from './ReplayBar'
import { RunInspector } from './RunInspector'

const AuthorCanvas = lazy(() => import('../author/AuthorCanvas').then((m) => ({ default: m.AuthorCanvas })))

const PERIODS: Period[] = ['24h', '7d', '30d']
const METRICS: Array<{ value: Metric; label: string }> = [
  { value: 'volume', label: 'Volume' }, { value: 'latency', label: 'Latency' }, { value: 'holds', label: 'Holds' }, { value: 'failures', label: 'Failures' }, { value: 'human', label: 'To a person' },
]
const TIER_WORD: Record<Tier, string> = { far: 'Regions', mid: 'Nodes', near: 'Detail' }
const INSPECTOR_W = 436

/**
 * CANVAS — the workspace. One workflow as a spatial board: sections, semantic
 * zoom, minimap, search, focus, a node / edge / run inspector, LIVE overlay
 * and run replay. Studio workflows switch the same board into the editor.
 */
export function CanvasMode({ liveDefault = false }: { liveDefault?: boolean } = {}) {
  const s = useStudio()
  const wf = s.wfKey
  const workflow = findWorkflow(s.workflows, wf)
  const detail = useResource<WorkflowDetailResponse>(`wf:${wf}:${s.period}`, (sig) => fetchWorkflow(wf, s.period, sig), { interval: 60_000, placeholderKey: `wf:${wf}:${s.period === '7d' ? '24h' : '7d'}` })
  const topology = detail.data?.topology ?? null
  const telemetry = detail.placeholder ? null : detail.data?.telemetry ?? null
  const wfEntry = detail.data?.workflow || workflow
  const canvas = useRef<GraphCanvasApi | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const [metric, setMetric] = useState<Metric>('volume')
  const [direction, setDirection] = useState<Direction>(() => pref('dir', 'LR'))
  const [expandedState, setExpandedState] = useState<{ wf: string; keys: string[] }>({ wf, keys: [] })
  const [edge, setEdge] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [branch, setBranch] = useState(false)
  const [minimap, setMinimap] = useState<boolean>(() => pref('minimap', true))
  const [liveOn, setLiveOn] = useState(liveDefault)
  const [tier, setTier] = useState<Tier>('mid')
  const [editing, setEditing] = useState(false)
  const [full, setFull] = useState(false)

  const runKey = s.runId ? `run:${wf}:${s.runId}` : null
  const runRes = useResource<RunDetailResponse>(runKey, (sig) => fetchRun(wf, s.runId!, sig), { interval: 45_000 })
  const run = runRes.data && runRes.data.run.run_id === s.runId ? runRes.data : null
  const liveKey = liveOn ? `live:${wf}` : null
  const live = useResource<LiveResponse>(liveKey, liveFetcher(wf), { interval: 15_000 })
  const isStudio = wfEntry?.kind === 'studio'
  const catalog = useResource<StudioCatalog>(isStudio ? 'catalog' : null, (sig) => fetchCatalog(sig))

  // selection that lives in a collapsed group opens the group (derived — never an effect)
  const groupOf = useCallback((k: string | null | undefined) => (k ? topology?.nodes.find((n) => n.key === k)?.group || null : null), [topology])
  const selectedNode = s.nodeKey && !s.nodeKey.startsWith('group:') ? s.nodeKey : null
  const selectedGroup = s.nodeKey?.startsWith('group:') ? s.nodeKey.slice(6) : null
  const expanded = useMemo(() => {
    const keys = new Set(expandedState.wf === wf ? expandedState.keys : [])
    for (const g of [groupOf(selectedNode), groupOf(run?.path.focus)]) if (g) keys.add(g)
    return keys
  }, [expandedState, groupOf, run?.path.focus, selectedNode, wf])
  const toggleGroup = useCallback((g: string) => setExpandedState((cur) => {
    const keys = new Set(cur.wf === wf ? cur.keys : [])
    if (keys.has(g)) keys.delete(g); else keys.add(g)
    return { wf, keys: [...keys] }
  }), [wf])

  const layout = useMemo(() => (topology ? layoutTopology(topology, expanded, { direction }) : null), [direction, expanded, topology])
  const ownerOf = useCallback((k: string) => layout?.owner.get(k) || k, [layout])

  // replay over the recorded path
  const steps = useMemo(() => replayStepsOf(run), [run])
  const quality = run?.timing?.quality || 'single'
  const replay = useReplay(run?.run.run_id || null, steps, quality)
  // the camera follows the replay: each revealed step is brought into view (zoom kept)
  const replayAt = replay.active && replay.index ? steps[replay.index - 1]?.node ?? null : null
  useEffect(() => {
    if (!replayAt) return
    const t = window.setTimeout(() => canvas.current?.flyToNode(ownerOf(replayAt), canvas.current.getView().k), 30)
    return () => window.clearTimeout(t)
  }, [ownerOf, replayAt])

  // where the run can go next: out-edges of the node it stopped at (only while it is not finished)
  const next = useMemo(() => {
    if (!run || !topology) return []
    if (['completed', 'cancelled', 'failed'].includes(run.run.status)) return []
    const at = run.run.current_node || run.path.focus
    return at ? topology.edges.filter((e) => e.from === at && !run.path.order.includes(e.to)).map((e) => e.to) : []
  }, [run, topology])

  const focus = useMemo(() => {
    if (!layout) return null
    if (run) return new Set([...run.path.order.map(ownerOf), ...next.map(ownerOf)])
    if (branch && s.nodeKey) return branchOf(layout, ownerOf(s.nodeKey))
    return null
  }, [branch, layout, next, ownerOf, run, s.nodeKey])

  const mapEdge = useCallback((id: string) => layout?.edges.find((e) => e.ids.includes(id))?.id || null, [layout])
  const pulses = useTraversalPulses(liveKey, wf, s.still, mapEdge)
  const liveOverlay = useMemo(() => (liveOn ? liveOverlayOf(live.data, wf, pulses.arrived) : null), [live.data, liveOn, pulses.arrived, wf])

  // centre on the node that holds a run once both the run and the board are ready
  const flown = useRef<string | null>(null)
  useEffect(() => {
    if (!run || !layout) return
    const target = s.nodeKey || run.path.focus
    const id = `${run.run.run_id}:${target}`
    if (!target || flown.current === id) return
    flown.current = id
    const t = window.setTimeout(() => canvas.current?.flyToNode(layout.owner.get(target) || target, 0.92), 80)
    return () => window.clearTimeout(t)
  }, [layout, run, s.nodeKey])

  // canvas opened (a workflow's board) — one cue, never per node or per live event
  useEffect(() => { sound.panel.open() }, [wf])

  const inspecting = Boolean(edge || s.nodeKey || s.runId)
  const insetRight = inspecting ? INSPECTOR_W : 0

  // keys belong to the canvas only while it has focus
  const [focused, setFocused] = useState(false)
  useClaimedKeys(['/', 'f', '0', '+', '=', '-', 'b', 'm', 'l', 't'], focused)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (t.closest('input, textarea, select, [contenteditable="true"], .lc-insp, [role="dialog"]')) {
      if (e.key === 'Escape' && t.closest('.ws4-find')) { e.preventDefault(); setSearch(''); setFindOpen(false); stageRef.current?.querySelector<HTMLElement>('.ws4-stage')?.focus() }
      else if (e.key === 'Escape' && t.tagName === 'INPUT') (t as HTMLInputElement).blur()
      return
    }
    const k = e.key
    const handled = () => { e.preventDefault(); e.stopPropagation() }
    if (k === '/') { handled(); openFind() }
    else if (k === 'f') { handled(); canvas.current?.fit() }
    else if (k === '0') { handled(); canvas.current?.recenter() }
    else if (k === '+' || k === '=') { handled(); canvas.current?.zoomIn() }
    else if (k === '-') { handled(); canvas.current?.zoomOut() }
    else if (k === 'b' && s.nodeKey) { handled(); setBranch((v) => !v) }
    else if (k === 'm') { handled(); setMinimap((v) => { savePref('minimap', !v); return !v }) }
    else if (k === 'l') { handled(); setLiveOn((v) => !v) }
    else if (k === 't') { handled(); flipDirection() }
    else if (k === 'Escape') { if (edge) setEdge(null); else if (s.nodeKey) s.setNode(null); else if (s.runId) s.setRun(null) }
  }

  const flipDirection = () => setDirection((d) => { const n = d === 'LR' ? 'TB' : 'LR'; savePref('dir', n); return n })
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.().catch(() => undefined)
  }

  const openFind = () => { setFindOpen(true); window.setTimeout(() => stageRef.current?.querySelector<HTMLInputElement>('.ws4-find input')?.focus(), 0) }
  const onSearchEnter = () => {
    const needle = search.trim().toLowerCase()
    const hit = needle ? topology?.nodes.find((n) => `${n.label} ${n.summary || ''} ${n.key}`.toLowerCase().includes(needle)) : null
    if (!hit) return
    s.setNode(hit.key)
    window.setTimeout(() => canvas.current?.flyToNode(ownerOf(hit.key), 1.05), 60)
  }
  const selectNode = useCallback((k: string | null) => { setEdge(null); s.setNode(k); if (k) sound.ui.select(); else setBranch(false) }, [s])
  const labelOf = useCallback((k: string) => topology?.nodes.find((n) => n.key === k)?.label || k, [topology])
  const matches = search.trim() ? topology?.nodes.filter((n) => `${n.label} ${n.summary || ''} ${n.key}`.toLowerCase().includes(search.trim().toLowerCase())).length ?? 0 : null
  const canEdit = Boolean(isStudio && wfEntry?.supports.edit && wfEntry.status !== 'not_running')

  if (editing && canEdit && wfEntry) {
    return (
      <Suspense fallback={<div className="ws4-loading"><LCSkeleton shape="chart" height={320} label="Opening the editor" /></div>}>
        <AuthorCanvas workflow={wfEntry} onExit={() => { setEditing(false); s.registry.reload(); detail.reload() }} />
      </Suspense>
    )
  }

  return (
    <div className={`ws4-canvasmode${inspecting ? ' has-insp' : ''}${full ? ' is-full' : ''}`} ref={stageRef} onKeyDown={onKeyDown} onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}>
      <div className="ws4-stage" tabIndex={-1}>
        {topology && layout ? (
          <WorkflowBoard
            key={`${wf}:${direction}`}
            ref={canvas}
            topology={topology}
            layout={layout}
            telemetry={telemetry}
            metric={metric}
            selected={s.nodeKey}
            selectedEdge={edge}
            onSelect={selectNode}
            onEdge={(id) => { s.setNode(null); setEdge(id === edge ? null : id) }}
            onToggleGroup={toggleGroup}
            focus={focus}
            search={search}
            run={run ? { path: run.path, revealed: replay.active ? replay.index : null, next } : null}
            live={liveOverlay}
            pulses={pulses.pulses}
            onPulseDone={pulses.done}
            flashEdges={pulses.flash}
            reducedMotion={s.still}
            viewKey={`canvas:${wf}:${direction}`}
            insetRight={insetRight}
            minimap={minimap}
            onTier={setTier}
            label={`${wfEntry?.name || wf} — workflow canvas`}
          >
            <div className="ws4-tool is-top" data-no-pan>
              <span className="ws4-tool__title">
                <strong>{wfEntry?.name || wf}</strong>
                <small className={isStudio ? 'is-studio' : 'is-system'}>{isStudio ? `Studio workflow · ${wfEntry?.runtime_version || ''} · ${wfEntry?.status === 'armed' ? 'armed' : wfEntry?.status || ''}` : 'System workflow · read-only topology'}</small>
              </span>
              <span className="ws4-tool__grow" />
              <LCSegmented size="sm" className="is-opt" label="Period" value={s.period} onChange={s.setPeriod} options={PERIODS.map((p) => ({ value: p, label: p }))} />
              <LCSelect size="sm" variant="chip" className="is-opt" label="Node figure" prefix="Show" value={metric} onChange={setMetric} options={METRICS} />
              <LCTooltip content="Animate real execution on the board (L)">
                <button type="button" className={`ws4-livetoggle${liveOn ? ' is-on' : ''}`} aria-pressed={liveOn} onClick={() => setLiveOn((v) => !v)}><i aria-hidden />Live</button>
              </LCTooltip>
              {canEdit ? <LCButton size="sm" variant="primary" icon="spark" onClick={() => setEditing(true)}>Edit draft</LCButton> : null}
            </div>
            <div className="ws4-tool is-left" data-no-pan>
              <div className="ws4-toolcol">
                <LCIconButton icon="search" label="Search nodes" shortcut={['/']} size="sm" variant="glass" tooltipSide="right" selected={findOpen || Boolean(search)} onClick={() => { if (findOpen && !search) setFindOpen(false); else openFind() }} />
                <LCIconButton icon="chevron-up" label="Zoom in" shortcut={['+']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.zoomIn()} />
                <LCIconButton icon="chevron-down" label="Zoom out" shortcut={['−']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.zoomOut()} />
                <LCIconButton icon="maximize" label="Fit the workflow" shortcut={['F']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.fit()} />
                <LCIconButton icon="target" label="Recenter" shortcut={['0']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.recenter()} />
                <LCIconButton icon="filter" label="Focus this node's branch" shortcut={['B']} size="sm" variant="glass" tooltipSide="right" selected={branch} disabled={!s.nodeKey} onClick={() => setBranch((v) => !v)} />
                {topology.groups.length ? <LCIconButton icon="layers" label={expanded.size ? 'Collapse grouped steps' : 'Expand every grouped step'} size="sm" variant="glass" tooltipSide="right" selected={expanded.size > 0} onClick={() => setExpandedState({ wf, keys: expanded.size ? [] : topology.groups.map((g) => g.key) })} /> : null}
                <LCIconButton icon="layout-split" label={direction === 'LR' ? 'Lay out top to bottom' : 'Lay out left to right'} shortcut={['T']} size="sm" variant="glass" tooltipSide="right" onClick={flipDirection} />
                <LCIconButton icon="map" label={minimap ? 'Hide the minimap' : 'Show the minimap'} shortcut={['M']} size="sm" variant="glass" tooltipSide="right" selected={minimap} onClick={() => setMinimap((v) => { savePref('minimap', !v); return !v })} />
                <LCIconButton icon={full ? 'close' : 'external-link'} label={full ? 'Leave focus view' : 'Focus view (fullscreen)'} size="sm" variant="glass" tooltipSide="right" onClick={toggleFull} />
              </div>
              {findOpen || search ? (
                <div className="ws4-find" onBlur={(e) => { if (!search.trim() && !e.currentTarget.contains(e.relatedTarget as Node | null)) setFindOpen(false) }}>
                  <LCSearch value={search} onChange={setSearch} label="Search nodes" placeholder="Search nodes" hint="esc" onSubmit={onSearchEnter} />
                  {matches !== null ? <span className="ws4-find__count lc-t-meta">{matches} match{matches === 1 ? '' : 'es'}{matches ? ' · ↵ to fly' : ''}</span> : null}
                </div>
              ) : null}
            </div>
            {run && steps.length ? (
              <div className="ws4-tool is-bottom-center" data-no-pan>
                <ReplayBar replay={replay} steps={steps} quality={quality} note={run.timing?.note} labelOf={labelOf} />
              </div>
            ) : null}
            <footer className="ws4-tool is-bottom" data-no-pan>
              <span className="ws4-zoomword">{TIER_WORD[tier]}</span>
              <StatusLine detail={detail.data} placeholder={detail.placeholder} period={s.period} stale={detail.stale} live={liveOn ? live.data : null} liveError={liveOn ? live.error : null} />
            </footer>
          </WorkflowBoard>
        ) : (
          <div className="ws4-board is-empty" aria-busy={detail.loading}>
            {detail.error ? <LCError what={`${workflow?.name || 'This workflow'} could not be read`} detail={`${detail.error}. Nothing is drawn rather than a guess.`} onRetry={detail.reload} /> : <LCSkeleton shape="chart" height={360} label={`Reading ${workflow?.name || 'the workflow'} from its runtime`} />}
          </div>
        )}
        {topology && wfEntry && edge ? (
          <EdgeInspector topology={topology} workflow={wfEntry} telemetry={telemetry} edgeId={edge} period={s.period} onClose={() => setEdge(null)} onNode={(k) => { setEdge(null); s.setNode(k); window.setTimeout(() => canvas.current?.flyToNode(ownerOf(k)), 40) }} />
        ) : topology && wfEntry && s.nodeKey && (selectedNode || selectedGroup) ? (
          <NodeInspector
            topology={topology}
            workflow={wfEntry}
            telemetry={telemetry}
            nodeKey={selectedNode}
            groupKey={selectedGroup}
            period={s.period}
            run={run}
            live={liveOverlay ? { executing: liveOverlay.executing[s.nodeKey] || 0, parked: liveOverlay.parked[s.nodeKey] || 0 } : null}
            catalog={catalog.data}
            onClose={() => s.setNode(null)}
            onNode={(k) => { s.setNode(k); window.setTimeout(() => canvas.current?.flyToNode(ownerOf(k)), 40) }}
            onOpenWorkflow={(k) => s.setWorkflow(k)}
            onToggleGroup={toggleGroup}
            expanded={expanded}
            back={s.runId ? { label: 'Back to the run', onBack: () => s.setNode(null) } : undefined}
          />
        ) : s.runId ? (
          <RunInspector run={run} error={runRes.error} loading={runRes.loading} topology={topology} workflow={wfEntry} next={next} onClose={() => { s.setRun(null); s.setNode(null) }} onNode={(k) => { s.setNode(k); window.setTimeout(() => canvas.current?.flyToNode(ownerOf(k)), 40) }} onRetry={runRes.reload} />
        ) : null}
      </div>
    </div>
  )
}

function StatusLine({ detail, placeholder, period, stale, live, liveError }: { detail: WorkflowDetailResponse | null; placeholder: boolean; period: Period; stale: boolean; live: LiveResponse | null; liveError: string | null }) {
  const t = detail?.telemetry
  if (!detail) return null
  return (
    <span className="ws4-tool__spec">
      {placeholder ? <span className="is-note">Showing the topology while the {period} telemetry reads</span> : t ? <span>{count(t.runs.total)} runs · {t.period}{t.runs.needs_you ? ` · ${t.runs.needs_you} need you` : ''}{t.runs.held ? ` · ${t.runs.held} held` : ''}{t.runs.failed ? ` · ${t.runs.failed} failed` : ''}</span> : null}
      {stale ? <span className="is-note"><Icon name="clock" size={11} />stale — the latest read failed</span> : null}
      {live ? <span className="is-live">Live · {live.active.filter((a) => a.workflow_key === detail.workflow.workflow_key).length} active · read every {Math.round(live.cadence_ms / 1000)} s</span> : liveError ? <span className="is-note">Live read failed — {liveError}</span> : null}
      {t?.notes?.[0] ? <span className="is-note">{t.notes[0]}</span> : null}
    </span>
  )
}
