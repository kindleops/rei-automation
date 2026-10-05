import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

vi.mock('../inbox/deal-desk-thread-reference', () => ({
  resolveDealDeskWritableThreadKey: (t: { threadKey?: string }) => ({ ok: true, threadKey: t.threadKey ?? 'k' }),
}))

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
}

async function load() {
  vi.resetModules()
  installWindow()
  const bus = await import('./linked-property-bus')
  const locator = await import('./property-locator')
  bus.__linkedTest.reset()
  bus.__linkedTest.track()
  let acting = 'pipeline'
  bus.setLinkedSourceResolver(() => acting)
  /** a click in `pane`: publishes inside it are the operator's intent */
  const click = (pane: string, fn: () => void) => { acting = pane; bus.markUserInput(true); bus.markUserInput(false); fn(); bus.__linkedTest.endInput() }
  /** a host re-asserting its own state: no input in its task */
  const ambient = (pane: string, fn: () => void) => { acting = pane; fn() }
  return { bus, locator, click, ambient }
}

describe('linked context — origin-aware latest wins', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('a Pipeline table click is not overridden by a stale Inbox re-publish 0–2s later', async () => {
    vi.useFakeTimers()
    const { bus, locator, click, ambient } = await load()
    const got: string[] = []
    bus.subscribeLinkedProperty((s) => got.push(String(s.locator.propertyId)))
    click('inbox', () => locator.setPropertyLocator({ propertyId: 'A', threadKey: 'tA' }))
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    click('pipeline', () => locator.setPropertyLocator({ propertyId: 'B', opportunityId: 'oB' }))
    for (const ms of [0, 300, 900, 1500, 2000]) {
      vi.advanceTimersByTime(ms === 0 ? 1 : 300)
      ambient('inbox', () => locator.setPropertyLocator({ propertyId: 'A', threadKey: 'tA' }))
      ambient('map', () => locator.setPropertyLocator({ propertyId: 'A' }))
    }
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    expect(got).toEqual(['A', 'B'])
    expect(locator.readPropertyLocator()?.propertyId).toBe('B')
  })

  it('an ambient publish of the SAME subject still enriches it', async () => {
    const { bus, locator, click, ambient } = await load()
    click('pipeline', () => locator.setPropertyLocator({ propertyId: 'B' }))
    ambient('inbox', () => locator.setPropertyLocator({ propertyId: 'B', threadKey: 'tB' }))
    expect(locator.readPropertyLocator()).toMatchObject({ propertyId: 'B', threadKey: 'tB' })
    void bus
  })

  it('a new gesture releases the hold (a read the operator asked for after it lands); so does time', async () => {
    vi.useFakeTimers()
    const { bus, locator, click, ambient } = await load()
    click('pipeline', () => locator.setPropertyLocator({ propertyId: 'B' }))
    ambient('inbox', () => locator.setPropertyLocator({ propertyId: 'A' }))
    expect(locator.readPropertyLocator()?.propertyId).toBe('B')
    bus.markUserInput(true); bus.__linkedTest.endInput() // the operator pressed a key elsewhere
    ambient('inbox', () => locator.setPropertyLocator({ propertyId: 'A' }))
    expect(locator.readPropertyLocator()?.propertyId).toBe('A')

    click('pipeline', () => locator.setPropertyLocator({ propertyId: 'C' }))
    vi.advanceTimersByTime(bus.INTENT_HOLD_MS + 1)
    ambient('inbox', () => locator.setPropertyLocator({ propertyId: 'A' }))
    expect(locator.readPropertyLocator()?.propertyId).toBe('A')
  })

  it('without workspace tracking (phones, single-app shells) every publish behaves as before', async () => {
    const { bus, locator } = await load()
    bus.__linkedTest.reset() // tracking off
    locator.setPropertyLocator({ propertyId: 'B' })
    locator.setPropertyLocator({ propertyId: 'A' })
    expect(locator.readPropertyLocator()?.propertyId).toBe('A')
  })

  it('no ping-pong between any two hosts: followers re-select on arrival, hosts re-assert late — one signal per click', async () => {
    vi.useFakeTimers()
    const { bus, locator, click, ambient } = await load()
    const signals: string[] = []
    bus.subscribeLinkedProperty((s) => signals.push(`${s.locator.propertyId}@${s.source}`))
    const hosts = ['inbox', 'map', 'pipeline', 'di', 'entity-graph', 'buyer-match', 'comps']
    const shows: Record<string, string | null> = Object.fromEntries(hosts.map((h) => [h, null]))
    for (const h of hosts) {
      const f = bus.createLinkedFollower(h, (loc, ctx) => {
        // re-select on arrival (guarded) …
        locator.setPropertyLocator({ propertyId: loc.propertyId, address: `${h} enrich` })
        shows[h] = loc.propertyId
        // … and a late async completion
        setTimeout(() => ctx.apply(() => locator.setPropertyLocator({ propertyId: loc.propertyId })), 50)
      })
      bus.subscribeLinkedProperty(f.onSignal)
    }
    // the operator clicks through apps; between clicks every host re-asserts its old state
    const clicks: Array<[string, string]> = [['inbox', 'A'], ['pipeline', 'B'], ['map', 'C'], ['di', 'D'], ['inbox', 'E']]
    for (const [pane, pid] of clicks) {
      const before = { ...shows }
      click(pane, () => locator.setPropertyLocator({ propertyId: pid }))
      for (const h of hosts) if (before[h]) ambient(h, () => locator.setPropertyLocator({ propertyId: before[h] }))
      vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 60)
      for (const h of hosts) if (before[h]) ambient(h, () => locator.setPropertyLocator({ propertyId: before[h] }))
      vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 60)
    }
    expect(signals).toEqual(['A@inbox', 'B@pipeline', 'C@map', 'D@di', 'E@inbox'])
    for (const h of hosts) if (h !== 'inbox') expect(shows[h]).toBe('E')
    expect(locator.readPropertyLocator()?.propertyId).toBe('E')
  })

  it("a pane's own selection cancels its stale linked run; a newer selection anywhere makes a run stale", async () => {
    vi.useFakeTimers()
    const { bus, locator, click } = await load()
    const applied: string[] = []
    let later: (() => void) | null = null
    const f = bus.createLinkedFollower('pipeline', (loc, ctx) => { later = () => { ctx.apply(() => applied.push(String(loc.propertyId))) } })
    bus.subscribeLinkedProperty(f.onSignal)
    click('inbox', () => locator.setPropertyLocator({ propertyId: 'A' }))
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    // Pipeline's lookup for A is in flight when the operator clicks B in Pipeline
    click('pipeline', () => locator.setPropertyLocator({ propertyId: 'B' }))
    later!() // still inside the debounce: B is newer
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    later!() // B's own signal arrived: the run was aborted
    expect(applied).toEqual([])
  })
})

