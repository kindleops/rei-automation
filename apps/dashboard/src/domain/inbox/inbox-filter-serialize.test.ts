import { describe, expect, it } from 'vitest'
import type { InboxAdvancedFilters } from '../../modules/inbox/inbox-ui-helpers'
import { serializeAdvancedFiltersForServer } from './inbox-advanced-filter-engine'
import { serializeInboxFiltersForServer } from './inbox-filter-catalog-runtime'

/**
 * The Advanced Filters sheet stores choices under catalog keys. The legacy
 * serializer alone dropped them, so Apply sent no `advanced` param and the
 * "Filtered" list was the unfiltered list (Stage = ownership_check showed S5
 * Offer rows). These pin the payload the Inbox now sends.
 */
describe('serializeInboxFiltersForServer', () => {
  it('carries a catalog Stage choice the legacy serializer dropped', () => {
    const filters = { stage: 'ownership_check' } as unknown as InboxAdvancedFilters
    expect(serializeAdvancedFiltersForServer(filters, { stage: 'all_stages', view: 'all_messages' as never })).toEqual({})
    expect(serializeInboxFiltersForServer(filters, { stage: 'all_stages', view: 'all_messages' as never })).toEqual({ stage: 'ownership_check' })
  })

  it('carries status, intent, read state and county', () => {
    const filters = { status: ['active'], intent: 'interested', isRead: 'no', county: 'Hennepin' } as unknown as InboxAdvancedFilters
    const out = serializeInboxFiltersForServer(filters)
    expect(out).toMatchObject({ status: 'active', intent: 'interested', isRead: 'no', county: 'Hennepin' })
  })

  it('an explicit header stage still wins over the sheet', () => {
    const filters = { stage: 'ownership_check' } as unknown as InboxAdvancedFilters
    expect(serializeInboxFiltersForServer(filters, { stage: 'S2' })).toMatchObject({ stage: 'S2' })
  })

  it('no choices serialise to an empty payload (no advanced param)', () => {
    expect(serializeInboxFiltersForServer({ outOfStateOwner: 'all' } as InboxAdvancedFilters, { stage: 'all_stages' })).toEqual({})
  })

  it('keeps the legacy keys it always sent', () => {
    const filters = { market: 'Dallas', outOfStateOwner: 'yes', sellerStage: 'S3' } as unknown as InboxAdvancedFilters
    expect(serializeInboxFiltersForServer(filters)).toMatchObject({ market: 'Dallas', absenteeOwner: true, stage: 'S3' })
  })
})
