/**
 * Canonical Deal Intelligence dossier builder.
 * Primary enrichment: inbox_threads_hydrated → properties → entity tables.
 */
import { supabase } from '../supabase/client.js'
import {
  normalizeAssetClass,
  normalizeMarket,
  normalizeState,
  normalizeZip,
} from '../intel/normalize.js'
import {
  loadComparableProperties,
  scoreProperty,
  normalizePropertyFeatures,
  evaluateCompEligibility,
  scoreComparable,
} from '../acquisition/acquisitionDecisionEngine.js'
import { DEAL_DOSSIER_SCHEMA } from './deal-dossier-schema.js'

const ACQUISITION_SCORE_SELECT = [
  'property_id',
  'valuation_low', 'valuation_mid', 'valuation_high', 'valuation_confidence',
  'comp_count', 'weighted_comp_score',
  'investor_ceiling_low', 'investor_ceiling_mid', 'investor_ceiling_high',
  'buyer_demand_score', 'liquidity_score', 'estimated_repairs',
  'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee',
  'subject_to_score', 'seller_finance_score', 'lease_option_score', 'novation_score',
  'best_strategy', 'aos_score', 'confidence', 'decision_tier', 'evidence',
  'seller_financial_pressure_score', 'forced_sale_pressure_score', 'foreclosure_risk_score',
  'transaction_probability_90', 'transaction_probability_180', 'transaction_probability_365',
  'landlord_fatigue_score', 'tax_pain_score', 'equity_unlock_score', 'debt_pressure_score',
  'repair_burden_score', 'offer_aggression_score',
  'owner_situation_primary', 'owner_situation_scores',
  'recommended_conversation_angle', 'recommended_offer_stack', 'computed_at',
].join(',')

const PROPERTY_SELECT = [
  'property_id', 'master_owner_id', 'property_address_full', 'property_address_city',
  'property_address_state', 'property_address_zip', 'property_zip', 'property_address_county_name',
  'property_county_name', 'market', 'market_region', 'latitude', 'longitude',
  'property_type', 'property_class', 'normalized_asset_class', 'normalized_asset_subclass',
  'asset_class', 'asset_type', 'total_bedrooms', 'total_baths', 'building_square_feet',
  'units_count', 'year_built', 'effective_year_built', 'building_condition', 'building_quality',
  'estimated_repair_cost', 'estimated_value', 'equity_amount', 'equity_percent',
  'total_loan_balance', 'property_flags_text', 'property_flags_json', 'streetview_image',
  'satellite_image', 'final_acquisition_score', 'structured_motivation_score',
  'deal_strength_score', 'tag_distress_score', 'ai_score', 'ownership_years',
  'sale_date', 'sale_price', 'saleprice', 'document_type', 'recording_date', 'default_date',
  'total_loan_amt', 'total_loan_payment', 'tax_amt', 'tax_delinquent', 'active_lien',
  'lot_acreage', 'lot_square_feet', 'stories', 'avg_sqft_per_unit', 'beds_per_unit',
  'assd_improvement_value', 'assd_land_value', 'assd_total_value',
  'rehab_level', 'construction_type', 'resale_price',
].join(',')

const OWNER_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess',
  'priority_score', 'priority_tier', 'urgency_score', 'financial_pressure_score',
  'contactability_score', 'best_contact_window', 'portfolio_total_value',
  'portfolio_total_equity', 'portfolio_total_loan_balance', 'property_count',
  'portfolio_total_units', 'tax_delinquent_count', 'active_lien_count',
  'seller_tags_text', 'seller_tags_json', 'primary_owner_address',
  'best_language', 'routing_market', 'routing_timezone',
  'best_phone_1', 'best_phone_2', 'best_phone_3', 'best_email_1', 'best_email_2',
].join(',')

const PROSPECT_SELECT = [
  'prospect_id', 'master_owner_id', 'full_name', 'first_name',
  'occupation_group', 'est_household_income', 'net_asset_value',
  'buying_power', 'person_flags_text', 'person_flags_json', 'matching_flags',
  'contact_score_final', 'phone_score_final', 'best_phone', 'best_email',
  'language_preference', 'gender', 'marital_status', 'education_model',
  'mob', 'likely_owner', 'likely_renting', 'email_score_final',
].join(',')

const PHONE_SELECT = [
  'phone_id', 'canonical_e164', 'phone', 'phone_type',
  'activity_status', 'usage_12_months', 'usage_2_months', 'contact_score_final',
  'contact_window', 'timezone', 'wrong_number_at', 'sort_rank',
].join(',')

function clean(value) {
  return String(value ?? '').trim()
}

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function hasValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  return true
}

function pick(...values) {
  for (const value of values) {
    if (!hasValue(value)) continue
    const text = clean(value)
    if (text && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'n/a') return value
  }
  return null
}

function parseZipFromAddress(address) {
  const text = clean(address)
  if (!text) return null
  const match = text.match(/\b(\d{5})(?:-\d{4})?\b/)
  return match ? match[1] : null
}

export function resolveCanonicalLocation({ propertyRow, hydrated, identity }) {
  const fullAddress = pick(
    propertyRow?.property_address_full,
    hydrated?.property_address_full,
    identity?.full_address,
  )
  const zip = normalizeZip(
    pick(
      propertyRow?.property_address_zip,
      propertyRow?.property_zip,
      hydrated?.property_address_zip,
      hydrated?.zip,
      identity?.zip,
      parseZipFromAddress(fullAddress),
    ),
  )
  const city = pick(propertyRow?.property_address_city, hydrated?.property_address_city, hydrated?.city)
  const state = normalizeState(
    pick(propertyRow?.property_address_state, hydrated?.property_address_state, hydrated?.state),
  )
  const cityStateMarket = city && state ? `${city}, ${state}` : null
  const market = pick(
    propertyRow?.market,
    propertyRow?.market_region,
    identity?.market,
    cityStateMarket,
    hydrated?.market_region,
    hydrated?.market,
  )
  const county = pick(propertyRow?.property_address_county_name, propertyRow?.property_county_name, hydrated?.property_county_name)
  const latitude = num(pick(propertyRow?.latitude, hydrated?.latitude, identity?.latitude))
  const longitude = num(pick(propertyRow?.longitude, hydrated?.longitude, identity?.longitude))

  return {
    full_address: fullAddress,
    zip,
    market,
    state,
    county,
    city,
    latitude,
    longitude,
    resolution: {
      zip_sources: [
        propertyRow?.property_address_zip && 'property_address_zip',
        propertyRow?.property_zip && 'property_zip',
        hydrated?.zip && 'hydrated.zip',
        hydrated?.property_address_zip && 'hydrated.property_address_zip',
        parseZipFromAddress(fullAddress) && 'parsed_address',
      ].filter(Boolean),
      market_source: propertyRow?.market
        ? 'properties.market'
        : identity?.market
          ? 'identity.market'
          : cityStateMarket
            ? 'parsed.city_state'
            : hydrated?.market_region
              ? 'hydrated.market_region'
              : hydrated?.market
                ? 'hydrated.market'
                : null,
    },
  }
}

