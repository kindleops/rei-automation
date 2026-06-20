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
].join(',')

const OWNER_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess',
  'priority_score', 'urgency_score', 'financial_pressure_score',
  'contactability_score', 'best_contact_window', 'portfolio_total_value',
  'portfolio_total_equity', 'portfolio_total_loan_balance', 'property_count',
  'portfolio_total_units', 'tax_delinquent_count', 'active_lien_count',
  'seller_tags_text', 'seller_tags_json', 'primary_owner_address',
  'best_language', 'routing_market',
].join(',')

const PROSPECT_SELECT = [
  'prospect_id', 'master_owner_id', 'full_name', 'first_name',
  'occupation_group', 'est_household_income', 'net_asset_value',
  'buying_power', 'person_flags_text', 'person_flags_json', 'matching_flags',
  'contact_score_final', 'phone_score_final', 'best_phone', 'best_email',
  'language_preference',
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

  return {
    status: 'no_coverage',
    signal: 'No Buyer Coverage',
    label: 'No matching buyer rollup after full fallback',
    geographic_level_used: null,
    fallback_attempted: attempted,
    source: 'buyer_geo_rollups_v2',
  }
}

async function fetchCompsSection(property, location, abortSignal) {
  if (!property?.property_id) {
    return { status: 'missing', comp_count: 0, weighted_comp_count: 0, records: [] }
  }

  const subject = {
    property_id: property.property_id,
    latitude: num(property.latitude ?? location.latitude),
    longitude: num(property.longitude ?? location.longitude),
    zip: location.zip || property.zip,
    market: location.market || property.market,
    state: location.state || property.state,
    city: location.city || property.city,
    normalized_asset_class: property.normalized_asset_class,
    property_type: property.property_type,
    units_count: property.units,
    building_square_feet: property.square_feet,
    year_built: property.year_built,
  }

  let comps = []
  try {
    comps = await loadComparableProperties(subject, { supabase })
  } catch (error) {
    console.warn('[DEAL_INTEL_COMPS]', error?.message)
  }

  const records = comps.slice(0, 8).map((row) => ({
    id: clean(row.id || row.comp_id || row.property_id),
    address: row.property_address_full || row.address || null,
    asset_class: row.normalized_asset_class || row.asset_class || null,
    zip: row.property_address_zip || null,
    distance_miles: num(row.distance_miles),
    units: num(row.units_count),
    sqft: num(row.building_square_feet),
    bedrooms: num(row.total_bedrooms),
    year_built: num(row.year_built),
    renovation_level: row.renovation_level_classification || row.rehab_level || null,
    sale_date: row.sale_date || row.mls_sold_date || null,
    sale_price: num(row.sale_price || row.mls_sold_price),
    ppsf: num(row.computed_ppsf || row.price_per_sqft),
    ppu: num(row.ppu),
    ppbd: num(row.ppbd),
    arv_estimate: num(row.arv_estimate),
    confidence: num(row.comp_confidence_score),
    deal_grade: row.deal_grade || null,
    source: row.source || 'v_recent_sold_comps',
  }))

  const salePrices = records.map((r) => r.sale_price).filter((v) => v > 0).sort((a, b) => a - b)
  const ppsfValues = records.map((r) => r.ppsf).filter((v) => v > 0).sort((a, b) => a - b)
  const ppuValues = records.map((r) => r.ppu).filter((v) => v > 0).sort((a, b) => a - b)
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null)
  const isMultifamily = /multi|mf|duplex|triplex|fourplex|apt/i.test(
    String(property.normalized_asset_class || property.property_type || ''),
  ) || (num(property.units) || 0) > 1

  return {
    status: records.length ? 'available' : 'missing',
    comp_count: comps.length,
    weighted_comp_count: records.filter((r) => num(r.confidence) >= 50).length,
    median_sale: median(salePrices),
    median_ppsf: isMultifamily ? null : median(ppsfValues),
    median_ppu: isMultifamily ? median(ppuValues) : null,
    valuation_low: salePrices.length ? Math.min(...salePrices) : null,
    valuation_high: salePrices.length ? Math.max(...salePrices) : null,
    valuation_mid: median(salePrices),
    confidence: records.length
      ? Math.round(records.reduce((sum, r) => sum + (num(r.confidence) || 0), 0) / records.length)
      : null,
    freshness: records[0]?.sale_date || null,
    records,
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

async function fetchActivityTimeline({ thread_key, canonical_e164, property_id, hydrated, abortSignal }) {
  const events = []
  const pushUnique = (event) => {
    const key = `${event.type}|${event.timestamp}|${event.label}`
    if (!events.some((e) => `${e.type}|${e.timestamp}|${e.label}` === key)) events.push(event)
  }

  if (hydrated?.latest_message_at) {
    pushUnique({
      type: hydrated.latest_message_direction === 'inbound' ? 'inbound_reply' : 'outreach_sent',
      label: hydrated.latest_message_direction === 'inbound' ? 'Inbound reply' : 'Outreach sent',
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
      if (direction === 'outbound' || direction === 'out') {
        pushUnique({ type: 'outreach_sent', label: 'Outreach sent', timestamp: msg.created_at, source: 'message_events' })
      } else if (direction === 'inbound' || direction === 'in') {
        pushUnique({
          type: intent.includes('positive') ? 'positive_engagement' : 'inbound_reply',
          label: intent.includes('positive') ? 'Positive engagement' : 'Inbound reply',
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
        pushUnique({ type: 'stage_change', label: `Stage · ${threadState.universal_stage}`, timestamp: threadState.updated_at, source: 'inbox_thread_state' })
      }
      if (threadState.universal_status || threadState.inbox_bucket) {
        pushUnique({ type: 'status_change', label: `Status · ${threadState.universal_status || threadState.inbox_bucket}`, timestamp: threadState.updated_at, source: 'inbox_thread_state' })
      }
    }
  }

  return events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 25)
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
    property_flags_overflow: Math.max(0, flags.length - 3),
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
    occupation: pick(prospectRow?.occupation, hydrated?.occupation),
    occupation_group: pick(prospectRow?.occupation_group, hydrated?.occupation_group),
    household_income: pick(prospectRow?.est_household_income, prospectRow?.estimated_household_income, hydrated?.est_household_income),
    net_asset_value: pick(prospectRow?.net_asset_value, hydrated?.net_asset_value),
    buying_power: pick(prospectRow?.buying_power, hydrated?.buying_power),
    person_flags: pick(prospectRow?.person_flags_text, prospectRow?.matching_flags, hydrated?.person_flags_text, hydrated?.matching_flags),
    contact_score: num(pick(prospectRow?.contact_score_final, prospectRow?.phone_score_final, hydrated?.prospect_contact_score, hydrated?.prospect_phone_score)),
    contact_window: pick(phoneRow?.contact_window, hydrated?.best_contact_window),
    thread_priority: num(hydrated?.thread_priority ?? hydrated?.priority_score),
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
    urgency_score: num(pick(ownerRow?.urgency_score, hydrated?.urgency_score)),
    financial_pressure_score: num(pick(ownerRow?.financial_pressure_score, hydrated?.financial_pressure_score)),
    contactability_score: num(pick(ownerRow?.contactability_score, hydrated?.contactability_score)),
    contact_window: pick(ownerRow?.best_contact_window, hydrated?.best_contact_window),
    portfolio_value: num(pick(ownerRow?.portfolio_total_value, hydrated?.portfolio_total_value)),
    portfolio_equity: num(pick(ownerRow?.portfolio_total_equity, hydrated?.portfolio_total_equity)),
    portfolio_loan_balance: num(pick(ownerRow?.portfolio_total_loan_balance, hydrated?.portfolio_total_loan_balance)),
    property_count: num(pick(ownerRow?.property_count, hydrated?.property_count)),
    total_units: num(pick(ownerRow?.portfolio_total_units, hydrated?.portfolio_total_units)),
    tax_delinquent_count: num(pick(ownerRow?.tax_delinquent_count, hydrated?.tax_delinquent_count)),
    active_lien_count: num(pick(ownerRow?.active_lien_count, hydrated?.active_lien_count)),
    ownership_years: num(hydrated?.ownership_years),
    seller_tags: pick(ownerRow?.seller_tags_text, hydrated?.seller_tags_text),
    absentee_owner: /absentee/i.test(String(pick(ownerRow?.owner_type_guess, hydrated?.owner_type_guess) || '')),
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
    owner_priority: num(hydrated?.owner_priority_score),
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

  const [comps, buyerMarket, buyerMatches, activity] = await Promise.all([
    fetchCompsSection(property, location, abortSignal),
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
    : { status: 'not_loaded', label: 'Census enrichment not loaded' }

  const dossier = {
    identity,
    location,
    property,
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
  'selecting_comps',
  'calculating_valuation',
  'measuring_buyer_demand',
  'evaluating_seller_pressure',
  'comparing_strategies',
  'building_offer_stack',
  'finalizing_decision',
]

export const ENGINE_STAGE_LABELS = {
  resolving_property: 'Resolving property',
  selecting_comps: 'Selecting comparable sales',
  calculating_valuation: 'Calculating valuation range',
  measuring_buyer_demand: 'Measuring investor demand',
  evaluating_seller_pressure: 'Evaluating seller pressure',
  comparing_strategies: 'Comparing acquisition strategies',
  building_offer_stack: 'Building offer stack',
  finalizing_decision: 'Finalizing decision',
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

  emit('selecting_comps', 'running')
  await loadComparableProperties({ ...property, zip: location.zip, market: location.market, state: location.state }, { supabase })
  emit('selecting_comps', 'done')

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
  const result = await scoreProperty(clean(propertyId))
  emit('building_offer_stack', 'done')

  emit('finalizing_decision', 'done', { ok: result?.ok === true })
  return result
}

export async function getUniversalDealDossier(params) {
  return buildDealIntelligenceDossier(params)
}