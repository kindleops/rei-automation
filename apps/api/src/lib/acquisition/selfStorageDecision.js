/**
 * Acquisition Engine V3 — Item 5D: self-storage analysis orchestrator.
 *
 * Runs ONLY for the SELF_STORAGE lane. Produces an additive `self_storage`
 * analysis block (contract, operational classification, unit-mix, revenue,
 * expenses, NOI, cap-rate, comparables, valuation, expansion, capital, market
 * context, buyer-exit, strategies, qualification and an explicit, strategy-
 * specific execution-state basis) WITHOUT altering the generic V2/residential
 * flow — so non-storage behavior and the V2-disabled path stay byte-identical.
 *
 * All outbound and AUTO execution remain disabled. Pure & deterministic.
 */

import { ASSET_LANES, EXECUTION_STATES as ES, STRATEGY_QUALIFICATION as SQ, num, round } from './modelConstants.js';
import { buildExecutionStateBasis } from './executionStateBasis.js';
import { buildSelfStorageContract, storageMissingInputs } from './selfStorageContract.js';
import { classifyStorageOperationalStatus } from './selfStorageClassification.js';
import {
  buildStorageRevenue, buildStorageExpenses, buildStorageNOI, buildStorageCapRate,
} from './selfStorageUnderwriting.js';
import { buildStorageComparables, buildStorageMarketContext } from './selfStorageComps.js';
import { buildStorageValuation, buildStorageCapital } from './selfStorageValuation.js';
import { buildStorageBuyerExit } from './selfStorageBuyerExit.js';
import {
  buildStorageCashOffer, buildStorageSellerFinance, buildStorageCommercialDebt,
  buildStorageDisposition, qualifyStorageStrategies,
} from './selfStorageStrategies.js';

export function isSelfStorageLane(lane) {
  return lane === ASSET_LANES.SELF_STORAGE;
}

export function buildSelfStorageAnalysis({
  subjectRow = {},
  storage = {},
  storageComps = [],
  storageBuyers = [],
  capRateEvidence = [],
  market = {},
  competitors = null,
  pipeline = null,
  repairInputs = {},
} = {}) {
  const contract = buildSelfStorageContract(subjectRow, storage);
  if (!contract.is_self_storage) return null;

  // ---- Operational status ----
  const opStatus = classifyStorageOperationalStatus({ facility: storage.operations ?? {}, contract });
  contract.identity.operational_status = {
    value: opStatus.operational_status, basis: 'SYSTEM_INFERRED',
    confidence: opStatus.confidence, source: 'classifyStorageOperationalStatus',
  };
  const facilityType = contract.identity.facility_type?.value ?? 'UNKNOWN';
  const facilityClass = contract.identity.facility_class?.value ?? 'UNKNOWN';

  // ---- Comparables (income-independent) ----
  const comparables = buildStorageComparables(storageComps, { subjectFacilityClass: facilityClass });

  // Rough comp-anchored value for the tax basis only (does not feed valuation).
  const nrsf = num(contract.physical.net_rentable_square_feet?.value);
  const stabComps = comparables.universes.stabilized_storage ?? [];
  const ppnrsfMed = stabComps.length
    ? median(stabComps.map((c) => num(c.price_per_nrsf)).filter((v) => v !== null))
    : null;
  const taxBasisValue = ppnrsfMed !== null && nrsf !== null ? ppnrsfMed * nrsf : null;

  // ---- Income chain ----
  const revenue = buildStorageRevenue(contract);
  const expenses = buildStorageExpenses(contract, {
    facilityType, egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: taxBasisValue,
  });
  const noi = buildStorageNOI({ revenue, expenses, contract });
  noi.income_supported = noi.income_supported && expenses.confidence >= 0; // keep flag explicit

  const capRate = buildStorageCapRate({
    facilityClass,
    observedEvidence: capRateEvidence,
    impliedNoi: noi.current_noi?.noi ?? null,
    impliedValue: taxBasisValue,
    occupancy: revenue.physical_occupancy,
    economicOccupancy: revenue.economic_occupancy,
    climateControlPct: num(contract.physical.climate_control_percentage?.value),
    yearBuilt: num(contract.identity.year_built?.value),
    marketTier: market.tier ?? 'SECONDARY',
    buyerDepth: storageBuyers.length >= 4 ? 'DEEP' : storageBuyers.length === 0 ? 'THIN' : 'MODERATE',
    hasExpansion: Boolean(num(contract.development.expansion_capacity_nrsf?.value)),
  });

  // ---- Valuation, capital, market, buyer exit ----
  const valuation = buildStorageValuation({
    contract, noi, revenue, capRate, comparables, operationalStatus: opStatus.operational_status,
  });
  const capital = buildStorageCapital(contract, { repairInputs });
  const marketContext = buildStorageMarketContext({ market, competitors, pipeline });
  const buyerExit = buildStorageBuyerExit({
    valuation, comparables, buyers: storageBuyers, operationalStatus: opStatus.operational_status,
  });

  // ---- Strategies ----
  const cash = buildStorageCashOffer({
    buyerExit, capital, noi, operationalStatus: opStatus.operational_status,
    demand: buyerExit.buyer_demand_score, confidence: valuation.reconciliation.value_classification === 'QUALIFIED' ? 60 : 30,
  });
  const sellerFinance = buildStorageSellerFinance({ valuation, noi, capitalRequired: capital.one_time_capital ?? 0 });
  const commercialDebt = buildStorageCommercialDebt({ contract, noi });
  const disposition = buildStorageDisposition({ valuation, buyerExit, cashRecommended: cash.recommended_cash_offer });
  const strategies = { cash, seller_finance: sellerFinance, commercial_debt: commercialDebt, disposition };

  // ---- Qualification (class-first) ----
  const qualification = qualifyStorageStrategies({
    classification: contract.classification, contract, valuation, noi, revenue, capRate,
    buyerExit, capital, strategies,
  });

  // ---- Storage-specific execution state + explicit basis (§17) ----
  const anyProvisional = qualification.ranked.some((r) => r.qualification_status === SQ.PROVISIONAL_SCENARIO);
  const executionState = qualification.shadow_mode_ready
    ? ES.SHADOW_MODE_READY
    : anyProvisional ? ES.REVIEW_REQUIRED : ES.DATA_REQUIRED;

  const primaryStrategy = qualification.ranked.find((r) => r.qualification_status === SQ.UNDERWRITTEN_SHADOW)?.strategy ?? null;
  const executionStateBasis = buildExecutionStateBasis({
    ranked: qualification.ranked, executionState, primaryStrategy,
  });

  return {
    lane: ASSET_LANES.SELF_STORAGE,
    is_self_storage: true,
    genuine_facility: contract.genuine_facility,
    classification: contract.classification,
    operational_status: opStatus,
    facility_type: facilityType,
    facility_class: facilityClass,
    contract,
    contract_completeness: contract.completeness,
    missing_inputs: storageMissingInputs(contract),
    unit_mix: contract.unit_inventory.unit_mix?.value ?? null,
    revenue,
    expenses,
    noi,
    cap_rate: capRate,
    comparables,
    valuation,
    expansion: valuation.expansion,
    capital,
    market_context: marketContext,
    buyer_exit: buyerExit,
    strategies,
    strategy_qualification: qualification,
    execution_state: executionState,
    execution_state_basis: executionStateBasis,
    // Explicit, repeated for consumers: no AUTO / outbound here.
    auto_execution_enabled: false,
    outbound_enabled: false,
  };
}

function median(arr) {
  const a = (arr ?? []).filter((v) => v !== null && v !== undefined);
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
