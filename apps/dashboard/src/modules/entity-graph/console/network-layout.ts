/**
 * Constellation layout for one ownership network, built for a phone screen.
 *
 * The controlling owner is the hub. Every relationship type owns a SECTOR, so
 * a glance reads the network's shape without reading a label:
 *
 *                 people ↖ (contacts fan outward)    ↗ title entities (LLC/trust)
 *     related owners ← mailing ─── OWNER ─── conversations
 *                        ↙  properties, in bands, across the bottom  ↘
 *
 * Deterministic (no physics): the same network always draws the same way, the
 * anchor property sits at the front of the first band, and a large portfolio
 * collapses into a "+N more" cluster that expands on request — the defence
 * against a 186-property owner turning into noise.
 */
import type { NetworkEdge, NetworkNode } from './entity-network-api'

export interface Placed {
  id: string
  x: number
  y: number
  size: number
  angle: number
  ring: number
}

export const PROPERTY_CLUSTER_ID = 'cluster:properties'
export const COLLAPSED_PROPERTY_LIMIT = 18

const DEG = Math.PI / 180

function arc(ids: string[], start: number, end: number, r0: number, spacing: number, step: number, size: number, ring: number, out: Map<string, Placed>) {
  let i = 0
  let r = r0
  let band = 0
  while (i < ids.length) {
    const span = (end - start) * DEG
    const cap = Math.max(1, Math.floor((span * r) / spacing))
    const n = Math.min(cap, ids.length - i)
    for (let k = 0; k < n; k++) {
      // Centre a partial band inside the sector, and stagger alternate bands.
      const t = n === 1 ? 0.5 : (k + 0.5) / n
      const a = (start + (end - start) * t + (band % 2 ? (end - start) / (cap * 2 + 2) : 0)) * DEG
      out.set(ids[i + k], { id: ids[i + k], x: Math.cos(a) * r, y: Math.sin(a) * r, size, angle: a, ring: ring + band })
    }
    i += n
    r += step
    band += 1
  }
}

export interface VisibleNetwork {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  hiddenProperties: number
}

/** Collapse a big portfolio to its most valuable properties + a cluster node. */
export function visibleNetwork(nodes: NetworkNode[], edges: NetworkEdge[], opts: { expanded: boolean; anchorId: string; hiddenTypes: Set<string> }): VisibleNetwork {
  const hub = nodes.find((n) => n.type === 'owner')
  let props = nodes.filter((n) => n.type === 'property')
  let hidden = 0
  if (!opts.expanded && props.length > COLLAPSED_PROPERTY_LIMIT) {
    const anchor = props.find((p) => p.id === opts.anchorId)
    const byValue = props.filter((p) => p.id !== opts.anchorId).sort((a, b) => Number(b.meta.value ?? 0) - Number(a.meta.value ?? 0))
    const keep = [...(anchor ? [anchor] : []), ...byValue.slice(0, COLLAPSED_PROPERTY_LIMIT - (anchor ? 1 : 0))]
    hidden = props.length - keep.length
    props = keep
  }
  const keepIds = new Set(props.map((p) => p.id))
  const outNodes = nodes.filter((n) => (n.type !== 'property' || keepIds.has(n.id)) && !opts.hiddenTypes.has(n.type) && !(n.type === 'email' && opts.hiddenTypes.has('phone')))
  if (hidden > 0 && !opts.hiddenTypes.has('property')) {
    outNodes.push({ id: PROPERTY_CLUSTER_ID, type: 'property', label: `+${hidden}`, sub: 'more properties', meta: { cluster: true, count: hidden } })
  }
  const ids = new Set(outNodes.map((n) => n.id))
  const outEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  if (hidden > 0 && hub && ids.has(PROPERTY_CLUSTER_ID)) outEdges.push({ from: hub.id, to: PROPERTY_CLUSTER_ID, kind: 'owns', label: `Owns ${hidden} more` })
  return { nodes: outNodes, edges: outEdges, hiddenProperties: hidden }
}

