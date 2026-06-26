import { loadSubjectComps, loadMarketComps } from '../../lib/data/commandMapData'
import { resolveCanonicalProperty } from '../canonical-property/resolver'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { AnyRecord } from '../../lib/data/shared'
import { mapCandidatesToDegradedEvidence } from './degraded-evidence'
import { fetchPropertyRecord } from './property-record-loader'
import type { CompCandidateEvidence, CompIntelligencePayload, CanonicalSubjectProperty } from './types'
import type { CompIntelligenceDecisionProjection } from './v3-types'

export const COMP_SEARCH_EXPANSION_STEPS = [
  { radius: 0.25, monthsBack: 6, label: 'radius_0.25mi_6mo', confidencePenalty: 0 },
  { radius: 0.5, monthsBack: 6, label: 'strict_nearby', confidencePenalty: 0 },
  { radius: 1, monthsBack: 6, label: 'radius_1mi_6mo', confidencePenalty: 2 },
  { radius: 1, monthsBack: 12, label: 'radius_1mi_12mo', confidencePenalty: 5 },
  { radius: 1.5, monthsBack: 12, label: 'radius_1.5mi_12mo', confidencePenalty: 6 },
  { radius: 3, monthsBack: 12, label: 'radius_3mi_12mo', confidencePenalty: 8 },
  { radius: 5, monthsBack: 24, label: 'radius_5mi_24mo', confidencePenalty: 14 },
] as const

export type CompSearchExpansionStep = (typeof COMP_SEARCH_EXPANSION_STEPS)[number]

export function getNextExpansionStep(
  radius: number,
  monthsBack: number,
): CompSearchExpansionStep | null {
  const idx = COMP_SEARCH_EXPANSION_STEPS.findIndex(
    (step) => step.radius === radius && step.monthsBack === monthsBack,
  )
  const nextIdx = idx >= 0 ? idx + 1 : COMP_SEARCH_EXPANSION_STEPS.findIndex((step) => step.radius > radius || step.monthsBack > monthsBack)
  if (nextIdx < 0 || nextIdx >= COMP_SEARCH_EXPANSION_STEPS.length) return null
  return COMP_SEARCH_EXPANSION_STEPS[nextIdx]
}

function evidenceNumber(value: number | null, source: string) {
  return {
    value,
    source,
    present: value !== null,
    missing_reason: value === null ? 'not_available' : null,
  }
}

function evidenceString(value: string | null, source: string) {
  return {
    value,
    source,
    present: Boolean(value),
    missing_reason: value ? null : 'not_available',
  }
}

function toCanonicalSubject(
  canonical: NonNullable<ReturnType<typeof resolveCanonicalProperty>>,
): CanonicalSubjectProperty {
  return {
    property_id: canonical.property_id,
    source_property_id: canonical.source_property_id,
    parcel_apn: evidenceString(canonical.apn, 'properties.apn_parcel_id'),
    canonical_address: evidenceString(canonical.display_address, 'properties.property_address_full'),
    normalized_address: evidenceString(canonical.normalized_address, 'properties.property_address_full'),
    owner_id: evidenceString(canonical.owner_id, 'properties.master_owner_id'),
    master_owner_id: evidenceString(canonical.master_owner_id, 'properties.master_owner_id'),
    opportunity_id: evidenceString(canonical.opportunity_id, 'universal_entity_context'),
    thread_key: evidenceString(canonical.thread_key, 'universal_entity_context'),
    asset_type: evidenceString(canonical.asset_type, 'properties.normalized_asset_class'),
    units: evidenceNumber(canonical.units, 'properties.units_count'),
    latitude: evidenceNumber(canonical.latitude, canonical.coordinate_source),
    longitude: evidenceNumber(canonical.longitude, canonical.coordinate_source),
    coordinate_source: canonical.coordinate_source,
    coordinate_confidence: canonical.coordinate_confidence,
    is_market_fallback: canonical.is_market_fallback,
    is_subject_resolved: canonical.is_subject_resolved,
    coordinate_failure_reason: canonical.coordinate_failure_reason,
    market: evidenceString(canonical.market, 'properties.market'),
    county: evidenceString(canonical.county, 'properties.property_address_county_name'),
    state: evidenceString(canonical.state, 'properties.property_address_state'),
    zip: evidenceString(canonical.zip, 'properties.property_address_zip'),
    city: evidenceString(canonical.city, 'properties.property_address_city'),
    property_type: evidenceString(canonical.property_type, 'properties.property_type'),
    bedrooms: evidenceNumber(canonical.bedrooms, 'properties.total_bedrooms'),
    bathrooms: evidenceNumber(canonical.bathrooms, 'properties.total_baths'),
    square_feet: evidenceNumber(canonical.square_feet, 'properties.building_square_feet'),
    year_built: evidenceNumber(canonical.year_built, 'properties.year_built'),
    lot_square_feet: evidenceNumber(canonical.lot_square_feet, 'properties.lot_square_feet'),
    condition: evidenceString(null, 'properties.building_condition'),
    estimated_value: evidenceNumber(null, 'properties.estimated_value'),
    contract_version: 'comp_intelligence_subject_v1',
  }
}

