/**
 * Lane D — conversation and contact identity.
 *
 * Governing rule (frontend constitution §0.1): a state named "confirmed" must
 * carry confirming evidence. Nothing in this file may assert ownership, an
 * entity type, or a relationship that it cannot point at a source for.
 */

const RELATIONSHIP_LABELS: Record<string, string> = {
  master_owner: 'Owner of record',
  probable_owner: 'Probable owner',
  confirmed_owner: 'Owner of record',
  authorized_spouse: 'Co-owner / spouse',
  spouse_co_owner: 'Co-owner / spouse',
  co_owner: 'Co-owner',
  executor_or_heir: 'Heir / executor',
  executor_heir: 'Heir / executor',
  // An entity signer is not the same thing as a person acting for themselves.
  // Collapsing both into "Representative" is what made an LLC and a natural
  // person render identically (RC-8).
  entity_representative: 'Signer for the entity',
  llc_representative: 'Signer for the LLC',
  agent_representative: 'Agent (acting for owner)',
  property_manager: 'Property manager',
  tenant: 'Tenant',
  renter_occupant: 'Tenant',
  referred_possible_owner: 'Referred contact',
  referred_contact: 'Referred contact',
  referral_source: 'Referral source',
  respondent: 'Responded to outreach',
  respondent_non_owner: 'Responded — not the owner of record',
  former_owner: 'Former owner',
  wrong_number: 'Wrong number',
  unknown: 'Relationship unknown',
}

/** Relationships that only make sense against a legal entity, not a person. */
const ENTITY_RELATIONSHIPS = new Set(['entity_representative', 'llc_representative'])

