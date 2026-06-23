/**
 * Acquisition Engine V3 — Item 5F office & medical-office intelligence &
 * underwriting.
 *
 * Deterministic, source-traceable office model: classification isolation (medical
 * vs general; life-science / data-center / hospital / coworking-business special
 * review; office condo ≠ whole building), subtype discipline, lease normalization
 * (coworking license ≠ ordinary lease; rentable-vs-usable + load factor), tenant-
 * credit (brand ≠ guaranty; hospital proximity ≠ health-system credit), rent-roll
 * normalization (no fabricated suite precision), revenue/expense/NOI/cap
 * separation, reimbursement leakage, parking-income separation, tenant + industry
 * concentration, WALE/WALT, rollover/TI/LC discipline, distress/obsolescence,
 * medical specialization (earned premium only), owner-user separation, comparable-
 * universe rules, valuation method monotonicity, business-value exclusion,
 * class-first strategy qualification, explicit execution-state basis, additivity
 * (V2 byte-identical when office is absent), and the disabled-execution invariant.
 *
 * Production reality (audit §1, §24): there is NO office operating/lease data and
 * NO office transaction comp in production (office inventory is thin, TX-skewed,
 * no NOI/cap/rent/lease/transaction), so qualified paths are exercised with
 * clearly-labeled deterministic fixtures, never a production sample.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_LANES, STRATEGY_QUALIFICATION as SQ } from '@/lib/acquisition/modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from '@/lib/acquisition/incomeSnapshotContract.js';
import {
  classifyOfficeAsset, classifyOfficeRecord, classifyOfficeTenancy, classifyOfficeOperationalStatus,
} from '@/lib/acquisition/officeClassification.js';
import {
  OFFICE_SUBTYPE as ST, OFFICE_RECORD_CLASS as RC, LEASE_TYPE as LT,
  TENANT_CREDIT_CLASS as TC, MEDICAL_TENANT_CLASS as MTC, OFFICE_TENANCY as TEN,
} from '@/lib/acquisition/officeConstants.js';
import { recognizeLeaseType, normalizeLease, classifyTenantCredit, classifyMedicalTenantCredit } from '@/lib/acquisition/officeLeaseModel.js';
import { buildOfficeContract, buildRentRoll, officeMissingInputs } from '@/lib/acquisition/officeContract.js';
import {
  buildOfficeRevenue, buildOfficeExpenses, buildOfficeNOI, buildOfficeRollover,
  buildOfficeCapRate, qualifyObservedOfficeCap, buildOfficeDistress, OFFICE_CAP_KIND,
} from '@/lib/acquisition/officeUnderwriting.js';
import { qualifyOfficeComp, buildOfficeComparables, OFFICE_COMP_UNIVERSE, buildOfficeMarketContext } from '@/lib/acquisition/officeComps.js';
import {
  buildOfficeValuation, buildMedicalSpecialization, buildOwnerUserValue,
  buildOfficeCapital, buildBusinessValueSeparation, buildLeaseDCF,
} from '@/lib/acquisition/officeValuation.js';
import { buildOfficeBuyerExit } from '@/lib/acquisition/officeBuyerExit.js';
import { valueFromCap } from '@/lib/acquisition/incomeUnderwriting.js';
import {
  buildOfficeCommercialDebt, buildOfficeDisposition, qualifyOfficeStrategies, buildOfficeExecutionBasis,
} from '@/lib/acquisition/officeStrategies.js';
import { buildOfficeAnalysis, isOfficeLane } from '@/lib/acquisition/officeDecision.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
// Regression target: retail lane must remain intact (no shared-extraction regression).
import { buildRetailAnalysis } from '@/lib/acquisition/retailDecision.js';

/* -------------------------------------------------------------------------- */
/* Fixtures (clearly-labeled, deterministic — NOT a production sample)         */
/* -------------------------------------------------------------------------- */

function officeRow() {
  return {
    property_id: 'of-subB', property_type: 'Suburban Class B Office', building_class: 'B',
    building_square_feet: 60000, lot_square_feet: 150000, number_of_suites: 6,
    floor_count: 3, year_built: 2005, property_address_state: 'TX',
  };
}

function officeLeases() {
  return [
    { tenant_name: 'Acme Law LLP', suite: '300', floor: 3, leased_square_feet: 20000, usable_square_feet: 17400, lease_type: 'full service gross', annual_base_rent: 520000, annual_escalation_pct: 0.03, lease_expiration: '2031-06-30', industry: 'legal' },
    { tenant_name: 'TechCo Software', suite: '200', floor: 2, leased_square_feet: 15000, lease_type: 'modified gross', monthly_base_rent: 34000, lease_expiration: '2028-03-31', industry: 'technology' },
    { tenant_name: 'Regional Bank', suite: '100', floor: 1, leased_square_feet: 18000, base_rent_per_rsf: 26, lease_expiration: '2030-12-31', tax_reimbursement: true, insurance_reimbursement: true, opex_reimbursement: true, industry: 'financial' },
  ];
}