function mapRpcRow(
  row: Record<string, unknown>,
  index: number,
): CompCandidateEvidence {
  const soldPrice = Number(row.mls_sold_price || row.sale_price || 0) || null
  const soldDate = String(row.mls_sold_date || row.sale_date || '') || null
  const lat = Number(row.latitude) || null
  const lng = Number(row.longitude) || null

  return {
    comp_property_id: String(row.property_id || row.comp_id || `comp-${index}`),
    property_id: String(row.property_id || ''),
    source: row.mls_sold_price ? 'MLS SOLD' : 'PUBLIC RECORD SOLD',
    sale_list_price: soldPrice,
    sale_list_date: soldDate,
    sold_price: soldPrice,
    sold_date: soldDate,
    sold_source: row.mls_sold_price ? 'MLS SOLD' : 'PUBLIC RECORD SOLD',
    distance_miles: Number(row.distance_miles) || null,
    latitude: lat && Math.abs(lat) > 0.0001 ? lat : null,
    longitude: lng && Math.abs(lng) > 0.0001 ? lng : null,
    asset_type: String(row.asset_class || row.normalized_asset_class || row.property_type || 'single_family'),
    units: Number(row.units_count) || null,
    bedrooms: Number(row.total_bedrooms || row.beds) || null,
    bathrooms: Number(row.total_baths || row.baths) || null,
    square_feet: Number(row.building_square_feet || row.sqft) || null,
    ppsf: Number(row.computed_ppsf || row.ppsf) || null,
    ppu: Number(row.ppu) || null,
    address: String(row.property_address_full || row.address || ''),
    city: String(row.property_address_city || row.city || ''),
    state: String(row.property_address_state || row.state || ''),
    zip: String(row.property_address_zip || row.zip || ''),
    year_built: Number(row.year_built) || null,
    lot_square_feet: Number(row.lot_square_feet) || null,
    property_type: String(row.property_type || row.normalized_asset_class || row.asset_class || '') || null,
    similarity_score: Number(row.similarity_score) || null,
    comp_match_label: 'Recovered evidence',
    selected: true,
    excluded: false,
    exclusion_reasons: [],
    scoring: {
      score: Number(row.similarity_score) || 0,
      label: 'Recovered evidence',
      reasoning: {},
      auto_included: true,
      auto_excluded: false,
      exclusion_reasons: [],
    },
  }
}

function buildDegradedProjection(candidateCount: number): CompIntelligenceDecisionProjection {
  return {
    engine_version: 'acquisition_decision_engine_v3',
    formula_version: 'degraded',
    v3_enabled: true,
    canonical_asset_lane: null,
    asset_lane_confidence: null,
    execution_state: 'EVIDENCE_ONLY_DEGRADED',
    value_classification: 'UNAVAILABLE',
    final_confidence: 0,
    dominant_model_universe: null,
    dominant_model_ess: null,
    dominant_model_depth_score: null,
    dominant_model_confidence_cap: null,
    execution_state_basis: null,
    value_contract: {
      qualified_market_value: null,
      scenario_market_value: null,
      qualified_buyer_exit: null,
      scenario_buyer_exit: null,
    },
    offer_authorization: {
      authorized_opening_offer: null,
      authorized_recommended_offer: null,
      authorized_maximum_offer: null,
      authorized_walkaway_price: null,
      scenario_opening_offer: null,
      scenario_recommended_offer: null,
      scenario_maximum_offer: null,
      scenario_walkaway_price: null,
    },
    strategy_ranking: null,
    projection_mode: 'evidence_only_degraded',
    shadow_mode: false,
    live_authorization_enabled: false,
    recovered_evidence_count: candidateCount,
  }
}

