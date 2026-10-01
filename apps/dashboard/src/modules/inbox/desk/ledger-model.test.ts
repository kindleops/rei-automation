import { describe, expect, it } from 'vitest'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import {
  MORE_LENSES,
  PRIMARY_LENSES,
  buildLedgerRow,
  filteredCountLabel,
  formatEquityEstimate,
  formatRelativeTime,
  formatValueEstimate,
  humanizeIntent,
  lensCount,
  moveCursor,
  resolveDeskLens,
  resolveLane,
  splitAddress,
  type LedgerFacts,
} from './ledger-model'

const NOW = Date.parse('2026-10-01T15:00:00.000Z')

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: 'ct:prospect:p1|property:273000001|owner:mo1|phone:+16122232473',
  threadKey: '+16122232473',
  thread_key: '+16122232473',
  canonical_e164: '+16122232473',
  seller_display_name: 'Wendy B Stuhr',
  property_address_full: '3831 Sheridan Ave N, Minneapolis, Mn 55412',
  market: 'Minneapolis, MN',
  latest_message_body: 'Yes.\n I am not interested in selling.  Thanks.',
  latest_message_direction: 'inbound',
  latest_message_at: '2026-10-01T14:56:00.000Z',
  lastMessageAt: '2026-10-01T14:56:00.000Z',
  property_type: 'Single Family Residential',
  seller_stage: 'offer_interest',
  property_id: '273000001',
  propertyId: '273000001',
  is_suppressed: false,
  ...overrides,
}) as unknown as InboxWorkflowThread

const facts = (overrides: Partial<LedgerFacts> = {}): LedgerFacts => ({
  thread_key: '+16122232473',
  flags: [],
  is_read: false,
  needs_review_reason: null,
  confidence: null,
  last_intent: null,
  disposition: null,
  stage: 'offer_interest',
  latest_direction: 'inbound',
  latest_delivery_status: null,
  pending_send: false,
  last_inbound_at: '2026-10-01T14:56:00.000Z',
  last_outbound_at: '2026-09-30T10:00:00.000Z',
  latest_message_at: '2026-10-01T14:56:00.000Z',
  snoozed_until: null,
  follow_up_at: null,
  next_scheduled_for: null,
  estimated_value: null,
  equity_percent: null,
  equity_amount: null,
  ...overrides,
})

describe('lenses', () => {
  it('has the five primary triage lenses in order, and no invented "system handling" bucket', () => {
    expect(PRIMARY_LENSES.map((lens) => lens.id)).toEqual(['priority', 'new_replies', 'needs_review', 'waiting', 'follow_up'])
    expect([...PRIMARY_LENSES, ...MORE_LENSES].some((lens) => /system/i.test(lens.label))).toBe(false)
  })

  it('folds view aliases onto their lens; filters are their own lens', () => {
    expect(resolveDeskLens('hot_leads')).toBe('priority')
    expect(resolveDeskLens('new_inbound')).toBe('new_replies')
    expect(resolveDeskLens('waiting_on_seller')).toBe('waiting')
    expect(resolveDeskLens('follow_up_due')).toBe('follow_up')
    expect(resolveDeskLens('all_messages')).toBe('all_conversations')
    expect(resolveDeskLens('priority', true)).toBe('filtered')
  })

  it('reads canonical counts and never turns "unknown" into 0', () => {
    const newReplies = PRIMARY_LENSES[1]
    expect(lensCount({ new_replies: 111 }, newReplies)).toBe(111)
    expect(lensCount({ new_replies: 0 }, newReplies)).toBe(0)
    expect(lensCount({}, newReplies)).toBeNull()
    expect(lensCount({ new_replies: null }, newReplies)).toBeNull()
    expect(lensCount(null, newReplies)).toBeNull()
  })
})

describe('formatting', () => {
  it('relative time is short and tabular', () => {
    expect(formatRelativeTime('2026-10-01T14:59:40.000Z', NOW)).toBe('now')
    expect(formatRelativeTime('2026-10-01T14:56:00.000Z', NOW)).toBe('4m')
    expect(formatRelativeTime('2026-10-01T12:00:00.000Z', NOW)).toBe('3h')
    expect(formatRelativeTime('2026-09-29T15:00:00.000Z', NOW)).toBe('2d')
    expect(formatRelativeTime(null, NOW)).toBe('')
  })

  it('estimates say they are estimates; missing stays missing', () => {
    expect(formatValueEstimate(212000)).toBe('$212K est.')
    expect(formatValueEstimate('1,250,000')).toBe('$1.3M est.')
    expect(formatValueEstimate(0)).toBeNull()
    expect(formatValueEstimate(null)).toBeNull()
    expect(formatEquityEstimate(76.4)).toBe('76% eq.')
    expect(formatEquityEstimate(140)).toBeNull()
  })

  it('splits the street from the locality', () => {
    expect(splitAddress('3831 Sheridan Ave N, Minneapolis, Mn 55412')).toEqual({ street: '3831 Sheridan Ave N', rest: 'Minneapolis, Mn 55412' })
    expect(splitAddress('Property Unknown')).toEqual({ street: null, rest: null })
  })

  it('an unclear intent is not an answer', () => {
    expect(humanizeIntent('asking_price_provided')).toBe('Asking price given')
    expect(humanizeIntent('unclear')).toBeNull()
    expect(humanizeIntent('some_new_intent')).toBe('Some new intent')
  })
})

