import { describe, expect, it } from 'vitest'
import {
  bucketPipelineStages,
  summarizeCalendar,
  buildFocusItems,
  greetingFor,
  rankMarkets,
  type FocusInputs,
  type HomeQueue,
  type HomeThread,
} from './home-signals'
import { DEFAULT_HOME_LAYOUT, HOME_MODULE_IDS, moveHomeModule, sanitizeHomeLayout } from './home-layout-store'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'
import type { CalendarEvent } from '../../lib/data/calendarData'
import { projectAlbersUsa } from './home-geo'
import { easeOutQuart } from './home-motion'
import { US_DOTS, US_STATES } from './us-dot-matrix'

const NOW = Date.parse('2026-09-27T15:00:00Z')

const queue = (overrides: Partial<HomeQueue> = {}): HomeQueue => ({
  status: 'healthy',
  sentToday: 120,
  deliveredToday: 115,
  failedToday: 0,
  inFlight: 40,
  awaitingApproval: 0,
  lagging: 0,
  stale: 0,
  latestSentAt: null,
  ...overrides,
})

const thread = (overrides: Partial<HomeThread> = {}): HomeThread => ({
  id: 't1',
  threadKey: 't1',
  propertyId: 'p1',
  prospectId: null,
  masterOwnerId: null,
  seller: 'Dana Seller',
  address: '1 Main St',
  market: 'Tulsa, OK',
  preview: 'What would you offer?',
  at: new Date(NOW - 5 * 60_000).toISOString(),
  unread: true,
  hot: false,
  urgent: false,
  ...overrides,
})

const empty: FocusInputs = {
  inbox: null,
  queue: null,
  campaigns: null,
  pipeline: null,
  closings: null,
  notifications: [],
  now: NOW,
}

