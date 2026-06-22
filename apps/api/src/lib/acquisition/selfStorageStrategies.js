/**
 * Acquisition Engine V3 — Item 5D §15 & §16: storage acquisition strategies +
 * class-first qualification.
 *
 *   - Cash: full dollar bridge anchored on the conservative storage-operator exit.
 *   - Seller finance: cash-flow-optimized / balanced / seller-price-optimized.
 *   - Commercial debt takeover: SUBJECT_TO slot but a DISTINCT commercial debt
 *     model — never labeled residential subject-to.
 *   - Storage marketed disposition: separate from residential novation; NOT
 *     labeled residential novation.
 *
 * Each strategy carries its OWN qualification state. AUTO states stay disabled.
 * Pure & deterministic.
 */

import {
  STRATEGY_QUALIFICATION as SQ,
  STRATEGIES as S,
  OFFER_COSTS,
  MARGIN_BASE_PCT,
  MARGIN_MIN_USD,
  SELLER_FINANCE,
  num,
  round,
  roundMoney,
  clamp,
} from './modelConstants.js';
import { dscr as dscrOf, debtYield as debtYieldOf } from './incomeUnderwriting.js';
import {
  STORAGE_DISPOSITION_STRATEGY,
  STORAGE_DEBT_MODEL,
} from './selfStorageConstants.js';

/* -------------------------------------------------------------------------- */
/* Cash (§15)                                                                  */
/* -------------------------------------------------------------------------- */

export function buildStorageCashOffer({ buyerExit, capital, noi, operationalStatus, demand = 50, confidence = 0 }) {
  const exit = num(buyerExit?.conservative_buyer_exit) ?? num(buyerExit?.scenario_conservative_exit);
  if (exit === null) {
    return { strategy: S.CASH, qualification: SQ.DATA_REQUIRED, available: false, reason: 'no_conservative_buyer_exit', bridge: [] };
  }
  const oneTimeCapital = num(capital?.double_count_guard?.offer_one_time_capital) ?? 0;

  const closing = exit * OFFER_COSTS.buyer_closing_pct;
  const holding = exit * OFFER_COSTS.buyer_holding_pct;
  const disposition = exit * OFFER_COSTS.buyer_disposition_pct;
  const contingency = exit * OFFER_COSTS.contingency_pct;
  const dueDiligence = exit * 0.006;
  const environmental = 6_000; // Phase I environmental (storage has fuel/vehicle exposure)
  const legal = exit * 0.004;
  const financing = exit * 0.015;
  // Stabilization loss: NOI lost while ramping a value-add/lease-up facility.
  const currentNoi = num(noi?.current_noi?.noi);
  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  const stabilizationLoss = (operationalStatus === 'VALUE_ADD' || operationalStatus === 'LEASE_UP') && currentNoi !== null && stabilizedNoi !== null && stabilizedNoi > currentNoi
    ? (stabilizedNoi - currentNoi) * 1.5 // ~18 months of lost upside (labeled)
    : 0;

  const marginPct = clamp((MARGIN_BASE_PCT.COMMERCIAL ?? 0.12) + (50 - demand) / 1000, 0.05, 0.3);
  const margin = Math.max(MARGIN_MIN_USD, exit * marginPct);

  const deductions = oneTimeCapital + closing + holding + disposition + contingency + dueDiligence + environmental + legal + financing + stabilizationLoss + margin;
  const recommended = roundMoney(exit - deductions);

  const bridge = [
    { line: 'conservative_buyer_exit', amount: roundMoney(exit) },
    { line: 'one_time_capital', amount: -roundMoney(oneTimeCapital) },
    { line: 'buyer_closing', amount: -roundMoney(closing) },
    { line: 'holding', amount: -roundMoney(holding) },
    { line: 'disposition', amount: -roundMoney(disposition) },
    { line: 'due_diligence', amount: -roundMoney(dueDiligence) },
    { line: 'environmental_phase_I', amount: -roundMoney(environmental) },
    { line: 'legal', amount: -roundMoney(legal) },
    { line: 'financing', amount: -roundMoney(financing) },
    { line: 'stabilization_loss', amount: -roundMoney(stabilizationLoss) },
    { line: 'contingency', amount: -roundMoney(contingency) },
    { line: `dynamic_margin@${round(marginPct, 3)}`, amount: -roundMoney(margin) },
    { line: 'recommended_cash_offer', amount: recommended },
  ];

  const exitQualified = (buyerExit?.exit_classification === 'QUALIFIED') && recommended > 0;
  const qualification = recommended <= 0 ? SQ.DISQUALIFIED
    : !exitQualified ? SQ.PROVISIONAL_SCENARIO
      : SQ.UNDERWRITTEN_SHADOW; // EXECUTABLE requires the exec flag (confidence layer)

  return {
    strategy: S.CASH,
    qualification,
    available: recommended > 0,
    authorized_offer: false, // AUTO disabled — never authorized here
    recommended_cash_offer: recommended > 0 ? recommended : null,
    opening_cash_offer: recommended > 0 ? roundMoney(recommended * 0.92) : null,
    maximum_cash_offer: recommended > 0 ? roundMoney(recommended * 1.08) : null,
    margin_pct_used: round(marginPct, 3),
    bridge,
    confidence: Math.round(clamp(confidence, 0, 100)),
  };
}