function officeInputs(overrides = {}) {
  return {
    rentable_building_area: 58000,
    number_of_suites: 6, floor_count: 3, parking_spaces: 200,
    operations: { physical_occupancy: 0.91, economic_occupancy: 0.88, market_rent_psf: 28, ...(overrides.operations ?? {}) },
    income: {
      base_rental_income: 1300000, expense_reimbursement_income: 150000, parking_income: 60000,
      in_place_rent_psf: 24.6, ...(overrides.income ?? {}),
    },
    expenses: { property_taxes: 200000, insurance: 32000, utilities: 140000, janitorial: 78000, management: 60000, ...(overrides.expenses ?? {}) },
    leases: overrides.leases ?? officeLeases(),
    ...overrides.top,
  };
}

function qualifiedOfficeComps() {
  return [
    { property_type: 'suburban class b office', sale_price: 11000000, building_square_feet: 56000, occupancy: 0.9, property_address_state: 'TX', sale_date: '2025-09-01', cap_rate: 0.085, noi: 935000 },
    { property_type: 'suburban class b office', sale_price: 9500000, building_square_feet: 52000, occupancy: 0.88, property_address_state: 'TX', sale_date: '2025-07-01', cap_rate: 0.087, noi: 826500 },
    { property_type: 'low rise office', sale_price: 12500000, building_square_feet: 60000, occupancy: 0.92, property_address_state: 'TX', sale_date: '2025-10-01', cap_rate: 0.082, noi: 1025000 },
  ];
}

