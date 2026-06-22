import { loadSubjectComps } from '../../lib/data/commandMapData'
import { resolveCanonicalProperty } from '../canonical-property/resolver'
import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { CompCandidateEvidence, CompIntelligencePayload, CanonicalSubjectProperty } from './types'

const INCLUSION_THRESHOLD = 45
const AUTO_INCLUDE_MIN = 2
const AUTO_INCLUDE_MAX = 6

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
    condition: evidenceString(null, 'properties.building_condition'),
    estimated_value: evidenceNumber(null, 'properties.estimated_value'),
    contract_version: 'comp_intelligence_subject_v1',
  }
}

function scoreComp(comp: Record<string, unknown>, subject: ReturnType<typeof resolveCanonicalProperty>) {
  let score = Number(comp.similarity_score) || 0
  if (!score) {
    const dist = Number(comp.distance_miles) || 99
    if (dist <= 1) score += 20
    else if (dist <= 3) score += 12
    else score += 6
    if (comp.sale_price || comp.mls_sold_price) score += 20
    if (comp.building_square_feet && subject?.square_feet) score += 10
  }
  return Math.min(100, Math.round(score))
}

function mapRpcRow(row: Record<string, unknown>, index: number, subject: NonNullable<ReturnType<typeof resolveCanonicalProperty>>): CompCandidateEvidence {
  const soldPrice = Number(row.mls_sold_price || row.sale_price || 0) || null
  const soldDate = String(row.mls_sold_date || row.sale_date || '') || null
  const score = scoreComp(row, subject)
  const hasPrice = soldPrice !== null && soldPrice > 0
  const autoIncluded = hasPrice && score >= INCLUSION_THRESHOLD
  const exclusionReasons: string[] = []
  if (!hasPrice) exclusionReasons.push('Missing sale price')
  if (score < INCLUSION_THRESHOLD) exclusionReasons.push('Similarity below inclusion threshold')

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
    similarity_score: score,
    comp_match_label: score >= 80 ? 'Strong Match' : score >= 55 ? 'Usable Match' : 'Review',
    selected: autoIncluded,
    excluded: !autoIncluded,
    exclusion_reasons: exclusionReasons,
    scoring: {
      score,
      label: score >= 80 ? 'Strong Match' : 'Usable Match',
      reasoning: {},
      auto_included: autoIncluded,
      auto_excluded: !autoIncluded,
      exclusion_reasons: exclusionReasons,
    },
  }
}

function autoIncludeStrongest(candidates: CompCandidateEvidence[]): CompCandidateEvidence[] {
  const ranked = [...candidates]
    .filter(c => (c.sale_list_price ?? c.sold_price) && (c.latitude || c.longitude))
    .sort((a, b) => (b.similarity_score ?? 0) - (a.similarity_score ?? 0))

  const target = Math.min(AUTO_INCLUDE_MAX, Math.max(AUTO_INCLUDE_MIN, Math.ceil(ranked.length * 0.4)))
  const includeIds = new Set(ranked.slice(0, target).map(c => c.comp_property_id))

  return candidates.map(c => {
    const forceInclude = includeIds.has(c.comp_property_id)
    if (!forceInclude) return c
    return {
      ...c,
      selected: true,
      excluded: false,
      exclusion_reasons: (c.exclusion_reasons ?? []).filter(r => r !== 'Similarity below inclusion threshold'),
      scoring: c.scoring
        ? { ...c.scoring, auto_included: true, auto_excluded: false }
        : c.scoring,
    }
  })
}

function computeValuation(subject: CanonicalSubjectProperty, included: CompCandidateEvidence[]) {
  const sqft = subject.square_feet?.value ?? null
  const prices = included.map(c => c.sale_list_price ?? c.sold_price ?? 0).filter(p => p > 0)
  const ppsfValues = included.map(c => c.ppsf ?? 0).filter(p => p > 0)
  const medianPpsf = ppsfValues.length
    ? ppsfValues.sort((a, b) => a - b)[Math.floor(ppsfValues.length / 2)]
    : null

  let arv: number | null = null
  if (sqft && medianPpsf) arv = Math.round((medianPpsf * sqft) / 1000) * 1000
  else if (prices.length) arv = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length / 1000) * 1000

  const confidence = included.length >= 3 ? 72 : included.length >= 1 ? 55 : 0
  const repairEstimate = sqft ? sqft * 20 : null

  return {
    model_version: 'comp_intelligence_direct_v1',
    arv,
    as_is_value: arv ? Math.round(arv * 0.82) : null,
    repair_estimate: repairEstimate,
    confidence,
    data_gaps: sqft ? [] : ['subject_square_feet_missing'],
    warnings: included.length ? [] : ['No included comps for ARV'],
    outputs: {
      retail_ceiling: { value: prices.length ? Math.max(...prices) : null },
      investor_reality: { value: arv ? Math.round(arv * 0.85) : null },
      target_offer: { value: arv && repairEstimate ? Math.round(arv * 0.7 - repairEstimate) : null },
      max_allowable_offer: { value: arv && repairEstimate ? Math.round(arv * 0.75 - repairEstimate) : null },
      weighted_ppsf: { value: medianPpsf },
    },
    supporting_comp_ids: included.map(c => c.comp_property_id),
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
      discovery: {
        search_mode: 'blocked_unresolved_subject',
        is_market_fallback: false,
        relaxations: [],
        candidates: [],
        included: [],
        excluded: [],
        counts: { total: 0, included: 0, excluded: 0 },
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
  let candidates = rows.map((row, index) =>
    mapRpcRow(row as unknown as Record<string, unknown>, index, canonical),
  )
  candidates = autoIncludeStrongest(candidates)

  const included = candidates.filter(c => c.selected && !c.excluded)
  const excluded = candidates.filter(c => c.excluded)
  const valuation = computeValuation(subject, included)

  return {
    subject,
    discovery: {
      search_mode: 'subject_radius',
      is_market_fallback: false,
      relaxations: [{ step: 'direct_rpc', radius_miles: radius, months_back: monthsBack, result_count: candidates.length }],
      candidates,
      included,
      excluded,
      counts: {
        total: candidates.length,
        included: included.length,
        excluded: excluded.length,
      },
    },
    valuation,
    valuation_state: {
      state: valuation.arv ? (valuation.data_gaps.length ? 'ready_with_limitations' : 'ready') : 'blocked_insufficient_evidence',
      label: valuation.arv ? 'Ready' : 'Blocked: insufficient evidence',
      detail: valuation.arv ? undefined : 'No qualifying comps after automated selection',
    },
  }
}