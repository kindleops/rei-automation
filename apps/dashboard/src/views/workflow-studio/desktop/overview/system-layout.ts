import type { GraphModel, GraphNodeView } from '../canvas/GraphCanvas'
import type { SystemEdge, SystemNode } from '../lib/types'

/**
 * SYSTEM MAP LAYOUT — deterministic, sized to read on a laptop pane.
 *
 *   row −1  what feeds a decision: delivery reconciliation · offer negotiation ·
 *           acquisition decision · lead-state reconcile (buyer matching, which
 *           nothing invokes automatically, sits apart in the corner)
 *   row  0  the spine, a lead's life left to right: campaign → dispatch →
 *           TextGrid → seller conversation → pipeline
 *   row  1  what the conversation sets off: suppression ← DNC · event bridge →
 *           Studio orchestrator
 *   row  2  after the deal: closing → email → Brevo · operator notifications
 *
 * Positions are a design decision; every connector comes from the server's
 * evidence list. Connectors are orthogonal with rounded corners and leave a
 * module from an ordered port, so the three loops back into dispatch nest
 * instead of crossing. No connector passes through a module (asserted by the
 * layout test). Two crossings are structural and are drawn as line jumps.
 */

const X = 262
const Y = 164
export const SYSTEM_NODE = { w: 208, h: 96 } as const
const HW = SYSTEM_NODE.w / 2
const HH = SYSTEM_NODE.h / 2
const R = 14

const SLOTS: Record<string, [number, number]> = {
  buyer_matching: [0, -1],
  delivery_reconcile: [1, -1],
  offer_negotiation: [2, -1],
  decision_engine: [3, -1],
  lead_state_reconcile: [4, -1],
  campaign_execution: [0, 0],
  queue_dispatch: [1, 0],
  textgrid: [2, 0],
  seller_inbound: [3, 0],
  pipeline: [4, 0],
  suppression: [1, 1],
  dnc_opt_out: [2, 1],
  event_bridge: [3, 1],
  studio_orchestrator: [4, 1],
  closing_execution: [1, 2],
  email_dispatch: [2, 2],
  brevo: [3, 2],
  operator_notifications: [4, 2],
}

type P = [number, number]
const top = (n: GraphNodeView, f = 0): P => [n.x + f * HW, n.y - HH]
const bottom = (n: GraphNodeView, f = 0): P => [n.x + f * HW, n.y + HH]
const left = (n: GraphNodeView, f = 0): P => [n.x - HW, n.y + f * HH]
const right = (n: GraphNodeView, f = 0): P => [n.x + HW, n.y + f * HH]

/** An orthogonal polyline with rounded corners, and the point at `at` of its length (where its label sits). */
export function ortho(points: P[], at = 0.5, r = R): { path: string; mid: { x: number; y: number }; tight: boolean } {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i]; const [cx, cy] = pts[i + 1]
    const lin = Math.hypot(bx - ax, by - ay); const lout = Math.hypot(cx - bx, cy - by)
    const rr = Math.min(r, lin / 2, lout / 2)
    const ix = (bx - ax) / (lin || 1); const iy = (by - ay) / (lin || 1)
    const ox = (cx - bx) / (lout || 1); const oy = (cy - by) / (lout || 1)
    d += ` L ${bx - ix * rr} ${by - iy * rr} Q ${bx} ${by}, ${bx + ox * rr} ${by + oy * rr}`
  }
  const last = pts[pts.length - 1]
  d += ` L ${last[0]} ${last[1]}`
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]))
  let half = lens.reduce((a, b) => a + b, 0) * at
  let mid = { x: pts[0][0], y: pts[0][1] }
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) { const t = lens[i] ? half / lens[i] : 0; mid = { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t }; break }
    half -= lens[i]
  }
  return { path: d, mid, tight: Math.max(...lens) < 96 }
}

export interface SystemLayout extends GraphModel { edgesById: Map<string, SystemEdge>; nodesByKey: Map<string, SystemNode> }

