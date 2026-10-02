import { describe, expect, it } from 'vitest'
import {
  anyOverlap,
  cellToRect,
  collides,
  compact,
  deriveLayout,
  familyFor,
  firstFit,
  metricsFor,
  nudge,
  placeItem,
  pointToCell,
  resizeItem,
  sanitize,
  snaplines,
  type GridItem,
} from './home-grid'

const it_ = (id: string, x: number, y: number, w: number, h: number, locked = false): GridItem => ({ id, cell: { x, y, w, h }, locked })
const at = (items: GridItem[], id: string) => items.find((i) => i.id === id)!.cell

describe('home grid — families', () => {
  it('maps board width to a family with roughly constant column width', () => {
    expect(familyFor(600)).toBe('narrow')
    expect(familyFor(1150)).toBe('standard')
    expect(familyFor(1780)).toBe('wide')
    expect(familyFor(3000)).toBe('ultra')
    expect(familyFor(4980)).toBe('wall')
    const laptop = metricsFor(1150)
    const wall = metricsFor(4980)
    expect(wall.cols).toBe(32)
    expect(wall.colW / laptop.colW).toBeLessThan(2)
  })

  it('converts cells to pixels and pixels back to the nearest cell', () => {
    const m = metricsFor(1200)
    const r = cellToRect({ x: 2, y: 1, w: 3, h: 2 }, m)
    expect(r.left).toBeCloseTo(2 * (m.colW + m.gap))
    expect(r.width).toBeCloseTo(3 * m.colW + 2 * m.gap)
    expect(pointToCell(r.left + 10, r.top + 5, 3, 2, m)).toEqual({ x: 2, y: 1, w: 3, h: 2 })
    // never outside the grid
    expect(pointToCell(99_999, -50, 3, 2, m)).toEqual({ x: m.cols - 3, y: 0, w: 3, h: 2 })
  })
})

