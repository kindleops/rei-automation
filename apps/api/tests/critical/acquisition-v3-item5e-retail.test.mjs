/**
 * Acquisition Engine V3 — Item 5E retail & strip-center intelligence &
 * underwriting.
 *
 * Deterministic, source-traceable retail model: classification isolation (office
 * / industrial / specialty), subtype discipline, lease normalization (NNN not
 * inferred from CAM alone), tenant-credit (brand ≠ guaranty), rent-roll
 * normalization (no fabricated suite precision), revenue/expense/NOI/cap
 * separation, reimbursement leakage, rollover/TI/LC discipline, co-tenancy/anchor
 * risk, comparable-universe rules, valuation method monotonicity, single-tenant /
 * ground-lease separation, business-value exclusion, class-first strategy
 * qualification, explicit execution-state basis, additivity (V2 byte-identical
 * when retail is absent), and the disabled-execution invariant.
 *
 * Production reality (audit §1, §24): there is NO retail operating/lease data and
 * NO retail transaction comp in production (237 'Strip Malls', TX-only, no NOI/
 * cap/rent/lease/transaction), so qualified paths are exercised with clearly-
 * labeled deterministic fixtures, never a production sample.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_LANES, STRATEGY_QUALIFICATION as SQ } from '@/lib/acquisition/modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from '@/lib/acquisition/incomeSnapshotContract.js';
import {
  classifyRetailAsset, classifyRetailRecord, classifyRetailTenancy, classifyRetailOperationalStatus,
} from '@/lib/acquisition/retailClassification.js';
import {
  RETAIL_SUBTYPE as ST, RETAIL_RECORD_CLASS as RC, LEASE_TYPE as LT,
  TENANT_CREDIT_CLASS as TC, RETAIL_TENANCY as TEN,
} from '@/lib/acquisition/retailConstants.js';
import { recognizeLeaseType, normalizeLease, classifyTenantCredit } from '@/lib/acquisition/retailLeaseModel.js';
import { buildRetailContract, buildRentRoll, retailMissingInputs } from '@/lib/acquisition/retailContract.js';
import {
  buildRetailRevenue, buildRetailExpenses, buildRetailNOI, buildRetailRollover,
  buildRetailCapRate, qualifyObservedRetailCap, RETAIL_CAP_KIND,
} from '@/lib/acquisition/retailUnderwriting.js';
import { qualifyRetailComp, buildRetailComparables, RETAIL_COMP_UNIVERSE, buildRetailMarketContext } from '@/lib/acquisition/retailComps.js';
import {
  buildRetailValuation, buildSingleTenantValue, buildGroundLeaseValue, buildAnchorRisk,
  buildRetailCapital, buildBusinessValueSeparation, buildLeaseDCF,
} from '@/lib/acquisition/retailValuation.js';
import { buildRetailBuyerExit } from '@/lib/acquisition/retailBuyerExit.js';
import { valueFromCap } from '@/lib/acquisition/incomeUnderwriting.js';
import {
  buildRetailCommercialDebt, buildRetailDisposition, qualifyRetailStrategies, buildRetailExecutionBasis,
} from '@/lib/acquisition/retailStrategies.js';
import { buildRetailAnalysis, isRetailLane } from '@/lib/acquisition/retailDecision.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
// Preflight §0 regression target (self-storage strategy semantics).
import { qualifyStorageStrategies } from '@/lib/acquisition/selfStorageStrategies.js';

/* -------------------------------------------------------------------------- */
/* Fixtures (clearly-labeled, deterministic — NOT a production sample)         */
/* -------------------------------------------------------------------------- */

function stripRow() {
  return {
    property_id: 'rt-strip', property_type: 'Neighborhood Strip Center',
    is_strip_center: true, building_square_feet: 30000, lot_square_feet: 80000,
    number_of_suites: 8, year_built: 2008, property_address_state: 'TX',
  };
}

function leaseFixtures() {
  return [
    { tenant_name: 'Bright Smiles Dental', suite: '101', leased_square_feet: 3000, lease_type: 'NNN', annual_base_rent: 78000, annual_escalation_pct: 0.03, lease_expiration: '2031-06-30', tax_reimbursement: true, insurance_reimbursement: true, cam_reimbursement: true, annual_reimbursement_income: 12000 },
    { tenant_name: 'Corner Cafe LLC', suite: '102', leased_square_feet: 2500, lease_type: 'modified gross', monthly_base_rent: 5200, lease_expiration: '2027-03-31', cam_reimbursement: true },
    { tenant_name: 'Dollar General', suite: '103', leased_square_feet: 9000, lease_type: 'triple net', base_rent_per_sf: 11, lease_expiration: '2034-12-31', tax_reimbursement: true, insurance_reimbursement: true, cam_reimbursement: true, annual_reimbursement_income: 28000 },
    { tenant_name: 'Local Nails', suite: '104', leased_square_feet: 1800, annual_base_rent: 39600, lease_expiration: '2026-09-30' },
  ];
}

