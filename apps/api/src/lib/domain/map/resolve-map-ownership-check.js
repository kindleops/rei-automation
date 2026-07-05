import { asString } from '@/lib/domain/map/map-ownership-string.js';

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
]

export const OWNER_SOURCE_RANK = {
  hydrated_map_identity: 1,
  properties_master_owner_id: 2,
  property_participant_graph: 3,
  map_filter_property_prospect_links: 4,
  universal_lead_command_cache: 5,
  campaign_target_graph: 6,
}

const SUPPRESSED_STATUSES = new Set(['suppressed', 'blocked', 'property_suppressed'])

const text = (value) => asString(value, '').trim()

const toE164 = (value) => {
  const raw = text(value)
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  if (raw.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

const firstAgentToken = (value) => {
  const trimmed = text(value)
  if (!trimmed) return ''
  return trimmed.split(/\s+/).filter(Boolean)[0] ?? ''
}

const parseLinkedPropertyIds = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => text(entry)).filter(Boolean)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => text(entry)).filter(Boolean)
      }
    } catch {
      return []
    }
  }
  return []
}

const parseLinkedProspectIds = (value) => {
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

const resolveProspectIdFromPhone = (phoneRow) => {
  const canonical = text(phoneRow.canonical_prospect_id)
  if (canonical) return canonical
  const primary = text(phoneRow.primary_prospect_id)
  if (primary) return primary
  const linked = parseLinkedProspectIds(phoneRow.linked_prospect_ids_json)
  return linked[0] ?? null
}

const resolveAgentName = (ownerRow, hints) => {
  const hintPersona = text(hints?.agentPersona)
  if (hintPersona) return hintPersona
  const hintFamily = text(hints?.agentFamily)
  if (hintFamily) return hintFamily
  const persona = text(ownerRow.agent_persona)
  if (persona) return persona
  return text(ownerRow.agent_family)
}

const addCandidate = (
  candidates,
  seen,
  candidate,
) => {
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

const isSuppressedParticipant = (row) => {
  const status = text(row.suppression_status).toLowerCase()
  return SUPPRESSED_STATUSES.has(status)
}

const isSafeParticipant = (row) => row.safe_to_contact !== false

const participantSortScore = (row) => {
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
  candidates,
) => {
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
  supabase,
  propertyId,
  masterOwnerId,
) => {
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

const validateHydratedMapIdentity = async (
  supabase,
  propertyId,
  property,
  hints,
) => {
  const masterOwnerId = text(hints.masterOwnerId)
  if (!masterOwnerId) return false

  const { data: ownerRow, error: ownerError } = await supabase
    .from('master_owners')
    .select('master_owner_id')
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (ownerError || !ownerRow) return false
  if (text(property.master_owner_id) === masterOwnerId) return true

  const prospectId = text(hints.prospectId)
  if (
    prospectId
    && await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, prospectId)
  ) {
    return true
  }

  return confirmHydratedMasterOwner(supabase, propertyId, masterOwnerId)
}

const validateProspectBelongsToOwner = async (
  supabase,
  propertyId,
  masterOwnerId,
  prospectId,
) => {
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
    return text((linkRow).master_owner_id) === normalizedOwnerId
  }

  const { data: prospectRow, error: prospectError } = await supabase
    .from('prospects')
    .select('prospect_id, master_owner_id, linked_property_ids_json')
    .eq('prospect_id', normalizedProspectId)
    .limit(1)
    .maybeSingle()

  if (prospectError || !prospectRow) return false
  const prospect = prospectRow
  const prospectOwnerId = text(prospect.master_owner_id)
  if (prospectOwnerId && prospectOwnerId !== normalizedOwnerId) return false
  const linkedProperties = parseLinkedPropertyIds(prospect.linked_property_ids_json)
  if (linkedProperties.includes(propertyId)) return true
  return prospectOwnerId === normalizedOwnerId
}

const loadPropertyOwnerProspects = async (
  supabase,
  propertyId,
  masterOwnerId,
  hints,
) => {
  const { data: linkRows, error } = await supabase
    .from('map_filter_property_prospect_links')
    .select('prospect_id')
    .eq('property_id', propertyId)
    .eq('master_owner_id', masterOwnerId)

  if (!error && Array.isArray(linkRows) && linkRows.length > 0) {
    return [...new Set((linkRows).map((row) => text(row.prospect_id)).filter(Boolean))]
  }

  const hintProspectId = text(hints.prospectId)
  if (
    hintProspectId
    && await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, hintProspectId)
  ) {
    return [hintProspectId]
  }

  return []
}

