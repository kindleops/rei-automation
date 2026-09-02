import { describe, expect, it } from 'vitest'
import {
  isMeaningful,
  mergeFragments,
  median,
  replyDeltas,
  type LeadMessage,
} from './use-lead-thread-messages'

const msg = (direction: 'inbound' | 'outbound', at: string, body: string, id = at): LeadMessage =>
  ({ id, direction, body, at })

/**
 * Fixture mirrors the real thread +15623674946, which is what exposed the
 * split-send and cadence behaviour in the first place.
 */
const REAL_THREAD: LeadMessage[] = [
  msg('outbound', '2026-08-17T19:39:36.955Z', 'Are you the owner of the retail center at 3242 N Colorado Ave?'),
  msg('inbound', '2026-08-17T20:04:12.594Z', "Hi Alex. What's your question?"),
  msg('outbound', '2026-08-17T20:43:55.452Z', 'Are you open to a proposal on the property?'),
  msg('inbound', '2026-08-17T20:59:10.274Z', 'Which one?'),
  msg('outbound', '2026-08-17T21:08:21.946Z', 'I am'),
  msg('outbound', '2026-08-17T21:09:01.684Z', 'referring to 3242 N Colorado Ave.'),
  msg('inbound', '2026-08-17T21:11:25.622Z', "No I'm not right now"),
]

describe('isMeaningful', () => {
  it('keeps ordinary inbound and delivered outbound', () => {
    expect(isMeaningful({ direction: 'inbound', message_body: 'Which one?' })).toBe(true)
    expect(isMeaningful({ direction: 'outbound', message_body: 'Hi', delivery_status: 'delivered' })).toBe(true)
  })

  it('drops empty bodies and unknown directions', () => {
    expect(isMeaningful({ direction: 'inbound', message_body: '   ' })).toBe(false)
    expect(isMeaningful({ direction: 'inbound', message_body: 'null' })).toBe(false)
    expect(isMeaningful({ direction: 'event', message_body: 'x' })).toBe(false)
  })

  it('drops drafts, receipts and system rows', () => {
    for (const kind of ['draft', 'delivery_receipt', 'system_note', 'internal']) {
      expect(isMeaningful({ direction: 'outbound', message_body: 'x', message_type: kind })).toBe(false)
    }
  })

  it('drops failed outbound — it never reached the seller', () => {
    expect(isMeaningful({ direction: 'outbound', message_body: 'x', delivery_status: 'failed' })).toBe(false)
    expect(isMeaningful({ direction: 'outbound', message_body: 'x', delivery_status: 'undelivered' })).toBe(false)
  })

  it('does not apply delivery gating to inbound, which has no delivery_status', () => {
    expect(isMeaningful({ direction: 'inbound', message_body: 'x', delivery_status: null })).toBe(true)
  })
})

describe('mergeFragments', () => {
  it('rejoins a split send and keeps the last timestamp', () => {
    const merged = mergeFragments(REAL_THREAD)
    const last = merged[merged.length - 2]
    expect(last.body).toBe('I am referring to 3242 N Colorado Ave.')
    expect(last.at).toBe('2026-08-17T21:09:01.684Z')
    expect(merged).toHaveLength(6)
  })

  it('does not merge across a direction change', () => {
    const merged = mergeFragments([
      msg('outbound', '2026-08-17T21:00:00.000Z', 'a'),
      msg('inbound', '2026-08-17T21:00:30.000Z', 'b'),
    ])
    expect(merged).toHaveLength(2)
  })

  it('does not merge same-direction sends beyond the fragment window', () => {
    const merged = mergeFragments([
      msg('outbound', '2026-08-17T21:00:00.000Z', 'a'),
      msg('outbound', '2026-08-17T21:10:00.000Z', 'b'),
    ])
    expect(merged).toHaveLength(2)
  })
})

describe('replyDeltas', () => {
  it('measures each outbound -> inbound gap once', () => {
    const deltas = replyDeltas(mergeFragments(REAL_THREAD))
    expect(deltas).toHaveLength(3)
    expect(deltas.map((d) => Math.round(d / 1000))).toEqual([1476, 915, 144])
  })

  it('counts a burst of seller replies as one measurement', () => {
    const deltas = replyDeltas([
      msg('outbound', '2026-08-17T20:00:00.000Z', 'q'),
      msg('inbound', '2026-08-17T20:05:00.000Z', 'a'),
      msg('inbound', '2026-08-17T20:05:10.000Z', 'b'),
      msg('inbound', '2026-08-17T20:05:20.000Z', 'c'),
    ])
    expect(deltas).toEqual([300_000])
  })

  it('ignores inbound with no preceding outbound', () => {
    expect(replyDeltas([msg('inbound', '2026-08-17T20:00:00.000Z', 'hello')])).toEqual([])
  })

  it('skips unparseable timestamps rather than emitting NaN', () => {
    const deltas = replyDeltas([
      msg('outbound', 'not-a-date', 'q'),
      msg('inbound', '2026-08-17T20:05:00.000Z', 'a'),
    ])
    expect(deltas.every(Number.isFinite)).toBe(true)
    expect(deltas).toEqual([])
  })
})

describe('median', () => {
  it('returns the middle value for an odd sample', () => {
    expect(median([144_000, 915_000, 1_476_000])).toBe(915_000)
  })

  it('averages the two middle values for an even sample', () => {
    expect(median([100, 200, 300, 400])).toBe(250)
  })

  it('returns null with no sample', () => {
    expect(median([])).toBeNull()
  })

  it('yields ~15m for the real thread, matching the rendered cadence', () => {
    const ms = median(replyDeltas(mergeFragments(REAL_THREAD)))
    expect(Math.round((ms as number) / 60_000)).toBe(15)
  })
})
