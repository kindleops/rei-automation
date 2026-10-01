import { describe, expect, it } from 'vitest'
import {
  groupActivity,
  heatField,
  homeDots,
  laneOf,
  nearestDot,
  projectAlbersUsa,
  resolveHomeMode,
  stateAbbr,
  summarizeFocus,
  systemPulses,
  money,
  type StudioActivityItem,
} from './home-command-model'
import type { FocusItem } from '../../home-signals'

const stateAt = (lng: number, lat: number) => {
  const xy = projectAlbersUsa(lng, lat)
  if (!xy) return null
  const i = nearestDot(xy[0], xy[1])
  return i == null ? null : stateAbbr(homeDots()[i].state)
}

describe('Albers USA lands real places in their own state on the dot matrix', () => {
  it.each([
    ['Minneapolis', -93.265, 44.978, 'MN'],
    ['Miami', -80.191, 25.761, 'FL'],
    ['Houston', -95.369, 29.760, 'TX'],
    ['Phoenix', -112.074, 33.448, 'AZ'],
    ['Atlanta', -84.388, 33.749, 'GA'],
    // Interior cities: a dot is ~50 km across, so a city on a state line
    // (Kansas City) can light the dot just over the border.
    ['Columbia, MO', -92.334, 38.952, 'MO'],
    ['Seattle', -122.332, 47.606, 'WA'],
    ['Denver', -104.990, 39.739, 'CO'],
    ['Anchorage', -149.900, 61.218, 'AK'],
    ['Honolulu', -157.858, 21.307, 'HI'],
  ])('%s', (_name, lng, lat, abbr) => {
    expect(stateAt(lng as number, lat as number)).toBe(abbr)
  })

  it('outside the US is not placed', () => {
    expect(projectAlbersUsa(-0.1278, 51.5074)).toBeNull()
    expect(projectAlbersUsa(Number.NaN, 40)).toBeNull()
  })
})

describe('heat field', () => {
  it('lands weight on the right state, counts what it could not place, and normalises to 0..1', () => {
    const field = heatField([
      { lat: 44.978, lng: -93.265, w: 10 },
      { lat: 25.761, lng: -80.191, w: 5 },
      { lat: 51.5, lng: -0.12, w: 7 },
      { lat: 30, lng: -95, w: 0 },
    ])
    expect(field.total).toBe(15)
    expect(field.unplaced).toBe(1)
    const byAbbr = Object.fromEntries([...field.byState.entries()].map(([i, v]) => [stateAbbr(i), v]))
    expect(byAbbr).toEqual({ MN: 10, FL: 5 })
    expect(Math.max(...field.level)).toBeCloseTo(1, 5)
    expect(Math.min(...field.level)).toBe(0)
  })
})

const item = (over: Partial<StudioActivityItem>): StudioActivityItem => ({
  id: Math.random().toString(36).slice(2),
  at: '2026-10-01T15:00:00Z',
  workflow: 'seller_inbound',
  workflow_name: 'Seller Conversation',
  kind: 'inbound',
  tone: 'cobalt',
  title: 'Seller replied',
  detail: null,
  subject: { name: 'Diane', address: '1 Main St', thread_key: '+15550001111' },
  link: '/inbox?thread=%2B15550001111',
  ...over,
})

