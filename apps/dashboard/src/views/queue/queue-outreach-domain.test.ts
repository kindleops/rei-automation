/**
 * THE QUEUE MUST NOT CALL A BUYER AN UNKNOWN OWNER (§10, §11).
 */
import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../../domain/queue/queue.types'
import { describeBuyerQueueRow, isBuyerQueueRow, resolveQueueOutreachIdentity } from './queue-outreach-domain'
import { resolveSellerIdentity } from './queue-ui-helpers'

const row = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q1', queueId: 'q1', sellerName: '', sellerDisplayName: '', propertyAddress: '123 Main St',
  toPhoneNumber: '+13055550100', phone: '+13055550100', touchNumber: 1, linkedPropertyId: null,
  metadata: {}, ...over,
} as unknown as QueueItem)

describe('buyer rows are identified the same way the server identifies them', () => {
  it('recognises the send kind on the row and in metadata', () => {
    expect(isBuyerQueueRow(row({ metadata: { send_kind: 'buyer_disposition' } }))).toBe(true)
    expect(isBuyerQueueRow(row({ metadata: { outreach_domain: 'buyer' } }))).toBe(true)
  })

  it('leaves ordinary seller rows alone', () => {
    expect(isBuyerQueueRow(row())).toBe(false)
    expect(isBuyerQueueRow(row({ metadata: { source: 'campaign' } }))).toBe(false)
    expect(resolveQueueOutreachIdentity(row())).toBeNull()
  })
})

describe('identity resolution', () => {
  it('a buyer row is named as the buyer, NOT reported as a lost seller', () => {
    // Without the domain check every seller name source misses and the row
    // renders "Unknown owner" — a data defect that is not there.
    const identity = resolveSellerIdentity(row({
      metadata: { send_kind: 'buyer_disposition', buyer_name: 'Acme Capital', buyer_key: 'B1' },
    }))
    expect(identity.primary).toBe('Acme Capital')
    expect(identity.secondary).toBe('Buyer')
    expect(identity.primary).not.toBe('Unknown owner')
  })

  it('a buyer with no name falls back to its key, not to a seller placeholder', () => {
    expect(resolveSellerIdentity(row({
      metadata: { outreach_domain: 'buyer', buyer_key: 'B-77' },
    })).primary).toBe('B-77')
  })

  it('a nameless seller row keeps its existing fallback, not a buyer label', () => {
    // The buyer short-circuit must not change how seller rows resolve. This one
    // has no name, so it falls back to the phone number as it always did.
    const identity = resolveSellerIdentity(row())
    expect(identity.primary).toBe('+13055550100')
    expect(identity.secondary).not.toBe('Buyer')
  })

  it('a seller row with no name AND no phone still reads as an unknown owner', () => {
    expect(resolveSellerIdentity(row({ toPhoneNumber: '', phone: '' })).primary).toBe('Unknown owner')
  })
})

describe('what the row is for', () => {
  it('describes a buyer row by the property it disposes', () => {
    expect(describeBuyerQueueRow(row({
      metadata: { send_kind: 'buyer_disposition', buyer_name: 'Acme', subject_property_id: '2130387643', touch_number: 2 },
    }))).toBe('Buyer outreach about 2130387643 · touch 2')
  })

  it('has nothing to say about a seller row', () => {
    expect(describeBuyerQueueRow(row())).toBeNull()
  })
})