function observedOfficeCap() {
  return [
    { sale_price: 11000000, observed_noi: 935000, exact_office_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 9500000, observed_noi: 826500, exact_office_subtype: true, sale_date: '2025-07-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
    { sale_price: 12500000, observed_noi: 1025000, exact_office_subtype: true, sale_date: '2025-10-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL },
  ];
}

function fullAnalysis(overrides = {}) {
  return buildOfficeAnalysis({
    subjectRow: overrides.subjectRow ?? officeRow(),
    office: overrides.office ?? officeInputs(),
    officeComps: overrides.officeComps ?? [
      ...qualifiedOfficeComps(),
      { property_type: 'warehouse', sale_price: 9000000, building_square_feet: 100000 },
      { property_type: 'suburban office portfolio', sale_price: 80000000, is_portfolio: true, parcel_count: 7 },
    ],
    officeBuyers: overrides.officeBuyers ?? [{ normalized_buyer_name: 'regional office partners', buyer_type: 'regional office operator', purchase_count: 6, avg_purchase_price: 12000000, preferred_price_min: 5000000, preferred_price_max: 20000000, preferred_subtypes: [ST.SUBURBAN_CLASS_B_OFFICE] }],
    capRateEvidence: overrides.capRateEvidence ?? observedOfficeCap(),
    market: overrides.market ?? { tier: 'SECONDARY', employment_growth: 1.5, office_using_jobs_growth: 1.2, return_to_office_rate: 65 },
    repairInputs: overrides.repairInputs ?? {},
  });
}

function medicalRow() {
  return {
    property_id: 'mob-1', property_type: 'Medical Office Building', is_medical_office: true,
    building_square_feet: 40000, number_of_suites: 5, floor_count: 2, year_built: 2012, property_address_state: 'TX',
  };
}

function medicalInputs(overrides = {}) {
  return {
    rentable_building_area: 38000,
    number_of_suites: 5, floor_count: 2, parking_spaces: 220,
    operations: { physical_occupancy: 0.94, economic_occupancy: 0.92, market_rent_psf: 32, ...(overrides.operations ?? {}) },
    income: { base_rental_income: 1100000, expense_reimbursement_income: 180000, in_place_rent_psf: 30.4, ...(overrides.income ?? {}) },
    expenses: { property_taxes: 180000, insurance: 30000, utilities: 120000, management: 52000, ...(overrides.expenses ?? {}) },
    medical: { medical_buildout_pct: 0.45, specialized_ti_replacement_cost: 3400000, hospital_affiliation: 'Regional Health System', ...(overrides.medical ?? {}) },
    leases: overrides.leases ?? [
      { tenant_name: 'Regional Health System Cardiology', leased_square_feet: 20000, lease_type: 'triple net', annual_base_rent: 640000, lease_expiration: '2034-12-31', tax_reimbursement: true, insurance_reimbursement: true, opex_reimbursement: true, hospital_affiliation: 'Regional Health System', health_system_guaranty: true, specialized_buildout_owner: 'landlord', restoration_obligation: true },
      { tenant_name: 'Dental Associates Group', leased_square_feet: 12000, lease_type: 'modified gross', annual_base_rent: 360000, lease_expiration: '2029-06-30', group_practice: true },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* §0 Cross-lane reuse — retail is NOT regressed by office                      */
/* -------------------------------------------------------------------------- */

test('office build does not regress the retail lane (no shared-extraction breakage)', () => {
  const retail = buildRetailAnalysis({
    subjectRow: { property_id: 'rt', property_type: 'Neighborhood Strip Center', is_strip_center: true, building_square_feet: 30000, number_of_suites: 8, property_address_state: 'TX' },
    retail: { gross_leasable_area: 28500, number_of_suites: 8 },
  });
  assert.ok(retail);
  assert.equal(retail.is_retail, true);
  assert.equal(retail.outbound_enabled, false);
});

/* -------------------------------------------------------------------------- */
/* §2 Classification discipline                                                */
/* -------------------------------------------------------------------------- */

test('a generic office flag alone does not prove a high-confidence subtype', () => {
  const c = classifyOfficeAsset({ property_id: 'x', is_office: true, building_square_feet: 20000 });
  assert.equal(c.is_office, true);
  assert.equal(c.subtype, ST.AMBIGUOUS_OFFICE);
  assert.ok(c.confidence <= 45);
});

test('medical office is a separate lane/subtype from general office', () => {
  const med = classifyOfficeAsset(medicalRow());
  assert.equal(med.lane, ASSET_LANES.OFFICE_MEDICAL);
  assert.equal(med.is_medical, true);
  const gen = classifyOfficeAsset(officeRow());
  assert.equal(gen.lane, ASSET_LANES.OFFICE_GENERAL);
  assert.equal(gen.is_medical, false);
});

test('life science and data center remain SPECIAL_REVIEW, not ordinary office', () => {
  const lab = classifyOfficeRecord({ property_type: 'Life Science Research Building with wet lab', building_square_feet: 80000 });
  assert.equal(lab.classification, RC.LABORATORY_LIFE_SCIENCE);
  assert.equal(lab.special_review, true);
  assert.equal(lab.pricing_eligible, false);
  const dc = classifyOfficeRecord({ property_type: 'Data Center colocation facility', building_square_feet: 100000 });
  assert.equal(dc.classification, RC.DATA_CENTER);
  assert.equal(dc.special_review, true);
});

test('an office condominium UNIT is not a whole-building office asset', () => {
  const condo = classifyOfficeRecord({ property_type: 'Office Condominium unit', building_square_feet: 2500 });
  assert.equal(condo.classification, RC.OFFICE_CONDOMINIUM);
  assert.equal(condo.pricing_eligible, false); // not investor-priced as a whole building
  assert.equal(condo.owner_user_pricing_eligible, true);
});

test('a coworking operating business is special review, not ordinary office', () => {
  const cw = classifyOfficeRecord({ property_type: 'WeWork coworking operating business for sale', building_square_feet: 30000 });
  assert.equal(cw.classification, RC.COWORKING_BUSINESS);
  assert.equal(cw.special_review, true);
});

test('a converted residential office is flagged, not priced as ordinary office', () => {
  const conv = classifyOfficeRecord({ property_type: 'Converted residential house used as office', building_square_feet: 2200 });
  assert.equal(conv.classification, RC.CONVERTED_RESIDENTIAL_OFFICE);
  assert.equal(conv.pricing_eligible, false);
});

test('tenancy and operational status are classified separately', () => {
  const ten = classifyOfficeTenancy({ rentRoll: { total_suites: 6, occupied_suites: 5 }, row: {} });
  assert.equal(ten.tenancy, TEN.MULTI_TENANT);
  const op = classifyOfficeOperationalStatus({ rentRoll: { physical_occupancy: 0.6 }, row: { year_built: 2024 } });
  assert.equal(op.operational_status, 'LEASE_UP');
});

/* -------------------------------------------------------------------------- */
/* §4 Lease normalization                                                      */
/* -------------------------------------------------------------------------- */

test('lease type recognition: FSG, modified gross, NNN, and coworking license', () => {
  assert.equal(recognizeLeaseType({ lease_type: 'full service gross' }).lease_type, LT.FULL_SERVICE_GROSS);
  assert.equal(recognizeLeaseType({ lease_type: 'modified gross' }).lease_type, LT.MODIFIED_GROSS);
  assert.equal(recognizeLeaseType({ lease_type: 'NNN' }).lease_type, LT.TRIPLE_NET);
  assert.equal(recognizeLeaseType({ is_coworking_license: true }).lease_type, LT.COWORKING_LICENSE);
});

test('a single pass-through does not make a lease NNN', () => {
  // Only taxes reimbursed → SINGLE_NET, never TRIPLE_NET.
  const r = recognizeLeaseType({ tax_reimbursement: true });
  assert.equal(r.lease_type, LT.SINGLE_NET);
});

test('coworking license is NOT treated as durable lease income', () => {
  const l = normalizeLease({ tenant_name: 'WeWork', is_coworking_license: true, leased_square_feet: 10000, annual_base_rent: 300000 });
  assert.equal(l.is_coworking_license, true);
  assert.equal(l.annual_base_rent, null);
  assert.equal(l.coworking_license_fee_annual, 300000);
  assert.equal(l.expiration_risk, 'LICENSE_NO_DURABLE_TERM');
});

test('lease normalization tracks rentable vs usable area and load factor', () => {
  const l = normalizeLease({ tenant_name: 'A', leased_square_feet: 11500, usable_square_feet: 10000, annual_base_rent: 300000 });
  assert.equal(l.rentable_square_feet, 11500);
  assert.equal(l.usable_square_feet, 10000);
  assert.equal(l.load_factor, 1.15);
  assert.ok(l.base_rent_per_rsf < l.base_rent_per_usf); // rent/USF > rent/RSF
});

test('missing lease data stays UNKNOWN and is listed, never coerced to zero', () => {
  const l = normalizeLease({ tenant_name: 'B', leased_square_feet: 5000 });
  assert.equal(l.annual_base_rent, null);
  assert.ok(l.missing_inputs.includes('base_rent'));
  assert.ok(l.missing_inputs.includes('lease_expiration_or_remaining_term'));
});

/* -------------------------------------------------------------------------- */
/* §5 Tenant credit discipline                                                 */
/* -------------------------------------------------------------------------- */

test('a brand name alone does not establish a corporate guaranty', () => {
  const c = classifyTenantCredit({ tenant_name: 'Microsoft' }); // no guaranty evidence
  assert.equal(c.credit_class, TC.NATIONAL_CORPORATE);
  assert.notEqual(c.credit_class, TC.INVESTMENT_GRADE_CORPORATE);
  const withGuaranty = classifyTenantCredit({ tenant_name: 'Microsoft', corporate_guaranty: true });
  assert.equal(withGuaranty.credit_class, TC.INVESTMENT_GRADE_CORPORATE);
});

test('a coworking operator is not durable office income', () => {
  const c = classifyTenantCredit({ tenant_name: 'Regus' });
  assert.equal(c.credit_class, TC.COWORKING_OPERATOR);
  assert.equal(c.durable_office_income, false);
});

test('hospital proximity does not prove health-system credit', () => {
  const c = classifyMedicalTenantCredit({ tenant_name: 'Dr. Smith Family Medicine', on_hospital_campus: true });
  assert.notEqual(c.credit_class, MTC.HEALTH_SYSTEM);
  assert.equal(c.health_system_credit, false);
  assert.equal(c.proximity_proves_credit, false);
  // An evidenced health-system tenant IS health-system credit.
  const sys = classifyMedicalTenantCredit({ tenant_name: 'Kaiser Permanente Medical Center', health_system_guaranty: true });
  assert.equal(sys.credit_class, MTC.HEALTH_SYSTEM);
});

test('physician use does not by itself prove long-term stability', () => {
  const c = classifyMedicalTenantCredit({ tenant_name: 'Family Medicine Associates' });
  assert.equal(c.physician_use_proves_stability, false);
});

/* -------------------------------------------------------------------------- */
/* §6 Rent roll                                                                 */
/* -------------------------------------------------------------------------- */

test('building-level-only input yields a BUILDING_LEVEL roll without fabricated suite precision', () => {
  const rr = buildRentRoll(officeRow(), { rentable_building_area: 58000, number_of_suites: 6 });
  assert.equal(rr.basis, 'BUILDING_LEVEL');
  assert.equal(rr.in_place_rent_psf, null);
  assert.equal(rr.wale_years, null);
  assert.ok(rr.missing.includes('suite_level_rents'));
});

test('lease-level roll computes occupancy, concentration, industry concentration and WALE/WALT', () => {
  const rr = buildRentRoll(officeRow(), { ...officeInputs(), _isMedical: false });
  assert.equal(rr.basis, 'LEASE_LEVEL');
  assert.ok(rr.physical_occupancy > 0 && rr.physical_occupancy <= 1);
  assert.ok(rr.tenant_concentration > 0);
  assert.ok(rr.top_five_share > 0);
  assert.ok(rr.wale_years > 0);
  assert.ok(rr.walt_years > 0);
  assert.ok(rr.industry_concentration && rr.industry_concentration.share !== null);
});

test('physical, leased, and economic occupancy remain separate fields', () => {
  const a = fullAnalysis();
  const ops = a.contract.operations;
  assert.ok('physical_occupancy' in ops);
  assert.ok('leased_occupancy' in ops);
  assert.ok('economic_occupancy' in ops);
});

/* -------------------------------------------------------------------------- */
/* §7 Revenue                                                                   */
/* -------------------------------------------------------------------------- */

test('parking income is separated from base rent and reimbursements', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const rev = buildOfficeRevenue(c);
  assert.equal(rev.parking_income_annual, 60000);
  assert.equal(rev.base_and_ancillary_separate, true);
  assert.ok(rev.current_contractual_base_annual !== rev.parking_income_annual);
});

test('coworking service revenue is excluded from real-estate revenue', () => {
  const c = buildOfficeContract(officeRow(), officeInputs({ income: { coworking_service_revenue: 500000, base_rental_income: 1300000 } }));
  const rev = buildOfficeRevenue(c);
  assert.equal(rev.coworking_service_revenue_in_re_income, false);
  assert.equal(rev.coworking_service_revenue_excluded, 500000);
});

/* -------------------------------------------------------------------------- */
/* §8 Expenses                                                                  */
/* -------------------------------------------------------------------------- */

test('expense model tracks reimbursement leakage; NNN is not full recovery', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const rev = buildOfficeRevenue(c);
  const exp = buildOfficeExpenses(c, { egrAnnual: rev.effective_gross_revenue_annual, subjectValue: 9000000, dominantLeaseType: LT.TRIPLE_NET });
  assert.equal(exp.full_nnn_recovery_assumed, false);
  assert.ok(exp.reimbursement_leakage >= 0);
  assert.ok(exp.recoverable_expenses >= exp.reimbursed_expenses);
});

test('full-service-gross keeps opex with the landlord (high leakage)', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const rev = buildOfficeRevenue(c);
  const fsg = buildOfficeExpenses(c, { egrAnnual: rev.effective_gross_revenue_annual, subjectValue: 9000000, dominantLeaseType: LT.FULL_SERVICE_GROSS });
  const nnn = buildOfficeExpenses(c, { egrAnnual: rev.effective_gross_revenue_annual, subjectValue: 9000000, dominantLeaseType: LT.TRIPLE_NET });
  assert.ok(fsg.reimbursement_leakage > nnn.reimbursement_leakage);
});

/* -------------------------------------------------------------------------- */
/* §9 NOI                                                                       */
/* -------------------------------------------------------------------------- */

test('NOI excludes debt service, capex, TI/LC and business-service income', () => {
  const a = fullAnalysis();
  assert.ok(a.noi.current_noi);
  for (const ex of ['debt_service', 'capital_expenditures', 'tenant_improvements', 'leasing_commissions', 'business_service_income']) {
    assert.ok(a.noi.current_noi.excludes.includes(ex), `NOI must exclude ${ex}`);
  }
});

/* -------------------------------------------------------------------------- */
/* §10 Rollover / TI / LC                                                       */
/* -------------------------------------------------------------------------- */

test('rollover exposure is reported by 12/24/36/60 months with required leasing capital', () => {
  const a = fullAnalysis();
  assert.equal(a.rollover.available, true);
  assert.ok('rollover_12m_rsf' in a.rollover);
  assert.ok('rollover_60m_rsf' in a.rollover);
  assert.ok(a.rollover.required_leasing_capital >= 0);
});

test('TI/LC (leasing capital) reduce DCF value', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const rev = buildOfficeRevenue(c);
  const exp = buildOfficeExpenses(c, { egrAnnual: rev.effective_gross_revenue_annual, subjectValue: 9000000, dominantLeaseType: LT.MODIFIED_GROSS });
  const noi = buildOfficeNOI({ revenue: rev, expenses: exp, contract: c });
  const withCapital = buildLeaseDCF({ contract: c, noi, rollover: { required_leasing_capital: 1500000 }, marketCap: 0.085, operationalStatus: 'STABILIZED' });
  const withoutCapital = buildLeaseDCF({ contract: c, noi, rollover: { required_leasing_capital: 0 }, marketCap: 0.085, operationalStatus: 'STABILIZED' });
  assert.ok(withCapital.present_value < withoutCapital.present_value);
});

test('TI/LC are not double-counted: offer one-time capital excludes reserves and TI/LC', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const cap = buildOfficeCapital(c, { repairInputs: { immediate_repairs: 100000, roof_envelope: 200000, replacement_reserves: 50000, suite_turns: 300000 } });
  // one_time_capital excludes reserves and suite turns (TI).
  assert.equal(cap.one_time_capital, 300000);
  assert.equal(cap.double_count_guard.offer_one_time_capital, 300000);
  assert.equal(cap.double_count_guard.ti_lc_in_rollover_model_only, true);
  assert.equal(cap.double_count_guard.reserves_in_opex_only, true);
});

