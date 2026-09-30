import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { fetchRun, fetchWorkflow } from '../observatory-api'
import type { Period, RegistryEntry, RunDetailResponse } from '../observatory-types'
import { LibraryRail } from '../overview/LibraryRail'
import { usePoll } from '../use-studio-data'
import type { Overlay } from './CanvasNode'
import { NodeInspector } from './NodeInspector'
import { RunPanel } from './RunPanel'
import { ReplayBar, useReplay } from '../runs/Replay'
import { StudioCanvas, type CanvasApi, type RunOverlay } from './StudioCanvas'
import type { Tier } from './usePanZoom'

const PERIODS: Period[] = ['24h', '7d', '30d']
const OVERLAYS: Array<{ id: Overlay; label: string }> = [
  { id: 'volume', label: 'Volume' }, { id: 'latency', label: 'Latency' }, { id: 'holds', label: 'Holds' }, { id: 'failures', label: 'Failures' }, { id: 'human', label: 'Human review' },
]
const TIER_WORD: Record<Tier, string> = { far: 'Topology', mid: 'Labels', near: 'Detail' }

/**
 * CANVAS — the crown jewel. A large spatial board of one workflow: pan, zoom,
 * fit, search a node, focus a branch, expand a group, go fullscreen; a node
 * opens the inspector, a run lights its executed path and centres on the node
 * that decided it.
 */
