import { describe, expect, it } from 'vitest'
import {
  buildLiveActivityFeedSnapshot,
  enrichActivityEvent,
  filterByChannel,
  filterByScope,
  isWithinBounds,
} from '../../src/views/map/live-activity-engine'
import { maybeBuildPinEvent, type CommandMapActivityPinSource, type CommandMapLiveActivitySettings } from '../../src/views/map/commandMapLiveActivity'

const baseSettings: CommandMapLiveActivitySettings = {
  visible: true,
  displayMode: 'minimal',
  speed: 'normal',
  pauseOnHover: true,
  onlyCurrentBounds: true,
  onlySelectedMarket: false,
  onlyHotCritical: false,
  maxCardsVisible: 20,
  autoScroll: true,
  eventTypes: Object.fromEntries(
    [
      'message_sent', 'message_delivered', 'message_failed', 'queue_scheduled', 'queue_ready',
      'queue_blocked', 'queue_paused', 'new_reply', 'positive_reply', 'hot_lead', 'follow_up_due',
      'offer', 'contract', 'closing', 'buyer_activity', 'sold_comp', 'system_alert', 'routing_block',
      'opt_out', 'automation_block', 'missing_message_event', 'provider_id_missing',
    ].map((key) => [key, true]),
  ) as CommandMapLiveActivitySettings['eventTypes'],
  pinHotEvents: true,
  autoPinCriticalSeconds: 22,
  subtleSpeedVariance: true,
  scope: 'viewport',
  activeChannel: 'live',
  showMapRipples: true,
  openTargetOnClick: true,
  retentionDays: 14,
}

const makePin = (overrides: Partial<CommandMapActivityPinSource> = {}): CommandMapActivityPinSource => ({
  conversation_id: 'conv-1',
  seller_name: 'Marcus Triplett',
  address: '123 Main St',
  city: 'Dallas',
  state: 'TX',
  market: 'Dallas, TX',
  lat: 32.78,
  lng: -96.8,
  priority_score: 80,
  conversation_stage: 'conversation',
  conversation_status: 'active',
  next_action: 'Review inbound',
  next_follow_up_at: null,
  last_activity_at: new Date().toISOString(),
  last_message: 'Yes, I am still the owner.',
  last_inbound_at: new Date().toISOString(),
  last_outbound_at: null,
  unread: true,
  offer_status: '',
  contract_status: '',
  suppression_status: 'clear',
  automation_status: 'clear',
  queue_status: null,
  latest_message_body: 'Yes, I am still the owner.',
  activity_state: 'replied',
  ...overrides,
})

