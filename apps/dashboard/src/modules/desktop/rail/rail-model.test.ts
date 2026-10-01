import { describe, expect, it } from 'vitest'
import { compactCount, machineState, nextTransient, restingFor, runtimeHealth, type ShellEvent, type ShellMetrics, type ShellRuntime } from './rail-model'

const ev = (id: string, over: Partial<ShellEvent> = {}): ShellEvent => ({
  id, app: '/queue', kind: 'delivered', transient: 'success', priority: 4, occurred_at: '2026-10-01T15:00:00Z', text: 'Delivered', ...over,
})

const metrics = (over: Partial<ShellMetrics> = {}): ShellMetrics => ({
  inbox: { awaiting: 12, needs_review: 2 },
  email: null,
  queue: { today_remaining: 1280, approval: 3, processing: 0, sent_today: 40, delivered_today: 38, failed_today: 2, status: 'healthy', latest_sent_at: null },
  campaigns: { active: 4, paused: 1, scheduled: 0, attention: 1 },
  pipeline: { live: 84, need_you: 5, system: 70, moved_today: 3, blocked: 1 },
  workflow: { live_runs: 6, human_holds: 2, events_today: 40 },
  closing: { active: 0, needs_you: 0, blocked: 0 },
  ...over,
})

const rt = (over: Partial<ShellRuntime> = {}): ShellRuntime => ({
  key: 'queue', name: 'Queue processor', owner_href: '/queue', status: 'on', heartbeat_at: '2026-10-01T15:00:00Z',
  heartbeat_state: 'beating', cadence: 'every minute', last_run_at: null, runs_24h: null, needs_you: 0, in_flight: 0, ...over,
})

describe('compactCount', () => {
  it('is precise below 10K and compact above', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(9999)).toBe('9,999')
    expect(compactCount(18_540)).toBe('18.5K')
    expect(compactCount(Number.NaN)).toBe('—')
  })
})

describe('restingFor', () => {
  it('shows one stable number per app from real metrics', () => {
    const m = metrics()
    expect(restingFor('/inbox', m)?.value).toBe(12)
    expect(restingFor('/queue', m)?.value).toBe(1280)
    expect(restingFor('/pipeline', m)?.value).toBe(84)
  })
  it('shows nothing when the source is unavailable — never a fabricated zero', () => {
    expect(restingFor('/inbox', metrics({ inbox: null }))).toBeNull()
    expect(restingFor('/inbox', null)).toBeNull()
    expect(restingFor('/map', metrics())).toBeNull()
  })
})

describe('nextTransient', () => {
  it('returns nothing for an empty queue', () => {
    expect(nextTransient([])).toBeNull()
  })
  it('puts a failure ahead of routine execution', () => {
    const next = nextTransient([ev('a'), ev('b', { kind: 'transport_failed', transient: 'failure', priority: 1 })])!
    expect(next.show.transient).toBe('failure')
    expect([...next.consumed]).toEqual(['b'])
  })
  it('coalesces a burst of sends into one readout', () => {
    const next = nextTransient([ev('a'), ev('b'), ev('c')])!
    expect(next.show.display).toBe('3 sent')
    expect(next.consumed.size).toBe(3)
  })
  it('sums refills into one +N', () => {
    const next = nextTransient([
      ev('a', { app: '/campaign-command', kind: 'queue_plan', transient: 'refill', value: 100, display: '+100' }),
      ev('b', { app: '/campaign-command', kind: 'queue_plan', transient: 'refill', value: 25, display: '+25' }),
    ])!
    expect(next.show.display).toBe('+125')
  })
  it('keeps the canonical stage transition for a single advance', () => {
    const next = nextTransient([ev('a', { app: '/pipeline', kind: 'advance', transient: 'stage', priority: 3, display: 'S2→S3' })])!
    expect(next.show.display).toBe('S2→S3')
    expect(next.show.tone).toBeDefined()
  })
})

describe('machine state', () => {
  const now = Date.parse('2026-10-01T15:02:00Z')
  it('is live when a clocked runtime beats on cadence', () => {
    expect(runtimeHealth(rt(), now)).toBe('current')
    expect(machineState({ metrics: metrics(), runtimes: [rt()] }, now).state).toBe('live')
  })
  it('is degraded and says why when a heartbeat is late', () => {
    const late = rt({ heartbeat_at: '2026-10-01T14:50:00Z' })
    expect(runtimeHealth(late, now)).toBe('delayed')
    const m = machineState({ metrics: metrics(), runtimes: [late] }, now)
    expect(m.state).toBe('degraded')
    expect(m.reason).toContain('Queue processor')
  })
  it('is unknown before the first read — not "live"', () => {
    expect(machineState(null, now).state).toBe('unknown')
  })
})

describe('which machine events make a sound', () => {
  it('a routine send is silent; a seller reply and a hold are not', async () => {
    const { cueForEvent } = await import('./rail-model')
    expect(cueForEvent(ev('d'))).toBeNull()
    expect(cueForEvent(ev('r', { app: '/inbox', kind: 'reply_received', transient: 'typing', priority: 2 }))?.cue).toBe('ready')
    expect(cueForEvent(ev('h', { app: '/inbox', kind: 'human_review', transient: 'attention', priority: 1 }))?.cue).toBe('attention')
  })
  it('a batch carrier failure is a warning; a conversation send failure is an error', async () => {
    const { cueForEvent } = await import('./rail-model')
    expect(cueForEvent(ev('q', { kind: 'carrier_failed', transient: 'failure', priority: 1 }))?.cue).toBe('warning')
    expect(cueForEvent(ev('i', { app: '/inbox', kind: 'reply_failed', transient: 'failure', priority: 1 }))?.cue).toBe('error')
  })
  it('pipeline movement stays visual', async () => {
    const { cueForEvent } = await import('./rail-model')
    expect(cueForEvent(ev('s', { app: '/pipeline', kind: 'advance', transient: 'stage', priority: 3, display: 'S2→S3' }))).toBeNull()
  })
})
