/**
 * Acquisition Engine V3 — Item 5B: income underwriting math.
 *
 * Pure, deterministic income-asset primitives shared by the small-multi (2–4)
 * and multifamily (5+) valuation models:
 *   - rent model (verified rent roll → leases → recorded → comps → assumptions)
 *   - expense model (actuals first; otherwise size-aware MODELED + labeled lines)
 *   - cap-rate model (qualified income-comp evidence; else labeled default)
 *   - NOI / EGI bridge (debt service, depreciation, income tax, capex EXCLUDED)
 *   - GRM / EGIM / PPU / PPSF / break-even occupancy / debt yield / DSCR
 *
 * Every modeled figure is labeled; unsupported income stays provisional.
 */

import {
  ASSET_FAMILIES,
  ASSET_LANES,
  DEFAULT_CAP_RATE,
  num,
  round,
  roundMoney,
  clamp,
} from './modelConstants.js';
import { FIELD_BASIS } from './residentialIncomeContract.js';

/** Operating-expense categories that may be modeled when actuals are absent. */
export const EXPENSE_CATEGORIES = Object.freeze([
  'taxes', 'insurance', 'management', 'maintenance', 'utilities', 'payroll',
  'administration', 'landscaping_snow', 'service_contracts', 'turnover',
  'bad_debt', 'replacement_reserves',
]);

/** Size band for 5+ multifamily (and a small-multi sentinel). */
export function sizeBand(lane, units) {
  if (lane === ASSET_LANES.MULTIFAMILY_5_20) return 'MF_5_20';
  if (lane === ASSET_LANES.MULTIFAMILY_21_99) return 'MF_21_99';
  if (lane === ASSET_LANES.MULTIFAMILY_100_PLUS) return 'MF_100_PLUS';
  const u = num(units);
  if (u !== null) {
    if (u >= 100) return 'MF_100_PLUS';
    if (u >= 21) return 'MF_21_99';
    if (u >= 5) return 'MF_5_20';
  }
  return 'SMALL_MULTI';
}

/**
 * Size-aware operating assumptions (LABELED). Deliberately distinct per band so
 * no single universal expense ratio is applied across asset sizes (mission §6).
 * vacancy = vacancy+credit-loss %; management = % of EGI; per-unit lines in USD.
 */
export const OPEX_ASSUMPTIONS = Object.freeze({
  SMALL_MULTI: { vacancy: 0.06, management: 0.08, maintenance_per_unit: 900, insurance_per_unit: 450, utilities_per_unit: 300, payroll_per_unit: 0, admin: 0.02, reserves_per_unit: 250, tax_rate_of_value: 0.018 },
  MF_5_20: { vacancy: 0.07, management: 0.06, maintenance_per_unit: 800, insurance_per_unit: 400, utilities_per_unit: 450, payroll_per_unit: 0, admin: 0.03, reserves_per_unit: 300, tax_rate_of_value: 0.018 },
  MF_21_99: { vacancy: 0.08, management: 0.05, maintenance_per_unit: 750, insurance_per_unit: 380, utilities_per_unit: 500, payroll_per_unit: 600, admin: 0.035, reserves_per_unit: 300, tax_rate_of_value: 0.019 },
  MF_100_PLUS: { vacancy: 0.07, management: 0.035, maintenance_per_unit: 700, insurance_per_unit: 350, utilities_per_unit: 520, payroll_per_unit: 1100, admin: 0.03, reserves_per_unit: 300, tax_rate_of_value: 0.02 },
});

/* -------------------------------------------------------------------------- */
/* Rent model                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the rent picture from the contract with explicit source lineage.
 * Priority: verified rent roll > property/unit leases > recorded property rent >
 * qualified comparable rents > transparent market assumptions.
 */
