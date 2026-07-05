import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString } from '../../lib/data/shared'
import { resolveCommandMapSellerPhone } from '../../lib/data/commandMapData'
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
  const masterOwnerId = text(hints.masterOwnerId)
  if (!masterOwnerId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  if (hints.smsEligible === false) {
    return { ok: false, error: 'prospect_not_sms_eligible' }
  }

  let recipientPhone = toE164(hints.recipientPhone) || resolveHydratedThreadPhone(record)
  let phoneId = text(hints.phoneId)
  let ownerSignals = null as Awaited<ReturnType<typeof readMasterOwnerSendSignals>>

  if (!recipientPhone || !phoneId) {
    ownerSignals = await readMasterOwnerSendSignals(masterOwnerId)
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

  if (!ownerSignals) {
    ownerSignals = await readMasterOwnerSendSignals(masterOwnerId)
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
  const { prospectFirstName, prospectFullName } = resolveGreetingName(hints)
  const propertyAddress = text(firstDefined(
    record.property_address_full,
    record.propertyAddressFull,
    record.property_address,
    viewModel.property.address,
  ))
  const ownerDisplayName = text(hints.ownerDisplayName)
    || ownerSignals?.ownerDisplayName
    || viewModel.masterOwner.displayName
  const ownerLanguage = text(firstDefined(
    record.prospect_language_preference,
    record.prospectLanguagePreference,
    record.language_preference,
    record.languagePreference,
    record.best_language,
    record.bestLanguage,
    record.language,
    record.seller_language,
    record.sellerLanguage,
  )) || ownerSignals?.ownerLanguage || 'English'

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