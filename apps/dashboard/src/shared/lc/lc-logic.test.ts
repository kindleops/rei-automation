import { describe, expect, it } from 'vitest'
import { groupActivity, type LCActivityEvent } from './activity-model'
import { cx } from './cx'
import { LC_STATES } from './states-model'

const ev = (id: string, at: number, groupKey?: string): LCActivityEvent => ({ id, at, title: id, groupKey, groupNoun: 'targets queued' })

describe('groupActivity — a burst reads as one line, not a hundred', () => {
  it('collapses same-key events inside the window into one group, newest first', () => {
    const out = groupActivity([ev('a', 1000, 'q'), ev('b', 3000, 'q'), ev('c', 2000, 'q')], 60_000)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('group')
    if (out[0].kind === 'group') {
      expect(out[0].events.map((e) => e.id)).toEqual(['b', 'c', 'a'])
      expect(out[0].noun).toBe('targets queued')
    }
  })
  it('does not merge across a different event in between', () => {
    const out = groupActivity([ev('a', 5000, 'q'), ev('x', 4000), ev('b', 3000, 'q')], 60_000)
    expect(out.map((e) => e.kind)).toEqual(['one', 'one', 'one'])
  })
  it('splits a burst when the gap exceeds the window', () => {
    const out = groupActivity([ev('a', 100_000, 'q'), ev('b', 99_000, 'q'), ev('c', 10_000, 'q')], 5_000)
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('group')
    expect(out[1].kind).toBe('one')
  })
  it('never groups events without a key', () => {
    expect(groupActivity([ev('a', 2), ev('b', 1)], 60_000)).toHaveLength(2)
  })
})

describe('state language', () => {
  it('waiting states are calm, never failures', () => {
    for (const k of ['waiting_seller', 'waiting_buyer', 'waiting_title', 'waiting_provider'] as const) {
      expect(LC_STATES[k].tone).toBe('neutral')
      expect(LC_STATES[k].quiet).toBe(true)
    }
  })
  it('system handling is calm and reads as the machine, not attention', () => {
    expect(LC_STATES.system_handling.tone).toBe('exec')
    expect(LC_STATES.system_handling.quiet).toBe(true)
  })
  it('only true blockers are red', () => {
    const red = Object.entries(LC_STATES).filter(([, v]) => v.tone === 'crit').map(([k]) => k).sort()
    expect(red).toEqual(['blocked', 'failed', 'overdue'])
  })
})

describe('cx', () => {
  it('joins truthy parts only', () => {
    expect(cx('a', false, null, undefined, 0, 'b')).toBe('a b')
    expect(cx()).toBe('')
  })
})
