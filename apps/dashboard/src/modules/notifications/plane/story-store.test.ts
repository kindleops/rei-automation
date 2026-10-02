import { describe, expect, it, vi } from 'vitest'

const played: Array<{ id: string; category: string }> = []
vi.mock('../../../shared/sound', () => ({ sound: { machine: { event: (e: { id: string; category: string }) => played.push(e) } } }))
vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))
vi.mock('../../desktop/objects', () => ({}))

import { voice } from './story-store'
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
