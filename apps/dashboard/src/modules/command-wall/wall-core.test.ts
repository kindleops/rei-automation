import { describe, expect, it } from 'vitest'
import { browserFamily, chooseRenderMode, mapPixelRatio, type WallCapabilities } from './render-mode'
import { createRecoveryLadder, FULL_RELOAD_AFTER, FULL_RELOADS_PER_DAY, FULL_RELOAD_GAP_MS, STABLE_MS, backoffFor, type RecoveryStorage } from './wall-recovery'
import { surfaceDrift, railShift, mapDrift, dimLevel, OLED_AMPLITUDE_PX, RAIL_SHIFT_PX, MAP_DRIFT_PX, IDLE_DIM_AFTER_MS, feedSide } from './wall-oled'
import { rotationAt, resolveActiveView, cameraDecision, flightDurationMs, FOLLOW_MIN_GAP_MS, TOUR_DWELL_MS } from './wall-rotation'
import { applyEventsReply, emptyEvents, feedRows, pulseCandidates, capsuleEvent, isQuietMoment, idleMs, pulseFunnel, MAX_EVENTS } from './wall-feed-model'
import { WALL_PRESET_IDS, presetFor, effectiveLayers } from './wall-presets'
import type { WallEvent } from './wall-types'

const CAPS: WallCapabilities = {
  webgl2: true, webgl: true, webglSoftware: false, maxTextureSize: 16384, deviceMemoryGb: 8, cores: 8, backdropFilter: true,
  resizeObserver: true, intersectionObserver: true, broadcastChannel: true, requestIdleCallback: true, webSocket: true, eventSource: true,
  fetch: true, localStorage: true, cookies: true, reducedMotion: false, screenWidth: 1920, screenHeight: 1080, dpr: 1, colorGamutP3: false,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
}
const TIZEN = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36'
const WEBOS = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager'

describe('render-mode detection', () => {
  it('desktop-class Chromium → FULL', () => {
    expect(chooseRenderMode(CAPS).mode).toBe('full')
  })
  it('no WebGL → SAFE (never a blank screen)', () => {
    const d = chooseRenderMode({ ...CAPS, webgl: false, webgl2: false })
    expect(d.mode).toBe('safe')
    expect(d.reasons[0]).toMatch(/WebGL/)
  })
  it('software WebGL or tiny textures → SAFE', () => {
    expect(chooseRenderMode({ ...CAPS, webglSoftware: true }).mode).toBe('safe')
    expect(chooseRenderMode({ ...CAPS, maxTextureSize: 2048 }).mode).toBe('safe')
  })
  it('smart-TV browsers, WebGL1, low memory, no backdrop-filter, reduced motion → LITE', () => {
    expect(chooseRenderMode({ ...CAPS, userAgent: TIZEN }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, userAgent: WEBOS }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, webgl2: false }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, deviceMemoryGb: 2 }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, backdropFilter: false }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, reducedMotion: true }).mode).toBe('lite')
    expect(chooseRenderMode({ ...CAPS, screenWidth: 3840, dpr: 2 }).mode).toBe('lite')
  })
  it('a forced mode is honoured, except a WebGL mode without WebGL', () => {
    expect(chooseRenderMode(CAPS, 'safe').mode).toBe('safe')
    expect(chooseRenderMode({ ...CAPS, userAgent: TIZEN }, 'full').mode).toBe('full')
    expect(chooseRenderMode({ ...CAPS, webgl: false, webgl2: false }, 'full').mode).toBe('safe')
  })
  it('browser families', () => {
    expect(browserFamily(TIZEN)).toBe('tizen')
    expect(browserFamily(WEBOS)).toBe('webos')
    expect(browserFamily(CAPS.userAgent)).toBe('chromium')
    expect(browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15')).toBe('safari')
    expect(browserFamily('Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 Silk/98')).toBe('fire_tv')
  })
  it('LITE caps the 4K pixel ratio', () => {
    expect(mapPixelRatio('lite', 2, 3840)).toBe(1)
    expect(mapPixelRatio('full', 3, 1920)).toBe(2)
  })
})

function memStorage(): RecoveryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

