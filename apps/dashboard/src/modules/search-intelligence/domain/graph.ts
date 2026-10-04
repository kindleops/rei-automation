/**
 * The site graph (§7): a property's architecture as a navigable tree, laid out
 * for a canvas renderer.
 *
 * Scale (§33): the tree is built once; layout is O(visible). Wide fan-outs are
 * grouped by page family (a "legacy city · 75" node), groups above a size
 * collapse by default, and a visible-node budget collapses the deepest
 * expanded groups first — so 10,000 pages render as a few hundred marks plus
 * aggregates, never thousands of DOM nodes.
 */
import type { SearchModel } from './model'
import { pagesIn } from './model'
import { coverageGaps, gapLabel, type CoverageGap } from './geography'
import { isOrphan } from './registry'
import type { PageStatus, SearchPage } from './types'

export type NodeKind = 'portfolio' | 'property' | 'page' | 'group' | 'gap'

export interface TreeNode {
  id: string
  kind: NodeKind
  label: string
  propertyId: string | null
  pageId: string | null
  gap: CoverageGap | null
  family: string | null
  status: PageStatus | null
  orphan: boolean
  children: TreeNode[]
  /** descendants (pages + gaps), for aggregate badges */
  size: number
  /** READY-or-later pages among descendants (and self) */
  ready: number
  gaps: number
}

const READYISH = new Set<PageStatus>(['READY', 'PUBLISHED', 'INDEXED'])
export const GROUP_THRESHOLD = 12
export const COLLAPSE_GROUP_ABOVE = 24

function pageNode(m: SearchModel, p: SearchPage): TreeNode {
  return {
    id: `p:${p.id}`, kind: 'page', label: p.path, propertyId: p.propertyId, pageId: p.id, gap: null, family: p.family, status: p.status,
    orphan: isOrphan(m, p), children: [], size: 1, ready: READYISH.has(p.status) ? 1 : 0, gaps: 0,
  }
}

function finalize(n: TreeNode): TreeNode {
  // group wide, mixed fan-outs by family
  if (n.kind !== 'group' && n.children.length > GROUP_THRESHOLD) {
    const byFam = new Map<string, TreeNode[]>()
    for (const c of n.children) {
      const k = c.kind === 'gap' ? `gap:${c.family ?? ''}` : c.family ?? 'page'
      ;(byFam.get(k) ?? byFam.set(k, []).get(k)!).push(c)
    }
    if (byFam.size > 1 || n.children.length > COLLAPSE_GROUP_ABOVE) {
      const grouped: TreeNode[] = []
      for (const [fam, kids] of byFam) {
        if (kids.length <= 3 && byFam.size > 1) { grouped.push(...kids); continue }
        const isGap = fam.startsWith('gap:')
        grouped.push({
          id: `${n.id}/g:${fam}`, kind: 'group', label: isGap ? `missing · ${fam.slice(4).replace(/-/g, ' ')}` : fam.replace(/-/g, ' '),
          propertyId: n.propertyId, pageId: null, gap: null, family: isGap ? fam.slice(4) : fam, status: null, orphan: false,
          children: kids, size: 0, ready: 0, gaps: 0,
        })
      }
      n.children = grouped
    }
  }
  n.children.sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label))
  let size = n.kind === 'page' || n.kind === 'gap' ? 1 : 0
  let ready = n.kind === 'page' && n.status && READYISH.has(n.status) ? 1 : 0
  let gaps = n.kind === 'gap' ? 1 : 0
  for (const c of n.children) {
    finalize(c)
    size += c.size
    ready += c.ready
    gaps += c.gaps
  }
  n.size = size
  n.ready = ready
  n.gaps = gaps
  return n
}
const order = (n: TreeNode) => (n.kind === 'gap' ? 3 : n.kind === 'group' ? 2 : 1)

/** Build the architecture tree for one property, or the whole portfolio. */
export function buildTree(m: SearchModel, propertyId: string | null, opts: { includeGaps?: boolean } = {}): TreeNode {
  const includeGaps = opts.includeGaps ?? true
  const props = propertyId ? [m.property.get(propertyId)!].filter(Boolean) : m.dataset.properties
  const roots = props.map((prop) => {
    const pages = pagesIn(m, prop.id) as SearchPage[]
    const nodes = new Map(pages.map((p) => [p.id, pageNode(m, p)]))
    const root: TreeNode = {
      id: `prop:${prop.id}`, kind: 'property', label: prop.domain, propertyId: prop.id, pageId: null, gap: null, family: null, status: null,
      orphan: false, children: [], size: 0, ready: 0, gaps: 0,
    }
    for (const p of pages) {
      const n = nodes.get(p.id)!
      const parent = p.parentId ? nodes.get(p.parentId) : undefined
      // guard against cycles: attach to root if the parent chain loops back
      let ok = !!parent
      if (parent) {
        let cur: string | null = p.parentId
        const seen = new Set<string>([p.id])
        while (cur) { if (seen.has(cur)) { ok = false; break } seen.add(cur); cur = m.page.get(cur)?.parentId ?? null }
      }
      ;(ok && parent ? parent : root).children.push(n)
    }
    if (includeGaps) {
      for (const g of coverageGaps(m, prop.id)) {
        const gapNode: TreeNode = {
          id: `gap:${g.id}`, kind: 'gap', label: gapLabel(m, g), propertyId: prop.id, pageId: null, gap: g, family: g.kind === 'OWNER_NOT_REGISTERED' ? 'unregistered-owner' : g.family,
          status: null, orphan: false, children: [], size: 1, ready: 0, gaps: 1,
        }
        const anchor = g.kind === 'DIMENSION_WITHOUT_PAGE' ? nodes.get(g.parentPageId)
          : g.kind === 'GEO_WITHOUT_PAGE' ? pages.map((p) => nodes.get(p.id)!).find((n) => n.family === 'market-national') : undefined
        ;(anchor ?? root).children.push(gapNode)
      }
    }
    return finalize(root)
  })
  if (propertyId && roots.length === 1) return roots[0]
  return finalize({
    id: 'portfolio', kind: 'portfolio', label: 'Portfolio', propertyId: null, pageId: null, gap: null, family: null, status: null,
    orphan: false, children: roots, size: 0, ready: 0, gaps: 0,
  })
}

