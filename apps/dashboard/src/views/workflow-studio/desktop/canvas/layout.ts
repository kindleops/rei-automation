import { FAMILY } from '../families'
import type { EdgeKind, NodeFamily, Topology, TopologyGroup, TopologyNode } from '../observatory-types'

/**
 * DETERMINISTIC AUTO-LAYOUT — left to right, always.
 *
 *   rank  longest path from the trigger over forward edges (retry edges are
 *         back-edges and never push a node right)
 *   lane  authored in the topology: 0 is the primary path (the spine),
 *         negative lanes sit above it (human review — easy to see), positive
 *         lanes below it (exceptions, failures); the exception lanes are
 *         offset by the spine's tallest column so nothing ever overlaps
 *   stack several nodes in one (rank, lane) cell stack vertically — parallel
 *         alternatives (e.g. the seller signals) read as one column
 *
 * Groups give progressive disclosure: a collapsed group is ONE node standing in
 * for its members (edges re-attached, internal edges dropped, telemetry summed
 * by the caller through `members`). Same input → same pixels, every time.
 */

export const COL = 268
export const PITCH = 100
export const LANE_GAP = 44

export interface LayoutNode {
  key: string
  family: NodeFamily
  label: string
  x: number
  y: number
  w: number
  h: number
  rank: number
  lane: number
  order: number
  node: TopologyNode | null
  group: TopologyGroup | null
  members: string[]
}

export interface LayoutEdge {
  id: string
  ids: string[]
  from: string
  to: string
  kind: EdgeKind
  label: string | null
  path: string
  mid: { x: number; y: number }
  back: boolean
}

export interface Layout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  bounds: { x: number; y: number; w: number; h: number }
  byKey: Map<string, LayoutNode>
  /** topology node key → the visible node that stands for it */
  owner: Map<string, string>
}

const groupKey = (k: string) => `group:${k}`

export function visibleGraph(topology: Topology, expanded: ReadonlySet<string>) {
  const order = new Map(topology.nodes.map((n, i) => [n.key, i]))
  const groups = new Map(topology.groups.map((g) => [g.key, g]))
  const owner = new Map<string, string>()
  const nodes: Array<{ key: string; family: NodeFamily; label: string; lane: number; order: number; node: TopologyNode | null; group: TopologyGroup | null; members: string[] }> = []
  const seenGroup = new Set<string>()
  for (const n of topology.nodes) {
    const g = n.group ? groups.get(n.group) : null
    if (g && !expanded.has(g.key)) {
      owner.set(n.key, groupKey(g.key))
      if (seenGroup.has(g.key)) continue
      seenGroup.add(g.key)
      const members = topology.nodes.filter((m) => m.group === g.key)
      nodes.push({ key: groupKey(g.key), family: g.family, label: g.label, lane: members[0]?.lane ?? 0, order: order.get(members[0].key) ?? 0, node: null, group: g, members: members.map((m) => m.key) })
      continue
    }
    owner.set(n.key, n.key)
    nodes.push({ key: n.key, family: n.family, label: n.label, lane: n.lane ?? 0, order: order.get(n.key) ?? 0, node: n, group: null, members: [n.key] })
  }
  const merged = new Map<string, { id: string; ids: string[]; from: string; to: string; kind: EdgeKind; label: string | null; labels: Set<string> }>()
  for (const e of topology.edges) {
    const from = owner.get(e.from)
    const to = owner.get(e.to)
    if (!from || !to || from === to) continue
    const k = `${from}>${to}>${e.kind}`
    const prev = merged.get(k)
    if (prev) { prev.ids.push(e.id); if (e.label) prev.labels.add(e.label); continue }
    merged.set(k, { id: e.id, ids: [e.id], from, to, kind: e.kind, label: e.label ?? null, labels: new Set(e.label ? [e.label] : []) })
  }
  const edges = [...merged.values()].map((m) => ({ id: m.id, ids: m.ids, from: m.from, to: m.to, kind: m.kind, label: m.labels.size === 1 ? [...m.labels][0] : m.labels.size ? null : m.label }))
  return { nodes, edges, owner }
}

