import { mapCandidateToDegradedEvidence } from '../../../domain/comp-intelligence/degraded-evidence'
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
  return candidates.map((candidate) => mapCandidateToDegradedEvidence(candidate, 'API_DISCOVERY'))
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

function isDisplayEligible(row: CompTransactionEvidence): boolean {
  if (row.display_eligible === true) return true
  if (row.evidence_authority === 'DEGRADED_NON_AUTHORITATIVE') {
    return row.sale_price != null && isValidCoord(row.geography.latitude, row.geography.longitude)
  }
  return row.pricing_eligibility === true
}

export function filterEvidenceByMapMode(
  rows: CompTransactionEvidence[],
  mapMode: 'PRICING' | 'DEMAND' | 'RISK',
): CompTransactionEvidence[] {
  if (mapMode === 'PRICING') {
    return rows.filter((row) => isDisplayEligible(row))
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