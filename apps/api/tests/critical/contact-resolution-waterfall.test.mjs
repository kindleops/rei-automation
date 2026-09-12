import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveNextContactAction,
  rankPhones,
  evaluatePhoneEligibility,
  normalizePhoneKey,
  S1_CONTACT_OUTCOME,
  RESOLUTION_ACTION,
  CONTACT_PROPERTY_ROLE,
  PROPERTY_CONTACT_STATE,
} from '@/lib/domain/seller-flow/contact-resolution-waterfall.js'
import {
  planReferralExecution,
  applyPlanToGraph,
  validateReferral,
  buildReferralIdentityKey,
  REFERRAL_EXECUTION_STATUS,
  REFERRAL_INVALID_REASON,
} from '@/lib/domain/seller-flow/referral-proposal-executor.js'
import { ACQUISITION_LIFECYCLE_EVENTS as EV, isKnownLifecycleEvent } from '@/lib/domain/seller-flow/acquisition-lifecycle-events.js'
import { resolveFollowUpPlan } from '@/lib/domain/seller-flow/seller-followup-scheduler.js'

/**
 * V2-1 — S1 contact resolution.
 *
 * The invariant under test throughout: a wrong contact disqualifies a
 * CONTACT-PROPERTY PAIR and never the property.
 */

const W = (over = {}) => ({ phone_type: 'W', is_valid: true, ...over })

const PROPERTY = 'prop-1'
const A = '+13050000001'
const B = '+13050000002'
const C = '+13050000003'

const phonePool = () => [
  W({ phone_e164: A, is_best_phone_for_owner: true, best_phone_score: 90 }),
  W({ phone_e164: B, best_phone_score: 70, contact_rank_position: 2 }),
  W({ phone_e164: C, best_phone_score: 50, contact_rank_position: 3 }),
]

const eventTypes = (r) => r.events.map((e) => e.type)

// ── Core invariant ─────────────────────────────────────────────────────────

test('V2-1 INVARIANT: a wrong contact never terminates the property', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
  })
  assert.equal(r.property_opportunity_terminated, false)
  assert.equal(r.contact_property_role, CONTACT_PROPERTY_ROLE.NOT_OWNER)
  assert.notEqual(r.property_contact_state, 'dead')
})

test('V2-1: the rejection is scoped to the pair, never global', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
  })
  const rejected = r.events.find((e) => e.type === EV.OWNERSHIP_CONTACT_REJECTED)
  assert.equal(rejected.data.scope, 'contact_property_pair')
  assert.equal(rejected.data.invalidate_globally, false)
})

// ── Wrong person → next phone ──────────────────────────────────────────────

test('V2-1: wrong person on A selects B and keeps the property active', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
  })
  assert.equal(r.action, RESOLUTION_ACTION.START_NEXT_PHONE)
  assert.equal(r.next_contact.phone_e164, B)
  assert.equal(r.next_contact.start_stage, 'ownership_confirmation')
  assert.equal(r.property_contact_state, PROPERTY_CONTACT_STATE.RESOLUTION_PENDING)
  assert.ok(eventTypes(r).includes(EV.NEXT_PHONE_SELECTED))
})

test('V2-1: the rejected contact is never reselected', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
    rejected_phones: [A],
  })
  assert.notEqual(r.next_contact.phone_e164, A)
})

test('V2-1: B suppressed → C is selected and B is never attempted', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
    suppressed_phones: [B],
  })
  assert.equal(r.next_contact.phone_e164, C)
  const bVerdict = r.considered.find((c) => c.phone_e164 === B)
  assert.equal(bVerdict.eligible, false)
  assert.equal(bVerdict.reason, 'suppressed_or_dnc')
})

test('V2-1: a wrong-number-history phone is skipped', () => {
  const phones = [W({ phone_e164: B, wrong_number_at: '2026-01-01T00:00:00Z' }), W({ phone_e164: C })]
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A, phones,
  })
  assert.equal(r.next_contact.phone_e164, C)
})