function parsePropertyFlags(text, json) {
  const flags = []
  if (hasValue(text)) {
    flags.push(
      ...String(text)
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  if (json && typeof json === 'object') {
    if (Array.isArray(json)) flags.push(...json.map((v) => clean(v)).filter(Boolean))
    else if (Array.isArray(json.flags)) flags.push(...json.flags.map((v) => clean(v)).filter(Boolean))
  }
  return [...new Set(flags)]
}

function buyerMarketSignal(score) {
  const n = num(score)
  if (n === null) return 'No Coverage'
  if (n >= 75) return 'Strong'
  if (n >= 60) return 'Active'
  if (n >= 40) return 'Balanced'
  if (n >= 20) return 'Thin'
  return 'No Coverage'
}

function isMultifamilyProperty(property) {
  return /multi|mf|duplex|triplex|fourplex|apt|unit/i.test(
    String(property?.normalized_asset_class || property?.property_type || property?.property_class || ''),
  ) || (num(property?.units) || 0) > 1
}

function parseDelimitedFlags(text) {
  if (!hasValue(text)) return []
  return [...new Set(String(text).split(/[;,|]/).map((s) => s.trim()).filter(Boolean))]
}

function yearsBetweenDates(startDate, endDate = new Date()) {
  const start = new Date(startDate)
  if (Number.isNaN(start.getTime())) return null
  const diff = endDate.getTime() - start.getTime()
  return diff > 0 ? diff / (365.25 * 24 * 60 * 60 * 1000) : null
}

function buildPropertySnapshot(propertyRow, hydrated, property) {
  const lastSalePrice = num(pick(propertyRow?.sale_price, propertyRow?.saleprice, hydrated?.sale_price))
  const lastSaleDate = pick(propertyRow?.sale_date, propertyRow?.recording_date)
  const currentValue = num(property?.value)
  const holdingYears = yearsBetweenDates(lastSaleDate)
  let appreciation = null
  if (lastSalePrice && currentValue && lastSaleDate && holdingYears !== null) {
    appreciation = {
      last_sale_price: lastSalePrice,
      last_sale_date: lastSaleDate,
      current_value: currentValue,
      dollar_change: currentValue - lastSalePrice,
      percent_change: ((currentValue - lastSalePrice) / lastSalePrice) * 100,
      holding_period_years: Math.round(holdingYears * 10) / 10,
    }
  }

  return {
    value: currentValue,
    equity_amount: num(property?.equity_amount),
    equity_percentage: num(property?.equity_percentage),
    total_loan_balance: num(pick(propertyRow?.total_loan_balance, hydrated?.total_loan_balance, hydrated?.total_loan_amt)),
    total_loan_amount: num(pick(propertyRow?.total_loan_amt, hydrated?.total_loan_amt)),
    total_loan_payment: num(propertyRow?.total_loan_payment),
    tax_amount: num(propertyRow?.tax_amt),
    repair_estimate: num(property?.repair_estimate),
    building_condition: property?.condition,
    last_sale_date: lastSaleDate,
    last_sale_price: lastSalePrice,
    last_sale_document_type: pick(propertyRow?.document_type),
    recording_date: pick(propertyRow?.recording_date),
    ownership_years: num(property?.ownership_years),
    active_lien: propertyRow?.active_lien ?? null,
    tax_delinquent: propertyRow?.tax_delinquent ?? null,
    default_date: pick(propertyRow?.default_date),
    appreciation,
  }
}

function buildPropertyDetailGroups(propertyRow, hydrated, property) {
  const row = (key, ...sources) => pick(...sources.map((s) => s?.[key]), propertyRow?.[key], hydrated?.[key])
  const groups = {
    valuation_debt: {
      estimated_value: num(property?.value),
      equity_amount: num(property?.equity_amount),
      equity_percentage: num(property?.equity_percentage),
      total_loan_balance: num(pick(propertyRow?.total_loan_balance, hydrated?.total_loan_balance)),
      total_loan_amount: num(propertyRow?.total_loan_amt),
      loan_payment: num(propertyRow?.total_loan_payment),
      assessed_improvement_value: num(propertyRow?.assd_improvement_value),
      assessed_land_value: num(propertyRow?.assd_land_value),
      assessed_total_value: num(propertyRow?.assd_total_value),
      repair_estimate: num(property?.repair_estimate),
      resale_price: num(propertyRow?.resale_price),
    },
    sale_recording: {
      last_sale_date: pick(propertyRow?.sale_date),
      last_sale_price: num(pick(propertyRow?.sale_price, propertyRow?.saleprice)),
      document_type: pick(propertyRow?.document_type),
      recording_date: pick(propertyRow?.recording_date),
      default_date: pick(propertyRow?.default_date),
    },
    physical: {
      square_feet: num(property?.square_feet),
      units: num(property?.units),
      bedrooms: num(property?.bedrooms),
      bathrooms: num(property?.bathrooms),
      year_built: num(property?.year_built),
      effective_year_built: num(propertyRow?.effective_year_built),
      lot_acreage: num(propertyRow?.lot_acreage),
      lot_square_feet: num(propertyRow?.lot_square_feet),
      stories: num(propertyRow?.stories),
      property_class: pick(propertyRow?.property_class, hydrated?.property_class),
      construction_type: pick(propertyRow?.construction_type),
      building_quality: pick(propertyRow?.building_quality),
      building_condition: property?.condition,
      rehab_level: pick(propertyRow?.rehab_level),
    },
    distress_flags: {
      tax_delinquent: propertyRow?.tax_delinquent ?? null,
      active_lien: propertyRow?.active_lien ?? null,
      property_flags: property?.property_flags || [],
    },
  }

  for (const [groupKey, fields] of Object.entries(groups)) {
    groups[groupKey] = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => {
        if (Array.isArray(value)) return value.length > 0
        return hasValue(value)
      }),
    )
  }

  return groups
}

function buildMultifamilyIntelligence(propertyRow, property, buyerMarket, comps) {
  const units = num(property?.units)
  if (!isMultifamilyProperty(property) || !units || units <= 1) {
    return { status: 'not_applicable' }
  }
  const value = num(property?.value)
  return {
    status: 'available',
    total_units: units,
    price_per_unit: value && units ? Math.round(value / units) : null,
    estimated_value_per_unit: value && units ? Math.round(value / units) : null,
    average_sqft_per_unit: num(pick(propertyRow?.avg_sqft_per_unit, property?.square_feet && units ? property.square_feet / units : null)),
    beds_per_unit: num(propertyRow?.beds_per_unit),
    total_square_feet: num(property?.square_feet),
    property_class: pick(propertyRow?.property_class, property?.property_type),
    buyer_market_ppu: num(buyerMarket?.ppu),
    comp_median_ppu: num(comps?.median_ppu),
    valuation_low: num(comps?.valuation_low),
    valuation_high: num(comps?.valuation_high),
    dominant_buyer_type: buyerMarket?.dominant_buyer_type || null,
  }
}

const COMP_REJECTION_LABELS = {
  invalid_sale_price: 'Invalid sale price',
  same_property: 'Same subject property',
  asset_type_mismatch: 'Asset type mismatch',
  sale_too_old: 'Sale too old',
  outside_radius: 'Outside search radius',
  outside_zip_without_coordinates: 'Outside ZIP without coordinates',
  square_feet_outside_range: 'Square footage outside range',
  unit_count_outside_range: 'Unit count outside range',
  building_size_outside_range: 'Building size outside range',
}

