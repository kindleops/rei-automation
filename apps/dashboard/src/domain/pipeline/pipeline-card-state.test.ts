import { describe, expect, it } from 'vitest'
import {
  resolveOpportunityAutomation,
  resolveOpportunityDisposition,
  resolveOpportunityNextAction,
  resolveOpportunityOfferState,
  resolveOpportunityStage,
} from './pipeline-card-state'

/**
 * PIPELINE-MOBILE-LOCK-1 — the card must read state, never invent it.
 *
 * Fixtures are shapes taken from `acquisition_opportunities` on 2026-09-15, not
 * imagined ones: `next_action` really is NULL on 130 of 264 active
 * opportunities, `no_action_contact_blocked` really does appear on rows whose
 * `opportunity_status` is still `active`, and every row currently reports
 * `automation_state` of `inactive`/`cancelled` with `workflow_state`
 * `not_enrolled`.
 *
 * Stage monotonicity and semantic stage skipping are NOT retested here — they
 * are enforced at the single backend writer and covered by 30 passing tests in
 * apps/api/tests/critical/ops1-ownership-invariant.test.mjs. Duplicating them
 * in the client would create the second stage authority §1 forbids.
 */

describe('stage badge', () => {
  it('reads the opportunity acquisition_stage', () => {
    expect(resolveOpportunityStage({ acquisition_stage: 'property_condition' })?.short).toBe('S4')
    expect(resolveOpportunityStage({ acquisition_stage: 'offer_interest' })?.short).toBe('S2')
    expect(resolveOpportunityStage({ acquisition_stage: 'closed' })?.short).toBe('S10')
  })

  /**
   * The defect this exists to prevent: normalizeLifecycleStage COERCES an empty
   * value to `ownership_confirmation`, and the lead command sheet printed
   * "S1 Ownership Check" for an S4 opportunity because both of its source
   * fields were undefined.
   */
  it('returns null rather than coercing an empty stage to S1', () => {
    expect(resolveOpportunityStage({})).toBeNull()
    expect(resolveOpportunityStage({ acquisition_stage: '' })).toBeNull()
    expect(resolveOpportunityStage({ acquisition_stage: null })).toBeNull()
    expect(resolveOpportunityStage(null)).toBeNull()
  })

  it('does not read a status as a stage', () => {
    // These are real `conversation_state` / legacy values, not stages.
    for (const notAStage of ['seller_replied', 'awaiting_response', 'needs_review', 'waiting', 'cold']) {
      expect(resolveOpportunityStage({ acquisition_stage: notAStage }), notAStage).toBeNull()
    }
  })
})

describe('disposition', () => {
  it('treats suppression as overriding everything', () => {
    const d = resolveOpportunityDisposition({
      opportunity_status: 'suppressed', universal_status: 'priority', conversation_state: 'seller_replied',
    })
    expect(d?.suppressed).toBe(true)
    expect(d?.tone).toBe('suppressed')
  })

  /**
   * 3 ACTIVE opportunities carry `next_action = no_action_contact_blocked`.
   * Reading only `opportunity_status` would show them as ordinary priority
   * leads and invite outreach that is blocked.
   */
  it('detects a blocked contact even when the status is still active', () => {
    const d = resolveOpportunityDisposition({
      opportunity_status: 'active', universal_status: 'priority',
      conversation_state: 'seller_replied', next_action: 'no_action_contact_blocked',
    })
    expect(d?.suppressed).toBe(true)
    expect(d?.label).toBe('No outreach')
  })

  it('separates Dead from suppressed', () => {
    const dead = resolveOpportunityDisposition({ opportunity_status: 'dead' })
    expect(dead?.label).toBe('Dead')
    expect(dead?.suppressed).toBe(false)
  })

  it('surfaces needs_review ahead of an ordinary reply', () => {
    expect(resolveOpportunityDisposition({
      opportunity_status: 'active', universal_status: 'needs_review', conversation_state: 'needs_review',
    })?.label).toBe('Needs review')
  })

  it('reports Waiting and Cold as dispositions, not stages', () => {
    expect(resolveOpportunityDisposition({ opportunity_status: 'active', universal_status: 'waiting' })?.label).toBe('Waiting')
    expect(resolveOpportunityDisposition({ opportunity_status: 'active', universal_status: 'cold' })?.label).toBe('Cold')
    // Neither carries a stage at all — the stage badge is resolved separately,
    // so a quiet seller cannot be pulled backwards by its disposition.
    expect(resolveOpportunityStage({ universal_status: 'cold' })).toBeNull()
  })

  it('says nothing when the row says nothing', () => {
    expect(resolveOpportunityDisposition({ opportunity_status: 'active' })).toBeNull()
  })
})

