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

export type PropertyParticipant = {
  participant_id: string
  property_id: string | null
  canonical_e164: string | null
  display_name: string | null
  relationship_to_property: string | null
  identity_class?: string | null
  last_message_at?: string | null
  unread_count?: number
  safe_to_contact?: boolean
  is_current_participant?: boolean
  is_primary_owner_record?: boolean
  is_referred_contact?: boolean
}

export type PropertyParticipantGraph = {
  property_id: string | null
  participants: PropertyParticipant[]
  selected_participant: PropertyParticipant | null
  selected_outbound_recipient: {
    participant_id: string | null
    canonical_e164: string | null
    display_name: string | null
    relationship_to_property: string | null
    safe_to_contact?: boolean
  } | null
}