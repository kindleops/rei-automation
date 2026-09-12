/**
 * V2-1B — durable contact×property resolution state.
 *
 * The resolver (contact-resolution-waterfall.js) stays PURE. All reads and
 * writes live here, so the decision logic remains testable without a database
 * and cannot acquire a hidden side effect.
 *
 *     inbound evidence
 *       → classify / extract
 *       → pure resolution decision      (waterfall)
 *       → persist contact×property outcome   (this module)
 *       → execute resulting operation
 *
 * WHAT MAKES THE ANTI-LOOP GUARANTEE DURABLE. `loadPropertyResolutionState`
 * returns the set of phones already rejected for a property, read from
 * `contact_property_resolution`. The waterfall takes that set as input, so a
 * contact ruled out in one process is still excluded in the next one. Without
 * this the guarantee held only inside a single in-memory resolution.
 *
 * WHY THIS TABLE AND NOT contact_outreach_state: that relation is unique on
 * (owner, phone), so it is contact × OWNER. Twelve owners in the graph hold
 * multiple properties, so a role stored there would leak across every property
 * that owner holds. See the migration for the full reasoning.
 *
 * ABSENCE IS UNKNOWN. No row means we never established a role — not that the
 * contact is eligible and not that they are disqualified. Nothing here invents
 * a role for a pairing nobody asked about.
 */

import { CONTACT_PROPERTY_ROLE, normalizePhoneKey } from './contact-resolution-waterfall.js'

const TABLE = 'contact_property_resolution'

const clean = (value) => String(value ?? '').trim()

/** Map an S1 outcome to the durable pair role. */
export const OUTCOME_TO_ROLE = Object.freeze({
  owner_confirmed: CONTACT_PROPERTY_ROLE.CONFIRMED_OWNER,
  not_owner: CONTACT_PROPERTY_ROLE.NOT_OWNER,
  former_owner: CONTACT_PROPERTY_ROLE.FORMER_OWNER,
  referral: CONTACT_PROPERTY_ROLE.REFERRAL_SOURCE,
  opt_out: CONTACT_PROPERTY_ROLE.SUPPRESSED,
})

/** Roles that disqualify a pairing from further ownership outreach. */
const REJECTING_ROLES = new Set([
  CONTACT_PROPERTY_ROLE.NOT_OWNER,
  CONTACT_PROPERTY_ROLE.FORMER_OWNER,
  CONTACT_PROPERTY_ROLE.REFERRAL_SOURCE,
  CONTACT_PROPERTY_ROLE.SUPPRESSED,
])

/**
 * Read everything the waterfall needs to know about one property.
 *
 * Fails CLOSED on a read error: an unreadable resolution table means we cannot
 * prove a contact has not already been rejected, and selecting one anyway is
 * how a seller gets texted a second time after saying "not mine". The caller
 * receives `ok:false` and must not proceed to selection.
 */
export async function loadPropertyResolutionState(supabase, propertyId) {
  const property = clean(propertyId)
  if (!supabase || !property) {
    return { ok: false, reason: 'missing_supabase_or_property', rejected_phones: [], roles: new Map() }
  }

  const { data, error } = await supabase
    .from(TABLE)
    .select('contact_phone_e164, contact_property_role, rejected_at, rejection_reason, suppression_scope, contact_origin, referral_identity_key')
    .eq('property_id', property)
    .range(0, 999)

  if (error) {
    return { ok: false, reason: 'resolution_state_unreadable', error: error.message, rejected_phones: [], roles: new Map() }
  }

  const rows = Array.isArray(data) ? data : []
  const rejected_phones = []
  const suppressed_phones = []
  const roles = new Map()

  for (const row of rows) {
    const key = normalizePhoneKey(row.contact_phone_e164)
    if (!key) continue
    roles.set(key, {
      role: row.contact_property_role || null,
      rejected_at: row.rejected_at || null,
      suppression_scope: row.suppression_scope || null,
      contact_origin: row.contact_origin || null,
    })
    if (row.rejected_at) rejected_phones.push(key)
    // A channel-compliance suppression is excluded from selection too, but for
    // a different reason, and it is reported separately so the two never blur.
    if (row.suppression_scope === 'channel_compliance') suppressed_phones.push(key)
  }

  return { ok: true, rejected_phones, suppressed_phones, roles, row_count: rows.length }
}

/**
 * Record the outcome of one contact×property S1 turn.
 *
 * Idempotent by construction: the table is unique on (property_id,
 * contact_phone_e164), so re-processing the same inbound event updates the one
 * row rather than appending a second. `rejected_at` is preserved once set —
 * a later turn cannot un-reject a pairing by accident.
 */
