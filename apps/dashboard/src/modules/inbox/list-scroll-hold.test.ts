import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anchoredRowShift, heldScrollTop, shouldApplyInitialOffset, snapshotVisibleRows } from './list-scroll-hold'

const ROW = 64
const VIEWPORT_ROWS = 11
const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

/** A deterministic scroller: rows of fixed height, operator parked mid-list. */
function parkedAt(rows: string[], startIndex: number) {
  const scrollTop = startIndex * ROW + 17 // mid-row, like a real thumb
  const snapshot = snapshotVisibleRows(rows, startIndex, startIndex + VIEWPORT_ROWS - 1)
  return { scrollTop, snapshot }
}
const firstVisible = (rows: string[], scrollTop: number) => rows[Math.floor(scrollTop / ROW)]

/** The pre-fix ledger anchor: followed the single first-visible row. */
function legacySingleRowAnchor(scrollTop: number, anchor: { id: string; index: number }, next: string[]) {
  const at = next.indexOf(anchor.id)
  return at >= 0 && at !== anchor.index ? scrollTop + (at - anchor.index) * ROW : scrollTop
}

describe('inbox list scroll hold — data never moves the list', () => {
  const rows = ids(300)

  it('reproduces the defect: the old single-row anchor sent the list to the top when that row got a reply', () => {
    const { scrollTop } = parkedAt(rows, 120)
    const resorted = ['t120', ...rows.filter((id) => id !== 't120')]
    expect(legacySingleRowAnchor(scrollTop, { id: 't120', index: 120 }, resorted)).toBe(17)
    expect(firstVisible(resorted, legacySingleRowAnchor(scrollTop, { id: 't120', index: 120 }, resorted))).toBe('t120')
  })

  it('a visible row re-sorting to the top does not drag the viewport', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    const resorted = ['t120', ...rows.filter((id) => id !== 't120')]
    const next = heldScrollTop(scrollTop, snapshot, resorted, ROW)
    expect(Math.abs(next - scrollTop)).toBeLessThanOrEqual(ROW)
    expect(next).toBeGreaterThan(100 * ROW)
  })

  it('a realtime update that only refreshes rows keeps scrollTop exactly', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    expect(heldScrollTop(scrollTop, snapshot, [...rows], ROW)).toBe(scrollTop)
  })

  it('a row re-sorting from BELOW the fold to the top keeps the visible rows in place', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    const resorted = ['t250', ...rows.filter((id) => id !== 't250')]
    const next = heldScrollTop(scrollTop, snapshot, resorted, ROW)
    expect(next).toBe(scrollTop + ROW)
    expect(firstVisible(resorted, next)).toBe('t120')
  })

  it('a brand-new conversation landing on top keeps what you are reading', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    const next = heldScrollTop(scrollTop, snapshot, ['new1', 'new2', ...rows], ROW)
    expect(next).toBe(scrollTop + 2 * ROW)
    expect(firstVisible(['new1', 'new2', ...rows], next)).toBe('t120')
  })

  it('Load More (append below) leaves scrollTop alone', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 280)
    expect(heldScrollTop(scrollTop, snapshot, [...rows, ...ids(200, 'p2-')], ROW)).toBe(scrollTop)
  })

  it('a row archived above the fold pulls the list up by exactly one row', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    const next = heldScrollTop(scrollTop, snapshot, rows.filter((id) => id !== 't3'), ROW)
    expect(next).toBe(scrollTop - ROW)
  })

  it('the first visible row disappearing holds the rows after it in place', () => {
    const { scrollTop, snapshot } = parkedAt(rows, 120)
    const next = rows.filter((id) => id !== 't120')
    const held = heldScrollTop(scrollTop, snapshot, next, ROW)
    // t121 sat at the same screen offset before and after
    expect(next.indexOf('t121') * ROW - held).toBe(rows.indexOf('t121') * ROW - scrollTop)
  })

  it('a burst of realtime updates and loads keeps the same row first in view', () => {
    let current = [...rows]
    let { scrollTop, snapshot } = parkedAt(current, 150)
    const steps: Array<(r: string[]) => string[]> = [
      (r) => [...r],
      (r) => [...r, ...ids(200, 'more-')],
      (r) => ['t160', ...r.filter((id) => id !== 't160')],
      (r) => ['fresh', ...r],
      (r) => ['t10', ...r.filter((id) => id !== 't10')],
      (r) => [...r],
    ]
    for (const step of steps) {
      const next = step(current)
      scrollTop = heldScrollTop(scrollTop, snapshot, next, ROW)
      current = next
      const start = Math.floor(scrollTop / ROW)
      snapshot = snapshotVisibleRows(current, start, start + VIEWPORT_ROWS - 1)
    }
    expect(firstVisible(current, scrollTop)).toBe('t150')
  })

  it('at the very top the list stays at the top', () => {
    const snapshot = snapshotVisibleRows(rows, 0, 10)
    expect(heldScrollTop(0, snapshot, ['new', ...rows], ROW)).toBe(0)
  })

  it('no snapshot / no surviving rows means no movement', () => {
    expect(anchoredRowShift(null, rows)).toBe(0)
    expect(anchoredRowShift(snapshotVisibleRows(rows, 5, 8), ids(3, 'x'))).toBe(0)
  })

  it('the virtual list applies its initial offset once, never again on later updates', () => {
    expect(shouldApplyInitialOffset(false, 0)).toBe(false)
    expect(shouldApplyInitialOffset(false, 40)).toBe(true)
    expect(shouldApplyInitialOffset(true, 41)).toBe(false)
  })
})

describe('inbox list scroll hold — no self-scrolling effects remain', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const ledger = readFileSync(join(here, 'desk/InboxDeskLedger.tsx'), 'utf8')
  const sidebar = readFileSync(join(here, 'components/InboxSidebar.tsx'), 'utf8')

  it('the desk ledger scrolls to the cursor only from a keyboard move, not on row changes', () => {
    expect(ledger).not.toMatch(/useEffect\(\(\)\s*=>\s*\{\s*scrollCursorIntoView/)
    expect(ledger).not.toMatch(/\[rowIds\]\)\s*\n\s*\n\s*useEffect\(\(\) => \{ scrollCursorIntoView/)
    expect(ledger).toMatch(/moveCursorTo\(moveCursor\(/)
  })

  it('the phone/rail list never scrollIntoViews the selected thread and Load More never restores scrollTop', () => {
    expect(sidebar).not.toMatch(/selectedNode\.scrollIntoView/)
    expect(sidebar).not.toMatch(/scrollPreserveRef/)
    expect(sidebar).toMatch(/overflowAnchor: 'none'/)
  })
})
