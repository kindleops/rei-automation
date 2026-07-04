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
  'sale_date', 'saleprice', 'document_type', 'last_sale_doc_type', 'recording_date', 'default_date',
  'total_loan_amt', 'total_loan_payment', 'tax_amt', 'tax_delinquent', 'active_lien',
  'lot_acreage', 'lot_square_feet', 'stories', 'avg_sqft_per_unit', 'beds_per_unit',
  'assd_improvement_value', 'assd_land_value', 'assd_total_value',
  'rehab_level', 'construction_type', 'air_conditioning', 'basement', 'exterior_walls',
  'floor_cover', 'garage', 'heating_fuel_type', 'heating_type', 'interior_walls', 'pool',
  'porch', 'patio', 'deck', 'driveway', 'roof_cover', 'roof_type', 'sewer', 'water', 'zoning',
  'subdivision_name', 'school_district_name', 'flood_zone', 'hoa1_name', 'hoa1_type', 'hoa_fee_amount',
].join(',')

const PROPERTY_BASELINE_SELECT = [
  'property_id',
  'final_acquisition_score',
  'structured_motivation_score',
  'deal_strength_score',
  'tag_distress_score',
].join(',')

const PROPERTY_ENGINE_SELECT = [
  'property_id', 'property_address_full', 'property_address_city', 'property_address_state',
  'property_address_zip', 'property_zip', 'property_address_county_name', 'property_county_name',
  'market', 'market_region', 'latitude', 'longitude', 'property_type', 'property_class',
  'normalized_asset_class', 'asset_class', 'asset_type', 'total_bedrooms', 'total_baths',
  'building_square_feet', 'units_count', 'year_built', 'building_condition',
  'estimated_repair_cost', 'estimated_value', 'equity_amount', 'equity_percent',
  'total_loan_balance', 'ownership_years', 'sale_date', 'saleprice',
].join(',')

