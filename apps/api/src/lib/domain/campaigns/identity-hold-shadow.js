/**
 * IDENTITY-HOLD SHADOW EVALUATOR (2026-10-05) — REPORTS ONLY, NEVER RELEASES.
 *
 * Campaign builds hold recipients under three identity-family reasons decided in
 * campaign-automation-service.js `resolveCampaignTargetReadiness`:
 *
 *   missing_identity_linkage        no seller_person_key on the graph row
 *   entity_contact_requires_review  seller.property_entity_contact_v1.requires_review
 *   ambiguous_phone_ownership       one phone, >1 distinct legacy master_owner_id
 *
 * This module answers, per held row, "which deterministic rule WOULD release it,
 * on what evidence, and why the rest must stay held". It does not touch
 * readiness, the graph or campaign targets: there is no code path from here to
 * a write. The flag below only decides whether callers bother to compute it.
 *
 * Compliance invariants every rule shares (checked before any rule runs):
 *   - the destination phone must be the resolved person's OWN vendor record
 *     (seller.owner_phone on that individual_key) — never a relative's number;
 *   - renter-not-owner (likely_renting && !likely_owner) never releases;
 *   - a vendor do-not-call mark on that phone never releases;
 *   - suppression / wrong-number / prior touch are already enforced upstream by
 *     queue_eligible, and a row that is not queue_eligible is never evaluated;
 *   - unknown never counts as a match: a null boolean fails the check that needs it.
 */

export const IDENTITY_HOLD_SHADOW_FLAG = 'CAMPAIGN_IDENTITY_HOLD_SHADOW'

export const HOLD_REASONS = Object.freeze({
  MISSING_IDENTITY_LINKAGE: 'missing_identity_linkage',
  ENTITY_CONTACT_REQUIRES_REVIEW: 'entity_contact_requires_review',
  AMBIGUOUS_PHONE_OWNERSHIP: 'ambiguous_phone_ownership',
  /** Graph exclusion, not a build hold: the entity contact has no SMS-capable phone. */
  ENTITY_NO_SMS_CHANNEL: 'entity_no_sms_channel',
})

/** Entity-lane graph exclusions R4 may answer with a different principal. */
const ENTITY_SUBSTITUTABLE_BLOCKS = new Set(['non_sms_capable', 'missing_phone'])
/** R3 holds that mean "wrong person or unusable phone", which another principal can fix. */
const R3_SUBSTITUTABLE_HOLDS = new Set(['occupant_not_owner', 'vendor_dnc_on_phone', 'phone_not_persons_own_record', 'person_record_missing', 'match_type_property_address', 'vendor_owner_match_not_true', 'property_not_in_person_portfolio', 'renter_not_owner'])

export const RULES = Object.freeze({
  /** missing_identity_linkage → the phone belongs to the resolver's own named co-owner. */
  COOWNER_PHONE_LINK: 'R1_coowner_phone_link',
  /** ambiguous_phone_ownership → every row on the phone is the same canonical person. */
  SAME_PERSON_PHONE: 'R2_same_person_phone',
  /** entity_contact_requires_review → the vendor matched this person to the entity's mailing address and lists the property in the person's portfolio. */
  ENTITY_PRINCIPAL_MAILING: 'R3_entity_principal_mailing_match',
  /** entity rows whose chosen contact is wrong/unreachable → a DIFFERENT vendor-matched principal of the same property with a clean wireless phone. */
  ENTITY_ALTERNATE_PRINCIPAL: 'R4_entity_alternate_principal',
})

/** Tier A = the evidence alone is decisive. Tier B = deterministic but needs its own owner sign-off. */
export const TIERS = Object.freeze({ A: 'A', B: 'B' })

/** Entity-owner vendor match types that tie the person to the OWNER (not the occupant). */
const OWNER_SIDE_MATCH_TYPES = new Set([
  'mailing_address',
  'company_auto_match',
  'company_tiebreaker',
  'company_level2_auto_match',
  'company_level2_tiebreaker',
  'trust_auto_match',
])

