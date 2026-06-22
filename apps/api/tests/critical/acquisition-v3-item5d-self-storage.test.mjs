/**
 * Acquisition Engine V3 — Item 5D self-storage intelligence & underwriting.
 *
 * Deterministic, source-traceable storage model: classification isolation,
 * unit-mix normalization, revenue/expense/NOI/cap separation, valuation method
 * monotonicity, comparable-universe rules, expansion/capital discipline,
 * buyer-exit routing, class-first strategy qualification, explicit execution-
 * state basis, additivity (V2 byte-identical when storage is absent), and the
 * disabled-execution invariant.
 *
 * Production reality (audit §1–§4): there is NO storage operating data and NO
 * storage transaction comp in production, so qualified paths are exercised with
 * clearly-labeled deterministic fixtures, never a production sample.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_LANES, STRATEGY_QUALIFICATION as SQ } from '@/lib/acquisition/modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from '@/lib/acquisition/incomeSnapshotContract.js';
import { classifySelfStorageFacility, classifyStorageOperationalStatus, classifyStorageRecord } from '@/lib/acquisition/selfStorageClassification.js';
import { STORAGE_RECORD_CLASS, OPERATING_FACILITY_MIN_CONFIDENCE } from '@/lib/acquisition/selfStorageConstants.js';
import { tierMonetary, qualifyStorageStrategies, buildStorageExecutionBasis } from '@/lib/acquisition/selfStorageStrategies.js';
import { buildSelfStorageContract, normalizeUnitMix } from '@/lib/acquisition/selfStorageContract.js';
import {
  buildStorageRevenue, buildStorageExpenses, buildStorageNOI, buildStorageCapRate,
  qualifyObservedStorageCap, STORAGE_CAP_KIND,
} from '@/lib/acquisition/selfStorageUnderwriting.js';
import { qualifyStorageComp, buildStorageComparables, STORAGE_COMP_UNIVERSE, buildStorageMarketContext } from '@/lib/acquisition/selfStorageComps.js';
import { buildStorageValuation, buildStorageExpansionValue, buildStorageCapital } from '@/lib/acquisition/selfStorageValuation.js';
import { buildStorageBuyerExit } from '@/lib/acquisition/selfStorageBuyerExit.js';
import { buildStorageCommercialDebt, buildStorageDisposition } from '@/lib/acquisition/selfStorageStrategies.js';
import { buildSelfStorageAnalysis } from '@/lib/acquisition/selfStorageDecision.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { STORAGE_DISPOSITION_STRATEGY, STORAGE_DEBT_MODEL } from '@/lib/acquisition/selfStorageConstants.js';

/* -------------------------------------------------------------------------- */
/* Fixtures (clearly-labeled, deterministic — NOT a production sample)         */
/* -------------------------------------------------------------------------- */

function stabilizedSubjectRow() {
  return {
    property_id: 'ss-stable', property_type: 'Self Storage Facility climate controlled',
    is_storage: true, building_square_feet: 60000, lot_square_feet: 130000,
    year_built: 2014, property_address_state: 'TX',
  };
}

function stabilizedStorageInputs() {
  return {
    net_rentable_square_feet: 52000,
    operations: { physical_occupancy: 0.91, economic_occupancy: 0.88, climate_control_percentage: 0.6 },
    income: {
      average_in_place_rent: 110, average_street_rent: 120, average_market_rent: 125,
      base_rental_income: 600000, tenant_insurance_income: 18000, late_fees: 9000,
    },
    expenses: { taxes: 70000, insurance: 12000, payroll: 40000, management: 36000, utilities: 30000, repairs: 18000 },
    unit_inventory: { total_units: 520, occupied_units: 473 },
  };
}

function qualifiedComps() {
  return [
    { property_type: 'self storage', sale_price: 5200000, building_square_feet: 50000, units_count: 500, occupancy: 0.9, property_address_state: 'TX', sale_date: '2025-09-01', revenue: 540000 },
    { property_type: 'self storage', sale_price: 4800000, building_square_feet: 48000, units_count: 480, occupancy: 0.88, property_address_state: 'TX', sale_date: '2025-07-01', revenue: 500000 },
    { property_type: 'self storage', sale_price: 6100000, building_square_feet: 58000, units_count: 560, occupancy: 0.92, property_address_state: 'TX', sale_date: '2025-10-01', revenue: 630000 },
  ];
}

