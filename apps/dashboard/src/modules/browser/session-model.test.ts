import { describe, expect, it } from 'vitest'
import * as M from './session-model'

const T0 = 1_700_000_000_000
const prop = (id: string, label = id): M.ResearchSubject => ({ kind: 'property', id, label })
const guardAll = (u: string) => (u.startsWith('http') ? u : null)

function seeded() {
  let s = M.createSession('bsess01', T0, prop('p1', '3635 Emerson Ave N'))
  let h: M.Histories = { [s.tabs[0].id]: { stack: [null], index: 0 } }
  return { get s() { return s }, get h() { return h }, set(next: { s: M.BrowserSession; h: M.Histories }) { s = next.s; h = next.h } }
}

describe('browser session — tabs and per-tab history', () => {
  it('starts with one start tab carrying the subject', () => {
    const s = M.createSession('bsess01', T0, prop('p1'))
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].url).toBeNull()
    expect(s.tabs[0].context?.id).toBe('p1')
    expect(M.activeTab(s).id).toBe(s.activeId)
  })

  it('opens a tab next to the active one and activates it', () => {
    const x = seeded()
    const first = x.s.activeId
    const r = M.openTab(x.s, x.h, { url: 'https://a.gov/x', title: 'A' }, T0 + 1)
    expect(r.s.tabs.map((t) => t.id)).toEqual([first, r.tab.id])
    expect(r.s.activeId).toBe(r.tab.id)
    expect(r.h[r.tab.id]).toEqual({ stack: ['https://a.gov/x'], index: 0 })
  })

  it('keeps an independent back/forward stack per tab', () => {
    const x = seeded()
    const a = x.s.activeId
    x.set(M.navigate(x.s, x.h, a, { url: 'https://one.gov' }, T0 + 1))
    x.set(M.navigate(x.s, x.h, a, { url: 'https://two.gov' }, T0 + 2))
    const o = M.openTab(x.s, x.h, { url: 'https://other.com' }, T0 + 3)
    x.set(o)
    expect(M.canBack(x.h, o.tab)).toBe(false)
    const tabA = x.s.tabs.find((t) => t.id === a)!
    expect(M.canBack(x.h, tabA)).toBe(true)
    const back = M.step(x.s, x.h, a, -1, T0 + 4)
    expect(back.url).toBe('https://one.gov')
    x.set(back)
    expect(M.canForward(x.h, x.s.tabs.find((t) => t.id === a)!)).toBe(true)
    // navigating after going back drops the forward entries
    x.set(M.navigate(x.s, x.h, a, { url: 'https://three.gov' }, T0 + 5))
    expect(M.canForward(x.h, x.s.tabs.find((t) => t.id === a)!)).toBe(false)
    expect(x.h[a].stack).toEqual([null, 'https://one.gov', 'https://three.gov'])
    // the other tab's history is untouched
    expect(x.h[o.tab.id].stack).toEqual(['https://other.com'])
  })

  it('a step past either end does nothing', () => {
    const x = seeded()
    const r = M.step(x.s, x.h, x.s.activeId, -1, T0)
    expect(r.moved).toBe(false)
    expect(r.s).toBe(x.s)
  })

  it('closing the last tab leaves a start tab; closing the active one picks the most recent', () => {
    const x = seeded()
    const a = x.s.activeId
    const b = M.openTab(x.s, x.h, { url: 'https://b.com' }, T0 + 10); x.set(b)
    const c = M.openTab(x.s, x.h, { url: 'https://c.com' }, T0 + 20); x.set(c)
    x.set({ s: M.activate(x.s, b.tab.id, T0 + 30), h: x.h })
    x.set({ s: M.activate(x.s, c.tab.id, T0 + 40), h: x.h })
    x.set(M.closeTab(x.s, x.h, c.tab.id, T0 + 50))
    expect(x.s.activeId).toBe(b.tab.id)
    x.set(M.closeTab(x.s, x.h, b.tab.id, T0 + 60))
    x.set(M.closeTab(x.s, x.h, a, T0 + 70))
    expect(x.s.tabs).toHaveLength(1)
    expect(x.s.tabs[0].url).toBeNull()
    expect(x.s.tabs[0].context?.id).toBe('p1')
  })

  it('is bounded: at the cap the least recently used inactive tab yields, never the active one', () => {
    const x = seeded()
    for (let i = 0; i < M.MAX_TABS + 3; i++) x.set(M.openTab(x.s, x.h, { url: `https://s${i}.com` }, T0 + i + 1))
    expect(x.s.tabs.length).toBe(M.MAX_TABS)
    expect(x.s.tabs.some((t) => t.id === x.s.activeId)).toBe(true)
    expect(Object.keys(x.h).length).toBe(M.MAX_TABS)
  })

  it('reorders without losing tabs', () => {
    const x = seeded()
    const b = M.openTab(x.s, x.h, { url: 'https://b.com' }, T0 + 1); x.set(b)
    const c = M.openTab(x.s, x.h, { url: 'https://c.com' }, T0 + 2); x.set(c)
    const r = M.reorder(x.s, c.tab.id, 0)
    expect(r.tabs[0].id).toBe(c.tab.id)
    expect(r.tabs).toHaveLength(3)
  })
})