/* -------------------------------------------------------------------------- */
/* Seller finance (§15)                                                        */
/* -------------------------------------------------------------------------- */

function sellerFinanceStructure({ price, noi, downPct, rate, amortMonths, balloonMonths, label }) {
  const down = price * downPct;
  const loan = price - down;
  const mRate = rate / 12;
  const payment = mRate > 0 ? (loan * mRate) / (1 - (1 + mRate) ** -amortMonths) : loan / amortMonths;
  const annualDebtService = payment * 12;
  const dscrVal = dscrOf(noi, annualDebtService);
  const debtYieldVal = debtYieldOf(noi, loan);
  const cashFlow = noi !== null ? noi - annualDebtService : null;
  const cashOnCash = cashFlow !== null && down > 0 ? cashFlow / down : null;
  return {
    label,
    price: roundMoney(price), down_payment: roundMoney(down), down_payment_pct: round(downPct, 3),
    loan_amount: roundMoney(loan), interest_rate: round(rate, 4), amortization_months: amortMonths,
    balloon_months: balloonMonths, monthly_payment: roundMoney(payment), annual_debt_service: roundMoney(annualDebtService),
    dscr: dscrVal, debt_yield: debtYieldVal,
    annual_cash_flow: cashFlow !== null ? roundMoney(cashFlow) : null,
    cash_on_cash: cashOnCash === null ? null : round(cashOnCash, 3),
    satisfies_target_dscr: dscrVal !== null && dscrVal >= SELLER_FINANCE.target_dscr,
  };
}

export function buildStorageSellerFinance({ valuation, noi, capitalRequired = 0 }) {
  const price = num(valuation?.reconciliation?.reconciled_value_mid);
  const noiVal = num(noi?.current_noi?.noi);
  const incomeSupported = Boolean(noi?.income_supported);
  if (price === null) {
    return { strategy: S.SELLER_FINANCE, qualification: SQ.DATA_REQUIRED, available: false, reason: 'no_value_basis' };
  }
  const rate = SELLER_FINANCE.default_rate;
  const structures = {
    cash_flow_optimized: sellerFinanceStructure({ price, noi: noiVal, downPct: SELLER_FINANCE.min_down_pct, rate, amortMonths: 360, balloonMonths: 84, label: 'cash_flow_optimized' }),
    balanced: sellerFinanceStructure({ price, noi: noiVal, downPct: 0.15, rate, amortMonths: 300, balloonMonths: 60, label: 'balanced' }),
    seller_price_optimized: sellerFinanceStructure({ price, noi: noiVal, downPct: SELLER_FINANCE.max_down_pct, rate: rate + 0.0075, amortMonths: 240, balloonMonths: 60, label: 'seller_price_optimized' }),
  };
  const anySatisfies = Object.values(structures).some((s) => s.satisfies_target_dscr);
  const qualification = !incomeSupported ? SQ.PROVISIONAL_SCENARIO : anySatisfies ? SQ.UNDERWRITTEN_SHADOW : SQ.PROVISIONAL_SCENARIO;
  return {
    strategy: S.SELLER_FINANCE,
    qualification,
    available: true,
    authorized_offer: false,
    income_supported: incomeSupported,
    capital_required: roundMoney(capitalRequired),
    structures,
    confidence: incomeSupported ? 50 : 25,
    note: incomeSupported ? null : 'Unsupported income — seller-finance economics are provisional.',
  };
}

