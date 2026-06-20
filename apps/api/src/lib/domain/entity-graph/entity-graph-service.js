import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  canonicalMarketKey,
  clean,
  formatContactMethodPresentation,
  formatPropertySummary,
  formatReadablePhone,
  int,
  lower,
  normalizeAddressSearch,
  normalizeEmail,
  normalizePhoneE164,
  normalizeSearchQuery,
  parseJsonArray,
  phoneTail,
  relationshipLabel,
  resolveEntityGraphMarket,
} from './entity-graph-normalize.js'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const GRAPH_NODE_CAP = 48

const PROPERTY_SUMMARY_SELECT = [
  'property_id', 'master_owner_id', 'property_address_full', 'property_address_city',
  'property_address_state', 'property_address_zip', 'property_zip', 'market', 'market_region',
  'latitude', 'longitude', 'property_type', 'property_class', 'normalized_asset_class',
  'estimated_value', 'equity_percent', 'equity_amount', 'total_loan_balance',
  'final_acquisition_score', 'structured_motivation_score', 'property_flags_text',
  'total_bedrooms', 'total_baths', 'building_square_feet', 'units_count',
].join(',')

const OWNER_SUMMARY_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess', 'priority_score', 'priority_tier',
  'urgency_score', 'financial_pressure_score', 'contactability_score',
  'portfolio_total_value', 'portfolio_total_equity', 'property_count', 'portfolio_total_units',
  'tax_delinquent_count', 'active_lien_count', 'best_phone_1', 'best_phone_2', 'best_phone_3',
  'best_email_1', 'best_email_2', 'primary_phone_id', 'primary_email_id',
  'best_prospect_id', 'best_canonical_prospect_id',
  'joined_property_ids_json', 'joined_prospect_ids_json', 'joined_phone_ids_json',
  'joined_email_ids_json', 'joined_sub_owner_ids_json',
].join(',')

const PROSPECT_SUMMARY_SELECT = [
  'prospect_id', 'canonical_prospect_id', 'master_owner_id', 'full_name', 'first_name',
  'occupation_group', 'est_household_income', 'net_asset_value', 'buying_power',
  'contact_score_final', 'phone_score_final', 'email_score_final', 'best_phone', 'best_email',
  'language_preference', 'gender', 'marital_status', 'education_model', 'likely_owner',
  'likely_renting', 'person_flags_text', 'linked_property_ids_json', 'phones_json', 'emails_json',
  'rank_position', 'source_slot',
].join(',')

const PHONE_SUMMARY_SELECT = [
  'phone_id', 'canonical_e164', 'phone', 'phone_type', 'master_owner_id',
  'primary_prospect_id', 'canonical_prospect_id', 'linked_prospect_ids_json',
  'activity_status', 'contact_score_final', 'sort_rank', 'wrong_number_at',
  'owner_display_name', 'usage_12_months', 'usage_2_months', 'contact_window', 'timezone',
].join(',')

const EMAIL_SUMMARY_SELECT = [
  'email_id', 'email_normalized', 'email', 'master_owner_id',
  'primary_prospect_id', 'canonical_prospect_id', 'linked_prospect_ids_json',
  'contact_score_final', 'sort_rank', 'owner_display_name',
].join(',')

const SUB_OWNER_SELECT = [
  'sub_owner_id', 'master_owner_id', 'owner_name', 'owner_entity_id', 'owner_address_full',
  'owner_address_city', 'owner_address_state', 'owner_address_zip',
].join(',')

function buildSearchResult({
  entityType,
  entityId,
  title,
  subtitle,
  badges = [],
  score = 0,
  linkedCounts = {},
  contextIds = {},
  details = undefined,
}) {
  return {
    entityType,
    entityId,
    title,
    subtitle,
    badges,
    score,
    linkedCounts,
    contextIds,
    ...(details ? { details } : {}),
  }
}

