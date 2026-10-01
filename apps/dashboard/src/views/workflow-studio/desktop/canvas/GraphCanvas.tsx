import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { usePanZoom, type Bounds, type Tier, type View } from './usePanZoom'

/**
 * GRAPH CANVAS — the spatial board both the system map and every workflow
 * board are drawn on. Level 0 field + engineering grid, section fields,
 * hairline connectors, glass nodes (rendered by the caller), one-shot
 * traversal pulses and a minimap. Pan/zoom never re-renders React; the zoom
 * TIER (far · mid · near) is the semantic zoom CSS reads.
 */

export interface GraphNodeView { key: string; x: number; y: number; w: number; h: number }
export interface GraphEdgeView { id: string; from: string; to: string; path: string; mid: { x: number; y: number }; back: boolean; /** too short for a worded label */ tight?: boolean }
export interface GraphSectionView { key: string; label: string; x: number; y: number; w: number; h: number; index: number }
export interface GraphModel { nodes: GraphNodeView[]; edges: GraphEdgeView[]; sections: GraphSectionView[]; bounds: Bounds; byKey: Map<string, GraphNodeView> }

/** One real traversal → one pulse along its edge, then rest. */
export interface Pulse { id: string; edge: string; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow'; delay: number }

export interface GraphCanvasApi {
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  recenter: () => void
  reframe: (mode?: 'contain' | 'readable') => void
  flyToNode: (key: string, k?: number) => void
  flyToPoint: (x: number, y: number, k?: number) => void
  /** frame these nodes in the visible area (never zooming past maxK) */
  frameNodes: (keys: string[], maxK?: number) => void
  getView: () => View
}

interface Props {
  model: GraphModel
  variant: 'system' | 'workflow'
  reducedMotion: boolean
  renderNode: (n: GraphNodeView) => ReactNode
  edgeClass: (e: GraphEdgeView) => string
  edgeWidth?: (e: GraphEdgeView) => number
  edgeLabel?: (e: GraphEdgeView) => ReactNode | null
  edgeTitle?: (e: GraphEdgeView) => string | null
  onEdge?: (id: string) => void
  onBackground?: () => void
  pulses?: Pulse[]
  onPulseDone?: (id: string) => void
  /** reduced motion: an instant edge highlight instead of travel */
  flashEdges?: ReadonlySet<string>
  minimap?: boolean
  /** nodes marked on the minimap (active execution) */
  marked?: ReadonlySet<string>
  /** per-node minimap tone */
  minimapTone?: (key: string) => string
  sectionsVisible?: boolean
  activeSection?: string | null
  onSection?: (key: string) => void
  viewKey?: string | null
  fitMode?: 'contain' | 'readable'
  insetRight?: number
  interactive?: boolean
  onTier?: (t: Tier) => void
  className?: string
  label: string
  /** flow direction — ports sit on the flow's sides */
  direction?: 'LR' | 'TB'
  /** arrowhead family for an edge (system map) — null for none */
  edgeMarker?: (e: GraphEdgeView) => string | null
  children?: ReactNode
}

export const GraphCanvas = forwardRef<GraphCanvasApi, Props>(function GraphCanvas(props, ref) {
  const {
    model, variant, reducedMotion, renderNode, edgeClass, edgeWidth, edgeLabel, edgeTitle, onEdge, onBackground, pulses = [], onPulseDone,
    flashEdges, minimap = true, marked, minimapTone, sectionsVisible = true, activeSection = null, onSection, viewKey = null, fitMode = 'readable',
    insetRight = 0, interactive = true, onTier, className, label, direction = 'LR', edgeMarker, children,
  } = props
  const pad = !interactive ? 24 : variant === 'system' ? SYSTEM_PAD : minimap ? WORKFLOW_PAD_MAP : WORKFLOW_PAD
  const { viewportRef, worldRef, tier, fit, zoomBy, recenter, reframe, flyTo, frameBox, getView, subscribe } = usePanZoom({ bounds: model.bounds, interactive, reducedMotion, insetRight, fitMode, viewKey, pad, maxFit: variant === 'system' ? 1.3 : 1.05 })
  useEffect(() => { onTier?.(tier) }, [tier, onTier])

  useImperativeHandle(ref, () => ({
    fit: () => fit(true, 'contain'),
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    recenter: () => recenter(),
    reframe: (mode) => reframe(mode),
    flyToNode: (key, k) => { const n = model.byKey.get(key); if (n) flyTo(n.x, n.y, k) },
    flyToPoint: (x, y, k) => flyTo(x, y, k),
    frameNodes: (keys, maxK) => {
      const ns = keys.map((k) => model.byKey.get(k)).filter((n): n is GraphNodeView => Boolean(n))
      if (!ns.length) return
      const x0 = Math.min(...ns.map((n) => n.x - n.w / 2)); const x1 = Math.max(...ns.map((n) => n.x + n.w / 2))
      const y0 = Math.min(...ns.map((n) => n.y - n.h / 2)); const y1 = Math.max(...ns.map((n) => n.y + n.h / 2))
      frameBox({ x: x0 - 30, y: y0 - 30, w: x1 - x0 + 60, h: y1 - y0 + 60 }, maxK)
    },
    getView: () => getView(),
  }), [fit, flyTo, frameBox, getView, model, recenter, reframe, zoomBy])

  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || !onBackground) return
    const h = () => onBackground()
    vp.addEventListener('ws4:background-click', h)
    return () => vp.removeEventListener('ws4:background-click', h)
  }, [onBackground, viewportRef])

  const pathOf = useMemo(() => new Map(model.edges.map((e) => [e.id, e.path])), [model])

  return (
    <div
      ref={viewportRef}
      className={['ws4-board', `is-z-${tier}`, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-dir={direction}
      role="application"
      aria-label={label}
      aria-roledescription="graph canvas"
    >
      <div ref={worldRef} className="ws4-world">
        {sectionsVisible && model.sections.length ? (
          <div className="ws4-fields" aria-hidden={!onSection}>
            {model.sections.map((s) => (
              <div key={s.key} className={`ws4-field${s.index % 2 ? ' is-alt' : ''}${activeSection === s.key ? ' is-on' : ''}`} style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
                {onSection ? <button type="button" className="ws4-field__label" onClick={() => onSection(s.key)} data-no-pan>{s.label}</button> : <span className="ws4-field__label">{s.label}</span>}
              </div>
            ))}
          </div>
        ) : null}
        <Edges model={model} edgeClass={edgeClass} edgeWidth={edgeWidth} edgeTitle={edgeTitle} onEdge={onEdge} flashEdges={flashEdges} jumps={variant === 'system'} edgeMarker={edgeMarker} />
        {edgeLabel ? model.edges.map((e) => {
          const content = edgeLabel(e)
          return content ? <span key={`l:${e.id}`} className={`ws4-elabel ${edgeClass(e)}`} style={{ left: e.mid.x, top: e.mid.y }}>{content}</span> : null
        }) : null}
        {model.nodes.map((n) => (
          <div key={n.key} className="ws4-slot" data-node={n.key} style={{ left: n.x - n.w / 2, top: n.y - n.h / 2, width: n.w, height: n.h }}>
            {renderNode(n)}
          </div>
        ))}
        {pulses.length ? <Pulses pulses={pulses} pathOf={pathOf} onDone={onPulseDone} /> : null}
      </div>
      {minimap && interactive ? <Minimap model={model} viewportRef={viewportRef} subscribe={subscribe} getView={getView} flyTo={flyTo} marked={marked} toneOf={minimapTone} /> : null}
      {children}
    </div>
  )
})