/* -------------------------------------------------------------------------- */
/* Commercial debt takeover (§15) — distinct from residential subject-to        */
/* -------------------------------------------------------------------------- */

export function buildStorageCommercialDebt({ contract, noi }) {
  const debt = contract?.debt ?? {};
  const balance = num(debt.loan_balance?.value);
  const payment = num(debt.monthly_payment?.value);
  const rate = num(debt.interest_rate?.value);
  const annualDebtService = payment !== null ? payment * 12 : null;
  const noiVal = num(noi?.current_noi?.noi);
  const dscrVal = dscrOf(noiVal, annualDebtService);
  const debtYieldVal = debtYieldOf(noiVal, balance);

  const qualification = balance !== null && payment !== null
    ? (dscrVal !== null && dscrVal >= 1.2 ? SQ.UNDERWRITTEN_SHADOW : SQ.PROVISIONAL_SCENARIO)
    : SQ.DATA_REQUIRED;

  // Refinance risk: near-term balloon/maturity with thin debt yield.
  const balloonMonths = num(debt.balloon_months?.value);
  const refinanceRisk = balloonMonths !== null && balloonMonths <= 24
    ? 'HIGH' : (debtYieldVal !== null && debtYieldVal < 0.08 ? 'ELEVATED' : 'MODERATE');

  return {
    strategy: S.SUBJECT_TO, // slot
    debt_model: STORAGE_DEBT_MODEL,
    is_residential_subject_to: false,
    qualification,
    available: balance !== null,
    authorized_offer: false,
    commercial_terms: {
      loan_balance: balance !== null ? roundMoney(balance) : null,
      monthly_payment: payment !== null ? roundMoney(payment) : null,
      interest_rate: rate,
      maturity_date: debt.maturity_date?.value ?? null,
      balloon_months: balloonMonths,
      interest_only_months: num(debt.interest_only_months?.value),
      assumable: debt.assumable?.value ?? null,
      recourse: debt.recourse?.value ?? null,
      rate_resets: debt.rate_resets?.value ?? null,
      covenants: debt.covenants?.value ?? null,
    },
    dscr: dscrVal,
    debt_yield: debtYieldVal,
    refinance_risk: refinanceRisk,
    note: 'Commercial debt takeover — distinct from residential subject-to; assumption / maturity / covenant terms govern.',
  };
}

/* -------------------------------------------------------------------------- */
/* Storage marketed disposition (§15) — NOT residential novation                */
/* -------------------------------------------------------------------------- */

export function buildStorageDisposition({ valuation, buyerExit, cashRecommended }) {
  const value = num(valuation?.reconciliation?.reconciled_value_mid);
  if (value === null) {
    return { strategy: STORAGE_DISPOSITION_STRATEGY, is_residential_novation: false, qualification: SQ.DATA_REQUIRED, available: false, reason: 'no_value_basis' };
  }
  const brokerage = value * 0.03;
  const closing = value * 0.015;
  const sellerNet = roundMoney(value - brokerage - closing);
  const advantage = cashRecommended ? round((sellerNet - cashRecommended) / cashRecommended, 3) : null;
  const qualified = buyerExit?.exit_classification === 'QUALIFIED';
  return {
    strategy: STORAGE_DISPOSITION_STRATEGY,
    is_residential_novation: false,
    qualification: qualified ? SQ.UNDERWRITTEN_SHADOW : SQ.PROVISIONAL_SCENARIO,
    available: true,
    authorized_offer: false,
    expected_disposition_value: roundMoney(value),
    projected_seller_net: sellerNet,
    seller_net_advantage_pct: advantage,
    expected_disposition_days: buyerExit?.expected_disposition_days ?? null,
    note: 'Storage marketed disposition — a commercial brokered sale; NOT residential novation.',
  };
}