export function resolveRentModel(contract, { comparableMarketMonthlyRent = null } = {}) {
  const units = num(contract.unit_count?.value);
  const rentableSqft = num(contract.rentable_square_feet?.value);
  const currentField = contract.current_gross_monthly_rent ?? {};
  const currentMonthly = num(currentField.value);
  const occupancy = num(contract.occupancy?.value);
  const missing = [];

  // Market rent: explicit market_rents → comp-derived → fall back to current.
  let marketMonthly = null;
  let marketSource = null;
  let marketBasis = FIELD_BASIS.UNKNOWN;
  const marketRents = contract.market_rents?.value;
  if (Array.isArray(marketRents) && marketRents.length) {
    marketMonthly = marketRents.reduce((s, r) => s + (num(r.market_rent) ?? 0), 0);
    marketSource = 'market_rents';
    marketBasis = FIELD_BASIS.KNOWN;
  } else if (comparableMarketMonthlyRent !== null) {
    marketMonthly = comparableMarketMonthlyRent;
    marketSource = 'qualified_comparable_rents';
    marketBasis = FIELD_BASIS.INFERRED;
  } else if (currentMonthly !== null) {
    marketMonthly = currentMonthly;
    marketSource = 'assumed_equal_to_current';
    marketBasis = FIELD_BASIS.ASSUMED;
    missing.push('market_rents');
  } else {
    missing.push('market_rents');
  }

  // Stabilized rent = market at stabilized occupancy (assumption when occ unknown).
  const stabilizedMonthly = marketMonthly;
  const lossToLease =
    marketMonthly !== null && currentMonthly !== null ? roundMoney(marketMonthly - currentMonthly) : null;

  const sourceLineage = [currentField.source, marketSource].filter(Boolean);
  const confidence = clamp(
    (currentField.confidence ?? 0) * 0.6 + (marketBasis === FIELD_BASIS.KNOWN ? 40 : marketBasis === FIELD_BASIS.INFERRED ? 25 : 10),
    0,
    100,
  );

  if (currentMonthly === null) missing.push('current_gross_rent');
  if (occupancy === null) missing.push('occupancy');

  return {
    current_gross_monthly: currentMonthly,
    current_gross_annual: currentMonthly !== null ? roundMoney(currentMonthly * 12) : null,
    market_gross_monthly: marketMonthly,
    market_gross_annual: marketMonthly !== null ? roundMoney(marketMonthly * 12) : null,
    stabilized_gross_monthly: stabilizedMonthly,
    stabilized_gross_annual: stabilizedMonthly !== null ? roundMoney(stabilizedMonthly * 12) : null,
    rent_per_unit_monthly: units && currentMonthly !== null ? roundMoney(currentMonthly / units) : null,
    rent_per_rentable_sqft_annual:
      rentableSqft && currentMonthly !== null ? round((currentMonthly * 12) / rentableSqft, 2) : null,
    loss_to_lease_monthly: lossToLease,
    occupancy,
    current_basis: currentField.basis ?? FIELD_BASIS.UNKNOWN,
    market_basis: marketBasis,
    source_lineage: sourceLineage,
    confidence: round(confidence, 0),
    missing_inputs: missing,
  };
}

/* -------------------------------------------------------------------------- */
/* Expense model                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the operating-expense picture. ACTUAL lines are used where present;
 * absent lines are MODELED from size-aware assumptions and clearly labeled.
 * Excludes debt service, depreciation, income tax and capex by construction.
 */
export function resolveExpenseModel(contract, { band, egiAnnual, subjectValue = null } = {}) {
  const units = num(contract.unit_count?.value) ?? 1;
  const a = OPEX_ASSUMPTIONS[band] ?? OPEX_ASSUMPTIONS.SMALL_MULTI;
  const lines = {};
  const known = [];
  const assumed = [];
  const missing = [];

  const useActualOrModel = (key, actualField, modeledValue, label) => {
    const actual = num(actualField?.value);
    if (actual !== null && (actualField?.basis === FIELD_BASIS.KNOWN)) {
      lines[key] = { value: roundMoney(actual), basis: FIELD_BASIS.KNOWN, source: actualField.source };
      known.push(key);
    } else if (modeledValue !== null) {
      lines[key] = { value: roundMoney(modeledValue), basis: FIELD_BASIS.ASSUMED, source: label };
      assumed.push(key);
    } else {
      lines[key] = { value: null, basis: FIELD_BASIS.UNKNOWN, source: null };
      missing.push(key);
    }
  };

  const egi = num(egiAnnual);
  useActualOrModel('taxes', contract.taxes_annual, subjectValue !== null ? subjectValue * a.tax_rate_of_value : null, `assumed_${a.tax_rate_of_value}_of_value`);
  useActualOrModel('insurance', contract.insurance_annual, units * a.insurance_per_unit, `assumed_${a.insurance_per_unit}_per_unit`);
  useActualOrModel('management', contract.management_annual, egi !== null ? egi * a.management : null, `assumed_${a.management}_of_egi`);
  useActualOrModel('maintenance', contract.maintenance_annual, units * a.maintenance_per_unit, `assumed_${a.maintenance_per_unit}_per_unit`);
  useActualOrModel('utilities', contract.owner_paid_utilities_annual, units * a.utilities_per_unit, `assumed_${a.utilities_per_unit}_per_unit`);
  useActualOrModel('payroll', contract.payroll_annual, a.payroll_per_unit > 0 ? units * a.payroll_per_unit : 0, `assumed_${a.payroll_per_unit}_per_unit`);
  useActualOrModel('administration', contract.administration_annual, egi !== null ? egi * a.admin : null, `assumed_${a.admin}_of_egi`);
  useActualOrModel('replacement_reserves', contract.replacement_reserves_annual, units * a.reserves_per_unit, `assumed_${a.reserves_per_unit}_per_unit`);

  const total = Object.values(lines).reduce((s, l) => s + (l.value ?? 0), 0);
  const actualTotal = Object.values(lines).filter((l) => l.basis === FIELD_BASIS.KNOWN).reduce((s, l) => s + (l.value ?? 0), 0);

  return {
    lines,
    total_operating_expenses: roundMoney(total),
    actual_operating_expenses: roundMoney(actualTotal),
    expense_ratio: egi && egi > 0 ? round(total / egi, 3) : null,
    expense_per_unit: units ? roundMoney(total / units) : null,
    expense_per_sqft: num(contract.rentable_square_feet?.value) ? round(total / num(contract.rentable_square_feet.value), 2) : null,
    known_lines: known,
    assumed_lines: assumed,
    missing_lines: missing,
    confidence: clamp((known.length / EXPENSE_CATEGORIES.length) * 100 + 20, 0, 100),
  };
}

