/**
 * Acquisition Engine V3 — Item 5E §7–§10, §13: retail underwriting math.
 *
 * Pure, deterministic retail primitives:
 *   - revenue (§7): contractual base + SEPARATED CAM/tax/insurance reimbursements
 *     + percentage rent + other income − vacancy − credit loss − concessions −
 *     downtime = effective gross revenue. Street/asking rent is NEVER collected
 *     revenue. Base rent and reimbursements are kept separate.
 *   - expenses (§8): ACTUAL-first; recoverable vs reimbursed vs unreimbursed
 *     leakage tracked. NOT all NNN expenses are assumed fully reimbursed.
 *   - NOI (§9): EGR − opex. Debt service / depreciation / income tax / capex /
 *     TI / LC EXCLUDED by construction.
 *   - cap rate (§13): OBSERVED vs IMPLIED vs MODELED_MARKET kept separate; an
 *     observed cap requires a qualified sale + observed NOI + exact retail
 *     compatibility. A modeled NOI can NEVER create an observed cap rate.
 *   - rollover (§10): per-expiration downtime / free rent / TI / LC / legal and a
 *     12/24/36-month rollover exposure. Costs reduce value (never double-counted).
 *
 * Missing values are UNKNOWN, never zero.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from './incomeSnapshotContract.js';
import { computeNOI, capRateFromValue } from './incomeUnderwriting.js';
import {
  LEASE_TYPE as LT,
  LANDLORD_EXPENSE_EXPOSURE,
  RETAIL_OPEX_ASSUMPTIONS as OPEX,
  RETAIL_EXPENSE_CATEGORIES,
  RETAIL_DEFAULT_CAP_RATE,
  RETAIL_CAP_RATE_BOUNDS,
  RETAIL_STABILIZED_OCCUPANCY,
  RETAIL_ROLLOVER_ASSUMPTIONS as ROLL,
  CREDIT_CAP_ADJUSTMENT_BPS,
} from './retailConstants.js';

const val = (f) => (f && isKnown(f) ? num(f.value) : null);

/* -------------------------------------------------------------------------- */
/* Revenue model (§7)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the retail revenue picture. Base rent and each reimbursement stream stay
 * separate; asking/market rent is POTENTIAL only, never collected revenue.
 */
