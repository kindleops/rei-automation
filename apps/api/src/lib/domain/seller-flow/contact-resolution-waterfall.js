/**
 * V2-1 — CONTACT RESOLUTION WATERFALL.
 *
 * THE INVARIANT THIS EXISTS TO ENFORCE:
 *
 *     a wrong contact  ≠  a dead property opportunity
 *
 * S1 ownership confirmation is performed against a CONTACT-PROPERTY
 * RELATIONSHIP, not against the property. One phone saying "I don't own that"
 * disqualifies that pairing and nothing else. The property then continues
 * through its remaining contact candidates.
 *
 * Before this module the two concepts were conflated: a property-scoped
 * non-owner reply routed to `permanent_suppression` in the follow-up
 * scheduler, and because no waterfall existed behind it the property simply
 * stopped — operationally identical to being killed, while looking like a
 * deliberate compliance outcome in the logs.
 *
 * WHAT THIS MODULE IS
 *   A pure function. Given the property's contact candidates, the outcome of
 *   the current contact, and any referral, it returns the NEXT ACTION and the
 *   lifecycle events that action implies.
 *
 * WHAT THIS MODULE IS NOT
 *   It does not text, email, enqueue, or write. §10 of the V2-1 brief requires
 *   resolution to be free of outbound side effects so it stays testable and
 *   cannot hide a send. The caller persists the outcome and hands the decision
 *   to governed outbound planning, which applies compliance and send authority
 *   independently.
 *
 * OPT-OUT IS NOT CONTACT-RESOLUTION EVIDENCE. "STOP" is a compliance event
 * about a channel. It must never be read as "this person is not the owner,
 * try the next number" — that would turn a legal suppression into an
 * acceleration. It terminates the waterfall for this turn and returns a
 * suppression action; whether the property may continue via an unrelated
 * contact is decided by canonical compliance policy elsewhere, never here.
 */

import { ACQUISITION_LIFECYCLE_EVENTS as EV, buildLifecycleEvent } from './acquisition-lifecycle-events.js'

const clean = (value) => String(value ?? '').trim()

/** Outcome of the CURRENT contact's S1 turn. */
export const S1_CONTACT_OUTCOME = Object.freeze({
  OWNER_CONFIRMED: 'owner_confirmed',
  NOT_OWNER: 'not_owner',
  FORMER_OWNER: 'former_owner',
  REFERRAL: 'referral',
  OPT_OUT: 'opt_out',
})

/** What the caller should do next. */
export const RESOLUTION_ACTION = Object.freeze({
  NONE: 'none',
  CONTINUE_CURRENT: 'continue_current_contact',
  START_REFERRED_CONTACT: 'start_referred_contact',
  START_NEXT_PHONE: 'start_next_phone',
  EMAIL_FALLBACK: 'email_fallback',
  EXHAUSTED: 'contact_resolution_exhausted',
  SUPPRESSED: 'contact_suppressed',
})

/** Role of a contact WITH RESPECT TO ONE PROPERTY. Never a property-level fact. */
export const CONTACT_PROPERTY_ROLE = Object.freeze({
  UNKNOWN: 'unknown',
  CONFIRMED_OWNER: 'confirmed_owner',
  NOT_OWNER: 'not_owner',
  FORMER_OWNER: 'former_owner',
  REFERRAL_SOURCE: 'referral_source',
  SUPPRESSED: 'suppressed',
})

/**
 * Property-level posture once the current contact is disqualified. This is the
 * state that replaces "dead": the opportunity is alive and waiting on contact
 * resolution.
 */
export const PROPERTY_CONTACT_STATE = Object.freeze({
  ACTIVE: 'active',
  RESOLUTION_PENDING: 'contact_resolution_pending',
  EXHAUSTED: 'contact_resolution_exhausted',
})

