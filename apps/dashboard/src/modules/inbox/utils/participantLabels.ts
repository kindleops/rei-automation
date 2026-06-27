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