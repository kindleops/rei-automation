/**
 * HOME LAYOUT ENGINE — pure geometry for the command board. No React, no DOM.
 *
 * A hidden magnetic grid: widgets snap to whole cells, never overlap, and
 * settle upward (vertical gravity) so the board never has holes the operator
 * did not leave. Moving or resizing one widget pushes the ones it lands on
 * down — predictably, in reading order — then everything settles. Locked
 * widgets do not move; others flow around them.
 *
 * GEOMETRY IS PER WIDTH FAMILY. A board composed on a 49" ultrawide keeps that
 * composition; opening it on a laptop derives a laptop arrangement (same
 * reading order, packed into fewer columns) without touching the ultrawide
 * one. A family gets its own stored geometry the first time the operator
 * edits at that width.
 */

export interface Cell { x: number; y: number; w: number; h: number }
export interface GridItem { id: string; cell: Cell; locked?: boolean }
export interface Bounds { min: { w: number; h: number }; max: { w: number; h: number } }

export type Family = 'narrow' | 'standard' | 'wide' | 'ultra' | 'wall'

export const FAMILIES: readonly Family[] = ['narrow', 'standard', 'wide', 'ultra', 'wall']

/** Board width → family. Columns keep a roughly constant physical width, so wider boards hold more instruments, not bigger ones. */
export const FAMILY_SPEC: Record<Family, { cols: number; minWidth: number; label: string }> = {
  narrow: { cols: 6, minWidth: 0, label: 'Narrow pane' },
  standard: { cols: 12, minWidth: 820, label: 'Laptop / desktop' },
  wide: { cols: 16, minWidth: 1500, label: 'Wide display' },
  ultra: { cols: 24, minWidth: 2400, label: 'Ultrawide' },
  wall: { cols: 32, minWidth: 3600, label: 'Command wall' },
}

export function familyFor(width: number): Family {
  let out: Family = 'narrow'
  for (const f of FAMILIES) if (width >= FAMILY_SPEC[f].minWidth) out = f
  return out
}

export const colsOf = (f: Family) => FAMILY_SPEC[f].cols

/** Pixel metrics for a board width: column width, row height (aspect follows the column), gap. */
export function metricsFor(width: number, family: Family = familyFor(width)) {
  const cols = colsOf(family)
  const gap = width >= 2400 ? 18 : 14
  const colW = Math.max(40, (width - gap * (cols - 1)) / cols)
  const rowH = Math.round(Math.min(92, Math.max(52, colW * 0.62)))
  return { cols, gap, colW, rowH }
}

export type GridMetrics = ReturnType<typeof metricsFor>

export function cellToRect(c: Cell, m: GridMetrics) {
  return {
    left: c.x * (m.colW + m.gap),
    top: c.y * (m.rowH + m.gap),
    width: c.w * m.colW + (c.w - 1) * m.gap,
    height: c.h * m.rowH + (c.h - 1) * m.gap,
  }
}

/** The cell a widget of size w×h would occupy with its top-left at pixel (px, py). Magnetic: rounds to the nearest cell. */
export function pointToCell(px: number, py: number, w: number, h: number, m: GridMetrics): Cell {
  const x = Math.round(px / (m.colW + m.gap))
  const y = Math.round(py / (m.rowH + m.gap))
  return { x: clamp(x, 0, Math.max(0, m.cols - w)), y: Math.max(0, y), w, h }
}

export function boardRows(items: readonly GridItem[]): number {
  return items.reduce((n, i) => Math.max(n, i.cell.y + i.cell.h), 0)
}

/* ── collision ───────────────────────────────────────────────────────── */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function collides(a: Cell, b: Cell): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function anyOverlap(items: readonly GridItem[]): boolean {
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) if (collides(items[i].cell, items[j].cell)) return true
  return false
}

const byReading = (a: GridItem, b: GridItem) => a.cell.y - b.cell.y || a.cell.x - b.cell.x || (a.id < b.id ? -1 : 1)

/** Clamp a footprint into the grid and the widget's bounds. */
export function fitCell(c: Cell, cols: number, bounds?: Bounds): Cell {
  const minW = Math.min(cols, bounds?.min.w ?? 1)
  const maxW = Math.min(cols, bounds?.max.w ?? cols)
  const w = clamp(Math.round(c.w), Math.max(1, minW), Math.max(1, maxW))
  const h = clamp(Math.round(c.h), Math.max(1, bounds?.min.h ?? 1), Math.max(1, bounds?.max.h ?? 24))
  return { x: clamp(Math.round(c.x), 0, cols - w), y: Math.max(0, Math.round(c.y)), w, h }
}

