/**
 * THE OPERATOR-FACING WORDING CARRIES THE SAME DISTINCTION THE BACKEND DOES.
 *
 * The server keeps "blocked before the provider" separate from "the carrier
 * refused it". If the surface collapses them into "Failed", the distinction is
 * lost exactly where it matters — a blocked row invites a retry that has
 * nothing to retry, and hides a compliance stop behind a transport error.
 */
import { describe, expect, it } from 'vitest'
import { describeBlockedReason, describeOutreachStatus } from './buyer-outreach-client'

describe('outreach status wording', () => {
  it('never presents a pre-provider block as a carrier failure', () => {
    expect(describeOutreachStatus({ status: 'blocked', blocked_reason: 'suppressed' }))
      .toBe('Blocked — Suppressed')
    expect(describeOutreachStatus({ status: 'deferred', blocked_reason: 'sender_eligibility_unavailable' }))
      .toBe('Held — sender eligibility unavailable')

    const failed = describeOutreachStatus({ status: 'failed', blocked_reason: null })
    expect(failed).toBe('Failed at the carrier')
    expect(failed).not.toContain('Blocked')
  })

  it('distinguishes never-queued from queued', () => {
    expect(describeOutreachStatus({ status: 'planned', blocked_reason: null })).toBe('Not yet queued')
    expect(describeOutreachStatus({ status: 'queued', blocked_reason: null })).toBe('Queued')
  })

  it('renders every reason in words, never a raw slug', () => {
    expect(describeBlockedReason('no_contact_on_record')).toBe('No contact on record')
    expect(describeBlockedReason('buyer_do_not_contact')).toBe('Marked do-not-contact')
    // Even an unmapped reason is humanised rather than shown as machine text.
    expect(describeBlockedReason('some_new_reason')).toBe('some new reason')
  })
})