/** Entity names that are institutions, not a person's holding company. */
const INSTITUTIONAL_ENTITY = /\b(BANK|BANCORP|MORTGAGE|CREDIT|FINANCIAL|SAVINGS|LENDING|LOAN|CHURCH|MINISTR\w*|TEMPLE|MOSQUE|DIOCESE|HOUSING AUTHORITY|CITY OF|COUNTY|STATE OF|SCHOOL|UNIVERSITY|HOA|HOMEOWNERS?|ASSOCIATION|ASSN|FEDERAL|FANNIE|FREDDIE|HUD|SECRETARY OF|GOVERNMENT|NATIONAL ASSOCIATION)\b/i
const TRUST_ENTITY = /\b(TRUST|TRUSTEE|TR|ESTATE OF)\b/i
/** Registered-agent services and law firms answer for an entity; they are not the person behind it. */
const AGENT_SERVICE = /(REGISTERED AGENT|AGENT SERVICE|CORPORATION SERVICE|CT CORPORATION|INCORP SERVICES|LEGALZOOM|LEGALINC|NORTHWEST REGISTERED|COGENCY|\bLAW\b|\bLAW (FIRM|GROUP|OFFICES?)\b|ATTORNEYS?\b|\bESQ\b)/i
/** Vendor placeholders that name nobody. */
const PLACEHOLDER_NAME = /^(CURRENT OWNER|OWNER|UNKNOWN|UNKNOWN OWNER|NOT AVAILABLE|N\/?A|NONE)$/i
/** Words that make a name an entity, and words too generic to prove two entity names are the same. */
const ENTITY_MARKERS = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LP', 'LLP', 'LTD', 'PARTNERSHIP', 'TRUST', 'HOLDINGS', 'PROPERTIES', 'PROPERTY', 'INVESTMENTS', 'INVESTMENT', 'GROUP', 'ENTERPRISES', 'ENTERPRISE', 'VENTURES', 'CAPITAL', 'REALTY', 'RENTALS', 'MANAGEMENT', 'HOMES', 'ASSETS', 'PARTNERS', 'FUND', 'LIMITED', 'PLLC', 'PC'])
const GENERIC_TOKENS = new Set([...ENTITY_MARKERS, 'THE', 'OF', 'AND', 'REAL', 'ESTATE', 'HOME', 'HOUSE', 'SERVICES', 'SOLUTIONS', 'USA', 'AMERICA', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'NEW', 'FIRST', 'BAY', 'CITY', 'ST', 'AVE', 'STREET', 'RD'])

/** Entities connected to one person: above A_MAX needs sign-off, above B_MAX is an agent/manager, not an owner. */
export const ENTITY_FANOUT = Object.freeze({ A_MAX: 3, B_MAX: 10 })

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function nameTokens(value) {
  return clean(value).toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2)
}