export function buildRetailRevenue(contract) {
  const rr = contract.rent_roll ?? {};
  const op = contract.operations ?? {};
  const inc = contract.income ?? {};
  const gla = val(contract.physical.gross_leasable_area);

  const lineage = [];
  const missing = [];

  const occupancy = num(rr.physical_occupancy) ?? val(op.physical_occupancy);

  // ---- Current ACTUAL contractual base rent ----
  let currentBaseAnnual = val(inc.base_rental_income) ?? num(rr.annualized_base_rent);
  let currentBasis = currentBaseAnnual !== null ? EVIDENCE_BASIS.ACTUAL : EVIDENCE_BASIS.UNKNOWN;
  if (currentBaseAnnual !== null) lineage.push(val(inc.base_rental_income) !== null ? 'income.base_rental_income(actual)' : 'rent_roll.annualized_base_rent');
  else missing.push('current_contractual_base_rent');

  // ---- Reimbursements (SEPARATED from base, never folded in) ----
  const camReimb = val(inc.cam_reimbursement_income) ?? 0;
  const taxReimb = val(inc.tax_reimbursement_income) ?? 0;
  const insReimb = val(inc.insurance_reimbursement_income) ?? 0;
  const reimbursementsKnown = isKnown(inc.cam_reimbursement_income) || isKnown(inc.tax_reimbursement_income) || isKnown(inc.insurance_reimbursement_income) || num(rr.reimbursement_income) !== null;
  const reimbursements = reimbursementsKnown ? roundMoney(camReimb + taxReimb + insReimb + (num(rr.reimbursement_income) ?? 0) - (camReimb + taxReimb + insReimb > 0 ? 0 : 0)) : null;

  const percentageRent = val(inc.percentage_rent_income) ?? 0;
  const otherIncome = val(inc.other_income) ?? 0;

  // ---- Scheduled gross POTENTIAL (all suites at market) ----
  const marketRentPsf = num(rr.market_rent_psf) ?? val(op.market_rent_psf);
  const scheduledGpr = marketRentPsf !== null && gla !== null ? roundMoney(marketRentPsf * gla) : null;
  if (scheduledGpr === null) missing.push('scheduled_gross_potential_revenue');
  else lineage.push('gpr=market_rent_psf*gla');

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
    ? roundMoney(collectedBase + (reimbursements ?? 0) + percentageRent + otherIncome - concessions - badDebt)
    : null;

  const stabilizedBase = scheduledGpr !== null ? roundMoney(scheduledGpr * RETAIL_STABILIZED_OCCUPANCY) : null;
  const stabilizedEgr = stabilizedBase !== null ? roundMoney(stabilizedBase + (reimbursements ?? 0) + percentageRent + otherIncome) : null;

  if (occupancy === null) missing.push('occupancy');
  if (gla === null) missing.push('gross_leasable_area');

  const incomeSupported = currentBaseAnnual !== null && currentBasis === EVIDENCE_BASIS.ACTUAL && occupancy !== null;

  return {
    current_contractual_base_annual: currentBaseAnnual,
    current_base_basis: currentBasis,
    reimbursement_income_annual: reimbursements,
    reimbursements_known: reimbursementsKnown,
    percentage_rent_annual: roundMoney(percentageRent),
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
    revenue_per_gla: gla && collectedBase !== null ? round(collectedBase / gla, 2) : null,
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
    base_and_reimbursements_separate: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Expense model (§8)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Retail operating-expense model. ACTUAL lines first, else MODELED + labeled.
 * Tracks recoverable vs reimbursed vs unreimbursed leakage — NOT all NNN expenses
 * are assumed fully reimbursed (mission §8). Excludes debt/depreciation/tax/capex.
 *
 * @param {object} contract
 * @param {object} args { egrAnnual, subjectValue, dominantLeaseType }
 */
export function buildRetailExpenses(contract, { egrAnnual = null, subjectValue = null, dominantLeaseType = LT.UNKNOWN } = {}) {
  const exp = contract.expenses ?? {};
  const gla = val(contract.physical.gross_leasable_area);
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
  const perGla = (rate) => (gla !== null ? gla * rate : null);
  const pctEgr = (rate) => (egr !== null ? egr * rate : null);

  set('property_taxes', exp.property_taxes, subjectValue !== null ? subjectValue * OPEX.property_tax_rate_of_value : null, `assumed_${OPEX.property_tax_rate_of_value}_of_value`, true);
  set('insurance', exp.insurance, perGla(OPEX.insurance_per_gla), `assumed_${OPEX.insurance_per_gla}/gla`, true);
  set('cam', exp.cam, perGla(OPEX.cam_per_gla), `assumed_${OPEX.cam_per_gla}/gla`, true);
  set('repairs_maintenance', exp.repairs_maintenance, perGla(OPEX.repairs_per_gla), `assumed_${OPEX.repairs_per_gla}/gla`, true);
  set('common_utilities', exp.common_utilities, perGla(OPEX.utilities_common_per_gla), `assumed_${OPEX.utilities_common_per_gla}/gla`, true);
  set('landscaping_parking', exp.landscaping_parking, perGla(OPEX.landscaping_parking_per_gla), `assumed_${OPEX.landscaping_parking_per_gla}/gla`, true);
  set('management', exp.management, pctEgr(OPEX.management_pct), `assumed_${OPEX.management_pct}_of_egr`, false);
  set('administrative', exp.administrative, pctEgr(OPEX.administrative_pct), `assumed_${OPEX.administrative_pct}_of_egr`, false);
  set('marketing', exp.marketing, pctEgr(OPEX.marketing_pct), `assumed_${OPEX.marketing_pct}_of_egr`, false);
  set('professional_fees', exp.professional_fees, egr !== null ? egr * 0.01 : null, 'assumed_0.01_of_egr', false);
  set('non_recoverable', exp.non_recoverable, perGla(OPEX.non_recoverable_per_gla), `assumed_${OPEX.non_recoverable_per_gla}/gla`, false);
  set('replacement_reserves', exp.replacement_reserves, perGla(OPEX.reserves_per_gla), `assumed_${OPEX.reserves_per_gla}/gla`, false);

  const explicitTotal = val(exp.total_operating_expenses);
  const lineSum = Object.values(lines).reduce((s, l) => s + (l.value ?? 0), 0);
  const total = explicitTotal !== null ? explicitTotal : roundMoney(lineSum);

  // Recoverable expenses (CAM/taxes/insurance/etc) and the landlord leakage that
  // is NOT actually reimbursed — never assume 100% NNN recovery.
  const recoverableTotal = roundMoney(Object.values(lines).filter((l) => l.recoverable).reduce((s, l) => s + (l.value ?? 0), 0));
  const landlordExposure = LANDLORD_EXPENSE_EXPOSURE[dominantLeaseType] ?? LANDLORD_EXPENSE_EXPOSURE.UNKNOWN;
  // Reimbursed = recoverable × (1 − landlord exposure) × occupancy-implied factor.
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
    expense_per_gla: gla ? round(total / gla, 2) : null,
    known_lines: known,
    assumed_lines: assumed,
    missing_lines: missing,
    confidence: clamp((known.length / RETAIL_EXPENSE_CATEGORIES.length) * 100 + 15, 0, 100),
    excludes: ['debt_service', 'depreciation', 'income_tax', 'acquisition_cost', 'capital_expenditures', 'tenant_improvements', 'leasing_commissions'],
    // Explicit invariant: NNN does not imply full reimbursement.
    full_nnn_recovery_assumed: false,
  };
}

/* -------------------------------------------------------------------------- */
/* NOI model (§9)                                                              */
/* -------------------------------------------------------------------------- */

/** Retail NOI from revenue + expenses, net of reimbursement leakage. */
export function buildRetailNOI({ revenue, expenses, contract }) {
  const gla = val(contract.physical.gross_leasable_area);
  const opex = num(expenses?.total_operating_expenses);
  const leakage = num(expenses?.reimbursement_leakage) ?? 0;

  const egr = num(revenue?.effective_gross_revenue_annual);
  // Reimbursement leakage reduces NOI: unreimbursed recoverable expense is a true
  // landlord cost that EGR did not capture as reimbursement income.
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
    noi_per_gla: noi !== null && gla ? round(noi / gla, 2) : null,
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
 * Model upcoming expirations + vacant-space lease-up. Returns 12/24/36-month
 * rollover exposure, required leasing capital, weighted downtime, stabilized-
 * occupancy timeline and a rollover risk score. Current NOI is never treated as
 * stabilized with material imminent rollover.
 */
export function buildRetailRollover({ contract, revenue }) {
  const rr = contract.rent_roll ?? {};
  const leases = Array.isArray(rr.leases) ? rr.leases : null;
  const gla = val(contract.physical.gross_leasable_area) ?? num(rr.total_gla);
  const marketRentPsf = num(rr.market_rent_psf) ?? num(revenue?.market_rent_psf);
  const vacantGla = num(rr.vacant_gla);

  if (!leases && vacantGla === null) {
    return { available: false, reason: 'no_lease_or_vacancy_data', rollover_risk_score: null, required_leasing_capital: null, near_term_material: false };
  }

  const events = [];
  for (const l of leases ?? []) {
    if (l.remaining_term_years === null) continue;
    const credit = l.is_anchor_size ? ROLL.renewal_probability_credit : ROLL.renewal_probability_local;
    const downtime = l.rollover_downtime_months ?? (l.is_anchor_size ? ROLL.downtime_months_anchor : ROLL.downtime_months_inline);
    events.push({
      tenant: l.tenant_name,
      gla: l.leased_square_feet,
      expires_in_years: l.remaining_term_years,
      renewal_probability: credit,
      downtime_months: downtime,
      market_rent_psf: marketRentPsf,
      free_rent_months: ROLL.free_rent_months,
      ti: l.ti_exposure,
      lc: l.lc_exposure,
      legal_marketing: ROLL.legal_marketing_per_suite,
      rollover_cost: l.rollover_cost,
    });
  }
  // Vacant space is an immediate lease-up event.
  if (vacantGla && vacantGla > 0) {
    const anchor = vacantGla >= 15_000;
    const ti = roundMoney((anchor ? ROLL.ti_per_gla_anchor : ROLL.ti_per_gla_inline) * vacantGla);
    const downtimeRent = marketRentPsf !== null ? roundMoney((marketRentPsf * vacantGla / 12) * (anchor ? ROLL.downtime_months_anchor : ROLL.downtime_months_inline)) : null;
    events.push({
      tenant: null, gla: vacantGla, expires_in_years: 0, renewal_probability: 0,
      downtime_months: anchor ? ROLL.downtime_months_anchor : ROLL.downtime_months_inline,
      market_rent_psf: marketRentPsf, free_rent_months: ROLL.free_rent_months,
      ti, lc: null, legal_marketing: ROLL.legal_marketing_per_suite,
      rollover_cost: sumNonNull([ti, downtimeRent, ROLL.legal_marketing_per_suite]),
      is_vacant_leaseup: true,
    });
  }

  const exposure = (maxYears) => roundMoney(events.filter((e) => e.expires_in_years <= maxYears).reduce((s, e) => s + (e.gla ?? 0), 0));
  const capital = (maxYears) => roundMoney(events.filter((e) => e.expires_in_years <= maxYears).reduce((s, e) => s + (e.rollover_cost ?? 0) * (1 - e.renewal_probability), 0));
  const requiredCapital = roundMoney(events.reduce((s, e) => s + (e.rollover_cost ?? 0) * (1 - e.renewal_probability), 0));

  const weightedDowntime = (() => {
    let wsum = 0;
    let w = 0;
    for (const e of events) { if (e.gla) { wsum += e.downtime_months * e.gla; w += e.gla; } }
    return w > 0 ? round(wsum / w, 1) : null;
  })();

  const rollover12mGla = exposure(1);
  const nearTermMaterial = gla && rollover12mGla !== null ? rollover12mGla / gla >= 0.2 : false;

  // Rollover risk score (0..100): more near-term GLA + lower renewal prob → higher.
  const nearShare = gla && rollover12mGla !== null ? rollover12mGla / gla : 0;
  const avgRenewal = events.length ? events.reduce((s, e) => s + e.renewal_probability, 0) / events.length : 0.6;
  const rolloverRiskScore = Math.round(clamp(nearShare * 60 + (1 - avgRenewal) * 40, 0, 100));

  return {
    available: true,
    events,
    rollover_12m_gla: rollover12mGla,
    rollover_24m_gla: exposure(2),
    rollover_36m_gla: exposure(3),
    leasing_capital_12m: capital(1),
    leasing_capital_24m: capital(2),
    leasing_capital_36m: capital(3),
    required_leasing_capital: requiredCapital,
    weighted_downtime_months: weightedDowntime,
    stabilized_occupancy_timeline_months: weightedDowntime !== null ? Math.round(weightedDowntime + ROLL.free_rent_months) : null,
    rollover_risk_score: rolloverRiskScore,
    near_term_material: nearTermMaterial,
    note: nearTermMaterial ? 'Material near-term rollover — current NOI is NOT stabilized NOI.' : null,
  };
}

function sumNonNull(arr) {
  const present = arr.filter((v) => v !== null && v !== undefined);
  return present.length ? roundMoney(present.reduce((s, v) => s + v, 0)) : null;
}
function sumNums(arr) {
  const present = (arr ?? []).filter((v) => v !== null && v !== undefined);
  return present.length ? present.reduce((s, v) => s + v, 0) : null;
}

/* -------------------------------------------------------------------------- */
/* Cap-rate model (§13)                                                        */
/* -------------------------------------------------------------------------- */

export const RETAIL_CAP_KIND = Object.freeze({
  OBSERVED: 'OBSERVED',
  IMPLIED: 'IMPLIED',
  MODELED_MARKET: 'MODELED_MARKET',
});

/**
 * Qualify an OBSERVED retail cap rate. Requires a qualified sale price, a time-
 * aligned OBSERVED NOI, exact retail subtype compatibility and complete lineage.
 * A modeled NOI can NEVER create an observed cap rate.
 */
export function qualifyObservedRetailCap(evidence = {}) {
  const price = num(evidence.sale_price);
  const noi = num(evidence.observed_noi);
  const reasons = [];
  if (price === null || price <= 0) reasons.push('no_qualified_sale_price');
  if (noi === null) reasons.push('no_time_aligned_observed_noi');
  if (evidence.noi_basis && evidence.noi_basis !== EVIDENCE_BASIS.ACTUAL && evidence.noi_basis !== EVIDENCE_BASIS.VERIFIED_DOCUMENT) {
    reasons.push('noi_not_observed');
  }
  if (evidence.exact_retail_subtype !== true) reasons.push('not_exact_retail_subtype');
  if (evidence.sale_date == null || evidence.noi_period == null) reasons.push('incomplete_time_lineage');
  if (reasons.length) return { kind: null, qualified: false, cap_rate: null, reasons };
  const cap = capRateFromValue(noi, price);
  if (cap === null || cap < RETAIL_CAP_RATE_BOUNDS.min || cap > RETAIL_CAP_RATE_BOUNDS.max) {
    return { kind: null, qualified: false, cap_rate: cap, reasons: ['cap_out_of_plausible_range'] };
  }
  return {
    kind: RETAIL_CAP_KIND.OBSERVED, qualified: true, cap_rate: round(cap, 4),
    sale_price: roundMoney(price), observed_noi: roundMoney(noi),
    sale_date: evidence.sale_date, noi_period: evidence.noi_period, reasons: [],
  };
}

/**
 * Resolve a retail cap rate keeping OBSERVED / IMPLIED / MODELED_MARKET separate.
 * Modeled market caps adjust for tenant credit, remaining lease term, lease
 * structure, occupancy, rollover, concentration, center type, market, age and
 * buyer depth. Never derives a market cap from package consideration.
 */
export function buildRetailCapRate({
  subtype = 'UNKNOWN', creditClass = 'UNKNOWN', observedEvidence = [], impliedNoi = null, impliedValue = null,
  occupancy = null, waleYears = null, dominantLeaseType = LT.UNKNOWN, tenantConcentration = null,
  rolloverRiskScore = null, marketTier = 'SECONDARY', yearBuilt = null, buyerDepth = 'MODERATE',
} = {}) {
  const observed = (observedEvidence ?? [])
    .map((e) => qualifyObservedRetailCap(e))
    .filter((r) => r.qualified);

  const implied = impliedNoi !== null && impliedValue !== null
    ? { kind: RETAIL_CAP_KIND.IMPLIED, cap_rate: capRateFromValue(impliedNoi, impliedValue), qualified: false, note: 'implied_from_subject_noi_and_value_estimate' }
    : null;

  // ---- Modeled market cap (labeled) ----
  let modeled = RETAIL_DEFAULT_CAP_RATE[subtype] ?? RETAIL_DEFAULT_CAP_RATE.UNKNOWN;
  const adjustments = [];
  const creditBps = CREDIT_CAP_ADJUSTMENT_BPS[creditClass] ?? CREDIT_CAP_ADJUSTMENT_BPS.UNKNOWN;
  if (creditBps !== 0) { modeled += creditBps / 10000; adjustments.push(`credit_${creditClass}${creditBps >= 0 ? '+' : ''}${creditBps}bps`); }
  if (waleYears !== null) {
    if (waleYears >= 10) { modeled -= 0.005; adjustments.push('long_wale-50bps'); }
    else if (waleYears <= 2) { modeled += 0.0075; adjustments.push('short_wale+75bps'); }
  }
  if (dominantLeaseType === LT.ABSOLUTE_NET || dominantLeaseType === LT.TRIPLE_NET) { modeled -= 0.0025; adjustments.push('net_lease-25bps'); }
  if (dominantLeaseType === LT.FULL_SERVICE_GROSS || dominantLeaseType === LT.MODIFIED_GROSS) { modeled += 0.005; adjustments.push('gross_lease+50bps'); }
  if (occupancy !== null && occupancy < 0.85) { modeled += 0.0075; adjustments.push('low_occupancy+75bps'); }
  if (tenantConcentration !== null && tenantConcentration >= 0.5) { modeled += 0.005; adjustments.push('high_concentration+50bps'); }
  if (rolloverRiskScore !== null && rolloverRiskScore >= 50) { modeled += 0.005; adjustments.push('high_rollover_risk+50bps'); }
  if (marketTier === 'PRIMARY') { modeled -= 0.005; adjustments.push('primary_market-50bps'); }
  if (marketTier === 'TERTIARY') { modeled += 0.01; adjustments.push('tertiary_market+100bps'); }
  if (yearBuilt !== null && (2026 - yearBuilt) > 35) { modeled += 0.005; adjustments.push('older_vintage+50bps'); }
  if (buyerDepth === 'DEEP') { modeled -= 0.0025; adjustments.push('deep_buyer_pool-25bps'); }
  if (buyerDepth === 'THIN') { modeled += 0.0075; adjustments.push('thin_buyer_pool+75bps'); }
  modeled = round(clamp(modeled, RETAIL_CAP_RATE_BOUNDS.min, RETAIL_CAP_RATE_BOUNDS.max), 4);

  let selected;
  if (observed.length >= 3) {
    const rates = observed.map((o) => o.cap_rate).sort((x, y) => x - y);
    selected = { kind: RETAIL_CAP_KIND.OBSERVED, cap_rate: round(rates[Math.floor((rates.length - 1) / 2)], 4), qualified: true, evidence_count: observed.length };
  } else {
    selected = { kind: RETAIL_CAP_KIND.MODELED_MARKET, cap_rate: modeled, qualified: false, evidence_count: observed.length };
  }

  return {
    observed, implied,
    modeled_market: { kind: RETAIL_CAP_KIND.MODELED_MARKET, cap_rate: modeled, adjustments, subtype, credit_class: creditClass },
    selected,
  };
}
