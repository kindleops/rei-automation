/**
 * Acquisition Engine V3 — decision pipeline orchestrator (mission Item 4).
 *
 * Subject + qualified comps ->
 *   universes -> reconciliation -> repair -> buyer exit -> cash offer ->
 *   novation -> subject-to -> seller-finance -> confidence/execution ->
 *   strategy ranking -> surfaced (V2-facing) valuation/offer + audit evidence.
 *
 * The engine calls buildV3Decision and surfaces the result. Authorized offer
 * fields are populated ONLY in an executable state; otherwise figures are
 * scenario-only (under v3.cash_offer) and never presented as approved offers.
 */

import {
  ENGINE_VERSION,
  FORMULA_VERSION,
  EXECUTION_STATES as ES,
  VALUATION_UNIVERSES as U,
  VALUE_CLASSIFICATION as VC,
  readFeatureFlag,
  num,
  roundMoney,
} from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import { assertAcquisitionInvariants } from './acquisitionInvariants.js';
import { buildValuationUniverses } from './valuationUniverses.js';
import { reconcileValuation } from './valuationReconciliation.js';
import { estimateRepairs } from './repairModel.js';
import { buildBuyerExit } from './buyerExitModel.js';
import { buildCashOffer } from './offerEconomics.js';
import { buildLaneOffer } from './v3LaneValuation.js';
import { buildNovation } from './novationModel.js';
import { buildSubjectTo } from './subjectToModel.js';
import { buildSellerFinance } from './sellerFinanceModel.js';
import { buildConfidenceAndExecution } from './acquisitionConfidence.js';
import { buildStrategyRanking } from './acquisitionStrategyRanking.js';
import { buildResidentialIncomeAnalysis, isIncomeFamily } from './residentialIncomeDecision.js';
import { buildSelfStorageAnalysis, isSelfStorageLane } from './selfStorageDecision.js';
import { buildRetailAnalysis, isRetailLane } from './retailDecision.js';
import { buildOfficeAnalysis, isOfficeLane } from './officeDecision.js';
import { buildExecutionStateBasis } from './executionStateBasis.js';

const EXECUTABLE_STATES = new Set([
  ES.SHADOW_MODE_READY, ES.AUTO_RANGE_READY, ES.AUTO_OFFER_READY, ES.AUTO_CREATIVE_READY,
]);

/** MERGED engine identity (V3 structure + v3.1 corpus, comp rules and offer math). */
export const MERGED_ENGINE_VERSION = 'acq-v3-merged';
export const MERGED_FORMULA_VERSION = 'v3.2.0-merged-v31-corpus-comp-offer';
export const OFFER_MODELS = Object.freeze({ MERGED_V31: 'merged_v31', LEGACY_BRIDGE: 'legacy_bridge' });

const FAMILY_OFFER_LANE = { RESIDENTIAL_SINGLE: 'sfr', SMALL_MULTI: 'mf24', MULTIFAMILY: 'mf5' };

/** A multifamily label carrying a unit count <= 1 is not a property fact (engine evidence.subject). */
export function subjectAssetIdentityConflict(subjectRow = {}) {
  const type = String(subjectRow.property_type ?? subjectRow.asset_type ?? '').toLowerCase();
  const units = num(subjectRow.units_count ?? subjectRow.units);
  return /multi|apartment|duplex|triplex|quad/.test(type) && units !== null && units <= 1;
}

/**
 * MERGED authorization gates (2026-10-07), applied BEFORE strategy ranking so a
 * gated property can never carry an authorized offer. Downgrade-only: a state
 * is never raised. Returns the (possibly) downgraded confidence + the gate log.
 */