/** room kept clear for the floating tools: left tool column, top toolbar, status line, minimap */
const SYSTEM_PAD = { t: 70, r: 24, b: 22, l: 60 }
const WORKFLOW_PAD = { t: 72, r: 32, b: 56, l: 64 }
const WORKFLOW_PAD_MAP = { t: 72, r: 40, b: 64, l: 64 }
const MARKERS = ['action', 'event', 'subworkflow', 'external', 'state'] as const

const Edges = memo(function Edges({ model, edgeClass, edgeWidth, edgeTitle, onEdge, flashEdges, jumps, edgeMarker }: {
  model: GraphModel
  edgeClass: (e: GraphEdgeView) => string
  edgeWidth?: (e: GraphEdgeView) => number
  edgeTitle?: (e: GraphEdgeView) => string | null
  onEdge?: (id: string) => void
  flashEdges?: ReadonlySet<string>
  /** draw a halo under each edge so a later edge visibly jumps over an earlier one */
  jumps?: boolean
  edgeMarker?: (e: GraphEdgeView) => string | null
}) {
  return (
    <svg className="ws4-edges" width="1" height="1" aria-hidden>
      {edgeMarker ? (
        <defs>
          {MARKERS.map((k) => (
            <marker key={k} id={`ws4-arrow-${k}`} className={`ws4-arrow is-k-${k}`} viewBox="0 0 10 10" refX="9.2" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 1 1.4 L 9.2 5 L 1 8.6 Q 2.6 5 1 1.4 Z" />
            </marker>
          ))}
        </defs>
      ) : null}
      {model.edges.map((e) => {
        const cls = `${edgeClass(e)}${flashEdges?.has(e.id) ? ' is-flash' : ''}`
        const w = edgeWidth ? edgeWidth(e) : null
        const marker = edgeMarker?.(e)
        return (
          <g key={e.id}>
            {jumps ? <path d={e.path} className={`ws4-edge-halo ${cls}`} style={w ? { strokeWidth: w + 6 } : undefined} /> : null}
            <path d={e.path} className={`ws4-edge ${cls}`} style={w ? { strokeWidth: w } : undefined} data-edge={e.id} markerEnd={marker ? `url(#ws4-arrow-${marker})` : undefined} />
          </g>
        )
      })}
      {onEdge ? model.edges.map((e) => (
        <path key={`h:${e.id}`} d={e.path} className="ws4-edge-hit" data-edge-hit={e.id} onClick={(ev) => { ev.stopPropagation(); onEdge(e.id) }}>
          {edgeTitle?.(e) ? <title>{edgeTitle(e)}</title> : null}
        </path>
      )) : null}
    </svg>
  )
})