/* -------------------------------------------------------------------------- */
/* NOI / EGI bridge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * EGI and NOI from a gross potential rent. Debt service, depreciation, income
 * tax and capital expenditures are EXCLUDED from operating expenses (mission §3).
 */
export function computeNOI({ gprAnnual, otherIncomeAnnual = 0, vacancyPct, concessionsAnnual = 0, badDebtAnnual = 0, opexAnnual }) {
  const gpr = num(gprAnnual);
  if (gpr === null) return null;
  const vac = clamp(num(vacancyPct) ?? 0, 0, 0.95);
  const vacancyLoss = gpr * vac;
  const egi = gpr + (num(otherIncomeAnnual) ?? 0) - vacancyLoss - (num(concessionsAnnual) ?? 0) - (num(badDebtAnnual) ?? 0);
  const opex = num(opexAnnual) ?? 0;
  const noi = egi - opex;
  return {
    gross_potential_rent: roundMoney(gpr),
    other_income: roundMoney(num(otherIncomeAnnual) ?? 0),
    vacancy_credit_loss: roundMoney(vacancyLoss),
    concessions: roundMoney(num(concessionsAnnual) ?? 0),
    bad_debt: roundMoney(num(badDebtAnnual) ?? 0),
    effective_gross_income: roundMoney(egi),
    operating_expenses: roundMoney(opex),
    noi: roundMoney(noi),
    excludes: ['debt_service', 'depreciation', 'income_tax', 'capital_expenditures'],
  };
}

/* -------------------------------------------------------------------------- */
/* Cap-rate model                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a cap rate. A QUALIFIED cap rate requires qualified income-property
 * evidence (comp sales with supportable NOI, or investor/institutional single-
 * asset purchases in the same size band). Otherwise a labeled default is used
 * and the resulting value must be treated as PROVISIONAL.
 */
export function resolveCapRate({ capEvidence = [], family = ASSET_FAMILIES.MULTIFAMILY, subjectCapRate = null } = {}) {
  const qualified = (capEvidence ?? []).filter(
    (e) => num(e.cap_rate) !== null && num(e.cap_rate) > 0.02 && num(e.cap_rate) < 0.2 && e.qualified === true,
  );
  if (qualified.length >= 3) {
    const rates = qualified.map((e) => num(e.cap_rate)).sort((x, y) => x - y);
    const mid = rates[Math.floor((rates.length - 1) / 2)];
    return { cap_rate: round(mid, 4), basis: FIELD_BASIS.KNOWN, qualified: true, evidence_count: qualified.length, source: 'qualified_income_comps' };
  }
  const subj = num(subjectCapRate);
  if (subj !== null && subj > 0.02 && subj < 0.2) {
    return { cap_rate: round(subj, 4), basis: FIELD_BASIS.INFERRED, qualified: false, evidence_count: 0, source: 'subject_reported_cap' };
  }
  const def = DEFAULT_CAP_RATE[family] ?? DEFAULT_CAP_RATE.UNKNOWN;
  return { cap_rate: def, basis: FIELD_BASIS.ASSUMED, qualified: false, evidence_count: qualified.length, source: `default_${family}` };
}

/* -------------------------------------------------------------------------- */
/* Income ratios                                                               */
/* -------------------------------------------------------------------------- */

