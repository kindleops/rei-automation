import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalThreadStateKey,
  resolveDialablePhoneFromThread,
} from '../../src/domain/inbox/resolveCanonicalThreadStateKey'
import { buildSellerMapCardViewModel } from '../../src/views/map/seller-card/seller-map-card-view-model'
import {
  buildMapTemplateManualValues,
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

  describe('map SMS personalization never uses the Master Owner name as the greeting (launch blocker)', () => {
    it('never populates seller_first_name/seller_name from an LLC master owner name', () => {
      const values = buildMapTemplateManualValues({
        owner_display_name: 'West 7th Apartments LLC',
        master_owner_id: 'owner-456',
      })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
      // owner_name is preserved as ownership *context*, never as the greeting name.
      expect(values.owner_name).toBe('West 7th Apartments LLC')
    })

    it('never populates seller_first_name/seller_name from a trust/estate master owner name', () => {
      const values = buildMapTemplateManualValues({ owner_display_name: 'D & D Divide LLC' })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
    })

    it('uses the resolved prospect name when one is present, ignoring the owner entity name', () => {
      const values = buildMapTemplateManualValues({
        owner_display_name: '88 Cleveland - M LLC',
        prospect_full_name: 'Maria Lopez',
      })
      expect(values.seller_first_name).toBe('Maria')
      expect(values.seller_name).toBe('Maria Lopez')
    })

    it('leaves seller_first_name empty (never entity-derived) when only an individual-named owner exists and no prospect is linked', () => {
      const values = buildMapTemplateManualValues({ owner_display_name: 'Jose A Valdizon' })
      expect(values.seller_first_name).toBe('')
      expect(values.seller_name).toBe('')
    })
  })
})