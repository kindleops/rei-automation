/**
 * CAMPAIGN IDENTITY RELEASE — the ONE predicate (2026-10-05, owner decision).
 *
 * Campaign builds hold recipients under three identity-family reasons decided in
 * campaign-automation-service.js `resolveCampaignTargetReadiness`:
 *
 *   missing_identity_linkage        no seller_person_key on the graph row
 *   entity_contact_requires_review  seller.property_entity_contact_v1.requires_review
 *   ambiguous_phone_ownership       one phone, >1 distinct legacy master_owner_id
 *
 * This module decides, per held row, whether deterministic evidence releases it.
 * planCampaignTargetRows calls it for Build, Reach, the Composer cohort count and
 * Map Preview alike, so all four agree. It is pure: the evidence is fetched by
 * campaign-recipient-metrics.js `fetchIdentityReleaseEvidence` and passed in.
 *
 * Live only when CAMPAIGN_IDENTITY_RELEASE_ENABLED is on (default OFF), and only
 * the AUTOMATIC tier releases. REVIEW-tier rows stay held. There is no
 * substitute-principal rule here — that lives (report-only) in the shadow.
 *
 * CONTACT MATCHING TAGS (Podio "contact-matching-tags") live in exactly one place
 * in the current model: public.prospects.matching_flags, text, ", "-delimited,
 * one prospect row per person × property link (linked_property_ids_json). Values:
 * Likely Owner, Family, Resident, Likely Renting, Potential Owner,
 * Linked To Company, Potentially Linked To Company.
 *
 * Compliance invariants (owner, 2026-10-05):
 *   - our own suppression, opt-outs, wrong numbers and prior touches still hold —
 *     they are enforced upstream by queue_eligible and nothing here can override
 *     a row that is not queue_eligible;
 *   - vendor do-not-call does NOT hold (owner decision; same as the live graph);
 *   - Resident / Likely Renting on an entity-owned property = the occupant: hold;
 *   - the phone must be the released person's own record;
 *   - unknown never counts as a match.
 */

export const IDENTITY_RELEASE_FLAG = 'CAMPAIGN_IDENTITY_RELEASE_ENABLED'

export const HOLD_REASONS = Object.freeze({
  MISSING_IDENTITY_LINKAGE: 'missing_identity_linkage',
  ENTITY_CONTACT_REQUIRES_REVIEW: 'entity_contact_requires_review',
  AMBIGUOUS_PHONE_OWNERSHIP: 'ambiguous_phone_ownership',
})

export const RULES = Object.freeze({
  /** missing_identity_linkage → the phone belongs to the resolver's own named co-owner on title. */
  COOWNER_PHONE_LINK: 'R1_coowner_phone_link',
  /** ambiguous_phone_ownership → every row on the phone is the same canonical person. */
  SAME_PERSON_PHONE: 'R2_same_person_phone',
  /** entity_contact_requires_review → the selected person carries an ownership-side contact matching tag for this property. */
  ENTITY_TAGGED_PRINCIPAL: 'R3_entity_tagged_principal',
})

/** automatic = released when the flag is on. review = deterministic but needs a person to look. */
export const TIERS = Object.freeze({ AUTOMATIC: 'automatic', REVIEW: 'review' })

export const TAGS = Object.freeze({
  LINKED_TO_COMPANY: 'Linked To Company',
  POTENTIALLY_LINKED_TO_COMPANY: 'Potentially Linked To Company',
  LIKELY_OWNER: 'Likely Owner',
  POTENTIAL_OWNER: 'Potential Owner',
  RESIDENT: 'Resident',
  FAMILY: 'Family',
  LIKELY_RENTING: 'Likely Renting',
})
const STRONG_TAGS = [TAGS.LINKED_TO_COMPANY, TAGS.LIKELY_OWNER]
const WEAK_TAGS = [TAGS.POTENTIALLY_LINKED_TO_COMPANY, TAGS.POTENTIAL_OWNER, TAGS.FAMILY]
const OCCUPANT_TAGS = [TAGS.RESIDENT, TAGS.LIKELY_RENTING]
const KNOWN_TAGS = new Set(Object.values(TAGS))

