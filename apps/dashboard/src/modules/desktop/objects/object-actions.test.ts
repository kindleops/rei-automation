import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The same small window the workspace-store tests use: location + history + storage + events. */
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

async function load(path: string, start = true) {
  vi.resetModules()
  const w = installWindow(path)
  const store = await import('../workspace/workspace-store')
  const L = await import('../workspace/layout')
  const actions = await import('./object-actions')
  const reg = await import('./object-registry')
  const focus = await import('../../../domain/map/map-property-focus')
  const focusSet = await import('../../../domain/map/map-focus-set')
  const locator = await import('../../../domain/locator/property-locator')
  const inspector = await import('../inspector/inspector-store')
  const bus = await import('../../../domain/locator/linked-property-bus')
  store.__workspaceTest.reset()
  inspector.__inspectorTest.reset()
  const stop = start ? store.startWorkspace() : () => {}
  const seen: unknown[] = []
  w.addEventListener(focus.MAP_PROPERTY_FOCUS_EVENT, (e) => seen.push((e as CustomEvent).detail))
  return { w, store, L, actions, reg, focus, focusSet, locator, inspector, bus, stop, seen }
}

type Env = Awaited<ReturnType<typeof load>>
const apps = (env: Env) => Object.values(env.store.getWorkspace().layout.instances).map((i) => i.app).sort()
const inst = (env: Env, app: string) => env.L.instanceForApp(env.store.getWorkspace().layout, app)!
const paneOfApp = (env: Env, app: string) => env.L.paneOf(env.store.getWorkspace().layout, inst(env, app).id)!

/** The same property as each surface builds it (different labels, hints and sources; one canonical id). */
function refsFromEverySurface(env: Env) {
  const { propertyObject } = env.reg
  return {
    inbox: propertyObject({ propertyId: '273312064', threadKey: '+15550100001', label: '3635 Emerson Ave N', source: 'inbox' }),
    di: propertyObject({ propertyId: '273312064', threadKey: '+15550100001', opportunityId: 'opp-1', label: '3635 Emerson Ave N, Minneapolis, MN 55412', source: 'deal-intelligence' }),
    comps: propertyObject({ propertyId: '273312064', label: '3635 EMERSON AVE N', source: 'comp-intelligence', lat: 45.0193, lng: -93.2943 }),
    pipeline: propertyObject({ propertyId: '273312064', opportunityId: 'opp-1', masterOwnerId: 'mo-1', label: '3635 Emerson', source: 'pipeline' }),
    graph: propertyObject({ propertyId: '273312064', label: 'Property 273312064', source: 'entity-graph' }),
    analytics: propertyObject({ propertyId: '273312064', threadKey: '+15550100001', label: null, source: 'analytics' }),
  }
}

describe('the same property from every surface gives the same canonical focus', () => {
  it('Show on Map, Open and Inspect all resolve to property 273312064', { timeout: 30000 }, async () => {
    const env = await load('/inbox')
    env.store.openApp('/map', 'beside')
    const refs = refsFromEverySurface(env)
    const opened: string[] = []
    for (const [surface, ref] of Object.entries(refs)) {
      const r = env.actions.showOnMap(ref)
      expect(r.ok, surface).toBe(true)
      opened.push(env.reg.objectCapabilities(ref).open!)
      env.actions.inspectObject(ref)
      expect(env.inspector.readInspectorState().current?.id, surface).toBe('273312064')
    }
    const ids = (env.seen as Array<{ propertyId: string }>).map((f) => f.propertyId)
    expect(ids).toHaveLength(6)
    expect(new Set(ids)).toEqual(new Set(['273312064']))
    expect(new Set(opened)).toEqual(new Set(['/deal-intelligence?property_id=273312064']))
    // only the caller that held canonical coordinates sends them; nobody invents them
    const withCoords = (env.seen as Array<{ lat: number | null; source: string }>).filter((f) => f.lat !== null).map((f) => f.source)
    expect(withCoords).toEqual(['comp-intelligence'])
    env.stop()
  })
})

