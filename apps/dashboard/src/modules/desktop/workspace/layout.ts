/**
 * THE WORKSPACE LAYOUT — a deterministic split tree.
 *
 *   row ┬─ pane [Inbox]                      40%
 *       └─ col ┬─ pane [Deal · Comps]        60% × 60%
 *              └─ pane [Map]                 60% × 40%
 *
 * A SPLIT node lays its children side by side (`row`) or stacked (`col`) with
 * fractional sizes that always sum to 1. A PANE node is a leaf holding a STACK
 * of app instances (tabs) with one active. Everything here is pure: every
 * operation takes a state and returns the next one, already normalized — no
 * empty panes, no single-child splits, no same-direction nesting.
 *
 * Policy: one instance per application per workspace. Asking for an app that
 * is already open moves or focuses it; it is never duplicated by accident.
 */

export type Dir = 'row' | 'col'
export type Side = 'left' | 'right' | 'top' | 'bottom'
export type Zone = Side | 'stack' | 'replace'

export interface PaneNode { kind: 'pane'; id: string; tabs: string[]; active: string }
export interface SplitNode { kind: 'split'; id: string; dir: Dir; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = PaneNode | SplitNode

export interface Instance {
  id: string
  /** registry app id */
  app: string
  /** route + query this instance shows */
  path: string
  /** a pinned instance keeps its subject when the workspace selection moves */
  pinned: boolean
  pinLabel?: string | null
}

export interface Layout {
  root: LayoutNode
  instances: Record<string, Instance>
  /** the pane with keyboard/command focus */
  focus: string
  /** the instance mirrored in the browser URL */
  primary: string
  /** a pane shown over the whole workspace; the rest stay laid out underneath */
  maximized: string | null
}

export interface Rect { x: number; y: number; w: number; h: number }

/* ── ids ──────────────────────────────────────────────────────────────── */

let seq = 0
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`

/* ── app geometry: what each application needs to stay usable ──────────── */

export interface AppGeometry {
  /** below this width the app shows NEEDS MORE SPACE instead of a crushed UI */
  minW: number
  minH: number
}

const GEOMETRY: Record<string, AppGeometry> = {
  map: { minW: 380, minH: 320 },
  inbox: { minW: 460, minH: 380 },
  conversation: { minW: 420, minH: 380 },
  'deal-intelligence': { minW: 500, minH: 400 },
  'comp-intelligence': { minW: 480, minH: 380 },
  'buyer-match': { minW: 480, minH: 380 },
  'entity-graph': { minW: 460, minH: 360 },
  pipeline: { minW: 520, minH: 380 },
  queue: { minW: 460, minH: 340 },
  'campaign-command': { minW: 560, minH: 400 },
  'email-command': { minW: 480, minH: 380 },
  'workflow-studio': { minW: 600, minH: 420 },
  'closing-desk': { minW: 500, minH: 380 },
  analytics: { minW: 540, minH: 380 },
  calendar: { minW: 460, minH: 360 },
  home: { minW: 520, minH: 380 },
  settings: { minW: 520, minH: 360 },
  properties: { minW: 500, minH: 380 },
}
const FALLBACK_GEOMETRY: AppGeometry = { minW: 460, minH: 340 }
export const geometryFor = (app: string): AppGeometry => GEOMETRY[app] ?? FALLBACK_GEOMETRY

/**
 * Preferred share of the NEW app when it splits beside another. Pairs the
 * operator uses together get a considered ratio; everything else is 50/50.
 * Always resizable afterwards.
 */
const PAIR_SHARE: Array<[string, string, number]> = [
  ['inbox', 'deal-intelligence', 0.6],
  ['inbox', 'map', 0.45],
  ['campaign-command', 'queue', 0.4],
  ['campaign-command', 'analytics', 0.45],
  ['map', 'entity-graph', 0.4],
  ['deal-intelligence', 'map', 0.4],
  ['deal-intelligence', 'comp-intelligence', 0.5],
  ['closing-desk', 'email-command', 0.45],
  ['workflow-studio', 'inbox', 0.38],
]
export function preferredShare(existingApp: string, newApp: string): number {
  for (const [a, b, s] of PAIR_SHARE) {
    if (a === existingApp && b === newApp) return s
    if (b === existingApp && a === newApp) return 1 - s
  }
  return 0.5
}

/** How many panes can sit side by side without anything becoming unusable. */
export function maxVisiblePanes(workspace: { w: number; h: number }): number {
  const across = Math.floor(workspace.w / 440)
  const cap = workspace.w >= 3400 ? 6 : 4
  return Math.max(1, Math.min(cap, across + (workspace.h >= 900 ? 1 : 0)))
}

/* ── traversal ─────────────────────────────────────────────────────────── */

export function panes(node: LayoutNode): PaneNode[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(panes)
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.kind === 'pane') return node.id === paneId ? node : null
  for (const c of node.children) { const hit = findPane(c, paneId); if (hit) return hit }
  return null
}

export function paneOf(layout: Layout, instanceId: string): PaneNode | null {
  return panes(layout.root).find((p) => p.tabs.includes(instanceId)) ?? null
}

export function instanceForApp(layout: Layout, app: string): Instance | null {
  return Object.values(layout.instances).find((i) => i.app === app) ?? null
}

/** The active instance of the focused pane — what the Command Deck speaks for. */
export function focusedInstance(layout: Layout): Instance | null {
  const p = findPane(layout.root, layout.focus) ?? panes(layout.root)[0]
  return p ? layout.instances[p.active] ?? null : null
}

/* ── normalization ─────────────────────────────────────────────────────── */

function normSizes(sizes: number[], n: number): number[] {
  if (sizes.length !== n || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return Array.from({ length: n }, () => 1 / n)
  const t = sizes.reduce((a, b) => a + b, 0)
  return sizes.map((s) => s / t)
}

/** Remove empties, collapse single-child splits, flatten same-direction nesting. */
export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.kind === 'pane') {
    if (!node.tabs.length) return null
    return node.tabs.includes(node.active) ? node : { ...node, active: node.tabs[0] }
  }
  const kids: LayoutNode[] = []
  const sizes: number[] = []
  const base = normSizes(node.sizes, node.children.length)
  node.children.forEach((c, i) => {
    const n = normalize(c)
    if (!n) return
    if (n.kind === 'split' && n.dir === node.dir) {
      const inner = normSizes(n.sizes, n.children.length)
      n.children.forEach((cc, k) => { kids.push(cc); sizes.push(base[i] * inner[k]) })
    } else {
      kids.push(n)
      sizes.push(base[i])
    }
  })
  if (!kids.length) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids, sizes: normSizes(sizes, kids.length) }
}

/** Keep focus, primary and maximized pointing at things that still exist. */
function settle(layout: Layout, root: LayoutNode | null): Layout {
  if (!root) return layout
  const all = panes(root)
  const live = new Set(all.flatMap((p) => p.tabs))
  const instances = Object.fromEntries(Object.entries(layout.instances).filter(([id]) => live.has(id)))
  const focus = all.some((p) => p.id === layout.focus) ? layout.focus : all[0].id
  const focusPane = all.find((p) => p.id === focus)!
  const primary = live.has(layout.primary) ? layout.primary : focusPane.active
  const maximized = layout.maximized && all.some((p) => p.id === layout.maximized) && all.length > 1 ? layout.maximized : null
  return { root, instances, focus, primary, maximized }
}

/* ── tree surgery ─────────────────────────────────────────────────────── */

function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  const next = fn(node)
  if (next.kind === 'split') return { ...next, children: next.children.map((c) => mapNode(c, fn)) }
  return next
}

function removeTab(node: LayoutNode, instanceId: string): LayoutNode {
  return mapNode(node, (n) => {
    if (n.kind !== 'pane' || !n.tabs.includes(instanceId)) return n
    const i = n.tabs.indexOf(instanceId)
    const tabs = n.tabs.filter((t) => t !== instanceId)
    // closing the active tab activates its neighbour, not the first tab
    const active = n.active === instanceId ? (tabs[Math.min(i, tabs.length - 1)] ?? '') : n.active
    return { ...n, tabs, active }
  })
}

const sideDir = (side: Side): Dir => (side === 'left' || side === 'right' ? 'row' : 'col')
const sideBefore = (side: Side) => side === 'left' || side === 'top'

/** Put `pane` on `side` of the target, taking `share` of the target's space. */
function insertBeside(root: LayoutNode, targetId: string, pane: PaneNode, side: Side, share: number): LayoutNode {
  const dir = sideDir(side)
  const before = sideBefore(side)
  const s = Math.min(0.8, Math.max(0.2, share))
  const wrap = (target: LayoutNode): LayoutNode => ({
    kind: 'split',
    id: newId('s'),
    dir,
    children: before ? [pane, target] : [target, pane],
    sizes: before ? [s, 1 - s] : [1 - s, s],
  })
  if (root.kind === 'pane') return root.id === targetId ? wrap(root) : root
  // the target's parent already runs in this direction: become its sibling
  const idx = root.children.findIndex((c) => c.kind === 'pane' && c.id === targetId)
  if (idx >= 0 && root.dir === dir) {
    const children = [...root.children]
    const sizes = [...root.sizes]
    const own = sizes[idx]
    children.splice(before ? idx : idx + 1, 0, pane)
    sizes.splice(idx, 1, ...(before ? [own * s, own * (1 - s)] : [own * (1 - s), own * s]))
    return { ...root, children, sizes }
  }
  if (idx >= 0) {
    const children = [...root.children]
    children[idx] = wrap(children[idx])
    return { ...root, children }
  }
  return { ...root, children: root.children.map((c) => insertBeside(c, targetId, pane, side, share)) }
}

/* ── operations ─────────────────────────────────────────────────────────── */

export function singleLayout(inst: Instance): Layout {
  const pane: PaneNode = { kind: 'pane', id: newId('p'), tabs: [inst.id], active: inst.id }
  return { root: pane, instances: { [inst.id]: inst }, focus: pane.id, primary: inst.id, maximized: null }
}

export interface Placement { pane: string; zone: Zone; /** the new pane's share, as previewed */ share?: number }

/**
 * Place an instance. A new instance is added; an instance already in the
 * layout is MOVED (detached from where it was first). Returns the new layout
 * and the pane the instance ended up in.
 */
export function place(layout: Layout, inst: Instance, at: Placement): { layout: Layout; pane: string } {
  const exists = Boolean(layout.instances[inst.id])
  const source = exists ? paneOf(layout, inst.id) : null
  const target = findPane(layout.root, at.pane)
  if (!target) return { layout, pane: source?.id ?? layout.focus }

  // dropping an instance onto its own single-tab pane is a no-op
  if (source && source.id === target.id && source.tabs.length === 1) {
    return { layout: { ...layout, focus: source.id }, pane: source.id }
  }

  const instances = { ...layout.instances, [inst.id]: inst }

  if (at.zone === 'stack' || at.zone === 'replace') {
    let root = exists ? removeTab(layout.root, inst.id) : layout.root
    let replaced: string | null = null
    root = mapNode(root, (n) => {
      if (n.kind !== 'pane' || n.id !== target.id) return n
      if (at.zone === 'replace' && n.active && n.active !== inst.id) {
        replaced = n.active
        const tabs = n.tabs.map((t) => (t === n.active ? inst.id : t)).filter((t, i, a) => a.indexOf(t) === i)
        return { ...n, tabs, active: inst.id }
      }
      const tabs = n.tabs.includes(inst.id) ? n.tabs : [...n.tabs, inst.id]
      return { ...n, tabs, active: inst.id }
    })
    if (replaced) delete instances[replaced]
    const next = settle({ ...layout, instances, focus: target.id, primary: replaced === layout.primary ? inst.id : layout.primary }, normalize(root))
    return { layout: next, pane: target.id }
  }

  // split: a new pane beside the target
  const pane: PaneNode = { kind: 'pane', id: newId('p'), tabs: [inst.id], active: inst.id }
  const targetApp = layout.instances[target.active]?.app ?? ''
  const share = at.share ?? preferredShare(targetApp, inst.app)
  let root = exists ? removeTab(layout.root, inst.id) : layout.root
  // the source pane may have vanished — that is fine, normalize() drops it
  root = normalize(root) ?? root
  if (!findPane(root, target.id)) return { layout, pane: source?.id ?? layout.focus }
  root = insertBeside(root, target.id, pane, at.zone, share)
  return { layout: settle({ ...layout, instances, focus: pane.id }, normalize(root)), pane: pane.id }
}

/** Close one instance (a tab). The last tab of a pane closes the pane; the last pane cannot close. */
export function closeInstance(layout: Layout, instanceId: string): Layout {
  const all = panes(layout.root)
  if (!layout.instances[instanceId]) return layout
  if (all.length === 1 && all[0].tabs.length === 1) return layout
  const home = paneOf(layout, instanceId)
  // a pane that keeps other tabs keeps focus; a pane that disappears hands
  // focus to the neighbour that absorbs its space
  const focusTo = home && home.tabs.length > 1 ? home.id : (home ? absorberOf(layout.root, home.id) : null) ?? layout.focus
  const root = normalize(removeTab(layout.root, instanceId))
  return settle({ ...layout, focus: focusTo }, root)
}

/** The pane that grows into a closing pane's space: its nearest sibling. */
function absorberOf(node: LayoutNode, paneId: string): string | null {
  if (node.kind === 'pane') return null
  const i = node.children.findIndex((c) => c.kind === 'pane' && c.id === paneId)
  if (i >= 0) {
    const sib = node.children[i + 1] ?? node.children[i - 1]
    return sib ? panes(sib)[0]?.id ?? null : null
  }
  for (const c of node.children) { const hit = absorberOf(c, paneId); if (hit) return hit }
  return null
}

export function closePane(layout: Layout, paneId: string): Layout {
  const pane = findPane(layout.root, paneId)
  if (!pane) return layout
  if (panes(layout.root).length === 1) return layout
  let next = layout
  for (const t of pane.tabs) next = closeInstanceForce(next, t)
  return next
}

function closeInstanceForce(layout: Layout, instanceId: string): Layout {
  const root = normalize(removeTab(layout.root, instanceId))
  return root ? settle(layout, root) : layout
}

export function activate(layout: Layout, paneId: string, instanceId: string): Layout {
  const root = mapNode(layout.root, (n) => (n.kind === 'pane' && n.id === paneId && n.tabs.includes(instanceId) ? { ...n, active: instanceId } : n))
  return { ...layout, root, focus: paneId }
}

export function focus(layout: Layout, paneId: string): Layout {
  return findPane(layout.root, paneId) && layout.focus !== paneId ? { ...layout, focus: paneId } : layout
}

export function setSizes(layout: Layout, splitId: string, sizes: number[]): Layout {
  const root = mapNode(layout.root, (n) => (n.kind === 'split' && n.id === splitId ? { ...n, sizes: normSizes(sizes, n.children.length) } : n))
  return { ...layout, root }
}

/** Double-click a divider: the pair returns to its preferred ratio. */
export function resetSizes(layout: Layout, splitId: string): Layout {
  const root = mapNode(layout.root, (n) => {
    if (n.kind !== 'split' || n.id !== splitId) return n
    if (n.children.length === 2) {
      const a = n.children[0].kind === 'pane' ? layout.instances[n.children[0].active]?.app : null
      const b = n.children[1].kind === 'pane' ? layout.instances[n.children[1].active]?.app : null
      if (a && b) { const s = preferredShare(a, b); return { ...n, sizes: [1 - s, s] } }
    }
    return { ...n, sizes: n.children.map(() => 1 / n.children.length) }
  })
  return { ...layout, root }
}

export function maximize(layout: Layout, paneId: string | null): Layout {
  if (paneId && (!findPane(layout.root, paneId) || panes(layout.root).length < 2)) return layout
  return { ...layout, maximized: paneId, focus: paneId ?? layout.focus }
}

export function updateInstance(layout: Layout, id: string, patch: Partial<Instance>): Layout {
  const cur = layout.instances[id]
  if (!cur) return layout
  const next = { ...cur, ...patch }
  if (next.path === cur.path && next.app === cur.app && next.pinned === cur.pinned && next.pinLabel === cur.pinLabel) return layout
  return { ...layout, instances: { ...layout.instances, [id]: next } }
}

/** Swap places with the neighbouring pane in a direction (keyboard "Move left/right/up/down"). */
export function neighbour(_layout: Layout, paneId: string, side: Side, rects: Record<string, Rect>): string | null {
  const me = rects[paneId]
  if (!me) return null
  const cx = me.x + me.w / 2
  const cy = me.y + me.h / 2
  let best: { id: string; d: number } | null = null
  for (const [id, r] of Object.entries(rects)) {
    if (id === paneId) continue
    const ox = r.x + r.w / 2
    const oy = r.y + r.h / 2
    const ok = side === 'left' ? ox < cx - 4 : side === 'right' ? ox > cx + 4 : side === 'top' ? oy < cy - 4 : oy > cy + 4
    if (!ok) continue
    const d = Math.hypot(ox - cx, oy - cy)
    if (!best || d < best.d) best = { id, d }
  }
  return best?.id ?? null
}

/* ── drop geometry ─────────────────────────────────────────────────────── */

export interface DropTarget { pane: string; zone: Zone; preview: Rect; share: number; blocked: string | null }

/**
 * Which zone the pointer is in over a pane: the centre stacks, the edges split.
 * A split that would leave either application below its minimum is refused
 * (stack instead), and so is any split past the visible-pane budget.
 */
export function dropTargetAt(
  rect: Rect,
  pt: { x: number; y: number },
  ctx: { paneId: string; targetApp: string; newApp: string; visiblePanes: number; maxPanes: number; replaceRect?: Rect | null },
): DropTarget {
  const u = (pt.x - rect.x) / rect.w
  const v = (pt.y - rect.y) / rect.h
  const rr = ctx.replaceRect
  if (rr && pt.x >= rr.x && pt.x <= rr.x + rr.w && pt.y >= rr.y && pt.y <= rr.y + rr.h) {
    return { pane: ctx.paneId, zone: 'replace', preview: rect, share: 1, blocked: null }
  }
  const inCentre = u > 0.3 && u < 0.7 && v > 0.28 && v < 0.72
  const stack: DropTarget = { pane: ctx.paneId, zone: 'stack', preview: rect, share: 1, blocked: null }
  if (inCentre) return stack
  const d = { left: u, right: 1 - u, top: v, bottom: 1 - v }
  const side = (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]) as Side
  const g1 = geometryFor(ctx.targetApp)
  const g2 = geometryFor(ctx.newApp)
  const horizontal = side === 'left' || side === 'right'
  const span = horizontal ? rect.w : rect.h
  const needA = horizontal ? g1.minW : g1.minH
  const needB = horizontal ? g2.minW : g2.minH
  // the pair's preferred ratio, moved only as far as both apps need to stay usable
  const lo = needB / span
  const hi = 1 - needA / span
  const share = Math.min(hi, Math.max(lo, preferredShare(ctx.targetApp, ctx.newApp)))
  let blocked: string | null = null
  if (ctx.visiblePanes >= ctx.maxPanes) blocked = 'The workspace is full — add it to a stack instead'
  else if (lo > hi) blocked = 'Not enough room to split here — add it to the stack'
  if (blocked) return { ...stack, blocked }
  const preview: Rect = side === 'left' ? { x: rect.x, y: rect.y, w: rect.w * share, h: rect.h }
    : side === 'right' ? { x: rect.x + rect.w * (1 - share), y: rect.y, w: rect.w * share, h: rect.h }
      : side === 'top' ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h * share }
        : { x: rect.x, y: rect.y + rect.h * (1 - share), w: rect.w, h: rect.h * share }
  return { pane: ctx.paneId, zone: side, preview, share, blocked: null }
}

/* ── persistence ───────────────────────────────────────────────────────── */

/** Validate a stored layout against the apps that exist; null when unusable. */
export function reviveLayout(raw: unknown, appExists: (app: string) => boolean): Layout | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Layout>
  if (!r.root || !r.instances || typeof r.instances !== 'object') return null
  const instances: Record<string, Instance> = {}
  const seenApps = new Set<string>()
  for (const [id, i] of Object.entries(r.instances as Record<string, Instance>)) {
    if (!i || typeof i.path !== 'string' || typeof i.app !== 'string' || !appExists(i.app) || seenApps.has(i.app)) continue
    seenApps.add(i.app)
    instances[id] = { id, app: i.app, path: i.path, pinned: Boolean(i.pinned), pinLabel: i.pinLabel ?? null }
  }
  const clean = (n: LayoutNode): LayoutNode => (n.kind === 'pane'
    ? { kind: 'pane', id: String(n.id), tabs: (n.tabs || []).filter((t) => instances[t]), active: String(n.active) }
    : { kind: 'split', id: String(n.id), dir: n.dir === 'col' ? 'col' : 'row', children: (n.children || []).map(clean), sizes: Array.isArray(n.sizes) ? n.sizes : [] })
  let root: LayoutNode | null
  try { root = normalize(clean(r.root as LayoutNode)) } catch { return null }
  if (!root) return null
  const base: Layout = { root, instances, focus: String(r.focus ?? ''), primary: String(r.primary ?? ''), maximized: r.maximized ?? null }
  return settle(base, root)
}

/** An abstract miniature of the layout for the workspace selector (fractions, no screenshots). */
export function miniature(node: LayoutNode, box: Rect = { x: 0, y: 0, w: 1, h: 1 }): Rect[] {
  if (node.kind === 'pane') return [box]
  const sizes = normSizes(node.sizes, node.children.length)
  let offset = 0
  return node.children.flatMap((c, i) => {
    const r: Rect = node.dir === 'row'
      ? { x: box.x + box.w * offset, y: box.y, w: box.w * sizes[i], h: box.h }
      : { x: box.x, y: box.y + box.h * offset, w: box.w, h: box.h * sizes[i] }
    offset += sizes[i]
    return miniature(c, r)
  })
}