test('V2-1: a landline is not SMS-eligible', () => {
  const v = evaluatePhoneEligibility({ phone_e164: B, phone_type: 'L' }, {})
  assert.equal(v.eligible, false)
  assert.equal(v.reason, 'not_sms_capable')
})

test('V2-1: unknown phone type is not assumed textable', () => {
  const v = evaluatePhoneEligibility({ phone_e164: B }, {})
  assert.equal(v.eligible, false)
  assert.equal(v.reason, 'sms_capability_unknown')
})

test('V2-1: a phone already in an active thread is not duplicated', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A,
    phones: phonePool(), active_thread_phones: [B],
  })
  assert.equal(r.next_contact.phone_e164, C)
})

// ── Ranking is canonical, not array order ──────────────────────────────────

test('V2-1: ranking prefers owner-best over array order', () => {
  const ranked = rankPhones([
    W({ phone_e164: C, best_phone_score: 10 }),
    W({ phone_e164: A, is_best_phone_for_owner: true, best_phone_score: 5 }),
  ])
  assert.equal(ranked[0].key, A)
})

test('V2-1: a missing rank sorts last rather than first', () => {
  const ranked = rankPhones([
    W({ phone_e164: C }),
    W({ phone_e164: B, contact_rank_position: 1 }),
  ])
  assert.equal(ranked[0].key, B)
})

test('V2-1: duplicate normalized phones collapse to one candidate', () => {
  const ranked = rankPhones([
    W({ phone_e164: '+13050000002' }),
    W({ phone_e164: '(305) 000-0002' }),
  ])
  assert.equal(ranked.length, 1)
})

test('V2-1: phone normalization is stable across formats', () => {
  assert.equal(normalizePhoneKey('(305) 000-0002'), B)
  assert.equal(normalizePhoneKey('13050000002'), B)
  assert.equal(normalizePhoneKey('305-000-0002'), B)
})

// ── Email fallback ─────────────────────────────────────────────────────────

test('V2-1: no eligible phones → email fallback, and no SMS work', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: A,
    phones: [W({ phone_e164: B, dnc: true })],
    emails: [{ email: 'owner@example.com' }],
  })
  assert.equal(r.action, RESOLUTION_ACTION.EMAIL_FALLBACK)
  assert.equal(r.next_contact.channel, 'email')
  assert.equal(r.next_contact.email, 'owner@example.com')
  assert.ok(eventTypes(r).includes(EV.PHONE_POOL_EXHAUSTED))
  assert.ok(eventTypes(r).includes(EV.EMAIL_FALLBACK_SELECTED))
})

test('V2-1: email fallback fails closed to review (runtime unapproved)', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A,
    phones: [], emails: [{ email: 'owner@example.com' }],
  })
  assert.equal(r.requires_review, true)
  assert.equal(r.review_reason, 'email_outreach_runtime_not_approved')
})

test('V2-1: a suppressed or bounced email is not selected', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A, phones: [],
    emails: [{ email: 'bounced@example.com', bounced: true }, { email: 'sup@example.com' }],
    suppressed_emails: ['sup@example.com'],
  })
  assert.equal(r.action, RESOLUTION_ACTION.EXHAUSTED)
})

// ── Exhaustion ─────────────────────────────────────────────────────────────

test('V2-1: all channels exhausted → review, NOT seller-not-interested', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A,
    phones: [], emails: [],
  })
  assert.equal(r.action, RESOLUTION_ACTION.EXHAUSTED)
  assert.equal(r.property_contact_state, PROPERTY_CONTACT_STATE.EXHAUSTED)
  assert.equal(r.seller_interest_implied, null, 'exhaustion must not imply seller appetite')
  assert.equal(r.property_opportunity_terminated, false)
  assert.ok(eventTypes(r).includes(EV.CONTACT_RESOLUTION_EXHAUSTED))
})

// ── Referral beats the pool ────────────────────────────────────────────────

