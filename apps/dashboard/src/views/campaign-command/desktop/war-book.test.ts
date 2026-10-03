import { describe, expect, it } from 'vitest'
import { coverageMarkets, instrumentOf, lifecycleSteps, pct } from './war-book'

const book = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'x', status: 'active', archived: false, created_at: '2026-09-30T12:00:00Z', updated_at: null, source: { kind: 'filters' },
  targets: { total: 100, ready: 10, planned: 0, held: 7, other: 0, held_by_reason: {} },
  sends: { sellers_dispatched: 80, sellers_delivered: 72, last_sent_at: null, sent_today: 5, truncated: false },
  replies: { sellers_replied: 6, sellers_asked_to_stop: 1, buckets: {}, latest_reply_at: null, truncated: false },
  ...over,
}) as never

describe('campaign book', () => {
  it('rates only over real denominators; unknown stays null', () => {
    const i = instrumentOf(book())
    expect(i.deliveryRate).toBeCloseTo(0.9)
    expect(i.replyRate).toBeCloseTo(6 / 72)
    expect(i.filtered).toBeNull() // only the intel read carries it
    expect(i.health).toBe('ok')
    const none = instrumentOf(book({ sends: null, replies: null }))
    expect(none.sent).toBeNull()
    expect(none.deliveryRate).toBeNull()
    expect(none.health).toBe('neutral')
    expect(pct(null)).toBe('—')
  })

  it('flags poor delivery as at risk once there is volume', () => {
    const i = instrumentOf(book({ sends: { sellers_dispatched: 100, sellers_delivered: 60, last_sent_at: null, sent_today: 0, truncated: false } }))
    expect(i.health).toBe('crit')
  })

  it('lifecycle marks the current stage and never paints attention red', () => {
    const steps = lifecycleSteps('scheduled', { key: 'missed_schedule', label: 'Missed schedule', tone: 'attn' } as never, null)
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'waiting', 'idle', 'idle'])
    const paused = lifecycleSteps('paused', { key: 'paused', label: 'Paused', tone: 'neutral' } as never, null)
    expect(paused[3].label).toBe('Paused')
  })

  it('coverage markets parse the state and drop empty markets', () => {
    expect(coverageMarkets({ 'Dallas, TX': 10, 'Nowhere': 2, 'Empty, MN': 0 })).toEqual([
      { market: 'Dallas, TX', state: 'TX', targets: 10 },
      { market: 'Nowhere', state: null, targets: 2 },
    ])
  })
})