function observedCapEvidence() {
  return [
    { sale_price: 5200000, observed_noi: 364000, exact_self_storage: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 4800000, observed_noi: 336000, exact_self_storage: true, sale_date: '2025-07-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 6100000, observed_noi: 415000, exact_self_storage: true, sale_date: '2025-10-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
  ];
}

function fullAnalysis(overrides = {}) {
  return buildSelfStorageAnalysis({
    subjectRow: overrides.subjectRow ?? stabilizedSubjectRow(),
    storage: overrides.storage ?? stabilizedStorageInputs(),
    storageComps: overrides.storageComps ?? [...qualifiedComps(), { property_type: 'warehouse distribution', sale_price: 9000000, building_square_feet: 100000 }, { property_type: 'self storage portfolio', sale_price: 40000000, is_portfolio: true, parcel_count: 8 }],
    storageBuyers: overrides.storageBuyers ?? [{ normalized_buyer_name: 'regional storage llc', buyer_type: 'regional operator', purchase_count: 6, avg_purchase_price: 5000000, preferred_price_min: 3000000, preferred_price_max: 8000000 }],
    capRateEvidence: overrides.capRateEvidence ?? observedCapEvidence(),
    market: overrides.market ?? { tier: 'SECONDARY', household_growth: 2.1, population_growth: 1.8, renter_growth: 1.5 },
    repairInputs: overrides.repairInputs ?? {},
  });
}

/* -------------------------------------------------------------------------- */
/* Classification & isolation                                                  */
/* -------------------------------------------------------------------------- */

test('storage is isolated from industrial / warehouse lanes', () => {
  const storage = classifySelfStorageFacility({ property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 40000 });
  assert.equal(storage.is_self_storage, true);
  assert.equal(storage.lane, ASSET_LANES.SELF_STORAGE);

  const warehouse = classifySelfStorageFacility({ property_type: 'Warehouse Distribution Center', building_square_feet: 100000 });
  assert.equal(warehouse.is_self_storage, false);
});

test('physical-plausibility gate flags sub-floor storage records as non-genuine', () => {
  // Audit §1: CA cohort is mostly <10k sqft garages / storage condos.
  const tiny = classifySelfStorageFacility({ property_type: 'storage', is_storage: true, building_square_feet: 1800 });
  assert.equal(tiny.is_self_storage, true);
  assert.equal(tiny.genuine_facility, false);
  const condo = classifySelfStorageFacility({ property_type: 'storage condominium', is_storage: true, building_square_feet: 40000 });
  assert.equal(condo.genuine_facility, false);
});

test('missing occupancy remains UNKNOWN, not zero', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), { net_rentable_square_feet: 52000, unit_inventory: { total_units: 500 } });
  assert.equal(isKnown(contract.operations.physical_occupancy), false);
  assert.equal(contract.operations.physical_occupancy.value, null);
  const status = classifyStorageOperationalStatus({ facility: {}, contract });
  assert.equal(status.operational_status, 'UNKNOWN');
  assert.ok(status.missing_requirements.includes('physical_occupancy'));
});

test('stabilized versus value-add classification', () => {
  const stable = fullAnalysis();
  assert.equal(stable.operational_status.operational_status, 'STABILIZED');

  const va = fullAnalysis({
    storage: { ...stabilizedStorageInputs(), operations: { physical_occupancy: 0.74, economic_occupancy: 0.70 } },
  });
  assert.equal(va.operational_status.operational_status, 'VALUE_ADD');
});

/* -------------------------------------------------------------------------- */
/* Unit-mix normalization                                                      */
/* -------------------------------------------------------------------------- */

test('unit-mix normalization summarizes a roll without inventing units', () => {
  const mix = normalizeUnitMix({
    unitRoll: [
      { unit_size: '10x10', climate_controlled: true, occupied: true, in_place_rent: 120, market_rent: 130 },
      { unit_size: '10x10', climate_controlled: true, occupied: false, market_rent: 130 },
      { unit_size: '10x20', drive_up: true, occupied: true, in_place_rent: 180, market_rent: 200 },
    ],
  });
  assert.equal(mix.basis, 'UNIT_ROLL');
  assert.equal(mix.total_units, 3);
  assert.equal(mix.occupied_units, 2);
  // Two distinct categories (10x10 climate, 10x20 drive-up) — not collapsed.
  assert.equal(mix.categories.length, 2);
});

test('no fabricated per-unit precision from aggregate data', () => {
  const mix = normalizeUnitMix({ totalUnits: 500, totalNrsf: 50000 });
  assert.equal(mix.basis, 'AGGREGATE');
  assert.equal(mix.categories, null); // does NOT invent a mix
  assert.equal(mix.average_unit_nrsf, 100);
  assert.ok(mix.missing.includes('unit_mix'));
});

/* -------------------------------------------------------------------------- */
/* Revenue model                                                               */
/* -------------------------------------------------------------------------- */

