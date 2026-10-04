import { beforeEach, describe, expect, it, vi } from 'vitest'

/* A minimal window: events + sessionStorage, enough for the locator and the bus. */
function installWindow() {
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const m = new Map<string, string>()
  const w = {
    sessionStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } },
    addEventListener: (t: string, fn: (e: Event) => void) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(fn) },
    removeEventListener: (t: string, fn: (e: Event) => void) => { handlers.get(t)?.delete(fn) },
    dispatchEvent: (e: Event) => { handlers.get(e.type)?.forEach((fn) => fn(e)); return true },
  }
  class CustomEvent<T> { type: string; detail: T; constructor(type: string, init?: { detail: T }) { this.type = type; this.detail = init?.detail as T } }
  Object.assign(globalThis, { window: w, CustomEvent })
  return w
}

async function load() {
  vi.resetModules()
  installWindow()
  const bus = await import('./linked-property-bus')
  const locator = await import('./property-locator')
  bus.__linkedTest.reset()
  return { bus, locator }
}

describe('linked-property bus', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('publish → one debounced signal per settled click; latest wins', async () => {
    vi.useFakeTimers()
    const { bus, locator } = await load()
    const got: string[] = []
    bus.subscribeLinkedProperty((s) => got.push(String(s.locator.propertyId)))
    locator.setPropertyLocator({ propertyId: 'A' })
    locator.setPropertyLocator({ propertyId: 'B' })
    locator.setPropertyLocator({ propertyId: 'C' })
    expect(got).toEqual([])
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    expect(got).toEqual(['C'])
    // the stored locator is immediate (dock, deck chip), only the follow waits
    expect(locator.readPropertyLocator()?.propertyId).toBe('C')
  })

  it('sequence ids increase and the source is attributed at publish time', async () => {
    const { bus, locator } = await load()
    const got: Array<{ seq: number; source: string | null }> = []
    bus.subscribeLinkedProperty((s) => got.push({ seq: s.seq, source: s.source }))
    let acting = 'pane-inbox'
    bus.setLinkedSourceResolver(() => acting)
    locator.setPropertyLocator({ propertyId: 'P1' }); bus.__linkedTest.flush()
    acting = 'pane-map'
    locator.setPropertyLocator({ propertyId: 'P2' }); bus.__linkedTest.flush()
    expect(got.map((g) => g.source)).toEqual(['pane-inbox', 'pane-map'])
    expect(got[1].seq).toBeGreaterThan(got[0].seq)
  })

  it('dedupes an identical subject: a re-publish of the same property enriches but does not re-broadcast', async () => {
    const { bus, locator } = await load()
    const got: unknown[] = []
    bus.subscribeLinkedProperty((s) => got.push(s))
    locator.setPropertyLocator({ propertyId: 'P1', opportunityId: 'O1' }); bus.__linkedTest.flush()
    locator.setPropertyLocator({ propertyId: 'P1', threadKey: 'T1' }); bus.__linkedTest.flush()
    expect(got).toHaveLength(1)
    const held = locator.readPropertyLocator()
    expect(held?.threadKey).toBe('T1')
    expect(held?.opportunityId).toBe('O1') // not erased by a publish that did not carry it
  })

  it('a follower applying a linked selection never re-broadcasts and never re-aims the locator', async () => {
    const { bus, locator } = await load()
    const got: unknown[] = []
    bus.subscribeLinkedProperty((s) => got.push(s))
    locator.setPropertyLocator({ propertyId: 'P1' }); bus.__linkedTest.flush()
    bus.withLinkedApply(() => {
      locator.setPropertyLocator({ propertyId: 'P1', threadKey: 'T1' }) // enrich: kept
      locator.setPropertyLocator({ propertyId: 'P9' }) // a different subject: ignored
    })
    bus.__linkedTest.flush()
    expect(got).toHaveLength(1)
    expect(locator.readPropertyLocator()?.propertyId).toBe('P1')
    expect(locator.readPropertyLocator()?.threadKey).toBe('T1')
  })

  it('no ping-pong: two followers that re-select on arrival produce exactly one signal', async () => {
    const { bus, locator } = await load()
    const signals: number[] = []
    bus.subscribeLinkedProperty((s) => signals.push(s.seq))
    let source = 'pipeline'
    bus.setLinkedSourceResolver(() => source)
    const echo = (id: string) => bus.createLinkedFollower(id, (loc) => {
      // each follower "selects" what it resolved — with richer identity
      locator.setPropertyLocator({ ...loc, threadKey: `T-${id}`, masterOwnerId: `M-${id}` })
    })
    const inbox = echo('inbox')
    const map = echo('map')
    const stopA = bus.subscribeLinkedProperty(inbox.onSignal)
    const stopB = bus.subscribeLinkedProperty(map.onSignal)
    locator.setPropertyLocator({ propertyId: 'P1', opportunityId: 'O1' })
    source = 'inbox' // whatever the followers publish, it is not a new selection
    bus.__linkedTest.flush()
    bus.__linkedTest.flush()
    expect(signals).toHaveLength(1)
    stopA(); stopB()
  })

  it('a follower skips its own selection and a subject it already shows; a newer one aborts the stale run', async () => {
    const { bus } = await load()
    const runs: Array<{ id: string | null; signal: AbortSignal }> = []
    const f = bus.createLinkedFollower('comps', (loc, ctx) => runs.push({ id: loc.propertyId, signal: ctx.signal }))
    const sig = (propertyId: string, source: string | null, seq: number) => ({ locator: { propertyId, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: null, setAt: 0 }, seq, source, at: 0 })
    f.onSignal(sig('P1', 'comps', 1)) // its own
    expect(runs).toHaveLength(0)
    f.onSignal(sig('P1', 'map', 2)) // already showing P1
    expect(runs).toHaveLength(0)
    f.onSignal(sig('P2', 'map', 3))
    f.onSignal(sig('P3', 'map', 4))
    expect(runs.map((r) => r.id)).toEqual(['P2', 'P3'])
    expect(runs[0].signal.aborted).toBe(true)
    expect(runs[1].signal.aborted).toBe(false)
    f.dispose()
    expect(runs[1].signal.aborted).toBe(true)
  })

  it('ctx.apply is skipped once the run is stale', async () => {
    const { bus } = await load()
    const applied: string[] = []
    const pending: Array<() => void> = []
    const f = bus.createLinkedFollower(null, (loc, ctx) => { pending.push(() => { ctx.apply(() => applied.push(String(loc.propertyId))) }) })
    const sig = (propertyId: string, seq: number) => ({ locator: { propertyId, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: null, setAt: 0 }, seq, source: null, at: 0 })
    f.onSignal(sig('SLOW', 1))
    f.onSignal(sig('FAST', 2))
    pending.forEach((p) => p()) // the slow fetch resolves after the fast one
    expect(applied).toEqual(['FAST'])
  })

  it('clearing the selection resets dedupe: the same property selected again is new', async () => {
    const { bus, locator } = await load()
    const got: unknown[] = []
    bus.subscribeLinkedProperty((s) => got.push(s))
    locator.setPropertyLocator({ propertyId: 'P1' }); bus.__linkedTest.flush()
    locator.clearPropertyLocator()
    locator.setPropertyLocator({ propertyId: 'P1' }); bus.__linkedTest.flush()
    expect(got).toHaveLength(2)
  })

  it('sameSubject: the property decides when both carry one', async () => {
    const { bus } = await load()
    const L = (p: Partial<Record<'propertyId' | 'threadKey' | 'opportunityId', string>>) => ({ propertyId: p.propertyId ?? null, threadKey: p.threadKey ?? null, opportunityId: p.opportunityId ?? null })
    expect(bus.sameSubject(L({ propertyId: 'P', threadKey: 'T1' }), L({ propertyId: 'P', threadKey: 'T2' }))).toBe(true)
    expect(bus.sameSubject(L({ propertyId: 'P', opportunityId: 'O' }), L({ propertyId: 'Q', opportunityId: 'O' }))).toBe(false)
    expect(bus.sameSubject(L({ threadKey: 'T' }), L({ propertyId: 'P', threadKey: 'T' }))).toBe(true)
    expect(bus.sameSubject(L({ opportunityId: 'O' }), L({ propertyId: 'P' }))).toBe(false)
  })
})