async function discoverCandidatesExact(
  propertyId: string,
  radius: number,
  monthsBack: number,
) {
  const rows = await loadSubjectComps(propertyId, radius, monthsBack, 100)
  const candidates = rows.map((row, index) => mapRpcRow(row as unknown as Record<string, unknown>, index))
  return {
    searchMode: 'subject_radius' as const,
    relaxations: [{
      step: 'exact_radius',
      radius_miles: radius,
      months_back: monthsBack,
      result_count: candidates.length,
      confidence_penalty: 0,
    }],
    candidates,
    isMarketFallback: false,
  }
}

async function discoverCandidatesMarketFallback(
  canonical: NonNullable<ReturnType<typeof resolveCanonicalProperty>>,
  monthsBack = 12,
) {
  const market = canonical.market || undefined
  const zip = canonical.zip || undefined
  const rows = await loadMarketComps(market, zip, 100, { monthsBack })
  const candidates = rows.map((row, index) => mapRpcRow(row as unknown as Record<string, unknown>, index))
  return {
    searchMode: 'market_fallback' as const,
    relaxations: [{
      step: 'market_fallback',
      market,
      zip,
      months_back: monthsBack,
      result_count: candidates.length,
      confidence_penalty: 25,
      reason: canonical.coordinate_failure_reason ?? 'subject_coordinates_unavailable',
    }],
    candidates,
    isMarketFallback: true,
  }
}

export async function runDirectCompIntelligence({
  dealContext,
  thread,
  radius = 3,
  monthsBack = 12,
  opportunityId = null,
  propertyRecord = null,
}: {
  dealContext?: DealContext | null
  thread?: InboxWorkflowThread | null
  radius?: number
  monthsBack?: number
  opportunityId?: string | null
  propertyRecord?: AnyRecord | null
}): Promise<CompIntelligencePayload | null> {
  const hydratedRecord = propertyRecord ?? await fetchPropertyRecord(
    String(
      dealContext?.propertyId
        || dealContext?.property_id
        || (thread as Record<string, unknown> | null)?.property_id
        || '',
    ).trim(),
  )

  const canonical = resolveCanonicalProperty({
    dealContext,
    thread,
    opportunityId,
    propertyRecord: hydratedRecord,
  })
  if (!canonical) return null

  const subject = toCanonicalSubject(canonical)
  let discoveryResult = await discoverCandidatesExact(canonical.property_id, radius, monthsBack)
  if (!discoveryResult.candidates.length) {
    discoveryResult = await discoverCandidatesMarketFallback(canonical, monthsBack)
  }
  const { candidates, relaxations, searchMode, isMarketFallback } = discoveryResult
  const sourcePath = isMarketFallback ? 'MARKET_FALLBACK' as const : 'DIRECT_RPC' as const
  const transactionEvidence = mapCandidatesToDegradedEvidence(candidates, sourcePath)

  return {
    subject,
    data_source_mode: 'EVIDENCE_ONLY_DEGRADED',
    decision_projection: buildDegradedProjection(candidates.length),
    transaction_evidence: transactionEvidence,
    discovery: {
      search_mode: searchMode,
      is_market_fallback: isMarketFallback,
      relaxations,
      candidates,
      included: candidates,
      excluded: [],
      counts: {
        total: candidates.length,
        included: candidates.length,
        excluded: 0,
      },
    },
    legacy_valuation: {
      model_version: 'comp_intelligence_direct_v1',
      arv: null,
      as_is_value: null,
      repair_estimate: null,
      confidence: 0,
      data_gaps: candidates.length ? ['v3_decision_unavailable'] : ['no_comp_candidates_recovered'],
      warnings: ['Direct RPC fallback cannot produce authoritative valuation'],
      outputs: {},
      authoritative: false,
      label: 'Legacy direct valuation — not authoritative',
    },
    valuation: {
      model_version: 'comp_intelligence_direct_v1',
      arv: null,
      as_is_value: null,
      repair_estimate: null,
      confidence: 0,
      data_gaps: candidates.length ? ['v3_decision_unavailable'] : ['no_comp_candidates_recovered'],
      warnings: ['Direct RPC fallback cannot produce authoritative valuation'],
      outputs: {},
    },
    valuation_state: {
      state: candidates.length ? 'blocked_insufficient_evidence' : 'blocked_missing_subject',
      label: candidates.length
        ? 'V3 decision unavailable — recovered comp evidence'
        : 'No comp evidence recovered',
      detail: canonical.is_subject_resolved
        ? 'Subject resolved; decision projection unavailable'
        : canonical.coordinate_failure_reason || 'Subject coordinates unresolved',
    },
    projection_meta: {
      read_only: true,
      persisted: false,
      snapshot_write: false,
      event_publication: false,
      outbound_execution: false,
    },
  }
}