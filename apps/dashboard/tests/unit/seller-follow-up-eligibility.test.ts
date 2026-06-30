import { describe, expect, it } from 'vitest'
import {
  hasPriorOutboundContact,
  resolveFollowUpEligibility,
} from '../../src/views/map/seller-card/seller-follow-up-eligibility'

const baseState = {
  threadKey: 'thread:abc123',
  messagingBlocked: false,
  messagingBlockReason: null,
  status: 'follow_up_due',
  suppressed: false,
  dnc: false,
  suppressionReason: null,
}

describe('seller follow-up eligibility', () => {
  it('blocks follow-up for uncontacted sellers', () => {
    const result = resolveFollowUpEligibility({
      outbound_count: 0,
      sent_count: 0,
      thread_key: 'property:123',
    }, {
      ...baseState,
      threadKey: 'property:123',
      status: 'awaiting_response',
    })

    expect(result.isUncontacted).toBe(true)
    expect(result.canExecute).toBe(true)
    expect(result.label).toBe('Send Ownership Check')
  })

  it('allows follow-up when contacted and due', () => {
    expect(hasPriorOutboundContact({
      outbound_count: 2,
      sent_count: 2,
      last_outbound_at: '2026-06-20T12:00:00.000Z',
      latest_direction: 'outbound',
    })).toBe(true)

    const contacted = resolveFollowUpEligibility({
      outbound_count: 2,
      sent_count: 2,
      last_outbound_at: '2026-06-20T12:00:00.000Z',
      canonical_e164: '+19015551234',
    }, baseState)

    expect(contacted.canExecute).toBe(true)
    expect(contacted.label).toBe('Follow Up')
  })

  it('blocks follow-up when not due for contacted sellers', () => {
    const result = resolveFollowUpEligibility({
      outbound_count: 3,
      sent_count: 3,
      last_outbound_at: '2026-06-20T12:00:00.000Z',
      canonical_e164: '+19015551234',
    }, {
      ...baseState,
      status: 'awaiting_response',
    })

    expect(result.canExecute).toBe(false)
    expect(result.disabledReason).toBe('Follow-up not due')
  })
})