function dedupeResults(results) {
  const seen = new Set()
  return results.filter((row) => {
    const key = `${row.entityType}:${row.entityId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sortResults(results, query) {
  const q = lower(query)
  return [...results].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.title.localeCompare(right.title)
  }).filter((row) => !q || row.title.toLowerCase().includes(q) || (row.subtitle || '').toLowerCase().includes(q) || row.entityId.toLowerCase().includes(q))
}

async function searchProperties(supabase, query, limit) {
  const results = []
  const q = normalizeSearchQuery(query)
  const addressQ = normalizeAddressSearch(query)
  const e164 = normalizePhoneE164(query)

  if (/^prop[_-]/i.test(q) || /^[a-f0-9-]{20,}$/i.test(q)) {
    const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).eq('property_id', q).limit(1)
    for (const row of data || []) {
      results.push(buildSearchResult({
        entityType: 'property',
        entityId: row.property_id,
        title: row.property_address_full || row.property_id,
        subtitle: [row.property_address_city, row.property_address_state, row.property_address_zip].filter(Boolean).join(', '),
        badges: [row.market, row.property_type].filter(Boolean),
        score: 1000,
        linkedCounts: { prospects: 1, contacts: 2 },
        contextIds: { propertyId: row.property_id, masterOwnerId: row.master_owner_id || undefined },
      }))
    }
  }

  if (results.length < limit && q) {
    const like = `%${q}%`
    const { data } = await supabase
      .from('properties')
      .select(PROPERTY_SUMMARY_SELECT)
      .or(`property_address_full.ilike.${like},property_id.ilike.${like},property_export_id.ilike.${like}`)
      .limit(limit)
    for (const row of data || []) {
      const exact = lower(row.property_id) === lower(q)
      results.push(buildSearchResult({
        entityType: 'property',
        entityId: row.property_id,
        title: row.property_address_full || row.property_id,
        subtitle: [row.market, row.property_address_zip].filter(Boolean).join(' · '),
        badges: [row.normalized_asset_class || row.property_type].filter(Boolean),
        score: exact ? 950 : 500,
        contextIds: { propertyId: row.property_id, masterOwnerId: row.master_owner_id || undefined },
      }))
    }
  }

  if (results.length < limit && addressQ.length > 4) {
    const like = `%${addressQ}%`
    const { data } = await supabase
      .from('properties')
      .select(PROPERTY_SUMMARY_SELECT)
      .ilike('property_address_full', like)
      .limit(limit)
    for (const row of data || []) {
      results.push(buildSearchResult({
        entityType: 'property',
        entityId: row.property_id,
        title: row.property_address_full || row.property_id,
        subtitle: row.market || undefined,
        badges: ['Address match'],
        score: 700,
        contextIds: { propertyId: row.property_id, masterOwnerId: row.master_owner_id || undefined },
      }))
    }
  }

  return results
}

async function searchOwners(supabase, query, limit) {
  const results = []
  const q = normalizeSearchQuery(query)
  if (!q) return results

  if (/^mo[_-]/i.test(q) || /^owner[_-]/i.test(q)) {
    const { data } = await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', q).limit(1)
    for (const row of data || []) {
      results.push(buildSearchResult({
        entityType: 'master_owner',
        entityId: row.master_owner_id,
        title: row.display_name || row.master_owner_id,
        subtitle: `${row.property_count || 0} properties`,
        badges: [row.owner_type_guess, row.priority_tier].filter(Boolean),
        score: 1000,
        linkedCounts: {
          properties: row.property_count || parseJsonArray(row.joined_property_ids_json).length,
          prospects: parseJsonArray(row.joined_prospect_ids_json).length,
          contacts: parseJsonArray(row.joined_phone_ids_json).length + parseJsonArray(row.joined_email_ids_json).length,
        },
        contextIds: { masterOwnerId: row.master_owner_id, prospectId: row.best_prospect_id || undefined },
      }))
    }
  }

  const like = `%${q}%`
  const { data } = await supabase
    .from('master_owners')
    .select(OWNER_SUMMARY_SELECT)
    .or(`display_name.ilike.${like},master_owner_id.ilike.${like}`)
    .limit(limit)
  for (const row of data || []) {
    results.push(buildSearchResult({
      entityType: 'master_owner',
      entityId: row.master_owner_id,
      title: row.display_name || row.master_owner_id,
      subtitle: `${row.property_count || 0} properties · ${row.portfolio_total_value ? `$${Math.round(row.portfolio_total_value).toLocaleString()}` : 'Portfolio'}`,
      badges: [row.owner_type_guess].filter(Boolean),
      score: lower(row.master_owner_id) === lower(q) ? 950 : 450,
      linkedCounts: {
        properties: row.property_count || 0,
        prospects: parseJsonArray(row.joined_prospect_ids_json).length,
      },
      contextIds: { masterOwnerId: row.master_owner_id, prospectId: row.best_prospect_id || undefined },
    }))
  }
  return results
}

async function searchProspects(supabase, query, limit) {
  const results = []
  const q = normalizeSearchQuery(query)
  if (!q) return results

  const like = `%${q}%`
  const { data } = await supabase
    .from('prospects')
    .select(PROSPECT_SUMMARY_SELECT)
    .or(`full_name.ilike.${like},prospect_id.ilike.${like},canonical_prospect_id.ilike.${like},first_name.ilike.${like}`)
    .limit(limit)
  for (const row of data || []) {
    results.push(buildSearchResult({
      entityType: 'prospect',
      entityId: row.prospect_id,
      title: row.full_name || row.first_name || row.prospect_id,
      subtitle: row.occupation_group || undefined,
      badges: [row.likely_owner ? 'Likely Owner' : null, row.language_preference].filter(Boolean),
      score: lower(row.prospect_id) === lower(q) ? 950 : 420,
      linkedCounts: {
        properties: parseJsonArray(row.linked_property_ids_json).length,
        contacts: parseJsonArray(row.phones_json).length + parseJsonArray(row.emails_json).length,
      },
      contextIds: {
        prospectId: row.prospect_id,
        masterOwnerId: row.master_owner_id || undefined,
        propertyId: parseJsonArray(row.linked_property_ids_json)[0] || undefined,
      },
    }))
  }
  return results
}

async function searchPhones(supabase, query, limit) {
  const results = []
  const e164 = normalizePhoneE164(query)
  const digits = clean(query).replace(/\D/g, '')
  if (!e164 && digits.length < 7) return results

  if (e164) {
    const { data } = await supabase.from('phones').select(PHONE_SUMMARY_SELECT).eq('canonical_e164', e164).limit(3)
    for (const row of data || []) {
      results.push(buildSearchResult({
        entityType: 'phone',
        entityId: row.phone_id,
        title: row.canonical_e164 || row.phone,
        subtitle: row.owner_display_name || undefined,
        badges: [row.phone_type, row.wrong_number_at ? 'Wrong Number' : 'Eligible'].filter(Boolean),
        score: 1000,
        contextIds: {
          contactMethodId: row.phone_id,
          masterOwnerId: row.master_owner_id || undefined,
          prospectId: row.primary_prospect_id || row.canonical_prospect_id || undefined,
        },
      }))
    }
  }

  const like = `%${digits.slice(-10)}%`
  const { data: fuzzy } = await supabase
    .from('phones')
    .select(PHONE_SUMMARY_SELECT)
    .or(`phone.ilike.${like},canonical_e164.ilike.%${e164 || digits}%`)
    .limit(limit)
  for (const row of fuzzy || []) {
    results.push(buildSearchResult({
      entityType: 'phone',
      entityId: row.phone_id,
      title: row.canonical_e164 || row.phone,
      subtitle: row.owner_display_name || undefined,
      badges: [row.phone_type].filter(Boolean),
      score: 600,
      contextIds: {
        contactMethodId: row.phone_id,
        masterOwnerId: row.master_owner_id || undefined,
        prospectId: row.primary_prospect_id || undefined,
      },
    }))
  }
  return results
}

async function searchEmails(supabase, query, limit) {
  const results = []
  const email = normalizeEmail(query)
  if (!email || !email.includes('@')) return results

  const { data } = await supabase
    .from('emails')
    .select(EMAIL_SUMMARY_SELECT)
    .or(`email_normalized.eq.${email},email.ilike.${email}`)
    .limit(limit)
  for (const row of data || []) {
    results.push(buildSearchResult({
      entityType: 'email',
      entityId: row.email_id,
      title: row.email_normalized || row.email,
      subtitle: row.owner_display_name || undefined,
      badges: ['Email'],
      score: lower(row.email_normalized) === email ? 1000 : 650,
      contextIds: {
        contactMethodId: row.email_id,
        masterOwnerId: row.master_owner_id || undefined,
        prospectId: row.primary_prospect_id || undefined,
      },
    }))
  }
  return results
}

async function searchMarketsAndZips(supabase, query, limit) {
  const results = []
  const q = normalizeSearchQuery(query)
  if (!q) return results

  if (/^\d{5}$/.test(q)) {
    const { data, count } = await supabase
      .from('properties')
      .select('property_id, market, property_address_zip', { count: 'exact', head: false })
      .eq('property_address_zip', q)
      .limit(1)
    results.push(buildSearchResult({
      entityType: 'zip',
      entityId: q,
      title: `ZIP ${q}`,
      subtitle: data?.[0]?.market || undefined,
      badges: ['ZIP'],
      score: 900,
      linkedCounts: { properties: count || 0 },
      contextIds: {},
    }))
  }

  const like = `%${q}%`
  const { data: markets } = await supabase
    .from('properties')
    .select('market')
    .ilike('market', like)
    .not('market', 'is', null)
    .limit(20)
  const uniqueMarkets = [...new Set((markets || []).map((row) => clean(row.market)).filter(Boolean))]
  for (const market of uniqueMarkets.slice(0, limit)) {
    const { count } = await supabase
      .from('properties')
      .select('property_id', { count: 'exact', head: true })
      .eq('market', market)
    results.push(buildSearchResult({
      entityType: 'market',
      entityId: market,
      title: market,
      subtitle: 'Market intelligence',
      badges: ['Market'],
      score: lower(market) === lower(q) ? 850 : 400,
      linkedCounts: { properties: count || 0 },
      contextIds: {},
    }))
  }
  return results
}

async function searchOrganizations(supabase, query, limit) {
  const results = []
  const q = normalizeSearchQuery(query)
  if (!q) return results
  const like = `%${q}%`

  const { data: owners } = await supabase
    .from('master_owners')
    .select('master_owner_id, display_name, owner_type_guess')
    .or('owner_type_guess.ilike.%trust%,owner_type_guess.ilike.%llc%,owner_type_guess.ilike.%corp%,owner_type_guess.ilike.%estate%')
    .ilike('display_name', like)
    .limit(limit)
  for (const row of owners || []) {
    results.push(buildSearchResult({
      entityType: 'organization',
      entityId: row.master_owner_id,
      title: row.display_name || row.master_owner_id,
      subtitle: row.owner_type_guess || 'Organization',
      badges: ['Organization'],
      score: 380,
      contextIds: { masterOwnerId: row.master_owner_id },
    }))
  }

  const { data: subs } = await supabase
    .from('sub_owners')
    .select(SUB_OWNER_SELECT)
    .or(`owner_name.ilike.${like},sub_owner_id.ilike.${like},owner_entity_id.ilike.${like}`)
    .limit(limit)
  for (const row of subs || []) {
    results.push(buildSearchResult({
      entityType: 'organization',
      entityId: row.sub_owner_id,
      title: row.owner_name || row.sub_owner_id,
      subtitle: row.owner_address_full || 'Sub-owner entity',
      badges: ['Sub-owner'],
      score: 360,
      contextIds: {
        masterOwnerId: row.master_owner_id || undefined,
      },
    }))
  }
  return results
}

const TAB_ENTITY_TYPES = {
  properties: ['property'],
  master_owners: ['master_owner'],
  people: ['prospect'],
  organizations: ['organization'],
  contact_methods: ['phone', 'email'],
  markets: ['market'],
  zips: ['zip'],
}

function propertyToResult(row, score = 100) {
  const summary = formatPropertySummary(row)
  return buildSearchResult({
    entityType: 'property',
    entityId: row.property_id,
    title: summary.title,
    subtitle: summary.subtitle || undefined,
    badges: [summary.marketLabel, summary.assetType].filter(Boolean),
    score: summary.acquisitionScore ?? score,
    linkedCounts: {
      prospects: 1,
      contacts: 2,
      reachableContacts: 2,
      avgAcquisitionScore: summary.acquisitionScore,
    },
    details: {
      city: summary.city,
      state: summary.state,
      zip: summary.zip,
      marketLabel: summary.marketLabel,
      marketKey: summary.marketKey,
      isUnmappedMarket: summary.isUnmappedMarket,
      assetType: summary.assetType,
      units: summary.units,
      value: summary.value,
      equity: summary.equity,
      acquisitionScore: summary.acquisitionScore,
      flagCount: summary.flagCount,
      flags: summary.flags,
    },
    contextIds: { propertyId: row.property_id, masterOwnerId: row.master_owner_id || undefined },
  })
}

function ownerToResult(row, score = 100) {
  const phoneCount = parseJsonArray(row.joined_phone_ids_json).length
  const emailCount = parseJsonArray(row.joined_email_ids_json).length
  const propertyCount = row.property_count || parseJsonArray(row.joined_property_ids_json).length
  const contactCount = phoneCount + emailCount
  const coverage = propertyCount > 0 ? Math.round((contactCount / propertyCount) * 100) : undefined
  return buildSearchResult({
    entityType: 'master_owner',
    entityId: row.master_owner_id,
    title: row.display_name || row.master_owner_id,
    subtitle: `${propertyCount} properties · ${row.portfolio_total_value ? `$${Math.round(row.portfolio_total_value).toLocaleString()}` : 'Portfolio'}`,
    badges: [row.owner_type_guess, row.priority_tier].filter(Boolean),
    score: row.priority_score ?? score,
    linkedCounts: {
      properties: propertyCount,
      prospects: parseJsonArray(row.joined_prospect_ids_json).length,
      contacts: contactCount,
      reachableContacts: contactCount,
      contactCoverage: coverage,
    },
    details: {
      ownerType: row.owner_type_guess || undefined,
      priorityTier: row.priority_tier || undefined,
      portfolioValue: row.portfolio_total_value ?? undefined,
      portfolioEquity: row.portfolio_total_equity ?? undefined,
      marketLabel: undefined,
    },
    contextIds: { masterOwnerId: row.master_owner_id, prospectId: row.best_prospect_id || undefined },
  })
}

function normalizeOccupationLabel(row) {
  const group = clean(row.occupation_group)
  const code = clean(row.occupation_code)
  if (group && !['0', '1', 'unknown', 'n/a'].includes(lower(group))) return group
  if (code && !['0', '1'].includes(String(code))) return `Occupation ${code}`
  return null
}

function classifyOwnershipEntity(row) {
  const name = lower(`${row.owner_name || ''} ${row.owner_entity_id || ''}`)
  if (name.includes('llc') || name.includes('corp') || name.includes('inc') || name.includes('l.l.c')) return 'LLC/Corporation'
  if (name.includes('trust')) return 'Trust'
  if (name.includes('estate')) return 'Estate'
  if (name.includes('individual') || /^[a-z]+ [a-z]+$/i.test(clean(row.owner_name))) return 'Individual'
  return 'Other/Unknown'
}

function prospectToResult(row, score = 100) {
  const occupation = normalizeOccupationLabel(row)
  const location = [row.primary_market, row.owner_display_name].filter(Boolean).join(' · ')
  const shortId = String(row.prospect_id || '').slice(-6)
  return buildSearchResult({
    entityType: 'prospect',
    entityId: row.prospect_id,
    title: row.full_name || row.first_name || row.prospect_id,
    subtitle: occupation || location || `ID …${shortId}`,
    badges: [row.likely_owner ? 'Likely Owner' : null, row.language_preference, occupation ? null : `…${shortId}`].filter(Boolean),
    score,
    linkedCounts: {
      properties: parseJsonArray(row.linked_property_ids_json).length,
      contacts: parseJsonArray(row.phones_json).length + parseJsonArray(row.emails_json).length,
    },
    contextIds: {
      prospectId: row.prospect_id,
      masterOwnerId: row.master_owner_id || undefined,
      propertyId: parseJsonArray(row.linked_property_ids_json)[0] || undefined,
    },
  })
}

function phoneToResult(row, score = 100) {
  const presentation = formatContactMethodPresentation(row, 'phone')
  return buildSearchResult({
    entityType: 'phone',
    entityId: row.phone_id,
    title: presentation.displayValue || row.canonical_e164 || row.phone,
    subtitle: row.owner_display_name || undefined,
    badges: [presentation.phoneType, presentation.eligibility].filter(Boolean),
    score,
    linkedCounts: {
      reachableContacts: presentation.reachable ? 1 : 0,
    },
    details: {
      contactType: presentation.contactType,
      phoneType: presentation.phoneType || undefined,
      eligibility: presentation.eligibility,
      reachability: presentation.reachability,
      wrongNumber: presentation.wrongNumber,
      suppressed: presentation.suppressed,
      optedOut: presentation.optedOut,
      rawValue: row.canonical_e164 || row.phone,
    },
    contextIds: {
      contactMethodId: row.phone_id,
      masterOwnerId: row.master_owner_id || undefined,
      prospectId: row.primary_prospect_id || row.canonical_prospect_id || undefined,
    },
  })
}

function emailToResult(row, score = 100) {
  const presentation = formatContactMethodPresentation(row, 'email')
  return buildSearchResult({
    entityType: 'email',
    entityId: row.email_id,
    title: presentation.displayValue || row.email_normalized || row.email,
    subtitle: row.owner_display_name || undefined,
    badges: [presentation.eligibility].filter(Boolean),
    score,
    linkedCounts: {
      reachableContacts: presentation.reachable ? 1 : 0,
    },
    details: {
      contactType: presentation.contactType,
      eligibility: presentation.eligibility,
      reachability: presentation.reachability,
      wrongNumber: false,
      suppressed: presentation.suppressed,
      optedOut: presentation.optedOut,
      rawValue: row.email_normalized || row.email,
    },
    contextIds: {
      contactMethodId: row.email_id,
      masterOwnerId: row.master_owner_id || undefined,
      prospectId: row.primary_prospect_id || undefined,
    },
  })
}

function paginatedResponse(results, total, cursor, pageSize) {
  const nextCursor = cursor + pageSize < total ? cursor + pageSize : null
  return {
    results,
    pagination: {
      cursor,
      pageSize,
      total,
      hasMore: nextCursor !== null,
      nextCursor,
      previousCursor: cursor > 0 ? Math.max(cursor - pageSize, 0) : null,
    },
  }
}

const BROWSE_SORT_COLUMNS = {
  properties: { default: 'property_address_full', columns: ['property_address_full', 'market', 'final_acquisition_score', 'estimated_value'] },
  master_owners: { default: 'display_name', columns: ['display_name', 'property_count', 'priority_score', 'portfolio_total_value'] },
  people: { default: 'full_name', columns: ['full_name', 'contact_score_final', 'rank_position'] },
  organizations: { default: 'owner_name', columns: ['owner_name', 'owner_entity_id'] },
  contact_methods: { default: 'sort_rank', columns: ['sort_rank', 'contact_score_final'] },
  markets: { default: 'market_key', columns: ['market_key', 'property_count'] },
  zips: { default: 'zip', columns: ['zip', 'property_count'] },
}

function parseBrowseFilters(params = {}) {
  return {
    market: clean(params.market || params.eg_market),
    city: clean(params.city || params.eg_city),
    state: clean(params.state || params.eg_state),
    zip: clean(params.zip || params.eg_zip),
    assetType: clean(params.asset_type || params.assetType || params.eg_asset_type),
    ownerType: clean(params.owner_type || params.ownerType || params.eg_owner_type),
    priorityTier: clean(params.priority_tier || params.priorityTier || params.eg_priority_tier),
    contactStatus: clean(params.contact_status || params.contactStatus || params.eg_contact_status),
    reachable: ['1', 'true', 'yes'].includes(lower(params.reachable || params.eg_reachable)),
    unitsMin: int(params.units_min ?? params.unitsMin, null, 100000),
    unitsMax: int(params.units_max ?? params.unitsMax, null, 100000),
    scoreMin: Number(params.score_min ?? params.scoreMin ?? params.eg_score_min) || null,
    scoreMax: Number(params.score_max ?? params.scoreMax ?? params.eg_score_max) || null,
    coverageMin: Number(params.coverage_min ?? params.coverageMin ?? params.eg_coverage_min) || null,
    language: clean(params.language || params.eg_language),
    entityType: clean(params.entity_type || params.entityType || params.eg_entity_type),
  }
}

function applyPropertyFilters(query, filters) {
  if (filters.market) {
    const like = `%${filters.market}%`
    query = query.or(`market.ilike.${like},market_region.ilike.${like}`)
  }
  if (filters.city) query = query.ilike('property_address_city', `%${filters.city}%`)
  if (filters.state) query = query.ilike('property_address_state', `%${filters.state}%`)
  if (filters.zip) query = query.or(`property_address_zip.eq.${filters.zip},property_zip.eq.${filters.zip}`)
  if (filters.assetType) {
    query = query.or(`normalized_asset_class.ilike.%${filters.assetType}%,property_type.ilike.%${filters.assetType}%`)
  }
  if (filters.unitsMin !== null) query = query.gte('units_count', filters.unitsMin)
  if (filters.unitsMax !== null) query = query.lte('units_count', filters.unitsMax)
  if (filters.scoreMin !== null) query = query.gte('final_acquisition_score', filters.scoreMin)
  if (filters.scoreMax !== null) query = query.lte('final_acquisition_score', filters.scoreMax)
  return query
}

function applyOwnerFilters(query, filters) {
  if (filters.ownerType) query = query.ilike('owner_type_guess', `%${filters.ownerType}%`)
  if (filters.priorityTier) query = query.ilike('priority_tier', `%${filters.priorityTier}%`)
  if (filters.market) query = query.ilike('primary_market', `%${filters.market}%`)
  if (filters.coverageMin !== null) query = query.gte('contactability_score', filters.coverageMin)
  return query
}

function applyProspectFilters(query, filters) {
  if (filters.language) query = query.ilike('language_preference', `%${filters.language}%`)
  if (filters.reachable) query = query.gt('contact_score_final', 0)
  return query
}

function applyPhoneFilters(query, filters) {
  if (filters.contactStatus === 'wrong') query = query.not('wrong_number_at', 'is', null)
  if (filters.contactStatus === 'eligible') query = query.is('wrong_number_at', null)
  if (filters.reachable) query = query.gt('contact_score_final', 0)
  return query
}

function sumMetric(existing, row, key) {
  const current = existing[key]
  const incoming = row[key]
  if (incoming === null || incoming === undefined) return current
  if (current === null || current === undefined) return incoming
  return Number(current) + Number(incoming)
}

function mergeCanonicalMarkets(rows) {
  const merged = new Map()
  for (const row of rows) {
    const rawKey = String(row.market_key || row.canonical_market || '')
    const resolved = resolveEntityGraphMarket({
      market: row.sample_locality || rawKey,
      marketRegion: row.canonical_market || row.market_region || rawKey,
      state: row.state,
    })
    const canonical = resolved.canonicalKey || rawKey
    const existing = merged.get(canonical) || {
      market_key: canonical,
      canonical_market: resolved.displayMarket,
      is_unmapped: resolved.isUnmapped,
      property_count: 0,
      owner_count: 0,
      people_count: 0,
      reachable_phones: 0,
      reachable_emails: 0,
      reachable_contacts: 0,
      high_equity_count: 0,
      distressed_count: 0,
      avg_acquisition_score: null,
      contact_coverage_pct: null,
      sample_locality: row.sample_locality || rawKey,
      state: resolved.state || row.state || null,
      _score_weight: 0,
    }
    existing.property_count = sumMetric(existing, row, 'property_count') ?? 0
    existing.owner_count = sumMetric(existing, row, 'owner_count') ?? 0
    existing.people_count = sumMetric(existing, row, 'people_count') ?? 0
    existing.reachable_phones = sumMetric(existing, row, 'reachable_phones') ?? 0
    existing.reachable_emails = sumMetric(existing, row, 'reachable_emails') ?? 0
    existing.reachable_contacts = sumMetric(existing, row, 'reachable_contacts')
      ?? (Number(existing.reachable_phones) + Number(existing.reachable_emails))
    existing.high_equity_count = sumMetric(existing, row, 'high_equity_count') ?? 0
    existing.distressed_count = sumMetric(existing, row, 'distressed_count') ?? 0
    if (row.avg_acquisition_score !== null && row.avg_acquisition_score !== undefined) {
      const weight = Number(row.property_count) || 0
      existing._score_weight += weight
      const prior = Number(existing.avg_acquisition_score) || 0
      const priorWeight = Math.max(existing.property_count - weight, 0)
      existing.avg_acquisition_score = existing._score_weight > 0
        ? ((prior * priorWeight) + (Number(row.avg_acquisition_score) * weight)) / existing._score_weight
        : row.avg_acquisition_score
    }
    if (existing.owner_count > 0) {
      existing.contact_coverage_pct = Math.round((existing.reachable_contacts / existing.owner_count) * 1000) / 10
    }
    merged.set(canonical, existing)
  }
  return [...merged.values()]
    .map(({ _score_weight, ...row }) => row)
    .sort((a, b) => b.property_count - a.property_count)
}

async function browseProperties(supabase, { cursor, pageSize, sortBy, ascending, filters = {} }) {
  const orderCol = BROWSE_SORT_COLUMNS.properties.columns.includes(sortBy) ? sortBy : 'property_address_full'
  let query = supabase
    .from('properties')
    .select(PROPERTY_SUMMARY_SELECT, { count: 'exact' })
  query = applyPropertyFilters(query, filters)
  const { data, error, count } = await query
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) throw error
  return paginatedResponse((data || []).map((row) => propertyToResult(row)), count || 0, cursor, pageSize)
}

async function browseOwners(supabase, { cursor, pageSize, sortBy, ascending, filters = {} }) {
  const orderCol = BROWSE_SORT_COLUMNS.master_owners.columns.includes(sortBy) ? sortBy : 'display_name'
  let query = supabase
    .from('master_owners')
    .select(OWNER_SUMMARY_SELECT, { count: 'exact' })
  query = applyOwnerFilters(query, filters)
  const { data, error, count } = await query
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) throw error
  return paginatedResponse((data || []).map((row) => ownerToResult(row)), count || 0, cursor, pageSize)
}

async function browseProspects(supabase, { cursor, pageSize, sortBy, ascending, filters = {} }) {
  const orderCol = BROWSE_SORT_COLUMNS.people.columns.includes(sortBy) ? sortBy : 'full_name'
  let query = supabase
    .from('prospects')
    .select(PROSPECT_SUMMARY_SELECT, { count: 'exact' })
  query = applyProspectFilters(query, filters)
  const { data, error, count } = await query
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) throw error
  return paginatedResponse((data || []).map((row) => prospectToResult(row)), count || 0, cursor, pageSize)
}

async function browseOrganizations(supabase, { cursor, pageSize, sortBy, ascending }) {
  const orderCol = BROWSE_SORT_COLUMNS.organizations.columns.includes(sortBy) ? sortBy : 'owner_name'
  const { data, error, count } = await supabase
    .from('sub_owners')
    .select(SUB_OWNER_SELECT, { count: 'exact' })
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) throw error
  const results = (data || []).map((row) => buildSearchResult({
    entityType: 'organization',
    entityId: row.sub_owner_id,
    title: row.owner_name || row.sub_owner_id,
    subtitle: classifyOwnershipEntity(row),
    badges: [classifyOwnershipEntity(row)].filter(Boolean),
    score: 100,
    linkedCounts: { properties: 1, prospects: 0, contacts: 0 },
    details: {
      mailingAddress: row.owner_address_full
        || [row.owner_address_city, row.owner_address_state, row.owner_address_zip].filter(Boolean).join(', ')
        || undefined,
    },
    contextIds: { masterOwnerId: row.master_owner_id || undefined },
  }))
  return paginatedResponse(results, count || 0, cursor, pageSize)
}

async function browseContactMethods(supabase, { cursor, pageSize, sortBy, ascending, subtype, filters = {} }) {
  const contactSubtype = lower(subtype || 'phone')
  if (contactSubtype === 'email') {
    const orderCol = sortBy === 'contact_score_final' ? 'contact_score_final' : 'sort_rank'
    const { data, error, count } = await supabase
      .from('emails')
      .select(EMAIL_SUMMARY_SELECT, { count: 'exact' })
      .order(orderCol, { ascending, nullsFirst: false })
      .range(cursor, cursor + pageSize - 1)
    if (error) throw error
    return paginatedResponse((data || []).map((row) => emailToResult(row)), count || 0, cursor, pageSize)
  }
  const orderCol = sortBy === 'contact_score_final' ? 'contact_score_final' : 'sort_rank'
  let query = supabase
    .from('phones')
    .select(PHONE_SUMMARY_SELECT, { count: 'exact' })
  query = applyPhoneFilters(query, filters)
  const { data, error, count } = await query
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) throw error
  return paginatedResponse((data || []).map((row) => phoneToResult(row)), count || 0, cursor, pageSize)
}

async function fetchMarketAggregateRows(supabase) {
  const { data: rpcRows, error: rpcError } = await supabase.rpc('entity_graph_browse_markets', {
    p_offset: 0,
    p_limit: 10000,
    p_ascending: false,
  })
  if (!rpcError && Array.isArray(rpcRows) && rpcRows.length > 0) return rpcRows

  const { data, error } = await supabase
    .from('v_entity_graph_market_aggregates')
    .select('market_key, canonical_market, sample_locality, state, property_count, owner_count, avg_acquisition_score, high_equity_count, distressed_count')
    .order('property_count', { ascending: false })
    .limit(10000)
  if (!error && data?.length) return data

  const fallback = await supabase
    .from('v_entity_graph_markets')
    .select('market_key, canonical_market, sample_locality, state, property_count')
    .order('property_count', { ascending: false })
    .limit(10000)
  return fallback.data || []
}

async function countCanonicalMarkets(supabase) {
  const rows = await fetchMarketAggregateRows(supabase)
  return mergeCanonicalMarkets(rows).length
}

function marketRowToResult(row) {
  const canonical = String(row.canonical_market || row.market_key || '')
  const state = row.state || null
  const coverage = row.contact_coverage_pct ?? (
    row.owner_count > 0 && row.reachable_contacts !== undefined
      ? Math.round((Number(row.reachable_contacts) / Number(row.owner_count)) * 1000) / 10
      : undefined
  )
  return buildSearchResult({
    entityType: 'market',
    entityId: canonical,
    title: canonical,
    subtitle: state || undefined,
    badges: [row.is_unmapped ? 'Unmapped Locality' : 'Canonical Market'].filter(Boolean),
    score: row.avg_acquisition_score ?? undefined,
    linkedCounts: {
      properties: Number(row.property_count) || 0,
      masterOwners: row.owner_count ?? undefined,
      prospects: row.people_count ?? undefined,
      reachableContacts: row.reachable_contacts ?? undefined,
      contacts: row.reachable_contacts ?? undefined,
      contactCoverage: coverage,
      avgAcquisitionScore: row.avg_acquisition_score ?? undefined,
      highEquity: row.high_equity_count ?? undefined,
      distressed: row.distressed_count ?? undefined,
    },
    details: {
      locality: row.sample_locality || undefined,
      state: state || undefined,
      marketLabel: canonical,
      metro: row.is_unmapped ? undefined : canonical,
      isUnmapped: Boolean(row.is_unmapped),
      contactCoverage: coverage,
      highEquityCount: row.high_equity_count ?? undefined,
      distressedCount: row.distressed_count ?? undefined,
    },
    contextIds: {},
  })
}

async function browseMarkets(supabase, { cursor, pageSize, sortBy, ascending, filters = {} }) {
  const rows = await fetchMarketAggregateRows(supabase)
  let mergedRows = mergeCanonicalMarkets(rows)
  if (filters.market) {
    const needle = lower(filters.market)
    mergedRows = mergedRows.filter((row) =>
      lower(row.market_key).includes(needle)
      || lower(row.canonical_market || '').includes(needle),
    )
  }
  if (filters.state) {
    const needle = lower(filters.state)
    mergedRows = mergedRows.filter((row) => lower(row.state || '').includes(needle))
  }

  if (sortBy === 'market_key') {
    mergedRows.sort((a, b) => {
      const left = String(a.canonical_market || a.market_key)
      const right = String(b.canonical_market || b.market_key)
      return ascending ? left.localeCompare(right) : right.localeCompare(left)
    })
  } else {
    mergedRows.sort((a, b) => {
      const left = Number(a.property_count) || 0
      const right = Number(b.property_count) || 0
      return ascending ? left - right : right - left
    })
  }

  const total = mergedRows.length
  const pageRows = mergedRows.slice(cursor, cursor + pageSize)
  return paginatedResponse(pageRows.map(marketRowToResult), total, cursor, pageSize)
}

async function fetchZipDistinctCount(supabase) {
  const { data, error } = await supabase.rpc('entity_graph_zip_distinct_count')
  if (!error && data !== null && data !== undefined) return Number(data) || 0

  const { count, error: viewError } = await supabase
    .from('v_entity_graph_zips')
    .select('zip', { count: 'exact', head: true })
  if (!viewError) return count || 0
  return 0
}

async function browseZips(supabase, { cursor, pageSize, sortBy, ascending }) {
  const { data: rpcRows, error: rpcError } = await supabase.rpc('entity_graph_browse_zips', {
    p_offset: cursor,
    p_limit: pageSize,
    p_ascending: ascending,
  })

  if (!rpcError && Array.isArray(rpcRows)) {
    const total = await fetchZipDistinctCount(supabase)
    const results = rpcRows.map((row) => {
      const marketResolved = row.market
        ? resolveEntityGraphMarket({ market: row.market, marketRegion: row.market })
        : null
      const coverage = row.contact_coverage_pct ?? (
        row.owner_count > 0 && row.reachable_contacts !== undefined
          ? Math.round((Number(row.reachable_contacts) / Number(row.owner_count)) * 1000) / 10
          : undefined
      )
      return buildSearchResult({
        entityType: 'zip',
        entityId: row.zip,
        title: row.zip,
        subtitle: marketResolved?.displayMarket || (row.market ? `Market: ${row.market}` : 'ZIP cluster'),
        badges: ['ZIP'],
        score: row.avg_acquisition_score ?? undefined,
        linkedCounts: {
          properties: Number(row.property_count) || 0,
          masterOwners: row.owner_count ?? undefined,
          prospects: row.people_count ?? undefined,
          reachableContacts: row.reachable_contacts ?? undefined,
          contacts: row.reachable_contacts ?? undefined,
          contactCoverage: coverage,
          avgAcquisitionScore: row.avg_acquisition_score ?? undefined,
        },
        details: {
          marketLabel: marketResolved?.displayMarket || row.market || undefined,
          contactCoverage: coverage,
        },
        contextIds: {},
      })
    })
    return paginatedResponse(results, total, cursor, pageSize)
  }

  const orderCol = sortBy === 'property_count' ? 'property_count' : 'zip'
  const { data, error, count } = await supabase
    .from('v_entity_graph_zips')
    .select('zip, market, property_count', { count: 'exact' })
    .order(orderCol, { ascending, nullsFirst: false })
    .range(cursor, cursor + pageSize - 1)
  if (error) {
    const merged = dedupeResults(sortResults(await searchMarketsAndZips(supabase, '', cursor + pageSize + 50), ''))
      .filter((row) => row.entityType === 'zip')
    const page = merged.slice(cursor, cursor + pageSize)
    return paginatedResponse(page, merged.length, cursor, pageSize)
  }
  const results = (data || []).map((row) => buildSearchResult({
    entityType: 'zip',
    entityId: row.zip,
    title: row.zip,
    subtitle: row.market ? `Market: ${row.market}` : 'ZIP cluster',
    badges: ['ZIP'],
    score: 100,
    linkedCounts: {
      properties: Number(row.property_count) || 0,
      prospects: Number(row.people_count) || 0,
      contacts: Number(row.reachable_contacts) || 0,
    },
    details: {
      marketLabel: row.market || undefined,
    },
    contextIds: {},
  }))
  return paginatedResponse(results, count || 0, cursor, pageSize)
}

export async function browseEntityGraph(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const tab = lower(params.tab || 'properties')
  const pageSize = int(params.page_size || params.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const cursor = int(params.cursor || params.offset, 0)
  const sortBy = clean(params.sort_by || params.sortBy) || BROWSE_SORT_COLUMNS[tab]?.default || 'id'
  const ascending = ['1', 'true', 'yes'].includes(lower(params.ascending))
  const filters = parseBrowseFilters(params)
  const browseArgs = { cursor, pageSize, sortBy, ascending, subtype: params.subtype, filters }

  switch (tab) {
    case 'properties':
      return browseProperties(supabase, browseArgs)
    case 'master_owners':
      return browseOwners(supabase, browseArgs)
    case 'people':
      return browseProspects(supabase, browseArgs)
    case 'organizations':
      return browseOrganizations(supabase, browseArgs)
    case 'contact_methods':
      return browseContactMethods(supabase, browseArgs)
    case 'markets':
      return browseMarkets(supabase, browseArgs)
    case 'zips':
      return browseZips(supabase, { ...browseArgs, filters })
    default:
      return browseProperties(supabase, browseArgs)
  }
}

export async function getEntityGraphCounts(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const [
    properties,
    masterOwners,
    people,
    organizations,
    phones,
    emails,
    markets,
    zips,
  ] = await Promise.all([
    supabase.from('properties').select('property_id', { count: 'exact', head: true }),
    supabase.from('master_owners').select('master_owner_id', { count: 'exact', head: true }),
    supabase.from('prospects').select('prospect_id', { count: 'exact', head: true }),
    supabase.from('sub_owners').select('sub_owner_id', { count: 'exact', head: true }),
    supabase.from('phones').select('phone_id', { count: 'exact', head: true }),
    supabase.from('emails').select('email_id', { count: 'exact', head: true }),
    countCanonicalMarkets(supabase).then((count) => ({ count: count || 0, error: null })),
    supabase.rpc('entity_graph_zip_distinct_count').then(async (result) => {
      if (!result.error && result.data !== null && result.data !== undefined) {
        return { count: Number(result.data) || 0, error: null }
      }
      const viewResult = await supabase.from('v_entity_graph_zips').select('zip', { count: 'exact', head: true })
      if (!viewResult.error) return viewResult
      return { count: 0, error: null }
    }),
  ])

  const firstError = [properties, masterOwners, people, organizations, phones, emails, markets, zips]
    .map((result) => result.error)
    .find(Boolean)
  if (firstError) throw firstError

  return {
    properties: properties.count || 0,
    master_owners: masterOwners.count || 0,
    people: people.count || 0,
    organizations: organizations.count || 0,
    contact_methods: (phones.count || 0) + (emails.count || 0),
    phones: phones.count || 0,
    emails: emails.count || 0,
    markets: markets.count || 0,
    zips: zips.count || 0,
  }
}

export async function searchEntityGraph(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const query = normalizeSearchQuery(params.q || params.query)
  const pageSize = int(params.page_size || params.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const cursor = int(params.cursor || params.offset, 0)
  const tab = lower(params.tab || 'properties')
  const subtype = lower(params.subtype || 'phone')

  if (!query) {
    return browseEntityGraph(params, deps)
  }

  if (tab === 'properties') {
    const q = query
    const like = `%${q}%`
    const addressLike = `%${normalizeAddressSearch(q)}%`
    let dbQuery = supabase
      .from('properties')
      .select(PROPERTY_SUMMARY_SELECT, { count: 'exact' })
      .or([
        `property_id.eq.${q}`,
        `property_export_id.ilike.${like}`,
        `property_address_full.ilike.${like}`,
        `property_address_full.ilike.${addressLike}`,
        `property_address_city.ilike.${like}`,
        `property_address_state.ilike.${like}`,
        `property_address_zip.ilike.${like}`,
      ].join(','))
      .order('final_acquisition_score', { ascending: false, nullsFirst: false })
      .range(cursor, cursor + pageSize - 1)
    const { data, error, count } = await dbQuery
    if (error) throw error
    const results = (data || []).map((row) => propertyToResult(
      row,
      lower(row.property_id) === lower(q) ? 1000 : 500,
    ))
    return paginatedResponse(dedupeResults(sortResults(results, query)), count || results.length, cursor, pageSize)
  }

  if (tab === 'master_owners') {
    const like = `%${query}%`
    const { data, error, count } = await supabase
      .from('master_owners')
      .select(OWNER_SUMMARY_SELECT, { count: 'exact' })
      .or(`display_name.ilike.${like},master_owner_id.ilike.${like}`)
      .order('priority_score', { ascending: false, nullsFirst: false })
      .range(cursor, cursor + pageSize - 1)
    if (error) throw error
    const results = (data || []).map((row) => ownerToResult(row, lower(row.master_owner_id) === lower(query) ? 1000 : 500))
    return paginatedResponse(dedupeResults(sortResults(results, query)), count || results.length, cursor, pageSize)
  }

  if (tab === 'people') {
    const like = `%${query}%`
    const { data, error, count } = await supabase
      .from('prospects')
      .select(PROSPECT_SUMMARY_SELECT, { count: 'exact' })
      .or(`full_name.ilike.${like},prospect_id.ilike.${like},canonical_prospect_id.ilike.${like},first_name.ilike.${like}`)
      .order('contact_score_final', { ascending: false, nullsFirst: false })
      .range(cursor, cursor + pageSize - 1)
    if (error) throw error
    const results = (data || []).map((row) => prospectToResult(row, lower(row.prospect_id) === lower(query) ? 1000 : 500))
    return paginatedResponse(dedupeResults(sortResults(results, query)), count || results.length, cursor, pageSize)
  }

  if (tab === 'organizations') {
    const merged = dedupeResults(sortResults(await searchOrganizations(supabase, query, pageSize + cursor), query))
    const page = merged.slice(cursor, cursor + pageSize)
    return paginatedResponse(page, merged.length, cursor, pageSize)
  }

  if (tab === 'contact_methods') {
    if (subtype === 'email' || query.includes('@')) {
      const merged = dedupeResults(sortResults(await searchEmails(supabase, query, pageSize + cursor), query))
      const page = merged.slice(cursor, cursor + pageSize)
      return paginatedResponse(page, merged.length, cursor, pageSize)
    }
    const merged = dedupeResults(sortResults(await searchPhones(supabase, query, pageSize + cursor), query))
    const page = merged.slice(cursor, cursor + pageSize)
    return paginatedResponse(page, merged.length, cursor, pageSize)
  }

  if (tab === 'markets' || tab === 'zips') {
    const merged = dedupeResults(sortResults(await searchMarketsAndZips(supabase, query, pageSize + cursor), query))
    const filtered = tab === 'markets'
      ? merged.filter((row) => row.entityType === 'market')
      : merged.filter((row) => row.entityType === 'zip')
    const page = filtered.slice(cursor, cursor + pageSize)
    return paginatedResponse(page, filtered.length, cursor, pageSize)
  }

  const perTypeLimit = Math.max(pageSize, 15)
  const buckets = await Promise.all([
    searchPhones(supabase, query, perTypeLimit),
    searchEmails(supabase, query, perTypeLimit),
    searchProperties(supabase, query, perTypeLimit),
    searchOwners(supabase, query, perTypeLimit),
    searchProspects(supabase, query, perTypeLimit),
    searchOrganizations(supabase, query, perTypeLimit),
    searchMarketsAndZips(supabase, query, perTypeLimit),
  ])
  const merged = dedupeResults(sortResults(buckets.flat(), query))
  const page = merged.slice(cursor, cursor + pageSize)
  return paginatedResponse(page, merged.length, cursor, pageSize)
}

async function fetchThreadsForContext(supabase, { propertyId, masterOwnerId, prospectId, phoneId, emailId }) {
  const select = 'thread_key, property_id, master_owner_id, prospect_id, seller_phone, canonical_e164, latest_message_at, latest_message_body, status'
  let query = supabase
    .from('inbox_thread_state')
    .select(select)
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .limit(25)

  if (phoneId) {
    const { data: phone } = await supabase
      .from('phones')
      .select('canonical_e164, phone')
      .eq('phone_id', phoneId)
      .maybeSingle()
    const e164 = clean(phone?.canonical_e164 || phone?.phone)
    if (!e164) return []
    query = query.or(`canonical_e164.eq.${e164},seller_phone.eq.${e164},thread_key.eq.${e164}`)
  } else if (emailId) {
    const { data: email } = await supabase
      .from('emails')
      .select('master_owner_id, primary_prospect_id, canonical_prospect_id')
      .eq('email_id', emailId)
      .maybeSingle()
    if (email?.primary_prospect_id || email?.canonical_prospect_id) {
      query = query.eq('prospect_id', email.primary_prospect_id || email.canonical_prospect_id)
    } else if (email?.master_owner_id) {
      query = query.eq('master_owner_id', email.master_owner_id)
    } else {
      return []
    }
  } else if (propertyId) {
    query = query.eq('property_id', propertyId)
  } else if (prospectId) {
    query = query.eq('prospect_id', prospectId)
  } else if (masterOwnerId) {
    query = query.eq('master_owner_id', masterOwnerId)
  } else {
    return []
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

async function fetchContactLadder(supabase, { masterOwnerId, propertyId, prospectId }) {
  const phones = []
  const emails = []

  let phoneQuery = supabase.from('phones').select(PHONE_SUMMARY_SELECT).order('sort_rank', { ascending: true }).limit(20)
  let emailQuery = supabase.from('emails').select(EMAIL_SUMMARY_SELECT).order('sort_rank', { ascending: true }).limit(20)

  if (prospectId) {
    phoneQuery = phoneQuery.or(`primary_prospect_id.eq.${prospectId},canonical_prospect_id.eq.${prospectId}`)
    emailQuery = emailQuery.or(`primary_prospect_id.eq.${prospectId},canonical_prospect_id.eq.${prospectId}`)
  } else if (masterOwnerId) {
    phoneQuery = phoneQuery.eq('master_owner_id', masterOwnerId)
    emailQuery = emailQuery.eq('master_owner_id', masterOwnerId)
  }

  const [{ data: phoneRows }, { data: emailRows }] = await Promise.all([phoneQuery, emailQuery])

  for (const row of phoneRows || []) {
    phones.push({
      id: row.phone_id,
      type: 'phone',
      value: row.canonical_e164 || row.phone,
      rank: row.sort_rank,
      score: row.contact_score_final,
      phoneType: row.phone_type,
      eligible: !row.wrong_number_at,
      wrongNumber: Boolean(row.wrong_number_at),
      suppressed: false,
      optedOut: false,
      lastContacted: null,
      lastResponse: null,
      prospectId: row.primary_prospect_id || row.canonical_prospect_id || null,
      relationship: null,
      tail: phoneTail(row.canonical_e164 || row.phone),
    })
  }

  for (const row of emailRows || []) {
    emails.push({
      id: row.email_id,
      type: 'email',
      value: row.email_normalized || row.email,
      rank: row.sort_rank,
      score: row.contact_score_final,
      eligible: true,
      wrongNumber: false,
      suppressed: false,
      optedOut: false,
      prospectId: row.primary_prospect_id || row.canonical_prospect_id || null,
    })
  }

  return { phones, emails }
}

function propertyGraphLabel(property) {
  const summary = formatPropertySummary(property)
  return summary.title === 'Address incomplete' ? summary.subtitle || property.property_id : summary.title
}

function buildGraphNodesEdges(anchor, neighborhood) {
  const nodes = []
  const edges = []
  const edgeKeys = new Set()
  const pushNode = (id, type, label, meta = {}) => {
    if (nodes.some((node) => node.id === id)) return
    nodes.push({ id, type, label, meta })
  }
  const pushEdge = (from, to, label) => {
    if (!from || !to || !label || from === to) return
    const key = `${from}|${to}|${label}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ from, to, label })
  }

  pushNode(anchor.id, anchor.type, anchor.label, { active: true, ...anchor.meta })

  const ownerNodeId = neighborhood.owner
    ? `master_owner:${neighborhood.owner.master_owner_id}`
    : null
  if (ownerNodeId && anchor.type !== 'master_owner') {
    pushNode(ownerNodeId, 'master_owner', neighborhood.owner.display_name || neighborhood.owner.master_owner_id)
  }

  for (const property of neighborhood.properties.slice(0, GRAPH_NODE_CAP)) {
    const id = `property:${property.property_id}`
    pushNode(id, 'property', propertyGraphLabel(property))
    if (anchor.type === 'master_owner') pushEdge(anchor.id, id, 'Owns')
    else if (anchor.type === 'property') pushEdge(anchor.id, id, 'Portfolio')
    else if (ownerNodeId) pushEdge(ownerNodeId, id, 'Owns')
    else pushEdge(anchor.id, id, 'Linked To')

    const market = resolveEntityGraphMarket({
      market: property.market,
      marketRegion: property.market_region,
      city: property.property_address_city,
      state: property.property_address_state,
    })
    if (market.canonicalKey) {
      const marketId = `market:${market.canonicalKey}`
      pushNode(marketId, 'market', market.displayMarket)
      pushEdge(id, marketId, 'Located In')
    }
    const zip = clean(property.property_address_zip || property.property_zip)
    if (zip) {
      const zipId = `zip:${zip}`
      pushNode(zipId, 'zip', zip)
      pushEdge(id, zipId, 'Located In')
    }
  }

  for (const prospect of neighborhood.prospects.slice(0, 20)) {
    const id = `prospect:${prospect.prospect_id}`
    pushNode(id, 'prospect', prospect.full_name || prospect.prospect_id)
    if (anchor.type === 'master_owner') pushEdge(anchor.id, id, 'Linked Person')
    else if (anchor.type === 'prospect') pushEdge(anchor.id, id, 'Identity')
    else if (ownerNodeId) pushEdge(ownerNodeId, id, 'Linked Person')
    else pushEdge(anchor.id, id, 'Linked Person')
  }

  for (const phone of neighborhood.phones.slice(0, 12)) {
    const id = `phone:${phone.phone_id}`
    const label = formatReadablePhone(phone.canonical_e164 || phone.phone) || phone.phone_id
    pushNode(id, 'phone', label)
    const prospectId = phone.primary_prospect_id || phone.canonical_prospect_id
    if (prospectId) pushEdge(`prospect:${prospectId}`, id, 'Contacted Through')
    else if (ownerNodeId) pushEdge(ownerNodeId, id, 'Contacted Through')
    else pushEdge(anchor.id, id, 'Contacted Through')
  }

  for (const email of neighborhood.emails.slice(0, 12)) {
    const id = `email:${email.email_id}`
    const label = email.email_normalized || email.email || email.email_id
    pushNode(id, 'email', label)
    const prospectId = email.primary_prospect_id || email.canonical_prospect_id
    if (prospectId) pushEdge(`prospect:${prospectId}`, id, 'Contacted Through')
    else if (ownerNodeId) pushEdge(ownerNodeId, id, 'Contacted Through')
    else pushEdge(anchor.id, id, 'Contacted Through')
  }

  for (const thread of neighborhood.threads.slice(0, 12)) {
    const id = `thread:${thread.thread_key}`
    pushNode(id, 'thread', `Thread ${String(thread.thread_key).slice(-6)}`)
    if (thread.prospect_id) pushEdge(id, `prospect:${thread.prospect_id}`, 'Participant')
    if (thread.property_id) pushEdge(id, `property:${thread.property_id}`, 'Regarding')
    else pushEdge(anchor.id, id, 'Regarding')
  }

  return { nodes: nodes.slice(0, GRAPH_NODE_CAP), edges }
}

