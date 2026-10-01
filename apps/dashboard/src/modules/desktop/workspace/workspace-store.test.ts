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
  const L = await import('./layout')
  store.__workspaceTest.reset()
  const stop = store.startWorkspace()
  return { w, store, router, locator, L, stop }
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
    const { store, locator, L, stop } = await load('/inbox')
    store.openApp('/buyer-match', 'beside')
    let ws = store.getWorkspace().layout
    const inboxPane = L.panes(ws.root).find((p) => ws.instances[p.active].app === 'inbox')!
    store.markPaneInteraction(inboxPane.id)
    locator.setPropertyLocator({ propertyId: 'P1', address: '1 Main St' })
    ws = store.getWorkspace().layout
    const bm = Object.values(ws.instances).find((i) => i.app === 'buyer-match')!
    expect(bm.path).toContain('property_id=P1')
    store.setPinned(bm.id, true)
    store.markPaneInteraction(inboxPane.id)
    locator.setPropertyLocator({ propertyId: 'P2', address: '2 Main St' })
    ws = store.getWorkspace().layout
    expect(ws.instances[bm.id].path).toContain('property_id=P1')
    stop()
  })

  it('an independent workspace does not follow at all', async () => {
    const { store, locator, stop } = await load('/inbox')
    store.openApp('/buyer-match', 'beside')
    store.setLinked(false)
    locator.setPropertyLocator({ propertyId: 'P9', address: '9 Main St' })
    const ws = store.getWorkspace().layout
    expect(Object.values(ws.instances).find((i) => i.app === 'buyer-match')!.path).toBe('/buyer-match')
    stop()
  })

  it('a reload restores the arrangement; a different explicit address opens alone', async () => {
    const first = await load('/inbox')
    first.store.openApp('/map', 'beside')
    await new Promise((r) => setTimeout(r, 260)) // persistence is debounced
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
