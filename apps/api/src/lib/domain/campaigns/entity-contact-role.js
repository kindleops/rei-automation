/**
 * ENTITY CONTACT ROLE RESOLVER v2 (2026-10-09) — the ONE decision on whether the
 * person selected for an entity-owned property may be contacted on the entity's
 * behalf.
 *
 * WHY. seller.property_entity_contact_v1 (S9, built 2026-08-07 by an offline
 * builder whose source is not in this repo) assigns a role from exactly three
 * signals, reverse-engineered from all 48,135 rows:
 *
 *   principal                 the person's surname is in the entity name (ENT_PERSON_NAME_IN_ENTITY)
 *   authorized_representative vendor matching_type company_auto_match | company_tiebreaker (ENT_VENDOR_COMPANY_MATCH)
 *   entity_mailing_contact    the person is the property's mailing name (ENT_MAIL_NAME_MATCH)
 *   unknown (ENT_ROLE_UNCORROBORATED, requires_review) — everything else
 *
 * It never reads the Contact Matching Tags (public.prospects.matching_flags),
 * vendor level-2 company matches, trust matches, the deed's second owner, the
 * tax-mailing "c/o" name or the Secretary-of-State registry address, and it
 * never checks whether its chosen person is the OCCUPANT. So `unknown` mixes
 * four different things: supported roles it could not see, occupants it should
 * never have chosen, owner-side people with no role evidence, and no human.
 *
 * This module separates them. It is pure; the facts come from
 * public.campaign_entity_contact_evidence (PROPOSED SQL
 * supabase/migrations/PROPOSED_20261009100000_entity_contact_role_evidence_v2.sql).
 *
 * Invariants (owner policy 2026-10-05 / 2026-10-08):
 *   - evidence is never manufactured: a role needs a recorded relationship;
 *   - no substitute principal: only the S9-selected person is evaluated;
 *   - Resident / Likely Renting / a property-address match = the occupant: never the entity;
 *   - suppression, opt-out and wrong-number are RESTRICTIONS, kept distinct from
 *     identity conflicts and from missing role evidence, and never overridden;
 *   - vendor do-not-call is not a restriction (owner decision);
 *   - the phone must be the person's own record;
 *   - unknown never counts as a match.
 */

export const ENTITY_ROLE_RULES_VERSION = 'entity-contact-role-v2@2026-10-09'
export const ENTITY_ROLE_FLAG = 'ENTITY_CONTACT_ROLE_V2' // off | shadow | release | on

export const STATUS = Object.freeze({
  CONTACTABLE: 'role_supported',
  REVIEW: 'role_review',
  UNCORROBORATED: 'role_uncorroborated',
  IDENTITY_CONFLICT: 'identity_conflict',
  RESTRICTED: 'contact_restricted',
  NO_HUMAN: 'no_human_candidate',
})

export const ROLES = Object.freeze({
  CO_OWNER_OF_RECORD: 'co_owner_of_record',
  PRINCIPAL_NAMED: 'principal',
  AUTHORIZED_REPRESENTATIVE: 'authorized_representative',
  PRINCIPAL_TAGGED: 'principal_linked_to_company',
  MAILING_CARE_OF: 'entity_mailing_contact',
  REPLY_CONFIRMED_OWNER: 'reply_confirmed_owner',
  TRUSTEE: 'trustee',
  REGISTERED_ADDRESS: 'registered_agent_or_principal_address',
  POSSIBLE_PRINCIPAL: 'possible_principal',
  OWNER_SIDE: 'owner_side_contact',
  UNKNOWN: 'unknown',
})

/**
 * Roles that are contactable by default. Everything else that resolves is
 * REVIEW. The owner can widen this (e.g. trustee) via options.contactable_roles;
 * it is never widened implicitly.
 */
export const DEFAULT_CONTACTABLE_ROLES = Object.freeze([
  ROLES.CO_OWNER_OF_RECORD,
  ROLES.PRINCIPAL_NAMED,
  ROLES.AUTHORIZED_REPRESENTATIVE,
  ROLES.PRINCIPAL_TAGGED,
  ROLES.MAILING_CARE_OF,
  ROLES.REPLY_CONFIRMED_OWNER,
])

