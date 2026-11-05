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
import { attributeInbounds } from '../conversation-ai/property-facts.js'
import { questionKindOf } from '../conversation-ai/questions.js'

const clean = (value) => String(value ?? '').trim()

export const OWNERSHIP_UNRESOLVED_HOLD = 'ownership_denial_property_unresolved'

/** The thread's recent messages (both directions, with property ids), read-only. */
async function loadThreadMessages(supabaseClient, thread_key) {
  if (!supabaseClient?.from || !clean(thread_key)) return []
  const { data, error } = await supabaseClient
    .from('message_events')
    .select('id,direction,message_body,property_id,created_at,event_timestamp')
    .eq('thread_key', clean(thread_key))
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) throw Object.assign(new Error('thread_messages_unreadable'), { code: 'THREAD_MESSAGES_UNREADABLE' })
  return (Array.isArray(data) ? data : []).map((m) => ({ id: m.id, direction: m.direction, body: m.message_body || '', property_id: m.property_id || null, at: m.event_timestamp || m.created_at }))
}

/**
 * blind-eval S1 (SYN-34 / SCONV-03): WHICH property an ownership answer is about — the one
 * attribution rule (property-facts.js), never simply the inbound row's property. A reply naming a
 * property address answers that property; one bare answer to ownership questions about several
 * properties is UNATTRIBUTED (a thread hold, owner 10-17 rule).
 * @returns {Promise<{ property: string, ambiguous: boolean, basis: string }>}
 */
export async function attributeOwnershipAnswer({ supabaseClient = null, thread_key = null, property_id = null, source_message_id = null, inbound_body = null, want = null, loadMessages = loadThreadMessages } = {}) {
  const fallback = { property: clean(property_id), ambiguous: false, basis: 'inbound_row_property' }
  if (!clean(source_message_id) || !clean(thread_key)) return fallback
  let messages = await loadMessages(supabaseClient, thread_key)
  if (!messages.some((m) => String(m.id) === clean(source_message_id))) {
    // the inbound is not persisted yet: it is the thread's LATEST message (appended after every row)
    if (inbound_body == null) return fallback
    const last = Math.max(0, ...messages.map((m) => Date.parse(m.at || 0) || 0))
    messages = [...messages, { id: clean(source_message_id), direction: 'inbound', body: String(inbound_body), property_id: clean(property_id) || null, at: new Date(last + 1000).toISOString() }]
  }
  const att = attributeInbounds({ messages, questionKindOf }).get(clean(source_message_id))
  if (!att) return fallback
  if (att.ambiguous) return { property: '', ambiguous: true, basis: att.basis }
  // blind-eval v2 (MUL-03/04/10): several properties named, read clause by clause — a denial goes on
  // the property the DENYING clause names, a confirmation on the confirming one
  if (att.clauses?.length) {
    const pick = want ? att.clauses.find((c) => c.ownership === want) : null
    return { property: pick?.property || '', ambiguous: !pick && Boolean(want), basis: pick ? `clause_${want}` : 'per_clause', clauses: att.clauses }
  }
  return { property: att.property || clean(property_id), ambiguous: false, basis: att.property ? att.basis : 'inbound_row_property' }
}

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
  // OWNER DECISION 2026-10-17: the polite decline to the ownership question (ownership unverified)
  if (intent === 'ownership_declined_unverified' || intent === 'ownership_declined') {
    return S1_CONTACT_OUTCOME.OWNERSHIP_DECLINED
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
  loadThreadMessages: loadMessages = loadThreadMessages,
} = {}) {
  const outcome = deriveS1Outcome({
    canonical_intent,
    relationship_outcome: relationship?.relationship_outcome,
    referral_detected: Boolean(referral?.referral_detected),
  })

  const base = { ran: false, outcome: outcome || null, sends: 0, property_opportunity_terminated: false }

  if (!outcome) return { ...base, reason: 'no_s1_contact_outcome' }
  if (!supabaseClient) return { ...base, reason: 'no_supabase_client' }

  const phone = normalizePhoneKey(inbound_from)
  // the property this answer is ABOUT (an opt-out is channel-wide: no attribution needed)
  let property = clean(property_id)
  let attribution = null
  if (outcome !== S1_CONTACT_OUTCOME.OPT_OUT) {
    try {
      const want = outcome === S1_CONTACT_OUTCOME.OWNER_CONFIRMED ? 'confirmed' : [S1_CONTACT_OUTCOME.NOT_OWNER, S1_CONTACT_OUTCOME.FORMER_OWNER, S1_CONTACT_OUTCOME.OWNERSHIP_DECLINED].includes(outcome) ? 'denied' : null
      attribution = await attributeOwnershipAnswer({ supabaseClient, thread_key: source_thread_key, property_id, source_message_id, want, loadMessages })
    } catch {
      // unreadable thread: never guess a property for a denial — a person resolves it
      return { ...base, ran: true, reason: 'thread_unreadable_for_attribution', requires_review: true, hold: OWNERSHIP_UNRESOLVED_HOLD }
    }
    if (attribution.ambiguous) {
      // nothing is written to ANY property: the recontact guard holds the thread on the same evidence
      return { ...base, ran: true, persisted: false, action: RESOLUTION_ACTION.NONE, hold: OWNERSHIP_UNRESOLVED_HOLD, attribution, requires_review: true }
    }
    property = attribution.property
  }
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

  // ── 2a. Ownership declined (unverified): a property × contact HOLD — no waterfall, no rejection ──
  if (outcome === S1_CONTACT_OUTCOME.OWNERSHIP_DECLINED) {
    return { ...base, ran: true, persisted: true, action: RESOLUTION_ACTION.NONE, waterfall_invoked: false, hold: 'ownership_declined_unverified', suppression_scope: 'contact_property_pair', contact_property_role: persisted.contact_property_role, property_id: property, attribution }
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
    property_id: property,
    attribution,
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