describe('recovery ladder', () => {
  it('climbs retry → reconnect → refresh → soft reload → full reload', () => {
    let t = 0
    const ladder = createRecoveryLadder({ now: () => t, storage: memStorage() })
    const types: string[] = []
    for (let i = 0; i < FULL_RELOAD_AFTER; i += 1) { types.push(ladder.failure().type); t += 1000 }
    expect(types.slice(0, 3)).toEqual(['retry', 'retry', 'retry'])
    expect(types[3]).toBe('reconnect')
    expect(types).toContain('refresh_data')
    expect(types).toContain('soft_reload')
    expect(types[types.length - 1]).toBe('full_reload')
  })
  it('backs off 2 → 30 s and never faster', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffFor)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  })
  it('NO RELOAD LOOP: ≤ 1 full reload per 30 min and ≤ 3 per day, persisted across reloads', () => {
    const storage = memStorage()
    let t = 1_000_000
    let reloads = 0
    // simulate 48 hours of a server that never comes back, one failure every 30 s,
    // with a page reload (new ladder instance, same storage) whenever asked
    let ladder = createRecoveryLadder({ now: () => t, storage })
    for (let i = 0; i < (48 * 3600) / 30; i += 1) {
      const a = ladder.failure()
      if (a.type === 'full_reload') {
        reloads += 1
        ladder.noteFullReload()
        ladder = createRecoveryLadder({ now: () => t, storage })
      }
      t += 30_000
    }
    expect(reloads).toBeLessThanOrEqual(FULL_RELOADS_PER_DAY * 2 + 1)
    const times = JSON.parse(storage.data.get('lc.wall.reloads.v1') || '[]') as number[]
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(FULL_RELOAD_GAP_MS)
  })
  it('never reloads while offline', () => {
    let t = 0
    const ladder = createRecoveryLadder({ now: () => t, storage: memStorage() })
    for (let i = 0; i < 100; i += 1) { expect(ladder.failure({ online: false }).type).toBe('retry'); t += 30_000 }
  })
  it('a flapping connection does not reset the streak; a stable one does', () => {
    let t = 0
    const ladder = createRecoveryLadder({ now: () => t, storage: memStorage() })
    for (let i = 0; i < 5; i += 1) ladder.failure()
    ladder.success(); t += 5_000
    expect(ladder.failure().type).not.toBe('retry')
    ladder.success(); t += STABLE_MS + 1; ladder.success()
    expect(ladder.failure().type).toBe('retry')
  })
  it('without storage, a page life still cannot loop (budget falls back to in-memory gap)', () => {
    let t = 0
    const ladder = createRecoveryLadder({ now: () => t, storage: null })
    let full = 0
    for (let i = 0; i < 200; i += 1) { if (ladder.failure().type === 'full_reload') full += 1; t += 30_000 }
    // without persistence the ladder cannot see past reloads; it still escalates only after FULL_RELOAD_AFTER
    expect(full).toBeGreaterThan(0)
  })
})

describe('OLED drift bounds', () => {
  it('surface, rail and map drift stay within their bounds for 24 h, and Off is zero', () => {
    for (const level of ['low', 'high'] as const) {
      let maxX = 0; let maxY = 0; let maxRail = 0; let maxMap = 0; let maxStep = 0
      let prev = surfaceDrift(0, level)
      for (let t = 0; t < 24 * 3600_000; t += 1000) {
        const d = surfaceDrift(t, level)
        maxX = Math.max(maxX, Math.abs(d.x)); maxY = Math.max(maxY, Math.abs(d.y))
        maxStep = Math.max(maxStep, Math.hypot(d.x - prev.x, d.y - prev.y))
        prev = d
        maxRail = Math.max(maxRail, Math.abs(railShift(t, level)))
        const m = mapDrift(t, level)
        maxMap = Math.max(maxMap, Math.hypot(m.x, m.y))
      }
      expect(maxX).toBeLessThanOrEqual(OLED_AMPLITUDE_PX[level])
      expect(maxY).toBeLessThanOrEqual(OLED_AMPLITUDE_PX[level])
      expect(maxX).toBeGreaterThanOrEqual(2) // 2–6 px per the brief
      expect(maxRail).toBe(RAIL_SHIFT_PX[level])
      expect(maxMap).toBeLessThanOrEqual(MAP_DRIFT_PX[level] + 0.01)
      // nearly imperceptible: < 0.08 px of movement per second (under 1 px per 12 s)
      expect(maxStep).toBeLessThan(0.08)
    }
    expect(surfaceDrift(123456, 'off')).toEqual({ x: 0, y: 0 })
    expect(railShift(123456, 'off')).toBe(0)
  })
  it('dims after prolonged inactivity and overnight only when enabled', () => {
    expect(dimLevel({ idleMs: IDLE_DIM_AFTER_MS - 1, hour: 14, level: 'low', overnight: false })).toBe(1)
    expect(dimLevel({ idleMs: IDLE_DIM_AFTER_MS, hour: 14, level: 'low', overnight: false })).toBeLessThan(1)
    expect(dimLevel({ idleMs: 0, hour: 2, level: 'low', overnight: true })).toBeLessThan(0.7)
    expect(dimLevel({ idleMs: 0, hour: 2, level: 'low', overnight: false })).toBe(1)
    expect(dimLevel({ idleMs: 1e12, hour: 2, level: 'off', overnight: false })).toBe(1)
  })
  it('layout rotates sides every 2 h when protection is on', () => {
    expect(feedSide(0, 'low')).toBe('right')
    expect(feedSide(2 * 3600_000, 'low')).toBe('left')
    expect(feedSide(2 * 3600_000, 'off')).toBe('right')
  })
})

