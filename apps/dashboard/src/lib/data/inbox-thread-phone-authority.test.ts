/**
 * P0 2026-10-09 — "Send Failed — Thread has no valid phone number".
 *
 * A fresh reply on a new-campaign thread the list had not loaded arrived over
 * realtime as an inbox_thread_state change. The row was created from the list
 * fields alone (buildThreadStateListPatch) -- no phone, no prospect, no
 * seller_display_name -- and the canonical overlay that replaced the
 * message_events one dropped the phone the event had carried. The composer
 * held that object: canonicalE164/phoneNumber empty, so the client guard
 * refused before any send_queue row, and the contact card read "Unknown
 * Contact" while the server row had thread_key / seller_phone / canonical_e164.
 */
import { describe, expect, it } from 'vitest'
import { normalizeInboxThread, resolveInboxProspectNameWithSource, resolveThreadSellerE164 } from './inboxData'
import { buildThreadStateListPatch, createRealtimeOverlayStore } from '../../domain/inbox/inbox-realtime-sync'
import { inboxReducer, EMPTY_INBOX_STORE_STATE, reconcileFetchedRowsWithRealtime } from '../../modules/inbox/inbox-store'

const SELLER = '+15125550123'
const OURS = '+16128060495' // one of our TextGrid numbers

const threadStateRow = {
  id: 'its-1',
  thread_key: SELLER,
  seller_phone: SELLER,
  canonical_e164: SELLER,
  our_number: OURS,
  prospect_id: 'pros-1',
  property_id: '2131315339',
  master_owner_id: 'mo-1',
  seller_display_name: 'Test Seller',
  latest_direction: 'inbound',
  latest_message_at: '2026-10-09T21:54:57.362Z',
  latest_message_body: 'Who is this?',
  inbox_bucket: null,
  is_read: false,
}

describe('resolveThreadSellerE164', () => {
  it('falls back to the E.164 thread key when the phone fields are missing', () => {
    expect(resolveThreadSellerE164({ id: SELLER, threadKey: SELLER })).toBe(SELLER)
    expect(resolveThreadSellerE164({ thread_key: '5125550123' })).toBe(SELLER)
  })
  it('prefers the canonical phone and never returns our own number', () => {
    expect(resolveThreadSellerE164({ canonicalE164: OURS, seller_phone: SELLER, ourNumber: OURS })).toBe(SELLER)
    expect(resolveThreadSellerE164({ phoneNumber: OURS, threadKey: SELLER })).toBe(SELLER)
    expect(resolveThreadSellerE164({ canonicalE164: '+15125550999', ourNumber: '+15125550999', threadKey: SELLER })).toBe(SELLER)
  })
  it('is empty when nothing is a phone', () => {
    expect(resolveThreadSellerE164({ threadKey: 'ct:abc', id: 'thread:1' })).toBe('')
    expect(resolveThreadSellerE164({ threadKey: 'prop:1|pros:2' })).toBe('')
    expect(resolveThreadSellerE164(null)).toBe('')
  })
})

describe('normalizeInboxThread phone mapping', () => {
  it('carries the canonical phone from a live row', () => {
    const t = normalizeInboxThread({ ...threadStateRow })
    expect(t.canonicalE164).toBe(SELLER)
    expect(t.phoneNumber).toBe(SELLER)
    expect(t.ourNumber).toBe(OURS)
  })
  it('falls back to the thread key when the row has no phone fields', () => {
    const t = normalizeInboxThread({ thread_key: SELLER, latest_message_at: threadStateRow.latest_message_at })
    expect(t.canonicalE164).toBe(SELLER)
    expect(t.phoneNumber).toBe(SELLER)
  })
})

describe('realtime row for a thread the list has not loaded', () => {
  it('thread-state patch carries phone, prospect, property and name', () => {
    const patch = buildThreadStateListPatch(threadStateRow)
    expect(patch.canonicalE164).toBe(SELLER)
    expect(patch.phoneNumber).toBe(SELLER)
    expect(patch.ourNumber).toBe(OURS)
    expect(patch.propertyId).toBe('2131315339')
    expect(patch.prospectId).toBe('pros-1')
    expect(patch.sellerDisplayName).toBe('Test Seller')
  })
  it('never takes our number as the seller phone', () => {
    const patch = buildThreadStateListPatch({ ...threadStateRow, seller_phone: OURS, canonical_e164: OURS })
    expect(patch.canonicalE164).toBe(SELLER) // from thread_key
  })
  it('the upserted reducer row is sendable and named', () => {
    const state = inboxReducer(EMPTY_INBOX_STORE_STATE, {
      type: 'REALTIME_PATCH_THREAD',
      threadKey: SELLER,
      patch: buildThreadStateListPatch(threadStateRow),
      targetBucketKey: 'all_messages',
      upsert: true,
    })
    const row = state.buckets.all_messages?.rows[0] as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(resolveThreadSellerE164(row)).toBe(SELLER)
    expect(resolveInboxProspectNameWithSource(row).value).toBe('Test Seller')
  })
  it('a canonical overlay keeps the phone the message event carried', () => {
    const store = createRealtimeOverlayStore()
    store.record({ threadKey: SELLER, upsert: true, patch: { canonicalE164: SELLER, phoneNumber: SELLER, latestMessageAt: threadStateRow.latest_message_at } })
    store.record({ threadKey: SELLER, upsert: true, canonical: true, patch: { latestMessageAt: threadStateRow.latest_message_at, preview: 'x' } })
    const [overlay] = store.list()
    expect(overlay.patch.canonicalE164).toBe(SELLER)
    expect(overlay.patch.phoneNumber).toBe(SELLER)
    expect(overlay.patch.preview).toBe('x')
  })
  it('a list fetch that misses the thread re-adds it with its phone', () => {
    const rows = reconcileFetchedRowsWithRealtime([], [{ threadKey: SELLER, upsert: true, patch: buildThreadStateListPatch(threadStateRow) }], 'all_messages')
    expect(rows).toHaveLength(1)
    expect(resolveThreadSellerE164(rows[0])).toBe(SELLER)
  })
  it('even a phone-less skeleton resolves through its E.164 key (composer guard)', () => {
    const rows = reconcileFetchedRowsWithRealtime([], [{ threadKey: SELLER, upsert: true, patch: { latestMessageAt: threadStateRow.latest_message_at } }], 'all_messages')
    expect(resolveThreadSellerE164(rows[0])).toBe(SELLER)
  })
})
