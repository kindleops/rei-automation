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
import { STORAGE_RECORD_CLASS as RC, STORAGE_READINESS as RD } from './selfStorageConstants.js';
import { buildSelfStorageContract, storageMissingInputs } from './selfStorageContract.js';
import { classifyStorageOperationalStatus, classifyStorageRecord } from './selfStorageClassification.js';
import {
  buildStorageRevenue, buildStorageExpenses, buildStorageNOI, buildStorageCapRate,
} from './selfStorageUnderwriting.js';
import { buildStorageComparables, buildStorageMarketContext } from './selfStorageComps.js';
import { buildStorageValuation, buildStorageCapital } from './selfStorageValuation.js';
import { buildStorageBuyerExit } from './selfStorageBuyerExit.js';
import {
  buildStorageCashOffer, buildStorageSellerFinance, buildStorageCommercialDebt,
  buildStorageDisposition, qualifyStorageStrategies, buildStorageExecutionBasis,
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

  // ---- Record-class gate (Item 5D.5 §4, §7): is this a genuine, pricing-
  // eligible facility, or garage/condo/accessory/ambiguous noise? A binary
  // is_storage flag alone is never sufficient. ----
  const ops = storage.operations ?? {};
  const inc = storage.income ?? {};
  const expIn = storage.expenses ?? {};
  const hasOperatingData = Boolean(
    ops.physical_occupancy != null || ops.economic_occupancy != null ||
    inc.base_rental_income != null || inc.average_in_place_rent != null ||
    expIn.total_operating_expenses != null || Object.keys(expIn).length > 0,
  );
  const recordClass = classifyStorageRecord(
    { ...subjectRow, ...(storage.net_rentable_square_feet != null ? { net_rentable_square_feet: storage.net_rentable_square_feet } : {}), ...(storage.unit_inventory?.total_units != null ? { total_units: storage.unit_inventory.total_units } : {}), climate_control_percentage: ops.climate_control_percentage },
    { hasOperatingData },
  );

  // NOT_SELF_STORAGE routes away from the storage engine entirely.
  if (recordClass.classification === RC.NOT_SELF_STORAGE) return null;
  const recordGated = !recordClass.underwriting_eligible;

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
    buyerExit, capital, strategies, recordGated, liveFlagsEnabled: false,
  });

  // ---- Storage execution state + explicit basis (§17, Item 5D.5 §2) ----
  // A gated (non-pricing-eligible) record is always DATA_REQUIRED — it never
  // invokes a confirmed-facility shadow state.
  const anyProvisional = qualification.ranked.some((r) => r.qualification_status === SQ.PROVISIONAL_SCENARIO);
  const executionState = recordGated
    ? ES.DATA_REQUIRED
    : qualification.shadow_mode_ready
      ? ES.SHADOW_MODE_READY
      : anyProvisional ? ES.REVIEW_REQUIRED : ES.DATA_REQUIRED;

  const executionStateBasis = buildStorageExecutionBasis({
    ranked: qualification.ranked, executionState, liveFlagsEnabled: false,
  });

  // ---- Production-readiness classification (Item 5D.5 §6) ----
  const productionReadiness = assessStorageProductionReadiness({
    recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext,
  });

  return {
    lane: ASSET_LANES.SELF_STORAGE,
    is_self_storage: true,
    genuine_facility: contract.genuine_facility,
    classification: contract.classification,
    record_class: recordClass,
    pricing_eligible: recordClass.pricing_eligible,
    underwriting_eligible: recordClass.underwriting_eligible,
    decision_gate: {
      record_gated: recordGated,
      reason: recordGated ? `record_class=${recordClass.classification}` : null,
      routed_to_storage_engine: true,
    },
    production_readiness: productionReadiness,
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

/**
 * Production-readiness classification (Item 5D.5 §6). Reports the data-sufficiency
 * ceiling for THIS subject plus the exact blockers. Never labels the model
 * production-pricing calibrated without real qualified data; AUTONOMOUS_READY is
 * never returned while execution flags are disabled.
 */
export function assessStorageProductionReadiness({ recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext }) {
  const classificationReliable = Boolean(recordClass?.underwriting_eligible);
  const hasNrsf = num(contract?.physical?.net_rentable_square_feet?.value) !== null;
  const nrsfModeledOnly = hasNrsf && contract.physical.net_rentable_square_feet.basis === 'MARKET_MODELED';
  const hasUnits = num(contract?.unit_inventory?.total_units?.value) !== null;
  const hasOccupancy = revenue?.physical_occupancy !== null && revenue?.physical_occupancy !== undefined;
  const hasRevenue = num(revenue?.current_actual_base_annual) !== null && revenue?.current_base_basis === 'ACTUAL';
  const hasExpenses = (noi?.income_supported ?? false);
  const hasNoi = Boolean(noi?.income_supported);
  const hasCapEvidence = capRate?.selected?.kind === 'OBSERVED' && capRate.selected.qualified;
  const hasQualifiedSales = (comparables?.qualified_count ?? 0) >= 3;
  const hasBuyerIdentity = (buyerExit?.matched_buyer_count ?? 0) > 0;
  const hasMarketSupply = (marketContext?.supply_risk_status ?? 'UNAVAILABLE') !== 'UNAVAILABLE';

  const blockers = {
    classification_reliability: classificationReliable ? null : `record_class=${recordClass?.classification} (confidence ${recordClass?.confidence})`,
    nrsf: hasNrsf ? (nrsfModeledOnly ? 'MODELED_FROM_GBA_ONLY' : null) : 'MISSING',
    units: hasUnits ? null : 'MISSING',
    occupancy: hasOccupancy ? null : 'MISSING',
    revenue: hasRevenue ? null : 'MISSING',
    expenses: hasExpenses ? null : 'MISSING_OR_MODELED',
    noi: hasNoi ? null : 'NOT_INCOME_SUPPORTED',
    cap_rate_evidence: hasCapEvidence ? null : 'NO_OBSERVED_CAP',
    qualified_sales: hasQualifiedSales ? null : 'NONE',
    buyer_identity: hasBuyerIdentity ? null : 'NONE',
    market_supply_data: hasMarketSupply ? null : 'UNAVAILABLE',
  };

  // Architecture / data-model / deterministic-fixture validation are established
  // facts of the build (see test suite); they are reported as always-true flags.
  const applicable = [RD.ARCHITECTURE_VALIDATED, RD.DATA_MODEL_READY, RD.DETERMINISTIC_FIXTURE_VALIDATED];
  if (!classificationReliable) applicable.push(RD.LIVE_CLASSIFICATION_PARTIAL);
  if (!hasQualifiedSales) applicable.push(RD.LIVE_TRANSACTION_DATA_UNAVAILABLE);
  if (!hasNoi) applicable.push(RD.LIVE_OPERATING_DATA_UNAVAILABLE);

  let status;
  if (!classificationReliable) {
    status = RD.LIVE_CLASSIFICATION_PARTIAL;
  } else if (hasNoi && hasCapEvidence && hasQualifiedSales && hasBuyerIdentity) {
    status = RD.PRODUCTION_SHADOW_READY; // shadow only — never autonomous
    applicable.push(RD.PRODUCTION_SHADOW_READY);
  } else if (hasQualifiedSales || hasNoi) {
    status = RD.SHADOW_SCENARIO_ONLY;
    applicable.push(RD.SHADOW_SCENARIO_ONLY);
  } else {
    status = RD.PRODUCTION_PRICING_NOT_CALIBRATED;
    applicable.push(RD.PRODUCTION_PRICING_NOT_CALIBRATED);
  }

  return {
    status,
    applicable_states: [...new Set(applicable)],
    autonomous_ready: false,
    blockers,
    active_blockers: Object.entries(blockers).filter(([, v]) => v !== null).map(([k, v]) => `${k}:${v}`),
  };
}
