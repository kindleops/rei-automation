import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString } from '../../lib/data/shared'
import {
  normalizeSellerDialablePhone,
  pickSellerContactPhone,
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

const dialablePhone = (value: unknown): string =>
  normalizeSellerDialablePhone(value) || ''

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

const resolveHydratedThreadPhone = (record: Record<string, unknown>): string =>
  dialablePhone(pickSellerContactPhone(record))
  || dialablePhone(firstDefined(...MAP_THREAD_PHONE_KEYS.map((key) => record[key])))

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
    bestPhone: dialablePhone(row.best_phone_1),
    primaryPhoneId: text(row.primary_phone_id),
    agentPersona: text(row.agent_persona),
    agentFamily: text(row.agent_family),
    ownerDisplayName: text(row.display_name),
    ownerLanguage: text(row.best_language) || 'English',
  }
}

const readSellerWorkItemOwnership = async (
  propertyId: string,
): Promise<{
  masterOwnerId: string
  prospectId: string
  prospectFullName: string
  recipientPhone: string
} | null> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('v_seller_work_items')
    .select('master_owner_id, prospect_id, prospect_full_name, prospect_best_phone, display_phone')
    .eq('property_id', propertyId)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  const row = data as Record<string, unknown>
  return {
    masterOwnerId: text(row.master_owner_id),
    prospectId: text(row.prospect_id),
    prospectFullName: text(row.prospect_full_name),
    recipientPhone: dialablePhone(pickSellerContactPhone(row)),
  }
}

const readSellerWorkItemMasterOwnerId = async (propertyId: string): Promise<string> => {
  const workItem = await readSellerWorkItemOwnership(propertyId)
  return workItem?.masterOwnerId || ''
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

  const workItem = await readSellerWorkItemOwnership(normalizedPropertyId)
  const baseHints = buildMapOwnershipCheckHints(viewModel, record)
  const workItemFullName = safeHumanName(workItem?.prospectFullName || '')
  const hints = {
    ...baseHints,
    masterOwnerId: baseHints.masterOwnerId || workItem?.masterOwnerId || null,
    prospectId: baseHints.prospectId || workItem?.prospectId || null,
    prospectFullName: baseHints.prospectFullName || workItemFullName || null,
    prospectFirstName: baseHints.prospectFirstName
      || (workItemFullName ? safeHumanName(firstToken(workItemFullName)) : null),
  }
  const masterOwnerId = await resolveMasterOwnerIdForSend(normalizedPropertyId, hints)
  if (!masterOwnerId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  const ownerSignals = await readMasterOwnerSendSignals(masterOwnerId)
  let recipientPhone = ownerSignals?.bestPhone
    || workItem?.recipientPhone
    || dialablePhone(hints.recipientPhone)
    || resolveHydratedThreadPhone(record)
  const phoneId = text(hints.phoneId) || ownerSignals?.primaryPhoneId || ''

  if (!recipientPhone) {
    const resolved = await resolveCommandMapSellerPhone(normalizedPropertyId, {
      prospectId: hints.prospectId,
      masterOwnerId,
    })
    recipientPhone = dialablePhone(resolved.phone)
  }

  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  const agentPersona = text(hints.agentPersona)
    || text(hints.agentFamily)
    || ownerSignals?.agentPersona
    || ownerSignals?.agentFamily
    || ''
  const agentFirstName = agentPersona ? firstToken(safeHumanName(agentPersona) || agentPersona) : ''
  if (!agentFirstName) {
    return { ok: false, error: 'assigned_agent_missing' }
  }

  const prospectId = text(hints.prospectId)
  const { prospectFirstName, prospectFullName } = resolveGreetingName(hints)
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
    agentName: agentFirstName,
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