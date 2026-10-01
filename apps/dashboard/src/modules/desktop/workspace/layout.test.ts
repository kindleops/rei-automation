import { describe, expect, it } from 'vitest'
import {
  activate, closeInstance, closePane, dropTargetAt, findPane, maxVisiblePanes, maximize, miniature, normalize,
  panes, place, preferredShare, resetSizes, reviveLayout, setSizes, singleLayout, type Instance, type Layout, type SplitNode,
} from './layout'

const inst = (app: string, path = `/${app}`): Instance => ({ id: `i-${app}`, app, path, pinned: false })

function journey(): { l: Layout; inbox: Instance; deal: Instance; map: Instance; comps: Instance } {
  const inbox = inst('inbox')
  const deal = inst('deal-intelligence')
  const map = inst('map')
  const comps = inst('comp-intelligence')
  let l = singleLayout(inbox)
  const inboxPane = l.focus
  l = place(l, deal, { pane: inboxPane, zone: 'right' }).layout
  const dealPane = panes(l.root).find((p) => p.tabs.includes(deal.id))!.id
  l = place(l, map, { pane: dealPane, zone: 'bottom' }).layout
  return { l, inbox, deal, map, comps }
}

describe('workspace layout', () => {
  it('splits right with the pair’s preferred ratio and focuses the new pane', () => {
    const inbox = inst('inbox')
    const deal = inst('deal-intelligence')
    const start = singleLayout(inbox)
    const { layout, pane } = place(start, deal, { pane: start.focus, zone: 'right' })
    const root = layout.root as SplitNode
    expect(root.kind).toBe('split')
    expect(root.dir).toBe('row')
    expect(root.sizes[1]).toBeCloseTo(preferredShare('inbox', 'deal-intelligence'))
    expect(layout.focus).toBe(pane)
    expect(layout.primary).toBe(inbox.id)
  })

  it('builds inbox | (deal / map) as a tree, not a flat row', () => {
    const { l } = journey()
    const root = l.root as SplitNode
    expect(root.dir).toBe('row')
    expect(root.children[1].kind).toBe('split')
    expect((root.children[1] as SplitNode).dir).toBe('col')
    expect(panes(l.root)).toHaveLength(3)
  })

  it('stacks into a pane without destroying what was there, and switches tabs', () => {
    const { l, deal, comps } = journey()
    const dealPane = panes(l.root).find((p) => p.tabs.includes(deal.id))!.id
    const stacked = place(l, comps, { pane: dealPane, zone: 'stack' }).layout
    const p = findPane(stacked.root, dealPane)!
    expect(p.tabs).toEqual([deal.id, comps.id])
    expect(p.active).toBe(comps.id)
    expect(activate(stacked, dealPane, deal.id).root).toBeTruthy()
    expect(findPane(activate(stacked, dealPane, deal.id).root, dealPane)!.active).toBe(deal.id)
  })

  it('drags a tab out of a stack into its own pane and back again', () => {
    const { l, deal, comps } = journey()
    const dealPane = panes(l.root).find((p) => p.tabs.includes(deal.id))!.id
    const stacked = place(l, comps, { pane: dealPane, zone: 'stack' }).layout
    const out = place(stacked, comps, { pane: dealPane, zone: 'right' }).layout
    expect(panes(out.root)).toHaveLength(4)
    expect(findPane(out.root, dealPane)!.tabs).toEqual([deal.id])
    const back = place(out, comps, { pane: dealPane, zone: 'stack' }).layout
    expect(panes(back.root)).toHaveLength(3)
    expect(findPane(back.root, dealPane)!.tabs).toEqual([deal.id, comps.id])
  })

  it('closing a pane simplifies the tree and leaves no empty split', () => {
    const { l, map, deal } = journey()
    const closed = closeInstance(l, map.id)
    expect(panes(closed.root)).toHaveLength(2)
    const root = closed.root as SplitNode
    expect(root.children.every((c) => c.kind === 'pane')).toBe(true)
    expect(closed.instances[map.id]).toBeUndefined()
    // focus goes to the neighbour that absorbed the space
    expect(findPane(closed.root, closed.focus)!.tabs).toContain(deal.id)
  })

  it('never closes the last application', () => {
    const only = singleLayout(inst('inbox'))
    expect(closeInstance(only, 'i-inbox')).toBe(only)
    expect(closePane(only, only.focus)).toBe(only)
  })

  it('hands the URL to another instance when the primary closes', () => {
    const { l, inbox } = journey()
    const closed = closeInstance(l, inbox.id)
    expect(closed.primary).not.toBe(inbox.id)
    expect(closed.instances[closed.primary]).toBeTruthy()
  })

  it('replace swaps the active app and drops the old instance', () => {
    const { l, map } = journey()
    const mapPane = panes(l.root).find((p) => p.tabs.includes(map.id))!.id
    const eg = inst('entity-graph')
    const next = place(l, eg, { pane: mapPane, zone: 'replace' }).layout
    expect(findPane(next.root, mapPane)!.tabs).toEqual([eg.id])
    expect(next.instances[map.id]).toBeUndefined()
  })

  it('moving the only tab of a pane onto itself changes nothing', () => {
    const { l, map } = journey()
    const mapPane = panes(l.root).find((p) => p.tabs.includes(map.id))!.id
    const same = place(l, map, { pane: mapPane, zone: 'left' }).layout
    expect(panes(same.root)).toHaveLength(3)
  })

  it('maximize and restore keep the exact geometry', () => {
    const { l } = journey()
    const sized = setSizes(l, (l.root as SplitNode).id, [0.3, 0.7])
    const target = panes(sized.root)[2].id
    const max = maximize(sized, target)
    expect(max.maximized).toBe(target)
    const back = maximize(max, null)
    expect((back.root as SplitNode).sizes).toEqual((sized.root as SplitNode).sizes)
  })

  it('double-click reset returns a pair to its preferred ratio', () => {
    const inbox = inst('inbox')
    const deal = inst('deal-intelligence')
    const start = singleLayout(inbox)
    let l = place(start, deal, { pane: start.focus, zone: 'right' }).layout
    const id = (l.root as SplitNode).id
    l = setSizes(l, id, [0.8, 0.2])
    l = resetSizes(l, id)
    expect((l.root as SplitNode).sizes[1]).toBeCloseTo(0.6)
  })

  it('normalize flattens same-direction nesting and drops empties', () => {
    const n = normalize({
      kind: 'split', id: 'a', dir: 'row', sizes: [0.5, 0.5], children: [
        { kind: 'pane', id: 'p1', tabs: ['x'], active: 'x' },
        { kind: 'split', id: 'b', dir: 'row', sizes: [0.5, 0.5], children: [
          { kind: 'pane', id: 'p2', tabs: ['y'], active: 'y' },
          { kind: 'pane', id: 'p3', tabs: [], active: '' },
        ] },
      ],
    }) as SplitNode
    expect(n.children.map((c) => c.id)).toEqual(['p1', 'p2'])
    expect(n.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
})

describe('drop targets', () => {
  const rect = { x: 0, y: 0, w: 1200, h: 800 }
  const ctx = { paneId: 'p', targetApp: 'inbox', newApp: 'map', visiblePanes: 1, maxPanes: 4 }
  it('the centre stacks and the edges split', () => {
    expect(dropTargetAt(rect, { x: 600, y: 400 }, ctx).zone).toBe('stack')
    expect(dropTargetAt(rect, { x: 1150, y: 400 }, ctx).zone).toBe('right')
    expect(dropTargetAt(rect, { x: 600, y: 760 }, ctx).zone).toBe('bottom')
  })
  it('previews the exact resulting geometry', () => {
    const t = dropTargetAt(rect, { x: 1150, y: 400 }, ctx)
    expect(t.preview.w).toBeCloseTo(1200 * preferredShare('inbox', 'map'))
    expect(t.preview.x + t.preview.w).toBeCloseTo(1200)
  })
  it('refuses a split that would crush either app — and says why', () => {
    const narrow = dropTargetAt({ x: 0, y: 0, w: 700, h: 800 }, { x: 680, y: 400 }, ctx)
    expect(narrow.zone).toBe('stack')
    expect(narrow.blocked).toMatch(/room/)
    const full = dropTargetAt(rect, { x: 1150, y: 400 }, { ...ctx, visiblePanes: 4 })
    expect(full.blocked).toMatch(/full/)
  })
  it('the visible-pane budget follows the screen', () => {
    expect(maxVisiblePanes({ w: 1100, h: 760 })).toBe(2)
    expect(maxVisiblePanes({ w: 1650, h: 1000 })).toBe(4)
    expect(maxVisiblePanes({ w: 4900, h: 1300 })).toBe(6)
  })
})

describe('persistence', () => {
  it('revives a stored layout and drops unknown apps and duplicate apps', () => {
    const { l } = journey()
    const raw = JSON.parse(JSON.stringify({ ...l, instances: { ...l.instances, ghost: { id: 'ghost', app: 'nope', path: '/nope', pinned: false } } }))
    const revived = reviveLayout(raw, (a) => a !== 'nope')!
    expect(Object.keys(revived.instances)).toHaveLength(3)
    expect(panes(revived.root)).toHaveLength(3)
  })
  it('returns null for garbage', () => {
    expect(reviveLayout(null, () => true)).toBeNull()
    expect(reviveLayout({ root: null }, () => true)).toBeNull()
  })
  it('draws an abstract miniature that tiles the unit square', () => {
    const { l } = journey()
    const rects = miniature(l.root)
    const area = rects.reduce((a, r) => a + r.w * r.h, 0)
    expect(area).toBeCloseTo(1)
  })
})

describe('splits that fit', () => {
  it('moves the preferred ratio just enough for both apps to stay usable', () => {
    // inbox (min 460) + deal intelligence (min 500) in a 1010px pane: 40/60 would crush inbox
    const t = dropTargetAt({ x: 0, y: 0, w: 1010, h: 800 }, { x: 1000, y: 400 }, { paneId: 'p', targetApp: 'inbox', newApp: 'deal-intelligence', visiblePanes: 1, maxPanes: 2 })
    expect(t.blocked).toBeNull()
    expect(1010 * (1 - t.share)).toBeGreaterThanOrEqual(459.99)
    expect(1010 * t.share).toBeGreaterThanOrEqual(499.99)
  })
  it('the drop lands exactly where the preview said', () => {
    const inbox: Instance = { id: 'a', app: 'inbox', path: '/inbox', pinned: false }
    const deal: Instance = { id: 'b', app: 'deal-intelligence', path: '/deal-intelligence', pinned: false }
    const start = singleLayout(inbox)
    const next = place(start, deal, { pane: start.focus, zone: 'right', share: 0.52 }).layout
    expect((next.root as SplitNode).sizes[1]).toBeCloseTo(0.52)
  })
})
