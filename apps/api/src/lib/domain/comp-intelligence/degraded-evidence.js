/**
 * Maps discovery candidates to non-authoritative transaction evidence when V3 projection fails.
 */

function clean(value) {
  return String(value ?? '').trim();
}

export function mapCandidateToDegradedEvidence(candidate, sourcePath = 'API_DISCOVERY') {
  const hasPrice = (candidate.sale_list_price ?? candidate.sold_price) != null;
  const lat = candidate.latitude ?? candidate.lat ?? null;
  const lng = candidate.longitude ?? candidate.lng ?? null;
  const hasCoords = lat != null && lng != null && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;
  const displayEligible = hasPrice && hasCoords;

  return {
    candidate_id: candidate.comp_property_id || candidate.property_id,
    source_record_id: candidate.comp_property_id || candidate.property_id,
    transaction_cluster_id: null,
    property_id: candidate.property_id ?? null,
    address: candidate.address ?? null,
    canonical_asset_lane: candidate.asset_type ?? null,
    sale_price: candidate.sale_list_price ?? candidate.sold_price ?? null,
    sale_date: candidate.sale_list_date ?? candidate.sold_date ?? null,
    buyer: null,
    buyer_archetype: null,
    transaction_channel: candidate.source ?? candidate.sold_source ?? null,
    evidence_role: 'DEGRADED_COMP',
    routed_universe: null,
    pricing_eligibility: false,
    demand_eligibility: false,
    package_probability: null,
    parcel_count: null,
    raw_row_count: 1,
    peer_classification: null,
    qualification_score: candidate.similarity_score ?? null,
    similarity: candidate.similarity_score ?? null,
    recency: candidate.sale_list_date ?? candidate.sold_date ?? null,
    geography: {
      distance_miles: candidate.distance_miles ?? null,
      zip: candidate.zip ?? null,
      city: candidate.city ?? null,
      state: candidate.state ?? null,
      latitude: lat,
      longitude: lng,
    },
    independence_weight: null,
    ess_contribution: 0,
    rejection_review_reasons: candidate.exclusion_reasons ?? [],
    source_lineage: {
      source_table: sourcePath === 'MARKET_FALLBACK' ? 'market_fallback' : 'discovery_candidate',
      source_record_id: clean(candidate.comp_property_id || candidate.property_id),
      identity_unresolved: true,
      source_completeness: candidate.similarity_score ?? null,
      channel_reasons: ['EVIDENCE_ONLY_DEGRADED'],
    },
    evidence_list_role: displayEligible ? 'accepted' : 'rejected',
    qualification_status: 'EVIDENCE_ONLY',
    evidence_authority: 'DEGRADED_NON_AUTHORITATIVE',
    display_eligible: displayEligible,
    source_path: sourcePath,
    square_feet: candidate.square_feet ?? null,
    bedrooms: candidate.bedrooms ?? null,
    bathrooms: candidate.bathrooms ?? null,
    units: candidate.units ?? null,
    comp_match_label: candidate.comp_match_label ?? null,
  };
}

export function mapDiscoveryToDegradedEvidence(discovery) {
  const sourcePath = discovery?.is_market_fallback ? 'MARKET_FALLBACK' : 'API_DISCOVERY';
  return (discovery?.candidates ?? []).map((candidate) =>
    mapCandidateToDegradedEvidence(candidate, sourcePath),
  );
}

export default { mapCandidateToDegradedEvidence, mapDiscoveryToDegradedEvidence };