test('street rent is not treated as actual collected revenue', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), {
    net_rentable_square_feet: 52000,
    operations: { physical_occupancy: 0.9 },
    income: { average_street_rent: 120 }, // ASKING only — no actual base
    unit_inventory: { total_units: 520, occupied_units: 468 },
  });
  const rev = buildStorageRevenue(contract);
  assert.equal(rev.current_actual_base_annual, null); // street rent is NOT collected revenue
  assert.equal(rev.gross_potential_basis, EVIDENCE_BASIS.LISTING_REPORTED);
  assert.equal(rev.street_rent_is_potential_only, true);
  assert.ok(rev.scheduled_gross_potential_annual > 0);
});

test('physical occupancy and economic occupancy remain distinct', () => {
  const a = fullAnalysis();
  assert.ok(a.revenue.physical_occupancy > a.revenue.economic_occupancy);
  assert.notEqual(a.revenue.physical_occupancy, a.revenue.economic_occupancy);
});

test('revenue bridge reconciles and vacancy/concessions/bad debt reduce revenue', () => {
  const base = buildSelfStorageContract(stabilizedSubjectRow(), stabilizedStorageInputs());
  const baseRev = buildStorageRevenue(base);

  const withDeductions = buildSelfStorageContract(stabilizedSubjectRow(), {
    ...stabilizedStorageInputs(),
    income: { ...stabilizedStorageInputs().income, concessions: 20000, bad_debt: 15000 },
  });
  const dedRev = buildStorageRevenue(withDeductions);
  assert.ok(dedRev.effective_gross_revenue_annual < baseRev.effective_gross_revenue_annual);
  // EGR = collected base + ancillary − concessions − bad debt (bridge reconciles).
  const expected = baseRev.current_actual_base_annual + dedRev.ancillary.total_ancillary_income - 20000 - 15000;
  assert.equal(dedRev.effective_gross_revenue_annual, Math.round(expected * 100) / 100);
});

test('ancillary income is separated from base rental income', () => {
  const a = fullAnalysis();
  const anc = a.revenue.ancillary;
  assert.ok(anc.total_ancillary_income > 0);
  assert.equal(anc.streams.tenant_insurance_income.basis, EVIDENCE_BASIS.ACTUAL); // provided
  assert.ok(anc.known_lines.includes('tenant_insurance_income'));
  // Base rental revenue must NOT include ancillary.
  assert.equal(a.revenue.current_actual_base_annual, 600000);
});

/* -------------------------------------------------------------------------- */
/* Expense & NOI models                                                        */
/* -------------------------------------------------------------------------- */

test('operating expenses exclude debt service and capex; no universal ratio', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), stabilizedStorageInputs());
  const driveUp = buildStorageExpenses(contract, { facilityType: 'DRIVE_UP', egrAnnual: 600000, subjectValue: 5000000 });
  const climate = buildStorageExpenses(contract, { facilityType: 'CLIMATE_CONTROLLED', egrAnnual: 600000, subjectValue: 5000000 });
  assert.deepEqual(driveUp.excludes, ['debt_service', 'depreciation', 'income_tax', 'acquisition_cost', 'expansion_capex']);
  // Distinct per facility type — not one universal ratio.
  assert.notEqual(driveUp.total_operating_expenses, climate.total_operating_expenses);
});

test('NOI calculation = EGR − opex; per-NRSF and per-unit reported', () => {
  const a = fullAnalysis();
  const egr = a.revenue.effective_gross_revenue_annual;
  const opex = a.expenses.total_operating_expenses;
  assert.equal(a.noi.current_noi.noi, Math.round((egr - opex) * 100) / 100);
  assert.ok(a.noi.noi_per_nrsf > 0);
  assert.ok(a.noi.noi_per_unit > 0);
});

/* -------------------------------------------------------------------------- */
/* Cap-rate model & valuation monotonicity                                     */
/* -------------------------------------------------------------------------- */

test('observed cap rate requires a time-aligned observed NOI', () => {
  const noNoi = qualifyObservedStorageCap({ sale_price: 5000000, exact_self_storage: true, sale_date: '2025-09-01' });
  assert.equal(noNoi.qualified, false);
  assert.ok(noNoi.reasons.includes('no_time_aligned_observed_noi'));
});

test('a modeled NOI cannot create an OBSERVED cap rate', () => {
  const modeled = qualifyObservedStorageCap({
    sale_price: 5000000, observed_noi: 350000, exact_self_storage: true,
    sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.MARKET_MODELED,
  });
  assert.equal(modeled.qualified, false);
  assert.ok(modeled.reasons.includes('noi_not_observed'));
});

