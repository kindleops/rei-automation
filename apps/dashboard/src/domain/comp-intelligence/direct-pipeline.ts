import { loadSubjectComps } from '../../lib/data/commandMapData'
import { resolveCanonicalProperty } from '../canonical-property/resolver'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { CompCandidateEvidence, CompIntelligencePayload, CanonicalSubjectProperty } from './types'
import type { CompIntelligenceDecisionProjection } from './v3-types'

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
    latitude: Number(row.latitude) || null,
    longitude: Number(row.longitude) || null,
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
    similarity_score: Number(row.similarity_score) || null,
    comp_match_label: 'Evidence only',
    selected: false,
    excluded: true,
    exclusion_reasons: ['V3 decision evidence unavailable — evidence-only degraded mode'],
    scoring: {
      score: Number(row.similarity_score) || 0,
      label: 'Evidence only',
      reasoning: {},
      auto_included: false,
      auto_excluded: true,
      exclusion_reasons: ['EVIDENCE_ONLY_DEGRADED'],
    },
  }
}

function buildDegradedProjection(): CompIntelligenceDecisionProjection {
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
  }
}

export async function runDirectCompIntelligence({
  dealContext,
  thread,
  radius = 3,
  monthsBack = 12,
  opportunityId = null,
}: {
  dealContext?: DealContext | null
  thread?: InboxWorkflowThread | null
  radius?: number
  monthsBack?: number
  opportunityId?: string | null
}): Promise<CompIntelligencePayload | null> {
  const canonical = resolveCanonicalProperty({ dealContext, thread, opportunityId })
  if (!canonical) return null

  const subject = toCanonicalSubject(canonical)
  if (!canonical.is_subject_resolved || canonical.latitude === null || canonical.longitude === null) {
    return {
      subject,
      data_source_mode: 'EVIDENCE_ONLY_DEGRADED',
      decision_projection: buildDegradedProjection(),
      transaction_evidence: [],
      discovery: {
        search_mode: 'blocked_unresolved_subject',
        is_market_fallback: false,
        relaxations: [],
        candidates: [],
        included: [],
        excluded: [],
        counts: { total: 0, included: 0, excluded: 0 },
      },
      legacy_valuation: {
        model_version: 'comp_intelligence_direct_v1',
        arv: null,
        as_is_value: null,
        repair_estimate: null,
        confidence: 0,
        data_gaps: ['subject_coordinates_unresolved'],
        warnings: [canonical.coordinate_failure_reason || 'Subject coordinates unresolved'],
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
        data_gaps: ['subject_coordinates_unresolved'],
        warnings: [canonical.coordinate_failure_reason || 'Subject coordinates unresolved'],
        outputs: {},
      },
      valuation_state: {
        state: 'blocked_missing_subject',
        label: 'Blocked: subject coordinates unresolved',
        detail: canonical.coordinate_failure_reason || 'Exact parcel coordinates required',
      },
    }
  }

  const rows = await loadSubjectComps(canonical.property_id, radius, monthsBack, 100)
  const candidates = rows.map((row, index) =>
    mapRpcRow(row as unknown as Record<string, unknown>, index),
  )

  return {
    subject,
    data_source_mode: 'EVIDENCE_ONLY_DEGRADED',
    decision_projection: buildDegradedProjection(),
    transaction_evidence: candidates.map((c) => ({
      candidate_id: c.comp_property_id,
      source_record_id: c.comp_property_id,
      transaction_cluster_id: null,
      property_id: c.property_id ?? null,
      address: c.address ?? null,
      canonical_asset_lane: c.asset_type ?? null,
      sale_price: c.sale_list_price ?? null,
      sale_date: c.sale_list_date ?? null,
      buyer: null,
      buyer_archetype: null,
      transaction_channel: c.source ?? null,
      evidence_role: 'CONTEXT_ONLY',
      routed_universe: null,
      pricing_eligibility: false,
      demand_eligibility: false,
      package_probability: null,
      parcel_count: null,
      raw_row_count: 1,
      peer_classification: null,
      qualification_score: c.similarity_score ?? null,
      similarity: c.similarity_score ?? null,
      recency: c.sale_list_date ?? null,
      geography: {
        distance_miles: c.distance_miles ?? null,
        zip: c.zip ?? null,
        city: c.city ?? null,
        state: c.state ?? null,
        latitude: c.latitude ?? null,
        longitude: c.longitude ?? null,
      },
      independence_weight: null,
      ess_contribution: null,
      rejection_review_reasons: c.exclusion_reasons ?? [],
      source_lineage: {
        source_table: 'direct_rpc',
        source_record_id: c.comp_property_id,
        identity_unresolved: true,
        source_completeness: null,
        channel_reasons: ['EVIDENCE_ONLY_DEGRADED'],
      },
      evidence_list_role: 'rejected',
      qualification_status: 'EVIDENCE_ONLY',
    })),
    discovery: {
      search_mode: 'direct_rpc_evidence_only',
      is_market_fallback: false,
      relaxations: [{ step: 'direct_rpc_degraded', radius_miles: radius, months_back: monthsBack, result_count: candidates.length }],
      candidates,
      included: [],
      excluded: candidates,
      counts: {
        total: candidates.length,
        included: 0,
        excluded: candidates.length,
      },
    },
    legacy_valuation: {
      model_version: 'comp_intelligence_direct_v1',
      arv: null,
      as_is_value: null,
      repair_estimate: null,
      confidence: 0,
      data_gaps: ['v3_decision_unavailable'],
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
      data_gaps: ['v3_decision_unavailable'],
      warnings: ['Direct RPC fallback cannot produce authoritative valuation'],
      outputs: {},
    },
    valuation_state: {
      state: 'blocked_insufficient_evidence',
      label: 'V3 decision evidence unavailable',
      detail: 'Direct RPC recovered subject and candidate evidence only — no authoritative valuation or offer',
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