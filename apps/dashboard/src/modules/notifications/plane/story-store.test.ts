import { describe, expect, it, vi } from 'vitest'

const played: Array<{ id: string; category: string }> = []
vi.mock('../../../shared/sound', () => ({ sound: { machine: { event: (e: { id: string; category: string }) => played.push(e) } } }))
vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))
vi.mock('../../desktop/objects', () => ({}))

import { __storyStore, voice } from './story-store'
import { serializeCache } from './story-model'
import type { Story } from './story-model'

const s = (id: string, sound: Story['sound'], over: Partial<Story> = {}) => ({ id, sound, resolved: false, ...over }) as Story

describe('notification plane sound', () => {
  it('one event, one sound: only plane-voiced, unresolved story triggers reach the Sound System, keyed by event identity', () => {
    played.length = 0
    voice([
      s('a', { id: 'story:ce:1', category: 'needsAttention', priority: 1, cue: 'attention', at: 1, voiced_by: 'plane' }),
      s('b', { id: 'story:me:9', category: 'sellerReplies', priority: 2, cue: 'ready', at: 1, voiced_by: 'rail' }),
      s('c', null),
      s('d', { id: 'story:ne:4', category: 'systemDegradation', priority: 1, cue: 'error', at: 1, voiced_by: 'plane' }, { resolved: true }),
    ])
    expect(played.map((p) => p.id)).toEqual(['story:ce:1'])
  })
})

describe('notification plane instant open', () => {
  it('hydrates last-known stories from the session cache (ready at once, reconciling, badge from them)', () => {
    const mem = new Map<string, string>()
    const sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, clear: () => mem.clear() }
    vi.stubGlobal('window', { sessionStorage })
    const now = Date.now()
    const st = { id: 'a', sound: null, resolved: false, read: false, lens: 'needs_you', priority: 'action', requires_operator: true, updated_at: new Date(now - 60e3).toISOString(), state: { code: 'open', label: null, tone: null } } as unknown as Story
    sessionStorage.setItem('lc.notifications.stories.v1', serializeCache([st], { generatedAt: new Date(now - 30e3).toISOString(), horizon: null, counts: null, nextCursor: null }, now))
    __storyStore.hydrate()
    const s = __storyStore.get()
    expect(s.status).toBe('ready')
    expect(s.reconciling).toBe(true)
    expect(s.stories.has('a')).toBe(true)
    expect(s.counts?.badge).toBe(1)
    sessionStorage.clear()
    __storyStore.reset()
    expect(__storyStore.get().status).toBe('idle')
    vi.unstubAllGlobals()
  })
})