function buildAggregateAnchorGraph(anchor, counts = {}, sampleChildren = {}) {
  const nodes = []
  const edges = []
  const pushNode = (id, type, label, meta = {}) => {
    if (nodes.some((node) => node.id === id)) return
    nodes.push({ id, type, label, meta })
  }
  const pushEdge = (from, to, label) => {
    edges.push({ from, to, label })
  }

  pushNode(anchor.id, anchor.type, anchor.label, { active: true, ...anchor.meta })

  const groups = [
    { kind: 'properties', type: 'property', label: 'Properties', count: counts.properties },
    { kind: 'master_owners', type: 'master_owner', label: 'Master Owners', count: counts.masterOwners },
    { kind: 'people', type: 'prospect', label: 'People', count: counts.people },
    { kind: 'reachable_contacts', type: 'phone', label: 'Reachable Contacts', count: counts.reachableContacts },
    { kind: 'distressed', type: 'property', label: 'Distressed Properties', count: counts.distressed },
    { kind: 'high_equity', type: 'property', label: 'High-Equity Properties', count: counts.highEquity },
  ]

  for (const group of groups) {
    if (!group.count) continue
    const groupId = `${anchor.type}:group:${group.kind}`
    pushNode(groupId, group.type, `${group.label} (${group.count})`, {
      group: true,
      groupKind: group.kind,
      count: group.count,
      expandable: true,
    })
    pushEdge(anchor.id, groupId, 'Contains')

    if (group.kind === 'properties' && Array.isArray(sampleChildren.properties) && sampleChildren.properties.length > 0) {
      const sample = sampleChildren.properties.slice(0, 8)
      for (const property of sample) {
        const childId = `property:${property.property_id}`
        pushNode(childId, 'property', property.property_address_full || property.property_id, { groupedUnder: groupId })
        pushEdge(groupId, childId, 'Sample')
      }
      if (group.count > sample.length) {
        const moreId = `${groupId}:more`
        pushNode(moreId, 'property', `Show More (${group.count - sample.length})`, { showMore: true, groupKind: group.kind })
        pushEdge(groupId, moreId, 'Expand')
      }
    }
  }

  return { nodes: nodes.slice(0, GRAPH_NODE_CAP), edges }
}