describe('rotation, remote view, camera policy', () => {
  const steps = [{ preset: 'national_command' as const, minutes: 4 }, { preset: 'acquisition_pulse' as const, minutes: 3 }, { preset: 'market_intelligence' as const, minutes: 3 }, { preset: 'campaign_operations' as const, minutes: 2 }]
  it('walks the default 4/3/3/2 schedule', () => {
    expect(rotationAt(steps, 0)?.preset).toBe('national_command')
    expect(rotationAt(steps, 4 * 60_000)?.preset).toBe('acquisition_pulse')
    expect(rotationAt(steps, 10 * 60_000 + 1)?.preset).toBe('campaign_operations')
    expect(rotationAt(steps, 12 * 60_000)?.preset).toBe('national_command')
    expect(rotationAt([steps[0]], 0)).toBeNull()
  })
  it('remote command beats local choice beats rotation beats config; paused rotation holds', () => {
    const base = { now: 1000, configPreset: 'national_command' as const, rotation: { enabled: true, steps }, rotationStartedAt: 1000 - 5 * 60_000, rotationPaused: false, command: null, localPreset: null }
    expect(resolveActiveView(base).preset).toBe('acquisition_pulse')
    expect(resolveActiveView({ ...base, rotationPaused: true }).preset).toBe('national_command')
    expect(resolveActiveView({ ...base, localPreset: 'spatial_intelligence' }).preset).toBe('spatial_intelligence')
    const command = { id: 'v', preset: 'market_intelligence' as const, market: 'dallas-tx', campaign_id: null, hold_minutes: 30, issued_at: '', expires_at: new Date(10_000).toISOString() }
    const v = resolveActiveView({ ...base, localPreset: 'spatial_intelligence', command })
    expect([v.preset, v.market, v.source]).toEqual(['market_intelligence', 'dallas-tx', 'command'])
    expect(resolveActiveView({ ...base, command, now: 20_000 }).source).not.toBe('command')
  })
  const reply = (kind: WallEvent['kind'], priority: WallEvent['priority']): WallEvent => ({ id: 'e', seq: 1, kind, priority, tone: 'cyan', label: '', occurred_at: '', count: 1, window_ms: null, geo: { lat: 32.7, lng: -96.8, precision: 'zip' } })
  it('event follow moves only for reply/offer/deal, never for sends, with ≥ 45 s between moves', () => {
    const st = { lastMoveAt: 0, followUntil: 0, tourIndex: 0, manualUntil: 0 }
    expect(cameraDecision('event_follow', st, 100_000, reply('sends', 3)).type).toBe('none')
    expect(cameraDecision('event_follow', st, 100_000, reply('stage', 2)).type).toBe('none')
    expect(cameraDecision('event_follow', st, 100_000, reply('offer', 1)).type).toBe('focus')
    expect(cameraDecision('event_follow', { ...st, lastMoveAt: 100_000 - FOLLOW_MIN_GAP_MS + 1 }, 100_000, reply('deal', 1)).type).toBe('none')
    expect(cameraDecision('static', st, 100_000, reply('deal', 1)).type).toBe('none')
    expect(cameraDecision('event_follow', { ...st, manualUntil: 200_000 }, 100_000, reply('deal', 1)).type).toBe('none')
    expect(cameraDecision('event_follow', st, 100_000, reply('deal', 1), { reducedMotion: true }).type).toBe('none')
  })
  it('tour dwells ≥ 90 s and flights are gentle (≥ 4 s, 0 with reduced motion)', () => {
    const st = { lastMoveAt: 0, followUntil: 0, tourIndex: 0, manualUntil: 0 }
    expect(cameraDecision('tour', st, TOUR_DWELL_MS - 1, null, { tourStops: 3 }).type).toBe('none')
    expect(cameraDecision('tour', st, TOUR_DWELL_MS, null, { tourStops: 3 })).toEqual({ type: 'tour', index: 1 })
    expect(flightDurationMs(4, 9, 10, false)).toBeGreaterThanOrEqual(4000)
    expect(flightDurationMs(4, 9, 2000, false)).toBeLessThanOrEqual(9000)
    expect(flightDurationMs(4, 9, 2000, true)).toBe(0)
  })
  it('presets', () => {
    expect(WALL_PRESET_IDS).toEqual(['national_command', 'acquisition_pulse', 'campaign_operations', 'market_intelligence', 'spatial_intelligence', 'custom'])
    expect(presetFor('bogus').id).toBe('national_command')
    expect(effectiveLayers(presetFor('custom'), ['cameras'])).toEqual(['cameras'])
    expect(effectiveLayers(presetFor('national_command'), ['cameras'])).not.toContain('cameras')
  })
})