const OWNER_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess',
  'priority_score', 'priority_tier', 'urgency_score', 'financial_pressure_score',
  'contactability_score', 'best_contact_window', 'portfolio_total_value',
  'portfolio_total_equity', 'portfolio_total_loan_balance', 'portfolio_total_loan_payment',
  'portfolio_total_tax_amount', 'property_count', 'portfolio_total_units',
  'tax_delinquent_count', 'active_lien_count',
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
  'phone_id', 'canonical_e164', 'phone', 'phone_type', 'phone_owner',
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
    last_sale_document_type: pick(propertyRow?.last_sale_doc_type, propertyRow?.document_type),
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

    },
    sale_recording: {
      last_sale_date: pick(propertyRow?.sale_date),
      last_sale_price: num(pick(propertyRow?.sale_price, propertyRow?.saleprice)),
      document_type: pick(propertyRow?.document_type),
      last_sale_doc_type: pick(propertyRow?.last_sale_doc_type, hydrated?.last_sale_doc_type),
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
      construction_type: pick(propertyRow?.construction_type, hydrated?.construction_type),
      building_quality: pick(propertyRow?.building_quality, hydrated?.building_quality),
      building_condition: property?.condition,
      rehab_level: pick(propertyRow?.rehab_level, hydrated?.rehab_level),
      air_conditioning: pick(propertyRow?.air_conditioning, hydrated?.air_conditioning),
      basement: pick(propertyRow?.basement, hydrated?.basement),
      exterior_walls: pick(propertyRow?.exterior_walls, hydrated?.exterior_walls),
      floor_cover: pick(propertyRow?.floor_cover, hydrated?.floor_cover),
      garage: pick(propertyRow?.garage, hydrated?.garage),
      heating_fuel_type: pick(propertyRow?.heating_fuel_type, hydrated?.heating_fuel_type),
      heating_type: pick(propertyRow?.heating_type, hydrated?.heating_type),
      interior_walls: pick(propertyRow?.interior_walls, hydrated?.interior_walls),
      pool: pick(propertyRow?.pool, hydrated?.pool),
      porch: pick(propertyRow?.porch, hydrated?.porch),
      patio: pick(propertyRow?.patio, hydrated?.patio),
      deck: pick(propertyRow?.deck, hydrated?.deck),
      driveway: pick(propertyRow?.driveway, hydrated?.driveway),
      roof_cover: pick(propertyRow?.roof_cover, hydrated?.roof_cover),
      roof_type: pick(propertyRow?.roof_type, hydrated?.roof_type),
      sewer: pick(propertyRow?.sewer, hydrated?.sewer),
      water: pick(propertyRow?.water, hydrated?.water),
      zoning: pick(propertyRow?.zoning, hydrated?.zoning),
      subdivision_name: pick(propertyRow?.subdivision_name, hydrated?.subdivision_name),
      school_district_name: pick(propertyRow?.school_district_name, hydrated?.school_district_name),
      flood_zone: pick(propertyRow?.flood_zone, hydrated?.flood_zone),
      hoa1_name: pick(propertyRow?.hoa1_name, hydrated?.hoa1_name),
      hoa1_type: pick(propertyRow?.hoa1_type, hydrated?.hoa1_type),
      hoa_fee_amount: num(pick(propertyRow?.hoa_fee_amount, hydrated?.hoa_fee_amount)),
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

const COMP_IDENTITY_SELECT = [
  'id', 'owner_name', 'owner_1_name', 'is_corporate_owner', 'document_type', 'last_sale_doc_type',
  'recording_date', 'sale_price', 'mls_sold_price', 'subdivision_name', 'school_district_name',
].join(',')

function looksLikeLlcEntity(name) {
  const n = String(name || '').toLowerCase()
  return /\b(llc|l\.l\.c|inc|corp|corporation|trust|lp|ltd|holdings|properties|investments|partners)\b/.test(n)
}

function resolveCompSaleChannel(comp = {}, identity = null) {
  const mlsPrice = num(comp.mls_sold_price ?? identity?.mls_sold_price)
  const mlsDate = comp.mls_sold_date || null
  const salePrice = num(comp.sale_price ?? identity?.sale_price)
  const isMlsSale = (mlsPrice != null && mlsPrice > 0) || Boolean(mlsDate)
  const isOffMarket = !isMlsSale && salePrice != null && salePrice > 0
  return { is_mls_sale: isMlsSale, is_off_market: isOffMarket }
}

function resolveCompBuyerProfile(comp = {}, identity = null) {
  const buyerName = clean(identity?.owner_name || identity?.owner_1_name || comp.buyer_name || comp.owner_name || '')
  const corporateFlag = identity?.is_corporate_owner === true || comp.is_corporate_owner === true
  const isCorporateBuyer = corporateFlag || (buyerName ? looksLikeLlcEntity(buyerName) : false)
  const buyerType = isCorporateBuyer
    ? (looksLikeLlcEntity(buyerName) ? 'llc_corporate' : 'corporate')
    : buyerName
      ? 'individual'
      : null
  return {
    buyer_name: buyerName || null,
    is_corporate_buyer: isCorporateBuyer,
    buyer_type: buyerType,
  }
}

async function fetchCompIdentityBatch(compIds, abortSignal) {
  if (!compIds.length) return new Map()
  let query = supabase.from('buyer_comp_raw_v2').select(COMP_IDENTITY_SELECT).in('id', compIds)
  if (abortSignal) query = query.abortSignal(abortSignal)
  const { data, error } = await query
  if (error) {
    console.warn('[DEAL_INTEL_COMP_IDENTITY]', error?.message)
    return new Map()
  }
  return new Map((data || []).map((row) => [clean(row.id), row]))
}

const average = (arr) => (arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : null)

async function queryMaybe(table, select, filters = {}, abortSignal) {
  let query = supabase.from(table).select(select)
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    query = query.eq(key, value)
  }
  if (abortSignal) query = query.abortSignal(abortSignal)
  // Never use maybeSingle() — duplicate rows (common on acquisition_scores, phones)
  // must not 500 the dossier; take the first matching row.
  query = query.limit(1)
  const { data, error } = await query
  if (!error) {
    const row = Array.isArray(data) ? data[0] : data
    return row || null
  }
  if (/does not exist|column/i.test(error.message || '')) {
    console.warn(`[DEAL_INTEL_QUERY] ${table} select failed: ${error.message}`)
    return null
  }
  throw error
}

const TERMINAL_OPPORTUNITY_STATUSES = new Set(['won', 'lost', 'dead', 'suppressed', 'archived'])

/**
 * Deterministically select the canonical opportunity for a thread's
 * Negotiation Intelligence projection: active/non-archived deals win, then a
 * deal on the same property, then the deal carrying the current accepted-term
 * version, with the latest updated_at only as the final tie-breaker. State
 * from an older or unrelated opportunity must never be displayed.
 */
async function selectNegotiationOpportunityRow({ threadKey, propertyId = null, abortSignal }) {
  if (!threadKey) return null
  let query = supabase
    .from('acquisition_opportunities')
    .select('id,acquisition_stage,opportunity_status,primary_property_id,asking_price,recommended_offer,current_offer,seller_counter,next_action,next_action_due,updated_at,metadata')
    .eq('primary_thread_key', threadKey)
    .order('updated_at', { ascending: false })
    .limit(20)
  if (abortSignal) query = query.abortSignal(abortSignal)
  const { data, error } = await query
  if (error) {
    if (/does not exist|column/i.test(error.message || '')) {
      console.warn(`[DEAL_INTEL_QUERY] acquisition_opportunities select failed: ${error.message}`)
      return null
    }
    throw error
  }
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return null

  const rank = (row) => {
    const active = TERMINAL_OPPORTUNITY_STATUSES.has(String(row.opportunity_status ?? '').trim().toLowerCase()) ? 0 : 1
    const propertyMatch = propertyId && row.primary_property_id === propertyId ? 1 : 0
    const acceptedTerms = row.metadata?.negotiation_state?.terms_accepted === true ? 1 : 0
    return active * 4 + propertyMatch * 2 + acceptedTerms
  }
  // Rows arrive newest-first, so on rank ties the latest updated_at wins.
  return rows.reduce((best, row) => (rank(row) > rank(best) ? row : best), rows[0])
}

