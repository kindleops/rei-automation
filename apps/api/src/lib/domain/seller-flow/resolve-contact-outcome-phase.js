/**
 * V2-1B — contact-resolution phase, wired into the live inbound path.
 *
 * Sits immediately after `runInboundIntelligencePhase` in
 * `process-seller-inbound-message.js`, which is the one place the canonical
 * relationship outcome becomes available. This is NOT a second inbound path:
 * it consumes the relationship the existing phase already resolved and adds
 * the durable contact-graph consequence that was previously missing.
 *
 *     inbound evidence
 *       → classify / extract            (existing)
 *       → relationship resolution       (existing)
 *       → PERSIST contact×property outcome     (here)
 *       → pure waterfall decision              (here)
 *       → planned next action / referral plan  (here)
 *       → governed outbound planning    (existing, downstream)
 *
 * NOTHING HERE SENDS. Every action it returns carries send_message:false and
 * requires_review:true. Deciding WHO is next is not permission to contact
 * them: the planned contact must still clear governance, prior-contact policy,
 * contact window, sender selection, suppression and queue authority
 * downstream, exactly as any other outbound would.
 */

import {
  resolveNextContactAction,
  S1_CONTACT_OUTCOME,
  RESOLUTION_ACTION,
  normalizePhoneKey,
} from './contact-resolution-waterfall.js'
import {
  loadPropertyResolutionState,
  recordContactOutcome,
  recordReferralExecution,
} from './contact-resolution-repository.js'
import { planReferralExecution } from './referral-proposal-executor.js'

const clean = (value) => String(value ?? '').trim()

/**
 * Canonical relationship outcomes → S1 contact outcomes.
 *
 * Keyed off the vocabulary `resolve-inbound-relationship.js` already emits, so
 * there is one relationship taxonomy rather than a parallel mapping table.
 */
export const RELATIONSHIP_TO_S1_OUTCOME = Object.freeze({
  property_specific_non_owner: S1_CONTACT_OUTCOME.NOT_OWNER,
  respondent_non_owner: S1_CONTACT_OUTCOME.NOT_OWNER,
  former_owner_respondent: S1_CONTACT_OUTCOME.FORMER_OWNER,
  property_specific_non_owner_with_referral: S1_CONTACT_OUTCOME.REFERRAL,
  non_owner_referral: S1_CONTACT_OUTCOME.REFERRAL,
  ownership_confirmed: S1_CONTACT_OUTCOME.OWNER_CONFIRMED,
})

/**
 * Decide the S1 contact outcome from the signals the pipeline already has.
 *
 * Opt-out is checked FIRST and independently of the relationship: compliance
 * outranks the contact graph, and a message can be both "not my house" and
 * "stop texting me". Treating that as a non-owner outcome would invoke the
 * waterfall off the back of an opt-out.
 */
export function deriveS1Outcome({ canonical_intent = null, relationship_outcome = null, referral_detected = false } = {}) {
  const intent = clean(canonical_intent).toLowerCase()
  if (intent === 'opt_out' || intent === 'unsubscribe' || intent === 'stop') {
    return S1_CONTACT_OUTCOME.OPT_OUT
  }

  const outcome = RELATIONSHIP_TO_S1_OUTCOME[clean(relationship_outcome)] || null
  if (outcome === S1_CONTACT_OUTCOME.NOT_OWNER && referral_detected) {
    return S1_CONTACT_OUTCOME.REFERRAL
  }
  return outcome
}

/**
 * Load the property's candidate phones from the contact graph.
 *
 * Returns [] on any read failure rather than a partial pool: selecting from
 * half a pool would pick a lower-ranked contact and look like a deliberate
 * decision. The caller fails closed on an empty pool.
 */
async function loadCandidatePhones(supabase, { master_owner_id, exclude_phone }) {
  const owner = clean(master_owner_id)
  if (!supabase || !owner) return []

  const { data, error } = await supabase
    .from('phones')
    .select('canonical_e164, phone_type, is_best_phone_for_owner, best_phone_score, contact_rank_position, contact_score_final, wrong_number_at, phone_contact_status, updated_at')
    .eq('master_owner_id', owner)
    .range(0, 99)

  if (error) return []

  const excludeKey = normalizePhoneKey(exclude_phone)
  return (Array.isArray(data) ? data : [])
    .map((row) => ({
      phone_e164: row.canonical_e164,
      phone_type: row.phone_type,
      is_best_phone_for_owner: row.is_best_phone_for_owner === true,
      best_phone_score: row.best_phone_score,
      contact_rank_position: row.contact_rank_position,
      contact_score_final: row.contact_score_final,
      wrong_number_at: row.wrong_number_at,
      updated_at: row.updated_at,
    }))
    .filter((p) => normalizePhoneKey(p.phone_e164) !== excludeKey)
}

/**
 * Run contact resolution for one inbound message.
 *
 * @returns {object} always includes `sends: 0`.
 */
