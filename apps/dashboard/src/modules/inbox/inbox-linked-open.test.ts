import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openLinkedThread, type LinkedInboxDeps } from './inbox-linked-open'
import { applyThreadReadOnSelect, type ThreadSelectIntent } from './thread-read-policy'
import type { PropertyLocator } from '../../domain/locator/property-locator'

vi.mock('../../domain/inbox/deal-desk-thread-reference', () => ({
  resolveDealDeskWritableThreadKey: (t: { threadKey?: string }) => ({ ok: true, threadKey: t.threadKey ?? 'k' }),
}))

const here = dirname(fileURLToPath(import.meta.url))
const loc = (p: Partial<PropertyLocator>): PropertyLocator => ({ propertyId: null, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: null, setAt: 0, ...p })
type T = { id: string; threadKey: string }

/** deps whose selections go through the REAL read policy with a spy on the write */
function harness(over: Partial<LinkedInboxDeps<T>> = {}) {
  const patchRead = vi.fn().mockResolvedValue({ ok: true })
  const selected: Array<{ via: string; intent: ThreadSelectIntent | null }> = []
  const deps: LinkedInboxDeps<T> = {
    findInList: () => null,
    lookupThreadKey: vi.fn().mockResolvedValue(null),
    fetchThread: vi.fn().mockResolvedValue(null),
    selectInList: (id) => { selected.push({ via: 'list', intent: 'navigate' }); applyThreadReadOnSelect('navigate', { threadKey: id } as never, { patchRead }) },
    selectFetched: (t) => { selected.push({ via: 'fetched', intent: null }); void t },
    ...over,
  }
  return { deps, patchRead, selected }
}

describe('linked Inbox open', () => {
  it('a loaded thread opens with the navigate intent and NEVER marks read', async () => {
    const { deps, patchRead, selected } = harness({ findInList: ({ threadKey }) => (threadKey === 'T1' ? 'row-1' : null) })
    const out = await openLinkedThread(loc({ propertyId: 'P', threadKey: 'T1' }), deps, new AbortController().signal)
    expect(out).toBe('in_list')
    expect(selected).toEqual([{ via: 'list', intent: 'navigate' }])
    expect(patchRead).not.toHaveBeenCalled()
  })

  it('property only: property → thread key → fetched thread, selected without a read', async () => {
    const fetchThread = vi.fn().mockResolvedValue({ id: 'x', threadKey: 'T7' })
    const { deps, patchRead, selected } = harness({ lookupThreadKey: vi.fn().mockResolvedValue('T7'), fetchThread })
    const out = await openLinkedThread(loc({ propertyId: 'P7' }), deps, new AbortController().signal)
    expect(out).toBe('fetched')
    expect(fetchThread).toHaveBeenCalledWith('T7', expect.anything())
    expect(selected).toEqual([{ via: 'fetched', intent: null }])
    expect(patchRead).not.toHaveBeenCalled()
  })

  it('no conversation for the property is missing — nothing is selected', async () => {
    const { deps, selected } = harness()
    expect(await openLinkedThread(loc({ propertyId: 'P0' }), deps, new AbortController().signal)).toBe('missing')
    expect(selected).toEqual([])
  })

  it('a stale run (newer click) stops before selecting', async () => {
    const ctl = new AbortController()
    const { deps, selected } = harness({ lookupThreadKey: vi.fn().mockImplementation(async () => { ctl.abort(); return 'T1' }) })
    expect(await openLinkedThread(loc({ propertyId: 'P' }), deps, ctl.signal)).toBe('aborted')
    expect(selected).toEqual([])
  })

  it('InboxPage wires the linked open to the navigate intent only — no read path', () => {
    const src = readFileSync(join(here, 'InboxPage.tsx'), 'utf8')
    const start = src.indexOf('const followLinkedProperty = useCallback(')
    const end = src.indexOf('useLinkedProperty(followLinkedProperty', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain("selectThreadWithIntent(id, 'navigate')")
    for (const banned of ['open_conversation', 'handleSelect(', 'readOnSelect', 'markThreadRead', 'is_read', 'handleThreadAction', 'handleDeskOpen']) {
      expect(block).not.toContain(banned)
    }
  })
})