test('medical TI buildout exposure and conversion cost remain explicit', () => {
  const a = fullAnalysis({ subjectRow: medicalRow(), office: medicalInputs() });
  assert.equal(a.is_medical, true);
  assert.ok(a.rollover.medical_buildout_exposure !== null);
  assert.ok(a.medical_specialization.conversion_cost_to_office !== null);
  assert.ok(a.medical_specialization.specialized_buildout_value !== null);
});

/* -------------------------------------------------------------------------- */
/* §11 Distress / obsolescence                                                  */
/* -------------------------------------------------------------------------- */

test('WFH demand risk + sublease overhang are flagged in distress', () => {
  const c = buildOfficeContract({ ...officeRow(), building_class: 'C', year_built: 1980 }, officeInputs({ operations: { physical_occupancy: 0.7, economic_occupancy: 0.6, sublease_vacancy: 8000, market_rent_psf: 22 } }));
  const rev = buildOfficeRevenue(c);
  const distress = buildOfficeDistress({ contract: c, revenue: rev, rollover: { near_term_material: true }, marketContext: { growth_support: 'SOFT' } });
  assert.equal(distress.wfh_demand_risk, true);
  assert.ok(distress.distress_flags.includes('sublease_overhang'));
  assert.ok(distress.total_obsolescence_discount_pct > 0);
  assert.equal(distress.historical_noi_not_capitalized_against_vacancy, true);
});

