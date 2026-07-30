/**
 * Offerr Evaluation Spine — fail-closed safety gates.
 *
 * Maps a canonical acquisition-engine decision to an Offerr outcome. This
 * module NEVER invents valuation or offer math — every number it touches
 * comes from the V3 decision block (authorized figures only) and every
 * uncertainty path collapses to REVIEW_REQUIRED / UNSUPPORTED with no range.
 *
 * Reused canonical safeguards:
 *   - assertAcquisitionInvariants (@/lib/acquisition/acquisitionInvariants.js)
 *   - V3 execution states / value classification / anomaly materiality
 *   - V3 correlated-comp effective sample size (packages count once)
 *
 * Hard failures (nonfinite / negative / reversed engine output) are surfaced
 * as { hard_failure: true } so the orchestrator aborts the evaluation rather
 * than shipping a defective range.
 */

import { assertAcquisitionInvariants } from '@/lib/acquisition/acquisitionInvariants.js';
import { EXECUTION_STATES, VALUE_CLASSIFICATION } from '@/lib/acquisition/modelConstants.js';

import {
  OFFERR_CONFIDENCE_LABELS,
  OFFERR_NEXT_STEPS,
  OFFERR_OUTCOMES,
  OFFERR_RESOLUTION_STATUSES,
  OFFERR_SUPPORTED_ASSET_FAMILIES,
} from './offerr-contracts.js';

export const OFFERR_GATE_THRESHOLDS = Object.freeze({
  instant_min_confidence: 70,
  conditional_min_confidence: 55,
  instant_min_effective_sample_size: 3,
  conditional_min_effective_sample_size: 2,
  high_label_min_confidence: 75,
  medium_label_min_confidence: 55,
});

const RANGE_ELIGIBLE_STATES = new Set([
  EXECUTION_STATES.SHADOW_MODE_READY,
  EXECUTION_STATES.AUTO_RANGE_READY,
  EXECUTION_STATES.AUTO_OFFER_READY,
  EXECUTION_STATES.AUTO_CREATIVE_READY,
]);

function finiteNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isBrokenMoney(value) {
  // null/undefined means "absent" (handled by eligibility gates); anything
  // present must be a finite, non-negative number.
  if (value === null || value === undefined) return false;
  const n = Number(value);
  return !Number.isFinite(n) || n < 0;
}

function confidenceLabel(confidence, thresholds) {
  const n = finiteNum(confidence);
  if (n === null) return OFFERR_CONFIDENCE_LABELS.LOW;
  if (n >= thresholds.high_label_min_confidence) return OFFERR_CONFIDENCE_LABELS.HIGH;
  if (n >= thresholds.medium_label_min_confidence) return OFFERR_CONFIDENCE_LABELS.MEDIUM;
  return OFFERR_CONFIDENCE_LABELS.LOW;
}

function review(reasonCodes, nextStep, gateChecks, label = OFFERR_CONFIDENCE_LABELS.LOW) {
  return {
    outcome: OFFERR_OUTCOMES.REVIEW_REQUIRED,
    preliminary_range: null,
    confidence_label: label,
    next_step: nextStep,
    reason_codes: reasonCodes,
    gate_checks: gateChecks,
    hard_failure: false,
    failure_code: null,
  };
}

function hardFailure(failureCode, reasonCodes, gateChecks) {
  return {
    outcome: null,
    preliminary_range: null,
    confidence_label: null,
    next_step: null,
    reason_codes: reasonCodes,
    gate_checks: gateChecks,
    hard_failure: true,
    failure_code: failureCode,
  };
}

/**
 * Apply Offerr eligibility and safety gates to a canonical decision.
 *
 * @param {object} args
 * @param {object} args.resolution - Result of resolveOfferrSubjectProperty.
 * @param {object|null} args.decision - calculateAcquisitionDecision output.
 * @param {string|null} args.assetFamily - Canonical asset family for the subject.
 * @param {string|null} args.assetLane - Canonical asset lane for the subject.
 * @param {string[]} [args.materialConflicts] - Seller-claim vs source conflicts.
 * @param {object} [args.thresholds] - Gate threshold overrides (tests only).
 */
