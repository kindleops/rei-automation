import { describe, expect, it } from 'vitest'
import type { PlatformEvent } from '../feed/feed-model'
import { buildTimeline, causalLinks, laneOf, nearestIndex, rangeOf, stepTo, ticksFor } from './replay-model'

const ev = (id: string, at: string, o: Partial<PlatformEvent> = {}): PlatformEvent => ({
  event_id: id, occurred_at: at, source_system: 'inbox', event_type: 'seller.replied', severity: 'info', actor: { kind: 'seller' },
  entity_refs: [], summary: id, deep_link: null, provenance: { table: 't', row_id: id, adapter: 'a' }, ...o,
})
const from = Date.parse('2026-10-01T00:00:00Z')
const to = Date.parse('2026-10-02T00:00:00Z')

describe('time machine model', () => {
  it('places events on the real time axis, oldest first, in their owning lane; empty lanes are not drawn', () => {
    const tl = buildTimeline([
      ev('w', '2026-10-01T18:00:00Z', { source_system: 'workflow', event_type: 'workflow.held' }),
      ev('r', '2026-10-01T06:00:00Z'),
      ev('n', '2026-10-01T12:00:00Z', { source_system: 'notification', event_type: 'alert.triggered' }),
    ], { from, to })
    expect(tl.nodes.map((n) => n.event.event_id)).toEqual(['r', 'n', 'w'])
    expect(tl.nodes.map((n) => n.x)).toEqual([0.25, 0.5, 0.75])
    expect(tl.lanes.map((l) => l.key)).toEqual(['inbox', 'workflow', 'alerts'])
    expect(laneOf({ source_system: 'email' })).toBe('queue')
  })

  it('draws causal arrows only from deterministic links', () => {
    const events = [
      ev('me:m1', '2026-10-01T10:00:00Z'),
      ev('wf:seller_inbound:r1', '2026-10-01T10:00:02Z', { source_system: 'workflow', event_type: 'workflow.completed', details: { source_message_id: 'm1' } }),
      ev('wf:seller_inbound:r2', '2026-10-01T11:00:00Z', { source_system: 'workflow', event_type: 'workflow.completed', details: { source_message_id: 'not-loaded' } }),
      ev('s1', '2026-10-01T10:00:01Z', { event_type: 'workflow.step', workflow_run_id: 'r9' }),
      ev('s2', '2026-10-01T10:00:03Z', { event_type: 'workflow.step', workflow_run_id: 'r9' }),
      ev('me:o1', '2026-10-01T12:00:00Z', { source_system: 'queue', event_type: 'message.sent', details: { queue_id: 'q1' } }),
      ev('me:o2', '2026-10-01T12:05:00Z', { source_system: 'queue', event_type: 'message.failed', details: { queue_id: 'q1' } }),
      ev('me:o3', '2026-10-01T12:06:00Z', { source_system: 'queue', event_type: 'message.sent', details: { queue_id: 'q2' } }),
    ]
    const links = causalLinks(events)
    expect(links).toContainEqual({ from: 'me:m1', to: 'wf:seller_inbound:r1', why: 'This run handled that reply' })
    expect(links).toContainEqual({ from: 's1', to: 's2', why: 'Same run' })
    expect(links).toContainEqual({ from: 'me:o1', to: 'me:o2', why: 'Same queue row' })
    expect(links.length).toBe(3)
  })

  it('steps event to event and scrubs to the nearest recorded event', () => {
    expect(stepTo(0, 5, -1)).toBe(0)
    expect(stepTo(3, 5, 1)).toBe(4)
    expect(stepTo(4, 5, 1)).toBe(4)
    expect(stepTo(0, 0, 1)).toBe(-1)
    const tl = buildTimeline([ev('a', '2026-10-01T02:00:00Z'), ev('b', '2026-10-01T20:00:00Z')], { from, to })
    expect(nearestIndex(tl, 0.1)).toBe(0)
    expect(nearestIndex(tl, 0.9)).toBe(1)
    expect(nearestIndex(buildTimeline([], { from, to }), 0.5)).toBe(-1)
  })

  it('ranges and axis ticks', () => {
    const now = to
    expect(rangeOf('72h', now)).toEqual({ from: now - 72 * 3600e3, to: now })
    expect(rangeOf('custom', now, { from: from + 1, to: now + 999 })).toEqual({ from: from + 1, to: now })
    expect(rangeOf('custom', now, { from: now, to: from })).toEqual({ from: now - 7 * 864e5, to: now })
    const ticks = ticksFor(from, to)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.every((t) => t.x >= 0 && t.x <= 1)).toBe(true)
  })
})