export function isIdentityHoldShadowEnabled(options = {}, env = process.env) {
  if (options && options.identity_hold_shadow === true) return true
  const raw = clean(env?.[IDENTITY_HOLD_SHADOW_FLAG]).toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/**
 * Every identity-family hold that applies to the row (not just the one that
 * wins precedence), plus the primary reason in the live precedence order:
 * missing linkage → entity review → ambiguous phone.
 */
export function identityHoldReasons(row = {}) {
  const reasons = []
  const personKey = clean(row.seller_person_key) || clean(row.prospect_id) || clean(row.canonical_prospect_id)
  if (!personKey || !clean(row.phone)) reasons.push(HOLD_REASONS.MISSING_IDENTITY_LINKAGE)
  // The accessor coalesces a NULL flag to true (fail closed) — mirrored here.
  if (row.entity && (row.entity.requires_review === true || row.entity.requires_review == null)) {
    reasons.push(HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW)
  }
  if (Number(row.phone_group?.distinct_master_owners || 0) > 1) reasons.push(HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP)
  return { reasons, primary: reasons[0] || null }
}

/** The shared compliance floor. Returns a hold code or null. */
export function complianceHold(person = {}) {
  if (!person) return 'person_record_missing'
  if (person.likely_renting === true && person.likely_owner !== true) return 'renter_not_owner'
  if (person.phone_dnc === true) return 'vendor_dnc_on_phone'
  if (person.phone_is_own !== true) return 'phone_not_persons_own_record'
  return null
}

/**
 * R1 — missing_identity_linkage.
 * The resolver could not pick ONE individual (ambiguous / conflicting) but the
 * graph's phone is held by exactly one property-linked person, that person is
 * the resolver's own co_owner_individual_key, and their given name and surname
 * are both on the deed / operational owner name.
 */
export function evaluateCoOwnerPhoneLink(row = {}) {
  const res = row.resolution || {}
  const holders = Array.isArray(row.phone_holders) ? row.phone_holders : []
  const base = { rule: RULES.COOWNER_PHONE_LINK, reason: HOLD_REASONS.MISSING_IDENTITY_LINKAGE }
  if (!holders.length) return { ...base, outcome: 'hold', hold: 'no_property_linked_holder_of_phone' }
  if (holders.length > 1) return { ...base, outcome: 'hold', hold: 'phone_shared_by_multiple_linked_people' }
  const holder = holders[0]
  if (!clean(res.co_owner_individual_key) || clean(holder.individual_key) !== clean(res.co_owner_individual_key)) {
    return { ...base, outcome: 'hold', hold: 'holder_is_not_resolver_co_owner' }
  }
  const title = new Set([...nameTokens(res.deed_owner_name), ...nameTokens(res.operational_owner_name)])
  const given = nameTokens(holder.given_name)[0]
  const surname = nameTokens(holder.surname)
  const onTitle = Boolean(given) && surname.length > 0 && title.has(given) && surname.every((t) => title.has(t))
  if (!onTitle) return { ...base, outcome: 'hold', hold: 'holder_name_not_on_title' }
  const compliance = complianceHold({ ...holder, phone_is_own: true })
  if (compliance) return { ...base, outcome: 'hold', hold: compliance }
  const status = clean(res.status)
  const evidence = {
    resolved_person_key: clean(holder.individual_key),
    resolution_status: status,
    holder_name: clean(holder.full_name),
    title_name: clean(res.operational_owner_name) || clean(res.deed_owner_name),
  }
  if (status === 'ambiguous') return { ...base, outcome: 'release', tier: TIERS.A, evidence }
  // conflicting_existing_assignment: a legacy master_owner assignment disagrees.
  // The co-owner is on title either way, but the live identity gate reads the
  // conflict as `mismatch` — releasing it is a separate owner decision.
  if (status === 'conflicting_existing_assignment') return { ...base, outcome: 'release', tier: TIERS.B, evidence }
  return { ...base, outcome: 'hold', hold: `resolution_status_${status || 'unknown'}` }
}

/**
 * R2 — ambiguous_phone_ownership.
 * The dedup compares the LEGACY master_owner_id, which is split for one person
 * across properties. When every row on the phone carries the same non-null
 * canonical seller_person_key, it is one person, not a shared phone.
 */
export function evaluateSamePersonPhone(row = {}) {
  const g = row.phone_group || {}
  const base = { rule: RULES.SAME_PERSON_PHONE, reason: HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP }
  if (Number(g.null_person_rows || 0) > 0) return { ...base, outcome: 'hold', hold: 'a_row_on_phone_has_no_person' }
  if (Number(g.distinct_person_keys || 0) !== 1) return { ...base, outcome: 'hold', hold: 'phone_held_by_multiple_people' }
  return {
    ...base,
    outcome: 'release',
    tier: TIERS.A,
    evidence: { person_key: clean(g.person_key), legacy_master_owners: Number(g.distinct_master_owners || 0), rows_on_phone: Number(g.rows || 0) },
  }
}

/**
 * R3 — entity_contact_requires_review.
 * There is NO officer / registered-agent data in the database
 * (comp_companies_private.officers is empty on all 11,836 rows), so the
 * registry can never corroborate a role. The vendor's own owner match can:
 * the person was matched at the entity's MAILING address, the vendor says
 * they match the property owner, and the property is in the person's
 * portfolio. A person matched at the PROPERTY address of an entity-owned
 * house is the occupant (a tenant) and never releases.
 */
export function evaluateEntityPrincipalMailing(row = {}) {
  const e = row.entity || {}
  const p = row.person || null
  const base = { rule: RULES.ENTITY_PRINCIPAL_MAILING, reason: HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW }
  const exclusions = Array.isArray(e.exclusion_reasons) ? e.exclusion_reasons : []
  const evidenceCodes = Array.isArray(e.evidence_codes) ? e.evidence_codes : []
  if (!p) return { ...base, outcome: 'hold', hold: 'person_record_missing' }
  if (clean(p.matching_type) === 'property_address' && p.matches_property_owner !== true) {
    return { ...base, outcome: 'hold', hold: 'occupant_not_owner' }
  }
  if (!OWNER_SIDE_MATCH_TYPES.has(clean(p.matching_type))) return { ...base, outcome: 'hold', hold: `match_type_${clean(p.matching_type) || 'unknown'}` }
  if (p.matches_property_owner !== true) return { ...base, outcome: 'hold', hold: 'vendor_owner_match_not_true' }
  if (p.in_portfolio !== true) return { ...base, outcome: 'hold', hold: 'property_not_in_person_portfolio' }
  if (exclusions.includes('ENT_DISSOLVED') || ['dissolved'].includes(clean(e.entity_status).toLowerCase())) {
    return { ...base, outcome: 'hold', hold: 'entity_dissolved' }
  }
  if (evidenceCodes.includes('ENT_BANK_REO')) return { ...base, outcome: 'hold', hold: 'bank_reo' }
  if (AGENT_SERVICE.test(clean(e.owning_entity_name)) || AGENT_SERVICE.test(clean(p.full_name))) {
    return { ...base, outcome: 'hold', hold: 'registered_agent_or_law_firm' }
  }
  // Registry officer link (W8C officer relationships, matched by entity id + person key).
  const officerRoles = (Array.isArray(p.registry_officer_roles) ? p.registry_officer_roles : []).map((r) => clean(r).toLowerCase()).filter(Boolean)
  const officerRole = officerRoles.find((r) => r !== 'agent' && r !== 'unknown') || null
  if (officerRoles.length && !officerRole && officerRoles.every((r) => r === 'agent')) {
    return { ...base, outcome: 'hold', hold: 'registered_agent_only' }
  }
  if (INSTITUTIONAL_ENTITY.test(clean(e.owning_entity_name))) return { ...base, outcome: 'hold', hold: 'institutional_entity' }
  const ownerOfRecord = entityIsOwnerOfRecord(e.owning_entity_name, row.owner_name, p)
  if (!ownerOfRecord.ok) return { ...base, outcome: 'hold', hold: ownerOfRecord.hold }
  const fanout = Number(p.entity_fanout || 0)
  if (fanout > ENTITY_FANOUT.B_MAX && !officerRole) return { ...base, outcome: 'hold', hold: 'person_fronts_many_entities' }
  const compliance = complianceHold(p)
  if (compliance) return { ...base, outcome: 'hold', hold: compliance }
  const isTrust = TRUST_ENTITY.test(clean(e.owning_entity_name))
  const evidence = {
    person_key: clean(e.selected_person_key),
    match_type: clean(p.matching_type),
    entity: clean(e.owning_entity_name),
    entity_status: clean(e.entity_status),
    entity_fanout: fanout,
    registry_name_match: evidenceCodes.includes('ENT_REGISTRY_NAME_MATCH'),
    owner_of_record_basis: ownerOfRecord.basis,
    registry_officer_role: officerRole,
  }
  const tier = officerRole || (fanout <= ENTITY_FANOUT.A_MAX && fanout >= 1 && !isTrust) ? TIERS.A : TIERS.B
  return { ...base, outcome: 'release', tier, evidence }
}

/**
 * The entity the contact was chosen for must BE the property's owner of record.
 * The entity-contact table sometimes carries an entity whose name shares
 * nothing with the deed owner (a mis-link), or a vendor placeholder such as
 * "Current Owner". Accepted bases, strongest first:
 *   person_on_title    the contact person's given name + surname are on the owner name
 *   entity_name_match  entity name and owner name share a distinctive token
 * A name with no entity marker that is not the contact person reads as a
 * person mis-typed as an entity and is held.
 */
export function entityIsOwnerOfRecord(entityName, ownerName, person = {}) {
  const owner = clean(ownerName)
  const entity = clean(entityName)
  if (!owner || PLACEHOLDER_NAME.test(owner) || PLACEHOLDER_NAME.test(entity)) return { ok: false, hold: 'owner_name_placeholder' }
  const ownerTokens = new Set(nameTokens(owner))
  const given = nameTokens(person?.given_name)[0]
  const surname = nameTokens(person?.surname)
  if (given && surname.length && ownerTokens.has(given) && surname.every((t) => ownerTokens.has(t))) {
    return { ok: true, basis: 'person_on_title' }
  }
  const entityTokens = nameTokens(entity)
  if (!entityTokens.some((t) => ENTITY_MARKERS.has(t)) && !nameTokens(owner).some((t) => ENTITY_MARKERS.has(t))) {
    return { ok: false, hold: 'owner_is_a_different_person' }
  }
  const distinctive = (tokens) => tokens.filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t))
  const shared = distinctive(entityTokens).filter((t) => ownerTokens.has(t))
  // Numbered entities ("1505 W Juniper LLC") share their street name instead.
  const digitsShared = (entity.match(/\d{2,}/g) || []).some((d) => owner.includes(d))
  if (shared.length || digitsShared) return { ok: true, basis: 'entity_name_match' }
  return { ok: false, hold: 'entity_not_owner_of_record' }
}

