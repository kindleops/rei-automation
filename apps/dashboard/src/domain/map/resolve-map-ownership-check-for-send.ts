import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString } from '../../lib/data/shared'
import {
  normalizeSellerDialablePhone,
  pickSellerContactPhone,
  resolveCommandMapSellerIdentity,
} from '../../lib/data/commandMapData'
import { safeHumanName } from '../../lib/identity/entityDetection'
import {
  buildMapOwnershipCheckHints,
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
  hints = await enrichHintsFromLiveIdentity(hints)

  const result = await resolveMapOwnershipCheckIdentity(normalizedPropertyId, { hints })
  if (!result.ok) return result

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

  if (!propertyAddress || propertyAddress === result.identity.propertyAddress) {
    return result
  }

  return {
    ok: true,
    identity: {
      ...result.identity,
      propertyAddress,
    },
  }
}