export function formatParticipantRelationship(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) return 'Relationship unknown'
  return RELATIONSHIP_LABELS[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function isEntityRelationship(value: string | null | undefined): boolean {
  return ENTITY_RELATIONSHIPS.has(String(value ?? '').trim().toLowerCase())
}

export type OwnerMatchFlag = {
  key: string
  label: string
}

/**
 * Flags that are themselves evidence of an owner relationship.
 * `likely_owner` is deliberately NOT here — project history records it as a
 * heuristic, not verification, so it must never render with a positive
 * (green / confirmed) tone next to a verification badge.
 */
const POSITIVE_OWNER_MATCH_FLAGS = new Set([
  'confirmed_owner',
  'property_owner',
  'family',
  'spouse',
  'resident',
  'primary_decision_maker',
  'co_owner',
  'heir',
  'executor',
  'authorized_representative',
])

/** Heuristic, unverified signals. Rendered in a caution tone with the word "unverified". */
const HEURISTIC_OWNER_MATCH_FLAGS = new Set([
  'likely_owner',
])

const NEGATIVE_OWNER_MATCH_FLAGS = new Set([
  'likely_renter',
  'tenant',
  'property_manager',
  'wrong_person',
])

export type OwnerMatchFlagTone = 'positive' | 'heuristic' | 'negative' | 'neutral'

export function ownerMatchFlagTone(key: string): OwnerMatchFlagTone {
  const normalized = String(key ?? '').trim().toLowerCase()
  if (NEGATIVE_OWNER_MATCH_FLAGS.has(normalized)) return 'negative'
  if (HEURISTIC_OWNER_MATCH_FLAGS.has(normalized)) return 'heuristic'
  if (POSITIVE_OWNER_MATCH_FLAGS.has(normalized)) return 'positive'
  return 'neutral'
}

/**
 * Attach the per-thread prospect headline WITHOUT destroying the canonical
 * `display_name`. The previous implementation overwrote it on phone match, so
 * the operator could never see that the contact record and the thread label
 * disagree (RC-8).
 */
export function withThreadProspectDisplayName(
  participant: PropertyParticipant | null,
  threadProspectName: string | null | undefined,
  activePhone: string | null | undefined,
): PropertyParticipant | null {
  if (!participant) return null
  const phone = String(participant.canonical_e164 ?? '').trim()
  const threadPhone = String(activePhone ?? '').trim()
  const prospectName = String(threadProspectName ?? '').trim()
  if (!prospectName || !phone || !threadPhone || phone !== threadPhone) return participant
  return { ...participant, thread_display_name: prospectName }
}

export type OwnershipStatus = 'confirmed' | 'inferred' | 'unconfirmed' | 'denied'

export type PropertyParticipant = {
  participant_id: string
  property_id: string | null
  master_owner_id?: string | null
  prospect_id?: string | null
  phone_id?: string | null
  canonical_e164: string | null
  display_name: string | null
  /** Thread-level headline for this phone. Never overwrites `display_name`. */
  thread_display_name?: string | null
  relationship_to_property: string | null
  identity_class?: string | null
  ownership_status?: OwnershipStatus | string | null
  ownership_confidence?: number | null
  ownership_source?: string | null
  ownership_inference_reason?: string | null
  owner_match_flags?: OwnerMatchFlag[]
  contact_rank?: number | null
  contact_rank_label?: string | null
  contact_score?: number | null
  best_phone_score?: number | null
  sms_eligible?: boolean
  contactability?: string | null
  likely_owner?: boolean
  likely_renting?: boolean
  matching_flags?: string | null
  person_flags_text?: string | null
  last_message_at?: string | null
  unread_count?: number
  safe_to_contact?: boolean
  safe_to_contact_reason?: string | null
  is_current_participant?: boolean
  is_primary_owner_record?: boolean
  is_referred_contact?: boolean
  excluded_as_renter?: boolean
  needs_review?: boolean
  active_thread_state?: string | null
  /** Set by the client when no participant record exists. Never treated as evidence. */
  is_client_derived?: boolean
}

export type PropertyParticipantGraph = {
  property_id: string | null
  master_owner_name?: string | null
  master_owner_household_label?: string | null
  property_address_full?: string | null
  participants: PropertyParticipant[]
  selected_participant: PropertyParticipant | null
  next_eligible_contact?: PropertyParticipant | null
  next_eligible_reason?: string | null
  next_eligible_selection_log?: Record<string, unknown> | null
  selected_outbound_recipient: {
    participant_id: string | null
    canonical_e164: string | null
    display_name: string | null
    relationship_to_property: string | null
    safe_to_contact?: boolean
  } | null
}

// ── Ownership verification ────────────────────────────────────────────────
//
// RC-7: `ownership_status === 'confirmed'` was a bare string equality. The API
// only ever produces "confirmed" together with an `ownership_source`
// (participant-intelligence.js:105-154). The client-side fallback participant
// derives a status from `contact_identity_class` and carries NO source at all.
// Requiring a source therefore separates a real confirmation from a guess.

export type OwnershipLevel = 'confirmed' | 'inferred' | 'denied' | 'unverified'

export type OwnershipVerification = {
  level: OwnershipLevel
  /** Short badge text. Never says "verified" without a source. */
  label: string
  /** One plain sentence naming the evidence, or naming its absence. */
  detail: string
  source: string | null
  sourceLabel: string | null
  confidence: number | null
  icon: string
  /** True when the record claims a status the evidence does not support. */
  claimDowngraded: boolean
}

const OWNERSHIP_SOURCE_LABELS: Record<string, string> = {
  message_confirmation: 'Confirmed by the seller in this conversation',
  prior_confirmation: 'Confirmed in an earlier conversation',
  relationship_outcome: 'Confirmed on a recorded call outcome',
  message_property_knowledge: 'Answered a property-specific question',
  message_denial: 'Told us they are not the owner',
  county_record: 'Matched to the county owner record',
  deed: 'Matched to the recorded deed',
}

export function ownershipSourceLabel(source: string | null | undefined): string | null {
  const key = String(source ?? '').trim()
  if (!key) return null
  return OWNERSHIP_SOURCE_LABELS[key] || key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const asConfidence = (value: unknown): number | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n > 1 ? Math.min(100, n) / 100 : n
}

export function resolveOwnershipVerification(
  participant: PropertyParticipant | null | undefined,
): OwnershipVerification {
  const status = String(participant?.ownership_status ?? '').trim().toLowerCase()
  const source = String(participant?.ownership_source ?? '').trim() || null
  const sourceLabel = ownershipSourceLabel(source)
  const confidence = asConfidence(participant?.ownership_confidence)
  const reason = String(participant?.ownership_inference_reason ?? '').trim()

  const unverified = (detail: string, claimDowngraded = false): OwnershipVerification => ({
    level: 'unverified',
    label: 'Ownership not verified',
    detail,
    source: null,
    sourceLabel: null,
    confidence: null,
    icon: 'alert',
    claimDowngraded,
  })

  if (!participant) {
    return unverified('No contact record loaded for this property.')
  }

  // A status without a source is a claim without evidence — it is downgraded,
  // and the operator is told the record disagrees with the evidence.
  if (!source) {
    if (status === 'confirmed') {
      return unverified(
        'Marked confirmed with no confirmation on record. Treat as unverified and ask before discussing price.',
        true,
      )
    }
    if (status === 'inferred') {
      return unverified(
        'Inferred from list data only — nothing in the conversation confirms ownership.',
        true,
      )
    }
    if (status === 'denied') {
      return unverified('Marked as not the owner, with no record of who said so.', true)
    }
    return unverified('No ownership confirmation on record. Confirm ownership before discussing price.')
  }

  if (status === 'denied') {
    return {
      level: 'denied',
      label: 'Not the owner',
      detail: sourceLabel || 'Recorded as not the owner.',
      source,
      sourceLabel,
      confidence,
      icon: 'x',
      claimDowngraded: false,
    }
  }

  if (status === 'confirmed') {
    return {
      level: 'confirmed',
      label: 'Owner confirmed',
      detail: sourceLabel || 'Confirmation on record.',
      source,
      sourceLabel,
      confidence,
      icon: 'check',
      claimDowngraded: false,
    }
  }

  if (status === 'inferred') {
    return {
      level: 'inferred',
      label: 'Ownership inferred',
      detail: sourceLabel
        ? `${sourceLabel}. Not a confirmation.`
        : 'Property-specific response, but ownership is not confirmed.',
      source,
      sourceLabel,
      confidence,
      icon: 'alert-circle',
      claimDowngraded: false,
    }
  }

  return unverified(
    reason
      ? `No ownership confirmation on record (${reason.replace(/_/g, ' ')}).`
      : 'No ownership confirmation on record. Confirm ownership before discussing price.',
  )
}

/** Kept for callers that only need the coarse tone; delegates to the evidence model. */
export function ownershipStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? '').trim()) {
    case 'confirmed': return 'Owner confirmed'
    case 'inferred': return 'Ownership inferred'
    case 'denied': return 'Not the owner'
    default: return 'Ownership not verified'
  }
}

