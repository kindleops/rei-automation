import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { NodeTelemetry, Topology, WorkflowTelemetry } from '../observatory-types'
import { CanvasNode, type NodeFigures, type NodePaint, type Overlay } from './CanvasNode'
import { branchOf, layoutTopology, type Layout, type LayoutNode } from './layout'
import { usePanZoom, type Tier, type View } from './usePanZoom'

export interface RunOverlay {
  nodes: Record<string, { status: string }>
  edges: string[]
  focus: string | null
  /** replay: only the first N nodes of `order` are revealed */
  order?: string[]
  revealed?: number
}

export interface CanvasApi {
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  flyToNode: (key: string, k?: number) => void
  layout: () => Layout
}

interface Props {
  topology: Topology
  telemetry: WorkflowTelemetry | null
  expanded: ReadonlySet<string>
  selected: string | null
  onSelect: (key: string | null) => void
  onToggleGroup?: (groupKey: string) => void
  focusBranch?: boolean
  search?: string
  overlay?: Overlay
  run?: RunOverlay | null
  live?: Record<string, number> | null
  impulses?: Record<string, number> | null
  interactive?: boolean
  mini?: boolean
  insetRight?: number
  reducedMotion: boolean
  showMiniMap?: boolean
  onTier?: (t: Tier) => void
  className?: string
  children?: ReactNode
}

const EMPTY: NodeTelemetry = { entered: 0, passed: 0, held: 0, failed: 0, human: 0, skipped: 0, waiting_now: 0, p50_ms: null, p95_ms: null, last_at: null }

function figuresFor(n: LayoutNode, telemetry: WorkflowTelemetry | null, topology: Topology): NodeFigures | null {
  if (!telemetry) return null
  let entered = 0; let held = 0; let failed = 0; let human = 0; let waiting = 0; let p50: number | null = null; let measured = false
  for (const k of n.members) {
    const t = telemetry.nodes[k] || EMPTY
    entered = Math.max(entered, t.entered) // a group's volume is the runs that entered it, not the sum of its steps
    held += t.held; failed += t.failed; human += t.human; waiting += t.waiting_now
    const node = topology.nodes.find((x) => x.key === k)
    if (node?.measured?.latency && t.p50_ms !== null) { measured = true; p50 = (p50 ?? 0) + t.p50_ms }
  }
  return { entered, held, failed, human, waiting, p50, measured }
}

const RUN_CLASS: Record<string, NodePaint['run']> = { succeeded: 'path', passed: 'path', completed: 'path', resolved: 'path', delivered: 'path', current: 'current', waiting: 'current', failed: 'failed', blocked: 'held', held: 'held', needs_review: 'held', human: 'held' }