describe('next action', () => {
  it('prefers the real next_action column', () => {
    const a = resolveOpportunityNextAction({ next_action: 'send_message_now', next_action_due: '2026-09-12T18:00:00Z' })
    expect(a?.label).toBe('Reply now')
    expect(a?.derived).toBe(false)
    expect(a?.dueAt).toBe('2026-09-12T18:00:00Z')
  })

  /**
   * NULL on 130 of 264 active opportunities. A card that printed only the
   * column said nothing about half the pipeline.
   */
  it('derives from durable state when the column is null, and marks it derived', () => {
    const a = resolveOpportunityNextAction({
      opportunity_status: 'active', universal_status: 'priority', conversation_state: 'seller_replied', next_action: null,
    })
    expect(a?.label).toBe('Reply needed')
    expect(a?.derived).toBe(true)
  })

  it('never offers outreach for a suppressed opportunity', () => {
    const a = resolveOpportunityNextAction({ opportunity_status: 'suppressed', conversation_state: 'seller_replied' })
    expect(a?.label).toBe('No outreach — suppressed')
  })

  it('offers nothing at all for a dead opportunity', () => {
    expect(resolveOpportunityNextAction({ opportunity_status: 'dead', conversation_state: 'seller_replied' })).toBeNull()
  })

  it('humanises an action it has no label for rather than dropping it', () => {
    expect(resolveOpportunityNextAction({ next_action: 'some_future_backend_action' })?.label)
      .toBe('Some future backend action')
  })
})

describe('automation', () => {
  it('reports the real state and never claims Active', () => {
    // Every production row is inactive or cancelled with workflow not_enrolled.
    expect(resolveOpportunityAutomation({ automation_state: 'inactive', workflow_state: 'not_enrolled' })?.label)
      .toBe('Automation off')
    expect(resolveOpportunityAutomation({ automation_state: 'cancelled' })?.tone).toBe('cancelled')
  })

  it('names the workflow when one is actually enrolled', () => {
    expect(resolveOpportunityAutomation({ automation_state: 'active', workflow_state: 'seller_nurture' })?.label)
      .toBe('Automation · seller nurture')
  })

  it('says nothing for an unknown automation state', () => {
    expect(resolveOpportunityAutomation({})).toBeNull()
  })
})

describe('offer state', () => {
  it('orders execution state by what actually happened', () => {
    expect(resolveOpportunityOfferState({ accepted_offer_id: 'off_1' })?.label).toBe('Offer accepted')
    expect(resolveOpportunityOfferState({ seller_counter: 400000 })?.label).toBe('Counter received')
    expect(resolveOpportunityOfferState({ active_offer_id: 'off_2' })?.label).toBe('Offer sent')
    expect(resolveOpportunityOfferState({ recommended_offer: 62300 })?.label).toBe('Offer ready')
    expect(resolveOpportunityOfferState({ asking_price: 150000 })?.label).toBe('Asking price known')
  })

  it('treats a zero offer as no offer', () => {
    // current_offer is 0 on real rows rather than null.
    expect(resolveOpportunityOfferState({ current_offer: 0, asking_price: 0 })).toBeNull()
  })

  it('says nothing when there are no economics yet', () => {
    expect(resolveOpportunityOfferState({})).toBeNull()
  })
})