// ── Owner-record identity: entity vs. person vs. multiple parties ──────────
//
// RC-8: an LLC and a natural person rendered identically, and a multi-owner
// record was asserted to be a "household". The owner-record string is the only
// evidence we have here, so the classification quotes the token it matched on
// and never claims a relationship (spouse, family, household) it cannot prove.

export type IdentityKind = 'person' | 'entity' | 'multiple'
export type EntityKind = 'llc' | 'corporation' | 'partnership' | 'trust' | 'estate' | 'company' | 'institution'

export type OwnerNameIdentity = {
  kind: IdentityKind
  entityKind: EntityKind | null
  /** Human label for the record type. */
  typeLabel: string
  /** Individual parties named in the record. One entry for an entity/person. */
  parties: string[]
  /** The literal token in the name that proves the classification. */
  matchedToken: string | null
  /** One sentence the UI can show verbatim as the justification. */
  evidence: string
}

const ENTITY_PATTERNS: Array<{ re: RegExp; kind: EntityKind; label: string }> = [
  { re: /\b(l\.?l\.?c\.?|llc)\b/i, kind: 'llc', label: 'LLC' },
  { re: /\b(l\.?l\.?p\.?|llp)\b/i, kind: 'partnership', label: 'LLP' },
  { re: /\b(l\.?p\.?|lp)\b/i, kind: 'partnership', label: 'Limited partnership' },
  { re: /\b(inc\.?|incorporated|corp\.?|corporation)\b/i, kind: 'corporation', label: 'Corporation' },
  { re: /\b(revocable|irrevocable|living)?\s*trust\b|\btrustee[s]?\b/i, kind: 'trust', label: 'Trust' },
  { re: /\bestate of\b|\bestate\b/i, kind: 'estate', label: 'Estate' },
  { re: /\b(company|holdings?|realty|properties|investments?|partners|enterprises?|ventures?|management|capital|associates|group)\b/i, kind: 'company', label: 'Company' },
  { re: /\b(church|ministries|housing authority|city of|county of|state of|bank|credit union|hoa|homeowners association)\b/i, kind: 'institution', label: 'Institution' },
]

