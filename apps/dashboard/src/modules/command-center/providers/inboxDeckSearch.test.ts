import { describe, expect, it } from 'vitest'
import { toDeckHit } from './inboxDeckSearch'
import { toConversationResult } from './sellerSearchProvider'
import { toPropertyResult } from './propertySearchProvider'

const ROW = {
  thread_key: '+16122232473',
  canonical_e164: '+16122232473',
  seller_display_name: 'Wendy B Stuhr',
  owner_name: 'Wendy B Stuhr',
  property_address_full: '3831 Sheridan Ave N, Minneapolis, Mn 55412',
  market: 'Minneapolis, MN',
  latest_message_body: 'Yes.\nI am not interested in selling. Thanks.',
  latest_message_direction: 'inbound',
  latest_message_at: '2026-09-30T20:20:43.090Z',
  property_id: '273000001',
  master_owner_id: 'mo-1',
  seller_stage: 'offer_interest',
  is_suppressed: false,
}

const INBOX = { routePath: '/inbox' }
const MAP = { routePath: '/map' }

describe('Command Deck — Inbox search', () => {
  it('reads one compact Inbox row as a hit', () => {
    const hit = toDeckHit(ROW)!
    expect(hit).toMatchObject({ threadKey: '+16122232473', name: 'Wendy B Stuhr', street: '3831 Sheridan Ave N', locality: 'Minneapolis, Mn 55412', stage: 'offer_interest', latestDirection: 'inbound' })
    expect(hit.latest).toBe('Yes. I am not interested in selling. Thanks.')
    expect(toDeckHit({ seller_display_name: 'No key' })).toBeNull()
  })

  it('a nameless row falls back to the formatted phone, never a fabricated name', () => {
    expect(toDeckHit({ thread_key: '+16125550100' })?.name).toBe('(612) 555-0100')
  })

  it('a conversation result opens THAT conversation', () => {
    const result = toConversationResult(toDeckHit(ROW)!, INBOX)
    expect(result.type).toBe('conversation')
    expect(result.payload).toEqual({ kind: 'focus_thread', threadId: '+16122232473', propertyId: '273000001' })
    expect(result.subtitle).toBe('3831 Sheridan Ave N · Minneapolis, MN')
    expect(result.badge).toBe('S2')
    expect(result.description).toContain('not interested')
  })

  it('ranks Inbox-first when the Inbox pane is focused', () => {
    const hit = toDeckHit(ROW)!
    expect(toConversationResult(hit, INBOX).score).toBeGreaterThan(toConversationResult(hit, MAP).score)
  })

  it('a property result opens Deal Intelligence on that property; unlinked threads are not properties', () => {
    const result = toPropertyResult(toDeckHit(ROW)!, INBOX)!
    expect(result.route).toBe('/deal-intelligence?property_id=273000001')
    expect(result.subtitle).toContain('Owner: Wendy B Stuhr')
    expect(toPropertyResult(toDeckHit({ ...ROW, property_id: null })!, INBOX)).toBeNull()
  })
})