export const StudioCanvas = forwardRef<CanvasApi, Props>(function StudioCanvas(props, ref) {
  const { topology, telemetry, expanded, selected, onSelect, onToggleGroup, focusBranch = false, search = '', overlay = 'volume', run = null, live = null, impulses = null, interactive = true, mini = false, insetRight = 0, reducedMotion, showMiniMap = true, onTier, className, children } = props
  const layout = useMemo(() => layoutTopology(topology, expanded), [topology, expanded])
  const miniRect = useRef<SVGRectElement | null>(null)
  const miniBox = useRef<{ s: number; ox: number; oy: number } | null>(null)

  const onView = useCallback((v: View) => {
    const r = miniRect.current
    const m = miniBox.current
    const vp = pz.viewport.current
    if (!r || !m || !vp) return
    r.setAttribute('x', String((-v.x / v.k - layout.bounds.x) * m.s + m.ox))
    r.setAttribute('y', String((-v.y / v.k - layout.bounds.y) * m.s + m.oy))
    r.setAttribute('width', String((vp.clientWidth / v.k) * m.s))
    r.setAttribute('height', String((vp.clientHeight / v.k) * m.s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  const pz = usePanZoom({ bounds: layout.bounds, interactive: interactive && !mini, reducedMotion, insetRight, pad: mini ? 28 : 72, onView, fitMode: mini ? 'contain' : 'readable' })
  const { tier } = pz
  useEffect(() => { onTier?.(tier) }, [tier, onTier])

  // a new topology / disclosure → reframe unless the operator is steering
  useEffect(() => { pz.reframe() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology.workflow_key, mini])

  useImperativeHandle(ref, () => ({
    fit: () => pz.fit(true, 'contain'),
    zoomIn: () => pz.zoomBy(1.25),
    zoomOut: () => pz.zoomBy(0.8),
    flyToNode: (key: string, k?: number) => {
      const owner = layout.owner.get(key) || key
      const n = layout.byKey.get(owner)
      if (n) pz.flyTo(n.x, n.y, k)
    },
    layout: () => layout,
  }), [layout, pz])

  // background click clears the selection
  useEffect(() => {
    const vp = pz.viewport.current
    if (!vp || mini) return
    const h = () => onSelect(null)
    vp.addEventListener('ws3:background-click', h)
    return () => vp.removeEventListener('ws3:background-click', h)
  }, [mini, onSelect, pz.viewport])

  const branch = useMemo(() => (focusBranch && selected && layout.byKey.has(layout.owner.get(selected) || selected) ? branchOf(layout, layout.owner.get(selected) || selected) : null), [focusBranch, layout, selected])
  const needle = search.trim().toLowerCase()
  const selectedOwner = selected ? layout.owner.get(selected) || selected : null

  const edgeCount = useCallback((ids: string[]) => ids.reduce((a, id) => a + (telemetry?.edges[id] || 0), 0), [telemetry])
  const maxEdge = useMemo(() => Math.max(1, ...layout.edges.map((e) => edgeCount(e.ids))), [layout, edgeCount])
  const maxEntered = useMemo(() => Math.max(1, ...layout.nodes.map((n) => figuresFor(n, telemetry, topology)?.entered || 0)), [layout, telemetry, topology])
  const runEdges = useMemo(() => new Set(run?.edges || []), [run])
  const revealedSet = useMemo(() => (run?.order && run.revealed !== undefined ? new Set(run.order.slice(0, run.revealed)) : null), [run])

  const replayAt = run?.order && run.revealed ? run.order[run.revealed - 1] : null
  const runPaint = (n: LayoutNode): NodePaint['run'] => {
    if (!run) return null
    if (replayAt && n.members.includes(replayAt)) return 'current'
    let best: NodePaint['run'] = null
    for (const k of n.members) {
      if (revealedSet && !revealedSet.has(k)) continue
      const st = run.nodes[k]?.status
      if (!st) continue
      const c = RUN_CLASS[st] || 'path'
      if (c === 'failed' || (c === 'held' && best !== 'failed') || (c === 'current' && !['failed', 'held'].includes(best || '')) || !best) best = c
    }
    return best || 'skipped'
  }

  const nodes = layout.nodes.map((n) => {
    const figures = figuresFor(n, telemetry, topology)
    const waitingHuman = (n.family === 'HUMAN_REVIEW' || n.family === 'APPROVAL') && figures?.waiting ? figures.waiting : 0
    const pressure = waitingHuman ? `${n.family === 'APPROVAL' ? 'Approval' : 'Human review'} · ${waitingHuman} waiting` : null
    const heat = overlay === 'volume' ? (figures ? Math.log10(1 + figures.entered) / Math.log10(1 + maxEntered) : 0)
      : overlay === 'holds' ? Math.min(1, (figures?.held || 0) / Math.max(1, figures?.entered || 1))
      : overlay === 'failures' ? Math.min(1, (figures?.failed || 0) / Math.max(1, figures?.entered || 1))
      : overlay === 'human' ? Math.min(1, ((figures?.human || 0) + (figures?.waiting || 0)) / Math.max(1, figures?.entered || 1))
      : 0
    const paint: NodePaint = {
      selected: selectedOwner === n.key,
      dim: Boolean(branch && !branch.has(n.key)),
      match: Boolean(needle && `${n.label} ${n.node?.summary || ''} ${n.key}`.toLowerCase().includes(needle)),
      live: Boolean(live && n.members.some((k) => (live[k] || 0) > 0)),
      run: runPaint(n),
      heat,
    }
    return { n, figures, paint, pressure }
  })

  // minimap geometry (only when the board is meaningfully larger than the view)
  const MW = 188; const MH = 104
  const s = Math.min((MW - 12) / Math.max(1, layout.bounds.w), (MH - 12) / Math.max(1, layout.bounds.h))
  miniBox.current = { s, ox: (MW - layout.bounds.w * s) / 2, oy: (MH - layout.bounds.h * s) / 2 }
  const miniVisible = showMiniMap && !mini && interactive && layout.bounds.w > 1400

  const onMiniClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    const m = miniBox.current
    if (!m) return
    const r = e.currentTarget.getBoundingClientRect()
    const wx = (e.clientX - r.left - m.ox) / m.s + layout.bounds.x
    const wy = (e.clientY - r.top - m.oy) / m.s + layout.bounds.y
    pz.flyTo(wx, wy, pz.view.current.k)
  }

  return (
    <div
      ref={pz.viewport}
      className={['ws3-board', mini && 'is-mini', `is-z-${tier}`, branch && 'is-focusing', run && 'is-run', needle && 'is-searching', className].filter(Boolean).join(' ')}
      data-overlay={overlay}
      aria-label={`${topology.workflow_key} topology`}
    >
      <div ref={pz.world} className="ws3-world">
        <svg className="ws3-edges" width="1" height="1" aria-hidden>
          {layout.edges.map((e) => {
            const count = edgeCount(e.ids)
            const w = telemetry ? 1.1 + 2.2 * (Math.log10(1 + count) / Math.log10(1 + maxEdge)) : 1.4
            const dim = branch ? !(branch.has(e.from) && branch.has(e.to)) : false
            const onRun = run ? e.ids.some((id) => runEdges.has(id)) && (!revealedSet || [...layout.byKey.get(e.to)?.members || []].some((k) => revealedSet.has(k))) : false
            const cls = ['ws3-edge', `is-${e.kind}`, e.back && 'is-back', dim && 'is-dim', run && (onRun ? 'is-path' : 'is-off'), telemetry && !count && 'is-cold'].filter(Boolean).join(' ')
            return <path key={e.id} d={e.path} className={cls} style={{ strokeWidth: w }} data-edge={e.id} />
          })}
        </svg>
        {layout.edges.filter((e) => e.label).map((e) => {
          const dim = branch ? !(branch.has(e.from) && branch.has(e.to)) : false
          const onRun = run ? e.ids.some((id) => runEdges.has(id)) : false
          return (
            <span key={`l:${e.id}`} className={['ws3-elabel', `is-${e.kind}`, dim && 'is-dim', run && (onRun ? 'is-path' : 'is-off')].filter(Boolean).join(' ')} style={{ left: e.mid.x, top: e.mid.y }}>
              {e.label}
              {telemetry && !mini ? <em>{edgeCount(e.ids) || ''}</em> : null}
            </span>
          )
        })}
        {nodes.map(({ n, figures, paint, pressure }) => (
          <CanvasNode
            key={n.key}
            n={n}
            figures={figures}
            paint={paint}
            overlay={overlay}
            pressure={pressure}
            tokens={live ? n.members.reduce((a, k) => a + (live[k] || 0), 0) : 0}
            impulse={impulses ? Math.max(0, ...n.members.map((k) => impulses[k] || 0)) : 0}
            onSelect={(k) => {
              if (n.group && selectedOwner === k && onToggleGroup) { onToggleGroup(n.group.key); return }
              onSelect(n.node ? n.node.key : k)
            }}
          />
        ))}
      </div>
      {miniVisible ? (
        <svg className="ws3-minimap" width={MW} height={MH} onClick={onMiniClick} data-no-pan role="img" aria-label="Mini-map">
          {layout.edges.filter((e) => !e.back).map((e) => {
            const a = layout.byKey.get(e.from)!; const b = layout.byKey.get(e.to)!
            const m = miniBox.current!
            return <line key={e.id} x1={(a.x - layout.bounds.x) * m.s + m.ox} y1={(a.y - layout.bounds.y) * m.s + m.oy} x2={(b.x - layout.bounds.x) * m.s + m.ox} y2={(b.y - layout.bounds.y) * m.s + m.oy} className={`is-${e.kind}`} />
          })}
          {layout.nodes.map((n) => {
            const m = miniBox.current!
            return <rect key={n.key} x={(n.x - n.w / 2 - layout.bounds.x) * m.s + m.ox} y={(n.y - n.h / 2 - layout.bounds.y) * m.s + m.oy} width={n.w * m.s} height={Math.max(2, n.h * m.s)} rx={2} className={`is-${n.family.toLowerCase()}${selectedOwner === n.key ? ' is-selected' : ''}`} />
          })}
          <rect ref={miniRect} className="ws3-minimap__view" rx={3} />
        </svg>
      ) : null}
      {children}
    </div>
  )
})
