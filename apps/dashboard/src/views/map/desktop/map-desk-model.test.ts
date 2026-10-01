/**
 * Map Desktop 2.0 — model tests. Each one pins a truthfulness rule: what the
 * desk chrome is allowed to say, and what it must refuse to invent.
 */
import { describe, expect, it } from 'vitest'
import {
  DESK_TOOLS,
  buildSensorArray,
  clampOpacity,
  filterCapsuleLabel,
  groupTally,
  lensPillSub,
  liveSignal,
  resolveDeskPinClick,
  shareOfUniverse,
  topMarkets,
  type SensorInput,
} from './map-desk-model'

const BASE: SensorInput = {
  pins: true, everyProperty: true, filterActive: false,
  lensId: 'radar', lensLabel: 'Acquisition Radar', lensHasSource: true, lensAmbient: true,
  comps: false, market: false,
  daylight: true, localTime: true, zones: true, livingEnabled: true, buildings: true, tilted: false, vectorBuildings: true,
  relief: false, activityOn: false, streamLive: false, orbs: true,
}
const row = (groups: ReturnType<typeof buildSensorArray>, id: string) => groups.flatMap((g) => g.rows).find((r) => r.id === id)!

describe('tool rail', () => {
  it('offers exactly the real tools, in order — and never a measure tool', () => {
    expect(DESK_TOOLS.map((t) => t.id)).toEqual(['layers', 'filters', 'draw', 'live', 'appearance'])
    expect(DESK_TOOLS.some((t) => /measure|ruler/i.test(`${t.id} ${t.label}`))).toBe(false)
  })
})

describe('numbers', () => {
  it('a share of the universe needs both sides known', () => {
    expect(shareOfUniverse(18_492, 169_811)).toBe('11%')
    expect(shareOfUniverse(9_870, 169_811)).toBe('5.8%')
    expect(shareOfUniverse(84_000, 169_811)).toBe('49%')
    expect(shareOfUniverse(3, 169_811)).toBe('<0.1%')
    expect(shareOfUniverse(0, 169_811)).toBe('0%')
    expect(shareOfUniverse(169_811, 169_811)).toBe('100%')
    expect(shareOfUniverse(169_810, 169_811)).toBe('>99.9%')
    expect(shareOfUniverse(null, 169_811)).toBeNull()
    expect(shareOfUniverse(10, null)).toBeNull()
    expect(shareOfUniverse(10, 0)).toBeNull()
  })
  it('the filter capsule omits a count it does not have', () => {
    expect(filterCapsuleLabel(7, 18_492)).toBe('7 filters · 18,492 properties')
    expect(filterCapsuleLabel(1, 1)).toBe('1 filter · 1 property')
    expect(filterCapsuleLabel(3, null)).toBe('3 filters')
  })
  it('by-market split comes only from rows the server returned', () => {
    const { rows, total, markets } = topMarkets([
      { properties: { market: 'Minneapolis, MN', property_count: 600 } },
      { properties: { market: 'Dallas, TX', property_count: 300 } },
      { properties: { market: 'Minneapolis, MN', property_count: 100 } },
      { properties: { market: '', property_count: 50 } },
      { properties: { market: 'Tampa, FL', property_count: 0 } },
      { properties: null },
    ], 5)
    expect(total).toBe(1000)
    expect(markets).toBe(2)
    expect(rows).toEqual([
      { market: 'Minneapolis, MN', n: 700, share: 0.7 },
      { market: 'Dallas, TX', n: 300, share: 0.3 },
    ])
  })
  it('opacity is clamped to a visible range', () => {
    expect(clampOpacity(0)).toBe(0.2)
    expect(clampOpacity(2)).toBe(1)
    expect(clampOpacity('x', 0.8)).toBe(0.8)
  })
})