/** Vendor match types that put the person on the OWNER side (mailing / company / trust), not at the house. */
const OWNER_SIDE_MATCH_TYPES = new Set([
  'mailing_address', 'company_auto_match', 'company_tiebreaker',
  'company_level2_auto_match', 'company_level2_tiebreaker', 'trust_auto_match', 'trust_tiebreaker',
])

const INSTITUTIONAL_ENTITY = /\b(BANK|BANCORP|MORTGAGE|CREDIT|FINANCIAL|SAVINGS|LENDING|LOAN|CHURCH|MINISTR\w*|TEMPLE|MOSQUE|DIOCESE|HOUSING AUTHORITY|CITY OF|COUNTY|STATE OF|SCHOOL|UNIVERSITY|HOA|HOMEOWNERS?|ASSOCIATION|ASSN|FEDERAL|FANNIE|FREDDIE|HUD|SECRETARY OF|GOVERNMENT|NATIONAL ASSOCIATION)\b/i
/** Registered-agent services and law firms answer for an entity; they are not the person behind it. */
const AGENT_SERVICE = /(REGISTERED AGENT|AGENT SERVICE|CORPORATION SERVICE|CT CORPORATION|INCORP SERVICES|LEGALZOOM|LEGALINC|NORTHWEST REGISTERED|COGENCY|\bLAW (FIRM|GROUP|OFFICES?)\b|\bLAW\b|ATTORNEYS?\b|\bESQ\b)/i
const PLACEHOLDER_NAME = /^(CURRENT OWNER|OWNER|UNKNOWN|UNKNOWN OWNER|NOT AVAILABLE|N\/?A|NONE)$/i
const ENTITY_MARKERS = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LP', 'LLP', 'LTD', 'PARTNERSHIP', 'TRUST', 'HOLDINGS', 'PROPERTIES', 'PROPERTY', 'INVESTMENTS', 'INVESTMENT', 'GROUP', 'ENTERPRISES', 'ENTERPRISE', 'VENTURES', 'CAPITAL', 'REALTY', 'RENTALS', 'MANAGEMENT', 'HOMES', 'ASSETS', 'PARTNERS', 'FUND', 'LIMITED', 'PLLC', 'PC'])
const GENERIC_TOKENS = new Set([...ENTITY_MARKERS, 'THE', 'OF', 'AND', 'REAL', 'ESTATE', 'HOME', 'HOUSE', 'SERVICES', 'SOLUTIONS', 'USA', 'AMERICA', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'NEW', 'FIRST', 'BAY', 'CITY', 'ST', 'AVE', 'STREET', 'RD'])

/** A person behind more than this many distinct entities is an agent/manager pattern, not an owner. */
export const MAX_ENTITY_FANOUT = 10

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function nameTokens(value) {
  return clean(value).toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2)
}