export function applyMergedGates(confidence, { lane, cashOffer, investorUniverse, assetIdentityConflict, rung = null }) {
  const gates = [];
  if (assetIdentityConflict) gates.push({ code: 'asset_identity_conflict_blocks_authorization', to: ES.REVIEW_REQUIRED });
  if (lane === 'mf24') gates.push({ code: 'mf_2_4_units_human_review', to: ES.REVIEW_REQUIRED });
  if (rung && !['R1', 'R2'].includes(rung)) gates.push({ code: `fallback_rung_${rung}_review_only`, to: ES.REVIEW_REQUIRED });
  if (!cashOffer?.available) gates.push({ code: investorUniverse?.unavailable_reason ?? 'no_qualified_investor_value', to: ES.DATA_REQUIRED });
  for (const r of cashOffer?.reasons ?? []) {
    if (r === 'no_qualified_investor_value' || r === 'no_value_from_any_rung') continue;
    gates.push({ code: r, to: ES.REVIEW_REQUIRED });
  }
  if (!gates.length || !EXECUTABLE_STATES.has(confidence.execution_state)) {
    return { confidence, gates: gates.map((g) => ({ ...g, applied: false })) };
  }
  const to = gates.some((g) => g.to === ES.DATA_REQUIRED) && !assetIdentityConflict ? ES.DATA_REQUIRED : ES.REVIEW_REQUIRED;
  return {
    confidence: {
      ...confidence,
      execution_state: to,
      auto_offer_ready_criteria_met: false,
      auto_offer_eligible: false,
      reasons: [...(confidence.reasons ?? []), ...gates.map((g) => `merged_gate:${g.code}`)],
    },
    gates: gates.map((g) => ({ ...g, applied: true, from: confidence.execution_state, result: to })),
  };
}

/**
 * MERGED cash offer from the lane model (owner rules 2026-10-07), mapped onto
 * the V3 cash-offer contract. NEVER blank: with no lane model (legacy loader)
 * the legacy exit or, last, the subject AVM feeds the same lane offer.
 */
function mergedCashOffer({ laneModel, reconciliation, subjectRow, offerLane, subjectUnits, investorEvidence }) {
  let lo = laneModel?.offer ?? null;
  if (!lo || !lo.available) {
    const exit = num(reconciliation.base_investor_exit);
    const avm = num(subjectRow.estimated_value);
    const rung = exit ? (reconciliation.investor_exit_classification === VC.QUALIFIED ? 'R1' : 'R5') : 'R6';
    lo = buildLaneOffer({
      investorPrice: exit ?? (avm ? avm * 0.75 : null),
      lane: offerLane,
      rung,
      confidence: exit ? reconciliation.investor_exit_confidence : 10,
      grade: exit ? (rung === 'R1' ? 'C' : 'E') : 'F',
      units: subjectUnits,
      unitsSource: 'recorded',
      market: subjectRow.market ?? null,
      env: investorEvidence?.env ?? process.env,
    });
  }
  if (!lo.available) {
    return { available: false, offer_model: 'lane_v1', unavailable_reason: 'no_value_from_any_rung', reasons: lo.reasons ?? ['no_value_from_any_rung'], bridge: [], policy_version: lo.policy_version, rung: null };
  }
  const spread = Math.max(0, (lo.investor_price ?? 0) - (lo.ceiling ?? 0));
  return {
    available: true,
    offer_model: 'lane_v1',
    policy_version: lo.policy_version,
    lane: lo.lane,
    rung: lo.rung,
    confidence_grade: lo.confidence_grade,
    investor_value: lo.investor_price,
    conservative_buyer_exit: lo.investor_price,
    buyer_ceiling: lo.ceiling,
    opening_cash_offer: lo.opening_hint,
    target_cash_offer: lo.ceiling,
    recommended_cash_offer: lo.recommended_cash_offer,
    maximum_cash_offer: lo.ceiling,
    walkaway_cash_price: lo.ceiling,
    minimum_acceptable_offer: lo.opening_hint,
    projected_assignment_fee: spread,
    projected_gross_margin: spread,
    margin_on_exit: lo.investor_price ? Math.round((spread / lo.investor_price) * 10000) / 10000 : null,
    margin_pct_used: lo.margin_pct != null ? lo.margin_pct / 100 : null,
    margin_pct: lo.margin_pct,
    margin_source: lo.margin_source,
    margin_key: lo.margin_key,
    calibration_pct: lo.calibration_pct,
    confidence_haircut_pct: lo.haircut_pct,
    repairs_basis: lo.repairs_basis,
    repairs_evidence: laneModel?.repairs_evidence ?? null,
    sanity: { offer_to_value: lo.offer_to_investor_price, within_bounds: lo.sanity?.within_bounds },
    cost_breakdown: { buyer_repairs: 0, buyer_closing: 0, buyer_holding: 0, buyer_disposition: 0, contingency: 0, acquisition_margin: spread },
    per_unit: lo.per_unit ?? null,
    bridge: lo.bridge,
    reasons: lo.reasons ?? [],
  };
}