function compRejectionLabel(reason) {
  return COMP_REJECTION_LABELS[reason] || reason.replace(/_/g, ' ')
}

async function queryMaybe(table, select, filters = {}, abortSignal) {
  let query = supabase.from(table).select(select)
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    query = query.eq(key, value)
  }
  if (abortSignal) query = query.abortSignal(abortSignal)
  const { data, error } = await query.maybeSingle()
  if (!error) return data || null
  if (/does not exist|column/i.test(error.message || '')) {
    console.warn(`[DEAL_INTEL_QUERY] ${table} select failed: ${error.message}`)
    return null
  }
  throw error
}

async function queryHydratedThread({ thread_key, property_id }, abortSignal) {
  if (thread_key) {
    let query = supabase.from('inbox_threads_hydrated').select('*').eq('thread_key', thread_key).limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data, error } = await query.maybeSingle()
    if (!error && data) return data
  }
  if (property_id) {
    let query = supabase.from('inbox_threads_hydrated').select('*').eq('property_id', property_id).limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data, error } = await query.maybeSingle()
    if (!error && data) return data
  }
  return null
}

async function resolveIdentity({
  thread_key,
  property_id,
  prospect_id,
  master_owner_id,
  canonical_e164,
  hydrated,
  abortSignal,
}) {
  let resolved = {
    thread_key: clean(thread_key),
    property_id: clean(property_id),
    prospect_id: clean(prospect_id),
    master_owner_id: clean(master_owner_id),
    canonical_e164: clean(canonical_e164),
    market: null,
    zip: null,
    latitude: null,
    longitude: null,
    full_address: null,
  }

  if (hydrated) {
    resolved.property_id = resolved.property_id || clean(hydrated.property_id)
    resolved.prospect_id = resolved.prospect_id || clean(hydrated.prospect_id)
    resolved.master_owner_id = resolved.master_owner_id || clean(hydrated.master_owner_id)
    resolved.canonical_e164 = resolved.canonical_e164 || clean(hydrated.canonical_e164 || hydrated.seller_phone || hydrated.thread_key)
    resolved.thread_key = resolved.thread_key || clean(hydrated.thread_key)
    resolved.full_address = clean(hydrated.property_address_full) || null
  }

  if (resolved.thread_key && (!resolved.property_id || !resolved.canonical_e164)) {
    const threadState = await queryMaybe(
      'inbox_thread_state',
      'property_id, master_owner_id, prospect_id, canonical_e164, seller_phone, market',
      { thread_key: resolved.thread_key },
      abortSignal,
    )
    if (threadState) {
      resolved.property_id = resolved.property_id || clean(threadState.property_id)
      resolved.master_owner_id = resolved.master_owner_id || clean(threadState.master_owner_id)
      resolved.prospect_id = resolved.prospect_id || clean(threadState.prospect_id)
      resolved.canonical_e164 = resolved.canonical_e164 || clean(threadState.canonical_e164 || threadState.seller_phone)
      resolved.market = clean(threadState.market) || resolved.market
    }
  }

  return resolved
}

async function fetchBuyerGeoRollup(subject, abortSignal) {
  const asset = normalizeAssetClass(subject.normalized_asset_class || subject.property_type) || 'all'
  const zip = normalizeZip(subject.zip)
  const county = clean(subject.county)
  const market = normalizeMarket(subject.market, subject.city, subject.state)
  const state = normalizeState(subject.state)

  const attempts = [
    zip ? { geo_level: 'zip', geo_key: zip, asset, label: `ZIP ${zip} + ${asset}` } : null,
    zip ? { geo_level: 'zip', geo_key: zip, asset: 'all', label: `ZIP ${zip} + all` } : null,
    county ? { geo_level: 'county', geo_key: county, asset, label: `County ${county} + ${asset}` } : null,
    market ? { geo_level: 'market', geo_key: market, asset, label: `Market ${market} + ${asset}` } : null,
    market ? { geo_level: 'market', geo_key: market, asset: 'all', label: `Market ${market} + all` } : null,
    state ? { geo_level: 'state', geo_key: state, asset, label: `State ${state} + ${asset}` } : null,
    state ? { geo_level: 'state', geo_key: state, asset: 'all', label: `State ${state} + all` } : null,
  ].filter(Boolean)

  const attempted = []

  for (const attempt of attempts) {
    attempted.push(attempt.label)
    let query = supabase
      .from('buyer_geo_rollups_v2')
      .select('*')
      .eq('geo_level', attempt.geo_level)
      .eq('geo_key', attempt.geo_key)
      .eq('normalized_asset_class', attempt.asset)
      .limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data, error } = await query.maybeSingle()
    if (!error && data) {
      const heat = num(data.buyer_heat_score) ?? num(data.investor_demand_score)
      return {
        status: 'available',
        signal: buyerMarketSignal(heat),
        timeframe: data.timeframe || data.rollup_window || '6mo',
        geographic_level_used: `${attempt.geo_level} · ${attempt.asset}`,
        geographic_key: attempt.geo_key,
        normalized_asset_class: attempt.asset,
        fallback_attempted: attempted,
        purchase_count: num(data.purchase_count),
        buyer_count: num(data.buyer_count),
        corporate_buyer_count: num(data.corporate_buyer_count),
        repeat_buyer_count: num(data.repeat_buyer_count),
        avg_purchase_price: num(data.avg_purchase_price),
        median_purchase_price: num(data.median_purchase_price),
        ppsf: num(data.ppsf) ?? num(data.avg_ppsf),
        ppu: num(data.ppu),
        avg_units: num(data.avg_units),
        liquidity_score: num(data.liquidity_score),
        velocity_score: num(data.velocity_score),
        investor_demand_score: num(data.investor_demand_score),
        buyer_heat_score: num(data.buyer_heat_score),
        dominant_buyer_type: data.dominant_buyer_type || null,
        dominant_strategy: data.dominant_strategy || null,
        top_buyers: Array.isArray(data.top_buyers) ? data.top_buyers : [],
        price_bands: data.price_bands || null,
        data_freshness: data.computed_at || data.updated_at || null,
        source: 'buyer_geo_rollups_v2',
      }
    }
  }

  const lastAttempt = attempted[attempted.length - 1] || null
  return {
    status: 'no_coverage',
    signal: 'No Buyer Coverage',
    message: 'No qualified buyer-market rollup found',
    coverage_hint: lastAttempt,
    geographic_level_used: null,
    source: 'buyer_geo_rollups_v2',
  }
}