export function CanvasMode({ workflows, wfKey, onWorkflow, period, onPeriod, nodeKey, onNode, runId, onRun, still, onOpenRun, onRunsThrough }: {
  workflows: RegistryEntry[]
  wfKey: string
  onWorkflow: (k: string) => void
  period: Period
  onPeriod: (p: Period) => void
  nodeKey: string | null
  onNode: (k: string | null) => void
  runId: string | null
  onRun: (id: string | null) => void
  still: boolean
  onOpenRun: (wf: string, run: string, node: string | null) => void
  onRunsThrough?: (node: string, label: string) => void
}) {
  const detail = usePoll((s) => fetchWorkflow(wfKey, period, s), [wfKey, period], 60_000)
  const [run, setRun] = useState<RunDetailResponse | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focusBranch, setFocusBranch] = useState(false)
  const [search, setSearch] = useState('')
  const [overlay, setOverlay] = useState<Overlay>('volume')
  const [tier, setTier] = useState<Tier>('mid')
  // the board gets the width on a laptop; the library rail is one click away
  const [libOpen, setLibOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1700)
  const [full, setFull] = useState(false)
  const canvas = useRef<CanvasApi | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const topology = detail.data?.topology || null
  const telemetry = detail.data?.telemetry || null
  const workflow = detail.data?.workflow || workflows.find((w) => w.workflow_key === wfKey) || null

  useEffect(() => { setExpanded(new Set()); setFocusBranch(false); setSearch('') }, [wfKey])

  // a run deep link: load it, light its path, centre on the node that decided it
  useEffect(() => {
    if (!runId) { setRun(null); setRunErr(null); return }
    const ac = new AbortController()
    setRunErr(null)
    fetchRun(wfKey, runId, ac.signal).then((r) => {
      setRun(r)
      const focus = nodeKey || r.path.focus
      if (focus) {
        const g = topology?.nodes.find((n) => n.key === focus)?.group
        if (g) setExpanded((cur) => new Set([...cur, g]))
        onNode(focus)
        window.setTimeout(() => canvas.current?.flyToNode(focus, 0.95), 60)
      }
    }).catch((e) => { if (e?.name !== 'AbortError') setRunErr(e?.message || 'unavailable') })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, wfKey, topology?.topology_version])

  const replay = useReplay(run?.path.order.length ?? 0)
  const runOverlay: RunOverlay | null = useMemo(() => (run ? { nodes: run.path.nodes, edges: run.path.edges, focus: run.path.focus, order: run.path.order, revealed: replay.active ? replay.index ?? undefined : undefined } : null), [run, replay.active, replay.index])
  const replayNode = run && replay.active && replay.index ? topology?.nodes.find((n) => n.key === run.path.order[replay.index! - 1])?.label || null : null
  const selectedNode = nodeKey && !nodeKey.startsWith('group:') ? nodeKey : null
  const selectedGroup = nodeKey?.startsWith('group:') ? nodeKey.slice(6) : null
  const toggleGroup = useCallback((g: string) => setExpanded((cur) => { const n = new Set(cur); if (n.has(g)) n.delete(g); else n.add(g); return n }), [])

  // keyboard: / search · f fit · + − zoom · b focus branch · esc clear
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { if (e.key === 'Escape') (t as HTMLInputElement).blur(); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'f' || e.key === '0') canvas.current?.fit()
      else if (e.key === '+' || e.key === '=') canvas.current?.zoomIn()
      else if (e.key === '-') canvas.current?.zoomOut()
      else if (e.key === 'b' && nodeKey) setFocusBranch((v) => !v)
      else if (e.key === 'Escape') { if (runId) onRun(null); else onNode(null); setFocusBranch(false) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [nodeKey, onNode, onRun, runId])

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === stage.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => {
    const el = stage.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else if (el.requestFullscreen) void el.requestFullscreen().catch(() => setFull((v) => !v))
    else setFull((v) => !v)
  }

  const onSearchEnter = () => {
    const l = canvas.current?.layout()
    const needle = search.trim().toLowerCase()
    if (!l || !needle) return
    const hit = topology?.nodes.find((n) => `${n.label} ${n.summary || ''} ${n.key}`.toLowerCase().includes(needle))
    if (!hit) return
    if (hit.group && !expanded.has(hit.group)) setExpanded((cur) => new Set([...cur, hit.group!]))
    onNode(hit.key)
    window.setTimeout(() => canvas.current?.flyToNode(hit.key, 1.05), 60)
  }

  const inspecting = Boolean(run || selectedNode || selectedGroup)
  const allGroups = topology?.groups || []

  return (
    <div className={`ws3-canvasmode${libOpen ? ' has-lib' : ''}${inspecting ? ' has-insp' : ''}${full ? ' is-full' : ''}`}>
      {libOpen ? <LibraryRail workflows={workflows} selected={wfKey} onSelect={(k) => { onRun(null); onNode(null); onWorkflow(k) }} compact /> : null}
      <div className="ws3-stage" ref={stage}>
        {topology ? (
          <StudioCanvas
            ref={canvas}
            topology={topology}
            telemetry={telemetry}
            expanded={expanded}
            selected={nodeKey}
            onSelect={(k) => onNode(k)}
            onToggleGroup={toggleGroup}
            focusBranch={focusBranch}
            search={search}
            overlay={overlay}
            run={runOverlay}
            reducedMotion={still}
            onTier={setTier}
          />
        ) : (
          <div className="ws3-board is-empty" aria-busy={detail.loading}>
            {detail.error ? <p className="ws3-quiet is-error">This workflow could not be read — {detail.error}. Nothing is drawn rather than a guess.</p> : <p className="ws3-quiet"><i className="ws3-spin" />Reading {workflow?.name || 'the workflow'} from its runtime…</p>}
          </div>
        )}

        <header className="ws3-tool is-top" data-no-pan>
          <button type="button" className="ws3-iconbtn" onClick={() => setLibOpen((v) => !v)} aria-label={libOpen ? 'Hide library' : 'Show library'} title="Library"><Icon name="layout-split" /></button>
          <span className="ws3-tool__title">
            <strong>{workflow?.name || '—'}</strong>
            <small>{topology?.badge || (workflow?.kind === 'studio' ? 'STUDIO WORKFLOW' : 'SYSTEM WORKFLOW')}</small>
          </span>
          <span className="ws3-tool__grow" />
          <div className="ws3-seg" role="tablist" aria-label="Period">
            {PERIODS.map((p) => <button key={p} type="button" role="tab" aria-selected={period === p} className={period === p ? 'is-on' : ''} onClick={() => onPeriod(p)}>{p}</button>)}
          </div>
          <label className="ws3-select" title="Metric overlay">
            <Icon name="layers" />
            <select value={overlay} onChange={(e) => setOverlay(e.target.value as Overlay)} aria-label="Metric overlay">
              {OVERLAYS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </header>

        <div className="ws3-tool is-left" data-no-pan>
          <div className="ws3-find">
            <Icon name="search" />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSearchEnter() }} placeholder="Search nodes" aria-label="Search nodes" />
            <kbd>/</kbd>
          </div>
          <div className="ws3-toolcol">
            <button type="button" className="ws3-iconbtn" onClick={() => canvas.current?.zoomIn()} aria-label="Zoom in" title="Zoom in (+)"><Icon name="chevron-up" /></button>
            <button type="button" className="ws3-iconbtn" onClick={() => canvas.current?.zoomOut()} aria-label="Zoom out" title="Zoom out (−)"><Icon name="chevron-down" /></button>
            <button type="button" className="ws3-iconbtn" onClick={() => canvas.current?.fit()} aria-label="Fit to screen" title="Fit (F)"><Icon name="maximize" /></button>
            <button type="button" className={`ws3-iconbtn${focusBranch ? ' is-on' : ''}`} disabled={!nodeKey} onClick={() => setFocusBranch((v) => !v)} aria-pressed={focusBranch} aria-label="Focus branch" title="Focus branch (B)"><Icon name="target" /></button>
            {allGroups.length ? <button type="button" className={`ws3-iconbtn${expanded.size ? ' is-on' : ''}`} onClick={() => setExpanded(expanded.size ? new Set() : new Set(allGroups.map((g) => g.key)))} aria-label={expanded.size ? 'Collapse all steps' : 'Expand all steps'} title={expanded.size ? 'Collapse steps' : 'Expand every step'}><Icon name="layers" /></button> : null}
            <button type="button" className={`ws3-iconbtn${full ? ' is-on' : ''}`} onClick={toggleFull} aria-label={full ? 'Exit fullscreen' : 'Fullscreen'} title="Fullscreen"><Icon name={full ? 'close' : 'external-link'} /></button>
          </div>
        </div>

        <footer className="ws3-tool is-bottom" data-no-pan>
          <span className="ws3-zoomword">{TIER_WORD[tier]}</span>
          {telemetry ? <span className="ws3-tool__spec">{telemetry.runs.total} runs · {telemetry.period}{telemetry.runs.needs_you ? ` · ${telemetry.runs.needs_you} need you` : ''}{telemetry.runs.failed ? ` · ${telemetry.runs.failed} failed` : ''}{telemetry.notes?.length ? ` · ${telemetry.notes[0]}` : ''}</span> : null}
        </footer>
      </div>

      {run || runId ? (
        <RunPanel
          run={run}
          error={runErr}
          topology={topology}
          onClose={() => { onRun(null); onNode(null) }}
          onNode={(k) => { onNode(k); canvas.current?.flyToNode(k) }}
          onOpenRun={onOpenRun}
          replay={run ? <ReplayBar replay={replay} length={run.path.order.length} current={replayNode} /> : null}
        />
      ) : (selectedNode || selectedGroup) && topology && workflow ? (
        <NodeInspector
          topology={topology}
          workflow={workflow}
          telemetry={telemetry}
          nodeKey={selectedNode}
          groupKey={selectedGroup}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          onClose={() => onNode(null)}
          onOpenRun={(id, k) => onOpenRun(wfKey, id, k)}
          onOpenWorkflow={(k) => { onNode(null); onWorkflow(k) }}
          onRunsThrough={workflow.supports.runs ? onRunsThrough : undefined}
        />
      ) : null}
    </div>
  )
}