function marketZipPropertyFilter(supabase, entityType, entityId) {
  if (entityType === 'zip') {
    return supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).or(`property_address_zip.eq.${entityId},property_zip.eq.${entityId}`)
  }
  const resolved = resolveEntityGraphMarket({ market: entityId, marketRegion: entityId })
  if (resolved.isUnmapped) {
    const locality = entityId.replace(/^Unmapped ·\s*/, '')
    const [city, state] = locality.split(',').map((part) => clean(part))
    let query = supabase.from('properties').select(PROPERTY_SUMMARY_SELECT)
    if (city) query = query.ilike('property_address_city', city)
    if (state) query = query.ilike('property_address_state', state)
    return query
  }
  return supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).or(`market.eq.${entityId},market_region.eq.${entityId}`)
}

async function countMarketZipMetrics(supabase, entityType, entityId) {
  const isZip = entityType === 'zip'
  const filterField = isZip ? 'property_address_zip' : 'market'
  const base = () => {
    if (isZip) {
      return supabase.from('properties').select('property_id', { count: 'exact', head: true })
        .or(`property_address_zip.eq.${entityId},property_zip.eq.${entityId}`)
    }
    return supabase.from('properties').select('property_id', { count: 'exact', head: true })
      .or(`market.eq.${entityId},market_region.eq.${entityId}`)
  }
  const [total, highEquity, distressed, owners, avgScore] = await Promise.all([
    base(),
    base().gte('equity_percent', 50),
    base().or('tax_delinquent.eq.true,active_lien.eq.true'),
    base().not('master_owner_id', 'is', null),
    supabase.from('properties').select('final_acquisition_score').or(
      isZip
        ? `property_address_zip.eq.${entityId},property_zip.eq.${entityId}`
        : `market.eq.${entityId},market_region.eq.${entityId}`,
    ).limit(5000),
  ])
  const scores = (avgScore.data || []).map((row) => Number(row.final_acquisition_score)).filter((v) => Number.isFinite(v))
  const avgAcquisitionScore = scores.length
    ? Math.round((scores.reduce((sum, v) => sum + v, 0) / scores.length) * 100) / 100
    : null
  return {
    properties: total.count || 0,
    highEquity: highEquity.count || 0,
    distressed: distressed.count || 0,
    masterOwners: owners.count || 0,
    people: 0,
    reachableContacts: 0,
    avgAcquisitionScore,
    filterField,
  }
}