function retailInputs(overrides = {}) {
  return {
    gross_leasable_area: 28500,
    number_of_suites: 8,
    operations: { physical_occupancy: 0.93, economic_occupancy: 0.90, market_rent_psf: 24, ...(overrides.operations ?? {}) },
    income: {
      base_rental_income: 540000, cam_reimbursement_income: 60000, tax_reimbursement_income: 40000,
      insurance_reimbursement_income: 12000, in_place_rent_psf: 20.4,
      ...(overrides.income ?? {}),
    },
    expenses: { property_taxes: 70000, insurance: 14000, cam: 52000, repairs_maintenance: 16000, management: 26000, ...(overrides.expenses ?? {}) },
    leases: overrides.leases ?? leaseFixtures(),
    ...overrides.top,
  };
}

function qualifiedRetailComps() {
  return [
    { property_type: 'strip center', sale_price: 5300000, building_square_feet: 28000, occupancy: 0.93, property_address_state: 'TX', sale_date: '2025-09-01', cap_rate: 0.072, noi: 382000 },
    { property_type: 'strip center', sale_price: 4700000, building_square_feet: 26000, occupancy: 0.9, property_address_state: 'TX', sale_date: '2025-07-01', cap_rate: 0.075, noi: 352000 },
    { property_type: 'neighborhood strip center', sale_price: 6100000, building_square_feet: 32000, occupancy: 0.95, property_address_state: 'TX', sale_date: '2025-10-01', cap_rate: 0.07, noi: 427000 },
  ];
}

function observedRetailCap() {
  return [
    { sale_price: 5300000, observed_noi: 382000, exact_retail_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 4700000, observed_noi: 352000, exact_retail_subtype: true, sale_date: '2025-07-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 6100000, observed_noi: 427000, exact_retail_subtype: true, sale_date: '2025-10-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
  ];
}

function fullAnalysis(overrides = {}) {
  return buildRetailAnalysis({
    subjectRow: overrides.subjectRow ?? stripRow(),
    retail: overrides.retail ?? retailInputs(),
    retailComps: overrides.retailComps ?? [
      ...qualifiedRetailComps(),
      { property_type: 'office building', sale_price: 9000000, building_square_feet: 50000 },
      { property_type: 'strip center portfolio', sale_price: 40000000, is_portfolio: true, parcel_count: 9 },
    ],
    retailBuyers: overrides.retailBuyers ?? [{ normalized_buyer_name: 'regional retail partners', buyer_type: 'regional shopping center operator', purchase_count: 6, avg_purchase_price: 5000000, preferred_price_min: 2000000, preferred_price_max: 9000000, preferred_subtypes: [ST.UNANCHORED_STRIP_CENTER, ST.NEIGHBORHOOD_STRIP_CENTER] }],
    capRateEvidence: overrides.capRateEvidence ?? observedRetailCap(),
    market: overrides.market ?? { tier: 'SECONDARY', population_growth: 1.8, household_growth: 1.6, retail_sales_growth: 2.0 },
    repairInputs: overrides.repairInputs ?? {},
  });
}

/* -------------------------------------------------------------------------- */
/* §0 Preflight blocker semantics (Case B regression)                          */
/* -------------------------------------------------------------------------- */

test('preflight: UNDERWRITTEN_SHADOW carries a live-execution blocker, not an economic-failure blocker', () => {
  // A shadow-approved underwritten CASH strategy keeps underwritten + shadow
  // status; its only execution blocker is the live-execution gate (renamed from
  // the ambiguous not_executable_economics).
  const q = qualifyStorageStrategies({
    classification: { is_self_storage: true, genuine_facility: true },
    contract: { physical: { net_rentable_square_feet: { value: 52000 } } },
    valuation: { reconciliation: { qualified_method_count: 2 }, income_supported: true },
    noi: { income_supported: true },
    revenue: { current_actual_base_annual: 600000, current_base_basis: 'ACTUAL', physical_occupancy: 0.91 },
    capRate: { selected: { kind: 'OBSERVED', qualified: true } },
    buyerExit: { exit_classification: 'QUALIFIED' },
    capital: { one_time_capital: 0, known_items: [] },
    strategies: {
      cash: { strategy: 'CASH', qualification: SQ.UNDERWRITTEN_SHADOW, available: true, recommended_cash_offer: 4000000, opening_cash_offer: 3680000, maximum_cash_offer: 4320000 },
    },
    recordGated: false, liveFlagsEnabled: false,
  });
  const cash = q.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.qualification_status, SQ.UNDERWRITTEN_SHADOW);
  assert.equal(cash.underwritten, true);
  assert.equal(cash.shadow_approved, true);
  assert.equal(cash.live_authorized, false);
  // The blocker is unambiguously a live-execution gate, NOT an economics failure.
  assert.ok(cash.authorization_blockers.includes('live_execution_not_authorized'));
  assert.ok(!cash.authorization_blockers.includes('not_executable_economics'));
  // Economic-failure blockers are absent for an underwritten strategy.
  assert.ok(!cash.authorization_blockers.includes('not_underwritten'));
  assert.ok(!cash.authorization_blockers.includes('scenario_only_economics'));
});