/** E.164-ish normalization so one human with one number never yields two threads. */
export function normalizePhoneKey(value) {
  const digits = clean(value).replace(/[^\d]/g, '')
  if (!digits) return ''
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`
}

function normalizeEmailKey(value) {
  return clean(value).toLowerCase()
}

/**
 * Is this phone eligible to be the NEXT contact for this property?
 *
 * Every condition is a refusal reason, and the first one that matches wins, so
 * a phone is never selected on a technicality. `already_active_thread` is
 * included because two live S1 threads to the same human about the same
 * property is a duplicate-contact defect, not diligence.
 */
export function evaluatePhoneEligibility(phone, context = {}) {
  const key = normalizePhoneKey(phone?.phone_e164 ?? phone?.canonical_e164 ?? phone?.phone)
  if (!key) return { eligible: false, reason: 'invalid_phone', key }

  const rejected = context.rejected_keys instanceof Set ? context.rejected_keys : new Set()
  const suppressed = context.suppressed_keys instanceof Set ? context.suppressed_keys : new Set()
  const activeKeys = context.active_thread_keys instanceof Set ? context.active_thread_keys : new Set()

  if (rejected.has(key)) return { eligible: false, reason: 'already_rejected_for_property', key }
  if (suppressed.has(key)) return { eligible: false, reason: 'suppressed_or_dnc', key }
  if (phone?.dnc === true) return { eligible: false, reason: 'suppressed_or_dnc', key }
  if (phone?.opted_out === true) return { eligible: false, reason: 'suppressed_or_dnc', key }
  if (phone?.wrong_number_at) return { eligible: false, reason: 'wrong_number_history', key }
  if (phone?.is_valid === false) return { eligible: false, reason: 'invalid_phone', key }

  // SMS capability. Absent information is NOT permission: a phone with no
  // known type cannot be asserted textable. Landline/VOIP are excluded.
  const type = clean(phone?.phone_type).toUpperCase()
  if (type && type !== 'W' && type !== 'WIRELESS' && type !== 'MOBILE') {
    return { eligible: false, reason: 'not_sms_capable', key }
  }
  if (!type && phone?.sms_capable !== true) {
    return { eligible: false, reason: 'sms_capability_unknown', key }
  }

  if (activeKeys.has(key)) return { eligible: false, reason: 'already_active_thread', key }
  if (phone?.prior_contact_blocked === true) {
    return { eligible: false, reason: 'prior_contact_policy', key }
  }

  return { eligible: true, reason: 'eligible', key }
}

/**
 * Canonical ranking. Deliberately NOT array order — enrichment arrays arrive in
 * whatever order the vendor emitted, so "first" carries no meaning.
 *
 * Reuses the ranking signals the phone graph already maintains rather than
 * inventing a score: owner-best flag, then the existing quality/confidence
 * score, then contact rank, then recency. Ties break on the normalized key so
 * selection is deterministic and a test can assert an exact choice.
 */
export function rankPhones(phones = []) {
  const scored = (Array.isArray(phones) ? phones : []).map((phone) => {
    const best = phone?.is_best_phone_for_owner === true ? 1 : 0
    const score = Number(phone?.best_phone_score ?? phone?.contact_score_final ?? phone?.phone_quality_score)
    const rank = Number(phone?.contact_rank_position)
    const seen = Date.parse(phone?.last_seen_at ?? phone?.updated_at ?? '') || 0
    return {
      phone,
      key: normalizePhoneKey(phone?.phone_e164 ?? phone?.canonical_e164 ?? phone?.phone),
      best,
      score: Number.isFinite(score) ? score : -Infinity,
      // A missing rank must sort LAST, not first — absent data is not a
      // recommendation.
      rank: Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER,
      seen,
    }
  })

  scored.sort((a, b) =>
    b.best - a.best ||
    b.score - a.score ||
    a.rank - b.rank ||
    b.seen - a.seen ||
    a.key.localeCompare(b.key)
  )

  // Deduplicate by normalized key: two contact records sharing a number are
  // one human and must yield one thread.
  const seenKeys = new Set()
  const deduped = []
  for (const entry of scored) {
    if (!entry.key || seenKeys.has(entry.key)) continue
    seenKeys.add(entry.key)
    deduped.push(entry)
  }
  return deduped
}

function buildKeySet(values, normalizer) {
  const out = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const key = normalizer(typeof value === 'string' ? value : value?.phone_e164 ?? value?.email ?? value)
    if (key) out.add(key)
  }
  return out
}

function evaluateEmailEligibility(email, context = {}) {
  const key = normalizeEmailKey(email?.email ?? email)
  if (!key || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) {
    return { eligible: false, reason: 'invalid_email', key }
  }
  const suppressed = context.suppressed_email_keys instanceof Set ? context.suppressed_email_keys : new Set()
  if (suppressed.has(key)) return { eligible: false, reason: 'suppressed_or_dnc', key }
  if (email?.bounced === true) return { eligible: false, reason: 'previously_bounced', key }
  if (email?.rejected_for_property === true) return { eligible: false, reason: 'already_rejected_for_property', key }
  return { eligible: true, reason: 'eligible', key }
}

/**
 * Resolve the next contact action for one property.
 *
 * @param {object} input
 * @param {string} input.outcome            one of S1_CONTACT_OUTCOME
 * @param {string} input.property_id
 * @param {string} input.current_phone      the contact that just replied
 * @param {object} [input.referral]         { referred_phone_e164, referred_name, relationship }
 * @param {Array}  [input.phones]           every candidate phone for the property
 * @param {Array}  [input.emails]           every candidate email
 * @param {Array}  [input.rejected_phones]  previously rejected for THIS property
 * @param {Array}  [input.suppressed_phones]
 * @param {Array}  [input.active_thread_phones]
 * @param {Array}  [input.suppressed_emails]
 * @param {object} [input.entities]         { master_owner_id, prospect_id, ... }
 * @returns {object} decision — never performs I/O
 */
export function resolveNextContactAction(input = {}) {
  const outcome = clean(input.outcome)
  const propertyId = clean(input.property_id) || null
  const currentKey = normalizePhoneKey(input.current_phone)
  const entities = { property_id: propertyId, ...(input.entities || {}) }
  const events = []
  const emit = (type, data, extra = {}) =>
    events.push(buildLifecycleEvent(type, {
      entities,
      data,
      occurred_at: input.occurred_at ?? null,
      source_message_id: input.source_message_id ?? null,
      ...extra,
    }))

  // ── Owner confirmed: no resolution needed ────────────────────────────────
  if (outcome === S1_CONTACT_OUTCOME.OWNER_CONFIRMED) {
    return {
      action: RESOLUTION_ACTION.CONTINUE_CURRENT,
      contact_property_role: CONTACT_PROPERTY_ROLE.CONFIRMED_OWNER,
      property_contact_state: PROPERTY_CONTACT_STATE.ACTIVE,
      property_opportunity_terminated: false,
      next_contact: null,
      events,
    }
  }

  // ── Opt-out: compliance, and explicitly NOT a waterfall trigger ──────────
  if (outcome === S1_CONTACT_OUTCOME.OPT_OUT) {
    return {
      action: RESOLUTION_ACTION.SUPPRESSED,
      contact_property_role: CONTACT_PROPERTY_ROLE.SUPPRESSED,
      // The property is not declared dead, but this module does not advance it
      // either. Any continuation is a compliance-policy decision made
      // elsewhere, never an inference drawn from the word "STOP".
      property_contact_state: PROPERTY_CONTACT_STATE.RESOLUTION_PENDING,
      property_opportunity_terminated: false,
      suppression: { scope: 'channel', phone_e164: currentKey, reason: 'opt_out' },
      waterfall_invoked: false,
      next_contact: null,
      events,
    }
  }

  const isNegative =
    outcome === S1_CONTACT_OUTCOME.NOT_OWNER ||
    outcome === S1_CONTACT_OUTCOME.FORMER_OWNER ||
    outcome === S1_CONTACT_OUTCOME.REFERRAL

  if (!isNegative) {
    return {
      action: RESOLUTION_ACTION.NONE,
      contact_property_role: CONTACT_PROPERTY_ROLE.UNKNOWN,
      property_contact_state: PROPERTY_CONTACT_STATE.ACTIVE,
      property_opportunity_terminated: false,
      next_contact: null,
      events,
    }
  }

  const role =
    outcome === S1_CONTACT_OUTCOME.FORMER_OWNER
      ? CONTACT_PROPERTY_ROLE.FORMER_OWNER
      : outcome === S1_CONTACT_OUTCOME.REFERRAL
        ? CONTACT_PROPERTY_ROLE.REFERRAL_SOURCE
        : CONTACT_PROPERTY_ROLE.NOT_OWNER

  // The rejection is recorded against the PAIR. Note the scope: this is the
  // fact that keeps the property alive.
  emit(EV.OWNERSHIP_CONTACT_REJECTED, {
    phone_e164: currentKey,
    property_id: propertyId,
    contact_property_role: role,
    scope: 'contact_property_pair',
    invalidate_globally: false,
    property_opportunity_terminated: false,
  })

  const base = {
    contact_property_role: role,
    property_opportunity_terminated: false,
    rejected_contact: { phone_e164: currentKey, role },
  }

  // ── 1. Explicit referral outranks any enrichment phone ───────────────────
  // A human naming the owner is better evidence than a vendor's ranking, so it
  // is tried before the pool regardless of the pool's scores.
  const referredPhone = normalizePhoneKey(input.referral?.referred_phone_e164)
  const referredName = clean(input.referral?.referred_name)
  if (outcome === S1_CONTACT_OUTCOME.REFERRAL && (referredPhone || referredName)) {
    emit(EV.OWNER_REFERRAL_RECEIVED, {
      referred_phone_e164: referredPhone || null,
      referred_name: referredName || null,
      relationship: clean(input.referral?.relationship) || null,
      source_contact_phone: currentKey,
      property_id: propertyId,
      referral_source: 'contact_referral',
    })
    return {
      ...base,
      action: RESOLUTION_ACTION.START_REFERRED_CONTACT,
      property_contact_state: PROPERTY_CONTACT_STATE.RESOLUTION_PENDING,
      next_contact: {
        channel: 'sms',
        phone_e164: referredPhone || null,
        display_name: referredName || null,
        relationship: clean(input.referral?.relationship) || null,
        origin: 'referral',
        start_stage: 'ownership_confirmation',
        merge_with_parent_timeline: false,
      },
      events,
    }
  }

  // ── 2/3. Next eligible phone, by canonical rank ──────────────────────────
  const rejectedKeys = buildKeySet(input.rejected_phones, normalizePhoneKey)
  // The contact that just replied is rejected from this point forward even if
  // the caller has not yet persisted it.
  if (currentKey) rejectedKeys.add(currentKey)
  const context = {
    rejected_keys: rejectedKeys,
    suppressed_keys: buildKeySet(input.suppressed_phones, normalizePhoneKey),
    active_thread_keys: buildKeySet(input.active_thread_phones, normalizePhoneKey),
  }

  const ranked = rankPhones(input.phones)
  const considered = []
  let selected = null
  for (const entry of ranked) {
    const verdict = evaluatePhoneEligibility(entry.phone, context)
    considered.push({ phone_e164: entry.key, eligible: verdict.eligible, reason: verdict.reason })
    if (verdict.eligible && !selected) selected = entry
  }

  if (selected) {
    emit(EV.NEXT_PHONE_SELECTED, {
      phone_e164: selected.key,
      property_id: propertyId,
      selection_basis: {
        is_best_phone_for_owner: selected.best === 1,
        score: Number.isFinite(selected.score) ? selected.score : null,
        rank: selected.rank === Number.MAX_SAFE_INTEGER ? null : selected.rank,
      },
      considered,
    })
    return {
      ...base,
      action: RESOLUTION_ACTION.START_NEXT_PHONE,
      property_contact_state: PROPERTY_CONTACT_STATE.RESOLUTION_PENDING,
      next_contact: {
        channel: 'sms',
        phone_e164: selected.key,
        origin: 'contact_graph',
        start_stage: 'ownership_confirmation',
        merge_with_parent_timeline: false,
      },
      considered,
      events,
    }
  }

  emit(EV.PHONE_POOL_EXHAUSTED, { property_id: propertyId, considered })

  // ── 4. Email fallback ────────────────────────────────────────────────────
  const emailContext = { suppressed_email_keys: buildKeySet(input.suppressed_emails, normalizeEmailKey) }
  const emailConsidered = []
  let selectedEmail = null
  for (const email of Array.isArray(input.emails) ? input.emails : []) {
    const verdict = evaluateEmailEligibility(email, emailContext)
    emailConsidered.push({ email: verdict.key, eligible: verdict.eligible, reason: verdict.reason })
    if (verdict.eligible && !selectedEmail) selectedEmail = verdict.key
  }

  if (selectedEmail) {
    emit(EV.EMAIL_FALLBACK_SELECTED, { email: selectedEmail, property_id: propertyId, considered: emailConsidered })
    return {
      ...base,
      action: RESOLUTION_ACTION.EMAIL_FALLBACK,
      property_contact_state: PROPERTY_CONTACT_STATE.RESOLUTION_PENDING,
      next_contact: {
        channel: 'email',
        email: selectedEmail,
        origin: 'contact_graph',
        start_stage: 'ownership_confirmation',
      },
      // Email outreach is not approved for autonomous use, so the action is
      // produced but fails closed to review rather than becoming sendable work.
      requires_review: true,
      review_reason: 'email_outreach_runtime_not_approved',
      considered,
      email_considered: emailConsidered,
      events,
    }
  }

  // ── 5. Exhausted — a review/enrichment state, NOT a seller rejection ─────
  emit(EV.CONTACT_RESOLUTION_EXHAUSTED, {
    property_id: propertyId,
    considered,
    email_considered: emailConsidered,
  })
  return {
    ...base,
    action: RESOLUTION_ACTION.EXHAUSTED,
    property_contact_state: PROPERTY_CONTACT_STATE.EXHAUSTED,
    // Pinned: exhausting contacts says nothing about seller appetite. Marking
    // this not_interested would poison nurture with a fact no seller stated.
    seller_interest_implied: null,
    requires_review: true,
    review_reason: 'contact_resolution_exhausted_awaiting_enrichment',
    next_contact: null,
    considered,
    email_considered: emailConsidered,
    events,
  }
}

export default resolveNextContactAction
