/**
 * Acquisition Engine V3 — multi-dimensional confidence + execution semantics
 * (mission Item 4 §15, mission §22/§24).
 *
 * Enforces the critical rule: subject-anchor / low-ESS / package-only evidence
 * can NEVER reach an executable state, and auto_offer_eligible is gated by both
 * the criteria AND the (default-false) ALLOW_AUTO_OFFER flag.
 */

import {
  EXECUTION,
  EXECUTION_STATES as ES,
  VALUE_CLASSIFICATION as VC,
  VALUATION_UNIVERSES as U,
  MODEL_DISAGREEMENT_CONF_CAP,
  readFeatureFlag,
  num,
  clamp,
  round,
} from './modelConstants.js';

function subjectCompleteness(subjectRow) {
  const fields = ['estimated_value', 'building_square_feet', 'units_count', 'year_built', 'building_condition'];
  const present = fields.filter((f) => subjectRow[f] !== null && subjectRow[f] !== undefined && subjectRow[f] !== '');
  return (present.length / fields.length) * 100;
}

function dominantUniverse(universes) {
  return [U.LOCAL_INVESTOR_VALUE, U.PUBLIC_RECORD_ARM_LENGTH_VALUE, U.RETAIL_MLS_VALUE, U.INSTITUTIONAL_VALUE]
    .map((k) => universes[k])
    .filter((u) => u && u.available)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] ?? null;
}

export function buildConfidenceAndExecution({
  subjectRow = {},
  classification = {},
  qualification = {},
  reconciliation = {},
  universes = {},
  repair = {},
  buyerExit = {},
  invariants = { ok: true },
}) {
  const sample = qualification.sample ?? {};
  const flags = qualification.anomaly_flags ?? [];
  const accepted = qualification.accepted ?? [];
  const ess = sample.effective_sample_size ?? 0;
  const dom = dominantUniverse(universes);
  const retail = universes[U.RETAIL_MLS_VALUE];
  const income = universes[U.INCOME_VALUE];

  const avgAcceptedScore = accepted.length
    ? accepted.reduce((s, a) => s + (a.score ?? 0), 0) / accepted.length
    : 0;

  const components = {
    subject_data: round(subjectCompleteness(subjectRow), 1),
    asset_classification: classification.confidence ?? 0,
    transaction_quality: round(avgAcceptedScore, 1),
    comp_depth: round(clamp((ess / 6) * 100, 0, 100), 1),
    physical_match: round(dom?.avg_similarity ?? 0, 1),
    geographic_match: round(dom?.geographic_score ?? 0, 1),
    investor_valuation: reconciliation.investor_exit_confidence ?? 0,
    retail_valuation: retail?.confidence ?? 0,
    income_valuation: income?.confidence ?? 0,
    repair: repair.repair_confidence ?? 0,
    buyer_exit: buyerExit.exit_confidence ?? 0,
    census: null,
  };

  const weighted = [
    [components.subject_data, 0.1],
    [components.asset_classification, 0.1],
    [components.transaction_quality, 0.15],
    [components.comp_depth, 0.15],
    [components.physical_match, 0.1],
    [components.investor_valuation, 0.2],
    [components.buyer_exit, 0.1],
    [components.repair, 0.1],
  ];
  let final = clamp(weighted.reduce((s, [v, w]) => s + (v ?? 0) * w, 0), 0, 100);

  const marketClass = reconciliation.market_value_classification;
  const disagreement = reconciliation.model_disagreement_score ?? 0;
  if (marketClass === VC.SUBJECT_ANCHOR_SCENARIO) final = Math.min(final, 30);
  else if (marketClass === VC.PROVISIONAL_SCENARIO) final = Math.min(final, 55);
  if (disagreement > MODEL_DISAGREEMENT_CONF_CAP) final = Math.min(final, 60);

  // ---- Execution state (fail closed) ----
  let executionState;
  const reasons = [];
  if (
    !invariants.ok ||
    flags.includes('PACKAGE_CONSIDERATION_DETECTED') ||
    flags.includes('IMPLAUSIBLE_COMP_PRICE') ||
    flags.includes('ASSET_LANE_MISMATCH')
  ) {
    executionState = ES.ANOMALY_QUARANTINE;
    reasons.push('anomaly_or_invariant_violation');
  } else if (
    (accepted.length ?? 0) === 0 ||
    ess < EXECUTION.MIN_EFFECTIVE_SAMPLE_SIZE ||
    marketClass === VC.SUBJECT_ANCHOR_SCENARIO
  ) {
    executionState = ES.DATA_REQUIRED;
    reasons.push('insufficient_transaction_support');
  } else if (disagreement > MODEL_DISAGREEMENT_CONF_CAP || marketClass === VC.PROVISIONAL_SCENARIO || final < 45) {
    executionState = ES.REVIEW_REQUIRED;
    reasons.push('model_disagreement_or_provisional_or_low_confidence');
  } else {
    executionState = ES.SHADOW_MODE_READY;
  }

  const criteriaMet =
    executionState === ES.SHADOW_MODE_READY &&
    ess >= EXECUTION.MIN_EFFECTIVE_SAMPLE_SIZE &&
    (components.investor_valuation ?? 0) >= EXECUTION.MIN_INVESTOR_VALUATION_CONFIDENCE &&
    (components.buyer_exit ?? 0) >= EXECUTION.MIN_BUYER_EXIT_CONFIDENCE &&
    (components.repair ?? 0) >= EXECUTION.MIN_REPAIR_CONFIDENCE &&
    disagreement <= EXECUTION.MAX_MODEL_DISAGREEMENT &&
    final >= EXECUTION.MIN_EXECUTION_CONFIDENCE &&
    invariants.ok &&
    marketClass === VC.QUALIFIED;

  // Outbound execution remains disabled by flag regardless of criteria.
  const autoOfferEligible = criteriaMet && readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER');

  return {
    components,
    final_confidence: Math.round(final),
    execution_state: executionState,
    value_classification: marketClass,
    auto_offer_ready_criteria_met: criteriaMet,
    auto_offer_eligible: autoOfferEligible,
    reasons,
  };
}