/**
 * Settle: every unlocked widget rises as far as it can, in reading order.
 * Locked widgets stay exactly where they are.
 */
export function compact(items: readonly GridItem[]): GridItem[] {
  const fixed = items.filter((i) => i.locked)
  const placed: GridItem[] = [...fixed]
  const out = new Map<string, GridItem>(fixed.map((i) => [i.id, i]))
  for (const it of [...items].filter((i) => !i.locked).sort(byReading)) {
    const c = { ...it.cell }
    // rise while free
    while (c.y > 0 && !placed.some((p) => collides({ ...c, y: c.y - 1 }, p.cell))) c.y -= 1
    // never rest overlapping (an unresolved input): drop until free
    while (placed.some((p) => collides(c, p.cell))) c.y += 1
    const next = { ...it, cell: c }
    placed.push(next)
    out.set(it.id, next)
  }
  return items.map((i) => out.get(i.id)!)
}

/**
 * Put `id` at `cell` and make room. The widget is lifted first (the rest
 * settle into the space it left — neighbours make room), then lands: whatever
 * it lands on moves down below it, cascading in reading order. A locked
 * widget is never moved — the mover slides below it instead. Then everything
 * settles. Dragging a widget onto the lower half of a neighbour therefore
 * lands it after that neighbour; onto the upper half, before it.
 */
export function placeItem(items: readonly GridItem[], id: string, cell: Cell, cols: number): GridItem[] {
  const target = items.find((i) => i.id === id)
  if (!target) return [...items]
  const c = fitCell(cell, cols)
  const locked = items.filter((i) => i.locked && i.id !== id)
  while (locked.some((l) => collides(c, l.cell))) {
    const blocker = locked.filter((l) => collides(c, l.cell)).sort((a, b) => b.cell.y + b.cell.h - (a.cell.y + a.cell.h))[0]
    c.y = blocker.cell.y + blocker.cell.h
  }
  const rest = compact(items.filter((i) => i.id !== id))
  // landing on the lower half of a neighbour means "after it"
  for (let guard = 0; guard < items.length; guard += 1) {
    const under = rest.find((o) => collides(c, o.cell) && c.y > o.cell.y && c.y - o.cell.y >= o.cell.h / 2)
    if (!under) break
    c.y = under.cell.y + under.cell.h
  }
  while (locked.some((l) => collides(c, l.cell))) c.y = Math.max(...locked.filter((l) => collides(c, l.cell)).map((l) => l.cell.y + l.cell.h))
  const work = new Map<string, GridItem>(rest.map((i) => [i.id, { ...i, cell: { ...i.cell } }]))
  work.set(id, { ...target, cell: c })

  const push = (moverId: string, depth: number) => {
    if (depth > items.length + 2) return
    const mover = work.get(moverId)!
    const hits = [...work.values()].filter((o) => o.id !== moverId && o.id !== id && !o.locked && collides(mover.cell, o.cell)).sort(byReading)
    for (const o of hits) {
      o.cell.y = mover.cell.y + mover.cell.h
      // a pushed widget that now sits on a locked one goes below it
      while (locked.some((l) => collides(o.cell, l.cell))) {
        const b = locked.find((l) => collides(o.cell, l.cell))!
        o.cell.y = b.cell.y + b.cell.h
      }
      push(o.id, depth + 1)
    }
  }
  push(id, 0)
  return settleAround(items.map((i) => work.get(i.id)!), id)
}

/**
 * Settle everything except the widget just placed (so it lands exactly where
 * it was dropped when that spot is free), then the placed widget itself rises
 * only into space directly above it that is free.
 */
function settleAround(items: GridItem[], placedId: string): GridItem[] {
  const pinned = items.map((i) => (i.id === placedId ? { ...i, locked: true } : i))
  const settled = compact(pinned)
  const restore = new Map(items.map((i) => [i.id, i.locked]))
  const again = settled.map((i) => ({ ...i, locked: restore.get(i.id) }))
  return compact(again)
}

export function resizeItem(items: readonly GridItem[], id: string, size: { w: number; h: number }, cols: number, bounds?: Bounds): GridItem[] {
  const it = items.find((i) => i.id === id)
  if (!it) return [...items]
  const c = fitCell({ ...it.cell, w: size.w, h: size.h }, cols, bounds)
  // growing past the right edge shifts left rather than refusing
  if (c.x + c.w > cols) c.x = Math.max(0, cols - c.w)
  return placeItem(items, id, c, cols)
}

