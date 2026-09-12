/**
 * V2-1 — REFERRAL PROPOSAL EXECUTOR.
 *
 * `buildReferralProposedOperations()` already produces exactly the right
 * operations — mark the source contact non-owner for THIS property, link the
 * referred phone, create/link the prospect, open a CHILD thread that does not
 * merge into the parent timeline, and route that thread to S1. They were named
 * `propose_*` and nothing ever consumed them, so five real referrals have been
 * sitting in `seller_contact_referrals` at `pending_review` doing nothing.
 *
 * So this is an EXECUTOR for the existing proposal object, not a second
 * referral system. It reads the operations that module already emits; it does
 * not re-derive them, and it invents no new proposal vocabulary.
 *
 * IDEMPOTENCY IS THE WHOLE PROBLEM. A referral executed twice must not produce
 * two people. The identity key is (property_id, normalized referred phone) —
 * or, when the referral carries only a name, (property_id, lowercased name).
 * Re-execution resolves to the SAME contact, the same property link and the
 * same thread, and reports `reused: true` rather than doing the work again.
 *
 * NO SENDS. Planning a child thread at S1 is not outbound work. The plan is
 * handed to governed outbound planning, which applies template governance,
 * compliance and send authority on its own. Nothing here can text anyone.
 */

import { ACQUISITION_LIFECYCLE_EVENTS as EV, buildLifecycleEvent } from './acquisition-lifecycle-events.js'
import { normalizePhoneKey } from './contact-resolution-waterfall.js'

const clean = (value) => String(value ?? '').trim()

export const REFERRAL_EXECUTION_STATUS = Object.freeze({
  EXECUTED: 'executed',
  REUSED: 'reused',
  INVALID: 'invalid',
  SKIPPED: 'skipped',
})

export const REFERRAL_INVALID_REASON = Object.freeze({
  NO_PROPERTY: 'referral_missing_property',
  NO_CONTACT_POINT: 'referral_missing_phone_and_name',
  SELF_REFERRAL: 'referral_points_at_source_contact',
  SUPPRESSED_TARGET: 'referred_contact_suppressed',
})

/**
 * Deterministic identity for a referral within a property.
 *
 * Phone wins when present because it is the stronger identifier; a name-only
 * referral still gets a stable key so repeated execution cannot fork it.
 */
export function buildReferralIdentityKey({ property_id, referred_phone_e164, referred_name } = {}) {
  const property = clean(property_id)
  const phone = normalizePhoneKey(referred_phone_e164)
  if (phone) return `prop:${property}|phone:${phone}`
  const name = clean(referred_name).toLowerCase().replace(/\s+/g, ' ')
  return name ? `prop:${property}|name:${name}` : ''
}

/**
 * Validate a referral before any resolution work.
 *
 * A self-referral ("call me back on this number") is rejected: it would
 * disqualify the contact as non-owner and then immediately re-open the same
 * contact as the referred owner, which is a loop, not a resolution.
 */
export function validateReferral(referral = {}, context = {}) {
  if (!clean(referral.property_id)) {
    return { valid: false, reason: REFERRAL_INVALID_REASON.NO_PROPERTY }
  }

  const phone = normalizePhoneKey(referral.referred_phone_e164)
  const name = clean(referral.referred_name)
  if (!phone && !name) {
    return { valid: false, reason: REFERRAL_INVALID_REASON.NO_CONTACT_POINT }
  }

  if (phone && phone === normalizePhoneKey(referral.source_contact_phone)) {
    return { valid: false, reason: REFERRAL_INVALID_REASON.SELF_REFERRAL }
  }

  const suppressed = context.suppressed_keys instanceof Set ? context.suppressed_keys : new Set()
  if (phone && suppressed.has(phone)) {
    // A referral cannot launder a suppressed number back into outreach.
    return { valid: false, reason: REFERRAL_INVALID_REASON.SUPPRESSED_TARGET }
  }

  return { valid: true, reason: null, identity_key: buildReferralIdentityKey(referral) }
}

/**
 * Plan the execution of one referral.
 *
 * Pure: it resolves against the contact graph SNAPSHOT the caller supplies and
 * returns the operations plus the lifecycle events. The caller persists.
 *
 * @param {object} referral   a `seller_contact_referrals` row (or equivalent)
 * @param {object} graph      { contacts: [{phone_e164, prospect_id, display_name}],
 *                              property_links: [{property_id, phone_e164}],
 *                              threads: [{property_id, phone_e164, thread_key}],
 *                              suppressed_keys: Set }
 */
