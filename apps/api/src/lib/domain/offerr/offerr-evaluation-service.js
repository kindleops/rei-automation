/**
 * Offerr Evaluation Spine — provider-independent orchestration service.
 *
 * evaluateOfferrProperty(input, deps):
 *   validate intake -> idempotent replay check -> deterministic address
 *   resolution -> canonical subject hydration -> seller-fact overlay (claims
 *   only, canonical data never mutated) -> canonical comp + acquisition
 *   decision paths -> Offerr fail-closed safety gates -> immutable versioned
 *   snapshot persistence -> seller-safe projection.
 *
 * Reuses the canonical engine exactly like the read-only comp-intelligence
 * projection: pure calculateAcquisitionDecision plus the engine's own loaders.
 * It never invokes the engine's persisting score path (which writes
 * property_acquisition_scores), never touches outbound execution
 * infrastructure, and never generates a binding offer.
 */

import { createHash } from 'node:crypto';

import {
  calculateAcquisitionDecision,
  loadComparableProperties,
  loadBuyerPurchases,
  loadSubjectProperty,
  normalizePropertyFeatures,
} from '@/lib/acquisition/acquisitionDecisionEngine.js';
import { loadV3CompCandidates } from '@/lib/acquisition/compCandidateLoader.js';
import { classifyAssetLane } from '@/lib/acquisition/assetClassification.js';
import { LANE_FAMILY, readFeatureFlag } from '@/lib/acquisition/modelConstants.js';
import { child } from '@/lib/logging/logger.js';

import {
  OFFERR_EVALUATION_TTL_MS,
  OFFERR_OUTCOMES,
  OFFERR_RESOLUTION_STATUSES,
  OFFERR_SPINE_VERSION,
  normalizeOfferrIntake,
} from './offerr-contracts.js';
import { resolveOfferrSubjectProperty } from './offerr-property-resolution.js';
import { applyOfferrSafetyGates } from './offerr-safety-gates.js';
import { buildOfferrSellerProjection } from './offerr-seller-projection.js';
import { createSupabaseOfferrEvaluationStore } from './offerr-evaluation-store.js';

const DEFAULT_TIMEOUT_MS = 15_000;

const moduleLogger = child({ module: 'domain.offerr.evaluation' });

