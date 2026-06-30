import { describe, expect, it } from 'vitest'
import { applyDeckRanking } from '../../src/views/map/useLiveActivityDeck'
import { enrichActivityEvent } from '../../src/views/map/live-activity-engine'
import type { CommandMapActivityEvent } from '../../src/views/map/commandMapLiveActivity'

const makeEvent = (overrides: Partial<CommandMapActivityEvent> & { id: string; type: CommandMapActivityEvent['type'] }): ReturnType<typeof enrichActivityEvent> => {
  const base: CommandMapActivityEvent = {
    priority: 'normal',
    title: 'Test',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  return enrichActivityEvent(base, 'live', 'test')
}

describe('live activity deck ranking', () => {
  it('demotes acknowledged opt-out events below fresh replies', () => {
    const reply = makeEvent({ id: 'reply-1', type: 'new_reply', priority: 'hot', threadKey: 't1' })
    const dnc = makeEvent({ id: 'dnc-1', type: 'opt_out', priority: 'critical', threadKey: 't2' })
    const ranked = applyDeckRanking([dnc, reply], new Set(['dnc-1']), new Set())
    expect(ranked[0].type).toBe('new_reply')
  })

  it('boosts pinned events within comparable priority band', () => {
    const sent = makeEvent({ id: 'sent-1', type: 'message_sent', threadKey: 't1' })
    const delivered = makeEvent({ id: 'delivered-1', type: 'message_delivered', threadKey: 't2' })
    const ranked = applyDeckRanking([delivered, sent], new Set(), new Set(['sent-1']))
    expect(ranked[0].id).toBe('sent-1')
  })
})