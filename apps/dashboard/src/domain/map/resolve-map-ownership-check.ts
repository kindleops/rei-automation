import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../lib/supabaseClient'
import { asString, type AnyRecord } from '../../lib/data/shared'
import { resolveCommandMapSellerPhone } from '../../lib/data/commandMapData'
import { safeHumanName } from '../../lib/identity/entityDetection'
import { resolveOwnershipCheckSellerLanguage } from './ownership-check-language'

const firstToken = (value: string): string => value.split(/\s+/).filter(Boolean)[0] ?? ''

/** Production-safe PostgREST select for master_owners (lcppdrmrdfblstpcbgpf). */
export const MAP_OWNERSHIP_MASTER_OWNER_SELECT =
  'master_owner_id, best_phone_1, primary_phone_id, display_name, best_language, agent_persona, agent_family'

/** Production-safe PostgREST select for phones (lcppdrmrdfblstpcbgpf). */
export const MAP_OWNERSHIP_PHONE_SELECT =
  'phone_id, master_owner_id, canonical_e164, canonical_prospect_id, primary_prospect_id, linked_prospect_ids_json'

export const MAP_OWNERSHIP_FORBIDDEN_SELECT_COLUMNS = [
  'master_owners.sms_agent_id',
  'master_owners.selected_agent_id',
  'phones.sms_eligible',
] as const

export const OWNER_SOURCE_RANK = {
  hydrated_map_identity: 1,
  properties_master_owner_id: 2,
  property_participant_graph: 3,
  map_filter_property_prospect_links: 4,
  universal_lead_command_cache: 5,
  campaign_target_graph: 6,
} as const

export type OwnerResolutionSource = keyof typeof OWNER_SOURCE_RANK

export type MapOwnershipCheckHints = {
  masterOwnerId?: string | null
  prospectId?: string | null
  phoneId?: string | null
  recipientPhone?: string | null
  prospectFirstName?: string | null
  prospectFullName?: string | null
  ownerDisplayName?: string | null
  agentPersona?: string | null
  agentFamily?: string | null
  smsEligible?: boolean | null
  prospectLanguagePreference?: string | null
  languagePreference?: string | null
  bestLanguage?: string | null
}

export type PropertyAddressParts = {
  street: string
  city: string
  state: string
  zip: string
  county: string
  full: string
}

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
  propertyCity: string
  propertyState: string
  propertyZip: string
  propertyCounty: string
  propertyAddressFull: string
  sellerDisplayName: string
  smsAgentId: string | null
  selectedAgentId: string | null
  resolutionSource: OwnerResolutionSource
  resolutionDiagnostics: {
    candidateCount: number
    source: OwnerResolutionSource
  }
}

export type MapOwnershipCheckResolveResult =
  | { ok: true; identity: MapOwnershipCheckIdentity }
  | { ok: false; error: string; diagnostics?: { candidateCount?: number; sources?: string[] } }

type ResolverDeps = {
  supabase?: SupabaseClient
  hints?: MapOwnershipCheckHints
}

type OwnerCandidate = {
  masterOwnerId: string
  source: OwnerResolutionSource
  rank: number
  prospectId?: string | null
  phoneId?: string | null
  recipientPhone?: string | null
  confidence: number
}

const SUPPRESSED_STATUSES = new Set(['suppressed', 'blocked', 'property_suppressed'])

const text = (value: unknown): string => asString(value, '').trim()

/** Street line only — templates use {{property_address}}, not city/state/zip. */
export const resolveStreetPropertyAddress = (
  property: AnyRecord,
  record?: Record<string, unknown>,
): string => {
  const fromRecord = record
    ? text(record.property_address ?? record.propertyAddress)
    : ''
  if (fromRecord) return fromRecord
  const street = text(property.property_address)
  if (street) return street
  const full = text(property.property_address_full)
  if (!full) return ''
  return full.split(',')[0]?.trim() || full
}

const readAddressField = (
  property: AnyRecord,
  record: Record<string, unknown> | undefined,
  keys: string[],
): string => {
  for (const key of keys) {
    const fromRecord = record ? text(record[key]) : ''
    if (fromRecord) return fromRecord
    const fromProperty = text(property[key])
    if (fromProperty) return fromProperty
  }
  return ''
}

const parseCityStateZipFromTail = (tail: string): { city: string; state: string; zip: string } => {
  const trimmed = tail.trim()
  if (!trimmed) return { city: '', state: '', zip: '' }

  const stateZipMatch = trimmed.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/)
  if (stateZipMatch) {
    return { city: '', state: stateZipMatch[1].toUpperCase(), zip: stateZipMatch[2] }
  }

  const parts = trimmed.split(/\s+/)
  const last = parts[parts.length - 1] ?? ''
  const secondLast = parts[parts.length - 2] ?? ''
  if (/^\d{5}(?:-\d{4})?$/.test(last) && /^[A-Za-z]{2}$/.test(secondLast)) {
    return {
      city: parts.slice(0, -2).join(' ').trim(),
      state: secondLast.toUpperCase(),
      zip: last,
    }
  }

  if (/^[A-Za-z]{2}$/.test(last)) {
    return {
      city: parts.slice(0, -1).join(' ').trim(),
      state: last.toUpperCase(),
      zip: '',
    }
  }

  return { city: trimmed, state: '', zip: '' }
}