test('cap-rate kinds (OBSERVED / IMPLIED / MODELED_MARKET) stay separate', () => {
  const cap = buildStorageCapRate({ facilityClass: 'B', observedEvidence: observedCapEvidence(), impliedNoi: 350000, impliedValue: 5000000, occupancy: 0.9 });
  assert.equal(cap.selected.kind, STORAGE_CAP_KIND.OBSERVED);
  assert.equal(cap.modeled_market.kind, STORAGE_CAP_KIND.MODELED_MARKET);
  assert.equal(cap.implied.kind, STORAGE_CAP_KIND.IMPLIED);
  assert.notEqual(cap.observed[0].cap_rate, cap.modeled_market.cap_rate);
});

test('a higher cap rate lowers value; a higher NOI raises value', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), stabilizedStorageInputs());
  const revenue = buildStorageRevenue(contract);
  const expenses = buildStorageExpenses(contract, { facilityType: 'CLIMATE_CONTROLLED', egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 6000000 });
  const noi = buildStorageNOI({ revenue, expenses, contract });
  const comparables = buildStorageComparables([], {});

  const lowCap = { selected: { kind: 'MODELED_MARKET', qualified: false }, modeled_market: { cap_rate: 0.05 } };
  const highCap = { selected: { kind: 'MODELED_MARKET', qualified: false }, modeled_market: { cap_rate: 0.08 } };
  const vLow = buildStorageValuation({ contract, noi, revenue, capRate: lowCap, comparables, operationalStatus: 'STABILIZED' });
  const vHigh = buildStorageValuation({ contract, noi, revenue, capRate: highCap, comparables, operationalStatus: 'STABILIZED' });
  assert.ok(vLow.methods.stabilized_noi_market_cap.mid > vHigh.methods.stabilized_noi_market_cap.mid);

  // Higher NOI → higher value at fixed cap.
  const noiHi = { ...noi, stabilized_noi: { noi: noi.stabilized_noi.noi * 1.2 } };
  const vNoiHi = buildStorageValuation({ contract, noi: noiHi, revenue, capRate: lowCap, comparables, operationalStatus: 'STABILIZED' });
  assert.ok(vNoiHi.methods.stabilized_noi_market_cap.mid > vLow.methods.stabilized_noi_market_cap.mid);
});

test('NRSF and price-per-unit methods compute from qualified comps', () => {
  const a = fullAnalysis();
  assert.ok(a.valuation.methods.price_per_nrsf.available);
  assert.ok(a.valuation.methods.price_per_unit.available);
  assert.equal(a.valuation.methods.price_per_nrsf.classification, 'QUALIFIED');
});

test('NOI/cap dominates a supportable stabilized facility; comps corroborate', () => {
  const a = fullAnalysis();
  assert.equal(a.valuation.dominant_method, 'STABILIZED_NOI_MARKET_CAP');
  assert.equal(a.valuation.reconciliation.income_led, true);
});

/* -------------------------------------------------------------------------- */
/* Comparable universes                                                        */
/* -------------------------------------------------------------------------- */

test('exact storage comps only — generic warehouse is rejected', () => {
  const wh = qualifyStorageComp({ property_type: 'warehouse distribution', sale_price: 9000000, building_square_feet: 100000 });
  assert.equal(wh.qualified, false);
  assert.equal(wh.reason, 'not_self_storage');
});

test('institutional package transaction provides demand only (no pricing)', () => {
  const pkg = qualifyStorageComp({ property_type: 'self storage portfolio', sale_price: 40000000, is_portfolio: true, parcel_count: 8 });
  assert.equal(pkg.qualified, false);
  assert.equal(pkg.demand_only, true);
  assert.equal(pkg.universe, STORAGE_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY);

  const built = buildStorageComparables([...qualifiedComps(), { property_type: 'self storage portfolio', sale_price: 40000000, is_portfolio: true, parcel_count: 8 }], {});
  assert.equal(built.qualified_count, 3);
  assert.equal(built.demand_only_count, 1);
});

test('market/demand context never fabricates supply data', () => {
  const ctx = buildStorageMarketContext({ market: { household_growth: 2, population_growth: 1.5, renter_growth: 1 } });
  assert.equal(ctx.supply_risk_status, 'UNAVAILABLE');
  assert.equal(ctx.competitor_count, null);
  assert.ok(ctx.note.includes('unavailable'));
});

/* -------------------------------------------------------------------------- */
/* Expansion & capital                                                         */
/* -------------------------------------------------------------------------- */

test('expansion value subtracts costs and a risk discount', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), {
    ...stabilizedStorageInputs(),
    development: { expansion_capacity_nrsf: 20000 },
  });
  const exp = buildStorageExpansionValue({ contract, marketCap: 0.065, asIsValue: 6000000 });
  assert.equal(exp.available, true);
  // Net incremental < gross development spread (risk discount applied).
  assert.ok(exp.net_incremental_value < exp.development_spread);
  // Required investment is subtracted before the spread.
  assert.ok(exp.development_spread === Math.round((exp.completed_value - exp.total_required_investment) * 100) / 100);
  // Total completed value = as-is + net incremental (not raw completed value).
  assert.equal(exp.total_completed_value, Math.round((6000000 + exp.net_incremental_value) * 100) / 100);
});