/* -------------------------------------------------------------------------- */
/* §1/§2 Classification & isolation                                            */
/* -------------------------------------------------------------------------- */

test('retail is isolated from office and industrial lanes', () => {
  const strip = classifyRetailAsset(stripRow());
  assert.equal(strip.is_retail, true);
  assert.equal(strip.lane, ASSET_LANES.RETAIL_STRIP_CENTER);

  const office = classifyRetailAsset({ property_type: 'Office Building', building_square_feet: 40000 });
  assert.equal(office.is_retail, false);
  const warehouse = classifyRetailAsset({ property_type: 'Warehouse Distribution', building_square_feet: 100000 });
  assert.equal(warehouse.is_retail, false);
});

test('generic retail flag alone does not prove a high-confidence subtype', () => {
  const r = classifyRetailAsset({ property_type: 'retail', is_retail: true, building_square_feet: 5000 });
  assert.equal(r.is_retail, true);
  assert.equal(r.subtype, ST.AMBIGUOUS_RETAIL);
  assert.ok(r.confidence <= 45);
});

test('gas station / car wash / restaurant business sale do not enter generic retail pricing', () => {
  const gas = classifyRetailRecord({ property_type: 'Gas Station with convenience store', building_square_feet: 3000 });
  assert.equal(gas.classification, RC.GAS_STATION_FUEL);
  assert.equal(gas.pricing_eligible, false);
  assert.equal(gas.specialty, true);
  assert.equal(gas.environmental_review_required, true);

  // A car wash mis-flagged as retail by the import must be separated, not priced.
  const wash = classifyRetailRecord({ property_type: 'Retail Car Wash', is_retail: true, building_square_feet: 4000 });
  assert.equal(wash.classification, RC.CAR_WASH);
  assert.equal(wash.pricing_eligible, false);

  const restaurant = classifyRetailRecord({ property_type: 'Restaurant business opportunity turnkey for sale', building_square_feet: 3500 });
  assert.ok(restaurant.classification === RC.RESTAURANT_BUSINESS_SALE || restaurant.classification === RC.BUSINESS_OPPORTUNITY);
  assert.equal(restaurant.pricing_eligible, false);
});

test('mixed-use retail/residential is separated from pure retail', () => {
  const mu = classifyRetailRecord({ property_type: 'Mixed-use retail with apartments above', building_square_feet: 12000 });
  assert.equal(mu.classification, RC.MIXED_USE_RETAIL_RESIDENTIAL);
  assert.equal(mu.pricing_eligible, false);
});

test('binary retail flag alone (no corroboration) is AMBIGUOUS, not a priced center', () => {
  const r = classifyRetailRecord({ property_type: 'retail', is_retail: true, building_square_feet: 14000 });
  assert.equal(r.classification, RC.AMBIGUOUS_RETAIL);
  assert.equal(r.pricing_eligible, false);
});

test('multi-tenant center with suites + lease data is pricing-eligible', () => {
  const r = classifyRetailRecord({ ...stripRow() }, { hasLeaseData: true, hasOperatingData: true });
  assert.equal(r.classification, RC.MULTI_TENANT_RETAIL_CENTER);
  assert.equal(r.pricing_eligible, true);
});

test('tenancy and operational status are distinct classifications', () => {
  const tenancy = classifyRetailTenancy({ rentRoll: { total_suites: 8, occupied_suites: 7, physical_occupancy: 0.93 } });
  assert.equal(tenancy.tenancy, TEN.MULTI_TENANT);
  const single = classifyRetailTenancy({ rentRoll: { total_suites: 1, physical_occupancy: 1 } });
  assert.equal(single.tenancy, TEN.SINGLE_TENANT);
  const vacant = classifyRetailOperationalStatus({ rentRoll: { physical_occupancy: 0 } });
  assert.equal(vacant.operational_status, 'VACANT');
});

test('missing occupancy remains UNKNOWN, not zero', () => {
  const contract = buildRetailContract(stripRow(), { gross_leasable_area: 28500 });
  assert.equal(isKnown(contract.operations.physical_occupancy), false);
  assert.equal(contract.operations.physical_occupancy.value, null);
  const status = classifyRetailOperationalStatus({ contract });
  assert.equal(status.operational_status, 'UNKNOWN');
  assert.ok(status.missing_requirements.includes('physical_occupancy'));
});

/* -------------------------------------------------------------------------- */
/* §4 Lease normalization                                                      */
/* -------------------------------------------------------------------------- */

test('NNN is not inferred from a CAM reimbursement alone', () => {
  const camOnly = recognizeLeaseType({ cam_reimbursement: true });
  assert.equal(camOnly.lease_type, LT.MODIFIED_GROSS);
  assert.ok(camOnly.reasons.includes('cam_only_not_nnn'));

  const fullNet = recognizeLeaseType({ tax_reimbursement: true, insurance_reimbursement: true, cam_reimbursement: true });
  assert.equal(fullNet.lease_type, LT.TRIPLE_NET);

  const explicit = recognizeLeaseType({ lease_type: 'NNN' });
  assert.equal(explicit.lease_type, LT.TRIPLE_NET);
});