export function grm(price, grossAnnualRent) {
  const p = num(price); const g = num(grossAnnualRent);
  return p !== null && g && g > 0 ? round(p / g, 2) : null;
}
export function egim(price, egiAnnual) {
  const p = num(price); const e = num(egiAnnual);
  return p !== null && e && e > 0 ? round(p / e, 2) : null;
}
export function pricePerUnit(price, units) {
  const p = num(price); const u = num(units);
  return p !== null && u && u > 0 ? roundMoney(p / u) : null;
}
export function pricePerRentableSqft(price, rentableSqft) {
  const p = num(price); const s = num(rentableSqft);
  return p !== null && s && s > 0 ? round(p / s, 2) : null;
}
export function capRateFromValue(noi, value) {
  const n = num(noi); const v = num(value);
  return n !== null && v && v > 0 ? round(n / v, 4) : null;
}
export function valueFromCap(noi, capRate) {
  const n = num(noi); const c = num(capRate);
  return n !== null && c && c > 0 ? roundMoney(n / c) : null;
}
/** Break-even occupancy = (opex + annual debt service) / gross potential rent. */
export function breakEvenOccupancy(opexAnnual, annualDebtService, gprAnnual) {
  const o = num(opexAnnual); const d = num(annualDebtService) ?? 0; const g = num(gprAnnual);
  return o !== null && g && g > 0 ? round((o + d) / g, 4) : null;
}
/** Debt yield = NOI / loan amount. */
export function debtYield(noi, loanAmount) {
  const n = num(noi); const l = num(loanAmount);
  return n !== null && l && l > 0 ? round(n / l, 4) : null;
}
/** DSCR = NOI / annual debt service. */
export function dscr(noi, annualDebtService) {
  const n = num(noi); const d = num(annualDebtService);
  return n !== null && d && d > 0 ? round(n / d, 3) : null;
}

/* -------------------------------------------------------------------------- */
/* Operating statement (rent + expenses + current/stabilized NOI)              */
/* -------------------------------------------------------------------------- */

/**
 * Tie the rent model, expense model and NOI bridge into one operating
 * statement. Produces both a CURRENT NOI (current rent, modeled/actual opex) and
 * a STABILIZED NOI (market rent at stabilized vacancy). All assumptions labeled;
 * if essential rent inputs are absent the statement is flagged provisional.
 */
export function buildOperatingStatement(contract, { lane, comparableMarketMonthlyRent = null, subjectValue = null } = {}) {
  const band = sizeBand(lane, contract.unit_count?.value);
  const a = OPEX_ASSUMPTIONS[band] ?? OPEX_ASSUMPTIONS.SMALL_MULTI;
  const rent = resolveRentModel(contract, { comparableMarketMonthlyRent });

  const otherIncome = num(contract.other_income_annual?.value) ?? 0;
  const concessions = num(contract.concessions_annual?.value) ?? 0;
  const badDebt = num(contract.bad_debt_annual?.value) ?? 0;
  // Observed occupancy → vacancy; else size-band assumption.
  const occ = num(contract.occupancy?.value);
  const observedVacancy = occ !== null ? clamp(1 - (occ > 1 ? occ / 100 : occ), 0, 0.95) : null;
  const vacancyPct = observedVacancy ?? a.vacancy;

  // First-pass EGI on current rent to scale % expense lines.
  const currentGpr = rent.current_gross_annual;
  const firstPassEgi = currentGpr !== null ? currentGpr + otherIncome - currentGpr * vacancyPct - concessions - badDebt : null;
  const expenses = resolveExpenseModel(contract, { band, egiAnnual: firstPassEgi, subjectValue });

  const current = currentGpr !== null
    ? computeNOI({ gprAnnual: currentGpr, otherIncomeAnnual: otherIncome, vacancyPct, concessionsAnnual: concessions, badDebtAnnual: badDebt, opexAnnual: expenses.total_operating_expenses })
    : null;

  const stabilizedGpr = rent.stabilized_gross_annual ?? rent.market_gross_annual;
  const stabilized = stabilizedGpr !== null
    ? computeNOI({ gprAnnual: stabilizedGpr, otherIncomeAnnual: otherIncome, vacancyPct: a.vacancy, concessionsAnnual: 0, badDebtAnnual: 0, opexAnnual: expenses.total_operating_expenses })
    : null;

  const incomeSupported = rent.current_basis === FIELD_BASIS.KNOWN && (rent.confidence ?? 0) >= 50;

  return {
    band,
    rent,
    expenses,
    current_noi: current,
    stabilized_noi: stabilized,
    vacancy_pct_used: round(vacancyPct, 4),
    income_supported: incomeSupported,
    provisional: !incomeSupported,
  };
}