test('capex is not double-counted across valuation and offer economics', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), stabilizedStorageInputs());
  const cap = buildStorageCapital(contract, { repairInputs: { immediate_repairs: 40000, roof_envelope: 60000, replacement_reserves: 15000, expansion_capex: 200000 } });
  // One-time capital excludes ongoing reserves and expansion capex.
  assert.equal(cap.one_time_capital, 100000);
  assert.equal(cap.double_count_guard.offer_one_time_capital, 100000);
  assert.equal(cap.replacement_reserves_annual, 15000);
  assert.equal(cap.expansion_capex, 200000);
  assert.equal(cap.double_count_guard.reserves_in_opex_only, true);
});

/* -------------------------------------------------------------------------- */
/* Buyer exit & strategies                                                     */
/* -------------------------------------------------------------------------- */

test('buyer-exit routing matches storage archetypes and gates on qualified value', () => {
  const a = fullAnalysis();
  assert.equal(a.buyer_exit.exit_classification, 'QUALIFIED');
  assert.ok(a.buyer_exit.conservative_buyer_exit > 0);
  assert.ok('REGIONAL_OPERATOR' in a.buyer_exit.buyer_archetypes);
  // No matched buyers → exit is demand-context only (scenario, not qualified).
  const noBuyers = fullAnalysis({ storageBuyers: [] });
  assert.equal(noBuyers.buyer_exit.matched_buyer_count, 0);
});

test('commercial debt strategy is separate from residential subject-to', () => {
  const contract = buildSelfStorageContract(stabilizedSubjectRow(), {
    ...stabilizedStorageInputs(),
    debt: { balance: 3000000, monthly_payment: 18000, interest_rate: 0.058, balloon_months: 18 },
  });
  const noi = buildStorageNOI({
    revenue: buildStorageRevenue(contract),
    expenses: buildStorageExpenses(contract, { facilityType: 'CLIMATE_CONTROLLED', egrAnnual: 600000, subjectValue: 6000000 }),
    contract,
  });
  const debt = buildStorageCommercialDebt({ contract, noi });
  assert.equal(debt.debt_model, STORAGE_DEBT_MODEL);
  assert.equal(debt.is_residential_subject_to, false);
  assert.ok('refinance_risk' in debt);
  assert.equal(debt.refinance_risk, 'HIGH'); // 18-month balloon
});

test('seller-finance DSCR behavior is reflected per structure', () => {
  const a = fullAnalysis();
  const sf = a.strategies.seller_finance;
  assert.ok(sf.structures.cash_flow_optimized.dscr !== undefined);
  // Cash-flow-optimized (lower down, longer amort) has the highest DSCR.
  assert.ok(sf.structures.cash_flow_optimized.dscr >= sf.structures.seller_price_optimized.dscr);
});

test('storage marketed disposition is NOT labeled residential novation', () => {
  const dispo = buildStorageDisposition({ valuation: { reconciliation: { reconciled_value_mid: 6000000 } }, buyerExit: { exit_classification: 'QUALIFIED', expected_disposition_days: 150 }, cashRecommended: 4500000 });
  assert.equal(dispo.strategy, STORAGE_DISPOSITION_STRATEGY);
  assert.equal(dispo.is_residential_novation, false);
});

/* -------------------------------------------------------------------------- */
/* Qualification, execution-state basis, additivity, safety                    */
/* -------------------------------------------------------------------------- */

test('strategy qualification remains class-first', () => {
  // Genuine classification + evidence ⇒ class-first OK and shadow-ready.
  const ok = fullAnalysis();
  assert.equal(ok.strategy_qualification.class_first_ok, true);
  assert.equal(ok.strategy_qualification.shadow_mode_ready, true);

  // Remove the facility-confirming size ⇒ class-first fails ⇒ no underwritten.
  const noSize = fullAnalysis({
    subjectRow: { property_id: 'x', property_type: 'self storage', is_storage: true, property_address_state: 'TX' },
    storage: { operations: { physical_occupancy: 0.9 }, income: { base_rental_income: 600000 }, unit_inventory: { total_units: 500, occupied_units: 450 } },
  });
  assert.equal(noSize.strategy_qualification.class_first_ok, false);
  assert.equal(noSize.strategy_qualification.shadow_mode_ready, false);
});

