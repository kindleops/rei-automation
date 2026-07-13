import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString } from '../../lib/data/shared'
import {
  normalizeSellerDialablePhone,
  pickSellerContactPhone,
  resolveCommandMapSellerIdentity,
  resolveCommandMapSellerPhone,
} from '../../lib/data/commandMapData'
import { safeHumanName } from '../../lib/identity/entityDetection'
import {
  buildMapOwnershipCheckHints,
  parsePropertyAddressParts,
  resolveMapOwnershipCheckIdentity,
  type MapOwnershipCheckHints,
  type MapOwnershipCheckResolveResult,
} from './resolve-map-ownership-check'
import type { SellerMapCardViewModel } from '../../views/map/seller-card/seller-map-card.types'

const text = (value: unknown): string => asString(value, '').trim()

const dialablePhone = (value: unknown): string =>
  normalizeSellerDialablePhone(value) || ''

const firstToken = (value: string): string => value.split(/\s+/).filter(Boolean)[0] ?? ''

const firstDefined = (...values: unknown[]): unknown =>
  values.find((value) => value != null && text(value))

const readPropertyProspectLink = async (
  propertyId: string,
): Promise<{ masterOwnerId: string; prospectId: string } | null> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('map_filter_property_prospect_links')
    .select('master_owner_id, prospect_id')
    .eq('property_id', propertyId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  const row = data as Record<string, unknown>
  const masterOwnerId = text(row.master_owner_id)
  const prospectId = text(row.prospect_id)
  if (!masterOwnerId && !prospectId) return null
  return { masterOwnerId, prospectId }
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

const enrichHintsFromWorkItem = (
  hints: MapOwnershipCheckHints,
  workItem: Awaited<ReturnType<typeof readSellerWorkItemOwnership>>,
): MapOwnershipCheckHints => {
  if (!workItem) return hints
  const workItemFullName = safeHumanName(workItem.prospectFullName || '')
  return {
    ...hints,
    masterOwnerId: hints.masterOwnerId || workItem.masterOwnerId || null,
    prospectId: hints.prospectId || workItem.prospectId || null,
    prospectFullName: hints.prospectFullName || workItemFullName || null,
    prospectFirstName: hints.prospectFirstName
      || (workItemFullName ? safeHumanName(firstToken(workItemFullName)) : null),
    recipientPhone: hints.recipientPhone || workItem.recipientPhone || null,
  }
}

const enrichHintsFromPropertyLink = async (
  propertyId: string,
  hints: MapOwnershipCheckHints,
): Promise<MapOwnershipCheckHints> => {
  if (hints.masterOwnerId && hints.prospectId) return hints
  const link = await readPropertyProspectLink(propertyId)
  if (!link) return hints
  return {
    ...hints,
    masterOwnerId: hints.masterOwnerId || link.masterOwnerId || null,
    prospectId: hints.prospectId || link.prospectId || null,
  }
}

const enrichHintsFromMasterOwner = async (
  hints: MapOwnershipCheckHints,
): Promise<MapOwnershipCheckHints> => {
  const masterOwnerId = text(hints.masterOwnerId)
  if (!masterOwnerId) return hints
  if (hints.recipientPhone && hints.phoneId && (hints.agentPersona || hints.agentFamily)) {
    return hints
  }

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('master_owners')
    .select('best_phone_1, primary_phone_id, agent_persona, agent_family, display_name, best_language')
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (error || !data) return hints
  const row = data as Record<string, unknown>
  return {
    ...hints,
    recipientPhone: hints.recipientPhone || dialablePhone(row.best_phone_1) || null,
    phoneId: hints.phoneId || text(row.primary_phone_id) || null,
    agentPersona: hints.agentPersona || text(row.agent_persona) || null,
    agentFamily: hints.agentFamily || text(row.agent_family) || null,
    ownerDisplayName: hints.ownerDisplayName || text(row.display_name) || null,
  }
}

const enrichHintsFromPhoneResolution = async (
  propertyId: string,
  hints: MapOwnershipCheckHints,
): Promise<MapOwnershipCheckHints> => {
  if (hints.recipientPhone) return hints

  const resolved = await resolveCommandMapSellerPhone(propertyId, {
    prospectId: hints.prospectId,
    masterOwnerId: hints.masterOwnerId,
  })
  if (!resolved.phone) return hints

  return {
    ...hints,
    recipientPhone: resolved.phone,
    prospectId: hints.prospectId || resolved.prospectId || null,
  }
}

const enrichHintsFromLiveIdentity = async (
  hints: MapOwnershipCheckHints,
): Promise<MapOwnershipCheckHints> => {
  const needsProspect = !hints.prospectFirstName && !hints.prospectFullName
  const needsAgent = !hints.agentPersona && !hints.agentFamily
  if ((!needsProspect && !needsAgent) || (!hints.prospectId && !hints.masterOwnerId)) {
    return hints
  }

  const live = await resolveCommandMapSellerIdentity({
    prospectId: hints.prospectId,
    masterOwnerId: hints.masterOwnerId,
  })

  const liveFirst = safeHumanName(live.prospectFirstName || '')
  const liveFull = safeHumanName(live.prospectFullName || '')
  return {
    ...hints,
    prospectFirstName: hints.prospectFirstName || liveFirst || null,
    prospectFullName: hints.prospectFullName || liveFull || null,
    agentPersona: hints.agentPersona || live.agentPersona || null,
    agentFamily: hints.agentFamily || live.agentFamily || null,
    smsEligible: hints.smsEligible ?? (live.smsEligible ? true : hints.smsEligible ?? null),
  }
}

/**
 * Browser send resolver: seeds hints from the hydrated map card, then delegates
 * to the canonical ownership-check identity resolver (property graph, prospect
 * links, master_owners, phones) so LLC/entity owners still reach linked humans.
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
  let hints = enrichHintsFromWorkItem(
    buildMapOwnershipCheckHints(viewModel, record),
    workItem,
  )
  hints = await enrichHintsFromPropertyLink(normalizedPropertyId, hints)
  hints = await enrichHintsFromMasterOwner(hints)
  hints = await enrichHintsFromLiveIdentity(hints)
  hints = await enrichHintsFromPhoneResolution(normalizedPropertyId, hints)

  const result = await resolveMapOwnershipCheckIdentity(normalizedPropertyId, { hints })
  if (!result.ok) return result

  const addressParts = parsePropertyAddressParts(
    {
      property_address: text(firstDefined(record.property_address, record.propertyAddress)),
      property_address_full: text(firstDefined(
        record.property_address_full,
        record.propertyAddressFull,
        viewModel.property.address,
      )),
      property_address_city: firstDefined(record.property_address_city, record.city),
      property_address_state: firstDefined(record.property_address_state, record.state),
      property_address_zip: firstDefined(record.property_address_zip, record.zip),
      property_address_county_name: firstDefined(
        record.property_address_county_name,
        record.county,
      ),
    },
    record,
  )
  const propertyAddress = addressParts.street || result.identity.propertyAddress

  if (
    propertyAddress === result.identity.propertyAddress
    && !addressParts.city
    && !addressParts.state
    && !addressParts.zip
    && !addressParts.county
  ) {
    return result
  }

  return {
    ok: true,
    identity: {
      ...result.identity,
      propertyAddress,
      propertyCity: addressParts.city || result.identity.propertyCity,
      propertyState: addressParts.state || result.identity.propertyState,
      propertyZip: addressParts.zip || result.identity.propertyZip,
      propertyCounty: addressParts.county || result.identity.propertyCounty,
      propertyAddressFull: addressParts.full || result.identity.propertyAddressFull,
    },
  }
}