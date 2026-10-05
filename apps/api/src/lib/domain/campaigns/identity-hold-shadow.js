/**
 * IDENTITY-HOLD SHADOW — REPORT ONLY.
 *
 * Wraps the live predicate (identity-release.js, the ONE rule set Build /
 * Reach / Composer / Map Preview use) for the read-only dry run, and adds the
 * one rule the owner explicitly did NOT approve: R4, substituting a different
 * principal for a wrong or unreachable entity contact. R4 is computed here
 * for reporting only; nothing in the live path imports this module, and an R4
 * result can never mark a row released.
 */
import {
  HOLD_REASONS, TIERS, evaluateIdentityRelease, entityIsOwnerOfRecord, parseContactMatchingTags,
} from './identity-release.js'

export const IDENTITY_HOLD_SHADOW_FLAG = 'CAMPAIGN_IDENTITY_HOLD_SHADOW'
export const R4_RULE = 'R4_entity_alternate_principal'
export const ENTITY_NO_SMS_CHANNEL = 'entity_no_sms_channel'

const ENTITY_SUBSTITUTABLE_BLOCKS = new Set(['non_sms_capable', 'missing_phone'])
const R3_SUBSTITUTABLE_HOLDS = new Set(['occupant_not_owner', 'resident_or_renter_tag', 'renter_not_owner', 'phone_not_persons_own_record', 'person_record_missing', 'no_contact_matching_tag'])
const OWNER_SIDE = new Set(['mailing_address', 'company_auto_match', 'company_tiebreaker', 'company_level2_auto_match', 'company_level2_tiebreaker', 'trust_auto_match'])

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

export function isIdentityHoldShadowEnabled(options = {}, env = process.env) {
  if (options && options.identity_hold_shadow === true) return true
  const raw = clean(env?.[IDENTITY_HOLD_SHADOW_FLAG]).toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/** R4 (NOT APPROVED — report only): another owner-side, non-occupant principal of the property with a clean wireless phone. */
export function evaluateEntityAlternatePrincipal(row = {}) {
  const e = row.entity || {}
  if (!row.entity) return { rule: R4_RULE, outcome: 'hold', hold: 'not_entity_owned' }
  const candidates = (Array.isArray(row.alt_principals) ? row.alt_principals : []).filter((c) =>
    clean(c.individual_key) && clean(c.individual_key) !== clean(e.selected_person_key)
    && OWNER_SIDE.has(clean(c.matching_type)) && c.matches_property_owner === true && c.likely_renting !== true
    && !parseContactMatchingTags(c.tags_on_property).some((t) => t === 'Resident' || t === 'Likely Renting')
    && c.phone_suppressed === false && ['W', 'Wireless'].includes(clean(c.phone_type)) && /^[0-9]{10}$/.test(clean(c.phone))
    && entityIsOwnerOfRecord(e.owning_entity_name, row.owner_name, c).ok)
  if (!candidates.length) return { rule: R4_RULE, outcome: 'hold', hold: 'no_clean_alternate_principal' }
  const people = [...new Set(candidates.map((c) => clean(c.individual_key)))].sort()
  return {
    rule: R4_RULE,
    outcome: 'would_substitute',
    not_approved: true,
    evidence: { principals_available: people.length, substitute_person_key: people[0] },
  }
}

/**
 * The live verdict for a dry-run row (evidence embedded on the row), plus an
 * R4 report where the live predicate holds an entity contact for a reason a
 * different principal could answer.
 */
export function evaluateIdentityHoldShadow(row = {}) {
  if (row.queue_eligible === false && row.entity && ENTITY_SUBSTITUTABLE_BLOCKS.has(clean(row.queue_block_reason))) {
    return { held: true, reasons: [ENTITY_NO_SMS_CHANNEL], primary: ENTITY_NO_SMS_CHANNEL, released: false, tier: null, results: [], r4: evaluateEntityAlternatePrincipal(row) }
  }
  const live = evaluateIdentityRelease(row, row)
  if (!live.held || live.released) return { ...live, r4: null }
  const entityHold = (live.results || []).find((r) => r.reason === HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW && r.outcome !== 'release')
  const r4 = entityHold && R3_SUBSTITUTABLE_HOLDS.has(entityHold.hold) ? evaluateEntityAlternatePrincipal(row) : null
  return { ...live, r4 }
}

export { TIERS }