test('execution-state basis is explicit and strategy-specific (hardened semantics)', () => {
  const a = fullAnalysis();
  assert.equal(a.execution_state, 'SHADOW_MODE_READY');
  const basis = a.execution_state_basis;
  // SHADOW_MODE_READY must name an underwritten shadow-approved basis strategy.
  assert.ok(basis.execution_state_basis_strategy !== null);
  assert.ok(basis.shadow_approved_strategies.includes(basis.execution_state_basis_strategy));
  // Underwritten cash supports shadow WITHOUT becoming live-authorized.
  assert.equal(basis.cash_underwritten, true);
  assert.equal(basis.cash_shadow_approved, true);
  assert.equal(basis.cash_scenario_only, false); // corrected: UNDERWRITTEN_SHADOW is NOT scenario-only
  assert.equal(basis.cash_live_authorized, false);
  // No live authorization while unsafe execution flags are disabled.
  assert.equal(basis.live_authorized_strategy, null);
  assert.equal(basis.live_authorized_offer_type, null);
  assert.equal(basis.authorized_strategy, null);
  assert.equal(basis.outbound_execution_enabled, false);
  // Null live authorization must NOT erase the underwritten shadow identity.
  assert.ok(basis.underwritten_strategies.includes('CASH'));
});

test('with no evidence, every storage strategy is DATA_REQUIRED / provisional (production reality)', () => {
  // Mirrors production: storage flag + size only, no operating data, no comps.
  const a = fullAnalysis({
    subjectRow: { property_id: 'prod', property_type: 'storage', is_storage: true, building_square_feet: 24000, property_address_state: 'TX' },
    storage: {}, storageComps: [], storageBuyers: [], capRateEvidence: [],
  });
  assert.equal(a.execution_state, 'DATA_REQUIRED');
  assert.equal(a.strategy_qualification.shadow_mode_ready, false);
  for (const r of a.strategy_qualification.ranked) {
    assert.ok([SQ.DATA_REQUIRED, SQ.PROVISIONAL_SCENARIO, SQ.DISQUALIFIED].includes(r.qualification_status));
    assert.equal(r.authorized_offer, false);
  }
});

test('storage analysis is additive — V2/residential flow unaffected for non-storage subjects', () => {
  const duplex = { property_id: 'd1', property_type: 'Duplex', units_count: 2, building_square_feet: 2200, estimated_value: 300000 };
  const result = buildV3Decision({ subjectRow: duplex, qualification: { accepted: [], rejected: [], anchors: {}, sample: {}, anomaly_flags: [] }, buyerPurchases: [] });
  assert.equal(result.v3.self_storage, null); // storage block absent for non-storage lane
  assert.equal(result.v3.canonical_asset_lane, ASSET_LANES.DUPLEX);
});

test('storage decision through the pipeline does not enable outbound or auto execution', () => {
  const result = buildV3Decision({
    subjectRow: stabilizedSubjectRow(),
    qualification: { accepted: [], rejected: [], anchors: {}, sample: {}, anomaly_flags: [] },
    buyerPurchases: [],
    storage: { subject: stabilizedStorageInputs(), comps: qualifiedComps(), buyers: [], cap_rate_evidence: observedCapEvidence() },
  });
  const ss = result.v3.self_storage;
  assert.ok(ss);
  assert.equal(ss.auto_execution_enabled, false);
  assert.equal(ss.outbound_enabled, false);
  for (const s of Object.values(ss.strategies)) {
    if (s && 'authorized_offer' in s) assert.equal(s.authorized_offer, false);
  }
  // Engine-level auto flags remain off.
  assert.equal(result.v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
});

/* ========================================================================== */
/* Item 5D.5 — hardened authorization semantics & classification               */
/* ========================================================================== */

/** Build a ranked-strategy qualification with explicit, controllable stubs. */
function qualifyWith({ cashStatus, debtStatus, classFirst = true, buyerExit = true, recordGated = false, incomeLed = true } = {}) {
  return qualifyStorageStrategies({
    classification: { is_self_storage: true, genuine_facility: classFirst },
    contract: { physical: { net_rentable_square_feet: { value: classFirst ? 50000 : null } } },
    valuation: { reconciliation: { qualified_method_count: classFirst ? 1 : 0 }, income_supported: incomeLed },
    noi: { income_supported: incomeLed },
    revenue: { current_actual_base_annual: incomeLed ? 600000 : null, current_base_basis: incomeLed ? 'ACTUAL' : 'UNKNOWN', physical_occupancy: incomeLed ? 0.9 : null },
    capRate: { selected: { kind: incomeLed ? 'OBSERVED' : 'MODELED_MARKET', qualified: incomeLed } },
    buyerExit: { exit_classification: buyerExit ? 'QUALIFIED' : 'PROVISIONAL_SCENARIO' },
    capital: { one_time_capital: 0, known_items: [] },
    strategies: {
      cash: cashStatus ? { strategy: 'CASH', qualification: cashStatus, available: true, recommended_cash_offer: 4000000, opening_cash_offer: 3700000, maximum_cash_offer: 4300000 } : undefined,
      commercial_debt: debtStatus ? { strategy: 'SUBJECT_TO', debt_model: 'COMMERCIAL_DEBT_TAKEOVER', qualification: debtStatus, available: true } : undefined,
    },
    recordGated,
    liveFlagsEnabled: false,
  });
}

test('UNDERWRITTEN_SHADOW is not scenario_only', () => {
  const q = qualifyWith({ cashStatus: SQ.UNDERWRITTEN_SHADOW });
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.underwritten, true);
  assert.equal(cash.scenario_only, false);
});

