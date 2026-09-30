/**
 * The relationship stage — one ownership network as a living constellation.
 *
 * Glass nodes sit over an SVG edge field. Focusing a node lights its edges
 * (a slow current runs along them) and recedes everything else; selecting a
 * node rings it. Pan is one finger, zoom is a pinch (or the wheel), a tap
 * focuses, a long-press selects. The viewport lives in a ref and is written
 * straight to the transform — panning never re-renders the nodes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import type { NetworkEdge, NetworkNode } from './entity-network-api'
import { money } from './entity-network-api'
import { layoutNetwork, neighbours, PROPERTY_CLUSTER_ID } from './network-layout'
import { NetworkFx } from './NetworkFx'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export const NODE_ICON: Record<string, IconName> = {
  owner: 'star',
  property: 'home',
  entity: 'briefcase',
  person: 'user',
  phone: 'phone',
  email: 'mail',
  mailing: 'inbox',
  related_owner: 'link',
  conversation: 'message',
  mortgage: 'dollar-sign',
  lien: 'alert',
  sale: 'refresh-cw',
  buyer: 'target',
}

export const TYPE_TONE: Record<string, string> = {
  owner: 'var(--egx-owner)', property: 'var(--egx-property)', entity: 'var(--egx-entity)', person: 'var(--egx-person)',
  phone: 'var(--egx-contact)', email: 'var(--egx-contact)', mailing: 'var(--egx-mailing)', related_owner: 'var(--egx-related)', conversation: 'var(--egx-convo)',
  mortgage: 'var(--egx-debt)', lien: 'var(--egx-lien)', sale: 'var(--egx-sale)', buyer: 'var(--egx-buyer)',
}

export const EDGE_TONE: Record<string, string> = {
  owns: 'var(--egx-owner)',
  titled_as: 'var(--egx-entity)',
  person_of: 'var(--egx-person)',
  reaches: 'var(--egx-contact)',
  mails_to: 'var(--egx-mailing)',
  household: 'var(--egx-related)',
  cluster: 'var(--egx-related)',
  mailing: 'var(--egx-related)',
  conversation: 'var(--egx-convo)',
  financed_by: 'var(--egx-debt)',
  encumbered_by: 'var(--egx-lien)',
  sold: 'var(--egx-sale)',
  purchased_by: 'var(--egx-buyer)',
  sold_by: 'var(--egx-buyer)',
}

type View = { x: number; y: number; k: number }

interface Props {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  anchorId: string
  focusId: string | null
  selected: ReadonlySet<string>
  selectMode: boolean
  fitKey: string
  onFocus: (id: string | null) => void
  onToggleSelect: (id: string) => void
  onExpandCluster: () => void
  reducedMotion?: boolean
}

export function EntityNetworkStage({ nodes, edges, anchorId, focusId, selected, selectMode, fitKey, onFocus, onToggleSelect, onExpandCluster, reducedMotion }: Props) {
  const { placed, radius } = useMemo(() => layoutNetwork(nodes, edges, anchorId), [nodes, edges, anchorId])
  const lit = useMemo(() => (focusId ? neighbours(edges, focusId) : null), [edges, focusId])
  const typeOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.type])), [nodes])

  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const panMoved = useRef(false)
  const worldR = useRef(0)
  const [zoomTier, setZoomTier] = useState<'far' | 'mid' | 'near'>('mid')

  const apply = useCallback((animate = false) => {
    const w = worldRef.current
    if (!w) return
    const { x, y, k } = view.current
    const R = worldR.current
    w.style.transition = animate && !reducedMotion ? 'transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
    // The world's (0,0) is its centre (R,R): fold that offset into the transform.
    w.style.transform = `translate3d(${x - R * k}px, ${y - R * k}px, 0) scale(${k})`
    const tier = k < 0.62 ? 'far' : k < 1.05 ? 'mid' : 'near'
    setZoomTier((t) => (t === tier ? t : tier))
  }, [reducedMotion])

  // The visible band: under the header + layer chips, above the sheet, left of the rail.
  const band = useCallback(() => {
    const s = stageRef.current!.getBoundingClientRect()
    const sheet = document.querySelector('.egx-sheet') as HTMLElement | null
    const sr = sheet ? sheet.getBoundingClientRect() : null
    // Desk: the inspector is a panel BESIDE the stage (entity-graph-desktop.css),
    // not a sheet beneath it, so the band is the stage's full height, under the
    // layer chips and left of the panel. A phone's sheet always spans the width.
    if (sr && sr.width > 0 && sr.left >= s.left + s.width * 0.5) {
      const chips = document.querySelector('.egx-layers') as HTMLElement | null
      const top = chips ? Math.max(24, chips.getBoundingClientRect().bottom - s.top + 20) : 186
      return { left: 24, right: Math.min(s.width - 58, sr.left - s.left - 24), top, bottom: Math.max(top + 200, s.height - 24), width: s.width, height: s.height }
    }
    const sheetTop = sr ? sr.top - s.top : s.height * 0.66
    return { left: 12, right: s.width - 58, top: 186, bottom: Math.max(260, Math.min(s.height, sheetTop) - 14), width: s.width, height: s.height }
  }, [])

  const fit = useCallback((animate = true, around?: { x: number; y: number }) => {
    const s = stageRef.current
    if (!s) return
    const b = band()
    if (around) {
      const k = Math.max(1, view.current.k)
      view.current = { k, x: (b.left + b.right) / 2 - around.x * k, y: (b.top + b.bottom) / 2 - around.y * k }
      apply(animate)
      return
    }
    // Fit the network's real extent (labels included), not a circle around the hub.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of placed.values()) {
      minX = Math.min(minX, p.x - p.size / 2 - 8); maxX = Math.max(maxX, p.x + p.size / 2 + 8)
      minY = Math.min(minY, p.y - p.size / 2 - 6); maxY = Math.max(maxY, p.y + p.size / 2 + 26)
    }
    if (!Number.isFinite(minX)) { minX = -radius; maxX = radius; minY = -radius; maxY = radius }
    const k = Math.max(0.3, Math.min(1.3, Math.min((b.right - b.left) / (maxX - minX), (b.bottom - b.top) / (maxY - minY))))
    view.current = { k, x: (b.left + b.right) / 2 - ((minX + maxX) / 2) * k, y: (b.top + b.bottom) / 2 - ((minY + maxY) / 2) * k }
    apply(animate)
  }, [apply, band, placed, radius])

  // Fit when the network changes (a new anchor, an expansion).
  // Cinematic open: the camera starts pulled back and pushes in to frame the network.
  useLayoutEffect(() => {
    fit(false)
    if (!reducedMotion) {
      const s = stageRef.current?.getBoundingClientRect()
      if (s) {
        const v = view.current
        const k0 = v.k * 0.62
        view.current = { k: k0, x: s.width / 2 - ((s.width / 2 - v.x) / v.k) * k0, y: s.height * 0.42 - ((s.height * 0.42 - v.y) / v.k) * k0 }
        apply(false)
      }
    }
    const t = window.setTimeout(() => fit(true), 60)
    const t2 = window.setTimeout(() => fit(true), 520)
    return () => { window.clearTimeout(t); window.clearTimeout(t2) }
  }, [fitKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Gestures: pan, pinch, wheel. Taps are resolved on the node buttons.
  useEffect(() => {
    const s = stageRef.current
    if (!s) return
    const pts = new Map<number, { x: number; y: number }>()
    let start: { v: View; c: { x: number; y: number }; d: number } | null = null
    const centre = () => {
      const a = [...pts.values()]
      return a.length === 2 ? { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 } : a[0]
    }
    const dist = () => {
      const a = [...pts.values()]
      return a.length === 2 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0
    }
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('[data-egx-control]')) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      start = { v: { ...view.current }, c: centre(), d: dist() }
      panMoved.current = false
    }
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId) || !start) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const c = centre()
      const r = s.getBoundingClientRect()
      if (Math.hypot(c.x - start.c.x, c.y - start.c.y) > 6 || pts.size === 2) panMoved.current = true
      if (pts.size === 2 && start.d > 0) {
        const k = Math.max(0.25, Math.min(3, start.v.k * (dist() / start.d)))
        const wx = (start.c.x - r.left - start.v.x) / start.v.k
        const wy = (start.c.y - r.top - start.v.y) / start.v.k
        view.current = { k, x: c.x - r.left - wx * k, y: c.y - r.top - wy * k }
      } else {
        view.current = { ...view.current, x: start.v.x + (c.x - start.c.x), y: start.v.y + (c.y - start.c.y) }
      }
      apply(false)
    }
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      start = pts.size ? { v: { ...view.current }, c: centre(), d: dist() } : null
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = s.getBoundingClientRect()
      const k0 = view.current.k
      const k = Math.max(0.25, Math.min(3, k0 * Math.exp(-e.deltaY * 0.0015)))
      const wx = (e.clientX - r.left - view.current.x) / k0
      const wy = (e.clientY - r.top - view.current.y) / k0
      view.current = { k, x: e.clientX - r.left - wx * k, y: e.clientY - r.top - wy * k }
      apply(false)
    }
    s.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    s.addEventListener('wheel', wheel, { passive: false })
    return () => {
      s.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      s.removeEventListener('wheel', wheel)
    }
  }, [apply])

  // Tap vs long-press vs drag, per node.
  const press = useRef<{ id: string; x: number; y: number; t: number; timer: number; fired: boolean } | null>(null)
  const onNodeDown = (id: string) => (e: React.PointerEvent) => {
    const timer = window.setTimeout(() => {
      if (!press.current || press.current.id !== id) return
      press.current.fired = true
      try { navigator.vibrate?.(10) } catch { /* unsupported */ }
      onToggleSelect(id)
    }, 460)
    press.current = { id, x: e.clientX, y: e.clientY, t: Date.now(), timer, fired: false }
  }
  const onNodeUp = (id: string) => (e: React.PointerEvent) => {
    const p = press.current
    press.current = null
    if (!p || p.id !== id) return
    window.clearTimeout(p.timer)
    if (p.fired) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 9) return // it was a drag
    if (id === PROPERTY_CLUSTER_ID) { onExpandCluster(); return }
    if (selectMode) { onToggleSelect(id); return }
    onFocus(focusId === id ? null : id)
    const at = placed.get(id)
    if (at && focusId !== id) fit(true, { x: at.x, y: at.y })
  }
  const onNodeCancel = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = null }

  const R = radius + 40
  const size = R * 2
  worldR.current = R

  return (
    <div ref={stageRef} className={cls('egx-stage', `is-${zoomTier}`, focusId && 'has-focus', selectMode && 'is-selecting')} onClick={(e) => { if (panMoved.current) return; if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('egx-world')) onFocus(null) }}>
      <div className="egx-aurora" aria-hidden="true"><i /><i /><i /></div>
      <NetworkFx nodes={nodes} edges={edges} placed={placed} lit={lit} view={view} epoch={fitKey} reducedMotion={reducedMotion} />
      <div ref={worldRef} className="egx-world" style={{ width: size, height: size }}>
        <svg className="egx-edges" width={size} height={size} viewBox={`${-R} ${-R} ${size} ${size}`} aria-hidden="true">
          <defs>
            {edges.map((e, i) => {
              const a = placed.get(e.from)
              const b = placed.get(e.to)
              if (!a || !b) return null
              return (
                <linearGradient key={`g${i}`} id={`egx-g-${i}`} gradientUnits="userSpaceOnUse" x1={a.x} y1={a.y} x2={b.x} y2={b.y}>
                  <stop offset="0%" style={{ stopColor: TYPE_TONE[typeOf.get(e.from) ?? ''] ?? 'var(--egx-owner)' }} />
                  <stop offset="100%" style={{ stopColor: TYPE_TONE[typeOf.get(e.to) ?? ''] ?? 'var(--egx-property)' }} />
                </linearGradient>
              )
            })}
            <radialGradient id="egx-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--egx-owner)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--egx-owner)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {[150, 230, 310].filter((r) => r < R).map((r) => <circle key={r} r={r} className="egx-orbit" />)}
          <circle r={120} fill="url(#egx-halo)" />
          {edges.map((e, i) => {
            const a = placed.get(e.from)
            const b = placed.get(e.to)
            if (!a || !b) return null
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const dx = b.x - a.x
            const dy = b.y - a.y
            const bend = 0.12
            const cx = mx - dy * bend
            const cy = my + dx * bend
            const on = lit ? lit.has(e.from) && lit.has(e.to) : false
            return (
              <path
                key={`${e.from}>${e.to}:${i}`}
                d={`M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`}
                className={cls('egx-edge', `is-${e.kind}`, on && 'is-lit', lit && !on && 'is-dim')}
                stroke={`url(#egx-g-${i})`}
                style={{ ['--tone' as string]: EDGE_TONE[e.kind] ?? 'var(--egx-contact)', animationDelay: `${Math.min(900, i * 14)}ms` }}
              />
            )
          })}
        </svg>
        {nodes.map((n, i) => {
          const p = placed.get(n.id)
          if (!p) return null
          const isHub = p.ring === 0
          const isAnchor = n.id === anchorId
          const on = lit ? lit.has(n.id) : true
          const cluster = n.id === PROPERTY_CLUSTER_ID
          const value = n.type === 'property' && !cluster ? Number(n.meta.value) : NaN
          const flags = n.type === 'property' && !cluster
            ? [n.meta.hot && 'hot', n.meta.conversation && 'talking', n.meta.activeLien && 'lien', n.meta.taxDelinquent && 'tax'].filter(Boolean) as string[]
            : []
          return (
            <button
              key={n.id}
              type="button"
              data-egx-node={n.id}
              data-egx-type={n.type}
              className={cls(
                'egx-node', `is-${n.type}`, isHub && 'is-hub', isAnchor && 'is-anchor', cluster && 'is-cluster',
                focusId === n.id && 'is-focus', !on && 'is-dim', selected.has(n.id) && 'is-selected',
                n.type === 'entity' && `k-${String(n.meta.kind ?? '')}`, n.type === 'phone' && n.meta.wrong ? 'is-wrong' : null,
              )}
              style={{ left: p.x + R, top: p.y + R, ['--s' as string]: `${p.size}px`, ['--d' as string]: `${Math.min(1100, p.ring * 110 + (i % 12) * 26)}ms` }}
              onPointerDown={onNodeDown(n.id)}
              onPointerUp={onNodeUp(n.id)}
              onPointerCancel={onNodeCancel}
              onPointerLeave={onNodeCancel}
              onContextMenu={(e) => e.preventDefault()}
              aria-pressed={selected.has(n.id)}
              aria-label={`${n.type.replace('_', ' ')}: ${n.label}`}
            >
              <span className="egx-node__orb">
                <span className="egx-node__rim" aria-hidden="true" />
                {isHub && <span className="egx-hub-core" aria-hidden="true" />}
                {isHub && <span className="egx-hub-sats" aria-hidden="true"><i /><i /><i /></span>}
                <span className="egx-node__sheen" aria-hidden="true" />
                {cluster ? <b className="egx-node__count">{n.label}</b> : <Icon name={NODE_ICON[n.type] ?? 'grid'} />}
                {selected.has(n.id) && <span className="egx-node__burst" aria-hidden="true" />}
                {selected.has(n.id) && <span className="egx-node__check" aria-hidden="true"><Icon name="check" /></span>}
                {flags.length > 0 && <span className={cls('egx-node__flag', `is-${flags[0]}`)} aria-hidden="true" />}
              </span>
              <span className="egx-node__label">
                <strong>{cluster ? 'more properties' : n.label}</strong>
                {Number.isFinite(value) && value > 0 ? <em>{money(value)}</em> : n.sub && (isHub || n.type !== 'property') ? <em>{n.sub}</em> : null}
              </span>
            </button>
          )
        })}
      </div>
      <div className="egx-stage__rail" data-egx-control>
        <button type="button" className="egx-ctl" aria-label="Fit the network" onClick={() => { onFocus(null); fit(true) }}><Icon name="maximize" /></button>
        <button type="button" className="egx-ctl" aria-label="Zoom in" onClick={() => { const s = stageRef.current!.getBoundingClientRect(); const k0 = view.current.k; const k = Math.min(3, k0 * 1.35); view.current = { k, x: s.width / 2 - ((s.width / 2 - view.current.x) / k0) * k, y: s.height / 2 - ((s.height / 2 - view.current.y) / k0) * k }; apply(true) }}>+</button>
        <button type="button" className="egx-ctl" aria-label="Zoom out" onClick={() => { const s = stageRef.current!.getBoundingClientRect(); const k0 = view.current.k; const k = Math.max(0.25, k0 / 1.35); view.current = { k, x: s.width / 2 - ((s.width / 2 - view.current.x) / k0) * k, y: s.height / 2 - ((s.height / 2 - view.current.y) / k0) * k }; apply(true) }}>−</button>
      </div>
    </div>
  )
}
