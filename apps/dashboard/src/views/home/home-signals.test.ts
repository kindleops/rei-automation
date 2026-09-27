import { describe, expect, it } from 'vitest'
import {
  bucketPipelineStages,
  buildFocusItems,
  greetingFor,
  rankMarkets,
  type FocusInputs,
  type HomeQueue,
  type HomeThread,
} from './home-signals'
import { DEFAULT_HOME_LAYOUT, HOME_MODULE_IDS, moveHomeModule, sanitizeHomeLayout } from './home-layout-store'
import type { NotificationEvent } from '../../domain/notifications/notification-contract'

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
    expect(moved.order.slice(0, 2)).toEqual(['actions', 'focus'])
    expect(moveHomeModule(DEFAULT_HOME_LAYOUT, 'focus', -1)).toBe(DEFAULT_HOME_LAYOUT)
  })
})