describe('Show on Map — where the Map is', () => {
  let env: Env
  beforeEach(async () => { env = await load('/comp-intelligence?property_id=1') })
  afterEach(() => env.stop())

  it('visible: the Map focuses in place; the operator keeps their pane and the layout does not move', async () => {
    env.store.openApp('/map', 'beside')
    const comps = paneOfApp(env, 'comp-intelligence').id
    env.store.focusPane(comps)
    const before = env.store.getWorkspace().layout
    const r = env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p1', label: '1 Main St' }), { source: 'comp-intelligence' })
    expect(r).toMatchObject({ ok: true, outcome: 'focused' })
    expect(env.store.getWorkspace().layout).toBe(before)
    expect(env.focus.readPendingMapPropertyFocus()?.propertyId).toBe('p1')
  })

  it('not visible (a background tab): the tab is revealed, focus stays in Comps', async () => {
    env.store.openApp('/map', { pane: env.store.getWorkspace().layout.focus, zone: 'stack' })
    // stack Map behind Comps, then bring Comps back to the front of that pane
    const pane = paneOfApp(env, 'map')
    env.store.activateTab(pane.id, inst(env, 'comp-intelligence').id)
    expect(paneOfApp(env, 'map').active).not.toBe(inst(env, 'map').id)
    const focusBefore = env.store.getWorkspace().layout.focus
    const r = env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p2' }))
    expect(r.outcome).toBe('revealed')
    expect(paneOfApp(env, 'map').active).toBe(inst(env, 'map').id)
    expect(env.store.getWorkspace().layout.focus).toBe(focusBefore)
  })

  it('hidden behind a maximized pane: the maximize is restored so the Map is on screen', async () => {
    env.store.openApp('/map', 'beside')
    const comps = paneOfApp(env, 'comp-intelligence').id
    env.store.toggleMaximize(comps)
    expect(env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p3' })).outcome).toBe('revealed')
    expect(env.store.getWorkspace().layout.maximized).toBeNull()
  })

  it('not open: the Map opens BESIDE (Comps is not navigated away) and consumes the pending request on mount', async () => {
    expect(apps(env)).toEqual(['comp-intelligence'])
    const r = env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p4' }))
    expect(r.outcome).toBe('map-opened')
    expect(apps(env)).toEqual(['comp-intelligence', 'map'])
    expect(inst(env, 'comp-intelligence').path).toBe('/comp-intelligence?property_id=1')
    expect(env.focus.readPendingMapPropertyFocus()?.propertyId).toBe('p4')
  })

  it('pinned: the Map stays put and the operator is told why', async () => {
    env.store.openApp('/map', 'beside')
    env.store.setPinned(inst(env, 'map').id, true)
    const r = env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p5' }))
    expect(r).toMatchObject({ ok: false, outcome: 'pinned' })
    expect(env.seen).toHaveLength(0)
    expect(env.store.getWorkspace().announce).toMatch(/pinned/)
  })

  it('unlinked workspace: an explicit Show on Map still reaches the Map', async () => {
    env.store.openApp('/map', 'beside')
    env.store.setLinked(false)
    expect(env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p6' })).ok).toBe(true)
    expect(env.seen).toHaveLength(1)
  })

  it('no property: unavailable with a reason, nothing is sent', async () => {
    const r = env.actions.showOnMap(env.reg.campaignObject({ campaignId: 'c1' }))
    expect(r).toMatchObject({ ok: false, outcome: 'unavailable' })
    expect(r.reason).toMatch(/no single place/)
    expect(env.actions.showOnMap(env.reg.dealObject({ opportunityId: 'o1' })).reason).toMatch(/No property is linked/)
    expect(env.seen).toHaveLength(0)
  })

  it('multi-property: frames the set from canonical coordinates; properties without them are reported, never placed', async () => {
    const { propertyObject } = env.reg
    const r = env.actions.showOnMap([
      propertyObject({ propertyId: 'a', lat: 44.98, lng: -93.27 }),
      propertyObject({ propertyId: 'b', lat: 45.01, lng: -93.3 }),
      propertyObject({ propertyId: 'c' }),
    ], { setLabel: 'comps' })
    expect(r.ok).toBe(true)
    const set = env.focusSet.readMapFocusSet()!
    expect(set.points.map((p) => p.id)).toEqual(['a', 'b'])
    expect(env.store.getWorkspace().announce).toMatch(/1 of 3 have no coordinates/)
  })
})

describe('Open / Open beside / linked context', () => {
  it('Open lands in the pane being acted in and publishes the linked subject', async () => {
    const env = await load('/inbox')
    const r = env.actions.openObject(env.reg.propertyObject({ propertyId: 'p7', threadKey: 'tk7', label: '7 Elm' }))
    expect(r.outcome).toBe('opened')
    expect(env.w.location.pathname + env.w.location.search).toBe('/deal-intelligence?property_id=p7')
    expect(env.locator.readPropertyLocator()).toMatchObject({ propertyId: 'p7', threadKey: 'tk7', address: '7 Elm' })
  })

  it('Open beside uses the existing split; an app already open is focused instead of duplicated', async () => {
    const env = await load('/inbox')
    expect(env.actions.openObjectBeside(env.reg.dealObject({ opportunityId: 'o8', propertyId: 'p8' })).outcome).toBe('beside')
    expect(apps(env)).toEqual(['inbox', 'pipeline'])
    expect(env.actions.openObjectBeside(env.reg.dealObject({ opportunityId: 'o9' })).outcome).toBe('focused')
    expect(apps(env)).toEqual(['inbox', 'pipeline'])
    expect(inst(env, 'pipeline').path).toBe('/pipeline?opp=o9')
  })

  it('a large (8-pane) workspace: Open targets the linked app’s own pane; pinned and unrelated panes are untouched', async () => {
    const env = await load('/inbox')
    for (const p of ['/map', '/comp-intelligence', '/pipeline', '/entity-graph', '/analytics', '/campaign-command', '/calendar']) env.store.openApp(p, 'beside')
    expect(Object.keys(env.store.getWorkspace().layout.instances)).toHaveLength(8)
    env.store.setPinned(inst(env, 'comp-intelligence').id, true)
    const compsBefore = inst(env, 'comp-intelligence').path
    const analyticsBefore = inst(env, 'analytics').path
    const campaignBefore = inst(env, 'campaign-command').path
    const ref = env.reg.dealObject({ opportunityId: 'o10', propertyId: 'p10', threadKey: 'tk10' })
    env.actions.openObject(ref)
    env.bus.__linkedTest.flush() // linked follow is debounced (latest click wins)
    const ws = env.store.getWorkspace().layout
    // the deal opened in the pane that already holds Pipeline — and that pane took focus
    expect(inst(env, 'pipeline').path).toBe('/pipeline?opp=o10')
    expect(ws.focus).toBe(paneOfApp(env, 'pipeline').id)
    // linked context reached Entity Graph (it reads property ids) …
    expect(inst(env, 'entity-graph').path).toBe('/entity-graph/property/p10')
    // … but not the pinned Comps, nor apps that do not understand a property
    expect(inst(env, 'comp-intelligence').path).toBe(compsBefore)
    expect(inst(env, 'analytics').path).toBe(analyticsBefore)
    expect(inst(env, 'campaign-command').path).toBe(campaignBefore)
    // Show on Map in the same workspace reveals the one Map instance in place
    expect(env.actions.showOnMap(ref).outcome).toBe('focused')
    expect(env.store.getWorkspace().layout.focus).toBe(paneOfApp(env, 'pipeline').id)
  })

  it('outside the desktop workspace, actions fall back to plain navigation', async () => {
    const env = await load('/inbox', false)
    expect(env.actions.showOnMap(env.reg.propertyObject({ propertyId: 'p11' })).outcome).toBe('navigated')
    expect(env.w.location.pathname).toBe('/map')
    expect(env.focus.readPendingMapPropertyFocus()?.propertyId).toBe('p11')
  })
})

describe('click grammar', () => {
  it('click / shift-click / cmd-or-ctrl-click', async () => {
    const env = await load('/inbox')
    const { gestureOf, handleObjectClick } = env.actions
    expect(gestureOf({})).toBe('activate')
    expect(gestureOf({ shiftKey: true })).toBe('inspect')
    expect(gestureOf({ metaKey: true })).toBe('beside')
    expect(gestureOf({ ctrlKey: true })).toBe('beside')
    expect(gestureOf({ metaKey: true, shiftKey: true })).toBe('activate')
    const ref = env.reg.propertyObject({ propertyId: 'p12' })
    let activated = 0
    expect(handleObjectClick({ shiftKey: true }, ref, () => { activated++ })).toBe('inspect')
    expect(env.inspector.readInspectorState().current?.id).toBe('p12')
    // a plain click on another object yields the unpinned inspector, then runs the surface's own click
    expect(handleObjectClick({}, ref, () => { activated++ })).toBe('activate')
    expect(activated).toBe(1)
    expect(env.inspector.readInspectorState().current).toBeNull()
    // shift-click on a type the inspector cannot read falls back to the plain click
    expect(handleObjectClick({ shiftKey: true }, env.reg.companyObject({ organizationId: 'o1' }), () => { activated++ })).toBe('activate')
    expect(activated).toBe(2)
  })

  it('the canonical property menu: Open / Open beside / Inspect / Show on Map / missions', async () => {
    const env = await load('/inbox')
    const ids = env.actions.objectActions(env.reg.propertyObject({ propertyId: 'p13', threadKey: 'tk' })).map((a) => a.id)
    expect(ids).toEqual(['open', 'beside', 'inspect', 'map', 'mission:work_seller', 'mission:move_deal'])
    const inMap = env.actions.objectActions(env.reg.propertyObject({ propertyId: 'p13' }), { omit: ['map'] }).map((a) => a.id)
    expect(inMap).not.toContain('map')
    const company = env.actions.objectActions(env.reg.companyObject({ organizationId: 'o1' }))
    expect(company.find((a) => a.id === 'inspect')).toMatchObject({ disabled: true, reason: 'No quick view for this yet' })
  })
})