async function loadOwnerNeighborhood(supabase, masterOwnerId) {
  const { data: owner } = await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).maybeSingle()
  if (!owner) return null

  const propertyIds = parseJsonArray(owner.joined_property_ids_json)
  let properties = []
  if (propertyIds.length > 0) {
    const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).in('property_id', propertyIds.slice(0, 50))
    properties = data || []
  } else {
    const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).limit(50)
    properties = data || []
  }

  const prospectIds = parseJsonArray(owner.joined_prospect_ids_json)
  let prospects = []
  if (prospectIds.length > 0) {
    const { data } = await supabase.from('prospects').select(PROSPECT_SUMMARY_SELECT).in('prospect_id', prospectIds.slice(0, 30))
    prospects = data || []
  } else {
    const { data } = await supabase.from('prospects').select(PROSPECT_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).limit(30)
    prospects = data || []
  }

  const [{ data: phones }, { data: emails }, threads, contactLadder, { data: subOwners }] = await Promise.all([
    supabase.from('phones').select(PHONE_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).order('sort_rank').limit(20),
    supabase.from('emails').select(EMAIL_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).order('sort_rank').limit(20),
    fetchThreadsForContext(supabase, { masterOwnerId }),
    fetchContactLadder(supabase, { masterOwnerId }),
    supabase.from('sub_owners').select(SUB_OWNER_SELECT).eq('master_owner_id', masterOwnerId).limit(20),
  ])

  const graph = buildGraphNodesEdges(
    { id: `master_owner:${masterOwnerId}`, type: 'master_owner', label: owner.display_name || masterOwnerId },
    { properties, prospects, phones: phones || [], emails: emails || [], threads, owner },
  )

  return {
    entityType: 'master_owner',
    entityId: masterOwnerId,
    summary: owner,
    identity: {
      masterOwner: owner.display_name,
      talkingTo: prospects[0]?.full_name || null,
      talkingToRelationship: relationshipLabel(prospects[0], owner),
      propertyContext: properties[0]?.property_address_full || null,
      contactMethod: phones?.[0]?.canonical_e164 ? `Mobile ending ${phoneTail(phones[0].canonical_e164)}` : emails?.[0]?.email_normalized || null,
    },
    portfolio: {
      propertyCount: owner.property_count || properties.length,
      totalValue: owner.portfolio_total_value,
      totalEquity: owner.portfolio_total_equity,
      units: owner.portfolio_total_units,
    },
    properties,
    prospects,
    subOwners: subOwners || [],
    phones: phones || [],
    emails: emails || [],
    threads,
    contactLadder,
    graph,
    timeline: [],
  }
}