/** Resolve street/city/state/zip/county for ownership_check template variables. */
export const parsePropertyAddressParts = (
  property: AnyRecord,
  record?: Record<string, unknown>,
): PropertyAddressParts => {
  const street = resolveStreetPropertyAddress(property, record)
  const city = readAddressField(property, record, [
    'property_address_city',
    'property_city',
    'city',
  ])
  const state = readAddressField(property, record, [
    'property_address_state',
    'property_state',
    'state',
  ])
  const zip = readAddressField(property, record, [
    'property_address_zip',
    'property_zip',
    'zip',
  ])
  const county = readAddressField(property, record, [
    'property_address_county_name',
    'property_county',
    'county',
  ])
  const full = readAddressField(property, record, [
    'property_address_full',
    'propertyAddressFull',
  ]) || [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')

  if (city || state || zip) {
    return { street, city, state, zip, county, full }
  }

  const source = full || street
  const commaParts = source.split(',').map((part) => part.trim()).filter(Boolean)
  if (commaParts.length >= 3) {
    const parsedTail = parseCityStateZipFromTail(commaParts.slice(2).join(', '))
    return {
      street: commaParts[0] ?? street,
      city: commaParts[1] ?? parsedTail.city,
      state: parsedTail.state,
      zip: parsedTail.zip,
      county,
      full: source,
    }
  }
  if (commaParts.length === 2) {
    const parsedTail = parseCityStateZipFromTail(commaParts[1] ?? '')
    return {
      street: commaParts[0] ?? street,
      city: parsedTail.city,
      state: parsedTail.state,
      zip: parsedTail.zip,
      county,
      full: source,
    }
  }

  return { street, city: '', state: '', zip: '', county, full: source }
}

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

const resolveAgentName = (ownerRow: AnyRecord, hints?: MapOwnershipCheckHints): string => {
  const hintPersona = text(hints?.agentPersona)
  if (hintPersona) return hintPersona
  const hintFamily = text(hints?.agentFamily)
  if (hintFamily) return hintFamily
  const persona = text(ownerRow.agent_persona)
  if (persona) return persona
  return text(ownerRow.agent_family)
}

const addCandidate = (
  candidates: OwnerCandidate[],
  seen: Set<string>,
  candidate: Omit<OwnerCandidate, 'rank'> & { rank?: number },
): void => {
  const masterOwnerId = text(candidate.masterOwnerId)
  if (!masterOwnerId) return
  const dedupeKey = `${candidate.source}:${masterOwnerId}`
  if (seen.has(dedupeKey)) return
  seen.add(dedupeKey)
  candidates.push({
    ...candidate,
    masterOwnerId,
    rank: candidate.rank ?? OWNER_SOURCE_RANK[candidate.source],
  })
}

const isSuppressedParticipant = (row: AnyRecord): boolean => {
  const status = text(row.suppression_status).toLowerCase()
  return SUPPRESSED_STATUSES.has(status)
}

const isSafeParticipant = (row: AnyRecord): boolean => row.safe_to_contact !== false

const participantSortScore = (row: AnyRecord): number => {
  let score = 0
  if (row.is_primary_owner_record === true) score += 1000
  if (row.is_current_participant === true) score += 500
  const confidence = Number(row.ownership_confidence)
  if (Number.isFinite(confidence)) score += confidence * 100
  const rank = Number(row.contact_rank)
  if (Number.isFinite(rank)) score += Math.max(0, 50 - rank)
  return score
}

const selectOwnerCandidate = (
  candidates: OwnerCandidate[],
): { ok: true; candidate: OwnerCandidate } | { ok: false; error: string; diagnostics: { candidateCount: number; sources: string[] } } => {
  const valid = candidates.filter((entry) => text(entry.masterOwnerId))
  if (valid.length === 0) {
    return {
      ok: false,
      error: 'property_owner_link_missing',
      diagnostics: { candidateCount: 0, sources: [] },
    }
  }

  const bestRank = Math.min(...valid.map((entry) => entry.rank))
  const atBestRank = valid.filter((entry) => entry.rank === bestRank)
  const distinctOwners = new Set(atBestRank.map((entry) => entry.masterOwnerId))

  if (distinctOwners.size > 1) {
    return {
      ok: false,
      error: 'property_owner_link_ambiguous',
      diagnostics: {
        candidateCount: atBestRank.length,
        sources: [...new Set(atBestRank.map((entry) => entry.source))],
      },
    }
  }

  const winner = atBestRank.reduce((best, current) => {
    if (!best) return current
    if (current.confidence > best.confidence) return current
    if (current.confidence < best.confidence) return best
    return current
  }, atBestRank[0])

  return { ok: true, candidate: winner }
}

const confirmHydratedMasterOwner = async (
  supabase: SupabaseClient,
  propertyId: string,
  masterOwnerId: string,
): Promise<boolean> => {
  const checks = await Promise.all([
    supabase
      .from('properties')
      .select('property_id')
      .eq('property_id', propertyId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('property_participant_graph')
      .select('property_id')
      .eq('property_id', propertyId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('map_filter_property_prospect_links')
      .select('property_id')
      .eq('property_id', propertyId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('universal_lead_command_cache')
      .select('property_id')
      .eq('property_id', propertyId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('campaign_target_graph')
      .select('property_id')
      .eq('property_id', propertyId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle(),
  ])

  return checks.some(({ data, error }) => !error && Boolean(data))
}

const validateProspectBelongsToOwner = async (
  supabase: SupabaseClient,
  propertyId: string,
  masterOwnerId: string,
  prospectId: string,
): Promise<boolean> => {
  const normalizedProspectId = text(prospectId)
  const normalizedOwnerId = text(masterOwnerId)
  if (!normalizedProspectId || !normalizedOwnerId) return false

  const { data: linkRow, error: linkError } = await supabase
    .from('map_filter_property_prospect_links')
    .select('prospect_id, master_owner_id')
    .eq('property_id', propertyId)
    .eq('prospect_id', normalizedProspectId)
    .limit(1)
    .maybeSingle()

  if (!linkError && linkRow) {
    return text((linkRow as AnyRecord).master_owner_id) === normalizedOwnerId
  }

  const { data: prospectRow, error: prospectError } = await supabase
    .from('prospects')
    .select('prospect_id, master_owner_id')
    .eq('prospect_id', normalizedProspectId)
    .limit(1)
    .maybeSingle()

  if (prospectError || !prospectRow) return false
  const prospectOwnerId = text((prospectRow as AnyRecord).master_owner_id)
  return prospectOwnerId === normalizedOwnerId
}

const loadPropertyOwnerProspects = async (
  supabase: SupabaseClient,
  propertyId: string,
  masterOwnerId: string,
): Promise<string[]> => {
  const { data: linkRows, error } = await supabase
    .from('map_filter_property_prospect_links')
    .select('prospect_id')
    .eq('property_id', propertyId)
    .eq('master_owner_id', masterOwnerId)

  if (error || !Array.isArray(linkRows)) return []
  return [...new Set((linkRows as AnyRecord[]).map((row) => text(row.prospect_id)).filter(Boolean))]
}

const phoneLinksToProspect = (phoneRow: AnyRecord, prospectId: string): boolean => {
  const normalizedProspectId = text(prospectId)
  if (!normalizedProspectId) return false
  const directMatches = [
    text(phoneRow.canonical_prospect_id),
    text(phoneRow.primary_prospect_id),
  ]
  if (directMatches.includes(normalizedProspectId)) return true
  return parseLinkedProspectIds(phoneRow.linked_prospect_ids_json).includes(normalizedProspectId)
}

const resolveProspectForPropertyOwner = async (
  supabase: SupabaseClient,
  propertyId: string,
  masterOwnerId: string,
  candidate: OwnerCandidate,
  hints: MapOwnershipCheckHints,
  phoneRow: AnyRecord | null,
  recipientPhone: string,
): Promise<string | null> => {
  const preferred = [text(candidate.prospectId), text(hints.prospectId)].filter(Boolean) as string[]
  for (const prospectId of preferred) {
    if (await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, prospectId)) {
      return prospectId
    }
  }

  const linkedProspects = await loadPropertyOwnerProspects(supabase, propertyId, masterOwnerId)
  if (linkedProspects.length === 1) {
    return linkedProspects[0]
  }

  const phoneProspectId = phoneRow ? resolveProspectIdFromPhone(phoneRow) : null
  if (phoneProspectId && linkedProspects.includes(phoneProspectId)) {
    return phoneProspectId
  }

  if (linkedProspects.length > 0) {
    for (const prospectId of linkedProspects) {
      const { data: prospectRow } = await supabase
        .from('prospects')
        .select('prospect_id, best_phone, sms_eligible')
        .eq('prospect_id', prospectId)
        .limit(1)
        .maybeSingle()
      if (!prospectRow) continue
      const row = prospectRow as AnyRecord
      if (row.sms_eligible !== true) continue
      if (recipientPhone && toE164(row.best_phone) === recipientPhone) {
        return prospectId
      }
    }

    for (const prospectId of linkedProspects) {
      const { data: prospectRow } = await supabase
        .from('prospects')
        .select('prospect_id, sms_eligible')
        .eq('prospect_id', prospectId)
        .limit(1)
        .maybeSingle()
      if ((prospectRow as AnyRecord | null)?.sms_eligible === true) {
        return prospectId
      }
    }

    return linkedProspects[0]
  }

  if (
    phoneProspectId
    && await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, phoneProspectId)
  ) {
    return phoneProspectId
  }

  return null
}

const collectOwnerCandidates = async (
  supabase: SupabaseClient,
  propertyId: string,
  property: AnyRecord,
  hints: MapOwnershipCheckHints,
): Promise<OwnerCandidate[]> => {
  const candidates: OwnerCandidate[] = []
  const seen = new Set<string>()

  const hydratedMasterOwnerId = text(hints.masterOwnerId)
  if (hydratedMasterOwnerId) {
    const confirmed = await confirmHydratedMasterOwner(supabase, propertyId, hydratedMasterOwnerId)
    if (confirmed) {
      addCandidate(candidates, seen, {
        masterOwnerId: hydratedMasterOwnerId,
        source: 'hydrated_map_identity',
        prospectId: hints.prospectId,
        phoneId: hints.phoneId,
        recipientPhone: hints.recipientPhone,
        confidence: 1,
      })
    }
  }

  const directMasterOwnerId = text(property.master_owner_id)
  if (directMasterOwnerId) {
    addCandidate(candidates, seen, {
      masterOwnerId: directMasterOwnerId,
      source: 'properties_master_owner_id',
      confidence: 1,
    })
  }

  const { data: graphRows, error: graphError } = await supabase
    .from('property_participant_graph')
    .select(
      'master_owner_id, prospect_id, phone_id, canonical_e164, ownership_confidence, contact_rank, safe_to_contact, suppression_status, is_current_participant, is_primary_owner_record',
    )
    .eq('property_id', propertyId)
    .not('master_owner_id', 'is', null)

  if (!graphError && Array.isArray(graphRows)) {
    const eligible = (graphRows as AnyRecord[])
      .filter((row) => text(row.master_owner_id))
      .filter((row) => isSafeParticipant(row))
      .filter((row) => !isSuppressedParticipant(row))
      .filter((row) => row.is_current_participant !== false || row.is_primary_owner_record === true)
      .sort((left, right) => participantSortScore(right) - participantSortScore(left))

    for (const row of eligible) {
      addCandidate(candidates, seen, {
        masterOwnerId: text(row.master_owner_id),
        source: 'property_participant_graph',
        prospectId: text(row.prospect_id) || null,
        phoneId: text(row.phone_id) || null,
        recipientPhone: text(row.canonical_e164) || null,
        confidence: Number.isFinite(Number(row.ownership_confidence))
          ? Number(row.ownership_confidence)
          : participantSortScore(row) / 1000,
      })
    }
  }

  const { data: linkRows, error: linkError } = await supabase
    .from('map_filter_property_prospect_links')
    .select('master_owner_id, prospect_id')
    .eq('property_id', propertyId)
    .not('master_owner_id', 'is', null)

  if (!linkError && Array.isArray(linkRows)) {
    for (const row of linkRows as AnyRecord[]) {
      const masterOwnerId = text(row.master_owner_id)
      const prospectId = text(row.prospect_id)
      if (!masterOwnerId) continue
      const prospectValid = prospectId
        ? await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, prospectId)
        : true
      if (!prospectValid) continue
      addCandidate(candidates, seen, {
        masterOwnerId,
        source: 'map_filter_property_prospect_links',
        prospectId,
        confidence: 0.9,
      })
    }
  }

  const { data: cacheRows, error: cacheError } = await supabase
    .from('universal_lead_command_cache')
    .select(
      'master_owner_id, prospect_id, resolved_prospect_id, phone_id, resolved_phone_id, contact_channel_value, resolution_confidence',
    )
    .eq('property_id', propertyId)
    .not('master_owner_id', 'is', null)
    .order('resolution_confidence', { ascending: false })
    .limit(25)

  if (!cacheError && Array.isArray(cacheRows)) {
    for (const row of cacheRows as AnyRecord[]) {
      const masterOwnerId = text(row.master_owner_id)
      const prospectId = text(row.resolved_prospect_id) || text(row.prospect_id)
      const phoneId = text(row.resolved_phone_id) || text(row.phone_id)
      const recipientPhone = toE164(row.contact_channel_value)
      if (!masterOwnerId || !prospectId || !phoneId || !recipientPhone) continue
      addCandidate(candidates, seen, {
        masterOwnerId,
        source: 'universal_lead_command_cache',
        prospectId,
        phoneId,
        recipientPhone,
        confidence: Number.isFinite(Number(row.resolution_confidence))
          ? Number(row.resolution_confidence)
          : 0.8,
      })
    }
  }

  const { data: graphTargetRows, error: graphTargetError } = await supabase
    .from('campaign_target_graph')
    .select('master_owner_id, prospect_id, phone_id, canonical_e164, best_phone_score')
    .eq('property_id', propertyId)
    .not('master_owner_id', 'is', null)
    .order('best_phone_score', { ascending: false })
    .limit(25)

  if (!graphTargetError && Array.isArray(graphTargetRows)) {
    for (const row of graphTargetRows as AnyRecord[]) {
      const masterOwnerId = text(row.master_owner_id)
      const prospectId = text(row.prospect_id)
      const phoneId = text(row.phone_id)
      const recipientPhone = toE164(row.canonical_e164)
      if (!masterOwnerId || !prospectId || !phoneId || !recipientPhone) continue
      addCandidate(candidates, seen, {
        masterOwnerId,
        source: 'campaign_target_graph',
        prospectId,
        phoneId,
        recipientPhone,
        confidence: Number.isFinite(Number(row.best_phone_score))
          ? Number(row.best_phone_score) / 100
          : 0.5,
      })
    }
  }

  return candidates
}

const phoneMatchesOwnerBestContact = (
  row: AnyRecord | null,
  ownerBestPhone: string,
): boolean => {
  const normalizedBestPhone = toE164(ownerBestPhone)
  if (!normalizedBestPhone || !row?.phone_id) return false
  return toE164(row.canonical_e164) === normalizedBestPhone
}

const loadBrowserSafeProspectContext = async (
  supabase: SupabaseClient,
  propertyId: string,
  prospectId: string,
  masterOwnerId: string,
  hints: MapOwnershipCheckHints,
): Promise<AnyRecord | null> => {
  const { data: workItem, error: workItemError } = await supabase
    .from('v_seller_work_items')
    .select('prospect_id, prospect_full_name, prospect_best_phone, display_phone, sms_eligible, master_owner_id')
    .eq('property_id', propertyId)
    .limit(1)
    .maybeSingle()

  if (!workItemError && workItem) {
    const row = workItem as AnyRecord
    const fullFromWorkItem = safeHumanName(text(row.prospect_full_name))
    const firstFromWorkItem = fullFromWorkItem ? firstToken(fullFromWorkItem) : ''
    const firstFromHints = safeHumanName(text(hints.prospectFirstName))
    const fullFromHints = safeHumanName(text(hints.prospectFullName))
    const firstName = firstFromHints || firstFromWorkItem
    const fullName = fullFromHints || fullFromWorkItem || firstName
    if (firstName || fullName) {
      return {
        prospect_id: text(row.prospect_id) || prospectId,
        first_name: firstName,
        full_name: fullName,
        sms_eligible: row.sms_eligible === true || hints.smsEligible === true,
        master_owner_id: text(row.master_owner_id) || masterOwnerId,
      }
    }
  }

  const firstFromHints = safeHumanName(text(hints.prospectFirstName))
  const fullFromHints = safeHumanName(text(hints.prospectFullName))
  if (!firstFromHints && !fullFromHints) return null

  return {
    prospect_id: prospectId,
    first_name: firstFromHints || (fullFromHints ? firstToken(fullFromHints) : ''),
    full_name: fullFromHints || firstFromHints,
    sms_eligible: hints.smsEligible === true,
    master_owner_id: masterOwnerId,
  }
}

const resolveRecipientPhoneForOwnershipCheck = async (
  propertyId: string,
  masterOwnerId: string,
  owner: AnyRecord,
  hints: MapOwnershipCheckHints,
  candidate: OwnerCandidate,
  prospectId?: string | null,
): Promise<string> => {
  const direct = toE164(owner.best_phone_1)
    || toE164(hints.recipientPhone)
    || toE164(candidate.recipientPhone)
  if (direct) return direct

  const resolved = await resolveCommandMapSellerPhone(propertyId, {
    prospectId: prospectId || hints.prospectId,
    masterOwnerId,
  })
  return toE164(resolved.phone)
}

const resolveOwnershipCheckPhoneBinding = async (
  supabase: SupabaseClient,
  params: {
    masterOwnerId: string
    recipientPhone: string
    owner: AnyRecord
    hints: MapOwnershipCheckHints
    candidate: OwnerCandidate
    prospectId: string
  },
): Promise<{ phoneId: string; phoneRow: AnyRecord | null } | null> => {
  const { masterOwnerId, recipientPhone, owner, hints, candidate, prospectId } = params
  const primaryPhoneId = text(owner.primary_phone_id)
  const hintPhoneId = text(candidate.phoneId) || text(hints.phoneId)

  const initialPhoneRow = await resolvePhoneRow(
    supabase,
    masterOwnerId,
    recipientPhone,
    primaryPhoneId,
    hintPhoneId,
    null,
    recipientPhone,
  )

  const phoneRow = await resolvePhoneRow(
    supabase,
    masterOwnerId,
    recipientPhone,
    primaryPhoneId,
    hintPhoneId,
    prospectId,
    recipientPhone,
  ) || initialPhoneRow

  const phoneId = text(phoneRow?.phone_id)
    || hintPhoneId
    || primaryPhoneId

  if (!phoneId || !recipientPhone) return null
  return { phoneId, phoneRow }
}

const resolvePhoneRow = async (
  supabase: SupabaseClient,
  masterOwnerId: string,
  recipientPhone: string,
  primaryPhoneId: string,
  hintPhoneId?: string | null,
  prospectId?: string | null,
  ownerBestPhone?: string | null,
): Promise<AnyRecord | null> => {
  const normalizedProspectId = text(prospectId)
  const normalizedOwnerBestPhone = toE164(ownerBestPhone || recipientPhone)
  const acceptPhone = (row: AnyRecord | null): AnyRecord | null => {
    if (!row?.phone_id) return null
    if (!normalizedProspectId || phoneLinksToProspect(row, normalizedProspectId)) return row
    if (phoneMatchesOwnerBestContact(row, normalizedOwnerBestPhone)) return row
    return null
  }
  const normalizedPhone = toE164(recipientPhone)
  const hintedPhoneId = text(hintPhoneId)

  if (hintedPhoneId) {
    const { data, error } = await supabase
      .from('phones')
      .select(MAP_OWNERSHIP_PHONE_SELECT)
      .eq('phone_id', hintedPhoneId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      const row = data as AnyRecord
      if (!normalizedPhone || toE164(row.canonical_e164) === normalizedPhone) {
        const accepted = acceptPhone(row)
        if (accepted) return accepted
      }
    }
  }

  if (primaryPhoneId) {
    const { data, error } = await supabase
      .from('phones')
      .select(MAP_OWNERSHIP_PHONE_SELECT)
      .eq('phone_id', primaryPhoneId)
      .eq('master_owner_id', masterOwnerId)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      const row = data as AnyRecord
      if (!normalizedPhone || toE164(row.canonical_e164) === normalizedPhone) {
        const accepted = acceptPhone(row)
        if (accepted) return accepted
      }
    }
  }

  if (normalizedPhone) {
    const { data, error } = await supabase
      .from('phones')
      .select(MAP_OWNERSHIP_PHONE_SELECT)
      .eq('master_owner_id', masterOwnerId)
      .eq('canonical_e164', normalizedPhone)
      .limit(1)
      .maybeSingle()
    if (!error && data) {
      const accepted = acceptPhone(data as AnyRecord)
      if (accepted) return accepted
    }
  }

  if (normalizedProspectId && normalizedPhone) {
    const { data: phoneRows, error } = await supabase
      .from('phones')
      .select(MAP_OWNERSHIP_PHONE_SELECT)
      .eq('master_owner_id', masterOwnerId)
      .eq('canonical_e164', normalizedPhone)
      .limit(10)
    if (!error && Array.isArray(phoneRows)) {
      for (const row of phoneRows as AnyRecord[]) {
        if (phoneLinksToProspect(row, normalizedProspectId)) return row
      }
    }
  }

  return null
}

export const buildMapOwnershipCheckHints = (
  viewModel: { propertyId: string; masterOwner: { id: string | null; displayName: string } },
  record: Record<string, unknown>,
): MapOwnershipCheckHints => {
  const firstDefined = (...values: unknown[]): unknown => values.find((value) => value != null && text(value))

  return {
    masterOwnerId: viewModel.masterOwner.id
      || text(firstDefined(
        record.master_owner_id,
        record.masterOwnerId,
        record.owner_id,
        record.ownerId,
      ))
      || null,
    prospectId: text(firstDefined(record.prospect_id, record.prospectId)) || null,
    phoneId: text(firstDefined(record.phone_id, record.resolved_phone_id)) || null,
    recipientPhone: toE164(firstDefined(
      record.canonical_e164,
      record.prospect_best_phone,
      record.display_phone,
      record.seller_phone,
    )) || null,
    prospectFirstName: text(firstDefined(record.prospect_first_name, record.prospectFirstName)) || null,
    prospectFullName: text(firstDefined(record.prospect_full_name, record.prospect_name, record.prospectFullName)) || null,
    ownerDisplayName: viewModel.masterOwner.displayName
      || text(firstDefined(record.owner_display_name, record.owner_name)) || null,
    agentPersona: text(firstDefined(record.agent_persona, record.agentPersona)) || null,
    agentFamily: text(firstDefined(record.agent_family, record.agentFamily)) || null,
    smsEligible: record.sms_eligible === false
      ? false
      : record.sms_eligible === true
        ? true
        : null,
    prospectLanguagePreference: text(firstDefined(
      record.prospect_language_preference,
      record.prospectLanguagePreference,
    )) || null,
    languagePreference: text(firstDefined(
      record.language_preference,
      record.languagePreference,
      record.seller_language,
      record.sellerLanguage,
    )) || null,
    bestLanguage: text(firstDefined(
      record.best_language,
      record.bestLanguage,
    )) || null,
  }
}

const buildIdentityFromResolvedParts = ({
  propertyId,
  property,
  owner,
  hints,
  masterOwnerId,
  prospectId,
  prospectFirstName,
  prospectFullName,
  recipientPhone,
  phoneId,
  resolutionSource,
  candidateCount,
}: {
  propertyId: string
  property: AnyRecord
  owner: AnyRecord
  hints: MapOwnershipCheckHints
  masterOwnerId: string
  prospectId: string
  prospectFirstName: string
  prospectFullName: string
  recipientPhone: string
  phoneId: string
  resolutionSource: OwnerResolutionSource
  candidateCount: number
}): MapOwnershipCheckResolveResult => {
  const agentName = resolveAgentName(owner, hints)
  const agentFirstName = firstAgentToken(agentName)
  if (!agentName || !agentFirstName) {
    return { ok: false, error: 'assigned_agent_missing' }
  }

  const ownerDisplayName = text(owner.display_name) || text(hints.ownerDisplayName)
  const addressParts = parsePropertyAddressParts(property)
  const propertyAddress = addressParts.street || resolveStreetPropertyAddress(property)

  return {
    ok: true,
    identity: {
      propertyId,
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
      ownerLanguage: resolveOwnershipCheckSellerLanguage({
        prospectLanguagePreference: hints.prospectLanguagePreference,
        languagePreference: hints.languagePreference,
        bestLanguage: hints.bestLanguage,
        ownerBestLanguage: text(owner.best_language) || null,
      }),
      propertyAddress,
      propertyCity: addressParts.city,
      propertyState: addressParts.state,
      propertyZip: addressParts.zip,
      propertyCounty: addressParts.county,
      propertyAddressFull: addressParts.full,
      sellerDisplayName: prospectFullName || prospectFirstName,
      smsAgentId: null,
      selectedAgentId: null,
      resolutionSource,
      resolutionDiagnostics: {
        candidateCount,
        source: resolutionSource,
      },
    },
  }
}

const tryResolveFromHydratedMapHints = async (
  supabase: SupabaseClient,
  propertyId: string,
  property: AnyRecord,
  hints: MapOwnershipCheckHints,
): Promise<MapOwnershipCheckResolveResult | null> => {
  const masterOwnerId = text(hints.masterOwnerId)
  const prospectId = text(hints.prospectId)
  if (!masterOwnerId || !prospectId) return null

  const propertyOwnerId = text(property.master_owner_id)
  if (propertyOwnerId && propertyOwnerId !== masterOwnerId) return null

  if (!propertyOwnerId) {
    const confirmed = await confirmHydratedMasterOwner(supabase, propertyId, masterOwnerId)
    if (!confirmed) return null
  }

  const { data: ownerRow, error: ownerError } = await supabase
    .from('master_owners')
    .select(MAP_OWNERSHIP_MASTER_OWNER_SELECT)
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (ownerError || !ownerRow) return null

  const owner = ownerRow as AnyRecord
  const recipientPhone = await resolveRecipientPhoneForOwnershipCheck(
    propertyId,
    masterOwnerId,
    owner,
    hints,
    {
      masterOwnerId,
      source: 'hydrated_map_identity',
      rank: OWNER_SOURCE_RANK.hydrated_map_identity,
      confidence: 1,
      prospectId,
      phoneId: hints.phoneId,
      recipientPhone: hints.recipientPhone,
    },
    prospectId,
  )
  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  const phoneBinding = await resolveOwnershipCheckPhoneBinding(supabase, {
    masterOwnerId,
    recipientPhone,
    owner,
    hints,
    candidate: {
      masterOwnerId,
      source: 'hydrated_map_identity',
      rank: OWNER_SOURCE_RANK.hydrated_map_identity,
      confidence: 1,
      prospectId,
      phoneId: hints.phoneId,
      recipientPhone: hints.recipientPhone,
    },
    prospectId,
  })
  if (!phoneBinding) return null
  const phoneId = phoneBinding.phoneId

  let prospectFirstName = safeHumanName(text(hints.prospectFirstName))
  let prospectFullName = safeHumanName(text(hints.prospectFullName)) || prospectFirstName
  if (!prospectFirstName || !prospectFullName) {
    const { data: prospectRow } = await supabase
      .from('prospects')
      .select('first_name, full_name')
      .eq('prospect_id', prospectId)
      .limit(1)
      .maybeSingle()
    const prospect = prospectRow as AnyRecord | null
    const loadedFirst = safeHumanName(text(prospect?.first_name))
    const loadedFull = safeHumanName(text(prospect?.full_name))
    prospectFirstName = prospectFirstName || (loadedFirst ? firstToken(loadedFirst) : '')
    prospectFullName = prospectFullName || loadedFull || prospectFirstName
    if (!prospectFirstName && loadedFull) {
      prospectFirstName = firstToken(loadedFull)
    }
    if (!prospectFirstName || !prospectFullName) {
      const fallback = await loadBrowserSafeProspectContext(
        supabase,
        propertyId,
        prospectId,
        masterOwnerId,
        hints,
      )
      if (fallback) {
        const fallbackFirst = safeHumanName(text(fallback.first_name))
        const fallbackFull = safeHumanName(text(fallback.full_name))
        prospectFirstName = prospectFirstName || (fallbackFirst ? firstToken(fallbackFirst) : '')
        prospectFullName = prospectFullName || fallbackFull || prospectFirstName
        if (!prospectFirstName && fallbackFull) {
          prospectFirstName = firstToken(fallbackFull)
        }
      }
    }
  }
  if (!prospectFirstName) return null

  return buildIdentityFromResolvedParts({
    propertyId,
    property,
    owner,
    hints,
    masterOwnerId,
    prospectId,
    prospectFirstName,
    prospectFullName,
    recipientPhone,
    phoneId,
    resolutionSource: 'hydrated_map_identity',
    candidateCount: 1,
  })
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
  const hints = deps.hints ?? {}

  const { data: propertyRow, error: propertyError } = await supabase
    .from('properties')
    .select('property_id, property_export_id, master_owner_id, property_address_full, property_address')
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

  const hydratedResult = await tryResolveFromHydratedMapHints(
    supabase,
    normalizedPropertyId,
    property,
    hints,
  )
  if (hydratedResult) {
    return hydratedResult
  }

  const candidates = await collectOwnerCandidates(supabase, normalizedPropertyId, property, hints)
  const selection = selectOwnerCandidate(candidates)
  if (!selection.ok) {
    return {
      ok: false,
      error: selection.error,
      diagnostics: selection.diagnostics,
    }
  }

  const { candidate } = selection
  const masterOwnerId = candidate.masterOwnerId

  const { data: ownerRow, error: ownerError } = await supabase
    .from('master_owners')
    .select(MAP_OWNERSHIP_MASTER_OWNER_SELECT)
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (ownerError) {
    return { ok: false, error: ownerError.message || 'master_owner_lookup_failed' }
  }
  if (!ownerRow) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  const owner = ownerRow as AnyRecord
  const preliminaryPhone = toE164(owner.best_phone_1)
    || toE164(hints.recipientPhone)
    || toE164(candidate.recipientPhone)

  const initialPhoneRow = preliminaryPhone
    ? await resolvePhoneRow(
      supabase,
      masterOwnerId,
      preliminaryPhone,
      text(owner.primary_phone_id),
      candidate.phoneId || hints.phoneId,
      null,
      preliminaryPhone,
    )
    : null

  const prospectId = await resolveProspectForPropertyOwner(
    supabase,
    normalizedPropertyId,
    masterOwnerId,
    candidate,
    hints,
    initialPhoneRow,
    preliminaryPhone || '',
  )

  if (!prospectId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  const recipientPhone = await resolveRecipientPhoneForOwnershipCheck(
    normalizedPropertyId,
    masterOwnerId,
    owner,
    hints,
    candidate,
    prospectId,
  )
  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  const phoneBinding = await resolveOwnershipCheckPhoneBinding(supabase, {
    masterOwnerId,
    recipientPhone,
    owner,
    hints,
    candidate,
    prospectId,
  })
  if (!phoneBinding) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }
  const phoneId = phoneBinding.phoneId

  const { data: prospectRow, error: prospectError } = await supabase
    .from('prospects')
    .select('prospect_id, first_name, full_name, sms_eligible, master_owner_id')
    .eq('prospect_id', prospectId)
    .limit(1)
    .maybeSingle()

  let prospect = (prospectRow as AnyRecord | null)
  if (!prospect) {
    prospect = await loadBrowserSafeProspectContext(
      supabase,
      normalizedPropertyId,
      prospectId,
      masterOwnerId,
      hints,
    )
  }

  if (prospectError && !prospect) {
    return { ok: false, error: prospectError.message || 'prospect_lookup_failed' }
  }
  if (!prospect) {
    return { ok: false, error: 'property_owner_link_missing' }
  }
  const loadedFirst = safeHumanName(text(prospect.first_name) || text(hints.prospectFirstName))
  const loadedFull = safeHumanName(text(prospect.full_name) || text(hints.prospectFullName))
  const prospectFirstName = loadedFirst
    ? firstToken(loadedFirst)
    : (loadedFull ? firstToken(loadedFull) : '')
  const prospectFullName = loadedFull || prospectFirstName

  const prospectMasterOwnerId = text(prospect.master_owner_id)
  if (prospectMasterOwnerId && prospectMasterOwnerId !== masterOwnerId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  return buildIdentityFromResolvedParts({
    propertyId: normalizedPropertyId,
    property,
    owner,
    hints,
    masterOwnerId,
    prospectId,
    prospectFirstName,
    prospectFullName,
    recipientPhone,
    phoneId,
    resolutionSource: candidate.source,
    candidateCount: candidates.length,
  })
}

const resolveProspectGreetingFirstName = (
  prospectFirstName: string,
  prospectFullName: string,
): string => {
  const fromFirst = safeHumanName(prospectFirstName)
  const fromFull = safeHumanName(prospectFullName)
  if (fromFirst) return firstToken(fromFirst)
  if (fromFull) return firstToken(fromFull)
  return ''
}

export const buildOwnershipCheckTemplateContext = (
  identity: MapOwnershipCheckIdentity,
): Record<string, string> => {
  const sellerFirstName = resolveProspectGreetingFirstName(
    identity.prospectFirstName,
    identity.prospectFullName,
  )
  const city = text(identity.propertyCity)
  const state = text(identity.propertyState)
  const zip = text(identity.propertyZip)
  const county = text(identity.propertyCounty)
  const street = text(identity.propertyAddress)
  const fullAddress = text(identity.propertyAddressFull)
    || [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')

  return {
    seller_first_name: sellerFirstName,
    seller_name: sellerFirstName,
    seller_full_name: sellerFirstName,
    seller_display_name: sellerFirstName,
    first_name: sellerFirstName,
    nickname: sellerFirstName,
    owner_name: identity.ownerDisplayName,
    property_address: street,
    street_address: street,
    property_address_full: fullAddress,
    property_city: city,
    property_state: state,
    property_zip: zip,
    property_county: county,
    city,
    state,
    zip,
    county,
    agent_name: identity.agentFirstName,
    agent_first_name: identity.agentFirstName,
  }
}