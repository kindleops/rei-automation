import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { LCIconButton, LCSegmented, useLcReducedMotion } from '../../../shared/lc'
import type { SearchModel } from '../domain/model'
import { buildHitGrid, buildTree, defaultExpanded, findPageNode, layoutTree, pathTo, type GraphLayout, type LayoutMode, type TreeNode } from '../domain/graph'
import type { PageStatus } from '../domain/types'

/**
 * The cinematic site graph (§7) — a canvas, never a DOM tree, so thousands
 * of pages stay fluid (§33). Positions come from the pure layout in
 * domain/graph.ts; this component draws, culls, tweens and hit-tests.
 */

export interface SiteGraphProps {
  model: SearchModel
  scope: string | null
  selectedPageId: string | null
  onSelectPage: (pageId: string) => void
  onSelectGap?: (node: TreeNode) => void
  onSelectGroup?: (node: TreeNode) => void
  highlightFamily?: string | null
  /** compact embeds (home wall) hide the toolbar */
  compact?: boolean
  label: string
}

type Palette = Record<'ink1' | 'ink2' | 'ink3' | 'ink4' | 'exec' | 'ok' | 'attn' | 'flow' | 'cobalt' | 'neutral' | 'crit' | 'bg' | 'font', string>

const STATUS_COLOR: Record<PageStatus, keyof Palette> = {
  PLANNED: 'ink3', RESEARCHED: 'ink2', COPY_READY: 'flow', BUILDING: 'exec', QA: 'exec', READY: 'ok', PUBLISHED: 'ok', INDEXED: 'ok', NEEDS_WORK: 'attn',
}

function readPalette(el: Element): Palette {
  const s = getComputedStyle(el)
  const v = (n: string, f: string) => s.getPropertyValue(n).trim() || f
  return {
    ink1: v('--lc-ink-1', '#eef2f8'), ink2: v('--lc-ink-2', '#b9c2d0'), ink3: v('--lc-ink-3', '#7d8798'), ink4: v('--lc-ink-4', '#4a5363'),
    exec: v('--lc-exec', '#5ab8ff'), ok: v('--lc-ok', '#5fd39b'), attn: v('--lc-attn', '#f0b45a'), flow: v('--lc-flow', '#a58cff'),
    cobalt: v('--lc-cobalt', '#6d8cff'), neutral: v('--lc-neutral', '#8a93a3'), crit: v('--lc-crit', '#ff6b6b'), bg: v('--lc-mat-solid-bg', '#0a0d12'),
    font: v('--lc-font-ui', 'Inter, system-ui, sans-serif'),
  }
}

interface View { s: number; x: number; y: number }