test('a scenario-only strategy cannot support SHADOW_MODE_READY', () => {
  const q = qualifyWith({ cashStatus: SQ.PROVISIONAL_SCENARIO });
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.scenario_only, true);
  assert.equal(cash.shadow_approved, false);
  assert.equal(q.shadow_mode_ready, false);
  assert.deepEqual(q.shadow_approved_strategies, []);
});

test('SHADOW_MODE_READY names an underwritten shadow-approved basis strategy', () => {
  const q = qualifyWith({ cashStatus: SQ.UNDERWRITTEN_SHADOW });
  assert.equal(q.shadow_mode_ready, true);
  const basis = buildStorageExecutionBasis({ ranked: q.ranked, executionState: 'SHADOW_MODE_READY', liveFlagsEnabled: false });
  assert.ok(q.shadow_approved_strategies.includes(basis.execution_state_basis_strategy));
  assert.ok(basis.underwritten_strategies.length >= 1);
});

test('live-authorized strategy remains null while execution flags are disabled', () => {
  const q = qualifyWith({ cashStatus: SQ.UNDERWRITTEN_SHADOW });
  const basis = buildStorageExecutionBasis({ ranked: q.ranked, executionState: 'SHADOW_MODE_READY', liveFlagsEnabled: false });
  assert.equal(basis.live_authorized_strategy, null);
  assert.equal(basis.outbound_execution_enabled, false);
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.live_authorized, false);
  assert.ok(cash.authorization_blockers.includes('unsafe_execution_flags_disabled'));
});

test('shadow monetary outputs are separate from live-authorized outputs', () => {
  const shadow = tierMonetary({ status: SQ.UNDERWRITTEN_SHADOW, liveAuthorized: false, opening: 3700000, recommended: 4000000, maximum: 4300000, walkaway: 4300000 });
  assert.equal(shadow.shadow_recommended, 4000000);
  assert.equal(shadow.scenario_recommended, null);
  assert.equal(shadow.authorized_recommended, null); // live disabled

  const scenario = tierMonetary({ status: SQ.PROVISIONAL_SCENARIO, liveAuthorized: false, recommended: 4000000 });
  assert.equal(scenario.scenario_recommended, 4000000);
  assert.equal(scenario.shadow_recommended, null);
  assert.equal(scenario.authorized_recommended, null);
});

test('provisional cash remains scenario-only (its own monetary tier)', () => {
  const q = qualifyWith({ cashStatus: SQ.PROVISIONAL_SCENARIO });
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.scenario_only, true);
  assert.equal(cash.monetary.scenario_recommended, 4000000);
  assert.equal(cash.monetary.shadow_recommended, null);
});

test('commercial debt may support shadow while cash remains provisional', () => {
  const q = qualifyWith({ cashStatus: SQ.PROVISIONAL_SCENARIO, debtStatus: SQ.UNDERWRITTEN_SHADOW });
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  const debt = q.ranked.find((r) => r.strategy === 'SUBJECT_TO');
  assert.equal(cash.shadow_approved, false); // provisional cash cannot be shadow-approved
  assert.equal(debt.underwritten, true);
  assert.equal(debt.shadow_approved, true);
  assert.equal(q.shadow_mode_ready, true);
  const basis = buildStorageExecutionBasis({ ranked: q.ranked, executionState: 'SHADOW_MODE_READY', liveFlagsEnabled: false });
  assert.equal(basis.execution_state_basis_strategy, 'SUBJECT_TO'); // debt, not provisional cash
  assert.equal(basis.cash_scenario_only, true);
  assert.equal(basis.cash_shadow_approved, false);
});

test('a binary is_storage flag alone is insufficient for high-confidence facility classification', () => {
  const rc = classifyStorageRecord({ is_storage: true, building_square_feet: 24000 });
  assert.equal(rc.classification, STORAGE_RECORD_CLASS.AMBIGUOUS_STORAGE);
  assert.ok(rc.confidence < OPERATING_FACILITY_MIN_CONFIDENCE);
  assert.equal(rc.pricing_eligible, false);
});

