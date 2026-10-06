import { describe, expect, it } from 'vitest'
import { createWallChannel, EVENTS_MS, STATE_MS, HEARTBEAT_MS } from './wall-channel'
import { WallHttpError, type WallApi, type WallEndpoint } from './wall-api'
import { createRecoveryLadder } from './wall-recovery'
import type { WallSession } from './wall-types'

/** Deterministic timer host: advance(ms) fires due callbacks in order. */
function fakeTimers() {
  let t = 0
  let seq = 0
  const q = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    timers: {
      setTimeout: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id },
      clearTimeout: (h: unknown) => { q.delete(h as number) },
    },
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const next = [...q.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        q.delete(next[0])
        t = next[1].at
        next[1].fn()
        for (let i = 0; i < 6; i += 1) await Promise.resolve()
      }
      t = end
    },
    pending: () => q.size,
  }
}

const SESSION: WallSession = { id: 'cwd_1', name: 'Living Room TV', config_version: 1, view_command: null, token_expires_at: null, config: { preset: 'national_command', theme: 'dark', privacy_mode: 'privacy', oled_protection: 'low', camera_mode: 'static', audio: 'off', show_feed: true, overnight_low_light: false, rotation: { enabled: false, steps: [] }, layers: null, watched_markets: [], map_view: null } }

function fakeApi({ fail = () => false }: { fail?: (ep: WallEndpoint) => false | WallHttpError } = {}) {
  const counts: Record<WallEndpoint, number> = { pair: 0, session: 0, state: 0, events: 0, heartbeat: 0, layers: 0 }
  const hit = async <T,>(ep: WallEndpoint, value: T): Promise<T> => {
    counts[ep] += 1
    const f = fail(ep)
    if (f) throw f
    return value
  }
  let head = 0
  const api: WallApi = {
    pairStart: () => Promise.reject(new Error('n/a')),
    pairPoll: () => Promise.reject(new Error('n/a')),
    session: () => hit('session', { display: SESSION, server_time: '' }),
    state: () => hit('state', { ok: true, generated_at: 'x' } as never),
    events: () => { head += 1; return hit('events', { ok: true, epoch: 'e1', reset: false, head, events: [{ id: `ev${head}`, seq: head, kind: 'reply', priority: 1, tone: 'cyan', label: 'Seller reply', occurred_at: new Date(head * 1000).toISOString(), count: 1, window_ms: null, geo: null }], status: { state: 'live', last_ok_at: null, stale_ms: null, projector_lag_ms: null, tick_ms: 15000 }, config_version: 1, server_time: '' } as never) },
    heartbeat: () => hit('heartbeat', { display: SESSION, rotated: false }),
    layers: () => hit('layers', {}),
    stats: () => ({ ...counts }),
  }
  return { api, counts }
}

describe('wall channel — one channel, bounded request rate', () => {
  it(`steady state is ~7 requests/min/display (events ${60_000 / EVENTS_MS}, state ${60_000 / STATE_MS}, heartbeat ${60_000 / HEARTBEAT_MS})`, async () => {
    const ft = fakeTimers()
    const { api, counts } = fakeApi()
    const ch = createWallChannel({ api, now: ft.now, timers: ft.timers, online: () => true })
    await ch.start()
    await ft.advance(5_000) // warm-up: initial session/state/events/heartbeat
    const base = { ...counts }
    await ft.advance(60 * 60_000)
    const perMin = (k: WallEndpoint) => (counts[k] - base[k]) / 60
    expect(perMin('events')).toBeCloseTo(4, 0)
    expect(perMin('state')).toBeCloseTo(2, 0)
    expect(perMin('heartbeat')).toBeCloseTo(1, 0)
    const total = (['events', 'state', 'heartbeat', 'session', 'layers', 'pair'] as WallEndpoint[]).reduce((s, k) => s + counts[k] - base[k], 0) / 60
    expect(total).toBeLessThanOrEqual(7.2)
    // no timer or listener growth over an hour
    expect(ft.pending()).toBeLessThanOrEqual(3)
    expect(ch._debug().listeners).toBe(0)
    expect(ch.getSnapshot().events.byId.size).toBeLessThanOrEqual(240)
    ch.stop()
  })

  it('a hidden page makes zero requests; resume catches up immediately', async () => {
    const ft = fakeTimers()
    const { api, counts } = fakeApi()
    const ch = createWallChannel({ api, now: ft.now, timers: ft.timers })
    await ch.start()
    await ft.advance(5_000)
    ch.pause()
    const before = { ...counts }
    await ft.advance(30 * 60_000)
    expect(counts).toEqual(before)
    ch.resume()
    await ft.advance(2_000)
    expect(counts.events).toBe(before.events + 1)
    expect(counts.state).toBe(before.state + 1)
    ch.stop()
  })

  it('an unpaired / revoked credential stops the channel (no retry storm) and reports unpaired', async () => {
    const ft = fakeTimers()
    let revoked = false
    const { api, counts } = fakeApi({ fail: () => (revoked ? new WallHttpError(401, 'display_revoked') : false) })
    const ch = createWallChannel({ api, now: ft.now, timers: ft.timers })
    await ch.start()
    await ft.advance(5_000)
    revoked = true
    await ft.advance(20_000)
    expect(ch.getSnapshot().unpaired).toBe(true)
    const after = counts.events + counts.state + counts.heartbeat
    await ft.advance(30 * 60_000)
    expect(counts.events + counts.state + counts.heartbeat).toBe(after)
  })

  it('server outage: keeps the last data, backs off, and never asks for a reload while offline', async () => {
    const ft = fakeTimers()
    let down = false
    const { api, counts } = fakeApi({ fail: () => (down ? new WallHttpError(0, 'network') : false) })
    let full = 0
    const ch = createWallChannel({ api, now: ft.now, timers: ft.timers, online: () => !down, ladder: createRecoveryLadder({ now: ft.now }), onFullReload: () => { full += 1 } })
    await ch.start()
    await ft.advance(20_000)
    const kept = ch.getSnapshot().events.byId.size
    expect(kept).toBeGreaterThan(0)
    down = true
    const before = counts.events
    await ft.advance(60 * 60_000)
    expect(full).toBe(0)
    expect(ch.getSnapshot().connection).toBe('offline')
    expect(ch.getSnapshot().events.byId.size).toBe(kept)
    // backoff caps at 30 s → ≤ 2 event attempts per minute while down
    expect((counts.events - before) / 60).toBeLessThanOrEqual(2.1)
    down = false
    ch.resume()
    await ft.advance(EVENTS_MS)
    expect(ch.getSnapshot().connection).toBe('live')
    ch.stop()
  })

  it('rate-limited responses are honoured with the server retry-after, not hammered', async () => {
    const ft = fakeTimers()
    let limited = true
    const { api, counts } = fakeApi({ fail: (ep) => (limited && ep === 'events' ? new WallHttpError(429, 'rate_limited', 60_000) : false) })
    const ch = createWallChannel({ api, now: ft.now, timers: ft.timers })
    await ch.start()
    await ft.advance(5 * 60_000)
    expect(counts.events).toBeLessThanOrEqual(6)
    limited = false
    ch.stop()
  })
})