function ranks(nodes: Array<{ key: string; order: number }>, edges: Array<{ from: string; to: string; kind: EdgeKind }>) {
  const fwd = edges.filter((e) => e.kind !== 'retry')
  const indeg = new Map(nodes.map((n) => [n.key, 0]))
  const out = new Map<string, string[]>()
  for (const e of fwd) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
    ;(out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e.to)
  }
  const orderOf = new Map(nodes.map((n) => [n.key, n.order]))
  const rank = new Map(nodes.map((n) => [n.key, 0]))
  const ready = nodes.filter((n) => !indeg.get(n.key)).map((n) => n.key)
  const done = new Set<string>()
  const byOrder = (a: string, b: string) => (orderOf.get(a) || 0) - (orderOf.get(b) || 0)
  ready.sort(byOrder)
  while (ready.length) {
    const k = ready.shift()!
    done.add(k)
    for (const t of out.get(k) || []) {
      rank.set(t, Math.max(rank.get(t) || 0, (rank.get(k) || 0) + 1))
      indeg.set(t, (indeg.get(t) || 0) - 1)
      if (!indeg.get(t)) { ready.push(t); ready.sort(byOrder) }
    }
  }
  // a cycle among forward edges is a topology bug; place leftovers after their placed parents
  for (const n of nodes) if (!done.has(n.key)) rank.set(n.key, Math.max(rank.get(n.key) || 0, 1))
  return rank
}

const bez = (p0: number, p1: number, p2: number, p3: number) => (p0 + 3 * p1 + 3 * p2 + p3) / 8

