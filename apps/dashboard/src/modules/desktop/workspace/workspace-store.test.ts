import { beforeEach, describe, expect, it, vi } from 'vitest'

/* A small window: location + history + storage + events, enough for the store. */
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
  const router = await import('../../../app/router')
  const locator = await import('../../../domain/locator/property-locator')
  const bus = await import('../../../domain/locator/linked-property-bus')
  const L = await import('./layout')
  store.__workspaceTest.reset()
  const stop = store.startWorkspace()
  // linked follow is debounced (latest click wins); tests settle it explicitly
  const select = (loc: Parameters<typeof locator.setPropertyLocator>[0]) => { locator.setPropertyLocator(loc); bus.__linkedTest.flush() }
  return { w, store, router, locator, bus, select, L, stop }
}

describe('workspace store', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('boots with the address bar as the one primary instance', async () => {
    const { store, L, stop } = await load('/inbox')
    const ws = store.getWorkspace().layout
    expect(L.panes(ws.root)).toHaveLength(1)
    expect(ws.instances[ws.primary].app).toBe('inbox')
    stop()
  })

  it('a navigation inside a side pane stays in that pane; the URL keeps the primary', async () => {
    const { store, router, L, w, stop } = await load('/inbox')
    store.openApp('/map', 'beside')
    const ws = store.getWorkspace().layout
    const mapPane = L.panes(ws.root).find((p) => ws.instances[p.active].app === 'map')!
    store.markPaneInteraction(mapPane.id)
    router.pushRoutePath('/pipeline')
    const after = store.getWorkspace().layout
    expect(after.instances[L.findPane(after.root, mapPane.id)!.active].app).toBe('pipeline')
    expect(w.location.pathname).toBe('/inbox')
    stop()
  })

  it('navigating to an app that is already open shows where it is — no duplicate', async () => {
    const { store, router, L, stop } = await load('/inbox')
    store.openApp('/map', 'beside')
    const before = store.getWorkspace().layout
    const inboxPane = L.panes(before.root).find((p) => before.instances[p.active].app === 'inbox')!
    store.focusPane(inboxPane.id)
    router.pushRoutePath('/map')
    const after = store.getWorkspace().layout
    expect(Object.values(after.instances).filter((i) => i.app === 'map')).toHaveLength(1)
    expect(after.instances[L.findPane(after.root, after.focus)!.active].app).toBe('map')
    stop()
  })

  it('the primary pane navigating changes the URL, not the layout', async () => {
    const { store, router, w, stop } = await load('/inbox')
    router.pushRoutePath('/queue')
    const ws = store.getWorkspace().layout
    expect(w.location.pathname).toBe('/queue')
    expect(ws.instances[ws.primary].app).toBe('queue')
    stop()
  })

  it('closing the primary hands the address bar to a remaining pane', async () => {
    const { store, w, stop } = await load('/inbox')
    store.openApp('/map', 'beside')
    const ws = store.getWorkspace().layout
    store.closeApp(ws.primary, { immediate: true })
    expect(w.location.pathname).toBe('/map')
    stop()
  })

  it('linked panes follow a selection; a pinned pane keeps its subject', async () => {
    const { store, select, L, stop } = await load('/inbox')
    store.openApp('/buyer-match', 'beside')
    let ws = store.getWorkspace().layout
    const inboxPane = L.panes(ws.root).find((p) => ws.instances[p.active].app === 'inbox')!
    store.markPaneInteraction(inboxPane.id)
    select({ propertyId: 'P1', address: '1 Main St' })
    ws = store.getWorkspace().layout
    const bm = Object.values(ws.instances).find((i) => i.app === 'buyer-match')!
    expect(bm.path).toContain('property_id=P1')
    store.setPinned(bm.id, true)
    store.markPaneInteraction(inboxPane.id)
    select({ propertyId: 'P2', address: '2 Main St' })
    ws = store.getWorkspace().layout
    expect(ws.instances[bm.id].path).toContain('property_id=P1')
    stop()
  })

  it('an independent workspace does not follow at all', async () => {
    const { store, select, stop } = await load('/inbox')
    store.openApp('/buyer-match', 'beside')
    store.setLinked(false)
    select({ propertyId: 'P9', address: '9 Main St' })
    const ws = store.getWorkspace().layout
    expect(Object.values(ws.instances).find((i) => i.app === 'buyer-match')!.path).toBe('/buyer-match')
    stop()
  })

  it('linked follow: rapid clicks resolve only the latest, once', async () => {
    const { store, locator, bus, L, stop } = await load('/inbox')
    store.openApp('/buyer-match', 'beside')
    const ws0 = store.getWorkspace().layout
    const inboxPane = L.panes(ws0.root).find((p) => ws0.instances[p.active].app === 'inbox')!
    store.markPaneInteraction(inboxPane.id)
    const bmPath = () => Object.values(store.getWorkspace().layout.instances).find((i) => i.app === 'buyer-match')!.path
    locator.setPropertyLocator({ propertyId: 'A' })
    locator.setPropertyLocator({ propertyId: 'B' })
    locator.setPropertyLocator({ propertyId: 'C' })
    expect(bmPath()).toBe('/buyer-match') // nothing fanned out mid-burst
    bus.__linkedTest.flush()
    expect(bmPath()).toContain('property_id=C')
    expect(bus.__linkedTest.last()?.locator.propertyId).toBe('C')
    stop()
  })

  it('linked follow never launches a closed app and never retargets the pane the selection came from', async () => {
    const { store, select, L, stop } = await load('/inbox')
    select({ propertyId: 'P1' })
    expect(Object.keys(store.getWorkspace().layout.instances)).toHaveLength(1)
    store.openApp('/buyer-match', 'beside')
    const ws = store.getWorkspace().layout
    const bmPane = L.panes(ws.root).find((p) => ws.instances[p.active].app === 'buyer-match')!
    const focusBefore = ws.focus
    store.markPaneInteraction(bmPane.id) // the operator is acting IN Buyer Match
    select({ propertyId: 'P2' })
    const after = store.getWorkspace().layout
    expect(after.instances[bmPane.active].path).toBe('/buyer-match')
    expect(after.focus).toBe(focusBefore)
    expect(Object.keys(after.instances)).toHaveLength(2)
    stop()
  })

  it('a reload restores the arrangement; a different explicit address opens alone', async () => {
    const first = await load('/inbox')
    first.store.openApp('/map', 'beside')
    first.store.__workspaceTest.flush() // persistence is debounced; flush it
    const saved = first.w.sessionStorage.getItem('lc.workspace.session.v1')
    first.stop()
    expect(saved).toBeTruthy()

    const again = await load('/inbox')
    again.w.sessionStorage.setItem('lc.workspace.session.v1', saved!)
    again.store.__workspaceTest.reset()
    expect(again.L.panes(again.store.getWorkspace().layout.root)).toHaveLength(2)
    again.stop()

    const deep = await load('/closing-desk')
    deep.w.sessionStorage.setItem('lc.workspace.session.v1', saved!)
    deep.store.__workspaceTest.reset()
    expect(deep.L.panes(deep.store.getWorkspace().layout.root)).toHaveLength(1)
    deep.stop()
  })
})

describe('workspace store · replace safety', () => {
  it('a late replace for an app no pane shows never hijacks a pane or the address bar', async () => {
    const { store, router, w, stop } = await load('/inbox')
    store.openApp('/map', 'beside')
    const before = JSON.stringify(Object.values(store.getWorkspace().layout.instances).map((i) => [i.app, i.path]))
    router.replaceRoutePath('/deal-intelligence?property_id=P9')
    expect(JSON.stringify(Object.values(store.getWorkspace().layout.instances).map((i) => [i.app, i.path]))).toBe(before)
    expect(w.location.pathname).toBe('/inbox')
    stop()
  })
})
