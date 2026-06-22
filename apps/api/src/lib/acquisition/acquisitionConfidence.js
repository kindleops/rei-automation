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
  LANE_FAMILY,
  MODEL_DISAGREEMENT_CONF_CAP,
  WHOLESALE_DEPTH_GATES,
  WHOLESALE_EXCEPTION,
  NOVATION_DEPTH_MIN,
  dominantDepthConfidenceCap,
  readFeatureFlag,
  num,
  clamp,
  round,
} from './modelConstants.js';

/** Independent (post-peer) pricing depth contributed by a qualified universe. */
function universeDepth(u) {
  return u && u.available && u.value_classification === VC.QUALIFIED
    ? num(u.accepted_independent_transaction_count, 0)
    : 0;
}

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
  novationRecommended = false,
}) {
  const sample = qualification.sample ?? {};
  const flags = qualification.anomaly_flags ?? [];
  const accepted = qualification.accepted ?? [];
  const ess = sample.effective_sample_size ?? 0;
  const dom = dominantUniverse(universes);
  const retail = universes[U.RETAIL_MLS_VALUE];
  const income = universes[U.INCOME_VALUE];

  // ---- Item 5B §0: universe-specific, strategy-specific evidence depth ----
  const family = LANE_FAMILY[classification.lane] ?? 'UNKNOWN';
  const investorEss = universeDepth(universes[U.LOCAL_INVESTOR_VALUE]);
  const institutionalEss = universeDepth(universes[U.INSTITUTIONAL_VALUE]);
  const publicEss = universeDepth(universes[U.PUBLIC_RECORD_ARM_LENGTH_VALUE]);
  const retailEss = universeDepth(universes[U.RETAIL_MLS_VALUE]);
  // Wholesale-cash depth = investor-compatible universes ONLY (retail/new-construction/
  // ARV/distressed/government routed elsewhere cannot lend wholesale depth).
  const wholesaleEss = investorEss + institutionalEss + publicEss;
  const dominantU = dom;
  const dominantEss = num(dominantU?.accepted_independent_transaction_count, 0);

  const avgAcceptedScore = accepted.length
    ? accepted.reduce((s, a) => s + (a.score ?? 0), 0) / accepted.length
    : 0;

  const components = {
    subject_data: round(subjectCompleteness(subjectRow), 1),
    asset_classification: classification.confidence ?? 0,
    transaction_quality: round(avgAcceptedScore, 1),
    // Depth is the DOMINANT model's independent depth — a high total candidate
    // count cannot inflate it (Item 5B §0.3).
    comp_depth: round(clamp((dominantEss / 6) * 100, 0, 100), 1),
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
  // Confidence cannot exceed what the dominant model's depth supports.
  final = Math.min(final, dominantDepthConfidenceCap(dominantEss));

  // ---- Strategy-specific wholesale-cash depth gate (Item 5B §0.4) ----
  const gate = WHOLESALE_DEPTH_GATES[family] ?? WHOLESALE_DEPTH_GATES.UNKNOWN;
  const invU = universes[U.LOCAL_INVESTOR_VALUE];
  const exceptionMet =
    wholesaleEss >= gate.exception_min &&
    disagreement < WHOLESALE_EXCEPTION.max_disagreement &&
    (invU?.avg_similarity ?? dominantU?.avg_similarity ?? 0) >= WHOLESALE_EXCEPTION.min_median_similarity &&
    (invU?.dispersion ?? 1) <= WHOLESALE_EXCEPTION.max_dispersion &&
    publicEss >= WHOLESALE_EXCEPTION.min_public_corroboration;
  let cashGatePassed = false;
  let cashGateReason;
  if (wholesaleEss >= gate.preferred) {
    cashGatePassed = true;
    cashGateReason = `wholesale_depth_${wholesaleEss}>=preferred_${gate.preferred}`;
  } else if (exceptionMet) {
    cashGatePassed = true;
    cashGateReason = `three_comp_strong_corroboration_exception`;
  } else {
    cashGateReason = `insufficient_wholesale_depth(${wholesaleEss}<${gate.preferred}); exception_not_met`;
  }
  const novationGatePassed = retailEss >= NOVATION_DEPTH_MIN && Boolean(novationRecommended);

  // ---- Anomaly MATERIALITY (mission Item 5A §9) ----
  // A rejected/quarantined candidate is a TRANSACTION-level anomaly. It only
  // becomes PROPERTY-level (quarantine) when it is material to the decision —
  // i.e. clean evidence is insufficient, contamination reached the pricing set,
  // or suspicious records dominate. Bad rows that were safely ISOLATED while
  // sufficient clean independent evidence remains are warnings, not blockers.
  const cleanAccepted = accepted.length ?? 0;
  const cleanESS = ess;
  const cleanUniverseConfidence = reconciliation.market_confidence ?? 0;
  const quarantined = sample.quarantined_count ?? 0;
  const excludedCount = sample.excluded_count ?? 0;
  const txnAnomalyCount = quarantined + excludedCount;
  const txnAnomalyPresent = flags.length > 0 || txnAnomalyCount > 0;

  // Defensive: accepted comps all passed qualifyTransaction (ACCEPT), so no
  // contaminated price can be in a pricing universe by construction.
  const contaminatedInUniverse = false;

  const materialReasons = [];
  if (!invariants.ok) materialReasons.push('invariant_violation');
  if (contaminatedInUniverse) materialReasons.push('contaminated_price_in_pricing_set');
  if (cleanAccepted === 0) materialReasons.push('no_clean_independent_evidence');
  else if (cleanESS < EXECUTION.MIN_EFFECTIVE_SAMPLE_SIZE) materialReasons.push('clean_ess_below_threshold');
  if (marketClass === VC.SUBJECT_ANCHOR_SCENARIO) materialReasons.push('no_qualified_market_value');
  if (cleanAccepted > 0 && cleanAccepted < EXECUTION.MIN_EFFECTIVE_SAMPLE_SIZE && quarantined > cleanAccepted * 3) {
    materialReasons.push('suspicious_candidates_dominate');
  }
  const material = materialReasons.length > 0;
  const nonmaterialWarnings = !material && txnAnomalyPresent ? flags.map((f) => `isolated:${f}`) : [];

  // ---- Execution state (fail closed) ----
  let executionState;
  const reasons = [];
  if (material) {
    if (!invariants.ok || contaminatedInUniverse) {
      executionState = ES.ANOMALY_QUARANTINE;
      reasons.push('material_contamination_or_invariant_violation');
    } else if (cleanAccepted === 0 && txnAnomalyCount > 0) {
      executionState = ES.ANOMALY_QUARANTINE;
      reasons.push('all_candidate_evidence_quarantined');
    } else if (materialReasons.includes('suspicious_candidates_dominate')) {
      executionState = ES.ANOMALY_QUARANTINE;
      reasons.push('suspicious_candidates_dominate');
    } else {
      executionState = ES.DATA_REQUIRED;
      reasons.push('insufficient_clean_evidence');
    }
  } else if (disagreement > MODEL_DISAGREEMENT_CONF_CAP || marketClass === VC.PROVISIONAL_SCENARIO || final < 45) {
    executionState = ES.REVIEW_REQUIRED;
    reasons.push('model_disagreement_or_provisional_or_low_confidence');
  } else if (cashGatePassed || novationGatePassed) {
    // Qualified value AND a strategy whose dominant-universe depth meets its gate.
    executionState = ES.SHADOW_MODE_READY;
    reasons.push(cashGatePassed ? `cash_depth_gate_passed:${cashGateReason}` : 'novation_depth_gate_passed');
    if (nonmaterialWarnings.length) reasons.push('isolated_anomaly_warnings');
  } else {
    // Qualified market value exists, but no strategy meets its evidence-depth gate
    // (e.g. thin wholesale depth) — review rather than authorize.
    executionState = ES.REVIEW_REQUIRED;
    reasons.push(`no_strategy_meets_depth_gate:${cashGateReason}`);
  }

  const criteriaMet =
    executionState === ES.SHADOW_MODE_READY &&
    cashGatePassed &&
    wholesaleEss >= EXECUTION.MIN_EFFECTIVE_SAMPLE_SIZE &&
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
    transaction_anomaly_present: txnAnomalyPresent,
    transaction_anomaly_count: txnAnomalyCount,
    transaction_anomaly_material: material,
    material_anomaly_reasons: materialReasons,
    nonmaterial_warning_reasons: nonmaterialWarnings,
    // clean depth = wholesale-relevant (investor-compatible) pricing depth only.
    clean_independent_transaction_count: wholesaleEss,
    clean_effective_sample_size: wholesaleEss,
    clean_universe_confidence: cleanUniverseConfidence,
    raw_accepted_transaction_count: cleanAccepted,
    raw_effective_sample_size: cleanESS,
    // ---- Item 5B §0: universe-specific + strategy-specific depth ----
    evidence_depth: {
      investor_pricing_ess: investorEss,
      institutional_pricing_ess: institutionalEss,
      public_pricing_ess: publicEss,
      retail_pricing_ess: retailEss,
      wholesale_pricing_ess: wholesaleEss,
    },
    dominant_model_universe: dominantU?.universe ?? null,
    dominant_model_independent_count: dominantEss,
    dominant_model_ess: dominantEss,
    dominant_model_depth_score: round(clamp((dominantEss / 6) * 100, 0, 100), 1),
    dominant_model_confidence_cap: dominantDepthConfidenceCap(dominantEss),
    strategy_depth_gate: {
      cash: { passed: cashGatePassed, reason: cashGateReason, wholesale_ess: wholesaleEss, preferred: gate.preferred, exception_met: exceptionMet },
      novation: { passed: novationGatePassed, retail_ess: retailEss, min: NOVATION_DEPTH_MIN },
    },
    reasons,
  };
}