export function layoutTopology(topology: Topology, expanded: ReadonlySet<string> = new Set()): Layout {
  const g = visibleGraph(topology, expanded)
  const rank = ranks(g.nodes, g.edges)
  const size = (f: NodeFamily, isGroup: boolean) => ({ w: FAMILY[f].w + (isGroup ? 8 : 0), h: FAMILY[f].h + (isGroup ? 6 : 0) })

  // cells: (rank, lane) → nodes in topology order
  const cells = new Map<string, typeof g.nodes>()
  for (const n of g.nodes) {
    const k = `${rank.get(n.key)}:${n.lane}`
    ;(cells.get(k) || cells.set(k, []).get(k)!).push(n)
  }
  for (const list of cells.values()) list.sort((a, b) => a.order - b.order)
  // how many nodes each lane ever stacks — lane offsets are global so lanes never collide
  const depth = new Map<number, number>()
  for (const [k, list] of cells) { const lane = Number(k.split(':')[1]); depth.set(lane, Math.max(depth.get(lane) || 0, list.length)) }
  const lanes = [...depth.keys()].sort((a, b) => a - b)
  const spineHalf = (((depth.get(0) || 1) - 1) * PITCH) / 2 + 40
  const laneStart = new Map<number, number>([[0, 0]])
  let down = spineHalf
  for (const l of lanes.filter((x) => x > 0)) { laneStart.set(l, down + LANE_GAP + 34); down += LANE_GAP + (depth.get(l) || 1) * PITCH }
  let up = spineHalf
  for (const l of lanes.filter((x) => x < 0).reverse()) { laneStart.set(l, -(up + LANE_GAP + 34)); up += LANE_GAP + (depth.get(l) || 1) * PITCH }

  const out: LayoutNode[] = []
  for (const [k, list] of cells) {
    const [r, lane] = k.split(':').map(Number)
    list.forEach((n, i) => {
      const { w, h } = size(n.family, Boolean(n.group))
      const y = lane === 0 ? (i - (list.length - 1) / 2) * PITCH : (laneStart.get(lane) || 0) + Math.sign(lane) * i * PITCH
      out.push({ key: n.key, family: n.family, label: n.label, x: r * COL, y, w, h, rank: r, lane, order: n.order, node: n.node, group: n.group, members: n.members })
    })
  }
  out.sort((a, b) => a.rank - b.rank || a.lane - b.lane || a.order - b.order)
  const byKey = new Map(out.map((n) => [n.key, n]))

  const edges: LayoutEdge[] = []
  for (const e of g.edges) {
    const a = byKey.get(e.from)
    const b = byKey.get(e.to)
    if (!a || !b) continue
    const back = e.kind === 'retry' || (b.rank <= a.rank && !(b.rank === a.rank && b.lane !== a.lane))
    let path: string
    let mid: { x: number; y: number }
    if (back) {
      // compact loop under the pair (retry) — never a long sweeping arc
      const sx = a.x; const sy = a.y + a.h / 2
      const tx = b.x; const ty = b.y + b.h / 2
      const d = 46 + Math.min(60, Math.abs(tx - sx) * 0.12)
      path = `M ${sx} ${sy} C ${sx} ${sy + d}, ${tx} ${ty + d}, ${tx} ${ty}`
      mid = { x: bez(sx, sx, tx, tx), y: bez(sy, sy + d, ty + d, ty) }
    } else if (a.rank === b.rank) {
      // same column, different lane (e.g. a stacked alternative): short vertical hop
      const sx = a.x; const sy = a.y + Math.sign(b.y - a.y) * (a.h / 2)
      const tx = b.x; const ty = b.y - Math.sign(b.y - a.y) * (b.h / 2)
      path = `M ${sx} ${sy} L ${tx} ${ty}`
      mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 }
    } else {
      const sx = a.x + a.w / 2; const sy = a.y
      const tx = b.x - b.w / 2; const ty = b.y
      const skip = b.rank - a.rank > 1 && Math.abs(ty - sy) < 1
      if (skip) {
        // a same-lane skip arcs over the nodes it passes (e.g. "no reply" skips rendering)
        const lift = Math.min(96, 34 + 18 * (b.rank - a.rank)) * (a.lane > 0 ? 1 : -1)
        path = `M ${sx} ${sy} C ${sx + 60} ${sy + lift}, ${tx - 60} ${ty + lift}, ${tx} ${ty}`
        mid = { x: bez(sx, sx + 60, tx - 60, tx), y: bez(sy, sy + lift, ty + lift, ty) }
      } else if (Math.abs(ty - sy) < 1) {
        path = `M ${sx} ${sy} L ${tx} ${ty}`
        mid = { x: (sx + tx) / 2, y: sy }
      } else {
        const dx = Math.max(34, Math.min(150, (tx - sx) * 0.55))
        path = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
        mid = { x: bez(sx, sx + dx, tx - dx, tx), y: bez(sy, sy, ty, ty) }
      }
    }
    edges.push({ id: e.id, ids: e.ids, from: e.from, to: e.to, kind: e.kind, label: e.label ?? null, path, mid, back })
  }

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const n of out) {
    minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2)
    minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2)
  }
  // back-edge loops hang below their nodes
  for (const e of edges) if (e.back) maxY = Math.max(maxY, e.mid.y + 16)
  if (!out.length) { minX = 0; minY = 0; maxX = 0; maxY = 0 }
  return { nodes: out, edges, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, byKey, owner: g.owner }
}

/** Every node upstream and downstream of `key` (focus branch). */
export function branchOf(layout: Layout, key: string): Set<string> {
  const keep = new Set<string>([key])
  const fwd = new Map<string, string[]>()
  const rev = new Map<string, string[]>()
  for (const e of layout.edges) {
    if (e.back) continue
    ;(fwd.get(e.from) || fwd.set(e.from, []).get(e.from)!).push(e.to)
    ;(rev.get(e.to) || rev.set(e.to, []).get(e.to)!).push(e.from)
  }
  const walk = (start: string, m: Map<string, string[]>) => {
    const stack = [start]
    while (stack.length) { const k = stack.pop()!; for (const n of m.get(k) || []) if (!keep.has(n)) { keep.add(n); stack.push(n) } }
  }
  walk(key, fwd)
  walk(key, rev)
  return keep
}