async function fetchCompsSection(property, location, propertyRow, abortSignal) {
  if (!property?.property_id) {
    return {
      status: 'missing',
      qualification: { candidates_found: 0, weighted_usable: 0, rejected: 0 },
      records: [],
    }
  }

  const subject = normalizePropertyFeatures(
    {
      ...propertyRow,
      property_id: property.property_id,
      property_address_zip: location.zip || property.zip,
      market: location.market || property.market,
      property_address_state: location.state || property.state,
      property_address_city: location.city || property.city,
      latitude: num(property.latitude ?? location.latitude),
      longitude: num(property.longitude ?? location.longitude),
      units_count: property.units,
      building_square_feet: property.square_feet,
      total_bedrooms: property.bedrooms,
      total_baths: property.bathrooms,
      year_built: property.year_built,
      property_type: property.property_type,
      normalized_asset_class: property.normalized_asset_class,
      estimated_repair_cost: property.repair_estimate,
      estimated_value: property.value,
    },
    { source: 'properties' },
  )

  let rawComps = []
  try {
    rawComps = await loadComparableProperties(subject, { supabase })
  } catch (error) {
    console.warn('[DEAL_INTEL_COMPS]', error?.message)
  }

  const qualification = {
    candidates_found: rawComps.length,
    asset_type_matches: 0,
    location_qualified: 0,
    similarity_qualified: 0,
    weighted_usable: 0,
    rejected: 0,
  }

  const analyzed = rawComps.map((raw) => {
    const eligibility = evaluateCompEligibility(subject, raw)
    const scored = scoreComparable(subject, raw)
    const assetMatch = !eligibility.reasons.includes('asset_type_mismatch')
    const locationOk = !eligibility.reasons.some((r) =>
      ['outside_radius', 'outside_zip_without_coordinates'].includes(r),
    )
    const similarityScore = num(scored?.comp_confidence ?? scored?.weighted_score)
    const usable = scored?.eligible === true && (similarityScore ?? 0) >= 45

    if (assetMatch) qualification.asset_type_matches += 1
    if (locationOk) qualification.location_qualified += 1
    if (scored?.eligible) qualification.similarity_qualified += 1
    if (usable) qualification.weighted_usable += 1
    else qualification.rejected += 1

    const comp = scored?.comp || raw
    return {
      id: clean(comp.id || comp.comp_id || comp.property_id),
      address: comp.property_address_full || comp.address || null,
      property_type: comp.property_type || comp.asset_type || null,
      asset_class: comp.normalized_asset_class || comp.asset_class || null,
      zip: comp.property_address_zip || comp.zip || null,
      distance_miles: num(eligibility.distance_miles ?? comp.distance_miles),
      units: num(comp.units_count ?? comp.units),
      sqft: num(comp.building_square_feet ?? comp.sqft),
      bedrooms: num(comp.total_bedrooms ?? comp.beds),
      bathrooms: num(comp.total_baths ?? comp.baths),
      year_built: num(comp.year_built),
      sale_date: comp.sale_date || comp.mls_sold_date || null,
      sale_price: num(comp.sale_price || comp.mls_sold_price),
      ppsf: num(comp.computed_ppsf || comp.price_per_sqft || (comp.sale_price && comp.building_square_feet ? comp.sale_price / comp.building_square_feet : null)),
      ppu: num(comp.ppu || (comp.sale_price && comp.units_count ? comp.sale_price / comp.units_count : null)),
      similarity_score: similarityScore,
      weight: num(scored?.weight),
      included: usable,
      exclusion_reason: usable
        ? null
        : compRejectionLabel(eligibility.reasons[0] || (scored?.eligible ? 'low_similarity' : 'not_eligible')),
      source: comp.source || 'v_recent_sold_comps',
    }
  })

  const usableRecords = analyzed.filter((r) => r.included)
  const salePrices = usableRecords.map((r) => r.sale_price).filter((v) => v > 0).sort((a, b) => a - b)
  const ppsfValues = usableRecords.map((r) => r.ppsf).filter((v) => v > 0).sort((a, b) => a - b)
  const ppuValues = usableRecords.map((r) => r.ppu).filter((v) => v > 0).sort((a, b) => a - b)
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null)
  const isMultifamily = isMultifamilyProperty(property)
  const usableCount = usableRecords.length
  let confidence = null
  if (usableCount > 0) {
    confidence = Math.round(
      usableRecords.reduce((sum, r) => sum + (num(r.similarity_score) || 0), 0) / usableCount,
    )
    if (usableCount === 1) confidence = Math.min(confidence, 55)
    if (usableCount < 3) confidence = Math.min(confidence, 70)
  }

  return {
    status: usableCount ? 'available' : qualification.candidates_found ? 'insufficient' : 'missing',
    label: usableCount ? null : 'Insufficient qualified comps',
    qualification,
    candidate_count: qualification.candidates_found,
    usable_count: usableCount,
    comp_count: usableCount,
    weighted_comp_count: qualification.weighted_usable,
    median_sale: median(salePrices),
    median_ppsf: isMultifamily ? null : median(ppsfValues),
    median_ppu: isMultifamily ? median(ppuValues) : null,
    valuation_low: salePrices.length ? Math.min(...salePrices) : null,
    valuation_high: salePrices.length ? Math.max(...salePrices) : null,
    valuation_mid: median(salePrices),
    confidence,
    freshness: usableRecords[0]?.sale_date || analyzed[0]?.sale_date || null,
    records: analyzed.sort((a, b) => (num(b.similarity_score) || 0) - (num(a.similarity_score) || 0)),
    source: 'v_recent_sold_comps',
    match_context: {
      zip: location.zip,
      market: location.market,
      asset_class: property.normalized_asset_class || property.property_type,
    },
  }
}

async function fetchBuyerMatches(propertyId, abortSignal) {
  let runQuery = supabase
    .from('buyer_match_runs')
    .select('buyer_match_run_id, total_matches, status, created_at')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (abortSignal) runQuery = runQuery.abortSignal(abortSignal)
  const { data: run } = await runQuery.maybeSingle()

  if (!run || !run.total_matches) {
    return {
      status: 'market_pool_only',
      label: 'Market Buyer Pool',
      matched_buyer_count: 0,
      matched_buyers: [],
    }
  }

  let candidateQuery = supabase
    .from('buyer_match_candidates')
    .select('buyer_name, buyer_type, match_score, match_reason, recent_buys, avg_buy_price, max_buy_price, last_buy_at')
    .eq('buyer_match_run_id', run.buyer_match_run_id)
    .order('match_score', { ascending: false })
    .limit(10)
  if (abortSignal) candidateQuery = candidateQuery.abortSignal(abortSignal)
  const { data: candidates } = await candidateQuery

  return {
    status: 'matched',
    label: 'Matched Buyers',
    matched_buyer_count: run.total_matches || candidates?.length || 0,
    matched_buyers: candidates || [],
    run_status: run.status,
    run_created_at: run.created_at,
  }
}

const ACTIVITY_TONE_BY_TYPE = {
  property_imported: 'info',
  owner_linked: 'info',
  prospect_enriched: 'info',
  outreach_sent: 'info',
  inbound_reply: 'success',
  positive_engagement: 'success',
  negative_engagement: 'danger',
  wrong_number: 'danger',
  delivery_failure: 'danger',
  automation_classified: 'ai',
  stage_change: 'warning',
  status_change: 'warning',
  follow_up_scheduled: 'warning',
  follow_up_sent: 'info',
  offer_calculated: 'ai',
  offer_presented: 'success',
  offer_accepted: 'success',
  offer_rejected: 'danger',
  acquisition_engine_started: 'ai',
  acquisition_engine_completed: 'ai',
  strategy_selected: 'ai',
  buyer_match_generated: 'success',
  contract_generated: 'success',
  contract_sent: 'info',
  contract_signed: 'success',
  closing_event: 'success',
}