describe('symptom 3 — a Pipeline click opens that deal in the Inbox (never a read) and the Map follows', () => {
  it('board beads, table rows and the overview planes all open through one choke point that publishes the property and the thread', async () => {
    const desk = readFileSync(join(here, '../../views/pipeline/desk/PipelineDesk.tsx'), 'utf8')
    // flow board + table: onOpen={openDeal}; overview planes: openById / openDeal
    expect(desk.match(/onOpen=\{openDeal\}/g)?.length).toBeGreaterThanOrEqual(2)
    expect(desk).toContain('onOpenDeal={openById}')
    expect(desk).toContain('onOpenDeal={openDeal}')
    expect(desk).toContain('setPropertyLocator(dealLocator(seed, card.id))')
    const { dealLocator } = await import('../../views/pipeline/desk/pipeline-linked')
    expect(dealLocator({ id: 'o1', propertyId: 'P1', threadKey: 't1', masterOwnerId: 'm1', address: '1 Main' }, 'o1'))
      .toEqual({ propertyId: 'P1', threadKey: 't1', masterOwnerId: 'm1', opportunityId: 'o1', address: '1 Main' })
  })

  it('the Inbox follower opens the thread with the navigate intent, the Map follower flies — no read write', async () => {
    vi.useFakeTimers()
    const { bus, locator, click } = await load()
    const { openLinkedThread } = await import('../../modules/inbox/inbox-linked-open')
    const { applyThreadReadOnSelect } = await import('../../modules/inbox/thread-read-policy')
    const { dealLocator } = await import('../../views/pipeline/desk/pipeline-linked')
    const patchRead = vi.fn().mockResolvedValue({ ok: true })
    const opened: string[] = []
    const flown: string[] = []
    const inbox = bus.createLinkedFollower('inbox', (loc, ctx) => {
      void openLinkedThread(loc, {
        findInList: ({ threadKey }) => (threadKey === 't1' ? 'row-1' : null),
        lookupThreadKey: async () => null,
        fetchThread: async () => null,
        selectInList: (id) => ctx.apply(() => { opened.push(id); applyThreadReadOnSelect('navigate', { threadKey: id } as never, { patchRead }) }),
        selectFetched: () => {},
      }, ctx.signal)
    })
    const map = bus.createLinkedFollower('map', (loc) => { flown.push(String(loc.propertyId)) })
    bus.subscribeLinkedProperty(inbox.onSignal)
    bus.subscribeLinkedProperty(map.onSignal)
    click('pipeline', () => locator.setPropertyLocator(dealLocator({ id: 'o1', propertyId: 'P1', threadKey: 't1', masterOwnerId: null, address: null }, 'o1')))
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    await vi.runAllTimersAsync()
    expect(opened).toEqual(['row-1'])
    expect(flown).toEqual(['P1'])
    expect(patchRead).not.toHaveBeenCalled()
  })
})