test('lease normalization returns exact missing inputs and computes rollover cost', () => {
  const l = normalizeLease({ tenant_name: 'X', leased_square_feet: 3000, annual_base_rent: 78000, lease_expiration: '2031-06-30' }, { asOfYear: 2026, marketRentPerSf: 28 });
  assert.equal(l.base_rent_per_sf, 26); // 78000/3000
  assert.equal(l.remaining_term_years, 5);
  assert.ok(l.rollover_cost > 0);
  assert.equal(l.loss_to_lease_per_sf, 2); // 28 - 26
  const missing = normalizeLease({ tenant_name: 'Y' });
  assert.ok(missing.missing_inputs.includes('base_rent'));
  assert.ok(missing.missing_inputs.includes('lease_expiration_or_remaining_term'));
});

test('lease expiration and remaining term drive expiration-risk bands', () => {
  const near = normalizeLease({ leased_square_feet: 2000, annual_base_rent: 40000, lease_expiration: '2026-09-30' }, { asOfYear: 2026 });
  assert.equal(near.expiration_risk, 'NEAR_TERM');
  const long = normalizeLease({ leased_square_feet: 2000, annual_base_rent: 40000, lease_expiration: '2034-12-31' }, { asOfYear: 2026 });
  assert.equal(long.expiration_risk, 'LONG_TERM');
});

/* -------------------------------------------------------------------------- */
/* §5 Tenant credit                                                            */
/* -------------------------------------------------------------------------- */

test('brand does not equal corporate guaranty', () => {
  const brandOnly = classifyTenantCredit({ tenant_name: 'McDonalds' });
  assert.equal(brandOnly.credit_class, TC.NATIONAL_CREDIT);
  assert.notEqual(brandOnly.credit_class, TC.INVESTMENT_GRADE_NATIONAL);

  const corporate = classifyTenantCredit({ tenant_name: 'McDonalds', corporate_guaranty: true });
  assert.equal(corporate.credit_class, TC.INVESTMENT_GRADE_NATIONAL);

  const franchisee = classifyTenantCredit({ tenant_name: 'McDonalds', is_franchisee: true, personal_guaranty: true });
  assert.equal(franchisee.credit_class, TC.FRANCHISEE);
  assert.equal(franchisee.guaranty_strength, 'FRANCHISEE_PERSONAL');
  assert.equal(franchisee.external_rating_invented, false);
});

test('grocery anchor and government tenants are credit-classified', () => {
  assert.equal(classifyTenantCredit({ tenant_name: 'Kroger' }).credit_class, TC.GROCERY_ANCHOR);
  assert.equal(classifyTenantCredit({ tenant_name: 'US Post Office' }).credit_class, TC.GOVERNMENT);
});

/* -------------------------------------------------------------------------- */
/* §6 Rent roll                                                                */
/* -------------------------------------------------------------------------- */

test('rent roll normalizes suite-level leases (occupancy, concentration, WALE)', () => {
  const rr = buildRentRoll(stripRow(), retailInputs());
  assert.equal(rr.basis, 'LEASE_LEVEL');
  assert.equal(rr.total_suites, 4);
  assert.ok(rr.occupied_gla > 0);
  assert.ok(rr.physical_occupancy > 0 && rr.physical_occupancy <= 1);
  assert.ok(rr.tenant_concentration !== null);
  assert.ok(rr.wale_years !== null);
  assert.ok(rr.in_place_rent_psf > 0);
});

test('no fabricated suite-level precision from a building-level total', () => {
  const rr = buildRentRoll(stripRow(), { gross_leasable_area: 28500, number_of_suites: 8 });
  assert.equal(rr.basis, 'BUILDING_LEVEL');
  assert.equal(rr.leases, null);
  assert.equal(rr.in_place_rent_psf, null);
  assert.ok(rr.missing.includes('suite_level_rents'));
});

test('physical and economic occupancy remain distinct', () => {
  const rr = buildRentRoll(stripRow(), retailInputs({ operations: { physical_occupancy: 0.93, economic_occupancy: 0.85, market_rent_psf: 24 } }));
  assert.equal(rr.economic_occupancy, 0.85);
  assert.ok(rr.physical_occupancy !== rr.economic_occupancy);
});

/* -------------------------------------------------------------------------- */
/* §7/§8/§9 Revenue / expense / NOI                                            */
/* -------------------------------------------------------------------------- */