describe('live activity engine', () => {
  it('separates sold comps into context channel', () => {
    const snapshot = buildLiveActivityFeedSnapshot({
      pins: [],
      threadsById: new Map(),
      soldComps: [{
        property_id: 'comp-1',
        property_address_full: '456 Oak Ave',
        property_address_city: 'Dallas',
        property_address_state: 'TX',
        sale_date: '2025-02-01T00:00:00.000Z',
        mls_sold_date: null,
        sale_price: 240000,
        mls_sold_price: null,
        latitude: 32.79,
        longitude: -96.81,
        sale_source: 'mls',
        comp_confidence_score: 88,
      }],
      settings: { ...baseSettings, activeChannel: 'context', scope: 'global' },
      buildPinEvent: maybeBuildPinEvent,
    })

    expect(snapshot.context.length).toBeGreaterThan(0)
    expect(snapshot.context[0].channel).toBe('context')
    expect(snapshot.context[0].badgeLabel).toBe('CONTEXT')
    expect(snapshot.live.every((event) => event.type !== 'sold_comp')).toBe(true)
  })

  it('filters viewport scope by bounds', () => {
    const inBounds = enrichActivityEvent({
      id: 'reply-1',
      type: 'new_reply',
      priority: 'hot',
      title: 'In View',
      createdAt: new Date().toISOString(),
      lat: 32.78,
      lng: -96.8,
    }, 'live', 'test')

    const outBounds = enrichActivityEvent({
      id: 'reply-2',
      type: 'new_reply',
      priority: 'hot',
      title: 'Out of View',
      createdAt: new Date().toISOString(),
      lat: 30.2,
      lng: -97.7,
    }, 'live', 'test')

    const scoped = filterByScope(
      [inBounds, outBounds],
      'viewport',
      { west: -97, south: 32, east: -96, north: 33 },
      null,
      null,
      null,
    )

    expect(scoped).toHaveLength(1)
    expect(scoped[0].title).toBe('In View')
  })

  it('ranks new reply above delivered message in rotation pool', () => {
    const snapshot = buildLiveActivityFeedSnapshot({
      pins: [
        makePin({ conversation_id: 'conv-delivered', unread: false, queue_status: 'delivered', activity_state: 'idle', suppression_status: 'clear' }),
        makePin({
          conversation_id: 'conv-reply',
          unread: true,
          activity_state: 'replied',
          latest_message_body: 'Need to check with my spouse.',
          last_message: 'Need to check with my spouse.',
        }),
      ],
      threadsById: new Map(),
      settings: { ...baseSettings, scope: 'global', activeChannel: 'live' },
      buildPinEvent: maybeBuildPinEvent,
    })

    expect(snapshot.rankedForRotation[0]?.type).toBe('new_reply')
  })

  it('dedupes repeated opt-out events per conversation', () => {
    const snapshot = buildLiveActivityFeedSnapshot({
      pins: [
        makePin({ conversation_id: 'conv-dnc', suppression_status: 'opt_out', unread: false, activity_state: 'idle' }),
        makePin({ conversation_id: 'conv-dnc', suppression_status: 'opt_out', unread: false, activity_state: 'idle', seller_name: 'Duplicate' }),
      ],
      threadsById: new Map(),
      settings: { ...baseSettings, scope: 'global', activeChannel: 'live' },
      buildPinEvent: maybeBuildPinEvent,
    })

    const dncEvents = snapshot.live.filter((event) => event.type === 'opt_out')
    expect(dncEvents).toHaveLength(1)
  })

  it('reports accurate visible count after channel filter', () => {
    const snapshot = buildLiveActivityFeedSnapshot({
      pins: [makePin()],
      threadsById: new Map(),
      soldComps: [{
        property_id: 'comp-2',
        property_address_full: '789 Pine Rd',
        property_address_city: 'Dallas',
        property_address_state: 'TX',
        sale_date: '2024-01-01T00:00:00.000Z',
        mls_sold_date: null,
        sale_price: 180000,
        mls_sold_price: null,
        latitude: 32.79,
        longitude: -96.81,
        sale_source: 'mls',
        comp_confidence_score: 70,
      }],
      settings: { ...baseSettings, scope: 'global', activeChannel: 'live' },
      buildPinEvent: maybeBuildPinEvent,
    })

    expect(snapshot.visibleCount).toBe(snapshot.visible.length)
    expect(filterByChannel([...snapshot.live, ...snapshot.context], 'live').every((e) => e.channel === 'live')).toBe(true)
  })

  it('checks coordinate bounds helper', () => {
    expect(isWithinBounds(32.78, -96.8, { west: -97, south: 32, east: -96, north: 33 })).toBe(true)
    expect(isWithinBounds(30, -96.8, { west: -97, south: 32, east: -96, north: 33 })).toBe(false)
  })

  it('exposes live-only ticker queue separate from context timeline', () => {
    const snapshot = buildLiveActivityFeedSnapshot({
      pins: [makePin()],
      threadsById: new Map(),
      soldComps: [{
        property_id: 'comp-ctx',
        property_address_full: '100 Context St',
        property_address_city: 'Dallas',
        property_address_state: 'TX',
        sale_date: '2024-06-01T00:00:00.000Z',
        mls_sold_date: null,
        sale_price: 210000,
        mls_sold_price: null,
        latitude: 32.79,
        longitude: -96.81,
        sale_source: 'mls',
        comp_confidence_score: 80,
      }],
      settings: { ...baseSettings, scope: 'global', activeChannel: 'live' },
      buildPinEvent: maybeBuildPinEvent,
    })

    expect(snapshot.tickerCount).toBeGreaterThan(0)
    expect(snapshot.tickerQueue.every((event) => event.channel === 'live')).toBe(true)
    expect(snapshot.tickerQueue.some((event) => event.type === 'sold_comp')).toBe(false)
  })
})