/**
 * R4 — substitute the entity's contact with another principal.
 * Candidates come from the property's own vendor person links
 * (seller.owner_portfolio_property), already filtered by the reader to people
 * the vendor matched on the OWNER side (mailing address / company / trust
 * match), matches_property_owner = true, not renting, holding a plaintext
 * wireless phone with do_not_call = false. This rule re-checks every one of
 * those facts (unknown fails) plus suppression on the new phone. Tier A needs
 * exactly one surviving principal whose surname is on the entity / owner name;
 * otherwise tier B (the lowest-slot phone of the first principal by key is
 * reported).
 */
export function evaluateEntityAlternatePrincipal(row = {}, reason = HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW) {
  const base = { rule: RULES.ENTITY_ALTERNATE_PRINCIPAL, reason }
  const e = row.entity || {}
  const exclusions = Array.isArray(e.exclusion_reasons) ? e.exclusion_reasons : []
  const evidenceCodes = Array.isArray(e.evidence_codes) ? e.evidence_codes : []
  if (!row.entity) return { ...base, outcome: 'hold', hold: 'not_entity_owned' }
  if (exclusions.includes('ENT_DISSOLVED') || clean(e.entity_status).toLowerCase() === 'dissolved') return { ...base, outcome: 'hold', hold: 'entity_dissolved' }
  if (evidenceCodes.includes('ENT_BANK_REO')) return { ...base, outcome: 'hold', hold: 'bank_reo' }
  if (INSTITUTIONAL_ENTITY.test(clean(e.owning_entity_name))) return { ...base, outcome: 'hold', hold: 'institutional_entity' }
  const candidates = (Array.isArray(row.alt_principals) ? row.alt_principals : []).filter((c) =>
    clean(c.individual_key)
    && clean(c.individual_key) !== clean(e.selected_person_key)
    && OWNER_SIDE_MATCH_TYPES.has(clean(c.matching_type))
    && c.matches_property_owner === true
    && c.likely_renting !== true
    && c.phone_dnc === false
    && c.phone_suppressed === false
    && ['W', 'Wireless'].includes(clean(c.phone_type))
    && /^[0-9]{10}$/.test(clean(c.phone))
    && !AGENT_SERVICE.test(clean(c.full_name)))
  if (!candidates.length) return { ...base, outcome: 'hold', hold: 'no_clean_alternate_principal' }
  const verified = candidates.filter((c) => entityIsOwnerOfRecord(e.owning_entity_name, row.owner_name, c).ok)
  if (!verified.length) return { ...base, outcome: 'hold', hold: 'entity_not_owner_of_record' }
  const people = [...new Set(verified.map((c) => clean(c.individual_key)))].sort()
  const pick = verified.filter((c) => clean(c.individual_key) === people[0]).sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0))[0]
  // A person at the entity's mailing address can be the principal, a household
  // member or a manager. Only a surname that is ON the entity / owner name ties
  // the substitute to the owner by itself (tier A); anything else needs sign-off.
  const ownerNameTokens = new Set([...nameTokens(e.owning_entity_name), ...nameTokens(row.owner_name)])
  const surnameTokens = nameTokens(pick.surname).filter((t) => t.length >= 3)
  const surnameOnName = surnameTokens.length > 0 && surnameTokens.every((t) => ownerNameTokens.has(t))
  return {
    ...base,
    outcome: 'release',
    tier: people.length === 1 && surnameOnName ? TIERS.A : TIERS.B,
    substitute: true,
    evidence: {
      substitute_person_key: clean(pick.individual_key),
      substitute_name: clean(pick.full_name),
      substitute_match_type: clean(pick.matching_type),
      substitute_phone_last4: clean(pick.phone).slice(-4),
      principals_available: people.length,
      substitute_surname_on_owner_name: surnameOnName,
      entity: clean(e.owning_entity_name),
    },
  }
}