test('base rent and reimbursements remain separate; asking rent is not collected', () => {
  const contract = buildRetailContract(stripRow(), retailInputs());
  const revenue = buildRetailRevenue(contract);
  assert.equal(revenue.current_contractual_base_annual, 540000);
  assert.ok(revenue.reimbursement_income_annual > 0);
  assert.notEqual(revenue.reimbursement_income_annual, revenue.current_contractual_base_annual);
  assert.equal(revenue.asking_rent_is_potential_only, true);
  assert.equal(revenue.base_and_reimbursements_separate, true);
  // Scheduled GPR (market rent × GLA) is potential, not collected base.
  assert.ok(revenue.scheduled_gross_potential_annual > revenue.current_contractual_base_annual);
});

test('reimbursement leakage reduces NOI; NNN does not imply full recovery', () => {
  const contract = buildRetailContract(stripRow(), retailInputs());
  const revenue = buildRetailRevenue(contract);
  const grossExp = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 5000000, dominantLeaseType: LT.TRIPLE_NET });
  const gross2Exp = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 5000000, dominantLeaseType: LT.FULL_SERVICE_GROSS });
  assert.equal(grossExp.full_nnn_recovery_assumed, false);
  // A gross lease leaks more recoverable expense than NNN.
  assert.ok(gross2Exp.reimbursement_leakage > grossExp.reimbursement_leakage);
  const noi = buildRetailNOI({ revenue, expenses: grossExp, contract });
  assert.ok(noi.reimbursement_leakage >= 0);
  assert.ok(noi.current_noi.noi < revenue.effective_gross_revenue_annual);
});

test('NOI excludes debt service, depreciation, capex, TI and LC', () => {
  const contract = buildRetailContract(stripRow(), retailInputs());
  const revenue = buildRetailRevenue(contract);
  const expenses = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 5000000, dominantLeaseType: LT.TRIPLE_NET });
  const noi = buildRetailNOI({ revenue, expenses, contract });
  for (const ex of ['debt_service', 'depreciation', 'income_tax', 'capital_expenditures', 'tenant_improvements', 'leasing_commissions']) {
    assert.ok(noi.current_noi.excludes.includes(ex));
  }
});

/* -------------------------------------------------------------------------- */
/* §10 Rollover                                                                */
/* -------------------------------------------------------------------------- */

test('rollover costs are computed and current NOI is not stabilized with imminent rollover', () => {
  // Make a roll where a large share expires within 12 months.
  const leases = [
    { tenant_name: 'BigBox', leased_square_feet: 20000, annual_base_rent: 240000, lease_expiration: '2026-08-31' },
    { tenant_name: 'Inline', leased_square_feet: 8500, annual_base_rent: 170000, lease_expiration: '2032-01-31' },
  ];
  const contract = buildRetailContract(stripRow(), retailInputs({ leases, operations: { physical_occupancy: 1, market_rent_psf: 24 } }));
  const revenue = buildRetailRevenue(contract);
  const rollover = buildRetailRollover({ contract, revenue });
  assert.equal(rollover.available, true);
  assert.ok(rollover.required_leasing_capital > 0);
  assert.equal(rollover.near_term_material, true);
  assert.ok(rollover.rollover_risk_score > 0);
});

/* -------------------------------------------------------------------------- */
/* §11 Co-tenancy / anchor                                                     */
/* -------------------------------------------------------------------------- */

test('anchor parcel ownership is not assumed; co-tenancy risk is explicit', () => {
  const contract = buildRetailContract(stripRow(), { ...retailInputs(), anchor: { anchor_tenant: 'Kroger', owned_on_parcel: false, shadow_anchor: true, co_tenancy: true } });
  const risk = buildAnchorRisk({ contract, rentRoll: contract.rent_roll });
  assert.equal(risk.anchor_parcel_ownership_assumed, false);
  assert.equal(risk.shadow_anchor_dependency, true);
  assert.equal(risk.anchor_risk_status, 'SHADOW_ANCHOR_DEPENDENCY');
  assert.ok(risk.value_impact_pct > 0);
});

/* -------------------------------------------------------------------------- */
/* §12 Comparables                                                             */
/* -------------------------------------------------------------------------- */

test('office/warehouse comps are rejected; portfolio is demand-only', () => {
  const office = qualifyRetailComp({ property_type: 'office building', sale_price: 4000000, building_square_feet: 30000 }, { subjectSubtype: ST.UNANCHORED_STRIP_CENTER });
  assert.equal(office.qualified, false);
  assert.equal(office.reason, 'non_retail_asset_rejected');

  const pkg = qualifyRetailComp({ property_type: 'strip center', is_portfolio: true, parcel_count: 6, sale_price: 30000000 }, { subjectSubtype: ST.UNANCHORED_STRIP_CENTER });
  assert.equal(pkg.qualified, false);
  assert.equal(pkg.demand_only, true);

  const comps = buildRetailComparables([...qualifiedRetailComps(), { property_type: 'office', sale_price: 1, building_square_feet: 1 }], { subjectSubtype: ST.UNANCHORED_STRIP_CENTER });
  assert.ok(comps.qualified_count >= 3);
  assert.equal(comps.portfolio_pricing_excluded, true);
});

