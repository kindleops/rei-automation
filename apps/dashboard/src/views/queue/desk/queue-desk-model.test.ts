import { describe, expect, it } from 'vitest'
import { bucketOf, flowOf, holdCode, laneWindow, reasonBook, senderCapacity, zoneLanes } from './queue-desk-model'
import type { TextgridFleetNumber } from '../../../domain/queue/queue.types'

const NOW = Date.parse('2026-10-03T18:00:00Z')
const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, status, timezone: 'America/Chicago', sentAt: null, scheduledForUtc: new Date(NOW + 3_600_000).toISOString(),
  fromPhoneNumber: '+15550000001', guardReason: null, blockedReason: null, pausedReason: null, ...extra,
}) as never

describe('queue desk model', () => {
  it('buckets canonical statuses without inventing a send', () => {
    expect(bucketOf('scheduled')).toBe('upcoming')
    expect(bucketOf('sending')).toBe('inflight')
    expect(bucketOf('delivered')).toBe('done')
    expect(bucketOf('failed')).toBe('failed')
    // a parked sender hold is NOT a failure — nothing reached the provider
    expect(bucketOf('blocked_sender_ineligible')).toBe('held')
    expect(bucketOf('paused_sender_eligibility_unavailable')).toBe('held')
    expect(bucketOf('cancelled')).toBe('other')
  })

  it('flow reads the counts it is given, in pipeline order', () => {
    const f = flowOf({ scheduled: 4, queued: 3, sending: 2, sent: 9, delivered: 7, failed: 1, blocked: 5, approval: 0 })
    expect(f.main.map((n) => [n.key, n.count])).toEqual([['scheduled', 4], ['queued', 3], ['sending', 2], ['sent', 9], ['delivered', 7]])
    expect(f.branches.find((b) => b.key === 'blocked')?.count).toBe(5)
  })

  it('lanes group by recipient zone and place rows inside the window only', () => {
    const lanes = zoneLanes([
      row('a', 'scheduled'),
      row('b', 'scheduled', { timezone: 'America/New_York' }),
      row('c', 'delivered', { sentAt: new Date(NOW - 30 * 3_600_000).toISOString() }),
      row('d', 'scheduled', { timezone: '' }),
    ], NOW, laneWindow(NOW))
    expect(lanes.map((l) => l.label)).toEqual(['Eastern', 'Central', 'Zone not recorded'])
    const central = lanes[1]
    expect(central.total).toBe(2)
    expect(central.ticks).toHaveLength(1)
    expect(central.outside).toBe(1)
    expect(central.ticks[0].pos).toBeCloseTo(7 / 24, 5)
  })

  it('capacity sums only recorded caps and says how many are uncapped', () => {
    const fleet: TextgridFleetNumber[] = [
      { id: '1', phone: '+15550000001', friendlyName: 'DAL', market: 'Dallas, TX', state: 'TX', status: 'active', isActive: true, dailyCap: 800, messagesSentToday: 200, lastUsedAt: null, healthScore: 1 },
      { id: '2', phone: '+15550000002', friendlyName: 'MSP', market: 'Minneapolis, MN', state: 'MN', status: 'active', isActive: true, dailyCap: null, messagesSentToday: 10, lastUsedAt: null, healthScore: 1 },
      { id: '3', phone: '+15550000003', friendlyName: 'OFF', market: 'Miami, FL', state: 'FL', status: 'paused', isActive: false, dailyCap: 800, messagesSentToday: 0, lastUsedAt: null, healthScore: 1 },
    ]
    const c = senderCapacity(fleet, [row('a', 'scheduled'), row('b', 'delivered')])
    expect(c.cap).toBe(800)
    expect(c.sentToday).toBe(210)
    expect(c.uncapped).toBe(1)
    expect(c.inactive).toBe(1)
    expect(c.lines[0].pending).toBe(1)
    expect(c.lines[0].used).toBeCloseTo(0.25)
  })

  it('reason book separates holds (by guard reason) from failures (by cause)', () => {
    const lines = reasonBook([
      row('a', 'blocked_sender_ineligible', { guardReason: 'no_eligible_sender_for_route' }),
      row('b', 'blocked_sender_ineligible', { guardReason: 'no_eligible_sender_for_route' }),
      row('c', 'failed'),
      row('d', 'scheduled'),
    ], () => 'carrier_failure', { carrier_failure: 'Carrier failure' })
    expect(lines).toEqual([
      { code: 'no_eligible_sender_for_route', label: 'No eligible sender for the route', kind: 'hold', count: 2, sender: true },
      { code: 'carrier_failure', label: 'Carrier failure', kind: 'failure', count: 1, sender: false },
    ])
    expect(holdCode(row('x', 'paused_global_lock'))).toBe('paused_global_lock')
  })
})

describe('lane window', () => {
  it('fits the page around now and never past a week either way', async () => {
    const { laneWindowFor, laneMarks } = await import('./queue-desk-model')
    const old = { sentAt: new Date(NOW - 50 * 3_600_000).toISOString(), scheduledForUtc: '' }
    const far = { sentAt: null, scheduledForUtc: new Date(NOW + 400 * 3_600_000).toISOString() }
    const w = laneWindowFor([old, far] as never, NOW)
    expect(w.fromMs).toBeLessThanOrEqual(NOW - 50 * 3_600_000)
    expect(w.toMs).toBeLessThanOrEqual(NOW + 168 * 3_600_000 + 6 * 3_600_000)
    const marks = laneMarks(w, NOW)
    expect(marks.filter((m) => m.now)).toHaveLength(1)
    expect(marks.every((m) => m.at >= w.fromMs && m.at <= w.toMs)).toBe(true)
  })
})