async function queryHydratedThread({ thread_key, property_id }, abortSignal) {
  if (thread_key) {
    let query = supabase.from('inbox_threads_hydrated').select('*').eq('thread_key', thread_key).limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data, error } = await query
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data
      if (row) return row
    }
  }
  if (property_id) {
    let query = supabase.from('inbox_threads_hydrated').select('*').eq('property_id', property_id).limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data, error } = await query
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data
      if (row) return row
    }
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

  if (resolved.property_id && !resolved.master_owner_id) {
    const propertyRow = await queryMaybe(
      'properties',
      'master_owner_id, prospect_id',
      { property_id: resolved.property_id },
      abortSignal,
    )
    if (propertyRow) {
      resolved.master_owner_id = resolved.master_owner_id || clean(propertyRow.master_owner_id)
      resolved.prospect_id = resolved.prospect_id || clean(propertyRow.prospect_id)
    }
  }

  if (resolved.master_owner_id && !resolved.prospect_id) {
    let linkedProspectQuery = supabase
      .from('prospects')
      .select('prospect_id')
      .eq('master_owner_id', resolved.master_owner_id)
      .limit(1)
    if (abortSignal) linkedProspectQuery = linkedProspectQuery.abortSignal(abortSignal)
    const { data: linkedProspectRows, error: linkedProspectError } = await linkedProspectQuery
    const linkedProspect = linkedProspectError ? null : (Array.isArray(linkedProspectRows) ? linkedProspectRows[0] : linkedProspectRows)
    if (linkedProspect?.prospect_id) {
      resolved.prospect_id = clean(linkedProspect.prospect_id)
    }
  }

  if (resolved.canonical_e164 && (!resolved.property_id || !resolved.master_owner_id || !resolved.prospect_id)) {
    const recentMessage = await queryMaybe(
      'message_events',
      'property_id, master_owner_id, prospect_id',
      { thread_key: resolved.canonical_e164 },
      abortSignal,
    )
    if (recentMessage) {
      resolved.property_id = resolved.property_id || clean(recentMessage.property_id)
      resolved.master_owner_id = resolved.master_owner_id || clean(recentMessage.master_owner_id)
      resolved.prospect_id = resolved.prospect_id || clean(recentMessage.prospect_id)
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
    const { data, error } = await query
    const rollupRow = error ? null : (Array.isArray(data) ? data[0] : data)
    if (rollupRow) {
      const heat = num(rollupRow.buyer_heat_score) ?? num(rollupRow.investor_demand_score)
      return {
        status: 'available',
        signal: buyerMarketSignal(heat),
        timeframe: rollupRow.timeframe || rollupRow.rollup_window || '6mo',
        geographic_level_used: `${attempt.geo_level} · ${attempt.asset}`,
        geographic_key: attempt.geo_key,
        normalized_asset_class: attempt.asset,
        fallback_attempted: attempted,
        purchase_count: num(rollupRow.purchase_count),
        buyer_count: num(rollupRow.buyer_count),
        corporate_buyer_count: num(rollupRow.corporate_buyer_count),
        repeat_buyer_count: num(rollupRow.repeat_buyer_count),
        avg_purchase_price: num(rollupRow.avg_purchase_price),
        median_purchase_price: num(rollupRow.median_purchase_price),
        ppsf: num(rollupRow.ppsf) ?? num(rollupRow.avg_ppsf),
        ppu: num(rollupRow.ppu),
        avg_units: num(rollupRow.avg_units),
        liquidity_score: num(rollupRow.liquidity_score),
        velocity_score: num(rollupRow.velocity_score),
        investor_demand_score: num(rollupRow.investor_demand_score),
        buyer_heat_score: num(rollupRow.buyer_heat_score),
        dominant_buyer_type: rollupRow.dominant_buyer_type || null,
        dominant_strategy: rollupRow.dominant_strategy || null,
        top_buyers: Array.isArray(rollupRow.top_buyers) ? rollupRow.top_buyers : [],
        price_bands: rollupRow.price_bands || null,
        data_freshness: rollupRow.computed_at || rollupRow.updated_at || null,
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

  const compIds = [...new Set(rawComps.map((raw) => clean(raw.comp_id || raw.id)).filter(Boolean))]
  const identityById = await fetchCompIdentityBatch(compIds, abortSignal)

  const qualification = {
    candidates_found: rawComps.length,
    asset_type_matches: 0,
    location_qualified: 0,
    similarity_qualified: 0,
    weighted_usable: 0,
    rejected: 0,
  }

  const analyzed = rawComps.map((raw) => {
    const scored = scoreComparable(subject, raw)
    const comp = scored?.comp || normalizePropertyFeatures(raw, {
      source: raw.source || 'v_recent_sold_comps',
      distance_miles: raw.distance_miles,
    })
    const gateEligibility = evaluateCompEligibility(subject, comp)
    const eligibilityReasons = scored?.eligible === false ? (scored.reasons || []) : []
    const eligibility = {
      eligible: scored?.eligible === true,
      reasons: eligibilityReasons,
      distance_miles: comp.distance_miles ?? gateEligibility.distance_miles ?? num(raw.distance_miles),
      sale_age_months: comp.sale_age_months ?? gateEligibility.sale_age_months,
    }
    const assetMatch = !gateEligibility.reasons.includes('asset_type_mismatch')
    const locationOk = !gateEligibility.reasons.some((r) =>
      ['outside_radius', 'outside_zip_without_coordinates'].includes(r),
    )
    const similarityScore = num(scored?.comp_confidence ?? scored?.weighted_score)
    const usable = scored?.eligible === true && (similarityScore ?? 0) >= 45

    if (assetMatch) qualification.asset_type_matches += 1
    if (locationOk) qualification.location_qualified += 1
    if (scored?.eligible) qualification.similarity_qualified += 1
    if (usable) qualification.weighted_usable += 1
    else qualification.rejected += 1
    const compId = clean(comp.id || comp.comp_id || comp.property_id)
    const identity = identityById.get(compId) || null
    const salePrice = num(comp.sale_price || comp.mls_sold_price || identity?.sale_price)
    const units = num(comp.units_count ?? comp.units)
    const sqft = num(comp.building_square_feet ?? comp.sqft)
    const channel = resolveCompSaleChannel(comp, identity)
    const buyer = resolveCompBuyerProfile(comp, identity)
    const documentType = clean(identity?.document_type || identity?.last_sale_doc_type || comp.document_type || '')

    return {
      id: compId,
      property_id: clean(comp.property_id || compId),
      latitude: num(comp.latitude),
      longitude: num(comp.longitude),
      address: comp.property_address_full || comp.address || null,
      property_type: comp.property_type || comp.asset_type || null,
      asset_class: comp.normalized_asset_class || comp.asset_class || null,
      zip: comp.property_address_zip || comp.zip || null,
      distance_miles: num(eligibility.distance_miles ?? comp.distance_miles),
      units,
      sqft,
      bedrooms: num(comp.total_bedrooms ?? comp.beds),
      bathrooms: num(comp.total_baths ?? comp.baths),
      avg_sqft_per_unit: num(comp.avg_sqft_per_unit ?? (sqft && units ? sqft / units : null)),
      avg_beds_per_unit: num(comp.avg_beds_per_unit ?? (num(comp.total_bedrooms ?? comp.beds) && units ? num(comp.total_bedrooms ?? comp.beds) / units : null)),
      year_built: num(comp.year_built),
      effective_year_built: num(comp.effective_year_built),
      condition: comp.condition || comp.building_condition || null,
      construction_type: comp.construction_type || null,
      subdivision: comp.subdivision || identity?.subdivision_name || null,
      school_district: comp.school_district || identity?.school_district_name || null,
      lot_sqft: num(comp.lot_sqft ?? comp.lot_square_feet),
      sale_date: comp.sale_date || comp.mls_sold_date || null,
      recording_date: identity?.recording_date || comp.recording_date || null,
      sale_price: salePrice,
      mls_sold_price: num(comp.mls_sold_price ?? identity?.mls_sold_price),
      document_type: documentType || null,
      ...channel,
      ...buyer,
      ppsf: num(comp.computed_ppsf || comp.price_per_sqft || (salePrice && sqft ? salePrice / sqft : null)),
      ppu: num(comp.ppu || comp.price_per_unit || (salePrice && units ? salePrice / units : null)),
      similarity_score: similarityScore,
      weight: num(scored?.weight),
      included: usable,
      exclusion_reason: usable
        ? null
        : compRejectionLabel(
          eligibilityReasons[0] || (scored?.eligible ? 'low_similarity' : 'not_eligible'),
        ),
      source: comp.source || 'v_recent_sold_comps',
    }
  })

  const usableRecords = analyzed.filter((r) => r.included)
  const salePrices = usableRecords.map((r) => r.sale_price).filter((v) => v > 0).sort((a, b) => a - b)
  const ppsfValues = usableRecords.map((r) => r.ppsf).filter((v) => v > 0).sort((a, b) => a - b)
  const ppuValues = usableRecords.map((r) => r.ppu).filter((v) => v > 0).sort((a, b) => a - b)
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null)
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
    median_ppsf: median(ppsfValues),
    avg_ppsf: average(ppsfValues),
    median_ppu: median(ppuValues),
    avg_ppu: average(ppuValues),
    mls_sale_count: usableRecords.filter((r) => r.is_mls_sale).length,
    off_market_count: usableRecords.filter((r) => r.is_off_market).length,
    corporate_buyer_count: usableRecords.filter((r) => r.is_corporate_buyer).length,
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
  const { data: runRows, error: runError } = await runQuery
  const run = runError ? null : (Array.isArray(runRows) ? runRows[0] : runRows)

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
    const key = event.id || `${event.type}|${event.timestamp}|${event.label}|${event.source}`
    if (!events.some((e) => (e.id || `${e.type}|${e.timestamp}|${e.label}|${e.source}`) === key)) {
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
      const msgId = clean(msg.id)
      const base = { timestamp: msg.created_at, source: 'message_events', id: msgId || undefined }

      if (direction === 'outbound' || direction === 'out') {
        pushUnique({ ...base, type: 'outreach_sent', label: 'Outbound message sent' })
      } else if (direction === 'inbound' || direction === 'in') {
        if (intent.includes('negative') || intent.includes('not interested')) {
          pushUnique({ ...base, type: 'negative_engagement', label: 'Negative engagement' })
        } else if (intent.includes('positive')) {
          pushUnique({ ...base, type: 'positive_engagement', label: 'Positive engagement' })
        } else {
          pushUnique({ ...base, type: 'inbound_reply', label: 'Inbound seller response' })
        }
      }

      if (intent.includes('wrong') || eventType.includes('wrong_number')) {
        pushUnique({ ...base, type: 'wrong_number', label: 'Wrong number reported' })
      }
      if (intent && !['positive', 'negative', 'unknown', ''].includes(intent)) {
        pushUnique({
          ...base,
          type: 'automation_classified',
          label: `Intent classified · ${intent.replace(/_/g, ' ')}`,
          detail: clean(msg.message_body).slice(0, 120) || null,
        })
      }
      const delivery = clean(msg.delivery_status).toLowerCase()
      if (delivery === 'failed') {
        pushUnique({ ...base, type: 'delivery_failure', label: 'Delivery failed' })
      } else if (delivery === 'delivered' && (direction === 'outbound' || direction === 'out')) {
        pushUnique({ ...base, type: 'follow_up_sent', label: 'Message delivered' })
      }
    }
  }

  if (thread_key) {
    const threadState = await queryMaybe(
      'inbox_thread_state',
      'stage, status, updated_at, next_action',
      { thread_key },
      abortSignal,
    )
    if (threadState?.updated_at) {
      if (threadState.stage) {
        pushUnique({
          type: 'stage_change',
          label: `Stage changed · ${threadState.stage}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
      if (threadState.status) {
        pushUnique({
          type: 'status_change',
          label: `Status changed · ${threadState.status}`,
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

function ageFromMob(mob) {
  const raw = clean(mob)
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length >= 6) {
    const year = Number(digits.slice(0, 4))
    const month = Number(digits.slice(4, 6))
    if (year > 1900 && year <= new Date().getFullYear() && month >= 1 && month <= 12) {
      const now = new Date()
      let age = now.getFullYear() - year
      if (now.getMonth() + 1 < month) age -= 1
      return age > 0 && age < 120 ? age : null
    }
  }
  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    const age = Math.floor((Date.now() - parsed.getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    return age > 0 && age < 120 ? age : null
  }
  return null
}

/** Baseline scores from public.properties only — never engine AOS. */
export function buildBaselineScores(propertyRow, hydrated) {
  return {
    acquisition_score: num(pick(
      propertyRow?.final_acquisition_score,
      hydrated?.final_acquisition_score,
    )),
    deal_strength_score: num(pick(
      propertyRow?.deal_strength_score,
      hydrated?.deal_strength_score,
    )),
    motivation_score: num(pick(
      propertyRow?.structured_motivation_score,
      hydrated?.structured_motivation_score,
      hydrated?.motivation_score,
      hydrated?.priority_score,
    )),
    distress_score: num(pick(
      propertyRow?.tag_distress_score,
      hydrated?.tag_distress_score,
      hydrated?.distress_score,
    )),
    label: 'Baseline Property Intelligence',
  }
}

function buildConversationIntelligence(hydrated, acquisition, compliance) {
  const fields = {
    latest_intent: pick(hydrated?.reply_intent, hydrated?.latest_intent, hydrated?.detected_intent),
    reply_intent: pick(hydrated?.reply_intent),
    seller_state: pick(hydrated?.universal_stage, hydrated?.stage),
    lead_temperature: pick(hydrated?.lead_temperature),
    sentiment: pick(hydrated?.sentiment, hydrated?.latest_sentiment),
    motivation_signal: pick(hydrated?.motivation_signal, hydrated?.structured_motivation_score),
    language: pick(hydrated?.best_language, hydrated?.language_preference),
    latest_inbound_summary: pick(hydrated?.latest_message_body, hydrated?.latest_inbound_body),
    recommended_conversation_angle: pick(acquisition?.recommended_conversation_angle, hydrated?.ai_next_action, hydrated?.next_action),
    last_seller_response_at: hydrated?.latest_message_direction === 'inbound' ? hydrated?.latest_message_at : null,
    next_follow_up_at: pick(hydrated?.next_follow_up_at, hydrated?.follow_up_at),
    universal_status: pick(hydrated?.universal_status, hydrated?.inbox_bucket),
  }

  const populated = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => hasValue(value)),
  )

  if (!Object.keys(populated).length) {
    return { status: 'sparse' }
  }

  return {
    status: 'available',
    ...populated,
    sms_eligible: compliance?.is_suppressed ? false : true,
    suppressed: compliance?.is_suppressed ?? false,
  }
}

/**
 * Negotiation Intelligence projection (spec §15) — read-only view of the
 * persisted negotiation state on the canonical deal record. The UI projects
 * backend truth; nothing here participates in execution.
 */
function buildNegotiationIntelligence(opportunityRow) {
  if (!opportunityRow) return { status: 'no_tracked_deal' }
  const metadata = opportunityRow.metadata && typeof opportunityRow.metadata === 'object'
    ? opportunityRow.metadata
    : {}
  const state = metadata.negotiation_state && typeof metadata.negotiation_state === 'object'
    ? metadata.negotiation_state
    : null
  const ade = metadata.ade_snapshot && typeof metadata.ade_snapshot === 'object'
    ? metadata.ade_snapshot
    : null
  if (!state && !ade) return { status: 'no_negotiation_state', opportunity_id: opportunityRow.id }

  const gap = state?.gap_metrics || {}
  return {
    status: 'available',
    opportunity_id: opportunityRow.id,
    acquisition_stage: opportunityRow.acquisition_stage || null,
    seller_position: {
      initial_ask: num(state?.initial_asking_price ?? state?.initial_ask),
      current_ask: num(state?.current_asking_price ?? state?.current_ask ?? opportunityRow.asking_price),
      lowest_indication: num(state?.lowest_seller_indication),
      net_requirement: num(state?.seller_net_requirement),
      asking_price_history: state?.asking_price_history || [],
      concessions: state?.seller_concessions || [],
      cumulative_concession_amount: num(state?.cumulative_concession_amount),
      price_confidence: num(state?.asking_price_confidence),
    },
    property_facts: {
      occupancy: state?.occupancy || null,
      condition: state?.condition_summary || null,
      repairs: state?.repair_facts || [],
      timeline: state?.timeline || null,
      motivation: state?.motivation_signals || [],
      closing_preference: state?.closing_preference || null,
    },
    acquisition_authority: {
      ade_confidence: num(ade?.confidence ?? ade?.valuation_confidence),
      recommended_offer: num(state?.recommended_offer ?? ade?.recommended_cash_offer),
      floor: num(state?.authorized_offer_floor ?? ade?.minimum_acceptable_offer),
      ceiling: num(state?.authorized_offer_ceiling ?? ade?.investor_ceiling_mid),
      direct_purchase_maximum: num(state?.direct_purchase_maximum ?? ade?.investor_ceiling_high),
      alternative_strategy_eligibility: state?.alternate_strategy_eligibility || null,
      repair_estimate: num(state?.repair_estimate ?? ade?.estimated_repairs),
      arv: num(state?.arv ?? ade?.valuation_mid),
      comp_anchor: state?.selected_comp_anchor || null,
      ade_snapshot_at: metadata.ade_snapshot_at || null,
    },
    negotiation: {
      zone: state?.negotiation_zone || null,
      strategy: state?.current_strategy || state?.strategy || null,
      prior_strategies: state?.prior_strategies || [],
      round: num(state?.negotiation_round ?? state?.negotiation_turn) ?? 0,
      offers_made: state?.offers_made || [],
      latest_offer: num(state?.latest_offer),
      counters: state?.seller_counters || [],
      remaining_gap: num(gap.absolute_gap),
      gap_pct_of_ask: num(gap.gap_pct_of_ask),
      movement_available: num(gap.remaining_authorized_movement),
      seller_sentiment: state?.seller_sentiment || state?.last_seller_sentiment || null,
      resistance_type: state?.resistance_type || null,
      terms_accepted: state?.terms_accepted === true,
      accepted_price: num(state?.accepted_price),
      terms_accepted_at: state?.terms_accepted_at || state?.accepted_at || null,
      next_action: state?.next_action || state?.next_move || opportunityRow.next_action || null,
      next_action_due_at: state?.next_action_due_at || opportunityRow.next_action_due || null,
      contract_readiness: state?.contract_readiness || null,
      unresolved_contract_fields: state?.unresolved_contract_fields || [],
    },
    explanation: {
      transition_reason: metadata.last_reasoning_code || null,
      strategy_reason: state?.human_review_reason || null,
      authority_source: ade ? 'persisted_ade_snapshot' : 'none',
      review_reason: state?.human_review_reason || null,
      automation_confidence: num(state?.automation_confidence),
      updated_at: state?.updated_at || opportunityRow.updated_at || null,
      updated_from_message_id: state?.updated_from_message_id || null,
    },
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
    motivation_score: num(pick(
      propertyRow?.structured_motivation_score,
      hydrated?.structured_motivation_score,
      hydrated?.motivation_score,
      hydrated?.priority_score,
    )),
    deal_strength_score: num(pick(propertyRow?.deal_strength_score, hydrated?.deal_strength_score)),
    distress_score: num(pick(
      propertyRow?.tag_distress_score,
      hydrated?.tag_distress_score,
      hydrated?.distress_score,
    )),
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
    full_name: name,
    language: pick(hydrated?.best_language, prospectRow?.language_preference),
    age: num(pick(
      prospectRow?.calculated_age,
      prospectRow?.age,
      prospectRow?.prospect_age,
      hydrated?.prospect_age,
      hydrated?.calculated_age,
      ageFromMob(prospectRow?.mob),
      ageFromMob(hydrated?.mob),
    )),
    occupation: pick(hydrated?.occupation, prospectRow?.occupation_group),
    occupation_code: pick(hydrated?.occupation_code),
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
    relationship_flags: parseDelimitedFlags(pick(prospectRow?.matching_flags, hydrated?.matching_flags, prospectRow?.person_flags_text)),
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
    full_name: displayName,
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
    portfolio_loan_payment: num(pick(ownerRow?.portfolio_total_loan_payment, hydrated?.portfolio_total_loan_payment)),
    portfolio_tax_amount: num(pick(ownerRow?.portfolio_total_tax_amount, hydrated?.portfolio_total_tax_amount)),
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

function normalizePhone(phoneRow, hydrated, canonicalE164, ownerRow, compliance) {
  const alternates = [
    pick(ownerRow?.best_phone_2),
    pick(ownerRow?.best_phone_3),
    pick(hydrated?.prospect_best_phone_2),
  ].filter((v) => v && v !== canonicalE164)

  if (phoneRow) {
    return {
      status: 'available',
      number: pick(phoneRow.canonical_e164, phoneRow.phone, canonicalE164),
      alternate_numbers: [...new Set(alternates)],
      type: phoneRow.phone_type || null,
      phone_owner: pick(phoneRow.phone_owner, hydrated?.phone_owner),
      carrier: pick(phoneRow.phone_owner, hydrated?.phone_owner),
      activity_status: phoneRow.activity_status || null,
      activity_period: phoneRow.activity_status || null,
      usage: phoneRow.usage_12_months || phoneRow.usage_2_months || null,
      phone_score: num(pick(phoneRow.phone_score_final, hydrated?.prospect_phone_score)),
      contact_score: num(phoneRow.contact_score_final),
      contact_window: pick(phoneRow.contact_window, hydrated?.best_contact_window),
      timezone: phoneRow.timezone || null,
      wrong_number: Boolean(phoneRow.wrong_number_at),
      sms_eligible: compliance?.is_suppressed ? false : true,
      delivery_eligible: compliance?.is_suppressed ? false : true,
      suppressed: compliance?.is_suppressed ?? false,
      suppression_reason: compliance?.suppressions?.[0]?.reason || null,
    }
  }
  if (canonicalE164) {
    return {
      status: 'available',
      number: canonicalE164,
      alternate_numbers: [...new Set(alternates)],
      contact_window: hydrated?.best_contact_window || null,
      sms_eligible: compliance?.is_suppressed ? false : true,
      suppressed: compliance?.is_suppressed ?? false,
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
  summary_only = false,
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
    propertyBaselineRow,
    prospectRow,
    ownerRow,
    phoneRow,
    acquisitionRow,
    suppressions,
  ] = await Promise.all([
    identity.property_id
      ? queryMaybe('properties', PROPERTY_SELECT, { property_id: identity.property_id }, abortSignal)
      : null,
    identity.property_id
      ? queryMaybe('properties', PROPERTY_BASELINE_SELECT, { property_id: identity.property_id }, abortSignal)
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

  const censusRow = !summary_only && location.zip
    ? await queryMaybe(
      'census_geo_metrics',
      'geo_level,geoid,name,median_household_income,total_population,total_households,total_housing_units,vacancy_rate,renter_rate,owner_occupancy_rate,median_year_built,acquisition_pressure_score',
      { geo_level: 'zcta', geoid: location.zip },
      abortSignal,
    )
    : null

  const propertySnapshot = buildPropertySnapshot(propertyRow, hydrated, property)
  const propertyDetail = summary_only ? null : buildPropertyDetailGroups(propertyRow, hydrated, property)

  const [comps, buyerMarket, buyerMatches, activity] = summary_only
    ? [
      { status: 'lazy', label: 'Open comps panel to load', records: [] },
      { status: 'lazy', label: 'Buyer market loads on expand', geographic_level_used: null, data_freshness: null },
      { status: 'lazy', label: 'Buyer matches load on expand', matched_buyer_count: 0, matched_buyers: [] },
      { status: 'lazy', label: 'Activity loads on expand', events: [] },
    ]
    : await Promise.all([
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
  const baselinePropertyRow = propertyBaselineRow
    ? { ...(propertyRow || {}), ...propertyBaselineRow }
    : propertyRow
  const baseline_scores = buildBaselineScores(baselinePropertyRow, hydrated)
  const decisionSnapshot = buildDecisionSnapshot({ property, baseline: baseline_scores, acquisition, buyerMarket, comps, hydrated })
  const prospect = normalizeProspect(prospectRow, hydrated, phoneRow)
  const owner = normalizeOwner(ownerRow, hydrated)
  const compliance = {
    suppressions: suppressions || [],
    is_suppressed: Array.isArray(suppressions) && suppressions.length > 0,
  }
  const phone = normalizePhone(phoneRow, hydrated, identity.canonical_e164, ownerRow, compliance)
  const conversation_intelligence = buildConversationIntelligence(hydrated, acquisition, compliance)

  // Negotiation Intelligence (spec §15) — persisted negotiation state on the
  // canonical deal record, projected read-only.
  const opportunityRow = identity.thread_key
    ? await selectNegotiationOpportunityRow({
      threadKey: identity.thread_key,
      propertyId: identity.property_id || null,
      abortSignal,
    })
    : null
  const negotiation_intelligence = buildNegotiationIntelligence(opportunityRow)

  const census = summary_only
    ? { status: 'lazy', label: 'Census loads on expand' }
    : (censusRow
      ? {
          status: 'available',
          median_household_income: num(censusRow.median_household_income),
          population: num(censusRow.total_population ?? censusRow.population),
          households: num(censusRow.total_households ?? censusRow.households),
          housing_units: num(censusRow.total_housing_units ?? censusRow.housing_units),
          vacancy_rate: num(censusRow.vacancy_rate),
          renter_rate: num(censusRow.renter_occupied_percent ?? censusRow.renter_rate),
          owner_occupancy_rate: num(censusRow.owner_occupied_percent ?? censusRow.owner_occupancy_rate),
          median_year_built: num(censusRow.median_year_built),
          acquisition_pressure_score: num(censusRow.acquisition_pressure_score),
        }
      : { status: 'pending', label: 'Census enrichment pending' })

  const multifamily = summary_only ? null : buildMultifamilyIntelligence(propertyRow, property, buyerMarket, comps)

  const dossier = summary_only
    ? {
        summary_only: true,
        identity,
        location,
        property: {
          property_id: property.property_id,
          full_address: property.full_address,
          market: property.market,
          estimated_value: property.estimated_value,
          beds: property.beds,
          baths: property.baths,
          sqft: property.sqft,
          property_type: property.property_type,
        },
        property_snapshot: propertySnapshot,
        baseline_scores,
        acquisition_decision: acquisition,
        decision_snapshot: decisionSnapshot,
        conversation_intelligence,
        negotiation_intelligence,
        compliance,
        freshness: {
          property_current: Boolean(propertyRow || hydrated),
          acquisition_computed_at: acquisition?.computed_at || null,
          hydrated_at: hydrated?.updated_at || hydrated?.latest_message_at || null,
        },
      }
    : {
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
        conversation_intelligence,
        negotiation_intelligence,
        activity_timeline: activity,
        compliance,
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

async function loadPropertyRowForEngine(propertyId, threadKey) {
  const id = clean(propertyId)
  if (!id) return { property: null, hydrated: null, location: null }

  let property = await queryMaybe('properties', PROPERTY_ENGINE_SELECT, { property_id: id })
  if (!property) {
    property = await queryMaybe('properties', PROPERTY_SELECT, { property_id: id })
  }

  const hydrated = await queryHydratedThread({ property_id: id, thread_key: threadKey })
  const location = resolveCanonicalLocation({
    propertyRow: property,
    hydrated,
    identity: { property_id: id, full_address: hydrated?.property_address_full },
  })

  if (!property && hydrated) {
    property = {
      property_id: id,
      property_address_full: hydrated.property_address_full,
      property_address_city: hydrated.property_address_city,
      property_address_state: hydrated.property_address_state,
      property_address_zip: hydrated.property_address_zip || hydrated.zip,
      property_zip: hydrated.property_address_zip || hydrated.zip,
      market: hydrated.market || hydrated.market_region,
      latitude: hydrated.latitude,
      longitude: hydrated.longitude,
      property_type: hydrated.property_type,
      property_class: hydrated.property_class,
      normalized_asset_class: hydrated.property_class,
      units_count: hydrated.units_count,
      total_bedrooms: hydrated.total_bedrooms,
      total_baths: hydrated.total_baths,
      building_square_feet: hydrated.building_square_feet,
      year_built: hydrated.year_built,
      building_condition: hydrated.building_condition,
      estimated_repair_cost: hydrated.estimated_repair_cost,
      estimated_value: hydrated.estimated_value,
      equity_amount: hydrated.equity_amount,
      equity_percent: hydrated.equity_percent,
      total_loan_balance: hydrated.total_loan_balance || hydrated.total_loan_amt,
      ownership_years: hydrated.ownership_years,
    }
  }

  return { property, hydrated, location }
}

export async function runAcquisitionEngineWithProgress(propertyId, onProgress, options = {}) {
  const emit = (stage, status = 'running', detail = null) => {
    if (typeof onProgress === 'function') onProgress({ stage, status, detail })
  }

  emit('resolving_property', 'running')
  const { property, location } = await loadPropertyRowForEngine(propertyId, options.thread_key)
  if (!property) throw new Error('property_not_found')
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