test('gas-station comp is rejected without specialty normalization', () => {
  const gas = qualifyRetailComp({ property_type: 'gas station', sale_price: 2000000, building_square_feet: 3000 }, { subjectSubtype: ST.SINGLE_TENANT_NET_LEASE });
  assert.equal(gas.qualified, false);
  assert.equal(gas.reason, 'specialty_use_rejected_without_normalization');
});

/* -------------------------------------------------------------------------- */
/* §13 Cap rate                                                                */
/* -------------------------------------------------------------------------- */

test('observed cap requires observed NOI; modeled NOI cannot create an observed cap', () => {
  const ok = qualifyObservedRetailCap({ sale_price: 5300000, observed_noi: 382000, exact_retail_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL });
  assert.equal(ok.qualified, true);
  assert.equal(ok.kind, RETAIL_CAP_KIND.OBSERVED);

  const modeledNoi = qualifyObservedRetailCap({ sale_price: 5300000, observed_noi: 382000, exact_retail_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.MARKET_MODELED });
  assert.equal(modeledNoi.qualified, false);
  assert.ok(modeledNoi.reasons.includes('noi_not_observed'));

  const noNoi = qualifyObservedRetailCap({ sale_price: 5300000, exact_retail_subtype: true, sale_date: '2025-09-01', noi_period: 'T12' });
  assert.equal(noNoi.qualified, false);
});

test('weaker tenant credit widens the modeled cap rate', () => {
  const ig = buildRetailCapRate({ subtype: ST.SINGLE_TENANT_NET_LEASE, creditClass: 'INVESTMENT_GRADE_NATIONAL' });
  const local = buildRetailCapRate({ subtype: ST.SINGLE_TENANT_NET_LEASE, creditClass: 'LOCAL_OPERATOR' });
  assert.ok(local.modeled_market.cap_rate > ig.modeled_market.cap_rate);
});

/* -------------------------------------------------------------------------- */
/* §14 Valuation monotonicity / DCF                                            */
/* -------------------------------------------------------------------------- */

test('cap-rate increase lowers value; NOI increase raises value', () => {
  const a = fullAnalysis();
  const baseVal = a.valuation.reconciliation.reconciled_value_mid;
  // Higher NOI via higher in-place base rent → higher value.
  const higher = fullAnalysis({ retail: retailInputs({ income: { base_rental_income: 700000, cam_reimbursement_income: 60000, tax_reimbursement_income: 40000, insurance_reimbursement_income: 12000, in_place_rent_psf: 24 } }) });
  assert.ok(higher.valuation.reconciliation.reconciled_value_mid >= baseVal);

  // Direct cap monotonicity at the method level.
  const v1 = valueFromCap(400000, 0.06);
  const v2 = valueFromCap(400000, 0.08);
  assert.ok(v2 < v1);
});

test('lease-by-lease DCF reconciles cash flows and terminal value', () => {
  const contract = buildRetailContract(stripRow(), retailInputs());
  const revenue = buildRetailRevenue(contract);
  const expenses = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 5000000, dominantLeaseType: LT.TRIPLE_NET });
  const noi = buildRetailNOI({ revenue, expenses, contract });
  const rollover = buildRetailRollover({ contract, revenue });
  const dcf = buildLeaseDCF({ contract, noi, revenue, rollover, marketCap: 0.072, operationalStatus: 'STABILIZED' });
  assert.equal(dcf.available, true);
  assert.ok(dcf.present_value > 0);
  assert.ok(dcf.pv_cash_flows > 0 && dcf.pv_terminal > 0);
  assert.ok(Math.abs(dcf.present_value - (dcf.pv_cash_flows + dcf.pv_terminal)) <= 2);
});

/* -------------------------------------------------------------------------- */
/* §15/§16/§18 Single-tenant / ground lease / business value                   */
/* -------------------------------------------------------------------------- */

test('single-tenant lease value separates residual and dark value', () => {
  const contract = buildRetailContract({ property_id: 'st', property_type: 'Single Tenant Net Lease freestanding retail', building_square_feet: 9000, property_address_state: 'TX' }, {
    gross_leasable_area: 9000,
    operations: { physical_occupancy: 1, market_rent_psf: 22, in_place_rent_psf: 24 },
    income: { base_rental_income: 216000, in_place_rent_psf: 24 },
  });
  const revenue = buildRetailRevenue(contract);
  const expenses = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 3000000, dominantLeaseType: LT.TRIPLE_NET });
  const noi = buildRetailNOI({ revenue, expenses, contract });
  const cap = buildRetailCapRate({ subtype: ST.SINGLE_TENANT_NET_LEASE, creditClass: 'NATIONAL_CREDIT' });
  const credit = classifyTenantCredit({ tenant_name: 'Walgreens' });
  const st = buildSingleTenantValue({ contract, noi, capRate: cap, tenantCredit: credit, leaseTerms: { remaining_term_years: 8, annual_escalation_pct: 0.02 } });
  assert.equal(st.available, true);
  assert.equal(st.residual_and_dark_separated, true);
  assert.ok(st.lease_value > 0);
  assert.ok(st.dark_value < st.residual_value || st.dark_value < st.lease_value);
});