/** Vendor match types that tie the PERSON to the COMPANY (any level). */
const COMPANY_MATCH_TYPES = new Set(['company_auto_match', 'company_tiebreaker', 'company_level2_auto_match', 'company_level2_tiebreaker'])
const TRUST_MATCH_TYPES = new Set(['trust_auto_match', 'trust_tiebreaker'])

export const TAG = Object.freeze({
  LINKED_TO_COMPANY: 'Linked To Company',
  POTENTIALLY_LINKED_TO_COMPANY: 'Potentially Linked To Company',
  LIKELY_OWNER: 'Likely Owner',
  POTENTIAL_OWNER: 'Potential Owner',
  FAMILY: 'Family',
  RESIDENT: 'Resident',
  LIKELY_RENTING: 'Likely Renting',
})
const KNOWN_TAGS = new Set(Object.values(TAG))

function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim()
}

/** "Likely Owner, Family" | "Likely Owner|Family" | [..] → exact known values only. */
export function parseTags(value) {
  const parts = Array.isArray(value) ? value : clean(value).split(/[,|]/)
  return [...new Set(parts.map(clean).filter((t) => KNOWN_TAGS.has(t)))]
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean)
  return clean(value).split(/[|+,]/).map(clean).filter(Boolean)
}

const bool = (v) => v === true || v === 't' || v === 'true'

export function entityRoleMode(options = {}, env = process.env) {
  const raw = clean(options.entity_role_mode ?? env?.[ENTITY_ROLE_FLAG]).toLowerCase()
  return raw === 'on' || raw === 'shadow' || raw === 'release' ? raw : 'off'
}

/**
 * Decide one property. `f` is one evidence row (flat facts, see the SQL accessor).
 * Returns { status, role, contactable, requires_review, codes, basis, conflicts, restrictions }.
 */