describe('the row', () => {
  it('reads identity, the latest reply and the canonical stage', () => {
    const row = buildLedgerRow(thread(), { lens: 'new_replies', facts: null, now: NOW })
    expect(row.name).toBe('Wendy B Stuhr')
    expect(row.street).toBe('3831 Sheridan Ave N')
    expect(row.locality).toBe('Minneapolis, MN')
    expect(row.message).toBe('Yes. I am not interested in selling. Thanks.')
    expect(row.direction).toBe('inbound')
    expect(row.stage?.short).toBe('S2')
    expect(row.propertyType).toBe('SFR')
    expect(row.timeLabel).toBe('4m')
    expect(row.timeExact).toMatch(/2026/)
  })

  it('a thread with no canonical stage shows no stage (never a fabricated S1)', () => {
    const row = buildLedgerRow(thread({ seller_stage: 'waiting', stage: 'waiting' }), { lens: 'new_replies', facts: null, now: NOW })
    expect(row.stage).toBeNull()
  })

  it('before facts arrive, the row is in the lens it was listed under — and nothing else', () => {
    expect(buildLedgerRow(thread(), { lens: 'waiting', facts: null, now: NOW }).lane?.label).toBe('Waiting on seller')
    expect(buildLedgerRow(thread(), { lens: 'all_conversations', facts: null, now: NOW }).lane).toBeNull()
    expect(buildLedgerRow(thread(), { lens: 'filtered', facts: null, now: NOW }).lane).toBeNull()
  })

  it('unread is canonical: an inbound reply nobody opened', () => {
    expect(buildLedgerRow(thread(), { lens: 'new_replies', facts: facts({ is_read: false }), now: NOW }).unread).toBe(true)
    expect(buildLedgerRow(thread(), { lens: 'new_replies', facts: facts({ is_read: true }), now: NOW }).unread).toBe(false)
    const outbound = thread({ latest_message_direction: 'outbound' })
    expect(buildLedgerRow(outbound, { lens: 'waiting', facts: facts({ is_read: false, latest_direction: 'outbound' }), now: NOW }).unread).toBe(false)
  })

  it('a reply that landed live is unread until opened, even if the row was read before', () => {
    const arrivedAt = Date.parse('2026-10-01T14:56:01.000Z')
    expect(buildLedgerRow(thread(), { lens: 'new_replies', facts: facts({ is_read: true }), now: NOW, arrivedAt }).unread).toBe(true)
  })

  it('valuation only from stored estimates, labelled', () => {
    const row = buildLedgerRow(thread({ equity_percent: 76 }), { lens: 'priority', facts: facts({ estimated_value: 212000, equity_percent: 76 }), now: NOW })
    expect(row.value).toBe('$212K est.')
    expect(row.equity).toBe('76% eq.')
  })

  it('needs review is gold with a reason in the predicate\'s own terms', () => {
    const row = buildLedgerRow(thread(), { lens: 'all_conversations', facts: facts({ flags: ['needs_review'], needs_review_reason: 'low_confidence', confidence: 0.42 }), now: NOW })
    expect(row.needsYou).toBe(true)
    expect(row.lane?.label).toBe('Needs you')
    expect(row.lane?.tone).toBe('attn')
    expect(row.needsYouWhy).toContain('42%')
  })

  it('suppression is visible and quiet, and outranks everything', () => {
    const row = buildLedgerRow(thread({ is_suppressed: true }), { lens: 'new_replies', facts: facts({ flags: ['new_replies', 'needs_review'] }), now: NOW })
    expect(row.suppressed).toBe(true)
    expect(row.lane?.label).toBe('Suppressed')
    expect(row.lane?.quiet).toBe(true)
  })

  it('a failed last send says so; a delivered one does not', () => {
    const failed = thread({ latest_message_direction: 'outbound', latest_delivery_status: 'failed' })
    expect(buildLedgerRow(failed, { lens: 'all_conversations', facts: null, now: NOW }).lane?.label).toBe('Send failed')
    const delivered = thread({ latest_message_direction: 'outbound', latest_delivery_status: 'delivered' })
    expect(buildLedgerRow(delivered, { lens: 'all_conversations', facts: null, now: NOW }).failed).toBe(false)
  })

  it('not interested is a 30-day nurture, never dead', () => {
    const lane = resolveLane({ lens: 'follow_up', facts: facts({ flags: ['follow_up'], disposition: 'not_interested' }), suppressed: false, failed: false, disposition: 'not_interested' })
    expect(lane?.label).toBe('Nurture · 30 days')
  })

  it('waiting says how long since we sent', () => {
    const row = buildLedgerRow(thread({ latest_message_direction: 'outbound' }), { lens: 'waiting', facts: facts({ flags: ['waiting'], latest_direction: 'outbound', last_outbound_at: '2026-10-01T11:00:00.000Z' }), now: NOW })
    expect(row.laneDetail).toBe('sent 4h ago')
  })
})

describe('keyboard cursor', () => {
  const ids = ['a', 'b', 'c']
  it('starts at the edge, moves, and clamps', () => {
    expect(moveCursor(ids, null, 1)).toBe('a')
    expect(moveCursor(ids, null, -1)).toBe('c')
    expect(moveCursor(ids, 'a', 1)).toBe('b')
    expect(moveCursor(ids, 'c', 1)).toBe('c')
    expect(moveCursor(ids, 'b', -10)).toBe('a')
    expect(moveCursor([], 'a', 1)).toBeNull()
  })
})

describe('the filtered lens', () => {
  it('carries its own count, never a bucket\'s', () => {
    expect(filteredCountLabel(37, 30, true)).toBe('37 conversations')
    expect(filteredCountLabel(null, 30, true)).toBe('30+ conversations')
    expect(filteredCountLabel(1, 1, false)).toBe('1 conversation')
  })
})
