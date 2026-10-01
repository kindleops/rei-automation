import { FAMILY } from '../lib/families'
import type { EdgeKind, NodeFamily, Topology, TopologyGroup, TopologyNode } from '../lib/types'

/**
 * DETERMINISTIC AUTO-LAYOUT — same input, same pixels, every time.
 *
 *   rank     longest path from the trigger over forward edges (retry edges are
 *            back-edges and never push a node forward)
 *   sections the topology's semantic stages become BANDS along the flow: every
 *            node of a stage sits after every node of the stage before it, so a
 *            stage is one contiguous field (Resolution → Understanding →
 *            Decision → …) instead of a box that overlaps its neighbours
 *   lane     authored in the topology: 0 is the spine, negative lanes sit before
 *            it (human review — easy to see), positive lanes after it
 *            (exceptions, failures)
 *   stack    several nodes in one (rank, lane) cell stack across the flow
 *   direction LR (left → right) or TB (top → bottom); TB is the narrow-pane
 *            reading of the same graph — positions are transposed, never
 *            re-ranked
 *
 * Groups give progressive disclosure: a collapsed group is ONE node standing
 * for its members (edges re-attached, internal edges dropped).
 */

export type Direction = 'LR' | 'TB'

const GEOMETRY = {
  LR: { main: 268, pitch: 94, laneGap: 40 },
  TB: { main: 124, pitch: 236, laneGap: 36 },
} as const

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
  section: string | null
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

export interface LayoutSection { key: string; label: string; x: number; y: number; w: number; h: number; members: string[]; index: number }

export interface Layout {
  direction: Direction
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  sections: LayoutSection[]
  bounds: { x: number; y: number; w: number; h: number }
  byKey: Map<string, LayoutNode>
  /** topology node key → the visible node that stands for it */
  owner: Map<string, string>
}

const groupKey = (k: string) => `group:${k}`

interface VisibleNode { key: string; family: NodeFamily; label: string; lane: number; order: number; node: TopologyNode | null; group: TopologyGroup | null; members: string[] }

export function visibleGraph(topology: Topology, expanded: ReadonlySet<string>) {
  const order = new Map(topology.nodes.map((n, i) => [n.key, i]))
  const groups = new Map(topology.groups.map((g) => [g.key, g]))
  const owner = new Map<string, string>()
  const nodes: VisibleNode[] = []
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
  // a forward cycle is a topology bug; place leftovers after their placed parents
  for (const n of nodes) if (!done.has(n.key)) rank.set(n.key, Math.max(rank.get(n.key) || 0, 1))
  return rank
}

/** Each visible node's semantic stage: its own (or its members'), else inherited along the flow. */
function sectionsOf(topology: Topology, g: ReturnType<typeof visibleGraph>, rank: Map<string, number>) {
  const stages = topology.stages || []
  const of = new Map<string, string | null>()
  for (const n of g.nodes) of.set(n.key, stages.find((s) => n.members.some((m) => s.nodes.includes(m)))?.key ?? null)
  const sorted = [...g.nodes].sort((a, b) => (rank.get(a.key) || 0) - (rank.get(b.key) || 0) || a.order - b.order)
  for (let pass = 0; pass < 3; pass++) {
    for (const n of sorted) {
      if (of.get(n.key)) continue
      const pred = g.edges.find((e) => e.to === n.key && e.kind !== 'retry' && of.get(e.from))
      if (pred) of.set(n.key, of.get(pred.from)!)
    }
  }
  for (const n of sorted) {
    if (of.get(n.key)) continue
    const succ = g.edges.find((e) => e.from === n.key && of.get(e.to))
    if (succ) of.set(n.key, of.get(succ.to)!)
  }
  return of
}

const bez = (p0: number, p1: number, p2: number, p3: number) => (p0 + 3 * p1 + 3 * p2 + p3) / 8

export interface LayoutOptions { direction?: Direction; sections?: boolean }

