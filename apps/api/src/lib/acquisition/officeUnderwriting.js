/**
 * Acquisition Engine V3 — Item 5F §7–§11, §13: office underwriting math.
 *
 * Pure, deterministic office primitives:
 *   - revenue (§7): contractual base + SEPARATED expense reimbursements + parking
 *     + signage + conference/amenity + other − vacancy − credit loss − concessions
 *     − downtime = effective gross revenue. Coworking SERVICE/business revenue is
 *     EXCLUDED unless separately isolated and supportable as real-estate income.
 *     Parking/signage income are kept separate from base rent.
 *   - expenses (§8): ACTUAL-first; recoverable vs reimbursed vs unreimbursed
 *     leakage tracked. Full-service-gross keeps opex with the landlord; NNN does
 *     not imply full reimbursement. Elevator cost applies for mid/high-rise;
 *     medical-systems maintenance applies for medical intensity.
 *   - NOI (§9): EGR − opex. Debt service / depreciation / income tax / capex / TI
 *     / LC / business-service income EXCLUDED by construction.
 *   - rollover (§10): per-expiration downtime / free rent / TI / LC / legal and a
 *     12/24/36/60-month rollover exposure. Office (and especially medical) TI/LC and
 *     downtime are explicit. Costs reduce value (never double-counted).
 *   - cap rate (§13): OBSERVED vs IMPLIED vs MODELED_MARKET kept separate; an
 *     observed cap requires a qualified sale + observed NOI + exact office subtype
 *     compatibility. A modeled NOI can NEVER create an observed cap rate.
 *   - distress/obsolescence (§11): WFH demand risk, sublease overhang, functional
 *     obsolescence, conversion feasibility, dark/redevelopment value.
 *
 * Missing values are UNKNOWN, never zero.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from './incomeSnapshotContract.js';
import { computeNOI, capRateFromValue, valueFromCap } from './incomeUnderwriting.js';
import {
  LEASE_TYPE as LT,
  LANDLORD_EXPENSE_EXPOSURE,
  OFFICE_OPEX_ASSUMPTIONS as OPEX,
  OFFICE_EXPENSE_CATEGORIES,
  OFFICE_DEFAULT_CAP_RATE,
  OFFICE_CAP_RATE_BOUNDS,
  OFFICE_STABILIZED_OCCUPANCY,
  OFFICE_ROLLOVER_ASSUMPTIONS as ROLL,
  CREDIT_CAP_ADJUSTMENT_BPS,
  OFFICE_HEIGHT as HT,
  OFFICE_OBSOLESCENCE as OBS,
} from './officeConstants.js';

const val = (f) => (f && isKnown(f) ? num(f.value) : null);

/* -------------------------------------------------------------------------- */
/* Revenue model (§7)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the office revenue picture. Base rent and each ancillary stream stay
 * separate; asking/market rent is POTENTIAL only. Coworking service/business
 * revenue is EXCLUDED from real-estate revenue.
 */
