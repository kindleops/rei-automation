/**
 * 8.2 — NO DEAD LINKS for a comp-only property (sold, never entered `properties`).
 * The comps workspace marks each comp canonicalProperty true/false from one
 * batched existence read; a false one opens nothing that would 404.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'

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
  const w = installWindow('/comp-intelligence?property_id=273312064')
  const fetchSpy = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchSpy)
  const store = await import('../workspace/workspace-store')
  const actions = await import('./object-actions')
  const reg = await import('./object-registry')
  const inspector = await import('../inspector/inspector-store')
  const { compObject } = await import('../../../views/comp-intelligence/desktop/comp-object')
  store.__workspaceTest.reset()
  inspector.__inspectorTest.reset()
  const stop = store.startWorkspace()
  const paths = () => [w.location.pathname + w.location.search, ...Object.values(store.getWorkspace().layout.instances).map((i) => i.path)]
  return { w, store, actions, reg, inspector, compObject, stop, paths }
}

const comp = (over: Partial<EvidenceComp>): EvidenceComp => ({
  key: 'p:x', corpus: 'engine_pool', compId: 'x', propertyId: '273330226', address: '3722 Fremont Ave N, Minneapolis, MN 55412',
  city: 'Minneapolis', zip: '55412', lat: 45.022873, lng: -93.29537, ...over,
} as EvidenceComp)

describe('a comp-only property (canonicalProperty: false)', { timeout: 20_000 }, () => {
  it('has no Open / Open beside / mission, says why, and keeps Inspect + Show on Map', async () => {
    const env = await load()
    const ref = env.compObject(comp({ canonicalProperty: false }))!
    const cap = env.reg.objectCapabilities(ref)
    expect(cap.open).toBeNull()
    expect(cap.beside).toBeNull()
    expect(cap.missions).toEqual([])
    expect(cap.missionSubject).toBeNull()
    expect(cap.notOpenable).toBe('Recorded sale · not a tracked property')
    expect(cap.inspectable).toBe(true)
    expect(cap.map.propertyId).toBe('273330226')
    const acts = env.actions.objectActions(ref)
    expect(acts.map((a) => a.id)).toEqual(['beside', 'inspect', 'map'])
    expect(acts[0]).toMatchObject({ disabled: true, reason: 'Recorded sale · not a tracked property' })
    // the Comps row menu (which omits 'open' because its click is local) still says why
    expect(env.actions.objectActions(ref, { omit: ['open'] }).find((a) => a.id === 'beside')?.reason).toBe('Recorded sale · not a tracked property')
    env.stop()
    vi.unstubAllGlobals()
  })

  it('never produces a Deal Intelligence deep link — from the menu, Open, Open beside, ⌘-click or a plain click', async () => {
    const env = await load()
    env.store.openApp('/map', 'beside')
    const ref = env.compObject(comp({ canonicalProperty: false }))!
    for (const a of env.actions.objectActions(ref)) a.run()
    expect(env.actions.openObject(ref)).toMatchObject({ ok: false, reason: 'Recorded sale · not a tracked property' })
    expect(env.actions.openObjectBeside(ref)).toMatchObject({ ok: false, reason: 'Recorded sale · not a tracked property' })
    env.actions.handleObjectClick({ metaKey: true }, ref)
    // plain click with no surface action falls to Inspect (the sale record)
    expect(env.actions.handleObjectClick(null, ref)).toBe('inspect')
    expect(env.inspector.readInspectorState().current?.id).toBe('273330226')
    expect(env.paths().some((p) => p.includes('/deal-intelligence'))).toBe(false)
    env.stop()
    vi.unstubAllGlobals()
  })

  it('a surface with its own click keeps it (Comps opens the comp in place)', async () => {
    const env = await load()
    const onActivate = vi.fn()
    expect(env.actions.handleObjectClick(null, env.compObject(comp({ canonicalProperty: false }))!, onActivate)).toBe('activate')
    expect(onActivate).toHaveBeenCalledTimes(1)
    env.stop()
    vi.unstubAllGlobals()
  })
})

describe('a canonical comp still opens Deal Intelligence', { timeout: 20_000 }, () => {
  it.each([[true], [null], [undefined]])('canonicalProperty %s', async (canonical) => {
    const env = await load()
    const ref = env.compObject(comp({ canonicalProperty: canonical }))!
    const cap = env.reg.objectCapabilities(ref)
    expect(cap.open).toBe('/deal-intelligence?property_id=273330226')
    expect(cap.notOpenable).toBeNull()
    expect(cap.missions.length).toBeGreaterThan(0)
    env.actions.handleObjectClick(null, ref)
    expect(env.paths().some((p) => p.startsWith('/deal-intelligence?property_id=273330226'))).toBe(true)
    env.stop()
    vi.unstubAllGlobals()
  })
})