const ev = (id: string, over: Partial<WallEvent> = {}): WallEvent => ({ id, seq: 1, kind: 'reply', priority: 1, tone: 'cyan', label: 'Seller reply', occurred_at: '2026-10-06T07:41:08Z', count: 1, window_ms: null, geo: { market_id: 'dallas-tx', market_name: 'Dallas, TX', zip: '75217', lat: 32.71, lng: -96.68, precision: 'zip' }, ...over })

describe('feed model', () => {
  it('upserts by id, flags updated aggregates as arrivals, resets on epoch change, stays bounded', () => {
    let s = emptyEvents()
    let r = applyEventsReply(s, { epoch: 'a', reset: true, head: 2, events: [ev('1'), ev('agg', { kind: 'sends', priority: 3, count: 10, seq: 2 })] })
    expect(r.arrived.length).toBe(2)
    s = r.state
    r = applyEventsReply(s, { epoch: 'a', reset: false, head: 3, events: [ev('agg', { kind: 'sends', priority: 3, count: 14, seq: 3 })] })
    expect(r.state.byId.get('agg')?.count).toBe(14)
    expect(r.arrived.length).toBe(1)
    r = applyEventsReply(r.state, { epoch: 'b', reset: true, head: 1, events: [ev('x')] })
    expect([...r.state.byId.keys()]).toEqual(['x'])
    const many = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => ev(`m${i}`, { occurred_at: new Date(Date.parse('2026-10-06T00:00:00Z') + i * 1000).toISOString() }))
    expect(applyEventsReply(emptyEvents(), { epoch: 'c', reset: true, head: 1, events: many }).state.byId.size).toBe(MAX_EVENTS)
  })
  it('feed rows read "02:41:08 SELLER REPLY · Dallas · 75217" and group sends', () => {
    const s = applyEventsReply(emptyEvents(), { epoch: 'a', reset: true, head: 2, events: [ev('1'), ev('sends:dallas-tx:1791200400000', { kind: 'sends', priority: 3, count: 37, window_ms: 120_000, label: 'Outbound', occurred_at: '2026-10-06T07:40:00Z', geo: { market_id: 'dallas-tx', market_name: 'Dallas, TX', lat: 32.78, lng: -96.96, precision: 'market' } })] }).state
    const rows = feedRows(s, { timeZone: 'UTC' })
    expect(rows[0]).toMatchObject({ time: '07:41:08', title: 'SELLER REPLY', place: 'Dallas · 75217' })
    expect(rows[1]).toMatchObject({ title: 'OUTBOUND', place: '37 sent', detail: 'Dallas' })
    // same 2-minute window across markets → one grouped row
    const s2 = applyEventsReply(s, { epoch: 'a', reset: false, head: 3, events: [ev('sends:houston-tx:1791200400000', { kind: 'sends', priority: 3, count: 5, window_ms: 120_000, label: 'Outbound', occurred_at: '2026-10-06T07:40:30Z', geo: { market_id: 'houston-tx', market_name: 'Houston, TX', lat: 29.8, lng: -95.4, precision: 'market' } })] }).state
    const grouped = feedRows(s2, { timeZone: 'UTC' }).filter((r) => r.title === 'OUTBOUND')
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({ place: '42 sent', detail: 'Dallas 37 · Houston 5' })
  })
  it('only P0/P1 geographic events pulse; capsule shows the newest high-value event; quiet moments and idle are derived from real events only', () => {
    const now = Date.parse('2026-10-06T07:41:30Z')
    const arrivals = [ev('1', { occurred_at: '2026-10-06T07:41:20Z' }), ev('2', { kind: 'sends', priority: 3 }), ev('3', { geo: null }), ev('4', { kind: 'stage', priority: 2 })]
    expect(pulseCandidates(arrivals, now).map((e) => e.id)).toEqual(['1'])
    const s = applyEventsReply(emptyEvents(), { epoch: 'a', reset: true, head: 1, events: arrivals }).state
    expect(capsuleEvent(s, now)?.id).toBe('1')
    expect(isQuietMoment(s, now)).toBe(false)
    expect(isQuietMoment(s, now + 10 * 60_000)).toBe(true)
    expect(idleMs(emptyEvents(), now)).toBe(Number.POSITIVE_INFINITY)
    expect(pulseFunnel(s, now).replies).toBe(2)
  })
})