export function layoutSystemMap(nodes: SystemNode[], edges: SystemEdge[]): SystemLayout {
  const placed: GraphNodeView[] = []
  let spare = 0
  for (const n of nodes) {
    const slot = SLOTS[n.key] || [spare++, 3] // a system this map does not know is still placed, in the open row
    placed.push({ key: n.key, x: slot[0] * X, y: slot[1] * Y, w: SYSTEM_NODE.w, h: SYSTEM_NODE.h })
  }
  const byKey = new Map(placed.map((n) => [n.key, n]))
  const maxNodeY = Math.max(...placed.map((n) => n.y + n.h / 2))
  const floor = maxNodeY + 34
  const eastX = Math.max(...placed.map((n) => n.x + n.w / 2)) + 30
  // the band between row −1 and the spine carries two tracks: the direct reply (lower) and the offer loop (upper)
  const gTop = -Y + HH
  const gBot = -HH
  const lowerTrack = gBot - (gBot - gTop) * 0.36
  const upperTrack = gBot - (gBot - gTop) * 0.78
  const between = Y / 2 // spine ↔ row 1
  const below = Y + HH + (Y - 2 * HH) / 2 // row 1 ↔ row 2
  const gapX = (c: number) => c * X + X / 2

  const route = (id: string, a: GraphNodeView, b: GraphNodeView) => {
    switch (id) {
      // three loops back into dispatch, nested: reconciliation straight down, the offer loop on the upper track, the direct reply on the lower
      case 'reconcile__dispatch': return ortho([bottom(a, -0.25), top(b, -0.25)])
      case 'seller__dispatch': { const s = top(a, -0.62); const t = top(b, 0.62); return ortho([s, [s[0], lowerTrack], [t[0], lowerTrack], t]) }
      case 'seller__negotiation': { const s = top(a, -0.3); const t = bottom(b, 0.4); return ortho([s, [s[0], upperTrack], [t[0], upperTrack], t]) }
      case 'negotiation__dispatch': { const s = bottom(a, -0.4); const t = top(b, 0.2); return ortho([s, [s[0], upperTrack], [t[0], upperTrack], t]) }
      case 'seller__decision': return ortho([top(a, 0.15), bottom(b, (a.x + 0.15 * HW - b.x) / HW)])
      case 'lead_state__seller': { const s = bottom(a, -0.6); const t = top(b, 0.6); const m = (gTop + gBot) / 2; return ortho([s, [s[0], m], [t[0], m], t]) }
      // the provider relationship, both directions, bent apart
      case 'dispatch__textgrid': return ortho([right(a, -0.3), left(b, -0.3)])
      case 'textgrid__dispatch': return ortho([left(a, 0.3), right(b, 0.3)])
      // what the conversation sets off, below the spine
      case 'seller__dnc': { const s = bottom(a, -0.55); const t = top(b, 0.45); return ortho([s, [s[0], between], [t[0], between], t]) }
      case 'seller__bridge': return ortho([bottom(a, 0.05), top(b, 0.05)])
      case 'suppression__dispatch': return ortho([top(a, 0), bottom(b, 0)])
      // send failures reach the bridge underneath suppression and DNC
      case 'dispatch__bridge': { const s = bottom(a, -0.55); const t = bottom(b, -0.4); const lane = gapX(0); return ortho([s, [s[0], HH + 18], [lane, HH + 18], [lane, below], [t[0], below], t], 0.63) }
      // notifications: the reply down the gap beside the bridge (one line jump), campaign and closing along the floor
      case 'seller__notifications': { const s = bottom(a, 0.6); const t = left(b, 0); const lane = gapX(3); return ortho([s, [s[0], HH + 22], [lane, HH + 22], [lane, t[1]], t], 0.71) }
      case 'campaign__notifications': { const s = bottom(a, 0); const t = bottom(b, -0.1); return ortho([s, [s[0], floor], [t[0], floor], t], 0.14) }
      case 'closing__notifications': { const s = bottom(a, 0.3); const t = bottom(b, -0.4); return ortho([s, [s[0], floor - 10], [t[0], floor - 10], t]) }
      // closing authority moves the opportunity's stage: under the floor and up the east side (one line jump)
      case 'closing__pipeline': { const s = bottom(a, -0.3); const t = right(b, 0.4); return ortho([s, [s[0], floor + 14], [eastX, floor + 14], [eastX, t[1]], t], 0.62) }
      default: {
        const dx = b.x - a.x
        const dy = b.y - a.y
        if (Math.abs(dy) < 1) return ortho([dx > 0 ? right(a) : left(a), dx > 0 ? left(b) : right(b)])
        if (Math.abs(dx) < 1) return ortho([dy > 0 ? bottom(a) : top(a), dy > 0 ? top(b) : bottom(b)])
        // any other pair: leave vertically, cross in the row gap, arrive vertically
        const s = dy > 0 ? bottom(a, Math.sign(dx) * 0.42) : top(a, Math.sign(dx) * 0.42)
        const t = dy > 0 ? top(b, -Math.sign(dx) * 0.42) : bottom(b, -Math.sign(dx) * 0.42)
        const m = (s[1] + t[1]) / 2
        return ortho([s, [s[0], m], [t[0], m], t])
      }
    }
  }

  const out = edges.filter((e) => byKey.has(e.from) && byKey.has(e.to)).map((e) => {
    const { path, mid, tight } = route(e.id, byKey.get(e.from)!, byKey.get(e.to)!)
    return { id: e.id, from: e.from, to: e.to, path, mid, back: false, tight }
  })
  const usesEast = out.some((e) => e.id === 'closing__pipeline')
  const usesFloor = out.some((e) => /notifications|closing__pipeline/.test(e.id) && e.id !== 'studio__notifications' && e.id !== 'seller__notifications')
  const minX = Math.min(...placed.map((n) => n.x - n.w / 2))
  const maxX = Math.max(usesEast ? eastX + 6 : -Infinity, ...placed.map((n) => n.x + n.w / 2))
  const minY = Math.min(...placed.map((n) => n.y - n.h / 2))
  const maxY = usesFloor ? floor + 20 : maxNodeY
  return {
    nodes: placed,
    edges: out,
    sections: [],
    bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    byKey,
    edgesById: new Map(edges.map((e) => [e.id, e])),
    nodesByKey: new Map(nodes.map((n) => [n.key, n])),
  }
}

/** Upstream ∪ downstream of a system (its dependencies and the effects it sets off). */
export function neighbourhood(key: string, edges: SystemEdge[]): { up: string[]; down: string[] } {
  return { up: [...new Set(edges.filter((e) => e.to === key).map((e) => e.from))], down: [...new Set(edges.filter((e) => e.from === key).map((e) => e.to))] }
}
