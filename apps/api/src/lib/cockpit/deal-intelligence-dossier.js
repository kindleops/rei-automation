/**
 * Canonical Deal Intelligence dossier builder.
 * Single normalized contract for all Deal Intelligence panel widths.
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
  'property_address_state', 'property_address_zip', 'property_address_county_name',
  'market', 'latitude', 'longitude', 'property_type', 'property_class',
  'normalized_asset_class', 'normalized_asset_subclass', 'asset_class', 'asset_type',
  'total_bedrooms', 'total_baths', 'building_square_feet', 'units_count',
  'year_built', 'effective_year_built', 'building_condition', 'building_quality',
  'estimated_repair_cost', 'estimated_value', 'arv', 'equity_amount', 'equity_percent',
  'total_loan_balance', 'property_flags_text', 'property_flags_json',
  'streetview_image', 'satellite_image', 'final_acquisition_score',
  'structured_motivation_score', 'deal_strength_score',
].join(',')

const PROSPECT_SELECT = [
  'prospect_id', 'master_owner_id', 'full_name', 'first_name', 'last_name',
  'language', 'language_preference', 'calculated_age', 'age', 'occupation',
  'occupation_group', 'est_household_income', 'estimated_household_income',
  'net_asset_value', 'buying_power', 'person_flags_text', 'person_flags_json',
  'matching_flags', 'prospect_contact_score', 'motivation_score', 'urgency_score',
  'financial_pressure_score',
].join(',')

const OWNER_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess', 'owner_type',
  'priority_score', 'urgency_score', 'financial_pressure_score',
  'contactability_score', 'portfolio_total_value', 'portfolio_total_equity',
  'property_count', 'portfolio_total_units', 'tax_delinquent_count',
  'active_lien_count', 'ownership_years', 'seller_tags_text', 'seller_tags_json',
  'absentee_owner', 'primary_owner_address',
].join(',')

const PHONE_SELECT = [
  'phone_id', 'canonical_e164', 'phone_number', 'line_type', 'phone_type',
  'phone_carrier', 'carrier', 'activity_status', 'usage', 'contact_score',
  'contact_window', 'timezone', 'wrong_number', 'is_wrong_number', 'dnc_status',
  'sms_eligible', 'sort_rank',
].join(',')

const COMP_DETAIL_SELECT = [
  'id', 'property_id', 'property_address_full', 'property_address_zip',
  'normalized_asset_class', 'property_type', 'total_bedrooms', 'total_baths',
  'building_square_feet', 'units_count', 'year_built', 'renovation_level_classification',
  'sale_date', 'sale_price', 'computed_ppsf', 'ppu', 'ppbd', 'arv_estimate',
  'comp_confidence_score', 'deal_grade', 'distance_miles', 'similarity_score',
].join(',')

const BUYER_MARKET_SIGNALS = ['Strong', 'Active', 'Balanced', 'Thin', 'No Coverage']

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

function omitEmptyRows(rows) {
  return rows.filter((row) => hasValue(row.value))
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
  if (error && !/does not exist|column/.test(error.message || '')) throw error
  return data || null
}

async function resolveIdentity({
  thread_key,
  property_id,
  prospect_id,
  master_owner_id,
  canonical_e164,
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
      resolved.market = clean(threadState.market) || null
    }
  }

  if (resolved.property_id && (!resolved.zip || !resolved.latitude)) {
    const property = await queryMaybe(
      'properties',
      'property_id, master_owner_id, prospect_id, market, property_address_zip, latitude, longitude',
      { property_id: resolved.property_id },
      abortSignal,
    )
    if (property) {
      resolved.master_owner_id = resolved.master_owner_id || clean(property.master_owner_id)
      resolved.prospect_id = resolved.prospect_id || clean(property.prospect_id)
      resolved.market = resolved.market || clean(property.market)
      resolved.zip = clean(property.property_address_zip)
      resolved.latitude = num(property.latitude)
      resolved.longitude = num(property.longitude)
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
    zip ? { geo_level: 'zip', geo_key: zip, asset, label: `ZIP ${zip} · ${asset}` } : null,
    county ? { geo_level: 'county', geo_key: county, asset, label: `County ${county} · ${asset}` } : null,
    market ? { geo_level: 'market', geo_key: market, asset, label: `Market ${market} · ${asset}` } : null,
    market ? { geo_level: 'market', geo_key: market, asset: 'all', label: `Market ${market} · all` } : null,
    state ? { geo_level: 'state', geo_key: state, asset: 'all', label: `State ${state} · all` } : null,
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
        geographic_level_used: attempt.geo_level,
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
    geographic_level_used: null,
    fallback_attempted: attempted,
    source: 'buyer_geo_rollups_v2',
  }
}

async function fetchCompsSection(property, abortSignal) {
  if (!property?.property_id) {
    return { status: 'missing', comp_count: 0, weighted_comp_count: 0, records: [] }
  }

  const subject = {
    property_id: property.property_id,
    latitude: num(property.latitude),
    longitude: num(property.longitude),
    zip: property.zip,
    market: property.market,
    state: property.state,
    normalized_asset_class: property.normalized_asset_class,
    property_type: property.property_type,
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
  )

  const valuationLow = salePrices.length ? Math.min(...salePrices) : null
  const valuationHigh = salePrices.length ? Math.max(...salePrices) : null

  return {
    status: records.length ? 'available' : 'missing',
    comp_count: comps.length,
    weighted_comp_count: records.filter((r) => num(r.confidence) >= 50).length,
    median_sale: median(salePrices),
    median_ppsf: isMultifamily ? null : median(ppsfValues),
    median_ppu: isMultifamily ? median(ppuValues) : null,
    valuation_low: valuationLow,
    valuation_high: valuationHigh,
    confidence: records.length
      ? Math.round(records.reduce((sum, r) => sum + (num(r.confidence) || 0), 0) / records.length)
      : null,
    freshness: records[0]?.sale_date || null,
    records,
    source: 'v_recent_sold_comps',
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

async function fetchActivityTimeline({
  thread_key,
  canonical_e164,
  property_id,
  abortSignal,
}) {
  const events = []
  const pushUnique = (event) => {
    const key = `${event.type}|${event.timestamp}|${event.label}`
    if (!events.some((e) => `${e.type}|${e.timestamp}|${e.label}` === key)) {
      events.push(event)
    }
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
        pushUnique({
          type: 'outreach_sent',
          label: 'Outreach sent',
          timestamp: msg.created_at,
          source: 'message_events',
        })
      } else if (direction === 'inbound' || direction === 'in') {
        pushUnique({
          type: intent.includes('positive') ? 'positive_engagement' : 'inbound_reply',
          label: intent.includes('positive') ? 'Positive engagement' : 'Inbound reply',
          timestamp: msg.created_at,
          source: 'message_events',
        })
      }
      if (clean(msg.delivery_status).toLowerCase() === 'failed') {
        pushUnique({
          type: 'delivery_failure',
          label: 'Delivery failure',
          timestamp: msg.created_at,
          source: 'message_events',
        })
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
          label: `Stage · ${threadState.universal_stage}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
      if (threadState.universal_status || threadState.inbox_bucket) {
        pushUnique({
          type: 'status_change',
          label: `Status · ${threadState.universal_status || threadState.inbox_bucket}`,
          timestamp: threadState.updated_at,
          source: 'inbox_thread_state',
        })
      }
    }
  }

  if (property_id) {
    let offerQuery = supabase
      .from('property_cash_offer_snapshots')
      .select('offer_price, created_at, source')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(5)
    if (abortSignal) offerQuery = offerQuery.abortSignal(abortSignal)
    const { data: offers } = await offerQuery
    for (const offer of offers || []) {
      pushUnique({
        type: clean(offer.source).includes('sent') ? 'offer_sent' : 'offer_calculated',
        label: clean(offer.source).includes('sent') ? 'Offer sent' : 'Offer calculated',
        timestamp: offer.created_at,
        source: 'property_cash_offer_snapshots',
        value: num(offer.offer_price),
      })
    }

    let matchQuery = supabase
      .from('buyer_match_runs')
      .select('created_at, total_matches')
      .eq('property_id', property_id)
      .gt('total_matches', 0)
      .order('created_at', { ascending: false })
      .limit(3)
    if (abortSignal) matchQuery = matchQuery.abortSignal(abortSignal)
    const { data: matches } = await matchQuery
    for (const match of matches || []) {
      pushUnique({
        type: 'buyer_match_generated',
        label: 'Buyer match generated',
        timestamp: match.created_at,
        source: 'buyer_match_runs',
        value: num(match.total_matches),
      })
    }
  }

  return events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 25)
}

function normalizeProperty(row) {
  if (!row) return { status: 'missing' }
  const flags = []
  if (row.property_flags_text) {
    flags.push(...String(row.property_flags_text).split(',').map((s) => s.trim()).filter(Boolean))
  }
  return {
    status: 'available',
    property_id: clean(row.property_id),
    full_address: row.property_address_full || null,
    street: row.property_address_full?.split(',')[0]?.trim() || null,
    city: row.property_address_city || null,
    state: row.property_address_state || null,
    zip: row.property_address_zip || null,
    county: row.property_address_county_name || null,
    market: row.market || null,
    property_type: row.property_type || null,
    normalized_asset_class: row.normalized_asset_class || row.asset_class || null,
    units: num(row.units_count),
    bedrooms: num(row.total_bedrooms),
    bathrooms: num(row.total_baths),
    square_feet: num(row.building_square_feet),
    year_built: num(row.year_built),
    condition: row.building_condition || null,
    repair_estimate: num(row.estimated_repair_cost),
    arv: num(row.arv),
    value: num(row.estimated_value),
    equity_amount: num(row.equity_amount),
    equity_percentage: num(row.equity_percent),
    loan_balance: num(row.total_loan_balance),
    property_flags: flags.slice(0, 6),
    street_view_url: row.streetview_image || null,
    satellite_url: row.satellite_image || null,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    acquisition_score: num(row.final_acquisition_score),
    motivation_score: num(row.structured_motivation_score),
    deal_strength_score: num(row.deal_strength_score),
  }
}

function normalizeAcquisitionDecision(row) {
  if (!row) {
    return {
      status: 'not_run',
      label: 'Decision Engine Not Run',
      can_run: true,
    }
  }
  return {
    status: 'available',
    ...row,
    acquisition_score: num(row.aos_score),
    heat_score: num(row.aos_score),
    recommended_cash_offer: num(row.recommended_cash_offer),
    expected_assignment_fee: num(row.expected_assignment_fee),
    best_strategy: row.best_strategy || null,
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

function buildDecisionSnapshot({ property, acquisition, buyerMarket, comps }) {
  const risks = []
  if (num(acquisition?.foreclosure_risk_score) >= 60) risks.push({ label: 'Foreclosure risk', score: acquisition.foreclosure_risk_score })
  if (num(acquisition?.tax_pain_score) >= 60) risks.push({ label: 'Tax pressure', score: acquisition.tax_pain_score })
  if (num(acquisition?.debt_pressure_score) >= 60) risks.push({ label: 'Debt pressure', score: acquisition.debt_pressure_score })
  if (num(acquisition?.repair_burden_score) >= 60) risks.push({ label: 'Repair burden', score: acquisition.repair_burden_score })
  if (num(property?.equity_percentage) < 20 && num(property?.equity_percentage) > 0) {
    risks.push({ label: 'Thin equity', score: 100 - num(property.equity_percentage) })
  }
  risks.sort((a, b) => (b.score || 0) - (a.score || 0))

  let recommendedNextAction = acquisition?.recommended_conversation_angle || null
  if (!recommendedNextAction && acquisition?.status === 'not_run') {
    recommendedNextAction = 'Run Decision Engine'
  } else if (!recommendedNextAction) {
    recommendedNextAction = 'Review valuation and offer stack'
  }

  return {
    acquisition_score: acquisition?.acquisition_score ?? property?.acquisition_score ?? null,
    heat_score: acquisition?.heat_score ?? property?.motivation_score ?? null,
    recommended_cash_offer: acquisition?.recommended_cash_offer ?? null,
    engine_status: acquisition?.status || 'missing',
    valuation_range: acquisition?.valuation_range || {
      low: comps?.valuation_low ?? null,
      mid: comps?.median_sale ?? null,
      high: comps?.valuation_high ?? null,
      confidence: comps?.confidence ?? null,
    },
    equity_amount: property?.equity_amount ?? null,
    equity_percentage: property?.equity_percentage ?? null,
    best_strategy: acquisition?.best_strategy ?? null,
    expected_assignment_fee: acquisition?.expected_assignment_fee ?? null,
    buyer_demand_score: acquisition?.buyer_demand_score ?? buyerMarket?.investor_demand_score ?? null,
    liquidity_score: acquisition?.liquidity_score ?? buyerMarket?.liquidity_score ?? null,
    largest_risk: risks[0] || null,
    recommended_next_action: recommendedNextAction,
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
  const identity = await resolveIdentity({
    thread_key,
    property_id,
    prospect_id,
    master_owner_id,
    canonical_e164,
    abortSignal,
  })

  const [
    propertyRow,
    prospectRow,
    ownerRow,
    phoneRow,
    acquisitionRow,
    censusRow,
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
    identity.zip
      ? queryMaybe('census_geo_metrics', '*', { zip: identity.zip }, abortSignal)
      : null,
    identity.canonical_e164
      ? supabase
          .from('sms_suppression_list')
          .select('phone_number, reason, suppressed_at, suppression_type')
          .eq('phone_number', identity.canonical_e164)
          .then((r) => r.data || [])
      : [],
  ])

  const property = normalizeProperty(propertyRow)
  if (!identity.zip && property.zip) identity.zip = property.zip
  if (!identity.market && property.market) identity.market = property.market
  if (!identity.latitude && property.latitude) identity.latitude = property.latitude
  if (!identity.longitude && property.longitude) identity.longitude = property.longitude

  const [comps, buyerMarket, buyerMatches, activity] = await Promise.all([
    fetchCompsSection(property, abortSignal),
    fetchBuyerGeoRollup({
      zip: property.zip || identity.zip,
      county: property.county,
      market: property.market || identity.market,
      state: property.state,
      city: property.city,
      normalized_asset_class: property.normalized_asset_class,
      property_type: property.property_type,
    }, abortSignal),
    identity.property_id ? fetchBuyerMatches(identity.property_id, abortSignal) : { status: 'market_pool_only', label: 'Market Buyer Pool', matched_buyer_count: 0, matched_buyers: [] },
    fetchActivityTimeline({
      thread_key: identity.thread_key,
      canonical_e164: identity.canonical_e164,
      property_id: identity.property_id,
      abortSignal,
    }),
  ])

  const acquisition = normalizeAcquisitionDecision(acquisitionRow)
  const decisionSnapshot = buildDecisionSnapshot({ property, acquisition, buyerMarket, comps })

  const prospect = prospectRow
    ? omitEmptyRows([
        { key: 'name', value: prospectRow.full_name || [prospectRow.first_name, prospectRow.last_name].filter(Boolean).join(' ') },
        { key: 'language', value: prospectRow.language || prospectRow.language_preference },
        { key: 'age', value: num(prospectRow.calculated_age ?? prospectRow.age) },
        { key: 'occupation', value: prospectRow.occupation || prospectRow.occupation_group },
        { key: 'household_income', value: num(prospectRow.est_household_income ?? prospectRow.estimated_household_income) },
        { key: 'net_asset_value', value: num(prospectRow.net_asset_value) },
        { key: 'buying_power', value: prospectRow.buying_power },
        { key: 'person_flags', value: prospectRow.person_flags_text || prospectRow.matching_flags },
        { key: 'contact_score', value: num(prospectRow.prospect_contact_score) },
      ]).reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {
        status: 'available',
        prospect_id: clean(prospectRow.prospect_id),
      })
    : { status: 'sparse' }

  const owner = ownerRow
    ? omitEmptyRows([
        { key: 'display_name', value: ownerRow.display_name },
        { key: 'owner_type', value: ownerRow.owner_type_guess || ownerRow.owner_type },
        { key: 'priority_score', value: num(ownerRow.priority_score) },
        { key: 'urgency_score', value: num(ownerRow.urgency_score) },
        { key: 'financial_pressure_score', value: num(ownerRow.financial_pressure_score) },
        { key: 'contactability_score', value: num(ownerRow.contactability_score) },
        { key: 'portfolio_value', value: num(ownerRow.portfolio_total_value) },
        { key: 'portfolio_equity', value: num(ownerRow.portfolio_total_equity) },
        { key: 'property_count', value: num(ownerRow.property_count) },
        { key: 'total_units', value: num(ownerRow.portfolio_total_units) },
        { key: 'tax_delinquent_count', value: num(ownerRow.tax_delinquent_count) },
        { key: 'active_lien_count', value: num(ownerRow.active_lien_count) },
        { key: 'ownership_years', value: num(ownerRow.ownership_years) },
        { key: 'seller_tags', value: ownerRow.seller_tags_text },
      ]).reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {
        status: 'available',
        master_owner_id: clean(ownerRow.master_owner_id),
      })
    : { status: 'sparse' }

  const phone = phoneRow
    ? omitEmptyRows([
        { key: 'number', value: phoneRow.canonical_e164 || phoneRow.phone_number },
        { key: 'type', value: phoneRow.line_type || phoneRow.phone_type },
        { key: 'carrier', value: phoneRow.phone_carrier || phoneRow.carrier },
        { key: 'activity_status', value: phoneRow.activity_status },
        { key: 'usage', value: phoneRow.usage },
        { key: 'contact_score', value: num(phoneRow.contact_score) },
        { key: 'contact_window', value: phoneRow.contact_window },
        { key: 'timezone', value: phoneRow.timezone },
        { key: 'wrong_number', value: phoneRow.wrong_number ?? phoneRow.is_wrong_number },
      ]).reduce((acc, row) => ({ ...acc, [row.key]: row.value }), { status: 'available' })
    : identity.canonical_e164
      ? { status: 'available', number: identity.canonical_e164 }
      : { status: 'missing' }

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
    property,
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
      property_current: Boolean(propertyRow),
      acquisition_computed_at: acquisition?.computed_at || null,
      buyer_market_freshness: buyerMarket?.data_freshness || null,
      comps_freshness: comps?.freshness || null,
    },
    _metadata: DEAL_DOSSIER_SCHEMA,
  }

  if (debug) {
    dossier.raw_sources_debug = {
      identity,
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
  'measuring_buyer_demand',
  'evaluating_seller_pressure',
  'comparing_strategies',
  'building_offer_stack',
  'decision_ready',
]

export async function runAcquisitionEngineWithProgress(propertyId, onProgress) {
  const emit = (stage, status = 'running', detail = null) => {
    if (typeof onProgress === 'function') onProgress({ stage, status, detail })
  }

  emit('resolving_property', 'running')
  const property = await queryMaybe('properties', PROPERTY_SELECT, { property_id: clean(propertyId) })
  if (!property) throw new Error('property_not_found')
  emit('resolving_property', 'done')

  emit('loading_comps', 'running')
  await loadComparableProperties(property)
  emit('loading_comps', 'done')

  emit('measuring_buyer_demand', 'running')
  await fetchBuyerGeoRollup({
    zip: property.property_address_zip,
    county: property.property_address_county_name,
    market: property.market,
    state: property.property_address_state,
    city: property.property_address_city,
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

  emit('decision_ready', 'done', { ok: result?.ok === true })
  return result
}

export async function getUniversalDealDossier(params) {
  return buildDealIntelligenceDossier(params)
}