async function loadPropertyNeighborhood(supabase, propertyId) {
  const { data: property } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).eq('property_id', propertyId).maybeSingle()
  if (!property) return null

  const masterOwnerId = property.master_owner_id
  const owner = masterOwnerId
    ? (await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).maybeSingle()).data
    : null

  const { data: prospects } = await supabase
    .from('prospects')
    .select(PROSPECT_SUMMARY_SELECT)
    .or(`linked_property_ids_json.cs.["${propertyId}"],master_owner_id.eq.${masterOwnerId || '___none___'}`)
    .limit(20)

  const activeProspect = prospects?.[0] || null
  const [threads, contactLadder] = await Promise.all([
    fetchThreadsForContext(supabase, { propertyId, masterOwnerId }),
    fetchContactLadder(supabase, { masterOwnerId, propertyId, prospectId: activeProspect?.prospect_id }),
  ])

  const portfolio = owner ? parseJsonArray(owner.joined_property_ids_json) : [propertyId]
  let portfolioProperties = [property]
  if (portfolio.length > 1) {
    const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).in('property_id', portfolio.slice(0, 25))
    portfolioProperties = data || portfolioProperties
  }

  const graph = buildGraphNodesEdges(
    { id: `property:${propertyId}`, type: 'property', label: propertyGraphLabel(property) },
    {
      properties: portfolioProperties,
      prospects: prospects || [],
      phones: contactLadder.phones,
      emails: contactLadder.emails,
      threads,
      owner,
    },
  )

  return {
    entityType: 'property',
    entityId: propertyId,
    summary: property,
    owner,
    prospects: prospects || [],
    portfolio: portfolioProperties,
    threads,
    contactLadder,
    scores: {
      acquisition: property.final_acquisition_score,
      motivation: property.structured_motivation_score,
      equityPercent: property.equity_percent,
    },
    identity: {
      masterOwner: owner?.display_name || null,
      talkingTo: activeProspect?.full_name || null,
      talkingToRelationship: relationshipLabel(activeProspect, owner),
      propertyContext: property.property_address_full,
      contactMethod: contactLadder.phones[0]?.value ? `Mobile ending ${contactLadder.phones[0].tail}` : contactLadder.emails[0]?.value || null,
    },
    graph,
    timeline: [],
  }
}