const Pulses = memo(function Pulses({ pulses, pathOf, onDone }: { pulses: Pulse[]; pathOf: Map<string, string>; onDone?: (id: string) => void }) {
  return (
    <>
      {pulses.map((p) => {
        const d = pathOf.get(p.edge)
        if (!d) return null
        return <i key={p.id} className="ws4-pulse" data-tone={p.tone} style={{ offsetPath: `path('${d}')`, animationDelay: `${p.delay}ms` }} onAnimationEnd={() => onDone?.(p.id)} aria-hidden />
      })}
    </>
  )
})

const MW = 196
const MH = 112

function Minimap({ model, viewportRef, subscribe, getView, flyTo, marked, toneOf }: {
  model: GraphModel
  viewportRef: RefObject<HTMLDivElement | null>
  subscribe: (l: (v: View) => void) => () => void
  getView: () => View
  flyTo: (x: number, y: number, k?: number) => void
  marked?: ReadonlySet<string>
  toneOf?: (key: string) => string
}) {
  const rect = useRef<SVGRectElement | null>(null)
  const b = model.bounds
  const s = Math.min((MW - 12) / Math.max(1, b.w), (MH - 12) / Math.max(1, b.h))
  const ox = (MW - b.w * s) / 2
  const oy = (MH - b.h * s) / 2
  const geo = useRef({ s, ox, oy, b })
  useEffect(() => { geo.current = { s, ox, oy, b } })

  const paint = useCallback((v: View) => {
    const r = rect.current
    const vp = viewportRef.current
    if (!r || !vp) return
    const g = geo.current
    r.setAttribute('x', String((-v.x / v.k - g.b.x) * g.s + g.ox))
    r.setAttribute('y', String((-v.y / v.k - g.b.y) * g.s + g.oy))
    r.setAttribute('width', String(Math.max(4, (vp.clientWidth / v.k) * g.s)))
    r.setAttribute('height', String(Math.max(4, (vp.clientHeight / v.k) * g.s)))
  }, [viewportRef])
  useEffect(() => { paint(getView()); return subscribe(paint) }, [getView, paint, subscribe])

  const onClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    flyTo((e.clientX - r.left - ox) / s + b.x, (e.clientY - r.top - oy) / s + b.y, getView().k)
  }
  return (
    <svg className="ws4-minimap" width={MW} height={MH} onClick={onClick} data-no-pan role="img" aria-label="Minimap — click to move the view">
      {model.sections.map((sec) => <rect key={sec.key} className={`ws4-minimap__field${sec.index % 2 ? ' is-alt' : ''}`} x={(sec.x - b.x) * s + ox} y={(sec.y - b.y) * s + oy} width={sec.w * s} height={sec.h * s} />)}
      {model.edges.filter((e) => !e.back).map((e) => {
        const a = model.byKey.get(e.from)
        const c = model.byKey.get(e.to)
        if (!a || !c) return null
        return <line key={e.id} x1={(a.x - b.x) * s + ox} y1={(a.y - b.y) * s + oy} x2={(c.x - b.x) * s + ox} y2={(c.y - b.y) * s + oy} />
      })}
      {model.nodes.map((n) => <rect key={n.key} x={(n.x - n.w / 2 - b.x) * s + ox} y={(n.y - n.h / 2 - b.y) * s + oy} width={Math.max(2, n.w * s)} height={Math.max(2, n.h * s)} rx={1.5} className={`ws4-minimap__node ${toneOf?.(n.key) || ''}`} />)}
      {marked ? model.nodes.filter((n) => marked.has(n.key)).map((n) => <circle key={`m:${n.key}`} className="ws4-minimap__mark" cx={(n.x - b.x) * s + ox} cy={(n.y - b.y) * s + oy} r={3} />) : null}
      <rect ref={rect} className="ws4-minimap__view" rx={3} />
    </svg>
  )
}
