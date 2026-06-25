import type { CompCandidateEvidence } from '../../../domain/comp-intelligence/types'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { isValidCoord } from '../utils/mapGeo'

function candidateKey(candidate: CompCandidateEvidence): string {
  return String(candidate.comp_property_id || candidate.property_id || '')
}

export function enrichEvidenceWithDiscoveryCoordinates(
  evidence: CompTransactionEvidence[],
  candidates: CompCandidateEvidence[] = [],
): CompTransactionEvidence[] {
  const byId = new Map<string, CompCandidateEvidence>()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (key) byId.set(key, candidate)
  }

  return evidence.map((row) => {
    const key = String(row.candidate_id || row.property_id || '')
    const candidate = key ? byId.get(key) : undefined
    const lat = row.geography.latitude ?? candidate?.latitude ?? null
    const lng = row.geography.longitude ?? candidate?.longitude ?? null
    const distance = row.geography.distance_miles ?? candidate?.distance_miles ?? null

    return {
      ...row,
      geography: {
        ...row.geography,
        latitude: lat,
        longitude: lng,
        distance_miles: distance,
      },
    }
  })
}

export function discoveryFallbackEvidence(candidates: CompCandidateEvidence[] = []): CompTransactionEvidence[] {
  return candidates.map((candidate) => ({
    candidate_id: candidate.comp_property_id,
    source_record_id: candidate.comp_property_id,
    transaction_cluster_id: null,
    property_id: candidate.property_id ?? null,
    address: candidate.address ?? null,
    canonical_asset_lane: candidate.asset_type ?? null,
    sale_price: candidate.sale_list_price ?? candidate.sold_price ?? null,
    sale_date: candidate.sale_list_date ?? candidate.sold_date ?? null,
    buyer: null,
    buyer_archetype: null,
    transaction_channel: candidate.source ?? null,
    evidence_role: candidate.selected && !candidate.excluded ? 'PRICING_EVIDENCE' : 'CONTEXT_ONLY',
    routed_universe: null,
    pricing_eligibility: Boolean(candidate.selected && !candidate.excluded && candidate.sale_list_price),
    demand_eligibility: false,
    package_probability: null,
    parcel_count: null,
    raw_row_count: 1,
    peer_classification: null,
    qualification_score: candidate.similarity_score ?? null,
    similarity: candidate.similarity_score ?? null,
    recency: candidate.sale_list_date ?? null,
    geography: {
      distance_miles: candidate.distance_miles ?? null,
      zip: candidate.zip ?? null,
      city: candidate.city ?? null,
      state: candidate.state ?? null,
      latitude: candidate.latitude ?? null,
      longitude: candidate.longitude ?? null,
    },
    independence_weight: null,
    ess_contribution: null,
    rejection_review_reasons: candidate.exclusion_reasons ?? [],
    source_lineage: {
      source_table: 'discovery_candidate',
      source_record_id: candidate.comp_property_id,
      identity_unresolved: true,
      source_completeness: null,
      channel_reasons: [],
    },
    evidence_list_role: candidate.excluded ? 'rejected' : 'accepted',
    qualification_status: candidate.excluded ? 'REJECTED' : 'ACCEPTED',
  }))
}

export function mergeMapEvidence(
  transactionEvidence: CompTransactionEvidence[],
  candidates: CompCandidateEvidence[] = [],
): CompTransactionEvidence[] {
  if (transactionEvidence.length) {
    return enrichEvidenceWithDiscoveryCoordinates(transactionEvidence, candidates)
  }
  return discoveryFallbackEvidence(candidates)
}

export function evidenceWithValidCoordinates(rows: CompTransactionEvidence[]): CompTransactionEvidence[] {
  return rows.filter((row) => isValidCoord(row.geography.latitude, row.geography.longitude))
}

export function filterEvidenceByMapMode(
  rows: CompTransactionEvidence[],
  mapMode: 'PRICING' | 'DEMAND' | 'RISK',
): CompTransactionEvidence[] {
  if (mapMode === 'PRICING') {
    return rows.filter((row) => row.pricing_eligibility === true)
  }
  if (mapMode === 'DEMAND') {
    return rows.filter((row) =>
      row.demand_eligibility === true
      || (row.package_probability != null && row.package_probability > 0.5)
      || (/demand|institutional|package/i.test(row.evidence_role || '')),
    )
  }
  return rows.filter((row) =>
    row.qualification_status === 'REJECTED'
    || row.qualification_status === 'QUARANTINED'
    || (row.rejection_review_reasons?.length ?? 0) > 0,
  )
}