const MULTI_PARTY_SPLIT = /\s*(?:&|\/|\band\b)\s*/i

const cleanName = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * Found in a real browser, not in the source: when the inbox row is hydrated in
 * `initial_boot` mode the owner name arrives NULL and the thread resolver falls
 * back to the phone number — which then rendered as
 * `"+1 (404) 936-3531 household"`. A phone number is never a name
 * (constitution §0.2 — no raw phone number as a title).
 */
export function looksLikePhoneNumber(value: string | null | undefined): boolean {
  const raw = cleanName(value)
  if (!raw) return false
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 7) return false
  return /^[+()\-.\s\d]+$/.test(raw)
}

export function classifyOwnerName(name: string | null | undefined): OwnerNameIdentity {
  const value = cleanName(name)
  if (!value || looksLikePhoneNumber(value)) {
    return {
      kind: 'person',
      entityKind: null,
      typeLabel: 'Owner name not loaded',
      parties: [],
      matchedToken: null,
      evidence: 'No owner name on record for this property.',
    }
  }

  for (const pattern of ENTITY_PATTERNS) {
    const match = value.match(pattern.re)
    if (!match) continue
    const token = cleanName(match[0])
    return {
      kind: 'entity',
      entityKind: pattern.kind,
      typeLabel: pattern.label,
      parties: [value],
      matchedToken: token || null,
      evidence: token
        ? `Owner record reads "${token}" — this is an entity, not a person.`
        : 'Owner record names an entity, not a person.',
    }
  }

  const parties = value
    .split(MULTI_PARTY_SPLIT)
    .map(cleanName)
    .filter((part) => part.length > 1)

  if (parties.length > 1) {
    const token = value.match(MULTI_PARTY_SPLIT)?.[0]?.trim() || '&'
    return {
      kind: 'multiple',
      entityKind: null,
      typeLabel: `${parties.length} named owners`,
      parties,
      matchedToken: token,
      evidence: `Owner record names ${parties.length} parties, separated by "${token}". Their relationship to each other is not recorded.`,
    }
  }

  return {
    kind: 'person',
    entityKind: null,
    typeLabel: 'Individual',
    parties: [value],
    matchedToken: null,
    evidence: 'Owner record names one individual.',
  }
}

/**
 * Replacement for the `"<Name> household"` assertion at ChatThread.tsx:748.
 * Returns a line that describes the owner record without asserting a
 * relationship, plus the classification that produced it.
 */
export function describeOwnerRecord(
  ownerName: string | null | undefined,
  serverHouseholdLabel?: string | null,
): { line: string; identity: OwnerNameIdentity } | null {
  const identity = classifyOwnerName(ownerName)
  if (!identity.parties.length) return null
  // The server label is the only evidenced household statement available.
  const serverLabel = cleanName(serverHouseholdLabel)
  if (serverLabel) return { line: serverLabel, identity }
  // The caller renders `typeLabel` as its own badge — repeating it here produced
  // "Janmar Holdings LLC · LLC  LLC" (constitution R5.5).
  if (identity.kind === 'entity') {
    return { line: `Owner of record: ${identity.parties[0]}`, identity }
  }
  if (identity.kind === 'multiple') {
    return { line: `Owner of record: ${identity.parties.join(' · ')}`, identity }
  }
  return { line: `Owner of record: ${identity.parties[0]}`, identity }
}

// ── Owner-priority ordering ───────────────────────────────────────────────
//
// RC-8: `participants[0]` was positional. Order by evidence instead, so the
// selected contact is the best-evidenced owner rather than whatever the API
// happened to return first.

const ownerPriorityScore = (participant: PropertyParticipant): number => {
  const verification = resolveOwnershipVerification(participant)
  let score = 0
  if (verification.level === 'confirmed') score += 1000
  else if (verification.level === 'inferred') score += 500
  else if (verification.level === 'denied') score -= 1000
  if (participant.is_primary_owner_record) score += 300
  if (participant.is_current_participant) score += 200
  if (participant.excluded_as_renter) score -= 400
  if (participant.safe_to_contact === false) score -= 250
  const rank = Number(participant.contact_rank)
  if (Number.isFinite(rank) && rank > 0) score += Math.max(0, 100 - rank * 10)
  return score
}