export function layoutTopology(topology: Topology, expanded: ReadonlySet<string> = new Set(), { direction = 'LR', sections = true }: LayoutOptions = {}): Layout {
  const G = GEOMETRY[direction]
  const g = visibleGraph(topology, expanded)
  let rank = ranks(g.nodes, g.edges)
  const sectionOf = sectionsOf(topology, g, rank)
  const stageOrder = (topology.stages || []).map((s) => s.key)
  const banded = sections && stageOrder.length > 0 && g.nodes.every((n) => sectionOf.get(n.key))

  // BANDS: stage i occupies ranks after stage i-1 (relative structure inside a stage is kept)
  if (banded) {
    const next = new Map<string, number>()
    let offset = 0
    for (const s of stageOrder) {
      const members = g.nodes.filter((n) => sectionOf.get(n.key) === s)
      if (!members.length) continue
      const lo = Math.min(...members.map((n) => rank.get(n.key) || 0))
      let hi = 0
      for (const n of members) { const r = (rank.get(n.key) || 0) - lo; next.set(n.key, offset + r); hi = Math.max(hi, r) }
      offset += hi + 1
    }
    rank = next
  }

  const size = (f: NodeFamily, isGroup: boolean) => ({ w: FAMILY[f].w + (isGroup ? 8 : 0), h: FAMILY[f].h + (isGroup ? 4 : 0) })

  // cells: (rank, lane) → nodes in topology order
  const cells = new Map<string, VisibleNode[]>()
  for (const n of g.nodes) {
    const k = `${rank.get(n.key)}:${n.lane}`
    ;(cells.get(k) || cells.set(k, []).get(k)!).push(n)
  }
  for (const list of cells.values()) list.sort((a, b) => a.order - b.order)
  // lanes are global so they never collide
  const depth = new Map<number, number>()
  for (const [k, list] of cells) { const lane = Number(k.split(':')[1]); depth.set(lane, Math.max(depth.get(lane) || 0, list.length)) }
  const lanes = [...depth.keys()].sort((a, b) => a - b)
  const spineHalf = (((depth.get(0) || 1) - 1) * G.pitch) / 2 + (direction === 'LR' ? 38 : 116)
  const laneStart = new Map<number, number>([[0, 0]])
  let down = spineHalf
  for (const l of lanes.filter((x) => x > 0)) { laneStart.set(l, down + G.laneGap + (direction === 'LR' ? 32 : 110)); down += G.laneGap + (depth.get(l) || 1) * G.pitch }
  let up = spineHalf
  for (const l of lanes.filter((x) => x < 0).reverse()) { laneStart.set(l, -(up + G.laneGap + (direction === 'LR' ? 32 : 110))); up += G.laneGap + (depth.get(l) || 1) * G.pitch }

  const out: LayoutNode[] = []
  for (const [k, list] of cells) {
    const [r, lane] = k.split(':').map(Number)
    list.forEach((n, i) => {
      const { w, h } = size(n.family, Boolean(n.group))
      const cross = lane === 0 ? (i - (list.length - 1) / 2) * G.pitch : (laneStart.get(lane) || 0) + Math.sign(lane) * i * G.pitch
      const main = r * G.main
      const x = direction === 'LR' ? main : cross
      const y = direction === 'LR' ? cross : main
      out.push({ key: n.key, family: n.family, label: n.label, x, y, w, h, rank: r, lane, order: n.order, node: n.node, group: n.group, members: n.members, section: sectionOf.get(n.key) ?? null })
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
    const { path, mid } = direction === 'LR' ? routeLR(a, b, back) : routeTB(a, b, back)
    edges.push({ id: e.id, ids: e.ids, from: e.from, to: e.to, kind: e.kind, label: e.label ?? null, path, mid, back })
  }

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const n of out) {
    minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2)
    minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2)
  }
  if (!out.length) { minX = 0; minY = 0; maxX = 0; maxY = 0 }

  // section fields: one contiguous band per stage, spanning the whole board across the flow
  const fields: LayoutSection[] = []
  if (banded) {
    const PAD_ACROSS = direction === 'LR' ? 64 : 40
    stageOrder.forEach((s, index) => {
      const members = out.filter((n) => n.section === s)
      if (!members.length) return
      const label = topology.stages!.find((x) => x.key === s)!.label
      if (direction === 'LR') {
        const lo = Math.min(...members.map((n) => n.x - n.w / 2)) - 26
        const hi = Math.max(...members.map((n) => n.x + n.w / 2)) + 26
        fields.push({ key: s, label, index, x: lo, y: minY - PAD_ACROSS, w: hi - lo, h: maxY - minY + PAD_ACROSS * 2, members: members.map((m) => m.key) })
      } else {
        const lo = Math.min(...members.map((n) => n.y - n.h / 2)) - 22
        const hi = Math.max(...members.map((n) => n.y + n.h / 2)) + 22
        fields.push({ key: s, label, index, x: minX - PAD_ACROSS, y: lo, w: maxX - minX + PAD_ACROSS * 2, h: hi - lo, members: members.map((m) => m.key) })
      }
    })
    for (const f of fields) { minX = Math.min(minX, f.x); minY = Math.min(minY, f.y); maxX = Math.max(maxX, f.x + f.w); maxY = Math.max(maxY, f.y + f.h) }
  }
  // back-edge loops hang outside their nodes
  for (const e of edges) if (e.back) { maxY = Math.max(maxY, e.mid.y + 18); maxX = Math.max(maxX, e.mid.x + 18) }
  return { direction, nodes: out, edges, sections: fields, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, byKey, owner: g.owner }
}

