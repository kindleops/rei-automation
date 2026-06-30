const RELATIONSHIP_LABELS: Record<string, string> = {
  master_owner: 'Owner',
  probable_owner: 'Probable Owner',
  confirmed_owner: 'Owner',
  authorized_spouse: 'Co-owner / Spouse',
  spouse_co_owner: 'Co-owner / Spouse',
  co_owner: 'Co-owner',
  executor_or_heir: 'Heir / Executor',
  executor_heir: 'Heir / Executor',
  entity_representative: 'Representative',
  llc_representative: 'Representative',
  agent_representative: 'Agent',
  property_manager: 'Property Manager',
  tenant: 'Tenant',
  renter_occupant: 'Tenant',
  referred_possible_owner: 'Referred Contact',
  referred_contact: 'Referred Contact',
  referral_source: 'Referral Source',
  respondent: 'Contact',
  respondent_non_owner: 'Family Member',
  former_owner: 'Former Owner',
  wrong_number: 'Wrong Number',
}

export function formatParticipantRelationship(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) return 'Contact'
  return RELATIONSHIP_LABELS[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export type OwnerMatchFlag = {
  key: string
  label: string
}

const POSITIVE_OWNER_MATCH_FLAGS = new Set([
  'confirmed_owner',
  'likely_owner',
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

const NEGATIVE_OWNER_MATCH_FLAGS = new Set([
  'likely_renter',
  'tenant',
  'property_manager',
  'wrong_person',
])

export type OwnerMatchFlagTone = 'positive' | 'negative' | 'neutral'

export function ownerMatchFlagTone(key: string): OwnerMatchFlagTone {
  const normalized = String(key ?? '').trim().toLowerCase()
  if (NEGATIVE_OWNER_MATCH_FLAGS.has(normalized)) return 'negative'
  if (POSITIVE_OWNER_MATCH_FLAGS.has(normalized)) return 'positive'
  return 'neutral'
}

/** Prefer per-thread prospect headline over master-owner display_name for the active phone. */
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
  return { ...participant, display_name: prospectName }
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

export function ownershipStatusLabel(status: string | null | undefined): string {
  switch (String(status ?? '').trim()) {
    case 'confirmed': return 'Confirmed Owner'
    case 'inferred': return 'Property-Associated'
    case 'denied': return 'Denied'
    default: return 'Unconfirmed'
  }
}

export function ownershipStatusTone(status: string | null | undefined): 'confirmed' | 'inferred' | 'denied' | 'neutral' {
  switch (String(status ?? '').trim()) {
    case 'confirmed': return 'confirmed'
    case 'inferred': return 'inferred'
    case 'denied': return 'denied'
    default: return 'neutral'
  }
}

const OWNER_MATCH_FLAG_LABELS: Record<string, string> = {
  confirmed_owner: 'Confirmed Owner',
  likely_owner: 'Likely Owner',
  property_owner: 'Property Owner',
  family: 'Family',
  spouse: 'Spouse',
  resident: 'Resident',
  primary_decision_maker: 'Primary Decision Maker',
  co_owner: 'Co-owner',
  heir: 'Heir',
  executor: 'Executor',
  authorized_representative: 'Authorized Representative',
  likely_renter: 'Likely Renter',
  tenant: 'Tenant',
  property_manager: 'Property Manager',
  wrong_person: 'Wrong Person',
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

  if (ownership === 'confirmed' || identity === 'confirmed_owner') flags.add('confirmed_owner')
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

  return [...flags].map((key) => ({
    key,
    label: OWNER_MATCH_FLAG_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }))
}