/**
 * 8.2 NO DEAD LINKS — Deal Intelligence Evidence comps. The decision marks each
 * comp canonicalProperty from one batched existence read (shared helper with Comps);
 * a comp-only parcel's menu never yields a Deal Intelligence path.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DiComp } from '../../../views/deal-intelligence/desktop/di-types'

function installWindow(path: string) {
  const [pathname, search = ''] = path.split('?')
  const loc = { pathname, search: search ? `?${search}` : '' }
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() } }
  const go = (url: string) => { const u = new URL(url, 'http://x'); loc.pathname = u.pathname; loc.search = u.search }
  const w = {
    location: loc,
    history: { state: null as unknown, replaceState: (_s: unknown, _t: string, url: string) => go(url), pushState: (_s: unknown, _t: string, url: string) => go(url) },
    sessionStorage: mem(),
    localStorage: mem(),
    innerWidth: 1600, innerHeight: 1000, screen: { width: 1600, height: 1000 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, fn: (e: Event) => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn) },
    removeEventListener: (type: string, fn: (e: Event) => void) => { handlers.get(type)?.delete(fn) },
    dispatchEvent: (e: Event) => { handlers.get(e.type)?.forEach((fn) => fn(e)); return true },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    getSelection: () => null,
  }
  Object.assign(globalThis, { window: w, sessionStorage: w.sessionStorage, localStorage: w.localStorage })
  class PopStateEvent { type: string; constructor(type: string) { this.type = type } }
  class CustomEvent<T> { type: string; detail: T; constructor(type: string, init?: { detail: T }) { this.type = type; this.detail = init?.detail as T } }
  Object.assign(globalThis, { PopStateEvent, CustomEvent })
  return w
}

async function load() {
  vi.resetModules()
  const w = installWindow('/deal-intelligence?property_id=273312064')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  const store = await import('../workspace/workspace-store')
  const actions = await import('./object-actions')
  const reg = await import('./object-registry')
  const inspector = await import('../inspector/inspector-store')
  const { diCompObject } = await import('../../../views/deal-intelligence/desktop/di-comp-object')
  store.__workspaceTest.reset()
  inspector.__inspectorTest.reset()
  const stop = store.startWorkspace()
  store.openApp('/map', 'beside')
  // every path the window and the workspace panes end up on, minus where we started
  const paths = () => [w.location.pathname + w.location.search, ...Object.values(store.getWorkspace().layout.instances).map((i) => i.path)]
    .filter((p) => p !== '/deal-intelligence?property_id=273312064')
  return { actions, reg, diCompObject, stop, paths }
}

const diComp = (over: Partial<DiComp>): DiComp => ({ id: 'c1', propertyId: '273330226', address: '3722 Fremont Ave N, Minneapolis, MN 55412', lat: 45.022873, lng: -93.29537, ...over } as DiComp)

describe('Deal Intelligence Evidence comps', () => {
  it('a comp-only row: Open / Open beside / every menu action never produce a DI path', async () => {
    const env = await load()
    const ref = env.diCompObject(diComp({ canonicalProperty: false }))!
    const cap = env.reg.objectCapabilities(ref)
    expect([cap.open, cap.beside]).toEqual([null, null])
    expect(cap.notOpenable).toBe('Recorded sale · not a tracked property')
    // the Evidence grid's own menu (it omits nothing but 'open' for comps)
    const menu = env.actions.objectActions(ref, { omit: ['open'], showOnMap: { source: 'deal-intelligence' } })
    expect(menu.map((a) => a.id)).toEqual(['beside', 'inspect', 'map'])
    for (const a of menu) a.run()
    env.actions.openObject(ref)
    env.actions.openObjectBeside(ref)
    env.actions.handleObjectClick({ metaKey: true }, ref, () => {})
    expect(env.paths().some((p) => p.includes('/deal-intelligence'))).toBe(false)
    env.stop()
    vi.unstubAllGlobals()
  })

  it.each([[true], [null], [undefined]])('canonical / unknown (%s) rows are unchanged: Open beside opens DI', async (canonical) => {
    const env = await load()
    const ref = env.diCompObject(diComp({ canonicalProperty: canonical }))!
    expect(env.reg.objectCapabilities(ref).open).toBe('/deal-intelligence?property_id=273330226')
    env.actions.openObjectBeside(ref)
    expect(env.paths().some((p) => p.startsWith('/deal-intelligence?property_id=273330226'))).toBe(true)
    env.stop()
    vi.unstubAllGlobals()
  })

  it('a comp with no property id is no object at all', async () => {
    const env = await load()
    expect(env.diCompObject(diComp({ propertyId: null }))).toBeNull()
    env.stop()
    vi.unstubAllGlobals()
  })
})