export function resolveEntityContactRole(f = {}, options = {}) {
  const contactableRoles = new Set(options.contactable_roles || DEFAULT_CONTACTABLE_ROLES)
  const tags = parseTags(f.tags_on_property)
  const personFlags = parseList(f.person_flags)
  const s9Evidence = parseList(f.s9_evidence_codes)
  const s9Exclusions = parseList(f.s9_exclusion_reasons)
  const matchType = clean(f.person_matching_type)
  const out = (status, role, codes, extra = {}) => ({
    status,
    role,
    contactable: status === STATUS.CONTACTABLE,
    requires_review: status !== STATUS.CONTACTABLE,
    codes,
    rules_version: ENTITY_ROLE_RULES_VERSION,
    ...extra,
  })

  // 0. No human / no channel.
  if (!bool(f.has_person)) return out(STATUS.NO_HUMAN, ROLES.UNKNOWN, ['ENT2_NO_HUMAN_CANDIDATE'])

  // 1. Contact restrictions — permission state, never overridden, never relabelled.
  const restrictions = []
  if (bool(f.phone_suppressed)) restrictions.push('ENT2_PHONE_SUPPRESSED')
  if (bool(f.phone_opted_out)) restrictions.push('ENT2_PHONE_OPTED_OUT')
  if (bool(f.phone_wrong_number)) restrictions.push('ENT2_WRONG_NUMBER')

  // 2. Identity conflicts — the selected person is not the entity's side.
  const conflicts = []
  const occupantTag = tags.includes(TAG.LIKELY_RENTING) || (tags.includes(TAG.RESIDENT) && !tags.includes(TAG.LIKELY_OWNER) && !tags.includes(TAG.LINKED_TO_COMPANY))
  if (occupantTag) conflicts.push('ENT2_RESIDENT_OR_RENTER_TAG')
  if (bool(f.person_likely_renting)) conflicts.push('ENT2_VENDOR_LIKELY_RENTING')
  const nameInEntity = bool(f.surname_in_entity) || s9Evidence.includes('ENT_PERSON_NAME_IN_ENTITY')
  // The vendor's "Renter" person flag means "not on title at this address" — an
  // LLC principal living in the LLC's house carries it too, so it is a conflict
  // only when nothing ties the person to the entity by name.
  if (matchType === 'property_address' && personFlags.includes('Renter') && !nameInEntity) conflicts.push('ENT2_OCCUPANT_RENTER')
  if (bool(f.reply_non_owner)) conflicts.push('ENT2_REPLY_SAYS_NOT_OWNER')
  if (bool(f.has_phone) && f.phone_is_own !== undefined && f.phone_is_own !== null && !bool(f.phone_is_own)) conflicts.push('ENT2_PHONE_NOT_PERSONS_OWN')

  // 3. Supported relationship evidence, strongest first. Every basis is a
  //    recorded fact about THIS person and THIS property/entity.
  const linked = bool(f.person_linked_to_property)
  const corroboration = []
  if (bool(f.addr_eq_mailing)) corroboration.push('mailing_address')
  if (bool(f.addr_eq_registry)) corroboration.push('registry_address')
  if (bool(f.person_mpo)) corroboration.push('vendor_owner_match')
  if (COMPANY_MATCH_TYPES.has(matchType)) corroboration.push('vendor_company_match')
  if (nameInEntity) corroboration.push('surname_in_entity')
  if (linked) corroboration.push('property_link')

  let role = ROLES.UNKNOWN
  const basis = []
  if (bool(f.reply_owner_confirmed)) { role = ROLES.REPLY_CONFIRMED_OWNER; basis.push('first_party_reply_confirmed_ownership') }
  else if (bool(f.person_on_title)) { role = ROLES.CO_OWNER_OF_RECORD; basis.push('named_owner_of_record') }
  else if (linked && nameInEntity) { role = ROLES.PRINCIPAL_NAMED; basis.push('surname_in_entity_name') }
  else if (COMPANY_MATCH_TYPES.has(matchType)) { role = ROLES.AUTHORIZED_REPRESENTATIVE; basis.push(`vendor_${matchType}`) }
  else if (tags.includes(TAG.LINKED_TO_COMPANY)) {
    const c = corroboration.filter((x) => x !== 'property_link')
    if (c.length) { role = ROLES.PRINCIPAL_TAGGED; basis.push('tag_linked_to_company', ...c.map((x) => `corroborated_by_${x}`)) }
    else { role = ROLES.POSSIBLE_PRINCIPAL; basis.push('tag_linked_to_company_uncorroborated') }
  }
  else if (bool(f.person_is_mail_care_of)) { role = ROLES.MAILING_CARE_OF; basis.push('tax_mailing_care_of_name') }
  else if (TRUST_MATCH_TYPES.has(matchType) && bool(f.entity_name_is_trust)) { role = ROLES.TRUSTEE; basis.push(`vendor_${matchType}`) }
  else if (bool(f.addr_eq_registry) && linked) { role = ROLES.REGISTERED_ADDRESS; basis.push('person_address_is_registry_address') }
  else if (tags.includes(TAG.POTENTIALLY_LINKED_TO_COMPANY)) { role = ROLES.POSSIBLE_PRINCIPAL; basis.push('tag_potentially_linked_to_company') }
  else if (linked && (tags.includes(TAG.LIKELY_OWNER) || bool(f.person_mpo)) && bool(f.addr_eq_mailing)) {
    role = ROLES.OWNER_SIDE; basis.push('owner_side_mailing_address_only')
  }

  // An occupant can only stand for the entity if the deed names them.
  if (matchType === 'property_address' && !linked && role !== ROLES.CO_OWNER_OF_RECORD && role !== ROLES.REPLY_CONFIRMED_OWNER) {
    conflicts.push('ENT2_OCCUPANT_NOT_LINKED_TO_ENTITY')
  }
  // Policy holds — not identity conflicts, not missing evidence: the role may be
  // real but the owner has not approved contacting it automatically.
  const policy = []
  if (bool(f.entity_institutional) || s9Evidence.includes('ENT_BANK_REO') || bool(f.owner_is_bank)) policy.push('ENT2_INSTITUTIONAL_OWNER')
  if (bool(f.entity_agent_service)) policy.push('ENT2_AGENT_SERVICE_OR_LAW_FIRM')
  if (Number(f.entity_fanout || 0) > 10) policy.push('ENT2_PERSON_FRONTS_MANY_ENTITIES')
  // The person is a party on a death / probate record for this property: the
  // decedent or the heir — the data cannot say which, so a person must look.
  if (bool(f.death_record)) policy.push('ENT2_PERSON_ON_DEATH_OR_PROBATE_RECORD')

  const extra = { basis, conflicts, restrictions, policy, corroboration, s9_role: clean(f.s9_contact_role) || null }
  if (restrictions.length) return out(STATUS.RESTRICTED, role, restrictions, extra)
  if (conflicts.length) return out(STATUS.IDENTITY_CONFLICT, role, conflicts, extra)
  // Channel absence is NOT a role question: graph readiness already blocks a
  // property with no SMS-capable phone (missing_phone / non_sms_capable).
  const notes = []
  if (!bool(f.has_phone)) notes.push('ENT2_NO_PHONE')
  const dissolved = ['dissolved', 'forfeited'].includes(clean(f.entity_status).toLowerCase()) || s9Exclusions.includes('ENT_DISSOLVED')
  if (role === ROLES.UNKNOWN) return out(STATUS.UNCORROBORATED, role, ['ENT2_NO_ROLE_EVIDENCE'], extra)
  // Owner-side evidence (Likely Owner / vendor owner-match at the entity's
  // mailing address) is not a ROLE. It is contactable only if the owner adds
  // owner_side_contact to contactable_roles; never by default.
  if (role === ROLES.OWNER_SIDE && !contactableRoles.has(ROLES.OWNER_SIDE)) return out(STATUS.UNCORROBORATED, role, ['ENT2_OWNER_SIDE_ONLY'], extra)
  if (policy.length) return out(STATUS.REVIEW, role, policy, extra)
  // Dissolved / forfeited is reported, not blocking: S9 did not block it either,
  // and whoever controlled the LLC still controls the title (owner decision).
  if (dissolved) notes.push('ENT2_ENTITY_DISSOLVED_OR_FORFEITED')
  extra.notes = notes
  if (!contactableRoles.has(role)) return out(STATUS.REVIEW, role, [`ENT2_ROLE_REVIEW_${role.toUpperCase()}`], extra)
  return out(STATUS.CONTACTABLE, role, [`ENT2_ROLE_${role.toUpperCase()}`], extra)
}