const phoneLinksToProspect = (phoneRow, prospectId) => {
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
  supabase,
  propertyId,
  masterOwnerId,
  candidate,
  hints,
  phoneRow,
  recipientPhone,
) => {
  const preferred = [text(candidate.prospectId), text(hints.prospectId)].filter(Boolean)
  for (const prospectId of preferred) {
    if (await validateProspectBelongsToOwner(supabase, propertyId, masterOwnerId, prospectId)) {
      return prospectId
    }
  }

  const linkedProspects = await loadPropertyOwnerProspects(supabase, propertyId, masterOwnerId, hints)
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
      const row = prospectRow
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
      if ((prospectRow)?.sms_eligible === true) {
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
  supabase,
  propertyId,
  property,
  hints,
) => {
  const candidates = []
  const seen = new Set()

  const hydratedMasterOwnerId = text(hints.masterOwnerId)
  if (hydratedMasterOwnerId) {
    const confirmed = await validateHydratedMapIdentity(supabase, propertyId, property, hints)
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
    const eligible = (graphRows)
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
    for (const row of linkRows) {
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
    for (const row of cacheRows) {
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
    for (const row of graphTargetRows) {
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
  row,
  ownerBestPhone,
) => {
  const normalizedBestPhone = toE164(ownerBestPhone)
  if (!normalizedBestPhone || !row?.phone_id) return false
  return toE164(row.canonical_e164) === normalizedBestPhone
}

const resolvePhoneRow = async (
  supabase,
  masterOwnerId,
  recipientPhone,
  primaryPhoneId,
  hintPhoneId,
  prospectId,
  ownerBestPhone,
) => {
  const normalizedProspectId = text(prospectId)
  const normalizedOwnerBestPhone = toE164(ownerBestPhone || recipientPhone)
  const acceptPhone = (row) => {
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
      const row = data
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
      const row = data
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
      const accepted = acceptPhone(data)
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
      for (const row of phoneRows) {
        if (phoneLinksToProspect(row, normalizedProspectId)) return row
      }
    }
  }

  return null
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
}) => {
  const agentName = resolveAgentName(owner, hints)
  const agentFirstName = firstAgentToken(agentName)
  if (!agentName || !agentFirstName) {
    return { ok: false, error: 'assigned_agent_missing' }
  }

  const ownerDisplayName = text(owner.display_name) || text(hints.ownerDisplayName)
  const propertyAddress = text(property.property_address_full) || text(property.property_address)

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
      ownerLanguage: text(owner.best_language) || 'English',
      propertyAddress,
      sellerDisplayName: prospectFullName,
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

/**
 * Fast path for map cards that already hydrated identity from
 * v_command_map_seller_pin_feed / seller work items. Avoids RLS-blocked
 * prospects/phones reads when the card already carries trustworthy hints.
 */
const tryResolveFromHydratedMapHints = async (
  supabase,
  propertyId,
  property,
  hints,
) => {
  const masterOwnerId = text(hints.masterOwnerId)
  const prospectId = text(hints.prospectId)
  const prospectFirstName = text(hints.prospectFirstName)
  if (!masterOwnerId || !prospectId || !prospectFirstName) return null
  if (hints.smsEligible === false) {
    return { ok: false, error: 'prospect_not_sms_eligible' }
  }

  const propertyOwnerId = text(property.master_owner_id)
  if (propertyOwnerId && propertyOwnerId !== masterOwnerId) return null

  if (!propertyOwnerId) {
    const confirmed = await validateHydratedMapIdentity(supabase, propertyId, property, hints)
    if (!confirmed) return null
  }

  const { data: ownerRow, error: ownerError } = await supabase
    .from('master_owners')
    .select(MAP_OWNERSHIP_MASTER_OWNER_SELECT)
    .eq('master_owner_id', masterOwnerId)
    .limit(1)
    .maybeSingle()

  if (ownerError || !ownerRow) return null

  const owner = ownerRow
  const recipientPhone = toE164(hints.recipientPhone) || toE164(owner.best_phone_1)
  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  let phoneId = text(hints.phoneId) || text(owner.primary_phone_id)
  if (!phoneId) {
    const phoneRow = await resolvePhoneRow(
      supabase,
      masterOwnerId,
      recipientPhone,
      text(owner.primary_phone_id),
      hints.phoneId,
      prospectId,
      recipientPhone,
    )
    phoneId = text(phoneRow?.phone_id)
  }

  if (!phoneId) return null

  const prospectFullName = text(hints.prospectFullName) || prospectFirstName
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
  propertyId,
  deps = {},
) => {
  const normalizedPropertyId = text(propertyId)
  if (!normalizedPropertyId) {
    return { ok: false, error: 'property_id is required' }
  }

  const supabase = deps.supabase
  if (!supabase) {
    return { ok: false, error: 'supabase_client_required' }
  }
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

  const property = propertyRow

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

  const owner = ownerRow
  const recipientPhone = toE164(owner.best_phone_1)
  if (!recipientPhone) {
    return { ok: false, error: 'master_owner_missing_best_phone' }
  }

  const initialPhoneRow = await resolvePhoneRow(
    supabase,
    masterOwnerId,
    recipientPhone,
    text(owner.primary_phone_id),
    candidate.phoneId || hints.phoneId,
    null,
    recipientPhone,
  )

  const prospectId = await resolveProspectForPropertyOwner(
    supabase,
    normalizedPropertyId,
    masterOwnerId,
    candidate,
    hints,
    initialPhoneRow,
    recipientPhone,
  )

  if (!prospectId) {
    return { ok: false, error: 'phone_not_linked_to_human_prospect' }
  }

  const phoneRow = await resolvePhoneRow(
    supabase,
    masterOwnerId,
    recipientPhone,
    text(owner.primary_phone_id),
    candidate.phoneId || hints.phoneId,
    prospectId,
    recipientPhone,
  ) || initialPhoneRow

  const phoneLinkedToProspect = Boolean(phoneRow?.phone_id && phoneLinksToProspect(phoneRow, prospectId))
  const phoneIsOwnerBestContact = phoneMatchesOwnerBestContact(phoneRow, recipientPhone)
  if (!phoneRow?.phone_id || (!phoneLinkedToProspect && !phoneIsOwnerBestContact)) {
    return { ok: false, error: 'phone_not_linked_to_human_prospect' }
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
    return { ok: false, error: 'phone_not_linked_to_human_prospect' }
  }

  const prospect = prospectRow
  const prospectFirstName = text(prospect.first_name) || text(hints.prospectFirstName)
  if (!prospectFirstName) {
    return { ok: false, error: 'phone_not_linked_to_human_prospect' }
  }

  const prospectMasterOwnerId = text(prospect.master_owner_id)
  if (prospectMasterOwnerId && prospectMasterOwnerId !== masterOwnerId) {
    return { ok: false, error: 'property_owner_link_missing' }
  }

  if (prospect.sms_eligible !== true) {
    return { ok: false, error: 'prospect_not_sms_eligible' }
  }

  const prospectFullName = text(prospect.full_name) || text(hints.prospectFullName) || prospectFirstName
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
    phoneId: text(phoneRow.phone_id),
    resolutionSource: candidate.source,
    candidateCount: candidates.length,
  })
}