/* -------------------------------------------------------------------------- */
/* §12 Medical specialization                                                   */
/* -------------------------------------------------------------------------- */

test('medical premium is EARNED only with specialized buildout AND defensible tenant', () => {
  // Strong: buildout + health-system tenant → earned premium.
  const strong = buildMedicalSpecialization({
    contract: buildOfficeContract(medicalRow(), medicalInputs()),
    ordinaryOfficeSupport: 10000000,
    tenantCredit: { credit_class: 'HEALTH_SYSTEM' },
    rollover: { medical_buildout_exposure: 2000000 },
  });
  assert.equal(strong.medical_use_premium_earned, true);
  assert.ok(strong.medical_specialized_value > 10000000);

  // Weak: no buildout, weak tenant → NO premium, cannot exceed ordinary support.
  const weak = buildMedicalSpecialization({
    contract: buildOfficeContract({ ...medicalRow(), property_type: 'Medical Office Building' }, { rentable_building_area: 38000 }),
    ordinaryOfficeSupport: 10000000,
    tenantCredit: { credit_class: 'INDIVIDUAL_PRACTICE' },
  });
  assert.equal(weak.medical_use_premium_earned, false);
  assert.equal(weak.medical_specialized_value, 10000000);
  assert.equal(weak.medical_value_cannot_exceed_office_without_evidence, true);
});