/** First free spot for a w×h widget, scanning rows top-down then columns left-right. */
export function firstFit(items: readonly GridItem[], w: number, h: number, cols: number, fromY = 0): Cell {
  const ww = Math.min(w, cols)
  for (let y = fromY; y < 400; y += 1) {
    for (let x = 0; x + ww <= cols; x += 1) {
      const c = { x, y, w: ww, h }
      if (!items.some((i) => collides(c, i.cell))) return c
    }
  }
  return { x: 0, y: boardRows(items), w: ww, h }
}

/**
 * Derive a family's arrangement from another one: same reading order, each
 * widget keeps its footprint (clamped to the narrower grid) and takes the
 * first free spot. Deterministic, so the same source always yields the same
 * board.
 */
export function deriveLayout(source: readonly GridItem[], cols: number, boundsOf?: (id: string) => Bounds | undefined): GridItem[] {
  const out: GridItem[] = []
  for (const it of [...source].sort(byReading)) {
    const b = boundsOf?.(it.id)
    const w = Math.min(cols, Math.max(b?.min.w ?? 1, it.cell.w))
    const c = firstFit(out, w, it.cell.h, cols)
    out.push({ id: it.id, cell: fitCell(c, cols, b), locked: false })
  }
  return out
}

/** Make any stored arrangement valid: inside the grid, inside bounds, no overlaps (locked first, then reading order). */
export function sanitize(items: readonly GridItem[], cols: number, boundsOf?: (id: string) => Bounds | undefined): GridItem[] {
  const fitted = items.map((i) => ({ ...i, cell: fitCell(i.cell, cols, boundsOf?.(i.id)) }))
  const placed: GridItem[] = []
  for (const it of [...fitted].sort((a, b) => Number(Boolean(b.locked)) - Number(Boolean(a.locked)) || byReading(a, b))) {
    let c = it.cell
    if (placed.some((p) => collides(c, p.cell))) c = it.locked ? firstFit(placed, c.w, c.h, cols, c.y) : firstFit(placed, c.w, c.h, cols, c.y)
    placed.push({ ...it, cell: c })
  }
  const byId = new Map(placed.map((p) => [p.id, p]))
  return compact(fitted.map((i) => byId.get(i.id)!))
}

/* ── keyboard ────────────────────────────────────────────────────────── */

export type Nudge = 'left' | 'right' | 'up' | 'down'

export function nudge(items: readonly GridItem[], id: string, dir: Nudge, cols: number, mode: 'move' | 'resize', bounds?: Bounds): GridItem[] {
  const it = items.find((i) => i.id === id)
  if (!it) return [...items]
  const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0
  const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0
  if (mode === 'resize') return resizeItem(items, id, { w: it.cell.w + dx, h: it.cell.h + dy }, cols, bounds)
  // moving up past a neighbour swaps over it: target the row above the widget above
  let y = it.cell.y + dy
  if (dy < 0) {
    const above = items.filter((o) => o.id !== id && o.cell.y + o.cell.h <= it.cell.y && o.cell.x < it.cell.x + it.cell.w && it.cell.x < o.cell.x + o.cell.w)
    const nearest = above.sort((a, b) => b.cell.y + b.cell.h - (a.cell.y + a.cell.h))[0]
    if (nearest && nearest.cell.y + nearest.cell.h === it.cell.y) y = nearest.cell.y
  }
  if (dy > 0) {
    const below = items.filter((o) => o.id !== id && o.cell.y >= it.cell.y + it.cell.h && o.cell.x < it.cell.x + it.cell.w && it.cell.x < o.cell.x + o.cell.w)
    const nearest = below.sort((a, b) => a.cell.y - b.cell.y)[0]
    if (nearest && nearest.cell.y === it.cell.y + it.cell.h) y = it.cell.y + nearest.cell.h
  }
  return placeItem(items, id, { ...it.cell, x: it.cell.x + dx, y: Math.max(0, y) }, cols)
}

/* ── snaplines ───────────────────────────────────────────────────────── */

/** Edges of other widgets the moving cell aligns with — shown as quiet guides while dragging. */
export function snaplines(items: readonly GridItem[], id: string, c: Cell): { x: number[]; y: number[] } {
  const xs = new Set<number>()
  const ys = new Set<number>()
  for (const o of items) {
    if (o.id === id) continue
    for (const e of [c.x, c.x + c.w]) if (e === o.cell.x || e === o.cell.x + o.cell.w) xs.add(e)
    for (const e of [c.y, c.y + c.h]) if (e === o.cell.y || e === o.cell.y + o.cell.h) ys.add(e)
  }
  return { x: [...xs], y: [...ys] }
}