async function loadProspectNeighborhood(supabase, prospectId) {
  const { data: prospect } = await supabase.from('prospects').select(PROSPECT_SUMMARY_SELECT).eq('prospect_id', prospectId).maybeSingle()
  if (!prospect) return null

  const propertyIds = parseJsonArray(prospect.linked_property_ids_json)
  let properties = []
  if (propertyIds.length > 0) {
    const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).in('property_id', propertyIds.slice(0, 25))
    properties = data || []
  }

  const owner = prospect.master_owner_id
    ? (await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', prospect.master_owner_id).maybeSingle()).data
    : null

  const [threads, contactLadder] = await Promise.all([
    fetchThreadsForContext(supabase, { prospectId, masterOwnerId: prospect.master_owner_id }),
    fetchContactLadder(supabase, { masterOwnerId: prospect.master_owner_id, prospectId }),
  ])

  const graph = buildGraphNodesEdges(
    { id: `prospect:${prospectId}`, type: 'prospect', label: prospect.full_name || prospectId },
    { properties, prospects: [prospect], phones: contactLadder.phones, emails: contactLadder.emails, threads },
  )

  return {
    entityType: 'prospect',
    entityId: prospectId,
    summary: prospect,
    owner,
    properties,
    threads,
    contactLadder,
    identity: {
      masterOwner: owner?.display_name || null,
      talkingTo: prospect.full_name,
      talkingToRelationship: relationshipLabel(prospect, owner),
      propertyContext: properties.length === 1 ? properties[0].property_address_full : `${properties.length} linked properties`,
      contactMethod: contactLadder.phones[0]?.value ? `Mobile ending ${contactLadder.phones[0].tail}` : contactLadder.emails[0]?.value || null,
    },
    graph,
    timeline: [],
  }
}