describe('home grid — collision and settling', () => {
  it('detects overlap only when cells share area', () => {
    expect(collides({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false)
    expect(collides({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true)
  })

  it('settles widgets upward without moving locked ones', () => {
    const out = compact([it_('a', 0, 5, 4, 2), it_('l', 4, 3, 4, 2, true), it_('b', 4, 9, 4, 2)])
    expect(at(out, 'a').y).toBe(0)
    expect(at(out, 'l').y).toBe(3)
    expect(at(out, 'b').y).toBe(5)
    expect(anyOverlap(out)).toBe(false)
  })

  it('pushes what a widget lands on down, then settles — never overlapping', () => {
    const items = [it_('a', 0, 0, 4, 4), it_('b', 4, 0, 4, 4), it_('c', 8, 0, 4, 4)]
    const out = placeItem(items, 'c', { x: 0, y: 0, w: 4, h: 4 }, 12)
    expect(at(out, 'c')).toEqual({ x: 0, y: 0, w: 4, h: 4 })
    expect(at(out, 'a')).toEqual({ x: 0, y: 4, w: 4, h: 4 })
    expect(anyOverlap(out)).toBe(false)
  })

  it('lands after a neighbour when dropped on its lower half, before it on the upper half', () => {
    const items = [it_('a', 0, 0, 4, 4), it_('b', 0, 4, 4, 4)]
    const after = placeItem(items, 'a', { x: 0, y: 2, w: 4, h: 4 }, 12) // b lifts to 0; a's top is in b's lower half
    expect(at(after, 'b').y).toBe(0)
    expect(at(after, 'a').y).toBe(4)
    const before = placeItem(items, 'b', { x: 0, y: 0, w: 4, h: 4 }, 12)
    expect(at(before, 'b').y).toBe(0)
    expect(at(before, 'a').y).toBe(4)
  })

  it('slides a dropped widget below a locked one instead of moving it', () => {
    const items = [it_('l', 0, 0, 6, 3, true), it_('a', 6, 0, 6, 3)]
    const out = placeItem(items, 'a', { x: 2, y: 0, w: 6, h: 3 }, 12)
    expect(at(out, 'l')).toEqual({ x: 0, y: 0, w: 6, h: 3 })
    expect(at(out, 'a').y).toBe(3)
    expect(anyOverlap(out)).toBe(false)
  })

  it('resizes within bounds and the grid, reflowing neighbours', () => {
    const items = [it_('a', 0, 0, 4, 4), it_('b', 4, 0, 4, 4)]
    const out = resizeItem(items, 'a', { w: 8, h: 4 }, 12, { min: { w: 3, h: 2 }, max: { w: 6, h: 8 } })
    expect(at(out, 'a').w).toBe(6)
    expect(anyOverlap(out)).toBe(false)
    const tiny = resizeItem(items, 'a', { w: 1, h: 1 }, 12, { min: { w: 3, h: 2 }, max: { w: 6, h: 8 } })
    expect(at(tiny, 'a')).toMatchObject({ w: 3, h: 2 })
  })

  it('finds the first free spot in reading order', () => {
    const items = [it_('a', 0, 0, 4, 4), it_('b', 4, 0, 4, 2)]
    expect(firstFit(items, 4, 2, 12)).toEqual({ x: 8, y: 0, w: 4, h: 2 })
    expect(firstFit(items, 6, 2, 12)).toEqual({ x: 4, y: 2, w: 6, h: 2 })
  })
})

describe('home grid — per-width families', () => {
  it('derives a narrower arrangement in the same reading order without overlap', () => {
    const wall = [it_('map', 0, 0, 8, 6), it_('focus', 8, 0, 4, 6), it_('inbox', 12, 0, 4, 4), it_('pipe', 16, 0, 6, 4)]
    const laptop = deriveLayout(wall, 12)
    expect(anyOverlap(laptop)).toBe(false)
    expect(laptop.every((i) => i.cell.x + i.cell.w <= 12)).toBe(true)
    const order = [...laptop].sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x).map((i) => i.id)
    expect(order).toEqual(['map', 'focus', 'inbox', 'pipe'])
    // a narrow pane clamps widths to its 6 columns
    expect(deriveLayout(wall, 6).every((i) => i.cell.w <= 6)).toBe(true)
  })

  it('sanitizes stored geometry: out of grid, overlapping, absurd sizes', () => {
    const bad = [it_('a', 30, -2, 40, 3), it_('b', 0, 0, 4, 4), it_('c', 1, 1, 4, 4)]
    const out = sanitize(bad, 12, () => ({ min: { w: 3, h: 2 }, max: { w: 8, h: 8 } }))
    expect(anyOverlap(out)).toBe(false)
    expect(out.every((i) => i.cell.x >= 0 && i.cell.x + i.cell.w <= 12 && i.cell.y >= 0)).toBe(true)
    expect(at(out, 'a').w).toBe(8)
  })
})

describe('home grid — keyboard and guides', () => {
  it('moves down past the neighbour below and back up over it', () => {
    const items = [it_('a', 0, 0, 4, 3), it_('b', 0, 3, 4, 2)]
    const down = nudge(items, 'a', 'down', 12, 'move')
    expect(at(down, 'b').y).toBe(0)
    expect(at(down, 'a').y).toBe(2)
    const up = nudge(down, 'a', 'up', 12, 'move')
    expect(at(up, 'a').y).toBe(0)
    expect(at(up, 'b').y).toBe(3)
  })

  it('moves sideways and resizes from the keyboard', () => {
    const items = [it_('a', 0, 0, 4, 3)]
    expect(at(nudge(items, 'a', 'right', 12, 'move'), 'a').x).toBe(1)
    expect(at(nudge(items, 'a', 'left', 12, 'move'), 'a').x).toBe(0)
    expect(at(nudge(items, 'a', 'right', 12, 'resize'), 'a').w).toBe(5)
    expect(at(nudge(items, 'a', 'down', 12, 'resize'), 'a').h).toBe(4)
  })

  it('reports aligned edges as snaplines', () => {
    const items = [it_('a', 0, 0, 4, 3), it_('b', 4, 0, 4, 3)]
    const lines = snaplines(items, 'b', { x: 4, y: 3, w: 4, h: 3 })
    expect(lines.x).toContain(4)
    expect(lines.y).toContain(3)
  })
})
