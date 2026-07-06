import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString } from '../../lib/data/shared'
import {
  resolveCommandMapSellerPhone,
  resolveMasterOwnerIdForProperty,
} from '../../lib/data/commandMapData'
import { safeHumanName } from '../../lib/identity/entityDetection'
import {
  buildMapOwnershipCheckHints,
  type MapOwnershipCheckIdentity,
  type MapOwnershipCheckResolveResult,
} from './resolve-map-ownership-check'
import type { SellerMapCardViewModel } from '../../views/map/seller-card/seller-map-card.types'

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

const firstToken = (value: string): string => value.split(/\s+/).filter(Boolean)[0] ?? ''

const MAP_THREAD_PHONE_KEYS = [
  'canonical_e164',
  'canonicalE164',
  'seller_phone',
  'sellerPhone',
  'phone_number',
  'phoneNumber',
  'to_phone_number',
  'prospect_best_phone',
  'prospectBestPhone',
  'display_phone',
  'displayPhone',
  'best_phone',
  'bestPhone',
  'phone',
]

const firstDefined = (...values: unknown[]): unknown =>
  values.find((value) => value != null && text(value))

const resolveHydratedThreadPhone = (record: Record<string, unknown>): string => {
  const raw = text(firstDefined(...MAP_THREAD_PHONE_KEYS.map((key) => record[key])))
  if (!raw || raw.toLowerCase() === 'no phone') return ''
  return toE164(raw)
}

const resolveGreetingName = (hints: ReturnType<typeof buildMapOwnershipCheckHints>): {
  prospectFirstName: string
  prospectFullName: string
} => {
  const firstFromHint = safeHumanName(hints.prospectFirstName)
  const fullFromHint = safeHumanName(hints.prospectFullName)
  const firstFromFull = fullFromHint ? safeHumanName(firstToken(fullFromHint)) : ''
  const prospectFirstName = firstFromHint || firstFromFull
  const prospectFullName = fullFromHint || prospectFirstName
  return { prospectFirstName, prospectFullName }
}

const readMasterOwnerSendSignals = async (
  masterOwnerId: string,
): Promise<{
  bestPhone: string
  primaryPhoneId: string
  agentPersona: string
  agentFamily: string
  ownerDisplayName: string
  ownerLanguage: string
} | null> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('master_owners')
    .select('best_phone_1, primary_phone_id, agent_persona, agent_family, display_name, best_language')
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  const row = data as Record<string, unknown>
  return {
    bestPhone: toE164(row.best_phone_1),
    primaryPhoneId: text(row.primary_phone_id),
    agentPersona: text(row.agent_persona),
    agentFamily: text(row.agent_family),
    ownerDisplayName: text(row.display_name),
    ownerLanguage: text(row.best_language) || 'English',
  }
}

const readSellerWorkItemMasterOwnerId = async (propertyId: string): Promise<string> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('v_seller_work_items')
    .select('master_owner_id')
    .eq('property_id', propertyId)
    .limit(1)
    .maybeSingle()

  if (error || !data) return ''
  return text((data as Record<string, unknown>).master_owner_id)
}

const resolveMasterOwnerIdForSend = async (
  propertyId: string,
  hints: ReturnType<typeof buildMapOwnershipCheckHints>,
): Promise<string> => {
  const fromHints = text(hints.masterOwnerId)
  if (fromHints) return fromHints

  const fromProperty = await resolveMasterOwnerIdForProperty(propertyId)
  if (fromProperty) return fromProperty

  return readSellerWorkItemMasterOwnerId(propertyId)
}

/**
 * Browser send resolver: uses hydrated map-card identity first and never reads
 * protected prospects/phones tables. Phone and greeting name are resolved
 * independently; entity-owned phones do not block a valid best-contact send.
 */
export const resolveMapOwnershipCheckForSend = async (
  propertyId: string,
  viewModel: SellerMapCardViewModel,
  record: Record<string, unknown>,
): Promise<MapOwnershipCheckResolveResult> => {
  const normalizedPropertyId = text(propertyId)
  if (!normalizedPropertyId) {
    return { ok: false, error: 'property_id is required' }
  }

  const hints = buildMapOwnershipCheckHints(viewModel, record)
  const masterOwnerId = await resolveMasterOwnerIdForSend(normalizedPropertyId, hints)
  if (!masterOwnerId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  let recipientPhone = toE164(hints.recipientPhone) || resolveHydratedThreadPhone(record)
  let phoneId = text(hints.phoneId)
  let ownerSignals = null as Awaited<ReturnType<typeof readMasterOwnerSendSignals>>

  ownerSignals = await readMasterOwnerSendSignals(masterOwnerId)

  if (!recipientPhone || !phoneId) {
    if (!recipientPhone) {
      recipientPhone = ownerSignals?.bestPhone || ''
    }
    if (!phoneId) {
      phoneId = ownerSignals?.primaryPhoneId || ''
    }
  }

  if (!recipientPhone) {
    const resolved = await resolveCommandMapSellerPhone(normalizedPropertyId, {
      prospectId: hints.prospectId,
      masterOwnerId,
    })
    recipientPhone = toE164(resolved.phone)
  }

  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  const agentName = text(hints.agentPersona)
    || text(hints.agentFamily)
    || ownerSignals?.agentPersona
    || ownerSignals?.agentFamily
    || ''
  const agentFirstName = agentName ? firstToken(safeHumanName(agentName) || agentName) : ''
  if (!agentName || !agentFirstName) {
    return { ok: false, error: 'assigned_agent_missing' }
  }

  const prospectId = text(hints.prospectId)
  let { prospectFirstName, prospectFullName } = resolveGreetingName(hints)
  if (prospectId && (!prospectFirstName || !prospectFullName)) {
    const supabase = getSupabaseClient()
    const { data: prospectRow } = await supabase
      .from('prospects')
      .select('first_name, full_name')
      .eq('prospect_id', prospectId)
      .limit(1)
      .maybeSingle()
    if (prospectRow) {
      const row = prospectRow as Record<string, unknown>
      prospectFirstName = prospectFirstName || safeHumanName(text(row.first_name))
      prospectFullName = prospectFullName || safeHumanName(text(row.full_name)) || prospectFirstName
    }
  }
  if (!prospectFirstName) {
    return { ok: false, error: 'prospect_name_missing' }
  }

  const propertyAddress = text(firstDefined(
    record.property_address,
    record.propertyAddress,
  )) || (() => {
    const full = text(firstDefined(
      record.property_address_full,
      record.propertyAddressFull,
      viewModel.property.address,
    ))
    return full.split(',')[0]?.trim() || full
  })()
  const ownerDisplayName = text(hints.ownerDisplayName)
    || ownerSignals?.ownerDisplayName
    || viewModel.masterOwner.displayName
  const ownerLanguage = ownerSignals?.ownerLanguage || 'English'

  const identity: MapOwnershipCheckIdentity = {
    propertyId: normalizedPropertyId,
    masterOwnerId,
    phoneId,
    recipientPhone,
    prospectId,
    prospectFirstName,
    prospectFullName,
    smsEligible: true,
    agentName,
    agentFirstName,
    ownerDisplayName,
    ownerLanguage,
    propertyAddress,
    sellerDisplayName: prospectFullName || prospectFirstName,
    smsAgentId: null,
    selectedAgentId: null,
    resolutionSource: 'hydrated_map_identity',
    resolutionDiagnostics: {
      candidateCount: 1,
      source: 'hydrated_map_identity',
    },
  }

  return { ok: true, identity }
}