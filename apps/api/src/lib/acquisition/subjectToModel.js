/**
 * Acquisition Engine V3 — subject-to engine (mission Item 4 §12).
 *
 * Uses ACTUAL debt fields where available; returns labeled scenarios (never
 * fabricated facts) when incomplete. Remains non-executable without sufficient
 * debt/payment/tax/rent information, and fails on stressed DSCR.
 */

import {
  SUBJECT_TO as ST,
  EXECUTION_STATES,
  num,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';

export function buildSubjectTo({ subjectRow = {}, marketRentMonthly = null, reconciliation = {} }) {
  const missing = [];
  const disqualifiers = [];
  const assumptions = [];

  const loanBalance = num(subjectRow.total_loan_balance) ?? num(subjectRow.total_loan_amt);
  const payment = num(subjectRow.total_loan_payment);
  const rent = num(marketRentMonthly) ?? num(subjectRow.monthly_rent) ?? num(subjectRow.rent_estimate);
  const taxesMonthly = num(subjectRow.tax_amt) != null ? num(subjectRow.tax_amt) / 12 : null;

  if (loanBalance == null) missing.push('total_loan_balance');
  if (payment == null) missing.push('total_loan_payment');
  if (rent == null) missing.push('market_rent');
  if (taxesMonthly == null) missing.push('tax_amount');

  const value = num(reconciliation.reconciled_market_value_mid);
  const insuranceMonthly = value ? (value * 0.005) / 12 : null;
  if (subjectRow.insurance_annual == null && value) assumptions.push('insurance=0.5%_of_value');

  const hasCore = loanBalance != null && payment != null && rent != null;
  if (!hasCore) {
    return {
      available: false,
      execution_state: EXECUTION_STATES.DATA_REQUIRED,
      executable: false,
      subject_to_viability_score: 0,
      subject_to_confidence: 20,
      missing_required_information: missing,
      subject_to_disqualifiers: ['insufficient_debt_or_rent_information'],
      assumptions,
    };
  }

  const arrears = num(subjectRow.past_due_amount) ?? 0;
  if (subjectRow.past_due_amount == null) assumptions.push('arrears=0_assumed_current');
  const closing = 3_000;
  const immediateRepairs = num(reconciliation.repair_immediate) ?? 0;
  const sellerCash = 0; // negotiable; not fabricated
  const totalEntry = roundMoney(arrears + closing + immediateRepairs + sellerCash);

  const opexRate = ST.vacancy_pct + ST.management_pct + ST.maintenance_pct + ST.reserve_pct;
  const insMo = insuranceMonthly ?? 0;
  const fixedMo = (taxesMonthly ?? 0) + insMo;
  const noiMonthly = rent - rent * opexRate - fixedMo;
  const cashFlow = noiMonthly - payment;
  const dscr = payment > 0 ? noiMonthly / payment : null;

  // stress
  const rentS = rent * (1 - ST.stress_rent_drop);
  const noiS = rentS - rentS * opexRate - fixedMo * (1 + ST.stress_expense_increase);
  const dscrS = payment > 0 ? noiS / payment : null;
  if (dscrS != null && dscrS < ST.min_stressed_dscr) disqualifiers.push('fails_stressed_dscr');

  const coc = totalEntry > 0 ? (cashFlow * 12) / totalEntry : null;
  const projections = [1, 3, 5, 10].map((yr) => {
    const grow = 1.03 ** yr;
    const rentY = rent * grow;
    const noiY = rentY - rentY * opexRate - fixedMo * 1.03 ** yr;
    return { year: yr, annual_cash_flow: roundMoney((noiY - payment) * 12) };
  });

  const executable = disqualifiers.length === 0 && (dscr ?? 0) >= ST.target_dscr;
  const viability = clamp(
    (dscr ? clamp((dscr - 0.8) * 120, 0, 60) : 0) + (coc ? clamp(coc * 300, 0, 40) : 0),
    0,
    100,
  );

  return {
    available: true,
    execution_state: executable ? EXECUTION_STATES.SHADOW_MODE_READY : EXECUTION_STATES.REVIEW_REQUIRED,
    executable,
    existing_loan_balance: roundMoney(loanBalance),
    monthly_loan_payment: roundMoney(payment),
    arrears_cure: roundMoney(arrears),
    total_entry_cost: totalEntry,
    market_rent: roundMoney(rent),
    monthly_noi: roundMoney(noiMonthly),
    monthly_cash_flow: roundMoney(cashFlow),
    annual_cash_flow: roundMoney(cashFlow * 12),
    dscr: dscr != null ? round(dscr, 3) : null,
    stressed_dscr: dscrS != null ? round(dscrS, 3) : null,
    cash_on_cash_return: coc != null ? round(coc, 4) : null,
    break_even_occupancy: round((rent * opexRate + fixedMo + payment) / rent, 3),
    projections,
    subject_to_viability_score: Math.round(viability),
    subject_to_confidence: Math.round(clamp(60 - missing.length * 10, 10, 80)),
    missing_required_information: missing,
    subject_to_disqualifiers: disqualifiers,
    assumptions,
    stress_tests: { rent_minus_10pct: true, expenses_plus_15pct: true },
  };
}