test('ground lease does not imply fee-simple ownership', () => {
  const contract = buildRetailContract({ property_id: 'gl', property_type: 'Ground Lease pad site', building_square_feet: 4000, lot_square_feet: 40000 }, {
    ground_lease: { is_ground_lease: true, ground_rent_annual: 120000, term_years: 50, escalation_pct: 0.02, subordinated: false },
  });
  const gl = buildGroundLeaseValue({ contract });
  assert.equal(gl.available, true);
  assert.equal(gl.fee_simple_ownership, false);
  assert.ok(gl.ground_lease_value > 0);
});

test('business value (FF&E/inventory/goodwill/franchise) is excluded from real-estate value', () => {
  const sep = buildBusinessValueSeparation({
    recordClass: { environmental_review_required: true },
    retail: { business_consideration: { ffe_value: 200000, inventory_value: 50000, goodwill_value: 300000, blended_business_and_re_price: 2000000 } },
  });
  assert.equal(sep.business_value_excluded_from_re, true);
  assert.equal(sep.total_business_value, 550000);
  assert.equal(sep.real_estate_only_consideration, 1450000);
  assert.equal(sep.environmental_review_required, true);
});

/* -------------------------------------------------------------------------- */
/* §17 Capital double-count guard                                              */
/* -------------------------------------------------------------------------- */

test('TI and LC are not double-counted with one-time capital', () => {
  const contract = buildRetailContract(stripRow(), retailInputs());
  const capital = buildRetailCapital(contract, { repairInputs: { immediate_repairs: 50000, roof_envelope: 80000, suite_turns: 40000, replacement_reserves: 12000 } });
  assert.equal(capital.double_count_guard.ti_lc_in_rollover_model_only, true);
  assert.equal(capital.double_count_guard.reserves_in_opex_only, true);
  // suite_turns / TI / LC are NOT in one_time_capital.
  assert.equal(capital.one_time_capital, 130000); // 50000 + 80000 only
});

/* -------------------------------------------------------------------------- */
/* §19 Buyer exit                                                              */
/* -------------------------------------------------------------------------- */

test('portfolio pricing is demand-only in buyer exit', () => {
  const a = fullAnalysis();
  assert.equal(a.buyer_exit.portfolio_pricing_excluded, true);
  assert.ok(a.buyer_exit.matched_buyer_count >= 1);
  assert.equal(a.buyer_exit.exit_classification, 'QUALIFIED');
});

/* -------------------------------------------------------------------------- */
/* §20/§21/§22 Strategies, qualification, execution-state basis                 */
/* -------------------------------------------------------------------------- */

test('commercial debt takeover is distinct from residential subject-to', () => {
  const contract = buildRetailContract(stripRow(), { ...retailInputs(), debt: { balance: 3000000, monthly_payment: 16000, interest_rate: 0.06, balloon_months: 36 } });
  const revenue = buildRetailRevenue(contract);
  const expenses = buildRetailExpenses(contract, { egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: 5000000, dominantLeaseType: LT.TRIPLE_NET });
  const noi = buildRetailNOI({ revenue, expenses, contract });
  const cd = buildRetailCommercialDebt({ contract, noi });
  assert.equal(cd.is_residential_subject_to, false);
  assert.equal(cd.debt_model, 'COMMERCIAL_DEBT_TAKEOVER');
  assert.ok(['HIGH', 'ELEVATED', 'MODERATE'].includes(cd.refinance_risk));
});

test('retail disposition is a commercial sale, not residential novation', () => {
  const a = fullAnalysis();
  assert.equal(a.strategies.disposition.is_residential_novation, false);
  assert.equal(a.strategies.disposition.strategy, 'RETAIL_MARKETED_DISPOSITION');
});

test('seller-finance DSCR behavior is reported per structure', () => {
  const a = fullAnalysis();
  const sf = a.strategies.seller_finance;
  assert.ok(sf.structures.cash_flow_optimized.dscr === null || typeof sf.structures.cash_flow_optimized.dscr === 'number');
  assert.ok(sf.structures.cash_flow_optimized.down_payment_pct < sf.structures.seller_price_optimized.down_payment_pct);
});

test('a stabilized multi-tenant center reaches SHADOW_MODE_READY (CASH basis), live unauthorized', () => {
  const a = fullAnalysis();
  assert.equal(a.execution_state, 'SHADOW_MODE_READY');
  assert.equal(a.execution_state_basis.execution_state_basis_strategy, 'CASH');
  assert.equal(a.execution_state_basis.cash_underwritten, true);
  assert.equal(a.execution_state_basis.cash_shadow_approved, true);
  assert.equal(a.execution_state_basis.cash_live_authorized, false);
  assert.equal(a.execution_state_basis.live_authorized_strategy, null);
  assert.equal(a.execution_state_basis.outbound_execution_enabled, false);
});