describe('machine feed', () => {
  it('one execution per conversation: reply, classification, stage move and the sent reply read as one moment', () => {
    const groups = groupActivity([
      item({ id: 'a', at: '2026-10-01T15:00:00Z', title: 'Seller replied' }),
      item({ id: 'b', at: '2026-10-01T15:00:20Z', kind: 'stage', tone: 'violet', title: 'Stage advanced', detail: 'Ownership → Interest' }),
      item({ id: 'c', at: '2026-10-01T15:01:00Z', kind: 'sent', tone: 'good', title: 'Reply delivered' }),
      item({ id: 'd', at: '2026-10-01T15:02:00Z', subject: { name: 'Other', address: null, thread_key: '+15550002222' }, title: 'Seller replied' }),
    ])
    expect(groups).toHaveLength(2)
    const diane = groups.find((g) => g.subject.name === 'Diane')!
    expect(diane.steps.map((s) => s.id)).toEqual(['c', 'b', 'a'])
    expect(diane.tone).toBe('good')
  })

  it('a failure anywhere in the execution colours the whole group', () => {
    const [g] = groupActivity([
      item({ id: 'a', at: '2026-10-01T15:00:00Z' }),
      item({ id: 'b', at: '2026-10-01T15:01:00Z', kind: 'failed', tone: 'bad', title: 'Message failed' }),
    ])
    expect(g.tone).toBe('bad')
  })

  it('steps more than 30 minutes apart are separate moments', () => {
    expect(groupActivity([
      item({ id: 'a', at: '2026-10-01T15:00:00Z' }),
      item({ id: 'b', at: '2026-10-01T16:00:00Z' }),
    ])).toHaveLength(2)
  })

  it('campaign batches and closing events never merge', () => {
    const groups = groupActivity([
      item({ id: 'a', workflow: 'campaign_execution', kind: 'campaign', subject: { name: 'Camp', address: null } }),
      item({ id: 'b', workflow: 'campaign_execution', kind: 'campaign', subject: { name: 'Camp', address: null } }),
    ])
    expect(groups).toHaveLength(2)
    expect(laneOf({ workflow: 'closing_execution' })).toBe('closing')
    expect(laneOf({ workflow: 'seller_inbound', studio: true })).toBe('orchestrator')
  })
})

describe('composition mode', () => {
  it('incident when the engine needs intervention or three critical items are open', () => {
    expect(resolveHomeMode({ system: 'bad', critical: 0, high: 0, lastHour: 0 })).toBe('incident')
    expect(resolveHomeMode({ system: 'good', critical: 3, high: 0, lastHour: 0 })).toBe('incident')
  })
  it('busy when the machine moves fast or a lot is waiting', () => {
    expect(resolveHomeMode({ system: 'good', critical: 0, high: 0, lastHour: 40 })).toBe('busy')
    expect(resolveHomeMode({ system: 'warn', critical: 2, high: 4, lastHour: 3 })).toBe('busy')
  })
  it('quiet only when nothing needs the operator and the machine is idle', () => {
    expect(resolveHomeMode({ system: 'good', critical: 0, high: 0, lastHour: 1 })).toBe('quiet')
    expect(resolveHomeMode({ system: 'good', critical: 0, high: 1, lastHour: 1 })).toBe('normal')
  })
})

describe('focus summary', () => {
  const f = (over: Partial<FocusItem>): FocusItem => ({ id: Math.random().toString(36), tone: 'normal', icon: 'inbox' as FocusItem['icon'], app: 'Inbox', title: 't', detail: 'd', at: null, target: { kind: 'route', path: '/inbox' }, weight: 1000, ...over })
  it('groups by owning app, most severe group first', () => {
    const s = summarizeFocus([
      f({ app: 'Inbox', tone: 'high', weight: 3001 }),
      f({ app: 'Queue', tone: 'critical', weight: 4001 }),
      f({ app: 'Inbox', tone: 'normal', weight: 1001 }),
    ])
    expect(s.groups.map((g) => g.app)).toEqual(['Queue', 'Inbox'])
    expect(s.critical).toBe(1)
    expect(s.high).toBe(1)
    expect(s.total).toBe(3)
  })
})

describe('system pulses never invent a zero', () => {
  it('drops unmeasured metrics and omits systems whose source did not load', () => {
    const pulses = systemPulses({
      overview: null, campaigns: null, performance: null, inbox: null,
      queue: { status: 'healthy' as never, sentToday: 251, deliveredToday: 200, failedToday: 44, inFlight: 1, awaitingApproval: 0, lagging: 0, stale: 0, latestSentAt: null },
      closings: { underContract: 2, closingsThisWeek: null, titleBlocked: 0, actionRequired: 1, next: null },
    })
    expect(pulses.map((p) => p.key)).toEqual(['queue', 'closings'])
    expect(pulses[0].tone).toBe('warn')
    expect(pulses[1].metrics.map((m) => m.label)).toEqual(['under contract', 'need you'])
  })
})

describe('money', () => {
  it('formats compactly and never shows a zero as money', () => {
    expect(money(4_800_000)).toBe('$4.8M')
    expect(money(1_250_000)).toBe('$1.25M')
    expect(money(12_400_000)).toBe('$12.4M')
    expect(money(950_000)).toBe('$950K')
    expect(money(0)).toBe('—')
    expect(money(null)).toBe('—')
  })
})