test('V2-1: an explicit referral outranks the next enrichment phone', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.REFERRAL,
    property_id: PROPERTY,
    current_phone: A,
    phones: phonePool(),
    referral: { referred_phone_e164: '+13055551234', referred_name: 'John' },
  })
  assert.equal(r.action, RESOLUTION_ACTION.START_REFERRED_CONTACT)
  assert.equal(r.next_contact.phone_e164, '+13055551234')
  assert.notEqual(r.next_contact.phone_e164, B, 'must not contact B before the referral')
  assert.equal(r.next_contact.origin, 'referral')
})

test('V2-1: the referred thread never merges into the source timeline', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.REFERRAL, property_id: PROPERTY, current_phone: A,
    referral: { referred_phone_e164: '+13055551234' },
  })
  assert.equal(r.next_contact.merge_with_parent_timeline, false)
  assert.equal(r.next_contact.start_stage, 'ownership_confirmation')
})

// ── Former owner ───────────────────────────────────────────────────────────

test('V2-1: a former owner is distinguished from a never-owner', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.FORMER_OWNER, property_id: PROPERTY, current_phone: A, phones: phonePool(),
  })
  assert.equal(r.contact_property_role, CONTACT_PROPERTY_ROLE.FORMER_OWNER)
  assert.equal(r.action, RESOLUTION_ACTION.START_NEXT_PHONE)
  assert.equal(r.property_opportunity_terminated, false)
})

// ── Opt-out is compliance, not a waterfall trigger ─────────────────────────

test('V2-1 COMPLIANCE: STOP suppresses and does NOT cycle to the next phone', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.OPT_OUT, property_id: PROPERTY, current_phone: A, phones: phonePool(),
  })
  assert.equal(r.action, RESOLUTION_ACTION.SUPPRESSED)
  assert.equal(r.waterfall_invoked, false)
  assert.equal(r.next_contact, null, 'STOP must never select a next contact')
  assert.equal(r.suppression.reason, 'opt_out')
})

test('V2-1: STOP emits no next-phone or referral event', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.OPT_OUT, property_id: PROPERTY, current_phone: A, phones: phonePool(),
  })
  const types = eventTypes(r)
  assert.ok(!types.includes(EV.NEXT_PHONE_SELECTED))
  assert.ok(!types.includes(EV.OWNER_REFERRAL_RECEIVED))
})

test('V2-1: owner confirmed needs no resolution', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.OWNER_CONFIRMED, property_id: PROPERTY, current_phone: A, phones: phonePool(),
  })
  assert.equal(r.action, RESOLUTION_ACTION.CONTINUE_CURRENT)
  assert.equal(r.contact_property_role, CONTACT_PROPERTY_ROLE.CONFIRMED_OWNER)
})

// ── Events are part of the existing vocabulary ─────────────────────────────

test('V2-1: every emitted event is a known lifecycle type', () => {
  const r = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER, property_id: PROPERTY, current_phone: A, phones: [], emails: [],
  })
  for (const e of r.events) {
    assert.equal(isKnownLifecycleEvent(e.type), true, `${e.type} is not in the canonical enum`)
    assert.equal(e.is_known_type, true)
  }
})

// ── No hidden sends ────────────────────────────────────────────────────────

test('V2-1: the resolver has no outbound side effect in any branch', () => {
  for (const outcome of Object.values(S1_CONTACT_OUTCOME)) {
    const r = resolveNextContactAction({
      outcome, property_id: PROPERTY, current_phone: A, phones: phonePool(),
      emails: [{ email: 'o@example.com' }], referral: { referred_phone_e164: '+13055551234' },
    })
    assert.equal(r.sent, undefined)
    assert.equal(r.queued, undefined)
    if (r.next_contact) assert.notEqual(r.next_contact.send_message, true)
  }
})

// ── Referral executor ──────────────────────────────────────────────────────

const REFERRAL = {
  id: 'ref-1',
  property_id: PROPERTY,
  source_contact_phone: A,
  referred_phone_e164: '+13055551234',
  referred_name: 'John Smith',
  relationship_claim: 'family_member',
}