function activityTone(type) {
  return ACTIVITY_TONE_BY_TYPE[type] || 'neutral'
}

async function fetchActivityTimeline({ thread_key, canonical_e164, property_id, hydrated, abortSignal }) {
  const events = []
  const pushUnique = (event) => {
    const key = `${event.type}|${event.timestamp}|${event.label}`
    if (!events.some((e) => `${e.type}|${e.timestamp}|${e.label}` === key)) {
      events.push({ ...event, tone: event.tone || activityTone(event.type) })
    }
  }

  if (hydrated?.created_at) {
    pushUnique({
      type: 'property_imported',
      label: 'Property imported',
      timestamp: hydrated.created_at,
      source: 'inbox_threads_hydrated',
    })
  }

  if (hydrated?.master_owner_id && hydrated?.updated_at) {
    pushUnique({
      type: 'owner_linked',
      label: 'Owner linked',
      timestamp: hydrated.updated_at,
      source: 'inbox_threads_hydrated',
    })
  }

  if (hydrated?.prospect_id && hydrated?.updated_at) {
    pushUnique({
      type: 'prospect_enriched',
      label: 'Prospect enriched',
      timestamp: hydrated.updated_at,
      source: 'inbox_threads_hydrated',
    })
  }

  if (property_id) {
    const acquisitionRow = await queryMaybe(
      'property_acquisition_scores',
      'computed_at, best_strategy',
      { property_id: clean(property_id) },
      abortSignal,
    )
    if (acquisitionRow?.computed_at) {
      pushUnique({
        type: 'acquisition_engine_completed',
        label: 'Acquisition engine completed',
        timestamp: acquisitionRow.computed_at,
        source: 'property_acquisition_scores',
        detail: acquisitionRow.best_strategy || null,
      })
      if (acquisitionRow.best_strategy) {
        pushUnique({
          type: 'strategy_selected',
          label: `Strategy · ${String(acquisitionRow.best_strategy).replace(/_/g, ' ')}`,
          timestamp: acquisitionRow.computed_at,
          source: 'property_acquisition_scores',
        })
      }
    }
  }

  if (hydrated?.latest_message_at) {
    pushUnique({
      type: hydrated.latest_message_direction === 'inbound' ? 'inbound_reply' : 'outreach_sent',
      label: hydrated.latest_message_direction === 'inbound' ? 'Inbound seller reply' : 'Initial outreach sent',
      timestamp: hydrated.latest_message_at,
      source: 'inbox_threads_hydrated',
    })
  }

  if (canonical_e164) {
    let msgQuery = supabase
      .from('message_events')
      .select('id, direction, message_body, intent, delivery_status, created_at, event_type')
      .or(`thread_key.eq.${canonical_e164},from_phone_number.eq.${canonical_e164},to_phone_number.eq.${canonical_e164}`)
      .order('created_at', { ascending: false })
      .limit(40)
    if (abortSignal) msgQuery = msgQuery.abortSignal(abortSignal)
    const { data: messages } = await msgQuery
    for (const msg of messages || []) {
      const direction = clean(msg.direction).toLowerCase()
      const intent = clean(msg.intent).toLowerCase()
      const eventType = clean(msg.event_type).toLowerCase()

      if (direction === 'outbound' || direction === 'out') {
        pushUnique({ type: 'outreach_sent', label: 'Outreach sent', timestamp: msg.created_at, source: 'message_events' })
      } else if (direction === 'inbound' || direction === 'in') {
        if (intent.includes('negative') || intent.includes('not interested')) {
          pushUnique({ type: 'negative_engagement', label: 'Negative engagement', timestamp: msg.created_at, source: 'message_events' })
        } else if (intent.includes('positive')) {
          pushUnique({ type: 'positive_engagement', label: 'Positive engagement', timestamp: msg.created_at, source: 'message_events' })
        } else {
          pushUnique({ type: 'inbound_reply', label: 'Inbound seller reply', timestamp: msg.created_at, source: 'message_events' })
        }
      }

      if (intent.includes('wrong') || eventType.includes('wrong_number')) {
        pushUnique({ type: 'wrong_number', label: 'Wrong number', timestamp: msg.created_at, source: 'message_events' })
      }
      if (intent && !['positive', 'negative', 'unknown'].includes(intent)) {
        pushUnique({
          type: 'automation_classified',
          label: `Automation classified · ${intent.replace(/_/g, ' ')}`,
          timestamp: msg.created_at,
          source: 'message_events',
        })
      }
      if (clean(msg.delivery_status).toLowerCase() === 'failed') {
        pushUnique({ type: 'delivery_failure', label: 'Delivery failure', timestamp: msg.created_at, source: 'message_events' })
      }
    }
  }

  if (thread_key) {
    const threadState = await queryMaybe(
      'inbox_thread_state',
      'universal_stage, universal_status, inbox_bucket, updated_at, next_action',
      { thread_key },
      abortSignal,
    )
    if (threadState?.updated_at) {
      if (threadState.universal_stage) {
        pushUnique({
          type: 'stage_change',
          label: `Stage changed · ${threadState.universal_stage}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
      if (threadState.universal_status || threadState.inbox_bucket) {
        pushUnique({
          type: 'status_change',
          label: `Status changed · ${threadState.universal_status || threadState.inbox_bucket}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
      if (threadState.next_action) {
        pushUnique({
          type: 'follow_up_scheduled',
          label: `Follow-up · ${threadState.next_action}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
    }
  }

  return events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 30)
}

function buildBaselineScores(propertyRow, hydrated) {
  return {
    acquisition_score: num(pick(propertyRow?.final_acquisition_score, hydrated?.final_acquisition_score)),
    deal_strength_score: num(pick(propertyRow?.deal_strength_score, hydrated?.deal_strength_score)),
    motivation_score: num(pick(propertyRow?.structured_motivation_score, hydrated?.priority_score, hydrated?.structured_motivation_score)),
    distress_score: num(pick(propertyRow?.tag_distress_score, hydrated?.tag_distress_score)),
    ai_score: num(pick(propertyRow?.ai_score, hydrated?.ai_score)),
    label: 'Baseline Property Intelligence',
  }
}

function normalizeProperty(propertyRow, hydrated, location) {
  if (!propertyRow && !hydrated) return { status: 'missing' }
  const flags = parsePropertyFlags(
    pick(propertyRow?.property_flags_text, hydrated?.property_flags_text),
    pick(propertyRow?.property_flags_json, hydrated?.property_flags_json),
  )

  return {
    status: 'available',
    property_id: clean(pick(propertyRow?.property_id, hydrated?.property_id)),
    full_address: location.full_address,
    street: location.full_address?.split(',')[0]?.trim() || null,
    city: location.city,
    state: location.state,
    zip: location.zip,
    county: location.county,
    market: location.market,
    property_type: pick(propertyRow?.property_type, hydrated?.property_type),
    property_class: pick(propertyRow?.property_class, hydrated?.property_class),
    normalized_asset_class: pick(propertyRow?.normalized_asset_class, propertyRow?.asset_class, hydrated?.property_class),
    units: num(pick(propertyRow?.units_count, hydrated?.units_count)),
    bedrooms: num(pick(propertyRow?.total_bedrooms, hydrated?.total_bedrooms)),
    bathrooms: num(pick(propertyRow?.total_baths, hydrated?.total_baths)),
    square_feet: num(pick(propertyRow?.building_square_feet, hydrated?.building_square_feet)),
    year_built: num(pick(propertyRow?.year_built, hydrated?.year_built)),
    condition: pick(propertyRow?.building_condition, hydrated?.building_condition),
    repair_estimate: num(pick(propertyRow?.estimated_repair_cost, hydrated?.estimated_repair_cost)),
    arv: null,
    value: num(pick(propertyRow?.estimated_value, hydrated?.estimated_value)),
    equity_amount: num(pick(propertyRow?.equity_amount, hydrated?.equity_amount)),
    equity_percentage: num(pick(propertyRow?.equity_percent, hydrated?.equity_percent)),
    loan_balance: num(pick(propertyRow?.total_loan_balance, hydrated?.total_loan_balance, hydrated?.total_loan_amt)),
    ownership_years: num(pick(propertyRow?.ownership_years, hydrated?.ownership_years)),
    property_flags: flags,
    property_flags_overflow: Math.max(0, flags.length - 4),
    street_view_url: pick(propertyRow?.streetview_image, hydrated?.streetview_image),
    satellite_url: pick(propertyRow?.satellite_image, hydrated?.satellite_image),
    latitude: location.latitude,
    longitude: location.longitude,
    acquisition_score: num(pick(propertyRow?.final_acquisition_score, hydrated?.final_acquisition_score)),
    motivation_score: num(pick(propertyRow?.structured_motivation_score, hydrated?.priority_score)),
    deal_strength_score: num(pick(propertyRow?.deal_strength_score, hydrated?.deal_strength_score)),
    distress_score: num(pick(propertyRow?.tag_distress_score, hydrated?.tag_distress_score)),
    ai_score: num(pick(propertyRow?.ai_score, hydrated?.ai_score)),
  }
}

function normalizeProspect(prospectRow, hydrated, phoneRow) {
  const name = pick(prospectRow?.full_name, hydrated?.prospect_full_name, hydrated?.owner_display_name)
  if (!name && !prospectRow && !hydrated) return { status: 'sparse' }

  return {
    status: 'available',
    prospect_id: clean(pick(prospectRow?.prospect_id, hydrated?.prospect_id)),
    name,
    language: pick(hydrated?.best_language, prospectRow?.language_preference),
    age: num(pick(prospectRow?.calculated_age, prospectRow?.age, prospectRow?.prospect_age, hydrated?.prospect_age, hydrated?.calculated_age)),
    occupation: pick(hydrated?.occupation, prospectRow?.occupation_group),
    occupation_group: pick(prospectRow?.occupation_group, hydrated?.occupation_group),
    household_income: pick(prospectRow?.est_household_income, hydrated?.est_household_income),
    net_asset_value: pick(prospectRow?.net_asset_value, hydrated?.net_asset_value),
    buying_power: pick(prospectRow?.buying_power, hydrated?.buying_power),
    gender: pick(prospectRow?.gender, hydrated?.gender),
    marital_status: pick(prospectRow?.marital_status, hydrated?.marital_status),
    education: pick(prospectRow?.education_model, hydrated?.education_model),
    likely_owner: prospectRow?.likely_owner ?? hydrated?.likely_owner ?? null,
    likely_renter: prospectRow?.likely_renter ?? hydrated?.likely_renting ?? null,
    person_flags: parseDelimitedFlags(pick(prospectRow?.person_flags_text, hydrated?.person_flags_text)),
    matching_flags: parseDelimitedFlags(pick(prospectRow?.matching_flags, hydrated?.matching_flags)),
    contact_score: num(pick(prospectRow?.contact_score_final, hydrated?.prospect_contact_score)),
    phone_score: num(pick(prospectRow?.phone_score_final, hydrated?.prospect_phone_score)),
    best_email: pick(prospectRow?.best_email, hydrated?.prospect_best_email),
    contact_window: pick(phoneRow?.contact_window, hydrated?.best_contact_window),
    thread_priority: num(hydrated?.thread_priority),
  }
}

function normalizeOwner(ownerRow, hydrated) {
  const displayName = pick(ownerRow?.display_name, hydrated?.owner_display_name, hydrated?.prospect_full_name)
  if (!displayName && !ownerRow && !hydrated) return { status: 'sparse' }

  return {
    status: 'available',
    master_owner_id: clean(pick(ownerRow?.master_owner_id, hydrated?.master_owner_id)),
    display_name: displayName,
    owner_type: pick(ownerRow?.owner_type_guess, hydrated?.owner_type_guess),
    priority_score: num(pick(ownerRow?.priority_score, hydrated?.owner_priority_score)),
    priority_tier: pick(ownerRow?.priority_tier, hydrated?.owner_priority_tier),
    urgency_score: num(pick(ownerRow?.urgency_score, hydrated?.urgency_score)),
    financial_pressure_score: num(pick(ownerRow?.financial_pressure_score, hydrated?.financial_pressure_score)),
    contactability_score: num(pick(ownerRow?.contactability_score, hydrated?.contactability_score)),
    contact_window: pick(ownerRow?.best_contact_window, hydrated?.best_contact_window),
    preferred_language: pick(ownerRow?.best_language, hydrated?.best_language),
    timezone: pick(ownerRow?.routing_timezone, hydrated?.routing_timezone),
    best_phone_1: pick(ownerRow?.best_phone_1, hydrated?.prospect_best_phone),
    best_phone_2: pick(ownerRow?.best_phone_2),
    best_phone_3: pick(ownerRow?.best_phone_3),
    best_email_1: pick(ownerRow?.best_email_1, hydrated?.prospect_best_email),
    best_email_2: pick(ownerRow?.best_email_2),
    portfolio_value: num(pick(ownerRow?.portfolio_total_value, hydrated?.portfolio_total_value)),
    portfolio_equity: num(pick(ownerRow?.portfolio_total_equity, hydrated?.portfolio_total_equity)),
    portfolio_loan_balance: num(pick(ownerRow?.portfolio_total_loan_balance, hydrated?.portfolio_total_loan_balance)),
    property_count: num(pick(ownerRow?.property_count, hydrated?.property_count)),
    total_units: num(pick(ownerRow?.portfolio_total_units, hydrated?.portfolio_total_units)),
    tax_delinquent_count: num(pick(ownerRow?.tax_delinquent_count, hydrated?.tax_delinquent_count)),
    active_lien_count: num(pick(ownerRow?.active_lien_count, hydrated?.active_lien_count)),
    ownership_years: num(hydrated?.ownership_years),
    seller_tags: parseDelimitedFlags(pick(ownerRow?.seller_tags_text, hydrated?.seller_tags_text)),
    absentee_owner: /absentee/i.test(String(pick(ownerRow?.owner_type_guess, hydrated?.owner_type_guess) || '')),
    out_of_state_owner: hydrated?.out_of_state_owner ?? null,
    corporate_owner: hydrated?.is_corporate_owner ?? null,
  }
}

function normalizePhone(phoneRow, hydrated, canonicalE164) {
  if (phoneRow) {
    return {
      status: 'available',
      number: pick(phoneRow.canonical_e164, phoneRow.phone, canonicalE164),
      type: phoneRow.phone_type || null,
      carrier: null,
      activity_status: phoneRow.activity_status || null,
      usage: phoneRow.usage_12_months || phoneRow.usage_2_months || null,
      contact_score: num(phoneRow.contact_score_final),
      contact_window: pick(phoneRow.contact_window, hydrated?.best_contact_window),
      timezone: phoneRow.timezone || null,
      wrong_number: Boolean(phoneRow.wrong_number_at),
    }
  }
  if (canonicalE164) {
    return {
      status: 'available',
      number: canonicalE164,
      contact_window: hydrated?.best_contact_window || null,
    }
  }
  return { status: 'missing' }
}

function normalizeAcquisitionDecision(row) {
  if (!row) {
    return { status: 'not_run', label: 'Full Decision Engine Not Run', can_run: true }
  }
  return {
    status: 'available',
    ...row,
    acquisition_score: num(row.aos_score),
    heat_score: num(row.aos_score),
    recommended_cash_offer: num(row.recommended_cash_offer),
    minimum_acceptable_offer: num(row.minimum_acceptable_offer),
    expected_assignment_fee: num(row.expected_assignment_fee),
    best_strategy: row.best_strategy || null,
    decision_tier: row.decision_tier || null,
    valuation_range: {
      low: num(row.valuation_low),
      mid: num(row.valuation_mid),
      high: num(row.valuation_high),
      confidence: num(row.valuation_confidence),
    },
    buyer_demand_score: num(row.buyer_demand_score),
    liquidity_score: num(row.liquidity_score),
    computed_at: row.computed_at,
  }
}

function buildDecisionSnapshot({ property, baseline, acquisition, buyerMarket, comps, hydrated }) {
  const risks = []
  const flags = property?.property_flags || []
  if (flags.some((f) => /tax delinquent/i.test(f))) risks.push({ label: 'Tax delinquent', score: 85 })
  if (flags.some((f) => /tired landlord/i.test(f))) risks.push({ label: 'Tired landlord', score: 75 })
  if (flags.some((f) => /heavily dated/i.test(f))) risks.push({ label: 'Heavily dated', score: 70 })
  if (num(acquisition?.foreclosure_risk_score) >= 60) risks.push({ label: 'Foreclosure risk', score: acquisition.foreclosure_risk_score })
  if (num(acquisition?.repair_burden_score) >= 60) risks.push({ label: 'Repair burden', score: acquisition.repair_burden_score })
  if (num(property?.repair_estimate) > 0 && num(property?.value) > 0 && property.repair_estimate / property.value > 0.25) {
    risks.push({ label: 'Heavy repair load', score: Math.round((property.repair_estimate / property.value) * 100) })
  }
  risks.sort((a, b) => (b.score || 0) - (a.score || 0))

  const engineAvailable = acquisition?.status === 'available'
  let recommendedNextAction = acquisition?.recommended_conversation_angle || hydrated?.ai_next_action || hydrated?.next_action || null
  if (!recommendedNextAction && !engineAvailable) recommendedNextAction = 'Run Full Decision Engine for offer stack'
  else if (!recommendedNextAction) recommendedNextAction = 'Review valuation and offer stack'

  return {
    baseline_acquisition_score: baseline.acquisition_score,
    engine_aos_score: engineAvailable ? acquisition.acquisition_score : null,
    acquisition_score: engineAvailable ? acquisition.acquisition_score : baseline.acquisition_score,
    deal_strength_score: baseline.deal_strength_score,
    motivation_score: baseline.motivation_score,
    distress_score: baseline.distress_score,
    ai_score: baseline.ai_score,
    heat_score: engineAvailable ? acquisition.heat_score : baseline.acquisition_score,
    recommended_cash_offer: engineAvailable ? acquisition.recommended_cash_offer : null,
    minimum_acceptable_offer: engineAvailable ? acquisition.minimum_acceptable_offer : null,
    engine_status: acquisition?.status || 'missing',
    engine_available: engineAvailable,
    valuation_range: engineAvailable
      ? acquisition.valuation_range
      : {
          low: comps?.valuation_low ?? null,
          mid: comps?.valuation_mid ?? property?.value ?? null,
          high: comps?.valuation_high ?? null,
          confidence: comps?.confidence ?? null,
        },
    equity_amount: property?.equity_amount ?? null,
    equity_percentage: property?.equity_percentage ?? null,
    repair_estimate: property?.repair_estimate ?? null,
    value: property?.value ?? null,
    condition: property?.condition ?? null,
    best_strategy: engineAvailable ? acquisition.best_strategy : null,
    decision_tier: engineAvailable ? acquisition.decision_tier : null,
    confidence: engineAvailable ? acquisition.confidence : null,
    expected_assignment_fee: engineAvailable ? acquisition.expected_assignment_fee : null,
    buyer_demand_score: engineAvailable ? acquisition.buyer_demand_score : buyerMarket?.investor_demand_score ?? buyerMarket?.buyer_heat_score,
    liquidity_score: engineAvailable ? acquisition.liquidity_score : buyerMarket?.liquidity_score,
    buyer_market_signal: buyerMarket?.signal || null,
    largest_risk: risks[0] || null,
    recommended_next_action: recommendedNextAction,
    engine_computed_at: acquisition?.computed_at || null,
  }
}

export async function buildDealIntelligenceDossier({
  thread_key,
  property_id,
  prospect_id,
  master_owner_id,
  canonical_e164,
  debug = false,
  abortSignal,
}) {
  const hydrated = await queryHydratedThread({ thread_key, property_id }, abortSignal)

  const identity = await resolveIdentity({
    thread_key,
    property_id,
    prospect_id,
    master_owner_id,
    canonical_e164,
    hydrated,
    abortSignal,
  })

  const [
    propertyRow,
    prospectRow,
    ownerRow,
    phoneRow,
    acquisitionRow,
    suppressions,
  ] = await Promise.all([
    identity.property_id
      ? queryMaybe('properties', PROPERTY_SELECT, { property_id: identity.property_id }, abortSignal)
      : null,
    identity.prospect_id
      ? queryMaybe('prospects', PROSPECT_SELECT, { prospect_id: identity.prospect_id }, abortSignal)
      : null,
    identity.master_owner_id
      ? queryMaybe('master_owners', OWNER_SELECT, { master_owner_id: identity.master_owner_id }, abortSignal)
      : null,
    identity.canonical_e164
      ? queryMaybe('phones', PHONE_SELECT, { canonical_e164: identity.canonical_e164 }, abortSignal)
      : null,
    identity.property_id
      ? queryMaybe('property_acquisition_scores', ACQUISITION_SCORE_SELECT, { property_id: identity.property_id }, abortSignal)
      : null,
    identity.canonical_e164
      ? supabase.from('sms_suppression_list').select('phone_number, reason, suppressed_at, suppression_type').eq('phone_number', identity.canonical_e164).then((r) => r.data || [])
      : [],
  ])

  const location = resolveCanonicalLocation({ propertyRow, hydrated, identity })
  identity.zip = location.zip
  identity.market = location.market
  identity.latitude = location.latitude
  identity.longitude = location.longitude
  identity.full_address = location.full_address

  const property = normalizeProperty(propertyRow, hydrated, location)
  const baseline_scores = buildBaselineScores(propertyRow, hydrated)

  const censusRow = location.zip
    ? await queryMaybe('census_geo_metrics', '*', { zip: location.zip }, abortSignal)
    : null

  const propertySnapshot = buildPropertySnapshot(propertyRow, hydrated, property)
  const propertyDetail = buildPropertyDetailGroups(propertyRow, hydrated, property)

  const [comps, buyerMarket, buyerMatches, activity] = await Promise.all([
    fetchCompsSection(property, location, propertyRow, abortSignal),
    fetchBuyerGeoRollup({
      zip: location.zip,
      county: location.county,
      market: location.market,
      state: location.state,
      city: location.city,
      normalized_asset_class: property.normalized_asset_class,
      property_type: property.property_type,
    }, abortSignal),
    identity.property_id ? fetchBuyerMatches(identity.property_id, abortSignal) : { status: 'market_pool_only', label: 'Market Buyer Pool', matched_buyer_count: 0, matched_buyers: [] },
    fetchActivityTimeline({
      thread_key: identity.thread_key,
      canonical_e164: identity.canonical_e164,
      property_id: identity.property_id,
      hydrated,
      abortSignal,
    }),
  ])

  const acquisition = normalizeAcquisitionDecision(acquisitionRow)
  const decisionSnapshot = buildDecisionSnapshot({ property, baseline: baseline_scores, acquisition, buyerMarket, comps, hydrated })
  const prospect = normalizeProspect(prospectRow, hydrated, phoneRow)
  const owner = normalizeOwner(ownerRow, hydrated)
  const phone = normalizePhone(phoneRow, hydrated, identity.canonical_e164)

  const census = censusRow
    ? {
        status: 'available',
        median_household_income: num(censusRow.median_household_income),
        population: num(censusRow.population),
        households: num(censusRow.households),
        housing_units: num(censusRow.housing_units),
        vacancy_rate: num(censusRow.vacancy_rate),
        renter_rate: num(censusRow.renter_occupied_percent ?? censusRow.renter_rate),
        owner_occupancy_rate: num(censusRow.owner_occupied_percent ?? censusRow.owner_occupancy_rate),
        median_year_built: num(censusRow.median_year_built),
        acquisition_pressure_score: num(censusRow.acquisition_pressure_score),
      }
    : { status: 'pending', label: 'Census enrichment pending' }

  const multifamily = buildMultifamilyIntelligence(propertyRow, property, buyerMarket, comps)

  const dossier = {
    identity,
    location,
    property,
    property_snapshot: propertySnapshot,
    property_detail: propertyDetail,
    multifamily,
    baseline_scores,
    prospect,
    master_owner: owner,
    phone,
    acquisition_decision: acquisition,
    decision_snapshot: decisionSnapshot,
    comps,
    buyer_market: buyerMarket,
    buyer_matches: buyerMatches,
    census,
    activity_timeline: activity,
    compliance: {
      suppressions: suppressions || [],
      is_suppressed: Array.isArray(suppressions) && suppressions.length > 0,
    },
    freshness: {
      property_current: Boolean(propertyRow || hydrated),
      acquisition_computed_at: acquisition?.computed_at || null,
      buyer_market_freshness: buyerMarket?.data_freshness || null,
      comps_freshness: comps?.freshness || null,
      hydrated_at: hydrated?.updated_at || hydrated?.latest_message_at || null,
    },
    _metadata: DEAL_DOSSIER_SCHEMA,
  }

  if (debug) {
    dossier.raw_sources_debug = {
      identity,
      location,
      hydrated_present: Boolean(hydrated),
      property_row: propertyRow,
      acquisition_row: acquisitionRow,
      buyer_market_level: buyerMarket?.geographic_level_used,
    }
  }

  return dossier
}

export const ENGINE_PROGRESS_STAGES = [
  'resolving_property',
  'loading_comps',
  'qualifying_comps',
  'calculating_valuation',
  'measuring_buyer_demand',
  'evaluating_seller_pressure',
  'comparing_strategies',
  'building_offer_stack',
  'calculating_confidence',
  'persisting_decision',
  'decision_ready',
]

export const ENGINE_STAGE_LABELS = {
  resolving_property: 'Resolving property and ownership',
  loading_comps: 'Loading comparable sales',
  qualifying_comps: 'Qualifying usable comps',
  calculating_valuation: 'Calculating valuation range',
  measuring_buyer_demand: 'Measuring buyer demand and liquidity',
  evaluating_seller_pressure: 'Evaluating seller and foreclosure pressure',
  comparing_strategies: 'Comparing acquisition strategies',
  building_offer_stack: 'Building the offer stack',
  calculating_confidence: 'Calculating confidence',
  persisting_decision: 'Persisting acquisition decision',
  decision_ready: 'Decision ready',
}

export async function runAcquisitionEngineWithProgress(propertyId, onProgress) {
  const emit = (stage, status = 'running', detail = null) => {
    if (typeof onProgress === 'function') onProgress({ stage, status, detail })
  }

  emit('resolving_property', 'running')
  const property = await queryMaybe('properties', PROPERTY_SELECT, { property_id: clean(propertyId) })
  if (!property) throw new Error('property_not_found')
  const location = resolveCanonicalLocation({ propertyRow: property, hydrated: null, identity: {} })
  emit('resolving_property', 'done')

  emit('loading_comps', 'running')
  const subject = normalizePropertyFeatures({ ...property, property_address_zip: location.zip }, { source: 'properties' })
  const rawComps = await loadComparableProperties(subject, { supabase })
  emit('loading_comps', 'done')

  emit('qualifying_comps', 'running')
  for (const raw of rawComps.slice(0, 12)) scoreComparable(subject, raw)
  emit('qualifying_comps', 'done')

  emit('calculating_valuation', 'running')
  emit('calculating_valuation', 'done')

  emit('measuring_buyer_demand', 'running')
  await fetchBuyerGeoRollup({
    zip: location.zip,
    county: location.county,
    market: location.market,
    state: location.state,
    city: location.city,
    normalized_asset_class: property.normalized_asset_class,
    property_type: property.property_type,
  })
  emit('measuring_buyer_demand', 'done')

  emit('evaluating_seller_pressure', 'running')
  emit('evaluating_seller_pressure', 'done')

  emit('comparing_strategies', 'running')
  emit('comparing_strategies', 'done')

  emit('building_offer_stack', 'running')
  emit('building_offer_stack', 'done')

  emit('calculating_confidence', 'running')
  const result = await scoreProperty(clean(propertyId))
  emit('calculating_confidence', 'done')

  emit('persisting_decision', 'running')
  emit('persisting_decision', 'done', { ok: result?.ok === true })

  emit('decision_ready', 'done', { ok: result?.ok === true })
  return result
}

export async function getUniversalDealDossier(params) {
  return buildDealIntelligenceDossier(params)
}