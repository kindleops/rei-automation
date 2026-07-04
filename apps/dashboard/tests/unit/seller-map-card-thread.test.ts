import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalThreadStateKey,
  resolveDialablePhoneFromThread,
} from '../../src/domain/inbox/resolveCanonicalThreadStateKey'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import {
  buildThreadFromViewModel,
  resolveMapThreadPhone,
} from '../../src/views/map/seller-card/useSellerMapCardActions'

const baseRecord = {
  property_id: 'prop-123',
  master_owner_id: 'owner-456',
  prospect_id: 'prospect-789',
  thread_key: 'property:prop-123',
  property_address_full: '123 Main St, Memphis, TN 38103',
  property_address_state: 'TN',
  market: 'memphis, tn',
  owner_display_name: 'Jane Seller',
  outbound_count: 0,
  sent_count: 0,
}

describe('seller map card thread builder', () => {
  it('resolves phone from prospect and display aliases', () => {
    expect(resolveMapThreadPhone({
      prospect_best_phone: '+19015551234',
    })).toBe('+19015551234')

    expect(resolveMapThreadPhone({
      display_phone: '+19015559876',
    })).toBe('+19015559876')

    expect(resolveMapThreadPhone({
      display_phone: 'No Phone',
    })).toBe('')
  })

  it('maps owner, prospect, state, and synthetic thread key into inbox thread', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
    expect(thread.ownerId).toBe('owner-456')
    expect(thread.prospectId).toBe('prospect-789')
    expect(thread.canonicalE164).toBe('+19015551234')
    expect(thread.property_address_state).toBe('TN')
    expect(thread.market).toBe('memphis, tn')
  })

  it('synthesizes property thread key when missing from record', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      thread_key: '',
      prospect_best_phone: '+19015551234',
    })

    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      thread_key: '',
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
  })

  it('applies phone and prospect overrides from hydration', () => {
    const viewModel = buildSellerMapCardViewModel(baseRecord)
    const thread = buildThreadFromViewModel(viewModel, baseRecord, {
      phone: '+19015550001',
      prospectId: 'prospect-hydrated',
    })

    expect(thread.canonicalE164).toBe('+19015550001')
    expect(thread.prospectId).toBe('prospect-hydrated')
  })

  it('resolves canonical E.164 send key from synthetic property thread', () => {
    const viewModel = buildSellerMapCardViewModel({
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })
    const thread = buildThreadFromViewModel(viewModel, {
      ...baseRecord,
      prospect_best_phone: '+19015551234',
    })

    expect(thread.threadKey).toBe('property:prop-123')
    expect(resolveCanonicalThreadStateKey(thread as unknown as Record<string, unknown>)).toBe('+19015551234')
  })

  it('does not treat numeric property ids as dialable phones', () => {
    const syntheticThread = {
      threadKey: 'property:2100277008',
      id: 'property:2100277008',
      phoneNumber: '',
      canonicalE164: '',
    }

    expect(resolveDialablePhoneFromThread(syntheticThread)).toBeNull()
    expect(resolveCanonicalThreadStateKey(syntheticThread)).toBeNull()
  })
})