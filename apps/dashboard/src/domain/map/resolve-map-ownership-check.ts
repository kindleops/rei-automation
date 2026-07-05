import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString, type AnyRecord } from '../../lib/data/shared'

export type MapOwnershipCheckIdentity = {
  propertyId: string
  masterOwnerId: string
  phoneId: string
  recipientPhone: string
  prospectId: string
  prospectFirstName: string
  prospectFullName: string
  smsEligible: boolean
  agentName: string
  agentFirstName: string
  ownerDisplayName: string
  ownerLanguage: string
  propertyAddress: string
  sellerDisplayName: string
  smsAgentId: string | null
  selectedAgentId: string | null
}

export type MapOwnershipCheckResolveResult =
  | { ok: true; identity: MapOwnershipCheckIdentity }
  | { ok: false; error: string }

type ResolverDeps = {
  supabase?: SupabaseClient
}

const text = (value: unknown): string => asString(value, '').trim()

const toE164 = (value: unknown): string => {
  const raw = text(value)
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (raw.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

const firstAgentToken = (value: string): string => {
  const trimmed = text(value)
  if (!trimmed) return ''
  return trimmed.split(/\s+/).filter(Boolean)[0] ?? ''
}

const parseLinkedProspectIds = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => text(entry)).filter(Boolean).sort()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => text(entry)).filter(Boolean).sort()
      }
    } catch {
      return []
    }
  }
  return []
}

const resolveProspectIdFromPhone = (phoneRow: AnyRecord): string | null => {
  const canonical = text(phoneRow.canonical_prospect_id)
  if (canonical) return canonical
  const primary = text(phoneRow.primary_prospect_id)
  if (primary) return primary
  const linked = parseLinkedProspectIds(phoneRow.linked_prospect_ids_json)
  return linked[0] ?? null
}

const resolveAgentName = (ownerRow: AnyRecord): string => {
  const persona = text(ownerRow.agent_persona)
  if (persona) return persona
  return text(ownerRow.agent_family)
}

export const resolveMapOwnershipCheckIdentity = async (
  propertyId: string,
  deps: ResolverDeps = {},
): Promise<MapOwnershipCheckResolveResult> => {
  const normalizedPropertyId = text(propertyId)
  if (!normalizedPropertyId) {
    return { ok: false, error: 'property_id is required' }
  }

  const supabase = deps.supabase ?? getSupabaseClient()

  const { data: propertyRow, error: propertyError } = await supabase
    .from('properties')
    .select('property_id, master_owner_id, property_address_full, property_address')
    .eq('property_id', normalizedPropertyId)
    .limit(1)
    .maybeSingle()

  if (propertyError) {
    return { ok: false, error: propertyError.message || 'property_lookup_failed' }
  }
  if (!propertyRow) {
    return { ok: false, error: 'property not found' }
  }

  const property = propertyRow as AnyRecord
  const masterOwnerId = text(property.master_owner_id)
  if (!masterOwnerId) {
    return { ok: false, error: 'property has no master_owner_id' }
  }

  const { data: ownerRow, error: ownerError } = await supabase
    .from('master_owners')
    .select(
      'master_owner_id, best_phone_1, primary_phone_id, display_name, best_language, agent_persona, agent_family, sms_agent_id, selected_agent_id',
    )
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (ownerError) {
    return { ok: false, error: ownerError.message || 'master_owner_lookup_failed' }
  }
  if (!ownerRow) {
    return { ok: false, error: 'master owner not found' }
  }

  const owner = ownerRow as AnyRecord
  const recipientPhone = toE164(owner.best_phone_1)
  if (!recipientPhone) {
    return { ok: false, error: 'master owner has no best_phone_1' }
  }

  const primaryPhoneId = text(owner.primary_phone_id)
  let phoneRow: AnyRecord | null = null

  if (primaryPhoneId) {
    const { data, error } = await supabase
      .from('phones')
      .select(
        'phone_id, master_owner_id, canonical_e164, canonical_prospect_id, primary_prospect_id, linked_prospect_ids_json, sms_eligible',
      )
      .eq('phone_id', primaryPhoneId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      const row = data as AnyRecord
      if (toE164(row.canonical_e164) === recipientPhone) {
        phoneRow = row
      }
    }
  }

  if (!phoneRow) {
    const { data, error } = await supabase
      .from('phones')
      .select(
        'phone_id, master_owner_id, canonical_e164, canonical_prospect_id, primary_prospect_id, linked_prospect_ids_json, sms_eligible',
      )
      .eq('master_owner_id', masterOwnerId)
      .eq('canonical_e164', recipientPhone)
      .limit(1)
      .maybeSingle()

    if (error) {
      return { ok: false, error: error.message || 'phone_lookup_failed' }
    }
    phoneRow = (data as AnyRecord | null) ?? null
  }

  if (!phoneRow?.phone_id) {
    return { ok: false, error: 'No phones row matched master owner best_phone_1' }
  }

  const prospectId = resolveProspectIdFromPhone(phoneRow)
  if (!prospectId) {
    return { ok: false, error: 'No human prospect linked to this phone' }
  }

  const { data: prospectRow, error: prospectError } = await supabase
    .from('prospects')
    .select('prospect_id, first_name, full_name, sms_eligible, master_owner_id')
    .eq('prospect_id', prospectId)
    .limit(1)
    .maybeSingle()

  if (prospectError) {
    return { ok: false, error: prospectError.message || 'prospect_lookup_failed' }
  }
  if (!prospectRow) {
    return { ok: false, error: 'No human prospect linked to this phone' }
  }

  const prospect = prospectRow as AnyRecord
  const prospectFirstName = text(prospect.first_name)
  if (!prospectFirstName) {
    return { ok: false, error: 'prospect first_name is required' }
  }

  const prospectMasterOwnerId = text(prospect.master_owner_id)
  if (prospectMasterOwnerId && prospectMasterOwnerId !== masterOwnerId) {
    return { ok: false, error: 'prospect/master_owner relationship invalid' }
  }

  if (prospect.sms_eligible !== true) {
    return { ok: false, error: 'prospect is not sms_eligible' }
  }

  const agentName = resolveAgentName(owner)
  if (!agentName) {
    return { ok: false, error: 'No SMS agent assigned to this property' }
  }

  const agentFirstName = firstAgentToken(agentName)
  if (!agentFirstName) {
    return { ok: false, error: 'No SMS agent assigned to this property' }
  }

  const ownerDisplayName = text(owner.display_name)
  const prospectFullName = text(prospect.full_name) || prospectFirstName
  const propertyAddress = text(property.property_address_full) || text(property.property_address)

  return {
    ok: true,
    identity: {
      propertyId: normalizedPropertyId,
      masterOwnerId,
      phoneId: text(phoneRow.phone_id),
      recipientPhone,
      prospectId,
      prospectFirstName,
      prospectFullName,
      smsEligible: true,
      agentName,
      agentFirstName,
      ownerDisplayName,
      ownerLanguage: text(owner.best_language) || 'English',
      propertyAddress,
      sellerDisplayName: prospectFullName,
      smsAgentId: text(owner.sms_agent_id) || null,
      selectedAgentId: text(owner.selected_agent_id) || null,
    },
  }
}

export const buildOwnershipCheckTemplateContext = (
  identity: MapOwnershipCheckIdentity,
): Record<string, string> => ({
  seller_first_name: identity.prospectFirstName,
  seller_name: identity.prospectFullName,
  seller_display_name: identity.sellerDisplayName,
  owner_name: identity.ownerDisplayName,
  property_address: identity.propertyAddress,
  agent_name: identity.agentName,
  agent_first_name: identity.agentFirstName,
})