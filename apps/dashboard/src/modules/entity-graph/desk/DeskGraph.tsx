/**
 * RELATIONSHIP VIEW — one ownership network as a calm SVG: owner at the hub,
 * properties in bands, title entities / people / contacts / mailing / related
 * owners in their sectors, recorded documents fanned off the anchor property.
 *
 * The geometry is the console's deterministic layout (network-layout.ts):
 * the same network always draws the same way, and a large portfolio collapses
 * to its most valuable properties plus a "+N" cluster. Rendering is plain SVG
 * (no physics, no canvas, no new dependency): ~100 nodes at most, pan by drag,
 * zoom by wheel / buttons, fit on demand. Hovering a node dims everything that
 * is not its immediate neighbourhood; clicking an owner, property or person
 * re-anchors the network on it.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react'
import { LCButton, LCIconButton, cx } from '../../../shared/lc'
import type { EntityNetwork, NetworkNode } from '../console/entity-network-api'
import { layoutNetwork, neighbours, visibleNetwork, PROPERTY_CLUSTER_ID } from '../console/network-layout'
import { fmtMoney, nodeAnchor, type NetworkAnchor } from './desk-model'
import { GraphHoverCard } from './DeskGraphCard'
import { useNetworkOutreach } from './desk-outreach'

const TYPE_LABEL: Record<string, string> = {
  owner: 'Owner', property: 'Property', entity: 'Title entity', person: 'Person', phone: 'Phone', email: 'Email',
  mailing: 'Mailing address', related_owner: 'Related owner', conversation: 'Conversation', mortgage: 'Mortgage',
  lien: 'Lien / recorded filing', sale: 'Transaction', buyer: 'Buyer',
}

type Props = {
  network: EntityNetwork
  compact?: boolean
  hiddenTypes?: ReadonlySet<string>
  onOpen?: (anchor: NetworkAnchor) => void
  onExpand?: () => void
  label?: string
}

export function DeskGraph({ network, compact = false, hiddenTypes, onOpen, onExpand, label }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [hoverAt, setHoverAt] = useState<{ x: number; y: number } | null>(null)
  const [cardH, setCardH] = useState(360)
  // outreach for the network's properties: fetched ONCE per network, read by the hover card
  const propertyIds = useMemo(() => (compact ? [] : network.properties.map((p) => p.id)), [network, compact])
  const outreach = useNetworkOutreach(propertyIds)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 600, h: 400 })
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const hidden = useMemo(() => new Set(hiddenTypes ?? []), [hiddenTypes])
  const vis = useMemo(
    () => visibleNetwork(network.graph.nodes, network.graph.edges, { expanded, anchorId: network.anchor.nodeId, hiddenTypes: hidden }),
    [network, expanded, hidden],
  )
  const base = useMemo(() => layoutNetwork(vis.nodes, vis.edges, network.anchor.nodeId).placed, [vis, network.anchor.nodeId])
  /**
   * The console layout is drawn for a portrait phone. A desk pane is wide, so
   * the same deterministic geometry is stretched horizontally to the pane's
   * aspect (bounded) — labels in a band get room instead of colliding. Then
   * the drawn extent is fitted to the box and nodes / type are sized in
   * SCREEN pixels (`k` = user units per CSS pixel): a two-node network and a
   * 90-node one read at the same type scale.
   */
  const stretch = Math.min(compact ? 1.5 : 2.1, Math.max(1, box.w / Math.max(1, box.h)))
  const placed = useMemo(() => {
    const m = new Map<string, { x: number; y: number; size: number }>()
    for (const [id, p] of base) m.set(id, { x: p.x * stretch, y: p.y, size: p.size })
    return m
  }, [base, stretch])
  const ex = useMemo(() => Math.max(60, ...[...placed.values()].map((p) => Math.abs(p.x))), [placed])
  const ey = useMemo(() => Math.max(60, ...[...placed.values()].map((p) => Math.abs(p.y))), [placed])
  const padX = compact ? 40 : 110
  const padY = compact ? 30 : 64
  const ppu = Math.max(0.05, Math.min((box.w - 2 * padX) / (2 * ex), (box.h - 2 * padY) / (2 * ey)))
  const W = box.w / ppu
  const H = box.h / ppu
  const k = 1 / ppu / view.k
  const extent = Math.max(ex, ey)
  const near = useMemo(() => (hover ? neighbours(vis.edges, hover) : null), [hover, vis.edges])
  /**
   * Label placement: each label is a ~150×30px box below its node; when that
   * box would overlap one already placed it flips above the node (if that
   * side is free). Greedy, hub first, in screen pixels.
   */
  const labelAbove = useMemo(() => {
    const out = new Set<string>()
    if (compact) return out
    const boxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = []
    const hit = (b: { x0: number; x1: number; y0: number; y1: number }) => boxes.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)
    const order = [...vis.nodes].sort((a, b) => (a.type === 'owner' ? -1 : 0) - (b.type === 'owner' ? -1 : 0))
    for (const n of order) {
      const p = placed.get(n.id)
      if (!p) continue
      const cx = p.x * ppu
      const cy = p.y * ppu
      const rp = (p.size / 70) * 15 + 6
      const h = n.sub ? 30 : 16
      const below = { x0: cx - 75, x1: cx + 75, y0: cy + rp + 2, y1: cy + rp + 2 + h }
      const above = { x0: cx - 75, x1: cx + 75, y0: cy - rp - 2 - h, y1: cy - rp - 2 }
      boxes.push({ x0: cx - rp, x1: cx + rp, y0: cy - rp, y1: cy + rp })
      if (!hit(below) || hit(above)) boxes.push(below)
      else { out.add(n.id); boxes.push(above) }
    }
    return out
  }, [vis.nodes, placed, ppu, compact])
  const hoverNode = hover ? vis.nodes.find((n) => n.id === hover) ?? null : null
  const vb = `${-W / 2 / view.k + view.x} ${-H / 2 / view.k + view.y} ${W / view.k} ${H / view.k}`

  const zoom = (factor: number) => setView((v) => ({ ...v, k: Math.min(4, Math.max(0.5, v.k * factor)) }))
  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    if (compact) return
    e.preventDefault()
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12)
  }
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (compact || (e.target as Element).closest('[data-node]')) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const el = e.currentTarget.getBoundingClientRect()
    const scale = W / view.k / Math.max(1, el.width)
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
    setView((v) => ({ ...v, x: d.vx - (e.clientX - d.x) * scale, y: d.vy - (e.clientY - d.y) * scale }))
  }
  const onUp = () => { drag.current = null }

  const pick = (n: NetworkNode) => {
    if (n.id === PROPERTY_CLUSTER_ID) { setExpanded(true); return }
    const a = nodeAnchor(n)
    if (a && onOpen) onOpen(a)
  }

  const anchorId = network.anchor.nodeId
  return (
    <div ref={boxRef} className={cx('egdk-graph', compact && 'is-compact')} data-nodes={vis.nodes.length} data-edges={vis.edges.length} style={{ ['--k' as string]: k }}>
      <svg
        className="egdk-graph__svg"
        viewBox={vb}
        role="img"
        aria-label={label ?? `Relationship network of ${network.owner.name}: ${vis.nodes.length} records, ${vis.edges.length} links`}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={compact && onExpand ? onExpand : undefined}
      >
        <defs>
          <radialGradient id="egdk-hub" cx="50%" cy="40%" r="65%">
            <stop offset="0%" stopColor="var(--egdk-hub-hi)" />
            <stop offset="100%" stopColor="var(--egdk-hub-lo)" />
          </radialGradient>
        </defs>
        {!compact ? [176, 300].filter((r) => r < extent + 40).map((r) => <circle key={r} r={r} className="egdk-graph__ring" />) : null}
        <g className="egdk-graph__edges">
          {vis.edges.map((e, i) => {
            const a = placed.get(e.from)
            const b = placed.get(e.to)
            if (!a || !b) return null
            const dim = near && !(near.has(e.from) && near.has(e.to))
            return <line key={`${e.from}>${e.to}:${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={cx('egdk-edge', `is-${e.kind}`, dim && 'is-dim', near && !dim && 'is-lit')} />
          })}
        </g>
        <g className="egdk-graph__nodes">
          {vis.nodes.map((n) => {
            const p = placed.get(n.id)
            if (!p) return null
            const r = ((p.size / 70) * (compact ? 9 : 15) + (compact ? 4 : 6)) * k
            const dim = near && !near.has(n.id)
            const isHub = n.type === 'owner' || (p.x === 0 && p.y === 0)
            const isAnchor = n.id === anchorId
            const opens = Boolean(nodeAnchor(n)) || n.id === PROPERTY_CLUSTER_ID
            const showLabel = !compact || isHub
            return (
              <g
                key={n.id}
                data-node={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className={cx('egdk-node', `is-${n.type}`, dim && 'is-dim', isHub && 'is-hub', isAnchor && 'is-anchor', opens && 'is-opens', Boolean(n.meta?.distress) && 'is-distress', Boolean(n.meta?.wrong) && 'is-wrong')}
                onPointerEnter={(e) => {
                  if (compact) return
                  setHover(n.id)
                  const rect = boxRef.current?.getBoundingClientRect()
                  if (rect) setHoverAt({ x: e.clientX - rect.left, y: e.clientY - rect.top })
                }}
                onPointerLeave={() => !compact && setHover((h) => (h === n.id ? null : h))}
                onClick={(e) => { if (compact) return; e.stopPropagation(); pick(n) }}
                tabIndex={compact || !opens ? -1 : 0}
                role={compact || !opens ? undefined : 'button'}
                aria-label={compact || !opens ? undefined : `${TYPE_LABEL[n.type] ?? n.type}: ${n.label}`}
                onKeyDown={(e) => { if (!compact && opens && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(n) } }}
              >
                <circle r={r} className="egdk-node__disc" fill={isHub ? 'url(#egdk-hub)' : undefined} />
                {isAnchor && !isHub ? <circle r={r + 5 * k} className="egdk-node__halo" /> : null}
                {n.id === PROPERTY_CLUSTER_ID ? <text className="egdk-node__count" dy="0.35em">{n.label}</text> : null}
                {showLabel ? (
                  <text className="egdk-node__label" y={labelAbove.has(n.id) ? -r - (n.sub ? 22 : 8) * k : r + (compact ? 11 : 15) * k}>
                    {truncate(n.label, isHub ? 30 : compact ? 18 : 20)}
                  </text>
                ) : null}
                {!compact && n.sub && (isHub || n.type === 'property' || n.type === 'related_owner' || n.type === 'sale' || n.type === 'mortgage') ? (
                  <text className="egdk-node__sub" y={labelAbove.has(n.id) ? -r - 8 * k : r + 28 * k}>{truncate(subFor(n), 26)}</text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>

      {!compact ? (
        <>
          <div className="egdk-graph__tools">
            <LCButton size="sm" variant="quiet" aria-label="Zoom in" onClick={() => zoom(1.25)}>+</LCButton>
            <LCButton size="sm" variant="quiet" aria-label="Zoom out" onClick={() => zoom(0.8)}>−</LCButton>
            <LCIconButton icon="maximize" label="Fit network" size="sm" variant="glass" onClick={() => setView({ k: 1, x: 0, y: 0 })} />
          </div>
          {vis.hiddenProperties > 0 ? (
            <p className="egdk-graph__note">Showing the {vis.nodes.filter((n) => n.type === 'property' && n.id !== PROPERTY_CLUSTER_ID).length} most valuable properties · {vis.hiddenProperties} more in the cluster</p>
          ) : null}
          {hoverNode ? (
            <GraphHoverCard
              node={hoverNode}
              network={network}
              outreach={outreach}
              style={hoverAt ? cardPosition(hoverAt, box, cardH) : undefined}
              measure={setCardH}
            />
          ) : null}
        </>
      ) : onExpand ? (
        <button type="button" className="egdk-graph__expand" onClick={onExpand} title="Open the relationship view">
          <span>{vis.nodes.length} records · {vis.edges.length} links</span>
          <span className="egdk-graph__expand-cta">Open graph</span>
        </button>
      ) : null}
    </div>
  )
}

function subFor(n: NetworkNode): string {
  if (n.type === 'property' && typeof n.meta?.value === 'number') return `${fmtMoney(n.meta.value as number)}${n.sub ? ` · ${n.sub}` : ''}`
  return n.sub ?? ''
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/** Beside the pointer, flipped / lifted to stay inside the pane (the card's measured height). */
function cardPosition(at: { x: number; y: number }, box: { w: number; h: number }, measured: number): CSSProperties {
  const W = 320
  const H = Math.min(measured, box.h - 16)
  const left = at.x + 18 + W > box.w ? Math.max(8, at.x - 18 - W) : at.x + 18
  const top = Math.min(Math.max(8, at.y - 40), Math.max(8, box.h - H - 8))
  return { left, top, right: 'auto', bottom: 'auto' }
}