export function buildOfficeRevenue(contract) {
  const rr = contract.rent_roll ?? {};
  const op = contract.operations ?? {};
  const inc = contract.income ?? {};
  const rba = val(contract.physical.rentable_building_area);

  const lineage = [];
  const missing = [];

  const occupancy = num(rr.physical_occupancy) ?? val(op.physical_occupancy);

  // ---- Current ACTUAL contractual base rent ----
  let currentBaseAnnual = val(inc.base_rental_income) ?? num(rr.annualized_base_rent);
  let currentBasis = currentBaseAnnual !== null ? EVIDENCE_BASIS.ACTUAL : EVIDENCE_BASIS.UNKNOWN;
  if (currentBaseAnnual !== null) lineage.push(val(inc.base_rental_income) !== null ? 'income.base_rental_income(actual)' : 'rent_roll.annualized_base_rent');
  else missing.push('current_contractual_base_rent');

  // ---- Reimbursements (SEPARATED from base) ----
  const reimbursements = val(inc.expense_reimbursement_income) ?? (num(rr.reimbursement_income) !== null ? roundMoney(num(rr.reimbursement_income)) : null);

  // ---- Ancillary income (kept separate; parking/signage/amenity) ----
  const parkingIncome = val(inc.parking_income) ?? 0;
  const signageIncome = val(inc.signage_income) ?? 0;
  const conferenceIncome = val(inc.conference_amenity_income) ?? 0;
  const otherIncome = val(inc.other_income) ?? 0;

  // Coworking SERVICE revenue is recorded but EXCLUDED from real-estate revenue.
  const coworkingServiceRevenue = val(inc.coworking_service_revenue);

  // ---- Scheduled gross POTENTIAL (all RSF at market) ----
  const marketRentPsf = num(rr.market_rent_psf) ?? val(op.market_rent_psf);
  const scheduledGpr = marketRentPsf !== null && rba !== null ? roundMoney(marketRentPsf * rba) : null;
  if (scheduledGpr === null) missing.push('scheduled_gross_potential_revenue');
  else lineage.push('gpr=market_rent_psf*rba');

  // ---- Bridge to EGR ----
  const vacancyPct = occupancy !== null ? clamp(1 - occupancy, 0, 0.95) : null;
  const grossPotentialBase = scheduledGpr ?? (currentBaseAnnual !== null && occupancy ? roundMoney(currentBaseAnnual / occupancy) : currentBaseAnnual);
  const vacancyLoss = grossPotentialBase !== null && vacancyPct !== null ? roundMoney(grossPotentialBase * vacancyPct) : null;
  const concessions = val(op.concessions) ?? 0;
  const badDebt = val(op.bad_debt) ?? 0;

  const collectedBase = currentBaseAnnual !== null
    ? currentBaseAnnual
    : (grossPotentialBase !== null && vacancyLoss !== null ? grossPotentialBase - vacancyLoss : null);

  const egr = collectedBase !== null
    ? roundMoney(collectedBase + (reimbursements ?? 0) + parkingIncome + signageIncome + conferenceIncome + otherIncome - concessions - badDebt)
    : null;

  const stabilizedBase = scheduledGpr !== null ? roundMoney(scheduledGpr * OFFICE_STABILIZED_OCCUPANCY) : null;
  const stabilizedEgr = stabilizedBase !== null ? roundMoney(stabilizedBase + (reimbursements ?? 0) + parkingIncome + signageIncome + conferenceIncome + otherIncome) : null;

  if (occupancy === null) missing.push('occupancy');
  if (rba === null) missing.push('rentable_building_area');

  const incomeSupported = currentBaseAnnual !== null && currentBasis === EVIDENCE_BASIS.ACTUAL && occupancy !== null;

  return {
    current_contractual_base_annual: currentBaseAnnual,
    current_base_basis: currentBasis,
    reimbursement_income_annual: reimbursements,
    parking_income_annual: roundMoney(parkingIncome),
    signage_income_annual: roundMoney(signageIncome),
    conference_amenity_income_annual: roundMoney(conferenceIncome),
    other_income_annual: roundMoney(otherIncome),
    scheduled_gross_potential_annual: scheduledGpr,
    trailing_revenue_annual: null, // requires explicit T-12 input
    vacancy_pct: vacancyPct !== null ? round(vacancyPct, 4) : null,
    vacancy_loss_annual: vacancyLoss,
    concessions_annual: roundMoney(concessions),
    bad_debt_annual: roundMoney(badDebt),
    effective_gross_revenue_annual: egr,
    stabilized_egr_annual: stabilizedEgr,
    pro_forma_egr_annual: stabilizedEgr,
    revenue_per_rsf: rba && collectedBase !== null ? round(collectedBase / rba, 2) : null,
    in_place_rent_psf: num(rr.in_place_rent_psf),
    market_rent_psf: marketRentPsf,
    loss_to_lease_annual: num(rr.loss_to_lease_annual),
    physical_occupancy: occupancy,
    economic_occupancy: num(rr.economic_occupancy) ?? val(op.economic_occupancy),
    income_supported: incomeSupported,
    source_lineage: lineage,
    missing_inputs: [...new Set(missing)],
    // Explicit invariants for downstream/tests.
    asking_rent_is_potential_only: true,
    base_and_ancillary_separate: true,
    coworking_service_revenue_excluded: coworkingServiceRevenue !== null ? roundMoney(coworkingServiceRevenue) : null,
    coworking_service_revenue_in_re_income: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Expense model (§8)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Office operating-expense model. ACTUAL lines first, else MODELED + labeled.
 * Tracks recoverable vs reimbursed vs unreimbursed leakage — full-service-gross
 * keeps opex with the landlord; NNN does not imply full reimbursement (§8).
 * Excludes debt/depreciation/tax/capex/TI/LC.
 *
 * @param {object} contract
 * @param {object} args { egrAnnual, subjectValue, dominantLeaseType }
 */
export function buildOfficeExpenses(contract, { egrAnnual = null, subjectValue = null, dominantLeaseType = LT.UNKNOWN } = {}) {
  const exp = contract.expenses ?? {};
  const rba = val(contract.physical.rentable_building_area);
  const height = contract.height ?? HT.UNKNOWN;
  const isMedical = contract.is_medical === true;
  const structuredSpaces = val(contract.physical.structured_parking_spaces) ?? (val(contract.physical.structured_parking) === true ? val(contract.physical.parking_spaces) : null);
  const egr = num(egrAnnual);
  const lines = {};
  const known = [];
  const assumed = [];
  const missing = [];

  const set = (key, actualField, modeled, label, recoverable) => {
    const actual = val(actualField);
    if (actual !== null) {
      lines[key] = { value: roundMoney(actual), basis: EVIDENCE_BASIS.ACTUAL, source: actualField.source, recoverable };
      known.push(key);
    } else if (modeled !== null) {
      lines[key] = { value: roundMoney(modeled), basis: EVIDENCE_BASIS.MARKET_MODELED, source: label, recoverable };
      assumed.push(key);
    } else {
      lines[key] = { value: null, basis: EVIDENCE_BASIS.UNKNOWN, source: null, recoverable };
      missing.push(key);
    }
  };
  const perRsf = (rate) => (rba !== null ? rba * rate : null);
  const pctEgr = (rate) => (egr !== null ? egr * rate : null);
  const elevatorApplies = height === HT.MID_RISE || height === HT.HIGH_RISE;

  set('property_taxes', exp.property_taxes, subjectValue !== null ? subjectValue * OPEX.property_tax_rate_of_value : null, `assumed_${OPEX.property_tax_rate_of_value}_of_value`, true);
  set('insurance', exp.insurance, perRsf(OPEX.insurance_per_rsf), `assumed_${OPEX.insurance_per_rsf}/rsf`, true);
  set('utilities', exp.utilities, perRsf(OPEX.utilities_per_rsf), `assumed_${OPEX.utilities_per_rsf}/rsf`, true);
  set('repairs_maintenance', exp.repairs_maintenance, perRsf(OPEX.repairs_per_rsf), `assumed_${OPEX.repairs_per_rsf}/rsf`, true);
  set('hvac', exp.hvac, perRsf(OPEX.hvac_per_rsf), `assumed_${OPEX.hvac_per_rsf}/rsf`, true);
  set('elevator', exp.elevator, elevatorApplies ? perRsf(OPEX.elevator_per_rsf) : null, `assumed_${OPEX.elevator_per_rsf}/rsf_mid_high_rise`, true);
  set('janitorial', exp.janitorial, perRsf(OPEX.janitorial_per_rsf), `assumed_${OPEX.janitorial_per_rsf}/rsf`, true);
  set('security', exp.security, perRsf(OPEX.security_per_rsf), `assumed_${OPEX.security_per_rsf}/rsf`, true);
  set('landscaping_snow', exp.landscaping_snow, perRsf(OPEX.landscaping_snow_per_rsf), `assumed_${OPEX.landscaping_snow_per_rsf}/rsf`, true);
  set('payroll', exp.payroll, perRsf(OPEX.payroll_per_rsf), `assumed_${OPEX.payroll_per_rsf}/rsf`, true);
  set('management', exp.management, pctEgr(OPEX.management_pct), `assumed_${OPEX.management_pct}_of_egr`, false);
  set('administrative', exp.administrative, pctEgr(OPEX.administrative_pct), `assumed_${OPEX.administrative_pct}_of_egr`, false);
  set('legal_accounting', exp.legal_accounting, pctEgr(OPEX.legal_accounting_pct), `assumed_${OPEX.legal_accounting_pct}_of_egr`, false);
  set('marketing', exp.marketing, pctEgr(OPEX.marketing_pct), `assumed_${OPEX.marketing_pct}_of_egr`, false);
  set('parking_operations', exp.parking_operations, structuredSpaces !== null ? structuredSpaces * OPEX.parking_ops_per_space : null, `assumed_${OPEX.parking_ops_per_space}/structured_space`, false);
  set('medical_systems', exp.medical_systems, isMedical ? perRsf(OPEX.medical_systems_per_rsf) : null, `assumed_${OPEX.medical_systems_per_rsf}/rsf_medical`, true);
  set('replacement_reserves', exp.replacement_reserves, perRsf(OPEX.reserves_per_rsf), `assumed_${OPEX.reserves_per_rsf}/rsf`, false);

  const explicitTotal = val(exp.total_operating_expenses);
  const lineSum = Object.values(lines).reduce((s, l) => s + (l.value ?? 0), 0);
  const total = explicitTotal !== null ? explicitTotal : roundMoney(lineSum);

  const recoverableTotal = roundMoney(Object.values(lines).filter((l) => l.recoverable).reduce((s, l) => s + (l.value ?? 0), 0));
  const landlordExposure = LANDLORD_EXPENSE_EXPOSURE[dominantLeaseType] ?? LANDLORD_EXPENSE_EXPOSURE.UNKNOWN;
  const reimbursed = roundMoney(recoverableTotal * (1 - landlordExposure));
  const unreimbursedLeakage = roundMoney(recoverableTotal - reimbursed);

  return {
    dominant_lease_type: dominantLeaseType,
    lines,
    total_operating_expenses: total,
    recoverable_expenses: recoverableTotal,
    reimbursed_expenses: reimbursed,
    unreimbursed_expenses: unreimbursedLeakage,
    reimbursement_leakage: unreimbursedLeakage,
    landlord_expense_exposure: landlordExposure,
    expense_ratio: egr && egr > 0 ? round(total / egr, 3) : null,
    expense_per_rsf: rba ? round(total / rba, 2) : null,
    known_lines: known,
    assumed_lines: assumed,
    missing_lines: missing,
    confidence: clamp((known.length / OFFICE_EXPENSE_CATEGORIES.length) * 100 + 15, 0, 100),
    excludes: ['debt_service', 'depreciation', 'income_tax', 'acquisition_cost', 'capital_expenditures', 'tenant_improvements', 'leasing_commissions', 'business_service_income'],
    // Explicit invariant: full-service-gross retains opex; NNN ≠ full reimbursement.
    full_nnn_recovery_assumed: false,
  };
}

/* -------------------------------------------------------------------------- */
/* NOI model (§9)                                                              */
/* -------------------------------------------------------------------------- */

/** Office NOI from revenue + expenses, net of reimbursement leakage. */
export function buildOfficeNOI({ revenue, expenses, contract }) {
  const rba = val(contract.physical.rentable_building_area);
  const opex = num(expenses?.total_operating_expenses);
  const leakage = num(expenses?.reimbursement_leakage) ?? 0;

  const egr = num(revenue?.effective_gross_revenue_annual);
  const current = egr !== null && opex !== null
    ? { effective_gross_revenue: egr, operating_expenses: opex, reimbursement_leakage: leakage, noi: roundMoney(egr - opex), excludes: expenses.excludes }
    : null;

  const stabilizedEgr = num(revenue?.stabilized_egr_annual);
  const stabilized = stabilizedEgr !== null && opex !== null
    ? computeNOI({ gprAnnual: stabilizedEgr, vacancyPct: 0, opexAnnual: opex })
    : null;

  const noi = current?.noi ?? null;
  const incomeSupported = Boolean(revenue?.income_supported) && current !== null;

  return {
    current_noi: current,
    contractual_noi: current ? { noi: current.noi } : null,
    stabilized_noi: stabilized ? { effective_gross_revenue: stabilizedEgr, operating_expenses: opex, noi: stabilized.noi } : null,
    trailing_noi: null, // requires explicit trailing inputs
    pro_forma_noi: stabilized ? stabilized.noi : null,
    noi_per_rsf: noi !== null && rba ? round(noi / rba, 2) : null,
    operating_expense_ratio: egr && egr > 0 && opex !== null ? round(opex / egr, 3) : null,
    reimbursement_leakage: roundMoney(leakage),
    noi_confidence: incomeSupported ? clamp((expenses?.confidence ?? 0) * 0.5 + 40, 0, 90) : 25,
    income_supported: incomeSupported,
    source_lineage: revenue?.source_lineage ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Lease-rollover / re-tenanting model (§10)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Model upcoming expirations + vacant-space lease-up. Returns 12/24/36/60-month
 * rollover exposure, required leasing capital, weighted downtime, stabilized-
 * occupancy timeline, medical buildout exposure and a rollover risk score. Current
 * NOI is never treated as stabilized with material imminent rollover.
 */
export function buildOfficeRollover({ contract, revenue }) {
  const rr = contract.rent_roll ?? {};
  const leases = Array.isArray(rr.leases) ? rr.leases : null;
  const rba = val(contract.physical.rentable_building_area) ?? num(rr.total_rentable_area);
  const marketRentPsf = num(rr.market_rent_psf) ?? num(revenue?.market_rent_psf);
  const vacantRsf = num(rr.vacant_area);
  const isMedical = contract.is_medical === true;

  if (!leases && vacantRsf === null) {
    return { available: false, reason: 'no_lease_or_vacancy_data', rollover_risk_score: null, required_leasing_capital: null, near_term_material: false, medical_buildout_exposure: null };
  }

  const events = [];
  let medicalBuildoutExposure = 0;
  for (const l of leases ?? []) {
    if (l.is_coworking_license) continue; // license, not a durable rollover event
    if (l.remaining_term_years === null) continue;
    const medicalLease = isMedical || Boolean(l.medical);
    const credit = medicalLease ? ROLL.renewal_probability_medical
      : l.is_large_block ? ROLL.renewal_probability_credit : ROLL.renewal_probability_local;
    const downtime = l.rollover_downtime_months ?? (medicalLease ? ROLL.downtime_months_medical : l.is_large_block ? ROLL.downtime_months_large_block : ROLL.downtime_months_office);
    if (medicalLease && l.ti_exposure !== null) medicalBuildoutExposure += l.ti_exposure;
    events.push({
      tenant: l.tenant_name,
      rsf: l.rentable_square_feet,
      expires_in_years: l.remaining_term_years,
      renewal_probability: credit,
      downtime_months: downtime,
      market_rent_psf: marketRentPsf,
      free_rent_months: l.free_rent_months ?? ROLL.free_rent_months,
      ti: l.ti_exposure,
      lc: l.lc_exposure,
      legal_design: ROLL.legal_design_per_suite,
      rollover_cost: l.rollover_cost,
      medical: medicalLease,
    });
  }
  // Vacant space is an immediate lease-up event.
  if (vacantRsf && vacantRsf > 0) {
    const tiPerRsf = isMedical ? ROLL.ti_per_rsf_new_medical : ROLL.ti_per_rsf_new_office;
    const ti = roundMoney(tiPerRsf * vacantRsf);
    const downtime = isMedical ? ROLL.downtime_months_medical : ROLL.downtime_months_office;
    const downtimeRent = marketRentPsf !== null ? roundMoney((marketRentPsf * vacantRsf / 12) * downtime) : null;
    if (isMedical) medicalBuildoutExposure += ti;
    events.push({
      tenant: null, rsf: vacantRsf, expires_in_years: 0, renewal_probability: 0,
      downtime_months: downtime, market_rent_psf: marketRentPsf, free_rent_months: ROLL.free_rent_months,
      ti, lc: null, legal_design: ROLL.legal_design_per_suite,
      rollover_cost: sumNonNull([ti, downtimeRent, ROLL.legal_design_per_suite]),
      is_vacant_leaseup: true, medical: isMedical,
    });
  }

  const exposure = (maxYears) => roundMoney(events.filter((e) => e.expires_in_years <= maxYears).reduce((s, e) => s + (e.rsf ?? 0), 0));
  const capital = (maxYears) => roundMoney(events.filter((e) => e.expires_in_years <= maxYears).reduce((s, e) => s + (e.rollover_cost ?? 0) * (1 - e.renewal_probability), 0));
  const requiredCapital = roundMoney(events.reduce((s, e) => s + (e.rollover_cost ?? 0) * (1 - e.renewal_probability), 0));

  const weightedDowntime = (() => {
    let wsum = 0;
    let w = 0;
    for (const e of events) { if (e.rsf) { wsum += e.downtime_months * e.rsf; w += e.rsf; } }
    return w > 0 ? round(wsum / w, 1) : null;
  })();

  const rollover12mRsf = exposure(1);
  const nearTermMaterial = rba && rollover12mRsf !== null ? rollover12mRsf / rba >= 0.2 : false;

  const nearShare = rba && rollover12mRsf !== null ? rollover12mRsf / rba : 0;
  const avgRenewal = events.length ? events.reduce((s, e) => s + e.renewal_probability, 0) / events.length : 0.6;
  const rolloverRiskScore = Math.round(clamp(nearShare * 60 + (1 - avgRenewal) * 40, 0, 100));

  return {
    available: true,
    events,
    rollover_12m_rsf: rollover12mRsf,
    rollover_24m_rsf: exposure(2),
    rollover_36m_rsf: exposure(3),
    rollover_60m_rsf: exposure(5),
    leasing_capital_12m: capital(1),
    leasing_capital_24m: capital(2),
    leasing_capital_36m: capital(3),
    required_leasing_capital: requiredCapital,
    weighted_downtime_months: weightedDowntime,
    stabilization_timeline_months: weightedDowntime !== null ? Math.round(weightedDowntime + ROLL.free_rent_months) : null,
    rollover_risk_score: rolloverRiskScore,
    near_term_material: nearTermMaterial,
    medical_buildout_exposure: isMedical || medicalBuildoutExposure > 0 ? roundMoney(medicalBuildoutExposure) : null,
    note: nearTermMaterial ? 'Material near-term rollover — current NOI is NOT stabilized NOI.' : null,
  };
}

function sumNonNull(arr) {
  const present = arr.filter((v) => v !== null && v !== undefined);
  return present.length ? roundMoney(present.reduce((s, v) => s + v, 0)) : null;
}

/* -------------------------------------------------------------------------- */
/* Cap-rate model (§13)                                                        */
/* -------------------------------------------------------------------------- */

export const OFFICE_CAP_KIND = Object.freeze({
  OBSERVED: 'OBSERVED',
  IMPLIED: 'IMPLIED',
  MODELED_MARKET: 'MODELED_MARKET',
});

/**
 * Qualify an OBSERVED office cap rate. Requires a qualified sale price, a time-
 * aligned OBSERVED NOI, exact office subtype compatibility and complete lineage.
 * A modeled NOI can NEVER create an observed cap rate.
 */
export function qualifyObservedOfficeCap(evidence = {}) {
  const price = num(evidence.sale_price);
  const noi = num(evidence.observed_noi);
  const reasons = [];
  if (price === null || price <= 0) reasons.push('no_qualified_sale_price');
  if (noi === null) reasons.push('no_time_aligned_observed_noi');
  if (evidence.noi_basis && evidence.noi_basis !== EVIDENCE_BASIS.ACTUAL && evidence.noi_basis !== EVIDENCE_BASIS.VERIFIED_DOCUMENT) {
    reasons.push('noi_not_observed');
  }
  if (evidence.exact_office_subtype !== true) reasons.push('not_exact_office_subtype');
  if (evidence.sale_date == null || evidence.noi_period == null) reasons.push('incomplete_time_lineage');
  if (reasons.length) return { kind: null, qualified: false, cap_rate: null, reasons };
  const cap = capRateFromValue(noi, price);
  if (cap === null || cap < OFFICE_CAP_RATE_BOUNDS.min || cap > OFFICE_CAP_RATE_BOUNDS.max) {
    return { kind: null, qualified: false, cap_rate: cap, reasons: ['cap_out_of_plausible_range'] };
  }
  return {
    kind: OFFICE_CAP_KIND.OBSERVED, qualified: true, cap_rate: round(cap, 4),
    sale_price: roundMoney(price), observed_noi: roundMoney(noi),
    sale_date: evidence.sale_date, noi_period: evidence.noi_period, reasons: [],
  };
}

/**
 * Resolve an office cap rate keeping OBSERVED / IMPLIED / MODELED_MARKET separate.
 * Modeled market caps adjust for tenant credit, WALE, lease structure, occupancy,
 * rollover, concentration, market, age, WFH/sublease risk and buyer depth. Never
 * derives a market cap from package consideration or modeled NOI.
 */
export function buildOfficeCapRate({
  subtype = 'UNKNOWN', creditClass = 'UNKNOWN', observedEvidence = [], impliedNoi = null, impliedValue = null,
  occupancy = null, waleYears = null, dominantLeaseType = LT.UNKNOWN, tenantConcentration = null,
  rolloverRiskScore = null, marketTier = 'SECONDARY', yearBuilt = null, buyerDepth = 'MODERATE',
  wfhRisk = false, subleaseOverhang = false,
} = {}) {
  const observed = (observedEvidence ?? [])
    .map((e) => qualifyObservedOfficeCap(e))
    .filter((r) => r.qualified);

  const implied = impliedNoi !== null && impliedValue !== null
    ? { kind: OFFICE_CAP_KIND.IMPLIED, cap_rate: capRateFromValue(impliedNoi, impliedValue), qualified: false, note: 'implied_from_subject_noi_and_value_estimate' }
    : null;

  // ---- Modeled market cap (labeled) ----
  let modeled = OFFICE_DEFAULT_CAP_RATE[subtype] ?? OFFICE_DEFAULT_CAP_RATE.UNKNOWN;
  const adjustments = [];
  const creditBps = CREDIT_CAP_ADJUSTMENT_BPS[creditClass] ?? CREDIT_CAP_ADJUSTMENT_BPS.UNKNOWN;
  if (creditBps !== 0) { modeled += creditBps / 10000; adjustments.push(`credit_${creditClass}${creditBps >= 0 ? '+' : ''}${creditBps}bps`); }
  if (waleYears !== null) {
    if (waleYears >= 8) { modeled -= 0.005; adjustments.push('long_wale-50bps'); }
    else if (waleYears <= 2) { modeled += 0.0075; adjustments.push('short_wale+75bps'); }
  }
  if (dominantLeaseType === LT.ABSOLUTE_NET || dominantLeaseType === LT.TRIPLE_NET) { modeled -= 0.0025; adjustments.push('net_lease-25bps'); }
  if (dominantLeaseType === LT.FULL_SERVICE_GROSS) { modeled += 0.0025; adjustments.push('full_service_gross+25bps'); }
  if (occupancy !== null && occupancy < 0.85) { modeled += 0.0075; adjustments.push('low_occupancy+75bps'); }
  if (tenantConcentration !== null && tenantConcentration >= 0.5) { modeled += 0.005; adjustments.push('high_concentration+50bps'); }
  if (rolloverRiskScore !== null && rolloverRiskScore >= 50) { modeled += 0.005; adjustments.push('high_rollover_risk+50bps'); }
  if (marketTier === 'PRIMARY') { modeled -= 0.005; adjustments.push('primary_market-50bps'); }
  if (marketTier === 'TERTIARY') { modeled += 0.01; adjustments.push('tertiary_market+100bps'); }
  if (yearBuilt !== null && (2026 - yearBuilt) > 30) { modeled += 0.0075; adjustments.push('older_vintage+75bps'); }
  if (wfhRisk) { modeled += 0.0075; adjustments.push('wfh_demand_risk+75bps'); }
  if (subleaseOverhang) { modeled += 0.005; adjustments.push('sublease_overhang+50bps'); }
  if (buyerDepth === 'DEEP') { modeled -= 0.0025; adjustments.push('deep_buyer_pool-25bps'); }
  if (buyerDepth === 'THIN') { modeled += 0.0075; adjustments.push('thin_buyer_pool+75bps'); }
  modeled = round(clamp(modeled, OFFICE_CAP_RATE_BOUNDS.min, OFFICE_CAP_RATE_BOUNDS.max), 4);

  let selected;
  if (observed.length >= 3) {
    const rates = observed.map((o) => o.cap_rate).sort((x, y) => x - y);
    selected = { kind: OFFICE_CAP_KIND.OBSERVED, cap_rate: round(rates[Math.floor((rates.length - 1) / 2)], 4), qualified: true, evidence_count: observed.length };
  } else {
    selected = { kind: OFFICE_CAP_KIND.MODELED_MARKET, cap_rate: modeled, qualified: false, evidence_count: observed.length };
  }

  return {
    observed, implied,
    modeled_market: { kind: OFFICE_CAP_KIND.MODELED_MARKET, cap_rate: modeled, adjustments, subtype, credit_class: creditClass },
    selected,
  };
}

/* -------------------------------------------------------------------------- */
/* Distress / obsolescence model (§11)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Model sustained vacancy, sublease overhang, functional obsolescence, WFH demand
 * risk, tenant downsizing, conversion feasibility and demolition/land value. Never
 * capitalizes historical occupied NOI as stabilized value when market vacancy and
 * rollover evidence contradict it (mission §11).
 */
export function buildOfficeDistress({ contract, revenue, rollover, marketContext = {} }) {
  const rba = val(contract.physical.rentable_building_area);
  const occupancy = num(revenue?.physical_occupancy);
  const econOcc = num(revenue?.economic_occupancy);
  const subleaseVacancy = num(contract.operations?.sublease_vacancy?.value) ?? num(contract.rent_roll?.sublease_vacancy_rsf);
  const yearBuilt = num(contract.identity.year_built?.value);
  const age = yearBuilt !== null ? 2026 - yearBuilt : null;
  const subtype = contract.subtype;
  const buildingClass = contract.building_class;

  const flags = [];
  let obsolescenceRisk = 'LOW';
  let totalDiscount = 0;

  // WFH demand risk: commodity Class B/C office in soft markets carries WFH risk.
  const wfhRisk = (buildingClass === 'CLASS_B' || buildingClass === 'CLASS_C') &&
    (marketContext.growth_support === 'SOFT' || occupancy !== null && occupancy < 0.85);
  if (wfhRisk) { flags.push('work_from_home_demand_risk'); totalDiscount += OBS.wfh_demand_risk_discount; }

  if (subleaseVacancy !== null && subleaseVacancy > 0) {
    flags.push('sublease_overhang');
    if (rba) totalDiscount += Math.min(0.06, (subleaseVacancy / rba) * 0.3);
  }
  if (occupancy !== null && econOcc !== null && occupancy - econOcc >= 0.1) flags.push('economic_occupancy_gap');
  if (age !== null && age > 35) { flags.push('aging_systems_obsolescence'); totalDiscount += OBS.outdated_systems_discount; }
  if (val(contract.physical.floor_plate_sqft) !== null && num(contract.physical.floor_plate_sqft.value) < 8000) {
    flags.push('inefficient_small_floor_plate'); totalDiscount += OBS.inefficient_floorplate_discount;
  }
  const parkingRatio = num(contract.physical.parking_ratio?.value);
  if (parkingRatio !== null && parkingRatio < 2.5) { flags.push('weak_parking'); totalDiscount += OBS.weak_parking_discount; }
  if (rollover?.near_term_material) flags.push('material_near_term_rollover');

  if (totalDiscount >= 0.15) obsolescenceRisk = 'HIGH';
  else if (totalDiscount >= 0.07) obsolescenceRisk = 'ELEVATED';
  else if (flags.length) obsolescenceRisk = 'MODERATE';

  // Conversion feasibility (office → residential/other): older small-floor-plate
  // Class B/C is more convertible; large modern Class A less so.
  const conversionFeasible = (buildingClass === 'CLASS_B' || buildingClass === 'CLASS_C') &&
    val(contract.physical.floor_plate_sqft) !== null && num(contract.physical.floor_plate_sqft.value) <= 15000;

  // Dark / conversion value floor (vs stabilized) and land/redevelopment value.
  const land = num(contract.physical.land_area?.value);
  const landValue = land !== null ? roundMoney(land * OBS.land_per_sqft_fallback) : null;
  const demolition = rba !== null ? roundMoney(rba * OBS.demolition_per_rsf) : null;
  const redevelopmentValue = landValue !== null ? roundMoney(Math.max(0, landValue - (demolition ?? 0))) : null;

  return {
    obsolescence_risk: obsolescenceRisk,
    marketability_risk: obsolescenceRisk === 'HIGH' ? 'HIGH' : (flags.includes('work_from_home_demand_risk') ? 'ELEVATED' : 'MODERATE'),
    distress_flags: flags,
    wfh_demand_risk: wfhRisk,
    sublease_overhang_rsf: subleaseVacancy,
    total_obsolescence_discount_pct: round(clamp(totalDiscount, 0, 0.4), 3),
    conversion_feasible: conversionFeasible,
    alternative_use_potential: conversionFeasible ? 'RESIDENTIAL_OR_MIXED_USE_CONVERSION' : 'LIMITED',
    required_capital_for_repositioning: rollover?.required_leasing_capital ?? null,
    redevelopment_value: redevelopmentValue,
    land_value: landValue,
    demolition_cost: demolition,
    confidence: occupancy !== null ? 45 : 20,
    // Explicit invariant: occupied historical NOI is not capitalized against
    // contradicting vacancy / rollover evidence.
    historical_noi_not_capitalized_against_vacancy: true,
  };
}

export { valueFromCap };