export async function runContactResolutionPhase({
  supabaseClient = null,
  property_id = null,
  master_owner_id = null,
  prospect_id = null,
  inbound_from = null,
  canonical_intent = null,
  relationship = null,
  referral = null,
  source_message_id = null,
  source_thread_key = null,
  now = null,
} = {}) {
  const outcome = deriveS1Outcome({
    canonical_intent,
    relationship_outcome: relationship?.relationship_outcome,
    referral_detected: Boolean(referral?.referral_detected),
  })

  const base = { ran: false, outcome: outcome || null, sends: 0, property_opportunity_terminated: false }

  if (!outcome) return { ...base, reason: 'no_s1_contact_outcome' }
  if (!supabaseClient) return { ...base, reason: 'no_supabase_client' }

  const property = clean(property_id)
  const phone = normalizePhoneKey(inbound_from)
  if (!property || !phone) return { ...base, reason: 'missing_property_or_phone' }

  // ── 1. Persist the contact×property outcome FIRST ────────────────────────
  // Before any selection. If the process dies immediately after this write,
  // the rejection is already durable and the next process will not re-select
  // this contact — which is the whole point of the increment.
  const persisted = await recordContactOutcome(supabaseClient, {
    property_id: property,
    contact_phone_e164: phone,
    outcome,
    master_owner_id,
    prospect_id,
    rejection_reason: clean(relationship?.relationship_claim) || null,
    suppression_scope:
      outcome === S1_CONTACT_OUTCOME.OPT_OUT ? 'channel_compliance' : 'contact_property_pair',
    source_message_id,
    source_thread_key,
    now,
  })

  if (!persisted.ok) {
    // Fail closed. Without a durable rejection we cannot guarantee the
    // waterfall will not loop, so we do not select a next contact at all.
    return { ...base, ran: true, reason: 'persist_failed', persist_error: persisted.reason, requires_review: true }
  }

  // ── 2. Owner confirmed / opt-out: no waterfall ───────────────────────────
  if (outcome === S1_CONTACT_OUTCOME.OWNER_CONFIRMED) {
    return { ...base, ran: true, persisted: true, action: RESOLUTION_ACTION.CONTINUE_CURRENT, contact_property_role: persisted.contact_property_role }
  }

  if (outcome === S1_CONTACT_OUTCOME.OPT_OUT) {
    // Suppression is recorded; the waterfall is deliberately NOT invoked.
    return {
      ...base,
      ran: true,
      persisted: true,
      action: RESOLUTION_ACTION.SUPPRESSED,
      waterfall_invoked: false,
      suppression_scope: 'channel_compliance',
      contact_property_role: persisted.contact_property_role,
    }
  }

  // ── 3. Durable exclusion set ─────────────────────────────────────────────
  const state = await loadPropertyResolutionState(supabaseClient, property)
  if (!state.ok) {
    return { ...base, ran: true, persisted: true, reason: 'resolution_state_unreadable', requires_review: true }
  }

  const phones = await loadCandidatePhones(supabaseClient, { master_owner_id, exclude_phone: phone })

  // ── 4. Pure decision ─────────────────────────────────────────────────────
  const decision = resolveNextContactAction({
    outcome,
    property_id: property,
    current_phone: phone,
    phones,
    emails: [],
    rejected_phones: state.rejected_phones,
    suppressed_phones: state.suppressed_phones,
    referral: referral?.referral_detected
      ? {
          referred_phone_e164: referral.referred_phone_e164,
          referred_name: referral.referred_name,
          relationship: referral.relationship_claim,
        }
      : null,
    entities: { master_owner_id, prospect_id },
    source_message_id,
    occurred_at: now,
  })

  // ── 5. Referral execution plan (idempotent, still no send) ───────────────
  let referral_execution = null
  if (decision.action === RESOLUTION_ACTION.START_REFERRED_CONTACT) {
    const plan = planReferralExecution(
      {
        id: referral?.id || null,
        property_id: property,
        source_contact_phone: phone,
        referred_phone_e164: referral?.referred_phone_e164,
        referred_name: referral?.referred_name,
        relationship_claim: referral?.relationship_claim,
        source_thread_key,
        master_owner_id,
      },
      {
        contacts: phones.map((p) => ({ phone_e164: p.phone_e164 })),
        property_links: [],
        threads: [],
        suppressed_keys: new Set(state.suppressed_phones),
      }
    )

    const written = plan.status === 'invalid'
      ? { ok: false, reason: plan.reason, reused: false }
      : await recordReferralExecution(supabaseClient, plan, {
          property_id: property,
          master_owner_id,
          source_message_id,
          source_thread_key,
          now,
        })

    referral_execution = {
      status: plan.status,
      reason: plan.reason || written.reason || null,
      identity_key: plan.identity_key,
      persisted: Boolean(written.ok),
      reused: Boolean(written.reused),
      sends: 0,
    }
  }

  return {
    ran: true,
    persisted: true,
    outcome,
    action: decision.action,
    contact_property_role: decision.contact_property_role,
    property_contact_state: decision.property_contact_state,
    // Pinned on the way out. Nothing downstream should have to re-derive that
    // a wrong contact left the opportunity alive.
    property_opportunity_terminated: false,
    next_contact: decision.next_contact
      ? {
          ...decision.next_contact,
          // V2-1B holds ALL resulting outreach. Resolution names the next
          // contact; it does not authorize speaking to them.
          send_message: false,
          automation_authority: 'review_hold',
        }
      : null,
    requires_review: true,
    referral_execution,
    events: decision.events,
    considered: decision.considered ?? null,
    sends: 0,
  }
}

export default runContactResolutionPhase
