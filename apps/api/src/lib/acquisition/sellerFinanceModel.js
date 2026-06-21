/**
 * Acquisition Engine V3 — seller-finance engine (mission Item 4 §13).
 *
 * Solves terms toward target economics (DSCR / cash-on-cash) rather than
 * returning arbitrary percentages. Three structures. Clearly labels known vs
 * inferred vs assumption vs scenario, and degrades to low-confidence scenarios
 * (never fabricated facts) when rent/NOI is unavailable.
 */

import {
  SELLER_FINANCE as SF,
  ASSET_FAMILIES,
  num,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';
import { amortizedPayment, remainingBalance, npv, irr } from './acquisitionMath.js';

function principalFromPayment(payment, annualRate, months) {
  const r = annualRate / 12;
  if (payment <= 0) return 0;
  if (r === 0) return payment * months;
  return (payment * (1 - (1 + r) ** -months)) / r;
}

function buildStructure(label, { price, rate, amortMonths, downPct, balloonMonths }, noiAnnual) {
  const notes = [];
  let down = price * downPct;
  let financed = price - down;

  if (noiAnnual && noiAnnual > 0) {
    const maxAnnualDebt = noiAnnual / SF.target_dscr;
    const maxMonthly = maxAnnualDebt / 12;
    const financedMax = principalFromPayment(maxMonthly, rate, amortMonths);
    if (financed > financedMax) {
      financed = financedMax;
      down = price - financed;
      notes.push('down_increased_to_hit_target_dscr');
    }
  } else {
    notes.push('no_rent_or_noi — terms are a labeled SCENARIO, DSCR/CoC unavailable');
  }

  const downPctActual = price > 0 ? down / price : 0;
  let feasible = true;
  if (downPctActual > SF.max_down_pct) {
    feasible = false;
    notes.push(`required_down ${round(downPctActual * 100, 1)}% exceeds max ${SF.max_down_pct * 100}%`);
  }
  if (downPctActual < SF.min_down_pct) {
    down = price * SF.min_down_pct;
    financed = price - down;
    notes.push('down_floored_at_min');
  }

  const monthlyPI = amortizedPayment(financed, rate, amortMonths);
  const annualDebt = monthlyPI * 12;
  const dscr = noiAnnual ? noiAnnual / annualDebt : null;
  const annualCF = noiAnnual ? noiAnnual - annualDebt : null;
  const coc = annualCF != null && down > 0 ? annualCF / down : null;
  const balloonBalance = remainingBalance(financed, rate, amortMonths, balloonMonths);

  // Seller note NPV (payments + balloon discounted at 7%/yr).
  const monthlyDiscount = 0.07 / 12;
  const noteNPV =
    npv(monthlyDiscount, Array.from({ length: balloonMonths }, () => monthlyPI)) +
    balloonBalance / (1 + monthlyDiscount) ** balloonMonths;

  // Buyer IRR (annual): -down, CF each year, + equity at balloon exit.
  let projectedIRR = null;
  if (annualCF != null) {
    const years = Math.round(balloonMonths / 12);
    const exitValue = price * 1.03 ** years - balloonBalance;
    const flows = [-down];
    for (let y = 1; y <= years; y += 1) flows.push(y === years ? annualCF + exitValue : annualCF);
    projectedIRR = irr(flows);
  }

  const sellerReceipts = down + monthlyPI * balloonMonths + balloonBalance;

  return {
    structure: label,
    feasible,
    purchase_price: roundMoney(price),
    down_payment: roundMoney(down),
    down_pct: round(downPctActual, 4),
    financed_balance: roundMoney(financed),
    interest_rate: rate,
    amortization_months: amortMonths,
    balloon_months: balloonMonths,
    monthly_principal_interest: roundMoney(monthlyPI),
    dscr: dscr != null ? round(dscr, 3) : null,
    cash_on_cash_return: coc != null ? round(coc, 4) : null,
    note_npv_to_seller: roundMoney(noteNPV),
    projected_irr: projectedIRR != null ? round(projectedIRR, 4) : null,
    seller_total_receipts: roundMoney(sellerReceipts),
    buyer_total_basis: roundMoney(down + monthlyPI * balloonMonths + balloonBalance),
    balloon_balance: roundMoney(balloonBalance),
    notes,
  };
}

export function buildSellerFinance({ reconciliation = {}, subjectRow = {}, marketRentMonthly = null, family = ASSET_FAMILIES.UNKNOWN }) {
  const priceBase =
    num(reconciliation.reconciled_market_value_mid) ?? num(reconciliation.base_investor_exit);
  const priceHigh = num(reconciliation.reconciled_market_value_high) ?? priceBase;
  const rent = num(marketRentMonthly) ?? num(subjectRow.monthly_rent) ?? num(subjectRow.rent_estimate);
  const noiAnnual = num(subjectRow.noi_estimate) ?? (rent ? rent * 12 * 0.55 : null);
  const missing = [];
  if (!rent && !num(subjectRow.noi_estimate)) missing.push('market_rent_or_noi');

  if (!priceBase || priceBase <= 0) {
    return {
      available: false,
      seller_finance_viability_score: 0,
      seller_finance_confidence: 0,
      seller_finance_disqualifiers: ['no_price_basis'],
      missing_required_information: missing,
    };
  }

  const structures = [
    buildStructure('CASH_FLOW_OPTIMIZED', { price: priceBase, rate: SF.default_rate, amortMonths: 480, downPct: SF.min_down_pct, balloonMonths: SF.default_balloon_months }, noiAnnual),
    buildStructure('BALANCED', { price: priceBase, rate: SF.default_rate, amortMonths: SF.default_amortization_months, downPct: 0.10, balloonMonths: SF.default_balloon_months }, noiAnnual),
    buildStructure('SELLER_PRICE_OPTIMIZED', { price: priceHigh, rate: Math.max(0.03, SF.default_rate - 0.01), amortMonths: SF.default_amortization_months, downPct: 0.15, balloonMonths: 84 }, noiAnnual),
  ];

  const feasible = structures.filter((s) => s.feasible);
  const best = feasible.reduce((b, s) => (!b || (s.dscr ?? 0) > (b.dscr ?? 0) ? s : b), null) ?? structures[0];
  const labeledScenario = !noiAnnual;
  const viability = labeledScenario
    ? 25
    : clamp((best.dscr ? clamp((best.dscr - 1) * 120, 0, 70) : 0) + (best.cash_on_cash_return ? clamp(best.cash_on_cash_return * 300, 0, 30) : 0), 0, 100);

  return {
    available: true,
    value_basis: roundMoney(priceBase),
    noi_used: noiAnnual ? roundMoney(noiAnnual) : null,
    structures,
    recommended_structure: best.structure,
    seller_finance_viability_score: Math.round(viability),
    seller_finance_confidence: labeledScenario ? 25 : 60,
    seller_finance_disqualifiers: feasible.length ? [] : ['no_feasible_structure_within_down_payment_limits'],
    missing_required_information: missing,
    labels: {
      known: ['interest_rate(default)', 'amortization(default)'],
      inferred: ['purchase_price=reconciled_market_value'],
      assumptions: [noiAnnual ? 'NOI from rent×12×0.55 unless subject NOI present' : 'NO rent/NOI — scenario only', 'rent growth/appreciation 3%/yr for IRR'],
    },
  };
}