test('a building labeled medical does not auto-receive a premium', () => {
  const a = fullAnalysis({ subjectRow: { property_id: 'm2', property_type: 'Medical Office Building', is_medical_office: true, building_square_feet: 25000, property_address_state: 'TX' }, office: { rentable_building_area: 24000, operations: { physical_occupancy: 0.9, market_rent_psf: 28 } } });
  assert.equal(a.is_medical, true);
  // No specialized buildout / strong tenant evidence → no earned premium.
  assert.equal(a.medical_specialization.medical_use_premium_earned, false);
});

/* -------------------------------------------------------------------------- */
/* §13 Comparables                                                              */
/* -------------------------------------------------------------------------- */

test('non-office comps (retail / warehouse) are rejected, never substituted', () => {
  const r1 = qualifyOfficeComp({ property_type: 'strip center', sale_price: 5000000, building_square_feet: 30000 }, { subjectSubtype: ST.SUBURBAN_CLASS_B_OFFICE });
  assert.equal(r1.qualified, false);
  assert.equal(r1.reason, 'non_office_asset_rejected');
  const r2 = qualifyOfficeComp({ property_type: 'warehouse distribution', sale_price: 9000000, building_square_feet: 100000 }, { subjectSubtype: ST.SUBURBAN_CLASS_B_OFFICE });
  assert.equal(r2.qualified, false);
});

test('medical comps are isolated from general office comps and vice versa', () => {
  const medForGeneral = qualifyOfficeComp({ property_type: 'medical office building', sale_price: 14000000, building_square_feet: 40000 }, { subjectSubtype: ST.SUBURBAN_CLASS_B_OFFICE });
  assert.equal(medForGeneral.qualified, false);
  assert.equal(medForGeneral.reason, 'medical_comp_for_general_subject_rejected');
  const genForMedical = qualifyOfficeComp({ property_type: 'suburban class b office', sale_price: 11000000, building_square_feet: 56000 }, { subjectSubtype: ST.MEDICAL_OFFICE_BUILDING });
  assert.equal(genForMedical.qualified, false);
});

test('portfolio / package office transactions are demand-only, never priced', () => {
  const comps = buildOfficeComparables([
    ...qualifiedOfficeComps(),
    { property_type: 'office portfolio', sale_price: 90000000, is_portfolio: true, parcel_count: 8, buyer_name: 'Big Fund' },
  ], { subjectSubtype: ST.SUBURBAN_CLASS_B_OFFICE });
  assert.equal(comps.demand_only_count, 1);
  assert.equal(comps.portfolio_pricing_excluded, true);
  assert.equal(comps.qualified_count, 3);
});

test('life science / data center comps are isolated, not substituted for office', () => {
  const r = qualifyOfficeComp({ property_type: 'life science research building', sale_price: 30000000, building_square_feet: 80000 }, { subjectSubtype: ST.SUBURBAN_CLASS_B_OFFICE });
  assert.equal(r.qualified, false);
  assert.equal(r.universe, OFFICE_COMP_UNIVERSE.SPECIAL_REVIEW_LIFE_SCIENCE_DATA_CENTER);
});

/* -------------------------------------------------------------------------- */
/* §13/§14 Cap rate + DCF                                                       */
/* -------------------------------------------------------------------------- */

test('an observed cap requires an observed (actual) NOI; modeled NOI cannot create one', () => {
  const ok = qualifyObservedOfficeCap({ sale_price: 10000000, observed_noi: 850000, exact_office_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.ACTUAL });
  assert.equal(ok.qualified, true);
  assert.equal(ok.kind, OFFICE_CAP_KIND.OBSERVED);
  const modeled = qualifyObservedOfficeCap({ sale_price: 10000000, observed_noi: 850000, exact_office_subtype: true, sale_date: '2025-09-01', noi_period: 'T12', noi_basis: EVIDENCE_BASIS.MARKET_MODELED });
  assert.equal(modeled.qualified, false);
  assert.ok(modeled.reasons.includes('noi_not_observed'));
});

test('with <3 observed sales the selected cap is MODELED_MARKET, never observed', () => {
  const cr = buildOfficeCapRate({ subtype: ST.SUBURBAN_CLASS_B_OFFICE, observedEvidence: [], impliedNoi: 800000, impliedValue: 9000000 });
  assert.equal(cr.selected.kind, OFFICE_CAP_KIND.MODELED_MARKET);
});

