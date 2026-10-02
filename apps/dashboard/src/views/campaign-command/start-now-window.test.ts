import { describe, expect, it } from 'vitest'
import { startNowWindow } from './start-now-window'

const base = { send_window_start: '08:00', send_window_end: '21:00', lineage: { timezone: 'America/Chicago' } } as Parameters<typeof startNowWindow>[0]

describe('Start now — contact window check', () => {
  it('open inside the campaign zone’s hours', () => {
    expect(startNowWindow(base, new Date('2026-10-01T15:00:00Z')).state).toBe('open') // 10:00 CDT
  })
  it('closed outside them, and says the first text waits', () => {
    const r = startNowWindow(base, new Date('2026-10-02T03:30:00Z')) // 22:30 CDT
    expect(r.state).toBe('closed')
    expect(r.words).toMatch(/first text goes when hours open/)
  })
  it('multi-zone cohorts are per recipient, not guessed', () => {
    expect(startNowWindow({ ...base, lineage: { timezone: null } } as typeof base, new Date()).state).toBe('per_recipient')
  })
  it('no hours on record is unknown, not "open"', () => {
    expect(startNowWindow({ ...base, send_window_start: null }, new Date()).state).toBe('unknown')
  })
})

import { missedStartAt } from './start-now-window'

describe('missed start (no late auto-activation)', () => {
  const now = Date.parse('2026-10-01T15:00:00Z')
  it('a start older than one activation tick is missed even before the worker marks it', () => {
    expect(missedStartAt('scheduled', '2026-10-01T14:30:00Z', null, now)).toBe('2026-10-01T14:30:00Z')
    expect(missedStartAt('scheduled', '2026-10-01T14:55:00Z', null, now)).toBeNull()
  })
  it('a marked miss wins; an active campaign is never missed', () => {
    expect(missedStartAt('scheduled', '2026-10-01T14:58:00Z', '2026-10-01T14:58:00Z', now)).toBe('2026-10-01T14:58:00Z')
    expect(missedStartAt('active', '2026-10-01T10:00:00Z', null, now)).toBeNull()
  })
})
