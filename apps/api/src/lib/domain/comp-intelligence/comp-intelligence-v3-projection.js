/**
 * Comp Intelligence — read-only Acquisition Engine V3 decision projection.
 *
 * Projects the same semantics as scoreProperty / calculateAcquisitionDecision
 * without score-table writes, valuation-snapshot writes, or event publication.
 */

import {
  calculateAcquisitionDecision,
  loadComparableProperties,
  loadBuyerPurchases,
  loadSubjectProperty,
  normalizePropertyFeatures,
} from '@/lib/acquisition/acquisitionDecisionEngine.js';
import { loadV3CompCandidates } from '@/lib/acquisition/compCandidateLoader.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { readFeatureFlag } from '@/lib/acquisition/modelConstants.js';

function clean(value) {
  return String(value ?? '').trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapDecisionProjection(decision, v3Enabled) {
  const v3 = decision?.v3 ?? null;
  if (!v3) {
    return {
      engine_version: 'acquisition_decision_engine_v2',
      formula_version: '2.0.0',
      v3_enabled: false,
      execution_state: 'V3_DISABLED',
      value_classification: null,
      final_confidence: decision?.confidence ?? null,
      projection_mode: 'legacy_v2_only',
    };
  }

  return {
    engine_version: v3.engine_version,
    formula_version: v3.formula_version,
    v3_enabled: v3Enabled,
    canonical_asset_lane: v3.canonical_asset_lane,
    asset_lane_confidence: v3.asset_lane_confidence,
    asset_lane_reasoning: v3.asset_lane_reasoning,
    conflicting_asset_signals: v3.conflicting_asset_signals ?? [],
    execution_state: v3.execution_state,
    value_classification: v3.value_classification,
    final_confidence: v3.final_confidence,
    dominant_model_universe: v3.dominant_model_universe,
    dominant_model_ess: v3.dominant_model_ess,
    dominant_model_depth_score: v3.dominant_model_depth_score,
    dominant_model_confidence_cap: v3.dominant_model_confidence_cap,
    execution_state_basis: v3.execution_state_basis,
    value_contract: v3.value_contract,
    offer_authorization: v3.offer_authorization,
    strategy_ranking: v3.strategy_ranking,
    strategy_depth_gate: v3.strategy_depth_gate,
    universes: v3.universes,
    reconciliation: v3.reconciliation,
    repair: v3.repair,
    buyer_exit: v3.buyer_exit,
    cash_offer: v3.cash_offer,
    novation: v3.novation,
    subject_to: v3.subject_to,
    seller_finance: v3.seller_finance,
    residential_income: v3.residential_income,
    self_storage: v3.self_storage,
    retail: v3.retail,
    office: v3.office,
    evidence_depth: v3.evidence_depth,
    anomaly_materiality: {
      transaction_anomaly_present: v3.transaction_anomaly_present,
      transaction_anomaly_count: v3.transaction_anomaly_count,
      transaction_anomaly_material: v3.transaction_anomaly_material,
      material_anomaly_reasons: v3.material_anomaly_reasons ?? [],
      nonmaterial_warning_reasons: v3.nonmaterial_warning_reasons ?? [],
      anomaly_flags: v3.anomaly_flags ?? [],
    },
    invariants: v3.invariants,
    loader_diagnostics: v3.loader_diagnostics,
    feature_flags: v3.active_feature_flags,
    shadow_mode: v3.shadow_mode,
    sample: v3.sample,
    clusters: v3.clusters,
    primary_strategy: v3.strategy_ranking?.primary_strategy ?? null,
    backup_strategy: v3.strategy_ranking?.backup_strategy ?? null,
    model_disagreement: v3.reconciliation?.model_disagreement ?? null,
    projection_mode: 'authoritative_v3',
  };
}

function mapQualificationStatus(item, role) {
  if (!item) return 'UNKNOWN';
  if (item.redundant) return 'COLLAPSED';
  if (role === 'accepted') return 'ACCEPTED';
  const status = item.status ?? item.q?.status;
  if (status === 'ACCEPT') return 'ACCEPTED';
  if (status === 'QUARANTINE') return 'QUARANTINED';
  if (status === 'EXCLUDE') return 'REJECTED';
  if (status === 'REVIEW') return 'REVIEW';
  return String(status || 'UNKNOWN').toUpperCase();
}

function mapTransactionEvidenceFromQualification(qualification, candidates = []) {
  const candidateById = new Map();
  for (const c of candidates) {
    const key = clean(c.id || c.property_id || c.source_record_id);
    if (key) candidateById.set(key, c);
  }

  const rows = [];
  const pushRow = (item, role) => {
    const raw = item.raw ?? item.tx?.raw ?? item;
    const cid = clean(raw?.id || raw?.property_id || raw?.source_record_id || item.property_id);
    const enriched = candidateById.get(cid) ?? raw ?? {};
    const clusterId = item.cluster_id ?? item.q?.cluster_id ?? null;
    const cluster = (qualification?.clusters_summary ?? []).find((c) => c.cluster_id === clusterId);

    rows.push({
      candidate_id: cid || null,
      source_record_id: clean(enriched.source_record_id || raw?.source_record_id || raw?.id) || null,
      transaction_cluster_id: clusterId,
      property_id: clean(enriched.property_id || raw?.property_id) || null,
      address: clean(enriched.property_address_full || item.address || raw?.property_address_full) || null,
      canonical_asset_lane: enriched.canonical_asset_lane ?? item.comp_lane ?? null,
      sale_price: num(enriched.sale_price ?? item.consideration ?? raw?.sale_price),
      sale_date: enriched.sale_date ?? raw?.sale_date ?? null,
      buyer: enriched.buyer_name_clean ?? enriched.buyer_name ?? null,
      buyer_archetype: enriched.buyer_archetype ?? null,
      transaction_channel: enriched.transaction_channel ?? enriched.v3_channel ?? null,
      evidence_role: enriched.evidence_role ?? null,
      routed_universe: enriched.v3_universe_hint ?? null,
      pricing_eligibility: enriched.v3_pricing_eligible ?? null,
      demand_eligibility: enriched.v3_demand_eligible ?? null,
      package_probability: cluster?.is_package ? (cluster.package_probability ?? 1) : cluster?.is_package === false ? 0 : null,
      parcel_count: cluster?.parcel_count ?? null,
      raw_row_count: cluster?.row_count ?? null,
      peer_classification: cluster?.peer_classification ?? null,
      qualification_score: num(item.score),
      similarity: num(enriched.similarity_score ?? raw?.similarity_score),
      recency: enriched.sale_date ?? raw?.sale_date ?? null,
      geography: {
        distance_miles: num(enriched.distance_miles ?? raw?.distance_miles),
        zip: clean(enriched.property_address_zip || raw?.property_address_zip) || null,
        city: clean(enriched.property_address_city || raw?.property_address_city) || null,
        state: clean(enriched.property_address_state || raw?.property_address_state) || null,
        latitude: num(enriched.latitude ?? raw?.latitude),
        longitude: num(enriched.longitude ?? raw?.longitude),
      },
      independence_weight: cluster?.independence_weight ?? null,
      ess_contribution: cluster?.ess_contribution ?? null,
      rejection_review_reasons: (item.reasons ?? item.q?.reasons ?? [])
        .map((r) => (typeof r === 'string' ? r : r?.code))
        .filter(Boolean),
      source_lineage: {
        source_table: enriched.source_table ?? 'rpc_candidate',
        source_record_id: enriched.source_record_id ?? null,
        identity_unresolved: enriched.identity_unresolved ?? null,
        source_completeness: enriched.source_completeness ?? null,
        channel_reasons: enriched.channel_reasons ?? [],
      },
      evidence_list_role: role,
      qualification_status: mapQualificationStatus(item, role),
    });
  };

  for (const item of qualification?.accepted ?? []) {
    pushRow(item, 'accepted');
  }
  for (const item of qualification?.rejected ?? []) {
    pushRow(item, 'rejected');
  }

  return rows;
}

function derivePipelineState(projection) {
  const state = projection?.execution_state;
  if (!projection?.v3_enabled) {
    return { state: 'legacy_v2_projection', label: 'Legacy V2 projection (V3 disabled)' };
  }
  switch (state) {
    case 'SHADOW_MODE_READY':
      return { state: 'ready', label: 'Shadow mode ready', detail: projection.execution_state_basis?.basis_strategy ?? null };
    case 'REVIEW_REQUIRED':
      return { state: 'ready_with_limitations', label: 'Review required' };
    case 'DATA_REQUIRED':
      return { state: 'blocked_insufficient_evidence', label: 'Data required' };
    case 'ANOMALY_QUARANTINE':
      return { state: 'blocked_insufficient_evidence', label: 'Anomaly quarantine' };
    case 'EVIDENCE_ONLY_DEGRADED':
      return { state: 'blocked_insufficient_evidence', label: 'V3 decision evidence unavailable (degraded)' };
    default:
      return { state: 'valuing', label: state || 'Projecting' };
  }
}

/**
 * Read-only V3 decision projection for Comp Intelligence.
 * Never persists scores, snapshots, or publishes events.
 */
export async function projectCompIntelligenceV3Decision(propertyId, context = {}, options = {}, deps = {}) {
  const startedAt = Date.now();
  const normalizedId = clean(propertyId);
  if (!normalizedId) {
    return { ok: false, error: 'property_id_required' };
  }

  const now = deps.now ?? new Date();
  const subjectLoader = deps.loadSubjectProperty ?? loadSubjectProperty;
  const compLoader = deps.loadComparableProperties ?? loadComparableProperties;
  const buyerLoader = deps.loadBuyerPurchases ?? loadBuyerPurchases;
  const v3Loader = deps.loadV3CompCandidates ?? loadV3CompCandidates;
  const v3Enabled = deps.v3Enabled ?? readFeatureFlag('ACQUISITION_ENGINE_V3_ENABLED');

  const rawSubject = await subjectLoader(normalizedId, deps);
  if (!rawSubject) {
    return { ok: false, error: 'property_not_found', queryMs: Date.now() - startedAt };
  }

  const subject = normalizePropertyFeatures(rawSubject, { source: 'properties', now });
  const [comps, buyerPurchases, v3Loaded] = await Promise.all([
    compLoader(subject, deps),
    buyerLoader(subject, deps),
    v3Enabled ? v3Loader(subject, deps) : Promise.resolve(null),
  ]);

  const decision = calculateAcquisitionDecision({
    subject,
    comps,
    buyerPurchases,
    now,
    targetAssignmentFee: num(options.targetAssignmentFee) ?? 15_000,
    v3Enabled,
    v3CompCandidates: v3Loaded?.candidates ?? null,
    v3LoaderDiagnostics: v3Loaded?.diagnostics ?? null,
  });

  const qualification = v3Enabled
    ? qualifyComps(rawSubject, v3Loaded?.candidates ?? comps)
    : null;

  const decision_projection = mapDecisionProjection(decision, v3Enabled);
  const transaction_evidence = v3Enabled
    ? mapTransactionEvidenceFromQualification(qualification, v3Loaded?.candidates ?? [])
    : [];

  return {
    ok: true,
    property_id: normalizedId,
    decision_projection,
    transaction_evidence,
    valuation_state: derivePipelineState(decision_projection),
    qualification_summary: qualification?.sample ?? null,
    projection_meta: {
      read_only: true,
      persisted: false,
      score_table_write: false,
      snapshot_write: false,
      event_publication: false,
      outbound_execution: false,
      queryMs: Date.now() - startedAt,
    },
    raw_decision: decision,
  };
}

export default { projectCompIntelligenceV3Decision };