describe('live', () => {
  it('LIVE only when the stream is actually flowing', () => {
    expect(liveSignal({ streamLive: true, activityOn: false })).toBe('live')
    expect(liveSignal({ streamLive: false, activityOn: true })).toBe('connecting')
    expect(liveSignal({ streamLive: false, activityOn: false })).toBe('off')
  })
  it('the pill states properties in view, then the live window', () => {
    expect(lensPillSub({ inView: 677, loading: false, zoom: 12, activityOn: false, eventCount: 0, windowLabel: 'Today' })).toBe('677 in view')
    expect(lensPillSub({ inView: 677, loading: false, zoom: 12, activityOn: true, eventCount: 12, windowLabel: 'Today' })).toBe('677 in view · 12 events today')
    expect(lensPillSub({ inView: 677, loading: false, zoom: 12, activityOn: true, eventCount: 1, windowLabel: '1h' })).toBe('677 in view · 1 event in 1h')
    expect(lensPillSub({ inView: 0, loading: false, zoom: 6, activityOn: false, eventCount: 0, windowLabel: 'Today' })).toBe('Zoom in to see properties')
    expect(lensPillSub({ inView: null, loading: true, zoom: 6, activityOn: false, eventCount: 0, windowLabel: 'Today' })).toBe('Loading properties…')
  })
})

describe('clicking a property on the desk', () => {
  it('first click previews, the same property in PREVIEW promotes to HALF', () => {
    expect(resolveDeskPinClick({ sameProperty: false, cardState: null })).toBe('preview')
    expect(resolveDeskPinClick({ sameProperty: false, cardState: 'full' })).toBe('preview')
    expect(resolveDeskPinClick({ sameProperty: true, cardState: 'preview' })).toBe('promote')
  })
  it('never demotes a card that is already open wider', () => {
    for (const s of ['half', 'full', 'conversation'] as const) expect(resolveDeskPinClick({ sameProperty: true, cardState: s })).toBe('keep')
  })
})

describe('sensor array', () => {
  it('has the four groups, in order', () => {
    expect(buildSensorArray(BASE).map((g) => g.id)).toEqual(['properties', 'market', 'world', 'operations'])
  })
  it('no camera row while no camera source is connected (the Map does not advertise a dead sensor)', () => {
    const ids = buildSensorArray(BASE).flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).not.toContain('cameras')
    expect(JSON.stringify(buildSensorArray(BASE))).not.toMatch(/camera/i)
  })
  it('buildings are honest about imagery themes and flat views', () => {
    expect(row(buildSensorArray({ ...BASE, vectorBuildings: false }), 'buildings')).toMatchObject({ available: false, status: 'unavailable' })
    expect(row(buildSensorArray(BASE), 'buildings')).toMatchObject({ status: 'waiting' })
    expect(row(buildSensorArray({ ...BASE, tilted: true }), 'buildings')).toMatchObject({ status: 'on' })
  })
  it('dots pause (and say why) while a filter is applied', () => {
    const dots = row(buildSensorArray({ ...BASE, filterActive: true }), 'dots')
    expect(dots.status).toBe('waiting')
    expect(dots.reason).toMatch(/filter/i)
  })
  it('live activity is "live" only with the stream up', () => {
    expect(row(buildSensorArray({ ...BASE, activityOn: true, streamLive: false }), 'activity').status).toBe('waiting')
    expect(row(buildSensorArray({ ...BASE, activityOn: true, streamLive: true }), 'activity').status).toBe('live')
  })
  it('controls appear only where the layer supports them', () => {
    const g = buildSensorArray(BASE)
    expect(row(g, 'pins').supports).toEqual({ visibility: true, opacity: true, style: true, time: false })
    expect(row(g, 'comps').supports.time).toBe(true)
    expect(row(g, 'activity').supports.time).toBe(true)
    // The ambient radar glow has no style or opacity knob of its own.
    expect(row(g, 'lens').supports).toMatchObject({ opacity: false, style: false })
    expect(row(buildSensorArray({ ...BASE, lensId: 'equity', lensAmbient: false }), 'lens').supports).toMatchObject({ opacity: true, style: true })
  })
  it('Living Map off disables its layers with a reason', () => {
    const g = buildSensorArray({ ...BASE, livingEnabled: false })
    for (const id of ['daylight', 'localTime', 'zones', 'buildings']) {
      expect(row(g, id).available).toBe(false)
      expect(row(g, id).reason).toMatch(/Living Map is off/)
    }
  })
  it('tallies count only usable layers', () => {
    const world = buildSensorArray(BASE).find((g) => g.id === 'world')!
    // daylight, local time, zones, buildings (on, waiting for tilt) — relief off
    expect(groupTally(world)).toBe('4 of 5 on')
  })
})