describe('browser session — linked vs pinned', () => {
  it('linked: a different selection is OFFERED and no tab changes', () => {
    const x = seeded()
    x.set(M.openTab(x.s, x.h, { url: 'https://assessor.gov/p1' }, T0 + 1))
    const before = x.s.tabs
    const next = M.selectionChanged(x.s, prop('p2', '1 Other St'))
    expect(next.offered?.id).toBe('p2')
    expect(next.subject?.id).toBe('p1')
    expect(next.tabs).toBe(before)
  })

  it('pinned: the selection is ignored entirely', () => {
    const x = seeded()
    const pinned = M.setLink(x.s, 'pinned')
    expect(M.selectionChanged(pinned, prop('p2'))).toBe(pinned)
  })

  it('the same subject clears a stale offer; no subject yet simply adopts', () => {
    const x = seeded()
    const offered = M.selectionChanged(x.s, prop('p2'))
    expect(M.selectionChanged(offered, prop('p1')).offered).toBeNull()
    const blank = M.createSession('bsess02', T0, null)
    expect(M.selectionChanged(blank, prop('p9')).subject?.id).toBe('p9')
  })

  it('accepting moves the subject but existing tabs keep their own context (a comp tab keeps the subject tabs)', () => {
    const x = seeded()
    x.set(M.openTab(x.s, x.h, { url: 'https://assessor.gov/p1', context: prop('p1') }, T0 + 1))
    x.set(M.openTab(x.s, x.h, { url: 'https://zillow.com/comp', context: { kind: 'property', id: 'c7', label: 'Comp', role: 'comp' } }, T0 + 2))
    const adopted = M.adoptSubject(M.selectionChanged(x.s, prop('p2')), prop('p2'))
    expect(adopted.subject?.id).toBe('p2')
    expect(adopted.offered).toBeNull()
    expect(adopted.tabs.map((t) => t.context?.id)).toEqual(['p1', 'p1', 'c7'])
    expect(M.contextGroups(adopted).map((g) => g.key)).toEqual(['property:p1', 'property:c7'])
  })

  it('pinning clears a pending offer', () => {
    const x = seeded()
    const offered = M.selectionChanged(x.s, prop('p2'))
    expect(M.setLink(offered, 'pinned').offered).toBeNull()
  })
})

describe('browser session — restore', () => {
  it('round-trips tabs without history or offers', () => {
    const x = seeded()
    x.set(M.openTab(x.s, x.h, { url: 'https://a.gov/x', title: 'A', destinationType: 'ASSESSOR', embed: 'EMBEDS' }, T0 + 1))
    const stored = JSON.parse(JSON.stringify(M.serializeSession(M.selectionChanged(x.s, prop('p2')))))
    expect(stored.offered).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain('stack')
    const back = M.reviveSession(stored, guardAll, T0 + 9)!
    expect(back.tabs.map((t) => [t.url, t.title, t.destinationType, t.embed])).toEqual([[null, null, null, null], ['https://a.gov/x', 'A', 'ASSESSOR', 'EMBEDS']])
    expect(back.activeId).toBe(x.s.activeId)
    expect(back.subject?.id).toBe('p1')
  })

  it('re-guards every stored URL: an unsafe one comes back as a start tab', () => {
    const raw = { v: 1, id: 'bsess03', activeId: 't1', link: 'pinned', tabs: [{ id: 't1', url: 'javascript:alert(1)', title: 'x' }, { id: 't2', url: 'https://ok.gov' }] }
    const s = M.reviveSession(raw, guardAll, T0)!
    expect(s.tabs[0].url).toBeNull()
    expect(s.tabs[0].title).toBeNull()
    expect(s.tabs[1].url).toBe('https://ok.gov')
    expect(s.link).toBe('pinned')
  })

  it('rejects garbage', () => {
    expect(M.reviveSession(null, guardAll, T0)).toBeNull()
    expect(M.reviveSession({ v: 2 }, guardAll, T0)).toBeNull()
    expect(M.reviveSession({ v: 1, id: 'x', tabs: [] }, guardAll, T0)).toBeNull()
  })

  it('remembers run intents, bounded', () => {
    let s = M.createSession('bsess04', T0)
    for (let i = 0; i < 40; i++) s = M.markHandled(s, `n${i}`)
    expect(s.handled.length).toBe(30)
    expect(M.markHandled(s, 'n39')).toBe(s)
  })

  it('names tabs by title, else host, else what they research', () => {
    const base = M.startTab(T0, prop('p1', '3635 Emerson Ave N'))
    expect(M.tabTitle(base)).toBe('Research · 3635 Emerson Ave N')
    expect(M.tabTitle({ ...base, url: 'https://www.hennepin.us/x' })).toBe('hennepin.us')
    expect(M.tabTitle({ ...base, url: 'https://x.gov', title: 'Assessor' })).toBe('Assessor')
  })
})