export function planReferralExecution(referral = {}, graph = {}) {
  const verdict = validateReferral(referral, { suppressed_keys: graph.suppressed_keys })
  const propertyId = clean(referral.property_id) || null
  const referredPhone = normalizePhoneKey(referral.referred_phone_e164)
  const referredName = clean(referral.referred_name) || null
  const sourcePhone = normalizePhoneKey(referral.source_contact_phone)

  const entities = {
    property_id: propertyId,
    master_owner_id: clean(referral.master_owner_id) || null,
  }
  const events = []

  if (!verdict.valid) {
    return {
      status: REFERRAL_EXECUTION_STATUS.INVALID,
      reason: verdict.reason,
      referral_id: clean(referral.id) || null,
      identity_key: null,
      operations: [],
      events,
      creates_contact: false,
      creates_thread: false,
      sends: 0,
    }
  }

  const identityKey = verdict.identity_key

  // ── Resolve against the existing graph (reuse beats create) ──────────────
  const contacts = Array.isArray(graph.contacts) ? graph.contacts : []
  const existingContact = referredPhone
    ? contacts.find((c) => normalizePhoneKey(c?.phone_e164 ?? c?.canonical_e164 ?? c?.phone) === referredPhone)
    : contacts.find((c) => clean(c?.display_name).toLowerCase() === clean(referredName).toLowerCase() && referredName)

  const links = Array.isArray(graph.property_links) ? graph.property_links : []
  const linkExists = links.some(
    (l) => clean(l?.property_id) === propertyId &&
      normalizePhoneKey(l?.phone_e164) === referredPhone && referredPhone
  )

  const threads = Array.isArray(graph.threads) ? graph.threads : []
  const existingThread = threads.find(
    (t) => clean(t?.property_id) === propertyId &&
      normalizePhoneKey(t?.phone_e164) === referredPhone && referredPhone
  )

  const operations = []

  // The source contact is disqualified for THIS property only. Scope is stated
  // on the operation so no consumer can widen it into a global invalidation.
  operations.push({
    op: 'mark_contact_property_non_owner',
    phone_e164: sourcePhone,
    property_id: propertyId,
    scope: 'property_specific',
    invalidate_globally: false,
  })

  if (!existingContact) {
    operations.push({
      op: 'create_contact',
      phone_e164: referredPhone || null,
      display_name: referredName,
      identity_key: identityKey,
      idempotent: true,
    })
  } else {
    operations.push({
      op: 'reuse_contact',
      phone_e164: referredPhone || null,
      prospect_id: clean(existingContact.prospect_id) || null,
      identity_key: identityKey,
    })
  }

  if (!linkExists) {
    operations.push({
      op: 'link_contact_to_property',
      phone_e164: referredPhone || null,
      property_id: propertyId,
      relationship: clean(referral.relationship_claim) || null,
      referral_source: 'contact_referral',
      idempotent: true,
    })
  }

  if (!existingThread) {
    operations.push({
      op: 'create_child_thread',
      parent_thread_key: clean(referral.source_thread_key) || sourcePhone || null,
      child_phone_e164: referredPhone || null,
      child_display_name: referredName,
      property_id: propertyId,
      start_stage: 'ownership_confirmation',
      // The referred person is a DIFFERENT human. Merging their thread into
      // the source contact's timeline would attribute the source contact's
      // statements to them.
      merge_with_parent_timeline: false,
      // Planning a thread is not authorization to speak in it.
      send_message: false,
      idempotent: true,
    })
  }

  operations.push({
    op: 'mark_referral_executed',
    referral_id: clean(referral.id) || null,
    identity_key: identityKey,
    idempotent: true,
  })

  const reused = Boolean(existingContact) && Boolean(existingThread)

  events.push(buildLifecycleEvent(EV.REFERRED_CONTACT_LINKED, {
    entities,
    data: {
      identity_key: identityKey,
      referred_phone_e164: referredPhone || null,
      referred_name: referredName,
      relationship: clean(referral.relationship_claim) || null,
      source_contact_phone: sourcePhone,
      reused_existing_contact: Boolean(existingContact),
      reused_existing_thread: Boolean(existingThread),
      start_stage: 'ownership_confirmation',
      property_opportunity_terminated: false,
    },
  }))

  return {
    status: reused ? REFERRAL_EXECUTION_STATUS.REUSED : REFERRAL_EXECUTION_STATUS.EXECUTED,
    reason: null,
    referral_id: clean(referral.id) || null,
    identity_key: identityKey,
    operations,
    events,
    creates_contact: !existingContact,
    creates_link: !linkExists,
    creates_thread: !existingThread,
    // Stated explicitly so a caller can assert the no-send property from the
    // return value alone.
    sends: 0,
  }
}

/**
 * Apply a plan to a mutable graph snapshot.
 *
 * Exists so idempotency is provable in a test without a database: plan, apply,
 * plan again, and the second plan must report reuse and create nothing.
 */
export function applyPlanToGraph(plan, graph = {}) {
  const next = {
    contacts: [...(graph.contacts || [])],
    property_links: [...(graph.property_links || [])],
    threads: [...(graph.threads || [])],
    suppressed_keys: graph.suppressed_keys,
    executed_referral_ids: new Set(graph.executed_referral_ids || []),
  }

  for (const op of plan.operations || []) {
    if (op.op === 'create_contact') {
      next.contacts.push({ phone_e164: op.phone_e164, display_name: op.display_name, prospect_id: op.identity_key })
    }
    if (op.op === 'link_contact_to_property') {
      next.property_links.push({ property_id: op.property_id, phone_e164: op.phone_e164 })
    }
    if (op.op === 'create_child_thread') {
      next.threads.push({
        property_id: op.property_id,
        phone_e164: op.child_phone_e164,
        thread_key: `${op.property_id}:${op.child_phone_e164}`,
      })
    }
    if (op.op === 'mark_referral_executed' && op.referral_id) {
      next.executed_referral_ids.add(op.referral_id)
    }
  }

  return next
}

export default planReferralExecution