export async function recordContactOutcome(supabase, {
  property_id,
  contact_phone_e164,
  outcome,
  master_owner_id = null,
  prospect_id = null,
  rejection_reason = null,
  suppression_scope = null,
  contact_origin = null,
  referral_id = null,
  referred_by_phone_e164 = null,
  source_message_id = null,
  source_thread_key = null,
  now = null,
} = {}) {
  const property = clean(property_id)
  const phone = normalizePhoneKey(contact_phone_e164)
  if (!supabase || !property || !phone) {
    return { ok: false, reason: 'missing_identity' }
  }

  const role = OUTCOME_TO_ROLE[clean(outcome)] || CONTACT_PROPERTY_ROLE.UNKNOWN
  const timestamp = now || new Date().toISOString()
  const rejects = REJECTING_ROLES.has(role)

  const row = {
    property_id: property,
    contact_phone_e164: phone,
    master_owner_id: clean(master_owner_id) || null,
    prospect_id: clean(prospect_id) || null,
    contact_property_role: role,
    rejected_at: rejects ? timestamp : null,
    rejection_reason: rejects ? (clean(rejection_reason) || clean(outcome) || null) : null,
    suppression_scope: clean(suppression_scope) || null,
    contact_origin: clean(contact_origin) || null,
    referral_id: referral_id || null,
    referred_by_phone_e164: normalizePhoneKey(referred_by_phone_e164) || null,
    source_message_id: clean(source_message_id) || null,
    source_thread_key: clean(source_thread_key) || null,
    updated_at: timestamp,
  }

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'property_id,contact_phone_e164' })
    .select('id, contact_property_role, rejected_at')
    .maybeSingle()

  if (error) return { ok: false, reason: 'resolution_write_failed', error: error.message }

  return {
    ok: true,
    id: data?.id ?? null,
    contact_property_role: data?.contact_property_role ?? role,
    rejected: Boolean(data?.rejected_at),
    // Pinned in the return value so a caller reading only this cannot conclude
    // the property was terminated.
    property_opportunity_terminated: false,
  }
}

/**
 * Persist a referral execution plan.
 *
 * Idempotency is enforced by the DATABASE, not by a prior read: a partial
 * unique index on `referral_identity_key` means a concurrent or retried
 * execution collides rather than forking a second identity. A conflict is a
 * SUCCESS with `reused: true` — the desired end state already exists.
 */
export async function recordReferralExecution(supabase, plan, {
  property_id,
  master_owner_id = null,
  source_message_id = null,
  source_thread_key = null,
  now = null,
} = {}) {
  if (!supabase || !plan || plan.status === 'invalid' || !plan.identity_key) {
    return { ok: false, reason: plan?.reason || 'invalid_plan', reused: false }
  }

  const property = clean(property_id) || clean(plan.property_id)
  const referredPhone = normalizePhoneKey(
    plan.operations?.find((o) => o.op === 'create_contact' || o.op === 'reuse_contact')?.phone_e164
  )
  if (!property || !referredPhone) {
    return { ok: false, reason: 'referral_missing_identity', reused: false }
  }

  const timestamp = now || new Date().toISOString()
  const sourcePhone = normalizePhoneKey(
    plan.operations?.find((o) => o.op === 'mark_contact_property_non_owner')?.phone_e164
  )

  const row = {
    property_id: property,
    contact_phone_e164: referredPhone,
    master_owner_id: clean(master_owner_id) || null,
    // The referred contact is a CANDIDATE owner, not a rejected one. Its role
    // stays unknown until that person answers S1 themselves.
    contact_property_role: CONTACT_PROPERTY_ROLE.UNKNOWN,
    rejected_at: null,
    contact_origin: 'referral',
    referral_id: plan.referral_id || null,
    referred_by_phone_e164: sourcePhone || null,
    referral_identity_key: plan.identity_key,
    source_message_id: clean(source_message_id) || null,
    source_thread_key: clean(source_thread_key) || null,
    updated_at: timestamp,
  }

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'referral_identity_key' })
    .select('id, referral_identity_key, created_at, updated_at')
    .maybeSingle()

  if (error) {
    // A unique violation here is the idempotency guard doing its job.
    const duplicate = /duplicate key|unique constraint/i.test(error.message || '')
    if (duplicate) return { ok: true, reused: true, reason: 'referral_already_executed' }
    return { ok: false, reason: 'referral_write_failed', error: error.message, reused: false }
  }

  return {
    ok: true,
    id: data?.id ?? null,
    identity_key: data?.referral_identity_key ?? plan.identity_key,
    reused: plan.status === 'reused',
    sends: 0,
  }
}

/** Has this referral already been executed? Used for replay-safe planning. */
export async function isReferralExecuted(supabase, identityKey) {
  const key = clean(identityKey)
  if (!supabase || !key) return { ok: false, executed: false }
  const { data, error } = await supabase
    .from(TABLE)
    .select('id')
    .eq('referral_identity_key', key)
    .maybeSingle()
  if (error) return { ok: false, executed: false, error: error.message }
  return { ok: true, executed: Boolean(data?.id) }
}

export default {
  loadPropertyResolutionState,
  recordContactOutcome,
  recordReferralExecution,
  isReferralExecuted,
}