const EVALUATORS = {
  [HOLD_REASONS.MISSING_IDENTITY_LINKAGE]: evaluateCoOwnerPhoneLink,
  [HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW]: evaluateEntityPrincipalMailing,
  [HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP]: evaluateSamePersonPhone,
}

/**
 * Evaluate one held row. A row is "would_release" only when EVERY identity
 * hold on it is released; its tier is the weakest tier among those releases.
 * The live readiness decision is untouched — this result is advisory.
 */
export function evaluateIdentityHoldShadow(row = {}) {
  // Entity rows the graph excluded for lack of an SMS channel: substitution only.
  if (row.queue_eligible === false && row.entity && ENTITY_SUBSTITUTABLE_BLOCKS.has(clean(row.queue_block_reason))) {
    const reasons = [HOLD_REASONS.ENTITY_NO_SMS_CHANNEL]
    const alt = evaluateEntityAlternatePrincipal(row, HOLD_REASONS.ENTITY_NO_SMS_CHANNEL)
    const release = alt.outcome === 'release'
    return {
      held: true, reasons, primary: reasons[0], would_release: release, tier: release ? alt.tier : null,
      rules: release ? [alt.rule] : [], remaining_holds: release ? [] : [`${alt.reason}:${alt.hold}`], results: [alt],
      note: 'graph re-gating of the substitute phone (sender coverage, prior touch, active queue) is still required',
    }
  }
  const { reasons, primary } = identityHoldReasons(row)
  if (!reasons.length) return { held: false, reasons, primary, would_release: false, results: [] }
  if (row.queue_eligible === false) {
    return { held: true, reasons, primary, would_release: false, results: [], hold: 'not_queue_eligible' }
  }
  const results = reasons.map((reason) => {
    const result = EVALUATORS[reason](row)
    // A wrong or unreachable entity contact can be answered by another principal.
    if (reason === HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW && result.outcome !== 'release' && R3_SUBSTITUTABLE_HOLDS.has(result.hold)) {
      const alt = evaluateEntityAlternatePrincipal(row, reason)
      return alt.outcome === 'release' ? alt : { ...result, hold: `${result.hold}|${alt.hold}` }
    }
    return result
  })
  const wouldRelease = results.every((r) => r.outcome === 'release')
  const tier = wouldRelease ? (results.some((r) => r.tier === TIERS.B) ? TIERS.B : TIERS.A) : null
  return {
    held: true,
    reasons,
    primary,
    would_release: wouldRelease,
    tier,
    rules: results.filter((r) => r.outcome === 'release').map((r) => r.rule),
    remaining_holds: results.filter((r) => r.outcome !== 'release').map((r) => `${r.reason}:${r.hold}`),
    results,
  }
}

/** Aggregate a set of evaluations: counts per reason, per overlap, per rule/tier, per remaining hold. */
export function summarizeIdentityHoldShadow(evaluations = []) {
  const out = { held: 0, would_release: 0, by_tier: { A: 0, B: 0 }, by_primary: {}, by_overlap: {}, released_by_rule: {}, remaining: {} }
  const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1 }
  for (const ev of evaluations) {
    if (!ev?.held) continue
    out.held += 1
    inc(out.by_primary, ev.primary)
    inc(out.by_overlap, ev.reasons.join('+'))
    for (const r of ev.results || []) {
      if (r.outcome === 'release') inc(out.released_by_rule, `${r.rule}:${r.tier}`)
      else inc(out.remaining, `${r.reason}:${r.hold}`)
    }
    if (ev.would_release) {
      out.would_release += 1
      inc(out.by_tier, ev.tier)
    }
  }
  return out
}