export function layoutNetwork(nodes: NetworkNode[], edges: NetworkEdge[], anchorId: string): { placed: Map<string, Placed>; radius: number } {
  const out = new Map<string, Placed>()
  const hub = nodes.find((n) => n.type === 'owner')
  if (hub) out.set(hub.id, { id: hub.id, x: 0, y: 0, size: 70, angle: 0, ring: 0 })

  const of = (t: string) => nodes.filter((n) => n.type === t).map((n) => n.id)

  // Properties — the anchor first, the cluster last.
  const props = of('property').filter((id) => id !== PROPERTY_CLUSTER_ID)
  const ordered = [...props.filter((id) => id === anchorId), ...props.filter((id) => id !== anchorId)]
  if (out.size === 0 && ordered.length === 1) {
    // A property with no linked owner record: it is the hub.
    out.set(ordered[0], { id: ordered[0], x: 0, y: 0, size: 70, angle: 0, ring: 0 })
  } else {
    // Front-centre for the anchor: the band fills outward from 90°.
    const front = ordered.length ? [...ordered] : []
    const centred: string[] = []
    front.forEach((id, i) => { if (i % 2) centred.push(id); else centred.unshift(id) })
    arc(ordered.length ? centred : [], 26, 154, 176, 58, 64, 44, 2, out)
    if (ordered[0] && out.get(ordered[0])) {
      // Pin the anchor to the middle of the first band.
      const first = out.get(ordered[0])!
      const mid = [...out.values()].find((p) => p.ring === 2 && Math.abs(p.angle - 90 * DEG) < 6 * DEG)
      if (mid && mid.id !== first.id) { const { x, y, angle } = mid; mid.x = first.x; mid.y = first.y; mid.angle = first.angle; first.x = x; first.y = y; first.angle = angle }
      first.size = 54
    }
  }
  if (nodes.some((n) => n.id === PROPERTY_CLUSTER_ID)) {
    const maxR = Math.max(176, ...[...out.values()].filter((p) => p.ring >= 2).map((p) => Math.hypot(p.x, p.y)))
    const a = 90 * DEG
    out.set(PROPERTY_CLUSTER_ID, { id: PROPERTY_CLUSTER_ID, x: Math.cos(a) * (maxR + 78), y: Math.sin(a) * (maxR + 78), size: 58, angle: a, ring: 9 })
  }

  // Ring one: mailing (left), people (upper-left), title entities (upper-right), conversations (right).
  const mailing = of('mailing')
  arc(mailing, 180, 180, 128, 60, 56, 44, 1, out)
  const people = of('person')
  arc(people, 212, 258, 132, 62, 58, 48, 1, out)
  const entities = of('entity')
  arc(entities, 282, 338, 136, 62, 58, 46, 1, out)
  const convos = of('conversation')
  arc(convos, 348, 372, 150, 60, 56, 40, 1, out)

  // Related owners fan out beyond the mailing address.
  arc(of('related_owner'), 168, 214, 236, 54, 56, 42, 3, out)

  // Contact points fan outward from the person they reach (or the hub).
  const contacts = nodes.filter((n) => n.type === 'phone' || n.type === 'email')
  const byParent = new Map<string, string[]>()
  for (const c of contacts) {
    const e = edges.find((x) => x.to === c.id && x.kind === 'reaches')
    const parent = e && out.has(e.from) ? e.from : hub?.id ?? ''
    byParent.set(parent, [...(byParent.get(parent) ?? []), c.id])
  }
  for (const [parent, ids] of byParent) {
    const p = out.get(parent)
    const baseAngle = p && (p.x !== 0 || p.y !== 0) ? p.angle : 235 * DEG
    const baseR = p ? Math.hypot(p.x, p.y) + 86 : 220
    ids.forEach((id, i) => {
      const spread = 13 * DEG
      const a = baseAngle + (i - (ids.length - 1) / 2) * spread
      const r = baseR + (i % 2) * 34
      out.set(id, { id, x: Math.cos(a) * r, y: Math.sin(a) * r, size: 34, angle: a, ring: 3 })
    })
  }

  // Anything left (unknown types) circles far out rather than stacking at 0,0.
  const rest = nodes.filter((n) => !out.has(n.id)).map((n) => n.id)
  arc(rest, 0, 360, 320, 56, 56, 36, 5, out)

  let radius = 160
  for (const p of out.values()) radius = Math.max(radius, Math.hypot(p.x, p.y) + p.size)
  return { placed: out, radius }
}

/** The node's immediate neighbourhood (for focus dimming and path glow). */
export function neighbours(edges: NetworkEdge[], id: string): Set<string> {
  const s = new Set<string>([id])
  for (const e of edges) {
    if (e.from === id) s.add(e.to)
    if (e.to === id) s.add(e.from)
  }
  return s
}