/** Default expansion: everything except large groups and anything deeper than `depth`. */
export function defaultExpanded(root: TreeNode, depth = 3): Set<string> {
  const out = new Set<string>()
  const walk = (n: TreeNode, d: number) => {
    if (!n.children.length) return
    if (n.kind === 'group' && n.children.length > COLLAPSE_GROUP_ABOVE) return
    if (d >= depth) return
    out.add(n.id)
    for (const c of n.children) walk(c, d + 1)
  }
  walk(root, 0)
  return out
}

/* ── layout ─────────────────────────────────────────────────────────────── */

export type LayoutMode = 'radial' | 'tree'

export interface LaidNode {
  node: TreeNode
  x: number
  y: number
  depth: number
  parent: number
  /** collapsed with hidden descendants */
  collapsed: boolean
}

export interface GraphLayout {
  nodes: LaidNode[]
  index: Map<string, number>
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** nodes collapsed by the budget, not by the operator */
  budgetCollapsed: number
}

export const VISIBLE_BUDGET = 1600

/** Visible node count for an expansion set, without allocating a layout. */
function countVisible(n: TreeNode, expanded: ReadonlySet<string>): number {
  if (!expanded.has(n.id)) return 1
  let c = 1
  for (const k of n.children) c += countVisible(k, expanded)
  return c
}

export function layoutTree(root: TreeNode, expandedIn: ReadonlySet<string>, mode: LayoutMode = 'radial', budget = VISIBLE_BUDGET): GraphLayout {
  // enforce the budget by collapsing the deepest expanded nodes first
  const expanded = new Set(expandedIn)
  expanded.add(root.id)
  let budgetCollapsed = 0
  let visible = countVisible(root, expanded)
  if (visible > budget) {
    const open: Array<{ node: TreeNode; d: number }> = []
    const walk = (n: TreeNode, d: number) => { if (expanded.has(n.id)) { open.push({ node: n, d }); for (const c of n.children) walk(c, d + 1) } }
    walk(root, 0)
    open.sort((a, b) => b.d - a.d || b.node.children.length - a.node.children.length)
    for (const e of open) {
      if (visible <= budget) break
      if (e.node === root) continue
      // deepest first: its descendants are already collapsed, so this is O(children)
      visible -= countVisible(e.node, expanded) - 1
      expanded.delete(e.node.id)
      budgetCollapsed += 1
    }
  }

  const nodes: LaidNode[] = []
  const index = new Map<string, number>()
  // leaf weights for angular/vertical allocation
  const leaves = (n: TreeNode): number => (expanded.has(n.id) && n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1)
  const total = leaves(root)
  let cursor = 0
  const RING = 120
  const ROW = 22
  const COL = 220
  const place = (n: TreeNode, depth: number, parent: number) => {
    const isOpen = expanded.has(n.id) && n.children.length > 0
    const i = nodes.length
    nodes.push({ node: n, x: 0, y: 0, depth, parent, collapsed: !isOpen && n.children.length > 0 })
    index.set(n.id, i)
    const start = cursor
    if (isOpen) for (const c of n.children) place(c, depth + 1, i)
    else cursor += 1
    const mid = (start + cursor - 1) / 2
    if (mode === 'radial') {
      const a = (mid / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
      const r = depth * RING * (1 + Math.log10(Math.max(1, total)) * 0.35)
      nodes[i].x = Math.cos(a) * r
      nodes[i].y = Math.sin(a) * r
    } else {
      nodes[i].x = depth * COL
      nodes[i].y = mid * ROW
    }
  }
  place(root, 0, -1)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y) }
  return { nodes, index, bounds: { minX, minY, maxX, maxY }, budgetCollapsed }
}

/** Ids along the path from root to a node, so selecting a deep node can open its branch. */
export function pathTo(root: TreeNode, id: string): string[] | null {
  if (root.id === id) return [root.id]
  for (const c of root.children) {
    const p = pathTo(c, id)
    if (p) return [root.id, ...p]
  }
  return null
}

/** Find the tree node for a page id. */
export function findPageNode(root: TreeNode, pageId: string): TreeNode | null {
  if (root.pageId === pageId) return root
  for (const c of root.children) {
    const f = findPageNode(c, pageId)
    if (f) return f
  }
  return null
}

/** Uniform-grid spatial index for canvas hit testing in layout space. */
export function buildHitGrid(layout: GraphLayout, cell = 40) {
  const grid = new Map<string, number[]>()
  layout.nodes.forEach((n, i) => {
    const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`
    ;(grid.get(k) ?? grid.set(k, []).get(k)!).push(i)
  })
  return (x: number, y: number, radius: number): number => {
    let best = -1
    let bestD = radius * radius
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell)
    const span = Math.ceil(radius / cell)
    for (let dx = -span; dx <= span; dx += 1) for (let dy = -span; dy <= span; dy += 1) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const n = layout.nodes[i]
        const d = (n.x - x) ** 2 + (n.y - y) ** 2
        if (d < bestD) { bestD = d; best = i }
      }
    }
    return best
  }
}