function routeLR(a: LayoutNode, b: LayoutNode, back: boolean) {
  if (back) {
    // a compact loop under the pair — never a long sweeping arc
    const sx = a.x; const sy = a.y + a.h / 2
    const tx = b.x; const ty = b.y + b.h / 2
    const d = 44 + Math.min(70, Math.abs(tx - sx) * 0.12)
    return { path: `M ${sx} ${sy} C ${sx} ${sy + d}, ${tx} ${ty + d}, ${tx} ${ty}`, mid: { x: bez(sx, sx, tx, tx), y: bez(sy, sy + d, ty + d, ty) } }
  }
  if (a.rank === b.rank) {
    const dir = Math.sign(b.y - a.y) || 1
    const sx = a.x; const sy = a.y + dir * (a.h / 2)
    const tx = b.x; const ty = b.y - dir * (b.h / 2)
    return { path: `M ${sx} ${sy} L ${tx} ${ty}`, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } }
  }
  const sx = a.x + a.w / 2; const sy = a.y
  const tx = b.x - b.w / 2; const ty = b.y
  if (b.rank - a.rank > 1 && Math.abs(ty - sy) < 1) {
    // a same-lane skip arcs over the nodes it passes
    const lift = Math.min(104, 36 + 16 * (b.rank - a.rank)) * (a.lane > 0 ? 1 : -1)
    return { path: `M ${sx} ${sy} C ${sx + 70} ${sy + lift}, ${tx - 70} ${ty + lift}, ${tx} ${ty}`, mid: { x: bez(sx, sx + 70, tx - 70, tx), y: bez(sy, sy + lift, ty + lift, ty) } }
  }
  if (Math.abs(ty - sy) < 1) return { path: `M ${sx} ${sy} L ${tx} ${ty}`, mid: { x: (sx + tx) / 2, y: sy } }
  const dx = Math.max(36, Math.min(150, (tx - sx) * 0.55))
  return { path: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`, mid: { x: bez(sx, sx + dx, tx - dx, tx), y: bez(sy, sy, ty, ty) } }
}

function routeTB(a: LayoutNode, b: LayoutNode, back: boolean) {
  if (back) {
    const sx = a.x + a.w / 2; const sy = a.y
    const tx = b.x + b.w / 2; const ty = b.y
    const d = 44 + Math.min(70, Math.abs(ty - sy) * 0.12)
    return { path: `M ${sx} ${sy} C ${sx + d} ${sy}, ${tx + d} ${ty}, ${tx} ${ty}`, mid: { x: bez(sx, sx + d, tx + d, tx), y: bez(sy, sy, ty, ty) } }
  }
  if (a.rank === b.rank) {
    const dir = Math.sign(b.x - a.x) || 1
    const sx = a.x + dir * (a.w / 2); const sy = a.y
    const tx = b.x - dir * (b.w / 2); const ty = b.y
    return { path: `M ${sx} ${sy} L ${tx} ${ty}`, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } }
  }
  const sx = a.x; const sy = a.y + a.h / 2
  const tx = b.x; const ty = b.y - b.h / 2
  if (b.rank - a.rank > 1 && Math.abs(tx - sx) < 1) {
    const lift = Math.min(150, 60 + 14 * (b.rank - a.rank)) * (a.lane > 0 ? 1 : -1)
    return { path: `M ${sx} ${sy} C ${sx + lift} ${sy + 50}, ${tx + lift} ${ty - 50}, ${tx} ${ty}`, mid: { x: bez(sx, sx + lift, tx + lift, tx), y: bez(sy, sy + 50, ty - 50, ty) } }
  }
  if (Math.abs(tx - sx) < 1) return { path: `M ${sx} ${sy} L ${tx} ${ty}`, mid: { x: sx, y: (sy + ty) / 2 } }
  const dy = Math.max(30, Math.min(90, (ty - sy) * 0.55))
  return { path: `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`, mid: { x: bez(sx, sx, tx, tx), y: bez(sy, sy + dy, ty - dy, ty) } }
}

/** Every node upstream and downstream of `key` (focus branch / dependencies). */
export function branchOf(layout: Pick<Layout, 'edges'>, key: string): Set<string> {
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