test('a small garage / accessory record does not become an operating facility', () => {
  const rc = classifyStorageRecord({ is_storage: true, property_type: 'storage', building_square_feet: 1800 });
  assert.equal(rc.classification, STORAGE_RECORD_CLASS.GARAGE_OR_ACCESSORY_STORAGE);
  assert.equal(rc.pricing_eligible, false);
});

test('storage condominium remains a separate class', () => {
  const rc = classifyStorageRecord({ is_storage: true, property_type: 'Storage Condominium', building_square_feet: 40000 });
  assert.equal(rc.classification, STORAGE_RECORD_CLASS.STORAGE_CONDOMINIUM);
  assert.equal(rc.pricing_eligible, false);
});

test('a warehouse-with-storage label is not self-storage automatically', () => {
  const rc = classifyStorageRecord({ is_storage: true, property_type: 'Warehouse Distribution with storage', building_square_feet: 80000 });
  assert.equal(rc.classification, STORAGE_RECORD_CLASS.WAREHOUSE_WITH_STORAGE_LABEL);
  assert.equal(rc.pricing_eligible, false);
});

test('a credible operating facility is recognized', () => {
  const rc = classifyStorageRecord({ property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 55000, number_of_buildings: 6, total_units: 480 }, { hasOperatingData: true });
  assert.equal(rc.classification, STORAGE_RECORD_CLASS.OPERATING_SELF_STORAGE_FACILITY);
  assert.ok(rc.confidence >= OPERATING_FACILITY_MIN_CONFIDENCE);
  assert.equal(rc.pricing_eligible, true);
});

test('ambiguous storage returns DATA_REQUIRED and does not run a confirmed-facility shadow', () => {
  const a = fullAnalysis({
    subjectRow: { property_id: 'amb', property_type: 'storage', is_storage: true, building_square_feet: 24000, property_address_state: 'TX' },
    storage: {}, storageComps: qualifiedComps(), storageBuyers: [], capRateEvidence: [],
  });
  assert.equal(a.record_class.classification, STORAGE_RECORD_CLASS.AMBIGUOUS_STORAGE);
  assert.equal(a.pricing_eligible, false);
  assert.equal(a.decision_gate.record_gated, true);
  assert.equal(a.execution_state, 'DATA_REQUIRED');
  assert.equal(a.strategy_qualification.shadow_mode_ready, false);
});

test('modeled NRSF from GBA remains clearly assumed and cannot make income valuation qualified alone', () => {
  const contract = buildSelfStorageContract({ property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 60000, number_of_buildings: 5 }, { unit_inventory: { total_units: 500 } });
  const nrsf = contract.physical.net_rentable_square_feet;
  assert.equal(nrsf.basis, EVIDENCE_BASIS.MARKET_MODELED);
  assert.ok(isKnown(nrsf)); // has a value, but explicitly modeled
  // With modeled NRSF but no income/comps, no qualified income value emerges.
  const a = fullAnalysis({
    subjectRow: { property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 60000, number_of_buildings: 5, property_address_state: 'TX' },
    storage: { unit_inventory: { total_units: 500 } }, storageComps: [], storageBuyers: [], capRateEvidence: [],
  });
  assert.notEqual(a.valuation.reconciliation.value_classification, 'QUALIFIED');
});

test('no operating-data zeros are fabricated when inputs are absent', () => {
  const contract = buildSelfStorageContract({ property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 50000, number_of_buildings: 4 }, {});
  for (const f of [contract.operations.physical_occupancy, contract.income.base_rental_income, contract.expenses.payroll, contract.operations.average_in_place_rent]) {
    assert.equal(isKnown(f), false);
    assert.equal(f.value, null); // UNKNOWN, never 0
  }
});

test('production-readiness reports SHADOW (not pricing-calibrated) with full fixtures, and not-calibrated with none', () => {
  const withFixtures = fullAnalysis();
  // Fixtures provide qualified data → shadow-class readiness, never autonomous.
  assert.ok(['PRODUCTION_SHADOW_READY', 'SHADOW_SCENARIO_ONLY'].includes(withFixtures.production_readiness.status));
  assert.equal(withFixtures.production_readiness.autonomous_ready, false);

  const credibleNoData = fullAnalysis({
    subjectRow: { property_type: 'Self Storage Facility', is_storage: true, building_square_feet: 30000, number_of_buildings: 4, property_address_state: 'TX' },
    storage: {}, storageComps: [], storageBuyers: [], capRateEvidence: [],
  });
  assert.equal(credibleNoData.production_readiness.status, 'PRODUCTION_PRICING_NOT_CALIBRATED');
  assert.ok(credibleNoData.production_readiness.active_blockers.some((b) => b.startsWith('qualified_sales')));
});