/**
 * The review decision readiness consumes.
 *   off      S9's flag.
 *   shadow   S9's flag, v2 returned alongside for comparison.
 *   release  v2 may only CLEAR an S9 review flag (never adds a block).
 *   on       v2 decides both ways (also blocks S9-resolved occupants, renters,
 *            unlinked name-only matches, institutions, >10-entity fronts).
 * A property with no evidence row keeps S9's flag; a NULL S9 flag is review.
 */
export function entityContactRequiresReview(f = {}, options = {}) {
  const s9 = f.s9_requires_review === undefined || f.s9_requires_review === null ? true : bool(f.s9_requires_review)
  const mode = options.mode || 'off'
  if (mode === 'off') return { requires_review: s9, source: 's9' }
  const v2 = resolveEntityContactRole(f, options)
  if (mode === 'shadow') return { requires_review: s9, source: 's9', v2 }
  if (mode === 'release') return { requires_review: s9 && v2.requires_review, source: s9 && !v2.requires_review ? 'v2' : 's9', v2 }
  return { requires_review: v2.requires_review, source: 'v2', v2 }
}

/** Counts by S9 role → v2 status/role, for dry runs and shadow logs. */
export function summarizeEntityRoles(rows = [], options = {}) {
  const out = { total: 0, before_review: 0, after_review: 0, released: 0, newly_blocked: 0, by_status: {}, by_role: {}, by_code: {}, transitions: {} }
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1 }
  for (const f of rows) {
    const v2 = resolveEntityContactRole(f, options)
    const s9 = f.s9_requires_review === undefined || f.s9_requires_review === null ? true : bool(f.s9_requires_review)
    out.total += 1
    if (s9) out.before_review += 1
    if (v2.requires_review) out.after_review += 1
    if (s9 && !v2.requires_review) out.released += 1
    if (!s9 && v2.requires_review) out.newly_blocked += 1
    inc(out.by_status, v2.status)
    inc(out.by_role, v2.role)
    for (const c of v2.codes) inc(out.by_code, c)
    inc(out.transitions, `${clean(f.s9_contact_role) || 'none'}${s9 ? '/review' : ''} -> ${v2.status}:${v2.role}`)
  }
  return out
}