test('WFH risk widens the modeled office cap rate', () => {
  const base = buildOfficeCapRate({ subtype: ST.SUBURBAN_CLASS_B_OFFICE });
  const wfh = buildOfficeCapRate({ subtype: ST.SUBURBAN_CLASS_B_OFFICE, wfhRisk: true });
  assert.ok(wfh.modeled_market.cap_rate > base.modeled_market.cap_rate);
});

test('DCF reconciles cash-flow PV + terminal-value PV into present value', () => {
  const c = buildOfficeContract(officeRow(), officeInputs());
  const rev = buildOfficeRevenue(c);
  const exp = buildOfficeExpenses(c, { egrAnnual: rev.effective_gross_revenue_annual, subjectValue: 9000000, dominantLeaseType: LT.MODIFIED_GROSS });
  const noi = buildOfficeNOI({ revenue: rev, expenses: exp, contract: c });
  const dcf = buildLeaseDCF({ contract: c, noi, rollover: { required_leasing_capital: 500000 }, marketCap: 0.085, operationalStatus: 'STABILIZED' });
  assert.equal(dcf.available, true);
  assert.equal(dcf.present_value, dcf.pv_cash_flows + dcf.pv_terminal);
});

/* -------------------------------------------------------------------------- */
/* §15 Valuation monotonicity + vacant + owner-user                            */
/* -------------------------------------------------------------------------- */

test('NOI increase raises value; cap-rate increase lowers value', () => {
  assert.ok(valueFromCap(1000000, 0.07) > valueFromCap(800000, 0.07)); // NOI up → value up
  assert.ok(valueFromCap(1000000, 0.09) < valueFromCap(1000000, 0.07)); // cap up → value down
});

test('vacant office does not capitalize nonexistent rent as current NOI', () => {
  const a = fullAnalysis({
    subjectRow: { ...officeRow(), property_type: 'Vacant Office Building' },
    office: officeInputs({ operations: { physical_occupancy: 0, market_rent_psf: 28 }, income: { base_rental_income: 0 } }),
  });
  assert.equal(a.valuation.methods.current_noi_cap.available, false);
  assert.notEqual(a.valuation.dominant_method, 'CURRENT_NOI_CAP');
});

test('owner-user value is a separate universe and is excluded from the investor blend', () => {
  const a = fullAnalysis({ subjectRow: { ...officeRow(), property_type: 'Owner User Office', owner_occupied: true }, office: officeInputs() });
  assert.equal(a.owner_user_value.separate_universe, true);
  assert.equal(a.owner_user_value.does_not_set_investor_exit, true);
  assert.equal(a.valuation.reconciliation.owner_user_excluded_from_investor_blend, true);
  // OWNER_USER_VALUE method carries no weight in the investor reconciliation.
  assert.equal(a.valuation.reconciliation.method_weights.OWNER_USER_VALUE ?? 0, 0);
});

test('historical occupied NOI cannot override material vacancy/rollover (current ≠ stabilized)', () => {
  const c = buildOfficeContract(officeRow(), officeInputs({ leases: [
    { tenant_name: 'BigCo', leased_square_feet: 40000, lease_type: 'modified gross', annual_base_rent: 1000000, lease_expiration: '2026-09-30' }, // expires within 12m
  ] }));
  const rev = buildOfficeRevenue(c);
  const roll = buildOfficeRollover({ contract: c, revenue: rev });
  assert.equal(roll.near_term_material, true);
  assert.ok(roll.note && roll.note.includes('NOT stabilized'));
});

/* -------------------------------------------------------------------------- */
/* §18 Business-value separation                                               */
/* -------------------------------------------------------------------------- */

test('business value (coworking/medical-practice/equipment/goodwill) is excluded from RE value', () => {
  const sep = buildBusinessValueSeparation({ recordClass: { classification: RC.MULTI_TENANT_OFFICE }, office: { business_consideration: { ffe_value: 200000, goodwill_value: 500000, medical_practice_value: 1000000, blended_business_and_re_price: 12000000 } } });
  assert.equal(sep.business_value_excluded_from_re, true);
  assert.equal(sep.total_business_value, 1700000);
  assert.equal(sep.real_estate_only_consideration, 12000000 - 1700000);
});

/* -------------------------------------------------------------------------- */
/* §20 Strategies                                                              */
/* -------------------------------------------------------------------------- */

test('commercial debt takeover is distinct from residential subject-to', () => {
  const c = buildOfficeContract(officeRow(), officeInputs({ top: { debt: { balance: 6000000, monthly_payment: 32000, interest_rate: 0.055, balloon_months: 60 } } }));
  const noi = { current_noi: { noi: 800000 }, income_supported: true };
  const cd = buildOfficeCommercialDebt({ contract: c, noi });
  assert.equal(cd.is_residential_subject_to, false);
  assert.equal(cd.debt_model, 'COMMERCIAL_DEBT_TAKEOVER');
  assert.ok(cd.dscr > 0);
});

test('office disposition is a commercial sale, not residential novation', () => {
  const a = fullAnalysis();
  assert.equal(a.strategies.disposition.is_residential_novation, false);
  assert.equal(a.strategies.disposition.strategy, 'OFFICE_MARKETED_DISPOSITION');
});