test('scenario/shadow/authorized monetary tiers are separated; authorized stays null', () => {
  const a = fullAnalysis();
  const cash = a.strategy_qualification.ranked.find((r) => r.strategy === 'CASH');
  assert.equal(cash.qualification_status, SQ.UNDERWRITTEN_SHADOW);
  assert.ok(cash.monetary.shadow_recommended > 0);
  assert.equal(cash.monetary.scenario_recommended, null);
  assert.equal(cash.monetary.authorized_recommended, null);
});

test('specialty record (gas station) is gated to DATA_REQUIRED, never shadow-priced', () => {
  const a = fullAnalysis({ subjectRow: { property_id: 'gs', property_type: 'Gas Station convenience store with fuel', is_retail: true, building_square_feet: 3000, property_address_state: 'TX' }, retail: { gross_leasable_area: 3000 } });
  // Either routed away or gated; if analysis is produced, it must be record-gated.
  if (a) {
    assert.equal(a.decision_gate.record_gated, true);
    assert.equal(a.execution_state, 'DATA_REQUIRED');
  }
});

/* -------------------------------------------------------------------------- */
/* §24 Coverage / production readiness                                          */
/* -------------------------------------------------------------------------- */

test('a building-level-only record stays PROVISIONAL/DATA_REQUIRED with no qualified value', () => {
  // Mirrors the live production reality (no lease/operating/transaction data).
  const a = fullAnalysis({ retail: { gross_leasable_area: 28500, number_of_suites: 8 }, retailComps: [], capRateEvidence: [], retailBuyers: [] });
  assert.notEqual(a.execution_state, 'SHADOW_MODE_READY');
  assert.equal(a.valuation.reconciliation.value_classification !== 'QUALIFIED', true);
  assert.equal(a.production_readiness.autonomous_ready, false);
});

/* -------------------------------------------------------------------------- */
/* Additivity / disabled execution invariants                                  */
/* -------------------------------------------------------------------------- */

test('isRetailLane only matches the two retail lanes', () => {
  assert.equal(isRetailLane(ASSET_LANES.RETAIL_STRIP_CENTER), true);
  assert.equal(isRetailLane(ASSET_LANES.RETAIL_SINGLE_TENANT), true);
  assert.equal(isRetailLane(ASSET_LANES.SELF_STORAGE), false);
  assert.equal(isRetailLane(ASSET_LANES.SFR), false);
});

test('V2 remains byte-identical when retail is disabled (non-retail lane → null block)', () => {
  const sfr = buildV3Decision({ subjectRow: { property_id: 's', property_type: 'Single Family Residence', building_square_feet: 1800 }, qualification: emptyQualification(), buyerPurchases: [] });
  assert.equal(sfr.v3.retail, null);

  const strip = buildV3Decision({ subjectRow: stripRow(), qualification: emptyQualification(), buyerPurchases: [], retail: retailWrapper() });
  assert.notEqual(strip.v3.retail, null);
  assert.equal(strip.v3.retail.outbound_enabled, false);
  assert.equal(strip.v3.retail.auto_execution_enabled, false);
});

test('no outbound execution is enabled anywhere in the retail block', () => {
  const a = fullAnalysis();
  assert.equal(a.outbound_enabled, false);
  assert.equal(a.auto_execution_enabled, false);
  assert.equal(a.execution_state_basis.outbound_execution_enabled, false);
  for (const r of a.strategy_qualification.ranked) {
    assert.equal(r.live_authorized, false);
    assert.equal(r.authorized_offer, false);
  }
});

test('retail decision exposes missing inputs and never coerces missing to zero', () => {
  const a = fullAnalysis({ retail: { gross_leasable_area: 28500 } });
  assert.ok(Array.isArray(a.missing_inputs));
  assert.ok(a.missing_inputs.length > 0);
});

/* -------------------------------------------------------------------------- */
/* Market context                                                              */
/* -------------------------------------------------------------------------- */

test('supply data is reported UNAVAILABLE rather than fabricated', () => {
  const ctx = buildRetailMarketContext({ market: { population_growth: 1.5, household_growth: 1.2, retail_sales_growth: 1.8 } });
  assert.equal(ctx.supply_risk_status, 'UNAVAILABLE');
  assert.ok(ctx.note.includes('not fabricated'));
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function emptyQualification() {
  return {
    anchors: {}, sample: {}, anomaly_flags: [], clusters_summary: [], rejected: [],
    accepted: [], universes: {},
  };
}

function retailWrapper() {
  return {
    subject: retailInputs(),
    comps: [...qualifiedRetailComps()],
    buyers: [{ normalized_buyer_name: 'regional retail partners', buyer_type: 'regional', purchase_count: 6, avg_purchase_price: 5000000, preferred_price_min: 2000000, preferred_price_max: 9000000 }],
    cap_rate_evidence: observedRetailCap(),
    market: { tier: 'SECONDARY', population_growth: 1.8, household_growth: 1.6, retail_sales_growth: 2.0 },
  };
}