export function applyOfferrSafetyGates({
  resolution,
  decision,
  assetFamily,
  assetLane,
  materialConflicts = [],
  thresholds = OFFERR_GATE_THRESHOLDS,
} = {}) {
  const reasons = [];
  const checks = {
    property_resolved: resolution?.status === OFFERR_RESOLUTION_STATUSES.RESOLVED,
    asset_family_supported: OFFERR_SUPPORTED_ASSET_FAMILIES.includes(assetFamily),
    engine_v3_active: Boolean(decision?.v3),
    execution_state_range_eligible: false,
    invariants_ok: false,
    no_material_anomaly: false,
    value_classification_qualified: false,
    cash_underwritten: false,
    range_numbers_finite: false,
    range_within_ceilings: false,
    comp_depth_instant: false,
    comp_depth_conditional: false,
    confidence_instant: false,
    confidence_conditional: false,
    no_material_source_conflicts: materialConflicts.length === 0,
  };

  // 1. Unresolved / ambiguous property -> no range. Checked before the asset
  //    lane because an unresolved subject has no trustworthy classification.
  if (!checks.property_resolved) {
    const status = resolution?.status ?? OFFERR_RESOLUTION_STATUSES.NOT_FOUND;
    reasons.push(`property_not_resolved:${status}`);
    const nextStep =
      status === OFFERR_RESOLUTION_STATUSES.AMBIGUOUS
        ? OFFERR_NEXT_STEPS.CONFIRM_PROPERTY_IDENTITY
        : OFFERR_NEXT_STEPS.CONFIRM_PROPERTY_ADDRESS;
    return review(reasons, nextStep, checks);
  }

  // 2. Unsupported asset lane -> no automatic range, ever.
  if (!checks.asset_family_supported) {
    reasons.push(`unsupported_asset_family:${assetFamily ?? 'UNKNOWN'}`);
    if (assetLane) reasons.push(`asset_lane:${assetLane}`);
    return {
      outcome: OFFERR_OUTCOMES.UNSUPPORTED,
      preliminary_range: null,
      confidence_label: OFFERR_CONFIDENCE_LABELS.LOW,
      next_step: OFFERR_NEXT_STEPS.NOT_SERVICEABLE,
      reason_codes: reasons,
      gate_checks: checks,
      hard_failure: false,
      failure_code: null,
    };
  }

  // 3. Without the V3 evidence layer there is no contamination defense, so a
  //    seller-facing range is never generated from V2-only output.
  const v3 = decision?.v3 ?? null;
  if (!v3) {
    reasons.push('engine_v3_disabled_or_unavailable');
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks);
  }

  const auth = v3.offer_authorization ?? {};
  const valueContract = v3.value_contract ?? {};
  const qualifiedValue = valueContract.qualified_market_value ?? null;
  const conservativeExit = finiteNum(v3.buyer_exit?.conservative_buyer_exit);
  const ess = finiteNum(v3.sample?.effective_sample_size) ?? 0;
  const confidence = finiteNum(v3.final_confidence);

  // 4. Nonfinite or negative money anywhere in the figures we would present
  //    is a hard failure, not a downgrade.
  const moneyFields = {
    authorized_opening_offer: auth.authorized_opening_offer,
    authorized_recommended_offer: auth.authorized_recommended_offer,
    authorized_maximum_offer: auth.authorized_maximum_offer,
    qualified_value_low: qualifiedValue?.low,
    qualified_value_mid: qualifiedValue?.mid,
    qualified_value_high: qualifiedValue?.high,
    conservative_buyer_exit: v3.buyer_exit?.conservative_buyer_exit,
  };
  for (const [field, value] of Object.entries(moneyFields)) {
    if (isBrokenMoney(value)) {
      reasons.push(`nonfinite_or_negative_engine_output:${field}`);
      return hardFailure('nonfinite_or_negative_engine_output', reasons, checks);
    }
  }
  checks.range_numbers_finite = true;

  const label = confidenceLabel(confidence, thresholds);

  // 5. Execution state must be range-eligible.
  checks.execution_state_range_eligible = RANGE_ELIGIBLE_STATES.has(v3.execution_state);
  if (!checks.execution_state_range_eligible) {
    reasons.push(`execution_state_not_range_eligible:${v3.execution_state}`);
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }

  // 6. Canonical invariants and anomaly materiality.
  checks.invariants_ok = Boolean(v3.invariants?.ok);
  if (!checks.invariants_ok) {
    reasons.push('acquisition_invariants_violated');
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }
  checks.no_material_anomaly = !v3.transaction_anomaly_material;
  if (!checks.no_material_anomaly) {
    reasons.push('material_transaction_anomaly');
    for (const r of v3.material_anomaly_reasons ?? []) reasons.push(`anomaly:${r}`);
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }

  // 7. Only QUALIFIED market evidence can drive a seller-facing range —
  //    scenario / subject-anchor figures are never presented to a seller.
  checks.value_classification_qualified =
    v3.value_classification === VALUE_CLASSIFICATION.QUALIFIED && qualifiedValue !== null;
  if (!checks.value_classification_qualified) {
    reasons.push(`value_classification_not_qualified:${v3.value_classification ?? 'null'}`);
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }

  // 8. Authorized (underwritten) cash figures must exist. Scenario figures
  //    from offerEconomics are explicitly not presentable.
  const low = finiteNum(auth.authorized_opening_offer);
  const high = finiteNum(auth.authorized_recommended_offer);
  const maximum = finiteNum(auth.authorized_maximum_offer);
  checks.cash_underwritten = low !== null && high !== null && maximum !== null;
  if (!checks.cash_underwritten) {
    reasons.push('cash_strategy_not_underwritten');
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }

  if (low <= 0 || high <= 0) {
    reasons.push('non_positive_range_bound');
    return hardFailure('non_positive_range_bound', reasons, checks);
  }
  if (low > high) {
    reasons.push('range_floor_exceeds_ceiling');
    return hardFailure('range_floor_exceeds_ceiling', reasons, checks);
  }

  // 9. The presented ceiling can never exceed the canonical conservative
  //    acquisition ceiling or the independent qualified valuation anchor.
  const invariantAudit = assertAcquisitionInvariants({
    valuation_low: qualifiedValue.low,
    valuation_mid: qualifiedValue.mid,
    valuation_high: qualifiedValue.high,
    recommended_cash_offer: high,
    maximum_cash_offer: maximum,
    conservative_buyer_exit: conservativeExit,
  });
  const ceilingOk =
    invariantAudit.ok &&
    high <= maximum &&
    (conservativeExit === null || high <= conservativeExit) &&
    (finiteNum(qualifiedValue.high) === null || high <= qualifiedValue.high);
  checks.range_within_ceilings = ceilingOk;
  if (!ceilingOk) {
    reasons.push('range_exceeds_conservative_ceiling');
    for (const v of invariantAudit.violations ?? []) reasons.push(`invariant:${v.code}`);
    return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
  }

  // 10. Comp depth + confidence tiers (correlated transactions already
  //     collapsed to one representative by the canonical clustering).
  checks.comp_depth_instant = ess >= thresholds.instant_min_effective_sample_size;
  checks.comp_depth_conditional = ess >= thresholds.conditional_min_effective_sample_size;
  checks.confidence_instant =
    confidence !== null && confidence >= thresholds.instant_min_confidence;
  checks.confidence_conditional =
    confidence !== null && confidence >= thresholds.conditional_min_confidence;

  const preliminaryRange = { low, high, currency: 'USD' };

  if (
    checks.comp_depth_instant &&
    checks.confidence_instant &&
    checks.no_material_source_conflicts
  ) {
    return {
      outcome: OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE,
      preliminary_range: preliminaryRange,
      confidence_label: label,
      next_step: OFFERR_NEXT_STEPS.SCHEDULE_VERIFICATION,
      reason_codes: reasons,
      gate_checks: checks,
      hard_failure: false,
      failure_code: null,
    };
  }

  if (checks.comp_depth_conditional && checks.confidence_conditional) {
    if (!checks.no_material_source_conflicts) {
      reasons.push('material_source_conflicts_downgrade');
      for (const c of materialConflicts) reasons.push(`conflict:${c}`);
    }
    if (!checks.comp_depth_instant) reasons.push('comp_depth_below_instant_threshold');
    if (!checks.confidence_instant) reasons.push('confidence_below_instant_threshold');
    return {
      outcome: OFFERR_OUTCOMES.CONDITIONAL_RANGE,
      preliminary_range: preliminaryRange,
      confidence_label:
        label === OFFERR_CONFIDENCE_LABELS.HIGH ? OFFERR_CONFIDENCE_LABELS.MEDIUM : label,
      next_step: OFFERR_NEXT_STEPS.VERIFY_CONDITION_DETAILS,
      reason_codes: reasons,
      gate_checks: checks,
      hard_failure: false,
      failure_code: null,
    };
  }

  if (!checks.comp_depth_conditional) reasons.push('insufficient_independent_comp_depth');
  if (!checks.confidence_conditional) reasons.push('confidence_below_conditional_threshold');
  return review(reasons, OFFERR_NEXT_STEPS.INTERNAL_REVIEW, checks, label);
}

export default { applyOfferrSafetyGates, OFFERR_GATE_THRESHOLDS };