test('V2-1: a referral plan creates a distinct contact, link and child thread', () => {
  const plan = planReferralExecution(REFERRAL, {})
  assert.equal(plan.status, REFERRAL_EXECUTION_STATUS.EXECUTED)
  assert.equal(plan.creates_contact, true)
  assert.equal(plan.creates_thread, true)
  assert.equal(plan.sends, 0)
  const thread = plan.operations.find((o) => o.op === 'create_child_thread')
  assert.equal(thread.merge_with_parent_timeline, false)
  assert.equal(thread.start_stage, 'ownership_confirmation')
  assert.equal(thread.send_message, false)
})

test('V2-1: the source contact is disqualified property-specifically', () => {
  const plan = planReferralExecution(REFERRAL, {})
  const mark = plan.operations.find((o) => o.op === 'mark_contact_property_non_owner')
  assert.equal(mark.scope, 'property_specific')
  assert.equal(mark.invalidate_globally, false)
})

test('V2-1 IDEMPOTENT: executing the same referral twice creates nothing new', () => {
  const first = planReferralExecution(REFERRAL, {})
  const graph = applyPlanToGraph(first, {})
  const second = planReferralExecution(REFERRAL, graph)

  assert.equal(second.status, REFERRAL_EXECUTION_STATUS.REUSED)
  assert.equal(second.creates_contact, false)
  assert.equal(second.creates_thread, false)
  assert.equal(second.identity_key, first.identity_key)

  const after = applyPlanToGraph(second, graph)
  assert.equal(after.contacts.length, 1)
  assert.equal(after.threads.length, 1)
  assert.equal(after.property_links.length, 1)
})

test('V2-1: a referral to an existing contact reuses that identity', () => {
  const graph = {
    contacts: [{ phone_e164: '+13055551234', prospect_id: 'existing-1' }],
    property_links: [],
    threads: [],
  }
  const plan = planReferralExecution(REFERRAL, graph)
  assert.equal(plan.creates_contact, false)
  const reuse = plan.operations.find((o) => o.op === 'reuse_contact')
  assert.equal(reuse.prospect_id, 'existing-1')
  assert.equal(plan.creates_link, true, 'property link is still required')
})

test('V2-1: a self-referral is refused rather than looping', () => {
  const v = validateReferral({ property_id: PROPERTY, source_contact_phone: A, referred_phone_e164: A })
  assert.equal(v.valid, false)
  assert.equal(v.reason, REFERRAL_INVALID_REASON.SELF_REFERRAL)
})

test('V2-1: a referral cannot launder a suppressed number back into outreach', () => {
  const v = validateReferral(REFERRAL, { suppressed_keys: new Set(['+13055551234']) })
  assert.equal(v.valid, false)
  assert.equal(v.reason, REFERRAL_INVALID_REASON.SUPPRESSED_TARGET)
})

test('V2-1: a name-only referral still gets a stable identity key', () => {
  const k1 = buildReferralIdentityKey({ property_id: PROPERTY, referred_name: 'Jane  Doe' })
  const k2 = buildReferralIdentityKey({ property_id: PROPERTY, referred_name: 'jane doe' })
  assert.equal(k1, k2)
  assert.ok(k1.includes('name:'))
})

test('V2-1: a referral with neither phone nor name is invalid', () => {
  const v = validateReferral({ property_id: PROPERTY, source_contact_phone: A })
  assert.equal(v.valid, false)
  assert.equal(v.reason, REFERRAL_INVALID_REASON.NO_CONTACT_POINT)
})

// ── Scheduler scope split ──────────────────────────────────────────────────

test('V2-1 §7: property_specific_non_owner suppresses the PAIR, not the property', () => {
  const r = resolveFollowUpPlan('property_specific_non_owner')
  assert.equal(r.suppressed, true)
  assert.equal(r.suppression_scope, 'contact_property_pair')
  assert.equal(r.property_opportunity_terminated, false)
  assert.equal(r.property_contact_state, 'contact_resolution_pending')
  assert.equal(r.contact_resolution_required, true)
})

test('V2-1 §7: opt_out stays channel compliance and does not request resolution', () => {
  const r = resolveFollowUpPlan('opt_out')
  assert.equal(r.suppressed, true)
  assert.equal(r.suppression_scope, 'channel_compliance')
  assert.equal(r.contact_resolution_required, false)
})
