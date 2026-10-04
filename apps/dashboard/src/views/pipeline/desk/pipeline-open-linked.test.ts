/**
 * QA defect (HIGH): "Deal Intelligence" for the deal at 2939 Lyndale opened on
 * 3226 Aldrich — the Inbox thread's property, carried by linked selection.
 *
 * The real locator + linked-property bus, the real Pipeline open; the target
 * apps are modelled exactly as they take a subject: from the path they are
 * opened on, then from linked signals (DI's follower; the workspace re-aim for
 * path-subject apps). An ambient re-publish of the Inbox's thread lands in the
 * same moment as the open — the race — and must not win.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../modules/desktop/workspace/workspace-store', () => ({ announceWorkspace: vi.fn(), isWorkspaceRunning: () => true, openApp: vi.fn() }))
vi.mock('../../../modules/mobile/mobile-inbox-bridge', () => ({ stageInboxThread: vi.fn() }))
vi.mock('../../../app/router', () => ({ pushRoutePath: vi.fn() }))

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
  const bus = await import('../../../domain/locator/linked-property-bus')
  const locator = await import('../../../domain/locator/property-locator')
  const open = await import('./pipeline-open')
  bus.__linkedTest.reset()
  return { bus, locator, open }
}

/** The property a path names (?property_id= or /entity-graph/property/<id>). */
const propertyOfPath = (path: string) => new URLSearchParams(path.split('?')[1] ?? '').get('property_id') ?? (path.match(/\/property\/([^/?]+)/)?.[1] ?? null)

const THREAD_A = { propertyId: 'X-3226-ALDRICH', threadKey: '+16125550001' }
const DEAL_B = { id: 'opp-B', propertyId: 'Y-2939-LYNDALE', threadKey: '+16125550002', address: '2939 Lyndale Ave S' }

const TARGETS = ['deal_intelligence', 'entity_graph', 'buyer_match', 'comps'] as const

describe('an explicit Pipeline open wins over the Inbox’s linked selection', () => {
  beforeEach(() => { vi.useFakeTimers() })

  for (const target of TARGETS) {
    for (const alreadyOpen of [true, false]) {
      it(`${target} (${alreadyOpen ? 'already open, following' : 'opened fresh'}) shows the deal’s property, not the Inbox thread’s`, async () => {
        const { bus, locator, open } = await load()
        // the target app: its subject, and a follower like the real one
        let shown: string | null = null
        let mounted = alreadyOpen
        const follower = bus.createLinkedFollower('target-pane', (loc) => { if (mounted && loc.propertyId) shown = loc.propertyId })
        bus.subscribeLinkedProperty(follower.onSignal)

        // 1. Inbox: thread A (property X) is selected — every follower moves to X
        locator.setPropertyLocator(THREAD_A)
        vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
        if (alreadyOpen) expect(shown).toBe(THREAD_A.propertyId)

        // 2. Pipeline opens the target for deal B (property Y). In the same
        //    moment the Inbox host re-publishes its own thread A — the race.
        const outcome = open.openFromPipeline(target, DEAL_B, {
          saveReturn: vi.fn(),
          openBeside: (path) => {
            mounted = true
            shown = propertyOfPath(path) // the pane takes the subject it was opened on
            locator.setPropertyLocator(THREAD_A) // ambient re-publish, same tick
            return alreadyOpen ? 'focused' : 'opened'
          },
        })
        expect(outcome).toBe(alreadyOpen ? 'focused' : 'beside')
        vi.advanceTimersByTime(100)
        locator.setPropertyLocator(THREAD_A) // and once more, a late write
        vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS * 3)

        expect(shown).toBe(DEAL_B.propertyId)
        expect(locator.readPropertyLocator()?.propertyId).toBe(DEAL_B.propertyId)
      })
    }
  }

  it('the hold is brief: a later, deliberate selection in another app is followed again', async () => {
    const { bus, locator, open } = await load()
    let shown: string | null = null
    bus.subscribeLinkedProperty(bus.createLinkedFollower('di', (loc) => { shown = loc.propertyId }).onSignal)
    open.openFromPipeline('deal_intelligence', DEAL_B, { saveReturn: vi.fn(), openBeside: () => 'focused' })
    expect(shown).toBe(DEAL_B.propertyId) // broadcast at once, not debounced
    vi.advanceTimersByTime(bus.EXPLICIT_HOLD_MS + 10)
    locator.setPropertyLocator(THREAD_A)
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    expect(shown).toBe(THREAD_A.propertyId)
  })

  it('an explicit open re-broadcasts even when the bus already holds that subject (fresh sequence)', async () => {
    const { bus, locator } = await load()
    const seqs: number[] = []
    bus.subscribeLinkedProperty((s) => seqs.push(s.seq))
    locator.setPropertyLocator({ propertyId: 'Y' })
    vi.advanceTimersByTime(bus.LINKED_DEBOUNCE_MS + 1)
    locator.setPropertyLocator({ propertyId: 'Y' }, { explicit: true })
    expect(seqs.length).toBe(2)
    expect(seqs[1]).toBeGreaterThan(seqs[0])
  })
})