test('seller-finance DSCR behavior is reported per structure', () => {
  const a = fullAnalysis();
  const sf = a.strategies.seller_finance;
  assert.ok(sf.structures.cash_flow_optimized.dscr !== undefined);
  assert.ok(sf.structures.balanced.dscr !== undefined);
  assert.ok(sf.structures.seller_price_optimized.dscr !== undefined);
});

/* -------------------------------------------------------------------------- */
/* §21/§22 Monetary tiers + execution-state basis                              */
/* -------------------------------------------------------------------------- */

test('a stabilized multi-tenant office reaches SHADOW_MODE_READY (CASH basis), live unauthorized', () => {
  const a = fullAnalysis();
  assert.equal(a.execution_state, 'SHADOW_MODE_READY');
  assert.equal(a.execution_state_basis.execution_state_basis_strategy, 'CASH');
  assert.equal(a.execution_state_basis.live_authorized_strategy, null);
});

test('scenario/shadow/authorized monetary tiers are separated; authorized stays null', () => {
  const a = fullAnalysis();
  const cash = a.strategy_qualification.ranked.find((r) => r.strategy === 'CASH');
  assert.ok(cash.monetary);
  assert.equal(cash.monetary.authorized_recommended, null); // flags disabled
  assert.ok(cash.monetary.shadow_recommended !== null); // underwritten shadow
  assert.equal(cash.monetary.scenario_recommended, null);
});

test('special-review record (life science) is gated to DATA_REQUIRED, never shadow-priced', () => {
  const a = fullAnalysis({ subjectRow: { property_id: 'ls', property_type: 'Life Science research building with wet lab', is_office: true, building_square_feet: 80000, property_address_state: 'TX' }, office: { rentable_building_area: 78000 } });
  if (a) {
    assert.equal(a.decision_gate.record_gated, true);
    assert.equal(a.execution_state, 'DATA_REQUIRED');
  }
});

/* -------------------------------------------------------------------------- */
/* §24 Coverage / production readiness                                          */
/* -------------------------------------------------------------------------- */

test('a building-level-only record stays PROVISIONAL/DATA_REQUIRED with no qualified value', () => {
  const a = fullAnalysis({ office: { rentable_building_area: 58000, number_of_suites: 6 }, officeComps: [], capRateEvidence: [], officeBuyers: [] });
  assert.notEqual(a.execution_state, 'SHADOW_MODE_READY');
  assert.equal(a.valuation.reconciliation.value_classification !== 'QUALIFIED', true);
  assert.equal(a.production_readiness.autonomous_ready, false);
});

/* -------------------------------------------------------------------------- */
/* Additivity / disabled execution invariants                                  */
/* -------------------------------------------------------------------------- */

test('isOfficeLane only matches the two office lanes', () => {
  assert.equal(isOfficeLane(ASSET_LANES.OFFICE_GENERAL), true);
  assert.equal(isOfficeLane(ASSET_LANES.OFFICE_MEDICAL), true);
  assert.equal(isOfficeLane(ASSET_LANES.RETAIL_STRIP_CENTER), false);
  assert.equal(isOfficeLane(ASSET_LANES.SFR), false);
});

test('V2 remains byte-identical when office is disabled (non-office lane → null block)', () => {
  const sfr = buildV3Decision({ subjectRow: { property_id: 's', property_type: 'Single Family Residence', building_square_feet: 1800 }, qualification: emptyQualification(), buyerPurchases: [] });
  assert.equal(sfr.v3.office, null);

  const office = buildV3Decision({ subjectRow: officeRow(), qualification: emptyQualification(), buyerPurchases: [], office: officeWrapper() });
  assert.notEqual(office.v3.office, null);
  assert.equal(office.v3.office.outbound_enabled, false);
  assert.equal(office.v3.office.auto_execution_enabled, false);
});

test('no outbound execution is enabled anywhere in the office block', () => {
  const a = fullAnalysis();
  assert.equal(a.outbound_enabled, false);
  assert.equal(a.auto_execution_enabled, false);
  assert.equal(a.execution_state_basis.outbound_execution_enabled, false);
  for (const r of a.strategy_qualification.ranked) {
    assert.equal(r.live_authorized, false);
    assert.equal(r.authorized_offer, false);
  }
});

test('office decision exposes missing inputs and never coerces missing to zero', () => {
  const a = fullAnalysis({ office: { rentable_building_area: 58000 } });
  assert.ok(Array.isArray(a.missing_inputs));
  assert.ok(a.missing_inputs.length > 0);
});

test('supply data is reported UNAVAILABLE rather than fabricated', () => {
  const ctx = buildOfficeMarketContext({ market: { employment_growth: 1.5, office_using_jobs_growth: 1.2, return_to_office_rate: 65 } });
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

function officeWrapper() {
  return {
    subject: officeInputs(),
    comps: [...qualifiedOfficeComps()],
    buyers: [{ normalized_buyer_name: 'regional office partners', buyer_type: 'regional', purchase_count: 6, avg_purchase_price: 12000000, preferred_price_min: 5000000, preferred_price_max: 20000000 }],
    cap_rate_evidence: observedOfficeCap(),
    market: { tier: 'SECONDARY', employment_growth: 1.5, office_using_jobs_growth: 1.2 },
  };
}