export function sortParticipantsByOwnerPriority(
  participants: PropertyParticipant[],
): PropertyParticipant[] {
  return [...participants]
    .map((participant, index) => ({ participant, index, score: ownerPriorityScore(participant) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.participant)
}

/** Contacts with owner-level evidence, used for the multi-owner disclosure. */
export function selectOwnerCandidates(participants: PropertyParticipant[]): PropertyParticipant[] {
  return participants.filter((participant) => {
    const level = resolveOwnershipVerification(participant).level
    if (level === 'confirmed' || level === 'inferred') return true
    const relationship = String(participant.relationship_to_property ?? '').toLowerCase()
    return relationship.includes('owner') || relationship === 'master_owner'
  })
}

const OWNER_MATCH_FLAG_LABELS: Record<string, string> = {
  confirmed_owner: 'Confirmed owner',
  likely_owner: 'Likely owner · unverified',
  property_owner: 'Property owner',
  family: 'Family',
  spouse: 'Spouse',
  resident: 'Resident',
  primary_decision_maker: 'Primary decision maker',
  co_owner: 'Co-owner',
  heir: 'Heir',
  executor: 'Executor',
  authorized_representative: 'Authorized representative',
  likely_renter: 'Likely renter',
  tenant: 'Tenant',
  property_manager: 'Property manager',
  wrong_person: 'Wrong person',
}

const parseFlagsText = (value: string | null | undefined): string[] =>
  String(value ?? '')
    .split(/[,;|]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

/** Client-side mirror of API participant-intelligence owner_match_flags derivation. */
export function deriveOwnerMatchFlags(participant: Partial<PropertyParticipant> = {}): OwnerMatchFlag[] {
  const flags = new Set<string>()
  const matching = parseFlagsText(participant.matching_flags)
  const person = parseFlagsText(participant.person_flags_text)
  const identity = String(participant.identity_class || participant.relationship_to_property || '').trim().toLowerCase()
  const ownership = String(participant.ownership_status || '').trim().toLowerCase()
  const hasOwnershipSource = Boolean(String(participant.ownership_source ?? '').trim())

  // `confirmed_owner` is a verification claim, so it needs the same evidence
  // gate as the badge. Without a source it degrades to the heuristic flag.
  if ((ownership === 'confirmed' && hasOwnershipSource) || identity === 'confirmed_owner') flags.add('confirmed_owner')
  else if (ownership === 'confirmed') flags.add('likely_owner')
  if (participant.likely_owner === true || matching.includes('likely owner') || matching.includes('likely_owner')) {
    flags.add('likely_owner')
  }
  if (matching.includes('property owner') || person.includes('property owner')) flags.add('property_owner')
  if (person.includes('family') || matching.includes('family') || matching.includes('relative')) flags.add('family')
  if (person.includes('spouse') || matching.includes('spouse') || identity === 'authorized_spouse') flags.add('spouse')
  if (person.includes('resident') || matching.includes('resident') || person.includes('occupant')) flags.add('resident')
  if (person.includes('primary decision maker') || person.includes('decision maker')) flags.add('primary_decision_maker')
  if (person.includes('co-owner') || person.includes('co owner') || identity === 'co_owner') flags.add('co_owner')
  if (person.includes('heir') || identity === 'executor_or_heir') flags.add('heir')
  if (person.includes('executor') || identity === 'executor_or_heir') flags.add('executor')
  if (person.includes('representative') || identity === 'entity_representative') flags.add('authorized_representative')
  if (participant.likely_renting === true || matching.includes('likely renting') || matching.includes('tenant')) {
    flags.add('likely_renter')
  }
  if (person.includes('tenant') || person.includes('renter') || identity === 'renter_occupant') flags.add('tenant')
  if (person.includes('property manager') || identity === 'property_manager') flags.add('property_manager')
  if (identity === 'wrong_person' || identity === 'wrong_number') flags.add('wrong_person')

  // A confirmed flag supersedes the heuristic one — never show both.
  if (flags.has('confirmed_owner')) flags.delete('likely_owner')

  return [...flags].map((key) => ({
    key,
    label: OWNER_MATCH_FLAG_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }))
}