/* -------------------------------------------------------------------------- */
/* Qualification (§16)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Class-first storage strategy qualification. SHADOW_MODE_READY requires
 * supportable asset classification, transaction OR income evidence, reliable
 * NRSF/physical size, buyer exit, capital requirements, strategy-specific
 * evidence depth, and all invariants. Income-led qualification additionally
 * requires rent/revenue, occupancy, expenses, NOI and cap-rate evidence.
 */
export function qualifyStorageStrategies({
  classification, contract, valuation, noi, revenue, capRate, buyerExit, capital,
  strategies,
}) {
  const requirements = {
    asset_classification: Boolean(classification?.is_self_storage && classification?.genuine_facility),
    reliable_size: Boolean(num(contract?.physical?.net_rentable_square_feet?.value)),
    transaction_or_income_evidence:
      (valuation?.reconciliation?.qualified_method_count ?? 0) > 0 || Boolean(noi?.income_supported),
    buyer_exit: buyerExit?.exit_classification === 'QUALIFIED',
    capital_requirements: capital?.one_time_capital !== null || (capital?.known_items?.length ?? 0) >= 0,
    invariants_ok: true,
  };
  const incomeEvidence = {
    rent_revenue: num(revenue?.current_actual_base_annual) !== null && revenue?.current_base_basis === 'ACTUAL',
    occupancy: revenue?.physical_occupancy !== null && revenue?.physical_occupancy !== undefined,
    expenses: (valuation?.income_supported ?? false),
    noi: Boolean(noi?.income_supported),
    cap_evidence: capRate?.selected?.kind === 'OBSERVED' && capRate.selected.qualified,
  };

  const classFirstOk = requirements.asset_classification && requirements.reliable_size && requirements.transaction_or_income_evidence;
  const incomeLedOk = Object.values(incomeEvidence).every(Boolean);

  const ranked = [];
  const evaluate = (entry) => {
    if (!entry || entry.qualification === undefined) return;
    // Demote any strategy above PROVISIONAL when class-first gates fail.
    let status = entry.qualification;
    if (!classFirstOk && (status === SQ.UNDERWRITTEN_SHADOW || status === SQ.EXECUTABLE)) {
      status = entry.qualification === SQ.DATA_REQUIRED ? SQ.DATA_REQUIRED : SQ.PROVISIONAL_SCENARIO;
    }
    // Income-led strategies (seller finance, commercial debt) require full income
    // evidence to be more than provisional.
    const isIncomeLed = entry.strategy === S.SELLER_FINANCE || entry.debt_model === STORAGE_DEBT_MODEL;
    if (isIncomeLed && !incomeLedOk && (status === SQ.UNDERWRITTEN_SHADOW || status === SQ.EXECUTABLE)) {
      status = SQ.PROVISIONAL_SCENARIO;
    }
    ranked.push({
      strategy: entry.strategy,
      debt_model: entry.debt_model ?? null,
      qualification_status: status,
      authorized_offer: false, // AUTO disabled
      available: Boolean(entry.available),
    });
  };
  evaluate(strategies.cash);
  evaluate(strategies.seller_finance);
  evaluate(strategies.commercial_debt);
  evaluate(strategies.disposition);

  // Storage shadow-ready iff at least one strategy is underwritten AND class-first
  // gates pass AND a buyer exit exists.
  const anyUnderwritten = ranked.some((r) => r.qualification_status === SQ.UNDERWRITTEN_SHADOW || r.qualification_status === SQ.EXECUTABLE);
  const shadowModeReady = Boolean(classFirstOk && requirements.buyer_exit && anyUnderwritten);

  return {
    requirements,
    income_evidence: incomeEvidence,
    class_first_ok: classFirstOk,
    income_led_ok: incomeLedOk,
    ranked,
    shadow_mode_ready: shadowModeReady,
    auto_states_enabled: false,
  };
}