describe('Home focus queue', () => {
  it('is empty when nothing needs the operator', () => {
    expect(buildFocusItems({ ...empty, queue: queue() })).toEqual([])
  })

  it('ranks an engine failure above a seller reply', () => {
    const items = buildFocusItems({
      ...empty,
      queue: queue({ status: 'critical', failedToday: 3 }),
      inbox: { newReplies: 1, priority: 0, needsAttention: 0, threads: [thread({ hot: true })] },
    })
    expect(items[0].id).toBe('queue-critical')
    expect(items[0].tone).toBe('critical')
    expect(items.some((item) => item.target.kind === 'thread')).toBe(true)
  })

  it('surfaces a closing within a week, and today as critical', () => {
    const items = buildFocusItems({
      ...empty,
      closings: {
        underContract: 1,
        closingsThisWeek: 1,
        titleBlocked: 0,
        actionRequired: 0,
        next: { name: 'Dana Seller', address: '1 Main St', date: new Date(NOW + 2 * 3_600_000).toISOString() },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Closing today')
    expect(items[0].tone).toBe('critical')
  })

  it('ignores a closing more than a week out', () => {
    const items = buildFocusItems({
      ...empty,
      closings: {
        underContract: 1,
        closingsThisWeek: 0,
        titleBlocked: 0,
        actionRequired: 0,
        next: { name: 'Dana', address: null, date: new Date(NOW + 20 * 86_400_000).toISOString() },
      },
    })
    expect(items).toEqual([])
  })

  it('aggregates campaign attention into one item', () => {
    const campaign = { id: 'c', name: 'Tulsa absentee', market: null, status: 'active' as const, ready: 0, total: 10, sent: 5, replies: 0, issue: 'No ready targets' }
    const items = buildFocusItems({
      ...empty,
      campaigns: { live: 2, paused: 0, readyTargets: 0, attention: [campaign, { ...campaign, id: 'd' }], highlighted: [], degraded: false },
    })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('2 campaigns need attention')
  })

  it('takes only unread warning and critical notifications, once per type', () => {
    const base: NotificationEvent = {
      id: 'n1', domain: 'numbers', severity: 'warning', type: 'number_degraded', title: 'Sender degraded',
      body: 'Delivery fell', status: 'unread', soundCategory: 'warning' as NotificationEvent['soundCategory'],
      createdAt: new Date(NOW - 60_000).toISOString(), actions: [],
    }
    const items = buildFocusItems({
      ...empty,
      notifications: [
        base,
        { ...base, id: 'n2' },
        { ...base, id: 'n3', type: 'other', status: 'read' },
        { ...base, id: 'n4', type: 'praise', severity: 'positive' },
      ],
    })
    expect(items.map((item) => item.id)).toEqual(['notification-n1'])
    expect(items[0].target).toEqual({ kind: 'route', path: '/queue' })
  })

  it('orders hot sellers ahead of recent ones within the inbox band', () => {
    const items = buildFocusItems({
      ...empty,
      inbox: {
        newReplies: 2,
        priority: 1,
        needsAttention: 0,
        threads: [thread({ id: 'recent', seller: 'Recent' }), thread({ id: 'hot', seller: 'Hot', hot: true, at: new Date(NOW - 3 * 3_600_000).toISOString() })],
      },
    })
    expect(items[0].title).toBe('Hot replied')
    expect(items[0].tone).toBe('opportunity')
  })
})

describe('Home pipeline buckets', () => {
  it('folds the canonical stages into five and excludes closed', () => {
    const buckets = bucketPipelineStages({
      ownership_confirmation: 10,
      offer_interest: 5,
      asking_price: 3,
      property_condition: 2,
      offer: 4,
      formal_contract: 1,
      disposition: 1,
      under_contract: 2,
      prepared_to_close: 1,
      closed: 50,
    })
    expect(buckets.map((bucket) => [bucket.id, bucket.count])).toEqual([
      ['new', 15],
      ['talking', 5],
      ['offer', 4],
      ['contract', 4],
      ['closing', 1],
    ])
  })

  it('reads a missing breakdown as zero per stage, not as a failure', () => {
    expect(bucketPipelineStages(undefined).every((bucket) => bucket.count === 0)).toBe(true)
  })
})

describe('Home market ranking', () => {
  it('ranks by positive replies, drops silent and unknown markets', () => {
    const ranked = rankMarkets([
      { market: 'Tulsa, OK', state: 'OK', sent: 500, replied: 20, positive: 2 },
      { market: 'Dallas, TX', state: 'TX', sent: 900, replied: 40, positive: 6 },
      { market: 'Unknown', state: '—', sent: 100, replied: 90, positive: 9 },
      { market: 'Quiet, KS', state: 'KS', sent: 0, replied: 0, positive: 0 },
    ])
    expect(ranked.map((row) => row.market)).toEqual(['Dallas, TX', 'Tulsa, OK'])
  })
})

describe('Home greeting', () => {
  it('follows the local hour', () => {
    expect(greetingFor(new Date(2026, 8, 27, 8))).toBe('Good morning')
    expect(greetingFor(new Date(2026, 8, 27, 13))).toBe('Good afternoon')
    expect(greetingFor(new Date(2026, 8, 27, 21))).toBe('Good evening')
  })
})

describe('Home layout store', () => {
  it('falls back to the default for garbage', () => {
    expect(sanitizeHomeLayout('nope')).toEqual(DEFAULT_HOME_LAYOUT)
    expect(sanitizeHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT)
  })

  it('appends modules added after the layout was saved, and drops retired ones', () => {
    const layout = sanitizeHomeLayout({ order: ['activity', 'retired-module', 'focus'], hidden: ['markets', 'bogus'], compact: [] })
    expect(layout.order.slice(0, 2)).toEqual(['activity', 'focus'])
    expect(new Set(layout.order)).toEqual(new Set(HOME_MODULE_IDS))
    expect(layout.hidden).toEqual(['markets'])
  })

  it('moves a module within bounds only', () => {
    const moved = moveHomeModule(DEFAULT_HOME_LAYOUT, 'actions', -1)
    expect(moved.order.slice(0, 3)).toEqual(['automation', 'actions', 'focus'])
    expect(moveHomeModule(DEFAULT_HOME_LAYOUT, 'automation', -1)).toBe(DEFAULT_HOME_LAYOUT)
  })
})

describe('Home map projection', () => {
  it('matches the Census Albers USA geometry', () => {
    // Colorado's pre-projected polygon in us-atlas spans x 264.6..395.3 and
    // y 237.2..340.7. On a conic projection the meridians slant, so its
    // westmost point is the south-west corner and its lowest the south-east.
    const sw = projectAlbersUsa(-109.05, 36.99)!
    const se = projectAlbersUsa(-102.04, 36.99)!
    expect(sw[0]).toBeCloseTo(264.6, 0)
    expect(se[1]).toBeCloseTo(340.7, 0)
  })

  it('places cities inside their own state', () => {
    const nearest = (x: number, y: number) => {
      let best = { d: Infinity, abbr: '' }
      for (let i = 0; i < US_DOTS.length; i += 3) {
        const d = Math.hypot(US_DOTS[i] / 10 - x, US_DOTS[i + 1] / 10 - y)
        if (d < best.d) best = { d, abbr: US_STATES[US_DOTS[i + 2]].abbr }
      }
      return best.abbr
    }
    for (const [lng, lat, abbr] of [[-96.797, 32.777, 'TX'], [-97.52, 35.47, 'OK'], [-104.99, 39.74, 'CO'], [-84.39, 33.75, 'GA']] as const) {
      const point = projectAlbersUsa(lng, lat)!
      expect(nearest(point[0], point[1])).toBe(abbr)
    }
  })

  it('refuses points it would misplace', () => {
    expect(projectAlbersUsa(-149.9, 61.2)).toBeNull()
    expect(projectAlbersUsa(0, 0)).toBeNull()
  })
})

describe('Home calendar summary', () => {
  const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
    id: 'e', type: 'seller_follow_up', tone: 'amber', title: 'Follow up', description: '', timestamp: '2026-09-27T15:00:00',
    sourceTable: 't', status: 'scheduled', market: '', state: '', sellerName: 'Dana', propertyAddress: '', propertyId: null,
    sellerId: null, threadId: null, priority: 'normal', actor: 'System', overdue: false, dueSoon: false, hot: false,
    automationBlocked: false, ...overrides,
  })
  const start = new Date(2026, 8, 27)

  it('keeps work, rolls up sends, drops history', () => {
    const summary = summarizeCalendar([
      event({ id: 'a', timestamp: new Date(2026, 8, 27, 15).toISOString() }),
      event({ id: 'b', type: 'scheduled_sms', timestamp: new Date(2026, 8, 27, 9).toISOString() }),
      event({ id: 'c', type: 'scheduled_sms', timestamp: new Date(2026, 8, 28, 9).toISOString() }),
      event({ id: 'd', type: 'sms_delivered', timestamp: new Date(2026, 8, 27, 10).toISOString() }),
      event({ id: 'e', timestamp: new Date(2026, 9, 9).toISOString() }),
    ], start)
    expect(summary.days).toHaveLength(7)
    expect(summary.days[0].agenda.map((item) => item.id)).toEqual(['a'])
    expect(summary.days[0].scheduledSends).toBe(1)
    expect(summary.days[1].scheduledSends).toBe(1)
  })

  it('counts overdue work and hides placeholder names', () => {
    const summary = summarizeCalendar([
      event({ id: 'a', overdue: true, sellerName: 'Unresolved event', timestamp: new Date(2026, 8, 27, 8).toISOString() }),
    ], start)
    expect(summary.overdue).toBe(1)
    expect(summary.days[0].agenda[0].who).toBe('')
  })
})

describe('Home counter easing', () => {
  it('never leaves 0..1, even for a frame stamped before the count began', () => {
    expect(easeOutQuart(-0.5)).toBe(0)
    expect(easeOutQuart(2)).toBe(1)
    expect(easeOutQuart(0.5)).toBeGreaterThan(0.5)
  })
})