function onOff(raw) {
  const v = clean(raw).toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

export function isIdentityReleaseEnabled(options = {}, env = process.env) {
  if (options && typeof options.identity_release_enabled === 'boolean') return options.identity_release_enabled
  return onOff(env?.[IDENTITY_RELEASE_FLAG])
}

/** "Likely Owner, Family" | ["Likely Owner"] → ['Likely Owner','Family'] (known values only, exact spelling). */
export function parseContactMatchingTags(value) {
  const parts = Array.isArray(value) ? value : clean(value).split(',')
  return [...new Set(parts.map((t) => clean(t)).filter((t) => KNOWN_TAGS.has(t)))]
}

/**
 * Every identity-family hold that applies to the row (not just the winner),
 * primary first in live precedence order: linkage → entity review → ambiguous.
 * Input fields: seller_person_key/prospect_id, canonical_e164|phone,
 * entity_contact_requires_review (or entity.requires_review), and
 * ambiguous_phone_ownership (or phone_group.distinct_master_owners).
 */
export function identityHoldReasons(row = {}) {
  const reasons = []
  const personKey = clean(row.seller_person_key) || clean(row.prospect_id) || clean(row.canonical_prospect_id)
  const phone = clean(row.canonical_e164) || clean(row.phone) || clean(row.phone_id)
  if (!personKey || !phone) reasons.push(HOLD_REASONS.MISSING_IDENTITY_LINKAGE)
  const review = row.entity_contact_requires_review !== undefined
    ? row.entity_contact_requires_review === true
    // The accessor coalesces a NULL flag to true (fail closed) — mirrored here.
    : Boolean(row.entity && (row.entity.requires_review === true || row.entity.requires_review == null))
  if (review) reasons.push(HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW)
  const ambiguous = row.ambiguous_phone_ownership !== undefined
    ? row.ambiguous_phone_ownership === true
    : Number(row.phone_group?.distinct_master_owners || 0) > 1
  if (ambiguous) reasons.push(HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP)
  return { reasons, primary: reasons[0] || null }
}

/**
 * R1 — missing_identity_linkage.
 * The resolver could not pick ONE individual, but the graph's phone is held by
 * exactly one property-linked person, that person is the resolver's own
 * co_owner_individual_key, and their given name + surname are on the deed /
 * operational owner name. ambiguous → automatic; conflicting_existing_assignment
 * (a legacy master_owner disagrees) → review.
 */
export function evaluateCoOwnerPhoneLink(ev = {}) {
  const res = ev.resolution || {}
  const holders = Array.isArray(ev.phone_holders) ? ev.phone_holders : []
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
  if (!(given && surname.length && title.has(given) && surname.every((t) => title.has(t)))) {
    return { ...base, outcome: 'hold', hold: 'holder_name_not_on_title' }
  }
  const tags = parseContactMatchingTags(holder.tags_on_property)
  if (holder.likely_renting === true || tags.includes(TAGS.LIKELY_RENTING)) return { ...base, outcome: 'hold', hold: 'renter_not_owner' }
  const status = clean(res.status)
  const evidence = {
    resolved_person_key: clean(holder.individual_key),
    resolution_status: status,
    holder_name: clean(holder.full_name),
    title_name: clean(res.operational_owner_name) || clean(res.deed_owner_name),
    contact_matching_tags: tags,
  }
  if (status === 'ambiguous') return { ...base, outcome: 'release', tier: TIERS.AUTOMATIC, evidence, person_key: evidence.resolved_person_key, identity_alignment: 'probable' }
  if (status === 'conflicting_existing_assignment') return { ...base, outcome: 'release', tier: TIERS.REVIEW, evidence }
  return { ...base, outcome: 'hold', hold: `resolution_status_${status || 'unknown'}` }
}

/**
 * R2 — ambiguous_phone_ownership.
 * The dedup compares the LEGACY master_owner_id, which is split for one person
 * across properties. When every row on the phone carries the same non-null
 * canonical seller_person_key, it is one person, not a shared phone.
 */
export function evaluateSamePersonPhone(ev = {}) {
  const g = ev.phone_group || {}
  const base = { rule: RULES.SAME_PERSON_PHONE, reason: HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP }
  if (Number(g.null_person_rows || 0) > 0) return { ...base, outcome: 'hold', hold: 'a_row_on_phone_has_no_person' }
  if (Number(g.distinct_person_keys || 0) !== 1) return { ...base, outcome: 'hold', hold: 'phone_held_by_multiple_people' }
  return {
    ...base,
    outcome: 'release',
    tier: TIERS.AUTOMATIC,
    evidence: { person_key: clean(g.person_key), legacy_master_owners: Number(g.distinct_master_owners || 0), rows_on_phone: Number(g.rows || 0) },
  }
}

/**
 * The entity the contact was chosen for must BE the property's owner of record.
 * Accepted bases: the contact's given name + surname are on the owner name
 * (person_on_title), or entity and owner names share a distinctive token or a
 * street number (entity_name_match). Placeholders ("Current Owner") never pass.
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
  const shared = entityTokens.filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t) && ownerTokens.has(t))
  const digitsShared = (entity.match(/\d{2,}/g) || []).some((d) => owner.includes(d))
  if (shared.length || digitsShared) return { ok: true, basis: 'entity_name_match' }
  return { ok: false, hold: 'entity_not_owner_of_record' }
}

/**
 * R3 — entity_contact_requires_review, on Contact Matching Tags.
 *
 *   AUTOMATIC  Linked To Company or Likely Owner on this person's prospect row
 *              for THIS property, + the phone is the person's own, + no
 *              Resident / Likely Renting contradiction, + at least one
 *              corroborating link: owner-side mailing/company match, the
 *              property in the person's portfolio, or the vendor owner-match.
 *   REVIEW     only Potentially Linked To Company / Potential Owner / Family.
 *   HOLD       Resident / Likely Renting / occupant match, no tag, or any
 *              contradiction (entity not owner of record, institution, bank
 *              REO, dissolved, agent service, placeholder, >10 entities).
 *
 * No Secretary-of-State officer row is required (none exists in the data).
 */
export function evaluateEntityTaggedPrincipal(ev = {}, row = {}) {
  const e = ev.entity || {}
  const p = ev.person || null
  const base = { rule: RULES.ENTITY_TAGGED_PRINCIPAL, reason: HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW }
  if (!ev.entity) return { ...base, outcome: 'hold', hold: 'entity_evidence_missing' }
  if (!p) return { ...base, outcome: 'hold', hold: 'person_record_missing' }
  const tags = parseContactMatchingTags(p.tags_on_property)
  // 1. Contradictions first — the occupant is never the LLC.
  if (tags.some((t) => OCCUPANT_TAGS.includes(t))) return { ...base, outcome: 'hold', hold: 'resident_or_renter_tag' }
  if (p.likely_renting === true) return { ...base, outcome: 'hold', hold: 'renter_not_owner' }
  if (clean(p.matching_type) === 'property_address' && p.matches_property_owner !== true) return { ...base, outcome: 'hold', hold: 'occupant_not_owner' }
  // 2. The company must be the owner of record, and not an institution / agent.
  const exclusions = Array.isArray(e.exclusion_reasons) ? e.exclusion_reasons : []
  const evidenceCodes = Array.isArray(e.evidence_codes) ? e.evidence_codes : []
  if (exclusions.includes('ENT_DISSOLVED') || clean(e.entity_status).toLowerCase() === 'dissolved') return { ...base, outcome: 'hold', hold: 'entity_dissolved' }
  if (evidenceCodes.includes('ENT_BANK_REO')) return { ...base, outcome: 'hold', hold: 'bank_reo' }
  if (INSTITUTIONAL_ENTITY.test(clean(e.owning_entity_name))) return { ...base, outcome: 'hold', hold: 'institutional_entity' }
  if (AGENT_SERVICE.test(clean(e.owning_entity_name)) || AGENT_SERVICE.test(clean(p.full_name))) return { ...base, outcome: 'hold', hold: 'registered_agent_or_law_firm' }
  const ownerOfRecord = entityIsOwnerOfRecord(e.owning_entity_name, row.owner_name ?? ev.owner_name, p)
  if (!ownerOfRecord.ok) return { ...base, outcome: 'hold', hold: ownerOfRecord.hold }
  if (Number(p.entity_fanout || 0) > MAX_ENTITY_FANOUT) return { ...base, outcome: 'hold', hold: 'person_fronts_many_entities' }
  // 3. The phone is the person's own.
  if (p.phone_is_own !== true) return { ...base, outcome: 'hold', hold: 'phone_not_persons_own_record' }
  // 4. The relationship tag.
  const strong = tags.filter((t) => STRONG_TAGS.includes(t))
  const weak = tags.filter((t) => WEAK_TAGS.includes(t))
  if (!strong.length && !weak.length) return { ...base, outcome: 'hold', hold: 'no_contact_matching_tag' }
  // 5. Corroboration: mailing/company relationship, portfolio, vendor owner-match.
  const corroboration = []
  if (OWNER_SIDE_MATCH_TYPES.has(clean(p.matching_type))) corroboration.push(`match:${clean(p.matching_type)}`)
  if (p.in_portfolio === true) corroboration.push('portfolio')
  if (p.matches_property_owner === true) corroboration.push('vendor_owner_match')
  const evidence = {
    person_key: clean(e.selected_person_key),
    contact_matching_tags: tags,
    corroboration,
    entity: clean(e.owning_entity_name),
    owner_of_record_basis: ownerOfRecord.basis,
    entity_fanout: Number(p.entity_fanout || 0),
  }
  if (strong.length && corroboration.length) return { ...base, outcome: 'release', tier: TIERS.AUTOMATIC, evidence, identity_alignment: 'entity_company_linked' }
  if (strong.length) return { ...base, outcome: 'release', tier: TIERS.REVIEW, evidence, review_reason: 'strong_tag_without_corroboration' }
  return { ...base, outcome: 'release', tier: TIERS.REVIEW, evidence, review_reason: 'weak_tag_only' }
}

const EVALUATORS = {
  [HOLD_REASONS.MISSING_IDENTITY_LINKAGE]: (ev) => evaluateCoOwnerPhoneLink(ev),
  [HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW]: (ev, row) => evaluateEntityTaggedPrincipal(ev, row),
  [HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP]: (ev) => evaluateSamePersonPhone(ev),
}

/**
 * Evaluate one row. `evidence` is the per-property evidence object
 * (resolution, phone_holders, entity, person) plus `phone_group` from the
 * recipient dedup. A row is RELEASED only when every identity hold on it is
 * released at the AUTOMATIC tier; otherwise its tier is the weakest seen.
 */
export function evaluateIdentityRelease(row = {}, evidence = {}) {
  const { reasons, primary } = identityHoldReasons(row)
  if (!reasons.length) return { held: false, reasons, primary, released: false, results: [] }
  if (row.queue_eligible === false) return { held: true, reasons, primary, released: false, results: [], hold: 'not_queue_eligible' }
  const ev = { ...evidence, phone_group: evidence.phone_group || row.phone_group || null }
  const results = reasons.map((reason) => EVALUATORS[reason](ev, row))
  const allPass = results.every((r) => r.outcome === 'release')
  const tier = allPass ? (results.some((r) => r.tier === TIERS.REVIEW) ? TIERS.REVIEW : TIERS.AUTOMATIC) : null
  const released = tier === TIERS.AUTOMATIC
  const r1 = results.find((r) => r.rule === RULES.COOWNER_PHONE_LINK && r.outcome === 'release')
  const r3 = results.find((r) => r.rule === RULES.ENTITY_TAGGED_PRINCIPAL && r.outcome === 'release')
  return {
    held: true,
    reasons,
    primary,
    released,
    tier,
    release_rule: allPass ? results.map((r) => r.rule).join('+') : null,
    person_key: r1?.person_key || null,
    identity_alignment: r1?.identity_alignment || r3?.identity_alignment || null,
    evidence: allPass ? Object.fromEntries(results.map((r) => [r.rule, r.evidence])) : null,
    remaining_holds: results.filter((r) => r.outcome !== 'release').map((r) => `${r.reason}:${r.hold}`),
    results,
  }
}

/**
 * The graph row as readiness should see it after an AUTOMATIC release. Returns
 * the row unchanged when nothing is released. Never touches queue_eligible,
 * suppression, wrong-number, timezone or sender fields.
 */
export function applyIdentityRelease(row = {}, evaluation = null) {
  if (!evaluation?.released) return row
  const next = { ...row }
  if (evaluation.reasons.includes(HOLD_REASONS.MISSING_IDENTITY_LINKAGE) && evaluation.person_key) {
    next.seller_person_key = evaluation.person_key
  }
  if (evaluation.reasons.includes(HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW)) next.entity_contact_requires_review = false
  if (evaluation.reasons.includes(HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP)) next.ambiguous_phone_ownership = false
  if (evaluation.identity_alignment) next.identity_alignment = evaluation.identity_alignment
  next.identity_release = {
    release_rule: evaluation.release_rule,
    tier: evaluation.tier,
    released_reasons: evaluation.reasons,
    evidence: evaluation.evidence,
    decided_by: 'campaign-identity-release@2026-10-05',
  }
  return next
}

/** Aggregate evaluations: counts per reason, overlap, rule/tier and remaining hold. */
export function summarizeIdentityRelease(evaluations = []) {
  const out = { held: 0, released: 0, by_tier: { automatic: 0, review: 0 }, by_primary: {}, by_overlap: {}, by_rule: {}, remaining: {} }
  const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1 }
  for (const ev of evaluations) {
    if (!ev?.held) continue
    out.held += 1
    inc(out.by_primary, ev.primary)
    inc(out.by_overlap, ev.reasons.join('+'))
    for (const r of ev.results || []) {
      if (r.outcome === 'release') inc(out.by_rule, `${r.rule}:${r.tier}`)
      else inc(out.remaining, `${r.reason}:${r.hold}`)
    }
    if (ev.tier) inc(out.by_tier, ev.tier)
    if (ev.released) out.released += 1
  }
  return out
}
