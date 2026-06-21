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
import { buildNovation } from './novationModel.js';
import { buildSubjectTo } from './subjectToModel.js';
import { buildSellerFinance } from './sellerFinanceModel.js';
import { buildConfidenceAndExecution } from './acquisitionConfidence.js';
import { buildStrategyRanking } from './acquisitionStrategyRanking.js';

const EXECUTABLE_STATES = new Set([
  ES.SHADOW_MODE_READY, ES.AUTO_RANGE_READY, ES.AUTO_OFFER_READY, ES.AUTO_CREATIVE_READY,
]);

export function buildV3Decision({ subjectRow = {}, qualification, buyerPurchases = [], now = new Date(), loaderDiagnostics = null }) {
  const classification = classifyAssetLane(subjectRow);
  const { universes, family } = buildValuationUniverses(subjectRow, qualification, buyerPurchases, now);
  const reconciliation = reconcileValuation(universes, family);
  const repair = estimateRepairs(subjectRow, { family });
  reconciliation.repair_immediate = repair.immediate_repairs;

  const buyerExit = buildBuyerExit({ subjectRow, reconciliation, universes, family, buyerPurchases });
  const cashOffer = buildCashOffer({
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
    conservative_buyer_exit: buyerExit.conservative_buyer_exit,
    anchor_value: num(subjectRow.estimated_value),
  });

  const confidence = buildConfidenceAndExecution({
    subjectRow, classification, qualification, reconciliation, universes, repair, buyerExit, invariants,
  });
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
    scenario_source: !cashUnderwritten && cashOffer.available ? 'offerEconomics.buildCashOffer' : null,
    scenario_assumptions:
      !cashUnderwritten && cashOffer.available
        ? ['buyer-exit-anchored bridge', `margin_pct=${cashOffer.margin_pct_used}`, `exit_basis=${reconciliation.investor_exit_classification}`]
        : [],
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
    minimum_acceptable_offer: cashUnderwritten ? cashOffer.target_cash_offer : null,
    maximum_cash_offer: offerAuthorization.authorized_maximum_offer,
    expected_assignment_fee: cashUnderwritten ? cashOffer.projected_assignment_fee : null,
  };

  const v3 = {
    engine_version: ENGINE_VERSION,
    formula_version: FORMULA_VERSION,
    shadow_mode: readFeatureFlag('ACQUISITION_ENGINE_V3_SHADOW_MODE'),
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
