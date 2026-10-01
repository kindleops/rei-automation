import { describe, expect, it, vi } from 'vitest'
import { missionsFor, planMission } from './missions'

/* Missions are pure planning: kind + subject → contextual panes. */

describe('mission planning', () => {
  it('offers only the missions the subject can carry', () => {
    expect(missionsFor({ label: 'x', threadKey: 't1' }).map((m) => m.kind)).toEqual(['work_seller'])
    expect(missionsFor({ label: 'x', propertyId: 'p1', opportunityId: 'o1' }).map((m) => m.kind)).toEqual(['work_seller', 'move_deal'])
    expect(missionsFor({ label: 'Probate MN', campaignId: 'c1' }).map((m) => m.kind)).toEqual(['run_campaign'])
    expect(missionsFor({ label: '3025 Sunbeam', closingId: 'k1' }).map((m) => m.kind)).toEqual(['close_deal'])
    expect(planMission('run_campaign', { label: 'no id' })).toBeNull()
  })

  it('work seller: Inbox anchors, Deal Intelligence + Comps stack beside, Map below — all on the property', () => {
    const plan = planMission('work_seller', { label: '3025 Sunbeam Ave', propertyId: 'P1', threadKey: 'T1', address: '3025 Sunbeam Ave' })!
    expect(plan.panes.map((p) => p.path.split('?')[0])).toEqual(['/inbox', '/deal-intelligence', '/comp-intelligence', '/map'])
    expect(plan.panes[0].at).toBeNull()
    expect(plan.panes[2].at).toEqual({ of: 1, zone: 'stack' })
    expect(plan.panes[2].path).toContain('property_id=P1')
    expect(plan.locator).toMatchObject({ propertyId: 'P1', threadKey: 'T1', address: '3025 Sunbeam Ave' })
  })

  it('run campaign aims Campaign Command at the campaign and never invents context for apps that cannot read it', () => {
    const plan = planMission('run_campaign', { label: 'Probate MN', campaignId: 'c 1' })!
    expect(plan.panes[0].path).toBe('/campaign-command?campaign=c%201')
    expect(plan.panes.slice(1).map((p) => p.path)).toEqual(['/queue', '/analytics', '/workflow-studio'])
    expect(plan.locator).toBeNull()
  })

  it('close deal opens the closing case by id', () => {
    const plan = planMission('close_deal', { label: '3025 Sunbeam', closingId: 'K9' })!
    expect(plan.panes.map((p) => p.path)).toEqual(['/closing-desk?case=K9', '/email-command', '/calendar'])
  })
})

/* The store side: compose, then restore exactly. */

function installWindow(path: string) {
  const [pathname, search = ''] = path.split('?')
  const loc = { pathname, search: search ? `?${search}` : '' }
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() } }
  const go = (url: string) => { const u = new URL(url, 'http://x'); loc.pathname = u.pathname; loc.search = u.search }
  const w = {
    location: loc,
    history: { state: null as unknown, replaceState: (_s: unknown, _t: string, url: string) => go(url), pushState: (_s: unknown, _t: string, url: string) => go(url) },
    sessionStorage: mem(), localStorage: mem(),
    innerWidth: 1600, innerHeight: 1000, screen: { width: 1600, height: 1000 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, fn: (e: Event) => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn) },
    removeEventListener: (type: string, fn: (e: Event) => void) => { handlers.get(type)?.delete(fn) },
    dispatchEvent: (e: Event) => { handlers.get(e.type)?.forEach((fn) => fn(e)); return true },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
  }
  Object.assign(globalThis, { window: w, sessionStorage: w.sessionStorage, localStorage: w.localStorage })
  class PopStateEvent { type: string; constructor(type: string) { this.type = type } }
  class CustomEvent<T> { type: string; detail: T; constructor(type: string, init?: { detail: T }) { this.type = type; this.detail = init?.detail as T } }
  Object.assign(globalThis, { PopStateEvent, CustomEvent })
  return w
}

async function load(path: string) {
  vi.resetModules()
  const w = installWindow(path)
  const store = await import('./workspace-store')
  const missions = await import('./missions')
  const locator = await import('../../../domain/locator/property-locator')
  const L = await import('./layout')
  store.__workspaceTest.reset()
  const stop = store.startWorkspace()
  return { w, store, missions, locator, L, stop }
}

describe('missions in the workspace', () => {
  it('composes around the subject, publishes it as linked context, and exits to the exact prior workspace', async () => {
    const { w, store, missions, locator, L, stop } = await load('/pipeline')
    store.openApp('/queue', 'beside')
    const before = store.getWorkspace()
    const beforeApps = Object.values(before.layout.instances).map((i) => i.app).sort()

    expect(store.startMission(missions.planMission('work_seller', { label: '3025 Sunbeam Ave', propertyId: 'P1', threadKey: 'T1' })!)).toBe(true)
    const during = store.getWorkspace()
    expect(during.mission?.kind).toBe('work_seller')
    expect(L.panes(during.layout.root)).toHaveLength(3)
    expect(Object.values(during.layout.instances).map((i) => i.app).sort()).toEqual(['comp-intelligence', 'deal-intelligence', 'inbox', 'map'])
    // the stack shows Deal Intelligence (planned first), Comps one tab away
    const stack = L.panes(during.layout.root).find((p) => p.tabs.length === 2)!
    expect(during.layout.instances[stack.active].app).toBe('deal-intelligence')
    expect(during.layout.instances[during.layout.primary].app).toBe('inbox')
    expect(w.location.pathname).toBe('/inbox')
    expect(locator.readPropertyLocator()?.propertyId).toBe('P1')

    store.exitMission()
    const after = store.getWorkspace()
    expect(after.mission).toBeNull()
    expect(Object.values(after.layout.instances).map((i) => i.app).sort()).toEqual(beforeApps)
    expect(w.location.pathname).toBe('/pipeline')
    stop()
  })

  it('a second mission still returns home to the workspace before the first', async () => {
    const { store, missions, stop } = await load('/analytics')
    store.startMission(missions.planMission('run_campaign', { label: 'Probate MN', campaignId: 'C1' })!)
    store.startMission(missions.planMission('close_deal', { label: '3025 Sunbeam', closingId: 'K1' })!)
    store.exitMission()
    const after = store.getWorkspace()
    expect(Object.values(after.layout.instances).map((i) => i.app)).toEqual(['analytics'])
    stop()
  })

  it('switching to another workspace ends the mission without restoring', async () => {
    const { store, missions, stop } = await load('/inbox')
    store.startMission(missions.planMission('run_campaign', { label: 'Probate MN', campaignId: 'C1' })!)
    store.resetWorkspace()
    expect(store.getWorkspace().mission).toBeNull()
    stop()
  })

  it('a reload keeps the mission and its way home', async () => {
    const first = await load('/pipeline')
    first.store.startMission(first.missions.planMission('close_deal', { label: '3025 Sunbeam', closingId: 'K1' })!)
    first.store.__workspaceTest.flush()
    const saved = first.w.sessionStorage.getItem('lc.workspace.session.v1')
    first.stop()

    const again = await load('/closing-desk?case=K1')
    again.w.sessionStorage.setItem('lc.workspace.session.v1', saved!)
    again.store.__workspaceTest.reset()
    expect(again.store.getWorkspace().mission?.kind).toBe('close_deal')
    again.store.exitMission()
    expect(Object.values(again.store.getWorkspace().layout.instances).map((i) => i.app)).toEqual(['pipeline'])
    again.stop()
  })
})
