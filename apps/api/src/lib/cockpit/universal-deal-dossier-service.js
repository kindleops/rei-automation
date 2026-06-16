/**
 * Universal Deal Dossier Service
 * Canonical data hydration layer for P0 Deal Dossier.
 */
import { supabase } from '../supabase/client.js'
import { DEAL_DOSSIER_SCHEMA } from './deal-dossier-schema.js'

// Explicit columns to avoid select('*') on heavy views
const COMMAND_COLUMNS = [
  'command_id', 'grain_key', 'property_id', 'master_owner_id', 'prospect_id', 
  'canonical_prospect_id', 'thread_key', 'contact_channel_value', 'phone_id', 'email_id',
  'full_name', 'first_name', 'language', 'gender', 'marital_status', 'education_model',
  'occupation_group', 'occupation_code', 'estimated_household_income', 'net_asset_value',
  'buying_power', 'calculated_age', 'matching_flags', 'person_flags_text',
  'sms_eligible', 'email_eligible', 'best_phone', 'best_email', 'contact_window', 'timezone',
  'property_address_full', 'market', 'property_type', 'estimated_value', 'equity_amount',
  'equity_percent', 'total_loan_balance', 'total_loan_payment', 'tax_amount', 'sale_date',
  'sale_price', 'units_count', 'tax_delinquent', 'tax_delinquent_year', 'active_lien',
  'ownership_years', 'building_square_feet', 'year_built', 'total_baths', 'total_bedrooms',
  'lot_acreage', 'lot_square_feet', 'latitude', 'longitude', 'building_condition',
  'building_quality', 'rehab_level', 'universal_status', 'universal_stage', 'reply_intent',
  'latest_message_body', 'latest_message_at', 'next_action', 'ai_summary', 'ai_next_action',
  'seller_asking_price', 'offer_price', 'pipeline_stage',
  'property_entity', 'master_owner_entity', 'prospect_entity', 'phone_entity', 'email_entity',
  'thread_entity', 'pipeline_summary', 'universal_state', 'contact_threads'
].join(',')

function asArray(value, nestedKey = null) {
  if (Array.isArray(value)) return value
  if (nestedKey && Array.isArray(value?.[nestedKey])) return value[nestedKey]
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.rows)) return value.rows
  if (Array.isArray(value?.data)) return value.data
  return []
}

function getContactThreads(command) {
  return asArray(command?.contact_threads, 'threads')
}

/**
 * Fetches and normalizes all data for a Deal Dossier.
 */