function clean(value) {
  return String(value ?? '').trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Deterministic identity hash of the comp evidence set used in a decision. */
function compSetHash(compRows = []) {
  const keys = compRows
    .map((c) =>
      [
        clean(c?.id ?? c?.comp_id ?? c?.property_id ?? c?.source_record_id),
        clean(c?.sale_price),
        clean(c?.sale_date),
      ].join('|'),
    )
    .sort();
  return sha256(keys.join('\n'));
}

/** Address is quasi-PII: log only a stable hash prefix plus the zip tail. */
function addressLogRef(normalizedAddress) {
  if (!normalizedAddress) return null;
  const zipMatch = normalizedAddress.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  return {
    address_sha256_12: sha256(normalizedAddress).slice(0, 12),
    zip: zipMatch ? zipMatch[1] : null,
  };
}

/**
 * Compare seller claims against canonical source data. Claims can only reduce
 * eligibility — they never improve an outcome and never mutate the subject.
 */
export function detectOverlayConflicts(sellerFacts = {}, rawSubject = null) {
  const conflicts = [];

  const askingPrice = num(sellerFacts.asking_price?.value);
  const estimatedValue = num(rawSubject?.estimated_value);
  if (askingPrice !== null && estimatedValue !== null && estimatedValue > 0) {
    if (askingPrice > estimatedValue * 1.5) {
      conflicts.push('asking_price_far_above_independent_value');
    }
  }

  const condition = sellerFacts.condition?.value ?? null;
  const repairLevel = sellerFacts.repairs?.value?.level ?? null;
  if ((condition === 'excellent' || condition === 'good') && repairLevel === 'major') {
    conflicts.push('condition_claim_conflicts_with_repair_disclosure');
  }

  return conflicts;
}

function sellerSafeConflictDescriptions(conflicts = []) {
  const map = {
    asking_price_far_above_independent_value:
      'The target price provided is above what current market data supports.',
    condition_claim_conflicts_with_repair_disclosure:
      'The reported condition and repair details appear inconsistent; verification is needed.',
  };
  return conflicts.map((c) => map[c]).filter(Boolean);
}

function buildAssumptions(intake, outcome) {
  const assumptions = ['Preliminary range is subject to an in-person or virtual walkthrough.'];
  if (intake.seller_facts?.condition) {
    assumptions.push('Reflects the seller-reported condition, pending verification.');
  } else if (
    outcome === OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE ||
    outcome === OFFERR_OUTCOMES.CONDITIONAL_RANGE
  ) {
    assumptions.push('Assumes average interior condition until verified.');
  }
  return assumptions;
}

function replayResult(found, startedAt) {
  const evaluation = found.evaluation ?? null;
  return {
    ok: true,
    idempotent_replay: true,
    request_id: found.request?.id ?? null,
    evaluation_id: evaluation?.id ?? null,
    outcome: evaluation?.outcome ?? null,
    seller_projection: evaluation?.seller_projection ?? null,
    internal_result: evaluation?.internal_result ?? null,
    timings: { total_ms: Date.now() - startedAt, replay: true },
  };
}

function failure(failureCode, extra = {}, timings = {}, startedAt = Date.now()) {
  return {
    ok: false,
    error: 'offerr_evaluation_failed',
    failure_code: failureCode,
    idempotent_replay: false,
    seller_projection: null,
    ...extra,
    timings: { ...timings, total_ms: Date.now() - startedAt },
  };
}

/**
 * Evaluate a seller-submitted address through the canonical acquisition
 * intelligence with Offerr fail-closed gating.
 *
 * @param {object} input - Raw intake (address, idempotency_key, seller_facts…).
 * @param {object} [deps] - Injection surface (tests / future providers):
 *   now, logger, store, timeoutMs, v3Enabled, targetAssignmentFee,
 *   resolveSubjectProperty, loadSubjectProperty, loadComparableProperties,
 *   loadBuyerPurchases, loadV3CompCandidates, calculateDecision,
 *   classifyAssetLane, generateRequestId, generateEvaluationId, db/supabase.
 */
export async function evaluateOfferrProperty(input = {}, deps = {}) {
  const startedAt = Date.now();
  const logger = deps.logger ?? moduleLogger;
  const now = deps.now ?? new Date();
  const timeoutMs = num(deps.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;
  const timings = {};

  const overDeadline = (stage) => {
    if (Date.now() <= deadline) return null;
    logger.warn('offerr_evaluation.timeout', { timeout_stage: stage, timeout_ms: timeoutMs });
    return failure('evaluation_timeout', { timeout_stage: stage }, timings, startedAt);
  };

  // ── Stage 1: validate + normalize intake ─────────────────────────────────
  let stageStart = Date.now();
  const normalized = normalizeOfferrIntake(input, {
    now,
    generateRequestId: deps.generateRequestId,
  });
  timings.validate_ms = Date.now() - stageStart;
  if (!normalized.ok) {
    return {
      ok: false,
      error: 'invalid_offerr_intake',
      failure_code: 'invalid_offerr_intake',
      validation_errors: normalized.errors,
      idempotent_replay: false,
      seller_projection: null,
      timings: { ...timings, total_ms: Date.now() - startedAt },
    };
  }
  const intake = normalized.intake;
  const logRef = addressLogRef(intake.normalized_submitted_address);

  logger.info('offerr_evaluation.requested', {
    request_id: intake.request_id,
    source: intake.source,
    has_seller_facts: intake.has_seller_facts,
    ...logRef,
  });

  // ── Stage 2: idempotent replay ───────────────────────────────────────────
  const store = deps.store ?? createSupabaseOfferrEvaluationStore(deps);
  stageStart = Date.now();
  const existing = await store.findByIdempotencyKey(intake.idempotency_key);
  timings.idempotency_ms = Date.now() - stageStart;
  if (!existing.ok) {
    logger.error('offerr_evaluation.failed', {
      request_id: intake.request_id,
      failure_code: 'offerr_persistence_unavailable',
      detail: existing.error,
    });
    return failure('offerr_persistence_unavailable', {}, timings, startedAt);
  }
  if (existing.found) {
    // Fail closed on a request row without its evaluation snapshot — a
    // partial snapshot must never be presented as a completed evaluation.
    if (!existing.evaluation) {
      logger.error('offerr_evaluation.failed', {
        request_id: existing.request?.id ?? intake.request_id,
        failure_code: 'offerr_incomplete_snapshot',
      });
      return failure('offerr_incomplete_snapshot', {}, timings, startedAt);
    }
    // An idempotency key is bound to one logical request: reusing it with a
    // different address is a caller bug, not a replay.
    const storedAddress = clean(existing.request?.normalized_submitted_address);
    if (storedAddress && storedAddress !== intake.normalized_submitted_address) {
      logger.warn('offerr_evaluation.failed', {
        request_id: existing.request?.id ?? intake.request_id,
        failure_code: 'idempotency_key_reused_with_different_payload',
      });
      return failure('idempotency_key_reused_with_different_payload', {}, timings, startedAt);
    }
    logger.info('offerr_evaluation.completed', {
      request_id: existing.request?.id ?? intake.request_id,
      outcome: existing.evaluation?.outcome ?? null,
      idempotent_replay: true,
      duration_ms: Date.now() - startedAt,
    });
    return replayResult(existing, startedAt);
  }

  // ── Stage 3: deterministic address -> property resolution ───────────────
  const resolveSubject = deps.resolveSubjectProperty ?? resolveOfferrSubjectProperty;
  stageStart = Date.now();
  let resolution;
  try {
    resolution = await resolveSubject(
      {
        rawAddress: intake.raw_submitted_address,
        normalizedAddress: intake.normalized_submitted_address,
      },
      deps,
    );
  } catch (error) {
    timings.resolution_ms = Date.now() - stageStart;
    logger.error('offerr_evaluation.failed', {
      request_id: intake.request_id,
      failure_code: 'property_resolution_error',
      error_message: clean(error?.message) || 'unknown',
    });
    return failure('property_resolution_error', {}, timings, startedAt);
  }
  timings.resolution_ms = Date.now() - stageStart;
  let timedOut = overDeadline('resolution');
  if (timedOut) return timedOut;

  // ── Stage 4: canonical subject hydration ─────────────────────────────────
  const subjectLoader = deps.loadSubjectProperty ?? loadSubjectProperty;
  let rawSubject = null;
  stageStart = Date.now();
  if (resolution.status === OFFERR_RESOLUTION_STATUSES.RESOLVED) {
    rawSubject = await subjectLoader(resolution.property_id, deps);
    if (!rawSubject) {
      // Resolution and hydration disagree: fail closed to ambiguity.
      resolution = {
        ...resolution,
        status: OFFERR_RESOLUTION_STATUSES.AMBIGUOUS,
        property_id: null,
        reason: 'resolved_property_failed_hydration',
      };
    }
  }
  timings.subject_ms = Date.now() - stageStart;
  timedOut = overDeadline('subject_hydration');
  if (timedOut) return timedOut;

  // ── Stage 5: asset classification + seller-fact overlay (claims only) ───
  stageStart = Date.now();
  const classify = deps.classifyAssetLane ?? classifyAssetLane;
  const classification = rawSubject ? classify(rawSubject) : null;
  const assetLane = classification?.lane ?? null;
  const assetFamily = assetLane ? (LANE_FAMILY[assetLane] ?? 'UNKNOWN') : null;
  const materialConflicts = detectOverlayConflicts(intake.seller_facts, rawSubject);
  timings.overlay_ms = Date.now() - stageStart;

  // ── Stage 6: canonical comp + decision paths ─────────────────────────────
  const v3Enabled = deps.v3Enabled ?? readFeatureFlag('ACQUISITION_ENGINE_V3_ENABLED');
  let decision = null;
  let compCandidateCount = 0;
  let compEvidenceHash = null;
  let loaderDiagnostics = null;
  timings.comp_load_ms = 0;
  timings.engine_ms = 0;

  if (rawSubject && resolution.status === OFFERR_RESOLUTION_STATUSES.RESOLVED) {
    const compLoader = deps.loadComparableProperties ?? loadComparableProperties;
    const buyerLoader = deps.loadBuyerPurchases ?? loadBuyerPurchases;
    const v3Loader = deps.loadV3CompCandidates ?? loadV3CompCandidates;

    stageStart = Date.now();
    const subject = normalizePropertyFeatures(rawSubject, { source: 'properties', now });
    let comps;
    let buyerPurchases;
    let v3Loaded;
    try {
      [comps, buyerPurchases, v3Loaded] = await Promise.all([
        compLoader(subject, deps),
        buyerLoader(subject, deps),
        v3Enabled ? v3Loader(subject, deps) : Promise.resolve(null),
      ]);
    } catch (error) {
      timings.comp_load_ms = Date.now() - stageStart;
      logger.error('offerr_evaluation.failed', {
        request_id: intake.request_id,
        failure_code: 'comp_load_error',
        error_message: clean(error?.message) || 'unknown',
      });
      return failure('comp_load_error', {}, timings, startedAt);
    }
    timings.comp_load_ms = Date.now() - stageStart;
    timedOut = overDeadline('comp_loading');
    if (timedOut) return timedOut;

    const compEvidence = v3Loaded?.candidates ?? comps ?? [];
    compCandidateCount = compEvidence.length;
    compEvidenceHash = compSetHash(compEvidence);
    loaderDiagnostics = v3Loaded?.diagnostics ?? null;

    stageStart = Date.now();
    const calculate = deps.calculateDecision ?? calculateAcquisitionDecision;
    decision = calculate({
      subject,
      comps,
      buyerPurchases,
      now,
      targetAssignmentFee: num(deps.targetAssignmentFee) ?? undefined,
      v3Enabled,
      v3CompCandidates: v3Loaded?.candidates ?? null,
      v3LoaderDiagnostics: loaderDiagnostics,
    });
    timings.engine_ms = Date.now() - stageStart;
    timedOut = overDeadline('acquisition_calculation');
    if (timedOut) return timedOut;
  }

  // ── Stage 7: Offerr fail-closed safety gates ─────────────────────────────
  stageStart = Date.now();
  const gates = applyOfferrSafetyGates({
    resolution,
    decision,
    assetFamily,
    assetLane,
    materialConflicts,
  });
  timings.gates_ms = Date.now() - stageStart;

  if (gates.hard_failure) {
    logger.error('offerr_evaluation.failed', {
      request_id: intake.request_id,
      failure_code: gates.failure_code,
      reason_codes: gates.reason_codes,
    });
    return failure(gates.failure_code, { reason_codes: gates.reason_codes }, timings, startedAt);
  }

  // ── Stage 8: provenance + internal result ────────────────────────────────
  const computedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + OFFERR_EVALUATION_TTL_MS).toISOString();
  const v3 = decision?.v3 ?? null;

  const provenance = {
    spine_version: OFFERR_SPINE_VERSION,
    engine_version: v3?.engine_version ?? (decision ? 'acquisition_decision_engine_v2' : null),
    formula_version: v3?.formula_version ?? (decision ? '2.0.0' : null),
    v3_enabled: v3Enabled,
    active_feature_flags: v3?.active_feature_flags ?? null,
    subject_property_id: resolution.property_id,
    subject_source: 'properties',
    subject_loaded_at: computedAt,
    resolution_method: resolution.method,
    comp_candidate_count: compCandidateCount,
    comp_set_hash: compEvidenceHash,
    comp_retrieval_tier: loaderDiagnostics?.retrieval_tier ?? null,
    effective_sample_size: v3?.sample?.effective_sample_size ?? null,
    seller_fact_overlay: intake.seller_facts,
    material_conflicts: materialConflicts,
    gate_checks: gates.gate_checks,
    reason_codes: gates.reason_codes,
    computed_at: computedAt,
    expires_at: expiresAt,
  };

  const internalResult = {
    spine_version: OFFERR_SPINE_VERSION,
    request_id: intake.request_id,
    idempotency_key: intake.idempotency_key,
    intake,
    resolution,
    asset_lane: assetLane,
    asset_family: assetFamily,
    overlay: { facts: intake.seller_facts, material_conflicts: materialConflicts },
    outcome: gates.outcome,
    preliminary_range: gates.preliminary_range,
    confidence_label: gates.confidence_label,
    next_step: gates.next_step,
    reason_codes: gates.reason_codes,
    gate_checks: gates.gate_checks,
    decision,
    provenance,
  };

  // ── Stage 9: persist immutable snapshot, then project ────────────────────
  const generateEvaluationId =
    deps.generateEvaluationId ?? (() => globalThis.crypto.randomUUID());
  const evaluationId = generateEvaluationId();

  const sellerProjection = buildOfferrSellerProjection({
    evaluationId,
    outcome: gates.outcome,
    preliminaryRange: gates.preliminary_range,
    confidenceLabel: gates.confidence_label,
    nextStep: gates.next_step,
    matchedProperty: resolution.match,
    assumptions: buildAssumptions(intake, gates.outcome),
    dataConflicts: sellerSafeConflictDescriptions(materialConflicts),
    expiresAt,
    processingMs: Date.now() - startedAt,
  });

  stageStart = Date.now();
  const persisted = await store.persistEvaluation({
    request: {
      id: intake.request_id,
      idempotency_key: intake.idempotency_key,
      raw_submitted_address: intake.raw_submitted_address,
      normalized_submitted_address: intake.normalized_submitted_address,
      seller_facts: intake.seller_facts,
      source: intake.source,
      spine_version: OFFERR_SPINE_VERSION,
      resolution_status: resolution.status,
      property_id: resolution.property_id,
      created_at: intake.created_at,
    },
    evaluation: {
      id: evaluationId,
      evaluation_version: 1,
      property_id: resolution.property_id,
      outcome: gates.outcome,
      confidence_label: gates.confidence_label,
      preliminary_range: gates.preliminary_range,
      seller_projection: sellerProjection,
      internal_result: internalResult,
      provenance,
      engine_version: provenance.engine_version,
      spine_version: OFFERR_SPINE_VERSION,
      computed_at: computedAt,
      expires_at: expiresAt,
    },
    event: {
      event_type: 'offerr_evaluation_completed',
      dedupe_key: `offerr_evaluation:${intake.idempotency_key}`,
      payload: {
        outcome: gates.outcome,
        confidence_label: gates.confidence_label,
        reason_codes: gates.reason_codes,
        timings,
      },
      created_at: computedAt,
    },
  });
  timings.persistence_ms = Date.now() - stageStart;

  if (!persisted.ok) {
    logger.error('offerr_evaluation.failed', {
      request_id: intake.request_id,
      failure_code: 'offerr_persistence_failed',
      detail: persisted.error,
    });
    return failure('offerr_persistence_failed', {}, timings, startedAt);
  }
  if (persisted.duplicate) {
    // Concurrent request with the same idempotency key won the insert race:
    // return the stored evaluation so the response stays deterministic.
    const winnerAddress = clean(persisted.request?.normalized_submitted_address);
    if (winnerAddress && winnerAddress !== intake.normalized_submitted_address) {
      return failure('idempotency_key_reused_with_different_payload', {}, timings, startedAt);
    }
    if (!persisted.evaluation) {
      return failure('offerr_incomplete_snapshot', {}, timings, startedAt);
    }
    logger.info('offerr_evaluation.completed', {
      request_id: persisted.request?.id ?? intake.request_id,
      outcome: persisted.evaluation?.outcome ?? null,
      idempotent_replay: true,
      duration_ms: Date.now() - startedAt,
    });
    return replayResult(persisted, startedAt);
  }

  timings.total_ms = Date.now() - startedAt;
  logger.info('offerr_evaluation.completed', {
    request_id: intake.request_id,
    evaluation_id: evaluationId,
    outcome: gates.outcome,
    confidence_label: gates.confidence_label,
    resolution_status: resolution.status,
    asset_lane: assetLane,
    reason_codes: gates.reason_codes,
    idempotent_replay: false,
    ...timings,
    duration_ms: timings.total_ms,
    ...logRef,
  });

  return {
    ok: true,
    idempotent_replay: false,
    request_id: intake.request_id,
    evaluation_id: evaluationId,
    outcome: gates.outcome,
    seller_projection: sellerProjection,
    internal_result: internalResult,
    timings,
  };
}

export default { evaluateOfferrProperty, detectOverlayConflicts };
