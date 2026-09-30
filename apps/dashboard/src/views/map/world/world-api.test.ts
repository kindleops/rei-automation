import { describe, expect, it } from 'vitest'
import { localClock, untilLabel, windowIsStale, windowTone, type ContactWindow } from './world-api'

const NOW = Date.parse('2026-09-29T23:30:00Z')
const w = (p: Partial<ContactWindow>): ContactWindow => ({ policy_version: 'contact_window_v1_0800_2100_local_fail_closed', window: '08:00–21:00', open: true, reason: 'inside_window', closes_at: null, next_open_at: null, ...p })

describe('world api helpers', () => {
  it('reads the wall clock in the IANA zone, never the browser offset', () => {
    const at = new Date('2026-09-29T23:30:00Z')
    expect(localClock('America/Chicago', at)).toBe('6:30 PM')
    expect(localClock('America/New_York', at)).toBe('7:30 PM')
    expect(localClock('America/Phoenix', at)).toBe('4:30 PM')
    expect(localClock('Pacific/Honolulu', at)).toBe('1:30 PM')
  })
  it('counts down to an instant', () => {
    expect(untilLabel(new Date(NOW + 2 * 3600e3 + 30 * 60e3).toISOString(), NOW)).toBe('2h 30m')
    expect(untilLabel(new Date(NOW + 42 * 60e3).toISOString(), NOW)).toBe('42m')
    expect(untilLabel(new Date(NOW + 30e3).toISOString(), NOW)).toBe('under a minute')
    expect(untilLabel(null, NOW)).toBeNull()
    expect(untilLabel('not a date', NOW)).toBeNull()
  })
  it('tones: open, closing within the hour, quiet, unknown', () => {
    expect(windowTone(null, NOW)).toBe('unknown')
    expect(windowTone(w({ open: false, reason: 'after_window', next_open_at: new Date(NOW + 9 * 3600e3).toISOString() }), NOW)).toBe('quiet')
    expect(windowTone(w({ closes_at: new Date(NOW + 3 * 3600e3).toISOString() }), NOW)).toBe('open')
    expect(windowTone(w({ closes_at: new Date(NOW + 59 * 60e3).toISOString() }), NOW)).toBe('closing')
  })
  it('a passed boundary makes the answer stale', () => {
    expect(windowIsStale(null, NOW)).toBe(false)
    expect(windowIsStale(w({ closes_at: new Date(NOW + 60e3).toISOString() }), NOW)).toBe(false)
    expect(windowIsStale(w({ closes_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(true)
    expect(windowIsStale(w({ open: false, next_open_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(true)
  })
})
