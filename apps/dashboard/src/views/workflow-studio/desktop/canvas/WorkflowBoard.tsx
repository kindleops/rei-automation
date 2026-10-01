import { forwardRef, useCallback, useMemo, type ReactNode } from 'react'
import type { RunPath, Topology, WorkflowTelemetry } from '../lib/types'
import { count as fmtCount } from '../lib/format'
import { branchWord, FAMILY, terminalTone } from '../lib/families'
import { GraphCanvas, type GraphCanvasApi, type GraphEdgeView, type GraphNodeView, type Pulse } from './GraphCanvas'
import { type Layout, type LayoutNode } from './layout'
import { WorkflowNode, type Metric, type NodeFigures, type NodeState } from './WorkflowNode'
import type { Tier } from './usePanZoom'

/** A run laid over the board: its recorded path, and (during replay) how much of it is revealed. */
export interface RunOverlay {
  path: RunPath
  /** replay: the first N steps of path.order are revealed */
  revealed?: number | null
  /** where the run can go next from where it stopped (out-edges of the current node) */
  next?: string[]
}

/** LIVE: what each node is doing now, and which nodes a traversal just reached. */
export interface LiveOverlay { executing: Record<string, number>; parked: Record<string, number>; arrived: ReadonlySet<string> }

export interface SimOverlay { path: string[]; actions: Record<string, string> }

const RUN_CLASS: Record<string, NodeState['run']> = {
  succeeded: 'done', passed: 'done', completed: 'done', resolved: 'done', delivered: 'done',
  current: 'current', waiting: 'current', running: 'current',
  failed: 'failed', blocked: 'held', held: 'held', needs_review: 'human', human: 'human', skipped: 'skipped',
}
const WEIGHT: Record<string, number> = { failed: 6, held: 5, human: 4, current: 3, done: 1, skipped: 0 }

interface Props {
  topology: Topology
  layout: Layout
  telemetry: WorkflowTelemetry | null
  metric?: Metric
  selected?: string | null
  selectedEdge?: string | null
  onSelect: (key: string | null) => void
  onEdge?: (id: string) => void
  onToggleGroup?: (groupKey: string) => void
  /** nodes kept sharp (focus branch · run path · dependencies); everything else dims */
  focus?: ReadonlySet<string> | null
  search?: string
  run?: RunOverlay | null
  live?: LiveOverlay | null
  pulses?: Pulse[]
  onPulseDone?: (id: string) => void
  flashEdges?: ReadonlySet<string>
  issues?: ReadonlyMap<string, { errors: number; warnings: number }>
  sim?: SimOverlay | null
  reducedMotion: boolean
  viewKey?: string | null
  insetRight?: number
  minimap?: boolean
  interactive?: boolean
  fitMode?: 'contain' | 'readable'
  onTier?: (t: Tier) => void
  label: string
  children?: ReactNode
}

