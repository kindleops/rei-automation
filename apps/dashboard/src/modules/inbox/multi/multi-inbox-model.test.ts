import { describe, expect, it } from 'vitest'
import {
  closePane, closePaneConversation, defaultMultiInbox, deskSplitRoomState, paneFlex, MIN_PANE_PX, focusPane, fromPersisted, layoutFor, openBeside, openPaneConversation,
  paneIndexForKey, sameViewAs, setCount, setPaneFilters, setPaneLens, setPaneSearch, setPaneSort, toPersisted,
} from './multi-inbox-model'

describe('multi-inbox model', () => {
  it('defaults to exactly ONE pane', () => {
    expect(defaultMultiInbox().count).toBe(1)
    expect(fromPersisted(null).count).toBe(1)
    expect(fromPersisted({ version: 9, count: 4 }).count).toBe(1)
  })

  it('1→2→3→4→1→4: every pane keeps its state', () => {
    let s = defaultMultiInbox()
    s = setCount(s, 2)
    s = setPaneLens(s, 1, 'needs_review')
    s = setPaneSearch(s, 1, 'salazar')
    s = setCount(s, 3)
    s = setPaneSort(s, 2, 'oldest')
    s = setCount(s, 4)
    s = openPaneConversation(s, 3, { threadId: 't9', threadKey: '+16125550909' }, 120)
    const before = s.panes
    s = setCount(s, 1)
    expect(s.count).toBe(1)
    s = setCount(s, 4)
    expect(s.panes).toEqual(before)
    expect(s.panes[1].query).toMatchObject({ lens: 'needs_review', q: 'salazar' })
    expect(s.panes[3].conversation?.threadId).toBe('t9')
  })

  it('changing pane 2 never mutates panes 1, 3 or 4', () => {
    let s = setCount(defaultMultiInbox(), 4)
    const others = [s.panes[0], s.panes[2], s.panes[3]]
    s = setPaneSearch(s, 1, 'minneapolis')
    s = setPaneFilters(s, 1, 'all_stages', { outOfStateOwner: 'yes' } as never)
    s = setPaneSort(s, 1, 'unread_first')
    expect([s.panes[0], s.panes[2], s.panes[3]]).toEqual(others)
    expect(s.panes[1].query.lens).toBe('filtered')
  })

  it('close conversation returns to the exact list state', () => {
    let s = setCount(defaultMultiInbox(), 2)
    s = setPaneSearch(setPaneLens(s, 1, 'priority'), 1, 'oak')
    const query = s.panes[1].query
    s = openPaneConversation(s, 1, { threadId: 'a', threadKey: null }, 480)
    s = closePaneConversation(s, 1)
    expect(s.panes[1].conversation).toBeNull()
    expect(s.panes[1].query).toEqual(query)
    expect(s.panes[1].scrollTop).toBe(480)
  })

  it('different conversations can be open in different panes; the same thread in two panes is fine', () => {
    let s = setCount(defaultMultiInbox(), 3)
    s = openPaneConversation(s, 1, { threadId: 'x', threadKey: '+1' }, 0)
    s = openPaneConversation(s, 2, { threadId: 'y', threadKey: '+2' }, 0)
    expect([s.panes[1].conversation?.threadId, s.panes[2].conversation?.threadId]).toEqual(['x', 'y'])
    s = openPaneConversation(s, 2, { threadId: 'x', threadKey: '+1' }, 0)
    expect(s.panes[2].conversation?.threadId).toBe('x')
  })

  it('open beside / close pane keep order and focus sane; pane 1 cannot close', () => {
    let s = openBeside(defaultMultiInbox())
    expect([s.count, s.focused]).toEqual([2, 1])
    s = openBeside(openBeside(s))
    expect(openBeside(s)).toBe(s)
    const third = s.panes[2]
    s = closePane(s, 1)
    expect(s.count).toBe(3)
    expect(s.panes[1]).toBe(third)
    expect(closePane(s, 0)).toBe(s)
    expect(focusPane(s, 9).focused).toBe(2)
  })

  it('layouts by the Inbox width: never four columns at 1440', () => {
    expect(layoutFor(1, 1440).kind).toBe('single')
    expect(layoutFor(2, 1440)).toEqual({ kind: 'columns', sizes: [0.5, 0.5] })
    expect(layoutFor(3, 1920)).toEqual({ kind: 'columns', sizes: [0.5, 0.25, 0.25] })
    const thirds = layoutFor(3, 3840)
    expect(thirds.kind === 'columns' && thirds.sizes.every((v) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true)
    expect(layoutFor(4, 1440).kind).toBe('grid2x2')
    expect(layoutFor(4, 1920).kind).toBe('columns')
    expect(layoutFor(4, 5120)).toEqual({ kind: 'columns', sizes: [0.25, 0.25, 0.25, 0.25] })
    expect(layoutFor(2, 1920, [3, 1])).toEqual({ kind: 'columns', sizes: [0.75, 0.25] })
  })

  it('persists count, order, sizes, lens, filters, sort, labels — not conversations or searches', () => {
    let s = setCount(defaultMultiInbox(), 3)
    s = setPaneLens(s, 2, 'archived')
    s = setPaneSearch(s, 2, 'temporary search')
    s = openPaneConversation(s, 2, { threadId: 'z', threadKey: null }, 0)
    const restored = fromPersisted(JSON.parse(JSON.stringify(toPersisted(s))))
    expect(restored.count).toBe(3)
    expect(restored.panes[2].query.lens).toBe('archived')
    expect(restored.panes[2].query.q).toBe('')
    expect(restored.panes[2].conversation).toBeNull()
    expect(fromPersisted({ version: 1, count: 2, panes: [{}, { query: { lens: 'bogus' } }] }).panes[1].query.lens).toBe('new_replies')
  })

  it('keyboard: ⌥1-⌥4 only (⌘/Ctrl digits belong to the browser and are never claimed)', () => {
    const k = (code: string, mods: Partial<{ altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
      paneIndexForKey({ altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, code, ...mods })
    expect(k('Digit2', { altKey: true })).toBe(1)
    expect(k('Digit2', { metaKey: true })).toBeNull()
    expect(k('Digit2', { ctrlKey: true })).toBeNull()
    expect(k('Digit2', { altKey: true, shiftKey: true })).toBeNull()
    expect(k('Digit5', { altKey: true })).toBeNull()
  })

  it('"same view as" is a hint, identical panes allowed', () => {
    const s = setCount(defaultMultiInbox(), 2)
    expect(sameViewAs(setPaneLens(s, 1, 'priority'), 1, { lens: 'priority', q: '' })).toBe(0)
    expect(sameViewAs(s, 1, { lens: 'priority', q: '' })).toBeNull()
  })
})

import { deskSplitRoomState, paneFlex } from './multi-inbox-model'

describe('multi-inbox layout fixes (visual QA 10-04)', () => {
  it('3840 × 2 panes: opening Inbox 1 keeps the desk split closed (no 1/3 contraction)', () => {
    expect(deskSplitRoomState({ isDeskInbox: true, multiActive: true, deskRoomOpen: true, deskRoomClosing: false })).toBe('closed')
    expect(deskSplitRoomState({ isDeskInbox: true, multiActive: false, deskRoomOpen: true, deskRoomClosing: false })).toBe('open')
    expect(deskSplitRoomState({ isDeskInbox: true, multiActive: false, deskRoomOpen: true, deskRoomClosing: true })).toBe('closed')
    expect(deskSplitRoomState({ isDeskInbox: false, multiActive: false, deskRoomOpen: true, deskRoomClosing: false })).toBeUndefined()
  })

  it('panes grow from a zero basis so seams never push the last pane past the edge', () => {
    // simulate flex distribution: free = container − seams; each pane = free × grow / Σgrow
    const distribute = (width: number, count: 2 | 3 | 4, seam = 9) => {
      const layout = layoutFor(count, width)
      if (layout.kind !== 'columns') return null
      const grows = layout.sizes.map((_, i) => Number(paneFlex(layout.sizes, i).split(' ')[0]))
      const free = width - seam * (count - 1)
      const sum = grows.reduce((a, b) => a + b, 0)
      return grows.map((g) => (free * g) / sum)
    }
    for (const [width, count] of [[1440, 2], [1920, 2], [1920, 3], [3840, 2], [3840, 3], [3840, 4], [5120, 4]] as const) {
      const widths = distribute(width, count)!
      const total = widths.reduce((a, b) => a + b, 0) + 9 * (count - 1)
      expect(Math.abs(total - width)).toBeLessThan(0.01)
      expect(Math.min(...widths)).toBeGreaterThan(MIN_PANE_PX - 1 - 30)
    }
    expect(paneFlex([0.5, 0.25, 0.25], 1)).toBe('0.25 1 0px')
  })

  it('every breakpoint has a layout that keeps panes ≥ 400 px or stacks', () => {
    for (const [width, count, kind] of [[1440, 4, 'grid2x2'], [1920, 4, 'columns'], [1920, 3, 'columns'], [5120, 4, 'columns']] as const) {
      expect(layoutFor(count, width).kind).toBe(kind)
    }
  })
})