export async function getUniversalDealDossier({
  thread_key,
  property_id,
  prospect_id,
  master_owner_id,
  canonical_e164,
  phone_number_id,
  debug = false,
  abortSignal
}) {
  let resolved_property_id = property_id
  let resolved_prospect_id = prospect_id
  let resolved_master_owner_id = master_owner_id
  let resolved_canonical_e164 = canonical_e164

  // 1. Identity Resolution
  if (thread_key && !thread_key.includes('|') && (!resolved_property_id || !resolved_prospect_id || !resolved_canonical_e164)) {
    let query = supabase
      .from('inbox_thread_state')
      .select('property_id, master_owner_id, prospect_id, canonical_e164, seller_phone')
      .eq('thread_key', thread_key)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data: threadState } = await query.maybeSingle()

    if (threadState) {
      resolved_property_id = resolved_property_id || threadState.property_id
      resolved_master_owner_id = resolved_master_owner_id || threadState.master_owner_id
      resolved_prospect_id = resolved_prospect_id || threadState.prospect_id
      resolved_canonical_e164 = resolved_canonical_e164 || threadState.canonical_e164 || threadState.seller_phone
    }
  }

  // 2. Fetch from v_universal_lead_command
  let command = null
  if (resolved_property_id && resolved_prospect_id && resolved_canonical_e164) {
    let query = supabase.from('v_universal_lead_command').select(COMMAND_COLUMNS)
      .eq('property_id', resolved_property_id)
      .eq('prospect_id', resolved_prospect_id)
      .eq('contact_channel_value', resolved_canonical_e164)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data } = await query.maybeSingle()
    command = data
  }

  if (!command && resolved_property_id && resolved_canonical_e164) {
    let query = supabase.from('v_universal_lead_command').select(COMMAND_COLUMNS)
      .eq('property_id', resolved_property_id)
      .eq('contact_channel_value', resolved_canonical_e164)
      .limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data } = await query.maybeSingle()
    command = data
  }

  if (!command && thread_key) {
    let query = supabase.from('v_universal_lead_command').select(COMMAND_COLUMNS)
      .eq('thread_key', thread_key).limit(1)
    if (abortSignal) query = query.abortSignal(abortSignal)
    const { data } = await query.maybeSingle()
    command = data
  }

  // 3. Aggregate Enrichment
  let census = null
  let buyer = null
  let suppressions = []
  let acquisition = null

  if (command?.property_id || resolved_property_id) {
    const targetPropId = command?.property_id || resolved_property_id
    
    // Census
    let censusQuery = supabase
      .from('census_geo_metrics')
      .select('zip, median_household_income, vacancy_rate, renter_occupied_percent, owner_occupied_percent, median_gross_rent, median_home_value, population_density, median_age')
      .eq('zip', command?.property_address_zip || command?.property_entity?.property_address_zip || '')
    if (abortSignal) censusQuery = censusQuery.abortSignal(abortSignal)
    const { data: censusData } = await censusQuery.maybeSingle()
    census = censusData || { status: 'missing', missing_reason: 'no_census_geo_metrics_row' }

    // Buyer Match
    let runQuery = supabase
      .from('buyer_match_runs')
      .select('buyer_match_run_id, total_matches, buyer_pressure, institutional_score, status, created_at')
      .eq('property_id', targetPropId)
      .order('created_at', { ascending: false })
      .limit(1)
    if (abortSignal) runQuery = runQuery.abortSignal(abortSignal)
    const { data: run } = await runQuery.maybeSingle()

    if (run) {
      let cQuery = supabase
        .from('buyer_match_candidates')
        .select('buyer_name, buyer_type, match_score, match_reason, recent_buys, avg_buy_price, max_buy_price, last_buy_at')
        .eq('buyer_match_run_id', run.buyer_match_run_id)
        .order('match_score', { ascending: false })
        .limit(10)
      if (abortSignal) cQuery = cQuery.abortSignal(abortSignal)
      const { data: candidates } = await cQuery

      buyer = {
        buyer_count: run.total_matches || 0,
        high_fit_count: candidates?.filter(c => c.match_score >= 80).length || 0,
        demand_score: run.buyer_pressure || 0,
        top_candidates: candidates || [],
        run_status: run.status || 'completed'
      }
    }

    // Acquisition Decision
    let acqQuery = supabase
      .from('property_acquisition_scores')
      .select('best_strategy, confidence, aos_score, valuation_high, recommended_cash_offer, expected_assignment_fee, evidence, recommended_conversation_angle, computed_at')
      .eq('property_id', targetPropId)
    if (abortSignal) acqQuery = acqQuery.abortSignal(abortSignal)
    const { data: score } = await acqQuery.maybeSingle()
    
    if (score) {
      acquisition = {
        status: 'available',
        source: 'property_acquisition_scores',
        recommended_strategy: score.best_strategy,
        strategy_label: score.best_strategy,
        confidence_score: score.confidence,
        acquisition_score: score.aos_score,
        max_allowable_offer: score.valuation_high,
        suggested_offer: score.recommended_cash_offer,
        expected_spread: score.expected_assignment_fee,
        risk_flags: score.evidence?.risks || [],
        reasoning_summary: score.recommended_conversation_angle,
        updated_at: score.computed_at
      }
    }
  }

  if (resolved_canonical_e164) {
    let suppQuery = supabase
      .from('sms_suppression_list')
      .select('phone_number, reason, suppressed_at, suppression_type')
      .eq('phone_number', resolved_canonical_e164)
    if (abortSignal) suppQuery = suppQuery.abortSignal(abortSignal)
    const { data: smsSupp } = await suppQuery
    if (smsSupp) suppressions.push(...smsSupp)
  }

  // 4. Construct Universal Deal Dossier Contract
  const contactThreads = getContactThreads(command)

  const dossier = {
    identity: {
      thread_key: command?.thread_key || thread_key,
      property_id: command?.property_id || resolved_property_id,
      prospect_id: command?.prospect_id || resolved_prospect_id,
      master_owner_id: command?.master_owner_id || resolved_master_owner_id,
      canonical_e164: command?.contact_channel_value || resolved_canonical_e164
    },
    property: {
      property_id: command?.property_id || resolved_property_id,
      parcel_id: command?.property_entity?.parcel_id || command?.apn_parcel_id,
      full_address: command?.property_address_full,
      street: command?.property_entity?.property_address,
      city: command?.property_address_city,
      state: command?.property_address_state,
      zip: command?.property_address_zip,
      county: command?.property_address_county_name,
      latitude: command?.latitude,
      longitude: command?.longitude,
      market: command?.market,
      property_type: command?.property_type,
      property_class: command?.property_class,
      beds: command?.total_bedrooms,
      baths: command?.total_baths,
      sqft: command?.building_square_feet,
      lot_acreage: command?.lot_acreage,
      lot_square_feet: command?.lot_square_feet,
      units_count: command?.units_count,
      year_built: command?.year_built,
      effective_year_built: command?.effective_year_built,
      stories: command?.stories,
      sum_buildings_nbr: command?.sum_buildings,
      construction_type: command?.construction_type,
      exterior_walls: command?.exterior_walls,
      floor_cover: command?.floor_cover,
      basement: command?.basement,
      air_conditioning: command?.air_conditioning,
      heating_type: command?.heating_type,
      roof_cover: command?.roof_cover,
      zoning: command?.zoning,
      flood_zone: command?.flood_zone,
      building_condition: command?.building_condition,
      building_quality: command?.building_quality,
      rehab_level: command?.rehab_level,
      missing_fields: []
    },
    prospect: {
      prospect_id: command?.prospect_id,
      full_name: command?.full_name,
      first_name: command?.first_name,
      age: command?.calculated_age,
      marital_status: command?.marital_status,
      gender: command?.gender,
      language: command?.language,
      education_model: command?.education_model,
      est_household_income: command?.estimated_household_income,
      net_asset_value: command?.net_asset_value,
      buying_power: command?.buying_power,
      occupation_group: command?.occupation_group,
      phone_carrier: command?.phone_entity?.phone_carrier || command?.phone_carrier,
      prospect_best_phone: command?.best_phone,
      prospect_best_email: command?.best_email,
      sms_eligible: command?.sms_eligible,
      email_eligible: command?.email_eligible,
      matching_flags: command?.matching_flags,
      person_flags_text: command?.person_flags_text,
      motivation_score: command?.structured_motivation_score,
      urgency_score: command?.urgency_score,
      financial_pressure_score: command?.financial_pressure_score,
      missing_fields: []
    },
    master_owner: {
      master_owner_id: command?.master_owner_id,
      full_name: command?.master_owner_entity?.display_name || command?.display_name,
      owner_type: command?.owner_type_guess,
      primary_owner_address: command?.primary_owner_address,
      absentee_owner: command?.master_owner_entity?.absentee_owner || (command?.ownership_years && !command?.property_entity?.is_owner_occupied),
      ownership_years: command?.ownership_years,
      portfolio_total_units: command?.portfolio_total_units,
      portfolio_total_value: command?.portfolio_total_value,
      portfolio_total_equity: command?.portfolio_total_equity,
      tax_delinquent_count: command?.tax_delinquent_count,
      active_lien_count: command?.active_lien_count,
      missing_fields: []
    },
    phones: contactThreads.filter(t => t?.channel === 'phone'),
    primary_phone: {
      canonical_e164: command?.contact_channel_value,
      phone_type: command?.phone_entity?.line_type,
      phone_carrier: command?.phone_entity?.phone_carrier,
      sms_eligible: command?.sms_eligible,
      dnc_status: command?.do_not_contact,
      suppression_status: command?.is_suppressed
    },
    emails: contactThreads.filter(t => t?.channel === 'email'),
    primary_email: {
      email: command?.best_email,
      email_eligible: command?.email_eligible
    },
    conversation: {
      thread_key: command?.thread_key,
      conversation_stage: command?.universal_stage,
      inbox_status: command?.inbox_bucket,
      seller_intent: command?.reply_intent,
      latest_message_body: command?.latest_message_body,
      latest_message_at: command?.latest_message_at,
      ai_summary: command?.ai_summary,
      next_best_action: command?.next_action
    },
    deal_status: {
      seller_asking_price: command?.seller_asking_price,
      offer_price: command?.offer_price,
      pipeline_stage: command?.pipeline_stage,
      universal_status: command?.universal_status
    },
    valuation: {
      estimated_value: command?.estimated_value,
      equity_amount: command?.equity_amount,
      equity_percent: command?.equity_percent,
      total_loan_balance: command?.total_loan_balance,
      tax_amount: command?.tax_amount
    },
    buyer_match: buyer || { status: 'missing' },
    census: census,
    acquisition_decision: acquisition || { status: 'missing' },
    compliance: {
      suppressions: suppressions,
      is_suppressed: command?.is_suppressed,
      dnc: command?.do_not_contact
    },
    freshness: {
      command_updated_at: command?.command_updated_at,
      latest_message_at: command?.latest_message_at
    },
    _metadata: DEAL_DOSSIER_SCHEMA
  }

  if (debug) {
    dossier.raw_sources_debug = {
      command_raw: command,
      diagnostics: {
        resolved_property_id,
        resolved_prospect_id,
        resolved_master_owner_id,
        resolved_canonical_e164
      }
    }
  }

  return dossier
}