export const WorkflowBoard = forwardRef<GraphCanvasApi, Props>(function WorkflowBoard(props, ref) {
  const {
    topology, layout, telemetry, metric = 'volume', selected = null, selectedEdge = null, onSelect, onEdge, onToggleGroup, focus = null, search = '',
    run = null, live = null, pulses, onPulseDone, flashEdges, issues, sim = null, reducedMotion, viewKey, insetRight, minimap = true,
    interactive = true, fitMode, onTier, label, children,
  } = props
  const needle = search.trim().toLowerCase()
  const selectedOwner = selected ? layout.owner.get(selected) || selected : null

  const figures = useMemo(() => {
    const out = new Map<string, NodeFigures | null>()
    for (const n of layout.nodes) {
      if (!telemetry) { out.set(n.key, null); continue }
      let entered = 0; let held = 0; let failed = 0; let human = 0; let waiting = 0
      const measured: Array<number | null> = []
      for (const k of n.members) {
        const t = telemetry.nodes[k]
        if (!t) continue
        entered = Math.max(entered, t.entered) // a group's volume is the runs that entered it, never the sum of its steps
        held += t.held; failed += t.failed; human += t.human; waiting += t.waiting_now
        if (topology.nodes.find((x) => x.key === k)?.measured?.latency) measured.push(t.p50_ms)
      }
      // percentiles do not add: a group shows one only when exactly one member is timed
      out.set(n.key, { entered, held, failed, human, waiting, p50: measured.length === 1 ? measured[0] : null, measured: measured.length === 1 })
    }
    return out
  }, [layout, telemetry, topology])

  const revealedSet = useMemo(() => (run && typeof run.revealed === 'number' ? new Set(run.path.order.slice(0, run.revealed)) : null), [run])
  const replayAt = run && typeof run.revealed === 'number' && run.revealed > 0 ? run.path.order[run.revealed - 1] : null
  const nextSet = useMemo(() => new Set(run?.next || []), [run])
  const simSet = useMemo(() => new Set(sim?.path || []), [sim])
  const runEdges = useMemo(() => new Set(run?.path.edges || []), [run])

  const stateOf = useCallback((n: LayoutNode): NodeState => {
    let runState: NodeState['run'] = null
    let runLabel: string | null = null
    if (run) {
      runState = 'off'
      if (replayAt && n.members.includes(replayAt)) { runState = 'current'; runLabel = run.path.nodes[replayAt]?.label || run.path.nodes[replayAt]?.reason || null }
      else {
        let best: NodeState['run'] = null
        for (const k of n.members) {
          if (revealedSet && !revealedSet.has(k) && run.path.nodes[k]?.status !== 'skipped') continue
          const st = run.path.nodes[k]
          if (!st) continue
          const c = RUN_CLASS[st.status] || 'done'
          if (!best || (WEIGHT[c || 'done'] ?? 1) > (WEIGHT[best] ?? 1)) { best = c; runLabel = st.label || (st.reason ? st.reason.replace(/_/g, ' ') : null) }
        }
        if (best) runState = best
        else if (!revealedSet && n.members.some((k) => nextSet.has(k))) runState = 'next'
      }
    }
    const executing = live ? n.members.reduce((a, k) => a + (live.executing[k] || 0), 0) : 0
    const parked = live ? n.members.reduce((a, k) => a + (live.parked[k] || 0), 0) : 0
    const issue = issues ? n.members.reduce((a, k) => ({ errors: a.errors + (issues.get(k)?.errors || 0), warnings: a.warnings + (issues.get(k)?.warnings || 0) }), { errors: 0, warnings: 0 }) : { errors: 0, warnings: 0 }
    const onSim = sim ? n.members.some((k) => simSet.has(k)) : false
    return {
      run: runState,
      runLabel,
      executing,
      parked,
      arrived: live ? n.members.some((k) => live.arrived.has(k)) : false,
      selected: selectedOwner === n.key,
      dim: Boolean(focus && !focus.has(n.key)),
      match: Boolean(needle && `${n.label} ${n.node?.summary || ''} ${n.key}`.toLowerCase().includes(needle)),
      invalid: issue.errors,
      warn: issue.warnings,
      sim: onSim,
      simAction: onSim && sim ? n.members.map((k) => sim.actions[k]).find(Boolean) || null : null,
    }
  }, [focus, issues, live, needle, nextSet, replayAt, revealedSet, run, selectedOwner, sim, simSet])

  const maxEdge = useMemo(() => Math.max(1, ...layout.edges.map((e) => e.ids.reduce((a, id) => a + (telemetry?.edges[id] || 0), 0))), [layout, telemetry])
  const edgeCount = useCallback((e: GraphEdgeView) => (layout.edges.find((x) => x.id === e.id)?.ids || [e.id]).reduce((a, id) => a + (telemetry?.edges[id] || 0), 0), [layout, telemetry])
  const kindOf = useMemo(() => new Map(layout.edges.map((e) => [e.id, e])), [layout])

  const edgeClass = useCallback((e: GraphEdgeView) => {
    const le = kindOf.get(e.id)
    if (!le) return ''
    const c: string[] = [`is-${le.kind}`]
    if (le.back) c.push('is-back')
    if (telemetry && !edgeCount(e)) c.push('is-cold')
    if (run) {
      const onPath = le.ids.some((id) => runEdges.has(id))
      const revealed = !revealedSet || layout.byKey.get(le.to)?.members.some((k) => revealedSet.has(k))
      c.push(onPath && revealed ? 'is-path' : 'is-off')
      if (!revealedSet && !onPath && (run.next || []).some((k) => layout.owner.get(k) === le.to)) c.push('is-next')
    }
    if (focus && !(focus.has(le.from) && focus.has(le.to))) c.push('is-dim')
    if (sim) { const i = sim.path.indexOf(le.from); if (i >= 0 && sim.path[i + 1] && layout.owner.get(sim.path[i + 1]) === le.to) c.push('is-sim') }
    if (selectedEdge && le.ids.includes(selectedEdge)) c.push('is-selected')
    return c.join(' ')
  }, [edgeCount, focus, kindOf, layout, revealedSet, run, runEdges, selectedEdge, sim, telemetry])

  const edgeWidth = useCallback((e: GraphEdgeView) => (telemetry ? 1.05 + 2.1 * (Math.log10(1 + edgeCount(e)) / Math.log10(1 + maxEdge)) : 1.3), [edgeCount, maxEdge, telemetry])
  const edgeLabel = useCallback((e: GraphEdgeView) => {
    const le = kindOf.get(e.id)
    if (!le) return null
    const n = telemetry ? edgeCount(e) : null
    const word = branchWord(le.label)
    if (!word && !n) return null
    if (!word && !(le.kind !== 'primary')) return null
    return <>{word ? <span>{word}</span> : null}{n ? <em className="lc-num">{fmtCount(n)}</em> : null}</>
  }, [edgeCount, kindOf, telemetry])
  const edgeTitle = useCallback((e: GraphEdgeView) => {
    const le = kindOf.get(e.id)
    if (!le) return null
    const from = layout.byKey.get(le.from)?.label
    const to = layout.byKey.get(le.to)?.label
    return `${from} → ${to}${le.label ? ` · ${le.label}` : ''}${telemetry ? ` · ${edgeCount(e)} runs` : ''}`
  }, [edgeCount, kindOf, layout, telemetry])

  const select = useCallback((k: string) => {
    const n = layout.byKey.get(k)
    onSelect(n?.node ? n.node.key : k)
  }, [layout, onSelect])

  const renderNode = useCallback((v: GraphNodeView) => {
    const n = layout.byKey.get(v.key)!
    return <WorkflowNode n={n} figures={figures.get(n.key) ?? null} metric={metric} state={stateOf(n)} onSelect={select} onToggleGroup={onToggleGroup} />
  }, [figures, layout, metric, onToggleGroup, select, stateOf])

  const marked = useMemo(() => {
    const s = new Set<string>()
    if (live) for (const n of layout.nodes) if (n.members.some((k) => (live.executing[k] || 0) + (live.parked[k] || 0) > 0)) s.add(n.key)
    if (run?.path.focus) s.add(layout.owner.get(run.path.focus) || run.path.focus)
    return s
  }, [layout, live, run])
  const toneOf = useCallback((key: string) => {
    const n = layout.byKey.get(key)
    return n ? `is-${n.family === 'TERMINAL' ? terminalTone(n.node?.terminal) : FAMILY[n.family].tone}` : ''
  }, [layout])

  return (
    <GraphCanvas
      ref={ref}
      model={layout}
      variant="workflow"
      direction={layout.direction}
      reducedMotion={reducedMotion}
      renderNode={renderNode}
      edgeClass={edgeClass}
      edgeWidth={edgeWidth}
      edgeLabel={edgeLabel}
      edgeTitle={edgeTitle}
      onEdge={onEdge}
      onBackground={() => onSelect(null)}
      pulses={pulses}
      onPulseDone={onPulseDone}
      flashEdges={flashEdges}
      minimap={minimap}
      marked={marked}
      minimapTone={toneOf}
      viewKey={viewKey}
      insetRight={insetRight}
      interactive={interactive}
      fitMode={fitMode}
      onTier={onTier}
      className={[run && 'is-run', focus && 'is-focusing', needle && 'is-searching', live && 'is-live', sim && 'is-simulating'].filter(Boolean).join(' ')}
      label={label}
    >
      {children}
    </GraphCanvas>
  )
})