async function loadContactNeighborhood(supabase, type, id) {
  const isPhone = type === 'phone'
  const table = isPhone ? 'phones' : 'emails'
  const select = isPhone ? PHONE_SUMMARY_SELECT : EMAIL_SUMMARY_SELECT
  const key = isPhone ? 'phone_id' : 'email_id'
  const { data: contact } = await supabase.from(table).select(select).eq(key, id).maybeSingle()
  if (!contact) return null

  const masterOwnerId = contact.master_owner_id
  const prospectId = contact.primary_prospect_id || contact.canonical_prospect_id
  const owner = masterOwnerId
    ? (await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', masterOwnerId).maybeSingle()).data
    : null
  const prospect = prospectId
    ? (await supabase.from('prospects').select(PROSPECT_SUMMARY_SELECT).eq('prospect_id', prospectId).maybeSingle()).data
    : null

  let properties = []
  if (owner) {
    const ids = parseJsonArray(owner.joined_property_ids_json)
    if (ids.length > 0) {
      const { data } = await supabase.from('properties').select(PROPERTY_SUMMARY_SELECT).in('property_id', ids.slice(0, 15))
      properties = data || []
    }
  }

  const threads = await fetchThreadsForContext(supabase, {
    masterOwnerId,
    prospectId,
    phoneId: isPhone ? id : undefined,
    emailId: !isPhone ? id : undefined,
  })

  const label = isPhone ? (contact.canonical_e164 || contact.phone) : (contact.email_normalized || contact.email)
  const graph = buildGraphNodesEdges(
    { id: `${type}:${id}`, type, label },
    { properties, prospects: prospect ? [prospect] : [], phones: isPhone ? [contact] : [], emails: !isPhone ? [contact] : [], threads },
  )

  return {
    entityType: type,
    entityId: id,
    summary: contact,
    owner,
    prospect,
    properties,
    threads,
    eligibility: {
      eligible: isPhone ? !contact.wrong_number_at : true,
      wrongNumber: isPhone ? Boolean(contact.wrong_number_at) : false,
      suppressed: false,
      optedOut: false,
    },
    identity: {
      masterOwner: owner?.display_name || null,
      talkingTo: prospect?.full_name || null,
      talkingToRelationship: relationshipLabel(prospect, owner),
      propertyContext: properties[0]?.property_address_full || null,
      contactMethod: isPhone ? `Mobile ending ${phoneTail(label)}` : label,
    },
    graph,
    timeline: [],
  }
}

export async function getEntityGraphDossier(type, id, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const entityType = lower(type)
  const entityId = clean(id)
  if (!entityId) return null

  switch (entityType) {
    case 'property':
      return loadPropertyNeighborhood(supabase, entityId)
    case 'owner':
    case 'master_owner':
      return loadOwnerNeighborhood(supabase, entityId)
    case 'prospect':
      return loadProspectNeighborhood(supabase, entityId)
    case 'phone':
    case 'email':
    case 'contact':
      return loadContactNeighborhood(supabase, entityType === 'contact' ? 'phone' : entityType, entityId)
    case 'organization': {
      const ownerDossier = await loadOwnerNeighborhood(supabase, entityId)
      if (ownerDossier) return { ...ownerDossier, entityType: 'organization' }
      const { data: sub } = await supabase.from('sub_owners').select(SUB_OWNER_SELECT).eq('sub_owner_id', entityId).maybeSingle()
      if (!sub) return null
      return {
        entityType: 'organization',
        entityId,
        summary: sub,
        owner: sub.master_owner_id ? (await supabase.from('master_owners').select(OWNER_SUMMARY_SELECT).eq('master_owner_id', sub.master_owner_id).maybeSingle()).data : null,
        graph: { nodes: [{ id: `organization:${entityId}`, type: 'organization', label: sub.owner_name || sub.sub_owner_id, meta: { active: true } }], edges: [] },
        timeline: [],
      }
    }
    case 'market': {
      const [sampleRes, metrics] = await Promise.all([
        marketZipPropertyFilter(supabase, 'market', entityId).limit(8),
        countMarketZipMetrics(supabase, 'market', entityId),
      ])
      const sample = sampleRes.data || []
      return {
        entityType: 'market',
        entityId,
        summary: { market: entityId, propertyCount: metrics.properties || 0 },
        properties: sample,
        graph: buildAggregateAnchorGraph(
          { id: `market:${entityId}`, type: 'market', label: entityId },
          metrics,
          { properties: sample },
        ),
        timeline: [],
      }
    }
    case 'zip': {
      const [sampleRes, metrics] = await Promise.all([
        marketZipPropertyFilter(supabase, 'zip', entityId).limit(8),
        countMarketZipMetrics(supabase, 'zip', entityId),
      ])
      const sample = sampleRes.data || []
      return {
        entityType: 'zip',
        entityId,
        summary: { zip: entityId, propertyCount: metrics.properties || 0 },
        properties: sample,
        graph: buildAggregateAnchorGraph(
          { id: `zip:${entityId}`, type: 'zip', label: entityId },
          metrics,
          { properties: sample },
        ),
        timeline: [],
      }
    }
    default:
      return null
  }
}