export function SiteGraph({ model, scope, selectedPageId, onSelectPage, onSelectGap, onSelectGroup, highlightFamily, compact, label }: SiteGraphProps) {
  const reduced = useLcReducedMotion()
  const tree = useMemo(() => buildTree(model, scope), [model, scope])
  const [mode, setMode] = useState<LayoutMode>('radial')
  const [showLinks, setShowLinks] = useState(false)
  const defaults = useMemo(() => defaultExpanded(tree), [tree])
  const [expandedState, setExpanded] = useState<{ key: TreeNode; set: Set<string> } | null>(null)
  // derived reset when the tree identity changes (no setState in an effect)
  const expanded = expandedState && expandedState.key === tree ? expandedState.set : defaults
  const layout = useMemo(() => layoutTree(tree, expanded, mode), [tree, expanded, mode])
  const hit = useMemo(() => buildHitGrid(layout), [layout])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View>({ s: 1, x: 0, y: 0 })
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const paletteRef = useRef<Palette | null>(null)
  const prevPos = useRef<Map<string, { x: number; y: number }>>(new Map())
  const tweenRef = useRef<{ from: Map<string, { x: number; y: number }>; start: number } | null>(null)
  const hoverRef = useRef<number>(-1)
  const rafRef = useRef<number>(0)
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; text: string; sub: string } | null>(null)

  const selectedNodeId = useMemo(() => (selectedPageId ? findPageNode(tree, selectedPageId)?.id ?? null : null), [tree, selectedPageId])

  const fit = useCallback((l: GraphLayout) => {
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const b = l.bounds
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY)
    const s = Math.min(2.2, Math.max(0.05, Math.min((w - 80) / bw, (h - 80) / bh)))
    viewRef.current = { s, x: w / 2 - ((b.minX + b.maxX) / 2) * s, y: h / 2 - ((b.minY + b.maxY) / 2) * s }
  }, [])

  const drawRef = useRef<() => void>(() => {})
  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const { w, h, dpr } = sizeRef.current
    const P = paletteRef.current ?? (paletteRef.current = readPalette(c))
    const v = viewRef.current
    const now = performance.now()
    const tw = tweenRef.current
    const t = tw ? Math.min(1, (now - tw.start) / 320) : 1
    const ease = 1 - (1 - t) ** 3
    const pos = (i: number) => {
      const n = layout.nodes[i]
      const from = tw?.from.get(n.node.id) ?? (n.parent >= 0 ? tw?.from.get(layout.nodes[n.parent].node.id) : undefined)
      if (!from || t >= 1) return { x: n.x, y: n.y }
      return { x: from.x + (n.x - from.x) * ease, y: from.y + (n.y - from.y) * ease }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.translate(v.x, v.y)
    ctx.scale(v.s, v.s)
    const inv = 1 / v.s
    const minX = -v.x * inv - 40, minY = -v.y * inv - 40, maxX = (w - v.x) * inv + 40, maxY = (h - v.y) * inv + 40
    const visible = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY
    const dimmed = (n: TreeNode) => !!highlightFamily && n.family !== highlightFamily && n.kind !== 'property' && n.kind !== 'portfolio'
    const P_ = layout.nodes.map((_, i) => pos(i))

    // tree edges
    ctx.lineWidth = inv
    for (let i = 1; i < layout.nodes.length; i += 1) {
      const n = layout.nodes[i]
      const a = P_[n.parent], b = P_[i]
      if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue
      ctx.strokeStyle = n.node.kind === 'gap' ? P.ink4 : P.ink4
      ctx.globalAlpha = dimmed(n.node) ? 0.12 : n.node.kind === 'gap' ? 0.35 : 0.5
      ctx.beginPath()
      if (mode === 'tree') {
        const mx = (a.x + b.x) / 2
        ctx.moveTo(a.x, a.y)
        ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
      } else {
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(a.x * 0.35 + b.x * 0.65 - (b.y - a.y) * 0.08, a.y * 0.35 + b.y * 0.65 + (b.x - a.x) * 0.08, b.x, b.y)
      }
      if (n.node.kind === 'gap') ctx.setLineDash([4 * inv, 4 * inv])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // internal links (selected node always; all when enabled)
    const selIdx = selectedNodeId ? layout.index.get(selectedNodeId) ?? -1 : -1
    const drawLinksFor = (pageId: string, alpha: number, color: string) => {
      for (const l of [...(model.linksOut.get(pageId) ?? []), ...(model.linksIn.get(pageId) ?? [])]) {
        if (l.kind === 'parent') continue
        const ai = layout.index.get(`p:${l.fromPageId}`), bi = layout.index.get(`p:${l.toPageId}`)
        if (ai === undefined || bi === undefined) continue
        const a = P_[ai], b = P_[bi]
        ctx.strokeStyle = color
        ctx.globalAlpha = alpha
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo((a.x + b.x) / 2 * 0.7, (a.y + b.y) / 2 * 0.7, b.x, b.y)
        ctx.stroke()
      }
    }
    if (showLinks) {
      let drawn = 0
      for (const n of layout.nodes) {
        if (!n.node.pageId || drawn > 3000) continue
        for (const l of model.linksOut.get(n.node.pageId) ?? []) {
          if (l.kind === 'parent') continue
          const bi = layout.index.get(`p:${l.toPageId}`)
          if (bi === undefined) continue
          const a = P_[layout.index.get(n.node.id)!], b = P_[bi]
          if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue
          ctx.strokeStyle = l.anchorClusterId ? P.flow : P.cobalt
          ctx.globalAlpha = 0.12
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.quadraticCurveTo((a.x + b.x) / 2 * 0.7, (a.y + b.y) / 2 * 0.7, b.x, b.y)
          ctx.stroke()
          drawn += 1
        }
      }
    }
    if (selIdx >= 0 && layout.nodes[selIdx].node.pageId) { ctx.lineWidth = 1.4 * inv; drawLinksFor(layout.nodes[selIdx].node.pageId!, 0.7, P.cobalt) }

    // nodes
    ctx.lineWidth = 1.2 * inv
    const labels: Array<{ i: number; x: number; y: number; r: number }> = []
    for (let i = 0; i < layout.nodes.length; i += 1) {
      const ln = layout.nodes[i]
      const n = ln.node
      const p = P_[i]
      if (!visible(p.x, p.y)) continue
      const dim = dimmed(n)
      ctx.globalAlpha = dim ? 0.18 : 1
      let r = 3.4
      if (n.kind === 'property' || n.kind === 'portfolio') {
        r = 9
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34)
        grd.addColorStop(0, P.exec)
        grd.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = dim ? 0.06 : 0.28
        ctx.fillStyle = grd
        ctx.beginPath(); ctx.arc(p.x, p.y, 34, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = dim ? 0.18 : 1
        ctx.fillStyle = P.ink1
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = P.exec
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
      } else if (n.kind === 'group') {
        r = Math.min(16, 5 + Math.sqrt(n.size) * 1.1)
        const share = n.size ? n.ready / n.size : 0
        ctx.strokeStyle = P.ink3
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
        if (share > 0) { ctx.strokeStyle = P.ok; ctx.lineWidth = 2.2 * inv; ctx.beginPath(); ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1.2 * inv }
        if (n.gaps && n.family) { ctx.setLineDash([2 * inv, 3 * inv]); ctx.strokeStyle = P.ink2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
        ctx.globalAlpha = dim ? 0.12 : 0.82
        ctx.fillStyle = P.bg
        ctx.beginPath(); ctx.arc(p.x, p.y, r - 1.2 * inv, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = dim ? 0.18 : 1
      } else if (n.kind === 'gap') {
        r = 3.2
        ctx.setLineDash([2 * inv, 2 * inv])
        ctx.strokeStyle = P.ink2
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
        ctx.setLineDash([])
      } else {
        const page = n.pageId ? model.page.get(n.pageId) : null
        const col = n.status ? P[STATUS_COLOR[n.status]] : P.ink3
        r = ln.collapsed ? 5 : 3.4
        if (page && !page.stage.builtRoute) {
          ctx.strokeStyle = col
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
        } else {
          ctx.fillStyle = col
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill()
        }
        if (n.orphan) { ctx.strokeStyle = P.attn; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.4, 0, Math.PI * 2); ctx.stroke() }
        if (ln.collapsed) { ctx.strokeStyle = P.ink3; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke() }
      }
      if (i === selIdx || i === hoverRef.current) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = i === selIdx ? P.ink1 : P.ink2
        ctx.lineWidth = 1.6 * inv
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.stroke()
        ctx.lineWidth = 1.2 * inv
      }
      const screenR = r * v.s
      if (!dim && (n.kind !== 'page' || v.s > 0.9 || ln.depth <= 1 || i === selIdx || i === hoverRef.current) && (n.kind !== 'gap' || v.s > 1.1)) labels.push({ i, x: p.x, y: p.y, r: screenR })
    }
    ctx.restore()

    // labels in screen space (crisp), capped and de-overlapped coarsely
    ctx.globalAlpha = 1
    const taken: Array<[number, number, number, number]> = []
    let count = 0
    const ordered = labels.sort((a, b) => (a.i === selIdx ? -1 : b.i === selIdx ? 1 : layout.nodes[a.i].depth - layout.nodes[b.i].depth))
    for (const lb of ordered) {
      if (count > 240) break
      const n = layout.nodes[lb.i].node
      const sx = lb.x * v.s + v.x, sy = lb.y * v.s + v.y
      const text = n.kind === 'group' ? `${n.label} · ${n.size.toLocaleString()}` : n.kind === 'page' ? shortPath(n.label) : n.label
      const strong = n.kind === 'property' || n.kind === 'portfolio' || lb.i === selIdx
      ctx.font = `${strong ? 600 : 500} ${strong ? 12.5 : 11}px ${P.font}`
      const tw2 = ctx.measureText(text).width
      const right = mode === 'tree' || lb.x >= 0
      const lx = right ? sx + lb.r + 6 : sx - lb.r - 6 - tw2
      const ly = sy + 4
      const box: [number, number, number, number] = [lx - 2, ly - 11, lx + tw2 + 2, ly + 3]
      if (taken.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue
      taken.push(box)
      ctx.fillStyle = strong ? P.ink1 : n.kind === 'gap' ? P.ink3 : P.ink2
      ctx.fillText(text, lx, ly)
      count += 1
    }
    if (tw && t < 1) rafRef.current = requestAnimationFrame(() => drawRef.current())
    else tweenRef.current = null
  }, [layout, mode, model, selectedNodeId, showLinks, highlightFamily])

  useEffect(() => { drawRef.current = draw }, [draw])
  const schedule = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => drawRef.current())
  }, [])

  // latest callbacks for long-lived observers
  const latest = useRef({ fit, layout, schedule })
  useEffect(() => { latest.current = { fit, layout, schedule } }, [fit, layout, schedule])

  // size + DPR (one observer for the component's life)
  useEffect(() => {
    const wrap = wrapRef.current, c = canvasRef.current
    if (!wrap || !c) return
    let first = true
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      sizeRef.current = { w: r.width, h: r.height, dpr }
      c.width = Math.round(r.width * dpr)
      c.height = Math.round(r.height * dpr)
      c.style.width = `${r.width}px`
      c.style.height = `${r.height}px`
      if (first) { latest.current.fit(latest.current.layout); first = false }
      paletteRef.current = null
      latest.current.schedule()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // layout change → tween from previous positions, refit on scope/mode change
  const lastTree = useRef<TreeNode | null>(null)
  const lastMode = useRef<LayoutMode>(mode)
  useEffect(() => {
    if (lastTree.current !== tree || lastMode.current !== mode) {
      fit(layout)
      prevPos.current = new Map()
    }
    lastTree.current = tree
    lastMode.current = mode
    if (!reduced && prevPos.current.size) tweenRef.current = { from: prevPos.current, start: performance.now() }
    prevPos.current = new Map(layout.nodes.map((n) => [n.node.id, { x: n.x, y: n.y }]))
    schedule()
    return () => cancelAnimationFrame(rafRef.current)
  }, [layout, tree, mode, fit, reduced, schedule])

  // theme changes: re-read palette
  useEffect(() => {
    const obs = new MutationObserver(() => { paletteRef.current = null; latest.current.schedule() })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme', 'data-theme', 'class', 'style'] })
    return () => obs.disconnect()
  }, [])

  // external selection → open its branch and centre it
  const [seenSelection, setSeenSelection] = useState<string | null>(null)
  if (selectedNodeId !== seenSelection) {
    setSeenSelection(selectedNodeId)
    if (selectedNodeId && !layout.index.has(selectedNodeId)) {
      const path = pathTo(tree, selectedNodeId)
      if (path) {
        const next = new Set(expanded)
        for (const id of path.slice(0, -1)) next.add(id)
        setExpanded({ key: tree, set: next })
      }
    }
  }
  const pendingFocus = seenSelection
  useEffect(() => {
    if (!pendingFocus) return
    const i = layout.index.get(pendingFocus)
    if (i === undefined) return
    const { w, h } = sizeRef.current
    const n = layout.nodes[i]
    const v = viewRef.current
    const s = Math.max(v.s, 0.9)
    viewRef.current = { s, x: w / 2 - n.x * s, y: h / 2 - n.y * s }
    schedule()
  }, [pendingFocus, layout, schedule])

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded({ key: tree, set: next })
  }

  // pointer: pan + click
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const toLayout = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.s, y: (clientY - r.top - v.y) / v.s, sx: clientX - r.left, sy: clientY - r.top }
  }
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      if (d.moved) { viewRef.current = { ...viewRef.current, x: d.vx + dx, y: d.vy + dy }; schedule(); return }
    }
    const p = toLayout(e.clientX, e.clientY)
    const i = hit(p.x, p.y, 14 / viewRef.current.s)
    if (i !== hoverRef.current) {
      hoverRef.current = i
      const n = i >= 0 ? layout.nodes[i].node : null
      setHoverLabel(n ? { x: p.sx, y: p.sy, text: n.kind === 'page' ? n.label : n.label, sub: nodeSub(n, model) } : null)
      e.currentTarget.style.cursor = i >= 0 ? 'pointer' : 'grab'
      schedule()
    }
  }
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    drag.current = null
    if (d?.moved) return
    const p = toLayout(e.clientX, e.clientY)
    const i = hit(p.x, p.y, 14 / viewRef.current.s)
    if (i < 0) return
    const ln = layout.nodes[i]
    const n = ln.node
    if (n.kind === 'group') { toggle(n.id); onSelectGroup?.(n) }
    else if (n.kind === 'gap') onSelectGap?.(n)
    else if (n.kind === 'page' && n.pageId) { if (e.detail >= 2 && n.children.length) toggle(n.id); else onSelectPage(n.pageId) }
    else if (n.children.length && n.kind !== 'property' && n.kind !== 'portfolio') toggle(n.id)
  }
  const zoomAt = (factor: number, sx: number, sy: number) => {
    const v = viewRef.current
    const s = Math.min(6, Math.max(0.03, v.s * factor))
    const k = s / v.s
    viewRef.current = { s, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
    schedule()
  }
  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect()
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const { w, h } = sizeRef.current
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.25, w / 2, h / 2) }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(0.8, w / 2, h / 2) }
    else if (e.key === '0') { e.preventDefault(); fit(layout); schedule() }
  }

  const visibleCount = layout.nodes.length
  return (
    <div className="si-graph" data-compact={compact ? 'true' : undefined}>
      {!compact ? (
        <div className="si-graph__bar">
          <LCSegmented size="sm" label="Graph layout" value={mode} onChange={setMode} options={[{ value: 'radial', label: 'Radial' }, { value: 'tree', label: 'Tree' }]} />
          <LCIconButton icon="link" label={showLinks ? 'Hide internal links' : 'Show internal links'} size="sm" selected={showLinks} onClick={() => setShowLinks((x) => !x)} />
          <LCIconButton icon="maximize" label="Fit to view (0)" size="sm" onClick={() => { fit(layout); schedule() }} />
          <span className="si-graph__count">{visibleCount.toLocaleString()} visible of {tree.size.toLocaleString()} objects{layout.budgetCollapsed ? ` · ${layout.budgetCollapsed} groups held for clarity` : ''}</span>
        </div>
      ) : null}
      <div ref={wrapRef} className="si-graph__stage">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={label}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { hoverRef.current = -1; setHoverLabel(null); schedule() }}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        />
        {hoverLabel ? (
          <div className="si-graph__tip" style={{ left: hoverLabel.x, top: hoverLabel.y }}>
            <b>{hoverLabel.text}</b>
            <span>{hoverLabel.sub}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function shortPath(p: string) {
  if (p.length <= 34) return p
  const seg = p.split('/').filter(Boolean)
  return `…/${seg.slice(-2).join('/')}`
}

function nodeSub(n: TreeNode, m: SearchModel): string {
  if (n.kind === 'group') return `${n.size.toLocaleString()} objects · ${n.ready} ready${n.gaps ? ` · ${n.gaps} missing` : ''} — click to ${'expand / collapse'}`
  if (n.kind === 'gap') return 'Missing planned page — coverage gap'
  if (n.kind === 'property' || n.kind === 'portfolio') return `${n.size.toLocaleString()} objects · ${n.ready} ready`
  const p = n.pageId ? m.page.get(n.pageId) : null
  return p ? `${p.family.replace(/-/g, ' ')} · ${p.status.replace(/_/g, ' ').toLowerCase()}${n.orphan ? ' · orphan' : ''}${p.stage.builtRoute ? '' : ' · planned only'}` : ''
}