export function buildV3Decision({
  subjectRow = {},
  qualification,
  buyerPurchases = [],
  now = new Date(),
  loaderDiagnostics = null,
  income = {},
  storage = {},
  retail = {},
  office = {},
  // MERGED (2026-10-07): canonical corpus rows for the v3.1 investor rules
  // ({ subject, rows, bulkRows|bulkOf, asOf, gate }); null => V3 legacy universe.
  investorEvidence = null,
  // 'merged_v31' (default; the authority candidate) | 'legacy_bridge' (the
  // pre-merge exit - repairs - 13% costs - margin bridge, kept for comparison).
  offerModel = OFFER_MODELS.MERGED_V31,
  assetIdentityConflict = null,
  // 'shadow' | 'live' — recorded only; the engine decides where the block goes.
  authorityMode = null,
}) {
  const classification = classifyAssetLane(subjectRow);
  const merged = offerModel !== OFFER_MODELS.LEGACY_BRIDGE;
  const { universes, family } = buildValuationUniverses(subjectRow, qualification, buyerPurchases, now, { investorEvidence });
  const reconciliation = reconcileValuation(universes, family);
  const repair = estimateRepairs(subjectRow, { family });
  reconciliation.repair_immediate = repair.immediate_repairs;

  const buyerExit = buildBuyerExit({ subjectRow, reconciliation, universes, family, buyerPurchases });
  const investorUniverse = universes[U.LOCAL_INVESTOR_VALUE] ?? null;
  const laneModel = investorUniverse?.lane_model ?? null;
  const offerLane = laneModel?.lane ?? investorUniverse?.lane ?? FAMILY_OFFER_LANE[family] ?? 'sfr';
  const subjectUnits = num(laneModel?.identity?.units) ?? num(investorEvidence?.subject?.units) ?? num(subjectRow.units_count);
  const cashOffer = merged
    ? mergedCashOffer({ laneModel, reconciliation, subjectRow, offerLane, subjectUnits, investorEvidence })
    : buildCashOffer({
        conservativeBuyerExit: buyerExit.conservative_buyer_exit,
        repair,
        family,
        buyerDemand: buyerExit.buyer_demand_score,
        confidence: reconciliation.investor_exit_confidence,
        expectedDays: buyerExit.expected_days_to_disposition,
      });

  const marketRent = num(subjectRow.monthly_rent) ?? num(subjectRow.rent_estimate);
  const cashSellerNet = cashOffer.available ? roundMoney(cashOffer.recommended_cash_offer * 0.99) : null;
  const novation = buildNovation({
    retailUniverse: universes[U.RETAIL_MLS_VALUE],
    subjectRow,
    cashSellerNet,
    buyerDemand: buyerExit.buyer_demand_score,
  });
  const subjectTo = buildSubjectTo({ subjectRow, marketRentMonthly: marketRent, reconciliation });
  const sellerFinance = buildSellerFinance({ reconciliation, subjectRow, marketRentMonthly: marketRent, family });

  const invariants = assertAcquisitionInvariants({
    valuation_low: reconciliation.reconciled_market_value_low,
    valuation_mid: reconciliation.reconciled_market_value_mid,
    valuation_high: reconciliation.reconciled_market_value_high,
    recommended_cash_offer: cashOffer.recommended_cash_offer,
    maximum_cash_offer: cashOffer.maximum_cash_offer,
    // Merged: the cap on our maximum is the end investor's as-is ceiling.
    conservative_buyer_exit: merged && cashOffer.available ? cashOffer.buyer_ceiling : buyerExit.conservative_buyer_exit,
    anchor_value: num(subjectRow.estimated_value),
  });

  const baseConfidence = buildConfidenceAndExecution({
    subjectRow, classification, qualification, reconciliation, universes, repair, buyerExit, invariants,
    novationRecommended: novation.novation_recommended,
  });
  const identityConflict = assetIdentityConflict ?? subjectAssetIdentityConflict(subjectRow);
  const { confidence, gates: mergedGates } = merged
    ? applyMergedGates(baseConfidence, { lane: offerLane, cashOffer, investorUniverse, assetIdentityConflict: identityConflict || laneModel?.identity?.identity_conflict === true, rung: cashOffer.rung ?? null })
    : { confidence: baseConfidence, gates: [] };
  const strategy = buildStrategyRanking({
    cashOffer,
    novation,
    subjectTo,
    sellerFinance,
    executionState: confidence.execution_state,
    reconciliation,
    autoOfferEligible: confidence.auto_offer_eligible,
    autoCreativeEligible: readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE'),
  });

  // ---- Item 5B: additive residential-income analysis (income families only) ----
  const residentialIncome = isIncomeFamily(family)
    ? buildResidentialIncomeAnalysis({
        subjectRow,
        qualification,
        universes,
        repair,
        family,
        lane: classification.lane,
        income,
        buyerPurchases,
        finalConfidence: confidence.final_confidence,
      })
    : null;

  // ---- Item 5D: additive self-storage analysis (SELF_STORAGE lane only) ----
  const selfStorage = isSelfStorageLane(classification.lane)
    ? buildSelfStorageAnalysis({
        subjectRow,
        storage: storage.subject ?? storage,
        storageComps: storage.comps ?? [],
        storageBuyers: storage.buyers ?? [],
        capRateEvidence: storage.cap_rate_evidence ?? [],
        market: storage.market ?? {},
        competitors: storage.competitors ?? null,
        pipeline: storage.pipeline ?? null,
        repairInputs: storage.repair_inputs ?? {},
      })
    : null;

  // ---- Item 5E: additive retail analysis (RETAIL_* lanes only) ----
  const retailAnalysis = isRetailLane(classification.lane)
    ? buildRetailAnalysis({
        subjectRow,
        retail: retail.subject ?? retail,
        retailComps: retail.comps ?? [],
        retailBuyers: retail.buyers ?? [],
        capRateEvidence: retail.cap_rate_evidence ?? [],
        market: retail.market ?? {},
        competingCenters: retail.competing_centers ?? null,
        pipeline: retail.pipeline ?? null,
        repairInputs: retail.repair_inputs ?? {},
      })
    : null;

  // ---- Item 5F: additive office & medical-office analysis (OFFICE_* lanes only) ----
  const officeAnalysis = isOfficeLane(classification.lane)
    ? buildOfficeAnalysis({
        subjectRow,
        office: office.subject ?? office,
        officeComps: office.comps ?? [],
        officeBuyers: office.buyers ?? [],
        capRateEvidence: office.cap_rate_evidence ?? [],
        market: office.market ?? {},
        competingVacancy: office.competing_vacancy ?? null,
        pipeline: office.pipeline ?? null,
        repairInputs: office.repair_inputs ?? {},
      })
    : null;

  // ---- Item 5C §10: explicit, strategy-specific execution-state basis ----
  const executionStateBasis = buildExecutionStateBasis({
    ranked: strategy.ranked,
    executionState: confidence.execution_state,
    primaryStrategy: strategy.primary_strategy,
  });

  const isExecutable = EXECUTABLE_STATES.has(confidence.execution_state);

  // ---- Authorized vs scenario monetary contract (Item 4.5 §3) ----
  const cashEntry = strategy.ranked.find((s) => s.strategy === 'CASH');
  const cashUnderwritten = Boolean(cashEntry?.authorized_offer); // EXECUTABLE or UNDERWRITTEN_SHADOW
  const marketQualified = reconciliation.market_value_classification === VC.QUALIFIED;
  const exitQualified = reconciliation.investor_exit_classification === VC.QUALIFIED;

  const offerAuthorization = {
    authorized_opening_offer: cashUnderwritten ? cashOffer.opening_cash_offer : null,
    authorized_recommended_offer: cashUnderwritten ? cashOffer.recommended_cash_offer : null,
    authorized_maximum_offer: cashUnderwritten ? cashOffer.maximum_cash_offer : null,
    authorized_walkaway_price: cashUnderwritten ? cashOffer.walkaway_cash_price : null,
    scenario_opening_offer: !cashUnderwritten && cashOffer.available ? cashOffer.opening_cash_offer : null,
    scenario_recommended_offer: !cashUnderwritten && cashOffer.available ? cashOffer.recommended_cash_offer : null,
    scenario_maximum_offer: !cashUnderwritten && cashOffer.available ? cashOffer.maximum_cash_offer : null,
    scenario_walkaway_price: !cashUnderwritten && cashOffer.available ? cashOffer.walkaway_cash_price : null,
    scenario_source: !cashUnderwritten && cashOffer.available ? (merged ? 'offerEconomics.buildCashOfferMerged' : 'offerEconomics.buildCashOffer') : null,
    scenario_assumptions:
      !cashUnderwritten && cashOffer.available
        ? merged
          ? ['lane offer: investor price x (1-calibration) x (1-margin) x (1-haircut); repairs only in the ARV rung', `lane=${cashOffer.lane}`, `rung=${cashOffer.rung}`, `grade=${cashOffer.confidence_grade}`, `margin_pct=${cashOffer.margin_pct}(${cashOffer.margin_source})`]
          : ['buyer-exit-anchored bridge', `margin_pct=${cashOffer.margin_pct_used}`, `exit_basis=${reconciliation.investor_exit_classification}`]
        : [],
    // The end investor's as-is MAO (merged) — the negotiation CEILING. Null when not underwritten.
    authorized_buyer_ceiling: cashUnderwritten && merged ? cashOffer.buyer_ceiling ?? null : null,
    scenario_buyer_ceiling: !cashUnderwritten && merged && cashOffer.available ? cashOffer.buyer_ceiling ?? null : null,
  };

  const valueContract = {
    qualified_market_value: marketQualified
      ? { low: reconciliation.reconciled_market_value_low, mid: reconciliation.reconciled_market_value_mid, high: reconciliation.reconciled_market_value_high }
      : null,
    scenario_market_value: marketQualified
      ? null
      : {
          low: reconciliation.reconciled_market_value_low,
          mid: reconciliation.reconciled_market_value_mid,
          high: reconciliation.reconciled_market_value_high,
          source: reconciliation.market_value_classification,
          assumptions: reconciliation.reasoning,
        },
    qualified_buyer_exit: exitQualified
      ? { conservative: reconciliation.conservative_investor_exit, base: reconciliation.base_investor_exit, optimistic: reconciliation.optimistic_investor_exit }
      : null,
    scenario_buyer_exit: exitQualified
      ? null
      : {
          conservative: reconciliation.conservative_investor_exit,
          base: reconciliation.base_investor_exit,
          optimistic: reconciliation.optimistic_investor_exit,
          source: reconciliation.investor_exit_classification,
          derived_from: reconciliation.investor_exit_derived_from,
        },
  };

  const surfacedOffer = {
    recommended_cash_offer: offerAuthorization.authorized_recommended_offer,
    minimum_acceptable_offer: cashUnderwritten ? (merged ? cashOffer.minimum_acceptable_offer : cashOffer.target_cash_offer) : null,
    buyer_ceiling: cashUnderwritten && merged ? cashOffer.buyer_ceiling ?? null : null,
    maximum_cash_offer: offerAuthorization.authorized_maximum_offer,
    expected_assignment_fee: cashUnderwritten ? cashOffer.projected_assignment_fee : null,
  };

  const v3 = {
    engine_version: merged ? MERGED_ENGINE_VERSION : ENGINE_VERSION,
    formula_version: merged ? MERGED_FORMULA_VERSION : FORMULA_VERSION,
    shadow_mode: readFeatureFlag('ACQUISITION_ENGINE_V3_SHADOW_MODE'),
    authority_mode: authorityMode,
    merged: merged
      ? {
          offer_model: cashOffer.offer_model ?? OFFER_MODELS.MERGED_V31,
          offer_policy_version: cashOffer.policy_version ?? null,
          lane: offerLane,
          rung: cashOffer.rung ?? null,
          rung_name: laneModel?.rung_name ?? null,
          confidence_grade: cashOffer.confidence_grade ?? null,
          margin_pct: cashOffer.margin_pct ?? null,
          margin_source: cashOffer.margin_source ?? null,
          margin_key: cashOffer.margin_key ?? null,
          identity: laneModel?.identity ?? null,
          ladder: laneModel?.ladder ?? [],
          institutional: laneModel?.institutional ?? null,
          retail_arv: laneModel?.retail_arv ?? null,
          flipper_signal: laneModel?.flipper_signal ?? null,
          noi_cross_check: laneModel?.noi_cross_check ?? null,
          condition_position: laneModel?.condition_position ?? null,
          evidence_ids: laneModel?.evidence_ids ?? [],
          investor_rules: investorUniverse?.model === 'merged_investor_rules' ? investorUniverse.rules_version : 'v3_legacy_universe_no_canonical_rows',
          investor_method: investorUniverse?.method ?? null,
          offer_lane: offerLane,
          asset_identity_conflict: identityConflict,
          gates: mergedGates,
          per_unit: cashOffer.per_unit ?? null,
          per_door_value: investorUniverse?.per_door ?? null,
          investor_value: cashOffer.investor_value ?? null,
          buyer_ceiling: cashOffer.buyer_ceiling ?? null,
          repairs_basis: cashOffer.repairs_basis ?? null,
          repairs_evidence: cashOffer.repairs_evidence ?? null,
        }
      : null,
    canonical_asset_lane: classification.lane,
    asset_lane_confidence: classification.confidence,
    asset_lane_reasoning: classification.reasoning,
    conflicting_asset_signals: classification.conflicting_signals,
    family,
    anchors: qualification.anchors,
    sample: qualification.sample,
    anomaly_flags: qualification.anomaly_flags,
    universes,
    reconciliation,
    repair,
    buyer_exit: buyerExit,
    cash_offer: cashOffer,
    novation,
    subject_to: subjectTo,
    seller_finance: sellerFinance,
    strategy_ranking: strategy,
    execution_state_basis: executionStateBasis,
    offer_authorization: offerAuthorization,
    value_contract: valueContract,
    confidence_components: confidence.components,
    final_confidence: confidence.final_confidence,
    execution_state: confidence.execution_state,
    value_classification: confidence.value_classification,
    auto_offer_ready_criteria_met: confidence.auto_offer_ready_criteria_met,
    auto_offer_eligible: confidence.auto_offer_eligible,
    // Item 5A: transaction-level vs property-level anomaly materiality.
    transaction_anomaly_present: confidence.transaction_anomaly_present,
    transaction_anomaly_count: confidence.transaction_anomaly_count,
    transaction_anomaly_material: confidence.transaction_anomaly_material,
    material_anomaly_reasons: confidence.material_anomaly_reasons,
    nonmaterial_warning_reasons: confidence.nonmaterial_warning_reasons,
    clean_independent_transaction_count: confidence.clean_independent_transaction_count,
    clean_effective_sample_size: confidence.clean_effective_sample_size,
    clean_universe_confidence: confidence.clean_universe_confidence,
    raw_accepted_transaction_count: confidence.raw_accepted_transaction_count,
    raw_effective_sample_size: confidence.raw_effective_sample_size,
    // Preflight §3: six explicitly-named, separate-semantics counts.
    total_clean_accepted_transaction_count: confidence.total_clean_accepted_transaction_count,
    total_clean_effective_sample_size: confidence.total_clean_effective_sample_size,
    wholesale_pricing_independent_count: confidence.wholesale_pricing_independent_count,
    wholesale_pricing_ess: confidence.wholesale_pricing_ess,
    dominant_universe_independent_count: confidence.dominant_universe_independent_count,
    dominant_universe_ess: confidence.dominant_universe_ess,
    // Item 5B §0: universe-specific + strategy-specific evidence depth.
    evidence_depth: confidence.evidence_depth,
    dominant_model_universe: confidence.dominant_model_universe,
    dominant_model_ess: confidence.dominant_model_ess,
    dominant_model_depth_score: confidence.dominant_model_depth_score,
    dominant_model_confidence_cap: confidence.dominant_model_confidence_cap,
    strategy_depth_gate: confidence.strategy_depth_gate,
    // Item 5B: residential-income specialization (null for non-income families).
    residential_income: residentialIncome,
    // Item 5D: self-storage specialization (null for non-storage lanes).
    self_storage: selfStorage,
    // Item 5E: retail & strip-center specialization (null for non-retail lanes).
    retail: retailAnalysis,
    // Item 5F: office & medical-office specialization (null for non-office lanes).
    office: officeAnalysis,
    loader_diagnostics: loaderDiagnostics,
    invariants,
    clusters: (qualification.clusters_summary ?? []).slice(0, 50),
    rejected_comps: (qualification.rejected ?? []).slice(0, 50),
    active_feature_flags: {
      ACQUISITION_ENGINE_V3_ENABLED: true,
      ACQUISITION_ENGINE_V3_SHADOW_MODE: readFeatureFlag('ACQUISITION_ENGINE_V3_SHADOW_MODE'),
      ACQUISITION_ENGINE_V3_ALLOW_PERSIST: readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_PERSIST'),
      ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER: readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER'),
      ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE: readFeatureFlag('ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE'),
    },
  };

  return {
    v3,
    surfaced: {
      valuation_low: reconciliation.reconciled_market_value_low,
      valuation_mid: reconciliation.reconciled_market_value_mid,
      valuation_high: reconciliation.reconciled_market_value_high,
      market_value_classification: reconciliation.market_value_classification,
      market_confidence: reconciliation.market_confidence,
      ...surfacedOffer,
      authorized: confidence.auto_offer_eligible,
      offer_summary: {
        execution_state: confidence.execution_state,
        value_classification: confidence.value_classification,
        cash_offer_bridge: cashOffer.bridge ?? [],
        scenario_note: isExecutable
          ? null
          : 'Non-executable state: cash figures are scenario-only under v3.cash_offer; NOT authorized offers.',
      },
    },
  };
}
