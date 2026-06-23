/**
 * Acquisition Engine V3 — Item 5B: residential-income acquisition strategies.
 *
 * Cash, Novation, Subject-To and Seller-Finance for income assets, each with its
 * OWN qualification state and universe-specific evidence depth. Key distinctions
 * (mission §10–§11):
 *   - Novation applies to qualified 2–4 retail/owner-occupant demand only; it is
 *     NOT applied to 5+ by default (5+ uses a separate commercial marketed
 *     disposition strategy).
 *   - Subject-To is a RESIDENTIAL debt model for 2–4 only when verified debt
 *     exists; for 5+ a COMMERCIAL debt strategy models maturity/balloon/
 *     covenants/recourse/resets/IO/assumability/DSCR/debt yield — never labeled
 *     ordinary residential subject-to.
 *   - Seller-finance solves cash-flow-optimized / balanced / seller-price-
 *     optimized structures; unsupported income stays provisional.
 * AUTO states remain unavailable.
 */

import {
  ASSET_FAMILIES,
  STRATEGY_QUALIFICATION as SQ,
  STRATEGIES as S,
  OFFER_COSTS,
  MARGIN_BASE_PCT,
  MARGIN_MIN_USD,
  NOVATION,
  SELLER_FINANCE,
  SUBJECT_TO,
  num,
  round,
  roundMoney,
  clamp,
} from './modelConstants.js';
import { dscr as dscrOf, debtYield as debtYieldOf } from './incomeUnderwriting.js';

/* -------------------------------------------------------------------------- */
/* Cash                                                                        */
/* -------------------------------------------------------------------------- */

export function buildIncomeCashOffer({ buyerExit, repairStab, family, demand = 50, confidence = 0 }) {
  const exit = num(buyerExit?.conservative_exit);
  if (exit === null) {
    return { strategy: S.CASH, qualification: SQ.DATA_REQUIRED, available: false, reason: 'no_conservative_buyer_exit', bridge: [] };
  }
  const oneTimeRepairs = num(repairStab?.double_count_guard?.offer_one_time_repairs) ?? 0;
  const stabilization = num(repairStab?.double_count_guard?.offer_stabilization) ?? 0;

  const closing = exit * OFFER_COSTS.buyer_closing_pct;
  const holding = exit * OFFER_COSTS.buyer_holding_pct;
  const disposition = exit * OFFER_COSTS.buyer_disposition_pct;
  const contingency = exit * OFFER_COSTS.contingency_pct;
  const dueDiligence = family === ASSET_FAMILIES.MULTIFAMILY ? exit * 0.005 : 1500;
  const financing = exit * 0.015;
  const marginPct = clamp((MARGIN_BASE_PCT[family] ?? 0.1) + (50 - demand) / 1000, 0.04, 0.3);
  const margin = Math.max(MARGIN_MIN_USD, exit * marginPct);

  const deductions = oneTimeRepairs + stabilization + closing + holding + disposition + contingency + dueDiligence + financing + margin;
  const recommended = roundMoney(exit - deductions);
  const bridge = [
    { line: 'conservative_buyer_exit', amount: roundMoney(exit) },
    { line: 'one_time_repairs', amount: -roundMoney(oneTimeRepairs) },
    { line: 'stabilization_capex', amount: -roundMoney(stabilization) },
    { line: 'buyer_closing', amount: -roundMoney(closing) },
    { line: 'holding', amount: -roundMoney(holding) },
    { line: 'disposition', amount: -roundMoney(disposition) },
    { line: 'due_diligence', amount: -roundMoney(dueDiligence) },
    { line: 'financing', amount: -roundMoney(financing) },
    { line: 'contingency', amount: -roundMoney(contingency) },
    { line: `dynamic_margin@${round(marginPct, 3)}`, amount: -roundMoney(margin) },
    { line: 'recommended_cash_offer', amount: recommended },
  ];

  // Qualification: cash needs a qualified buyer-exit basis + adequate confidence.
  const exitQualified = buyerExit?.confidence >= 55 && exit > 0 && recommended > 0;
  const qualification = !exitQualified
    ? SQ.PROVISIONAL_SCENARIO
    : confidence >= 70
      ? SQ.UNDERWRITTEN_SHADOW // EXECUTABLE requires the exec flag (handled by confidence layer)
      : SQ.UNDERWRITTEN_SHADOW;

  return {
    strategy: S.CASH,
    qualification: recommended > 0 ? qualification : SQ.DISQUALIFIED,
    available: recommended > 0,
    recommended_cash_offer: recommended > 0 ? recommended : null,
    opening_cash_offer: recommended > 0 ? roundMoney(recommended * 0.93) : null,
    maximum_cash_offer: recommended > 0 ? roundMoney(recommended * 1.08) : null,
    margin_pct_used: round(marginPct, 3),
    bridge,
    confidence: Math.round(clamp(confidence, 0, 100)),
  };
}

/* -------------------------------------------------------------------------- */
/* Novation (2–4 only) / commercial marketed disposition (5+)                  */
/* -------------------------------------------------------------------------- */

export function buildIncomeNovation({ family, valuation, buyerExit, cashRecommended }) {
  if (family === ASSET_FAMILIES.MULTIFAMILY) {
    // Residential novation does NOT apply to 5+; surface the separate channel.
    return {
      strategy: S.NOVATION,
      applicable: false,
      qualification: SQ.DISQUALIFIED,
      reason: 'residential_novation_not_applicable_to_5plus',
      alternative_strategy: 'COMMERCIAL_MARKETED_DISPOSITION',
    };
  }
  const retail = valuation?.values?.retail_owner_occupant;
  const retailQualified = retail?.available && retail.value_classification === 'QUALIFIED';
  const expectedSale = retail?.available ? retail.mid : null;
  if (!expectedSale) {
    return { strategy: S.NOVATION, applicable: true, qualification: SQ.DATA_REQUIRED, reason: 'no_retail_owner_occupant_value' };
  }
  const costs =
    expectedSale * (NOVATION.agent_commission_pct + NOVATION.seller_closing_pct + NOVATION.prep_allowance_pct + NOVATION.holding_reserve_pct + NOVATION.company_fee_pct);
  const sellerNet = roundMoney(expectedSale - costs);
  const advantage = cashRecommended ? (sellerNet - cashRecommended) / cashRecommended : null;
  const beatsCash = advantage !== null && advantage >= NOVATION.min_seller_net_advantage_pct;

  return {
    strategy: S.NOVATION,
    applicable: true,
    qualification: retailQualified && beatsCash ? SQ.UNDERWRITTEN_SHADOW : retailQualified ? SQ.PROVISIONAL_SCENARIO : SQ.PROVISIONAL_SCENARIO,
    expected_retail_sale: roundMoney(expectedSale),
    projected_seller_net: sellerNet,
    seller_net_advantage_pct: advantage === null ? null : round(advantage, 3),
    beats_cash: beatsCash,
    depends_on: 'qualified_owner_occupant_retail_demand',
    confidence: retail?.confidence ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Subject-To (residential, 2–4 only) / commercial debt takeover (5+)          */
/* -------------------------------------------------------------------------- */

export function buildIncomeDebtStrategy({ family, contract, operatingStatement }) {
  const debt = contract?.current_debt ?? {};
  const balance = num(debt.balance?.value);
  const payment = num(debt.monthly_payment?.value);
  const rate = num(debt.interest_rate?.value);
  const annualDebtService = payment !== null ? payment * 12 : null;
  const noi = operatingStatement?.current_noi?.noi ?? null;

  if (family === ASSET_FAMILIES.SMALL_MULTI) {
    // RESIDENTIAL subject-to requires verified loan/payment/rate (+ tax/insurance).
    const verified = balance !== null && payment !== null && rate !== null;
    if (!verified) {
      return {
        strategy: S.SUBJECT_TO,
        debt_model: 'RESIDENTIAL_SUBJECT_TO',
        qualification: SQ.DATA_REQUIRED,
        reason: 'residential_subject_to_requires_verified_debt(loan,payment,rate)',
        verified_debt: false,
      };
    }
    const dscrVal = dscrOf(noi, annualDebtService);
    return {
      strategy: S.SUBJECT_TO,
      debt_model: 'RESIDENTIAL_SUBJECT_TO',
      qualification: dscrVal !== null && dscrVal >= SUBJECT_TO.min_stressed_dscr ? SQ.UNDERWRITTEN_SHADOW : SQ.PROVISIONAL_SCENARIO,
      verified_debt: true,
      loan_balance: roundMoney(balance),
      monthly_payment: roundMoney(payment),
      interest_rate: rate,
      arrears: num(debt.arrears?.value),
      dscr: dscrVal,
      confidence: 55,
    };
  }

  // 5+ ⇒ COMMERCIAL debt strategy (NOT residential subject-to).
  const dscrVal = dscrOf(noi, annualDebtService);
  const dyVal = debtYieldOf(noi, balance);
  return {
    strategy: S.SUBJECT_TO,
    debt_model: 'COMMERCIAL_DEBT_TAKEOVER',
    is_residential_subject_to: false,
    qualification: balance !== null && payment !== null ? SQ.PROVISIONAL_SCENARIO : SQ.DATA_REQUIRED,
    commercial_terms: {
      maturity_date: debt.maturity_date?.value ?? null,
      balloon_months: num(debt.balloon_months?.value),
      interest_only_months: num(debt.interest_only_months?.value),
      assumable: debt.assumable?.value ?? null,
      recourse: debt.recourse?.value ?? null,
      rate_resets: debt.rate_resets?.value ?? null,
      covenants: debt.covenants?.value ?? null,
    },
    dscr: dscrVal,
    debt_yield: dyVal,
    loan_balance: balance !== null ? roundMoney(balance) : null,
    note: 'Commercial debt takeover — distinct from residential subject-to; assumption/maturity/covenant terms govern.',
  };
}

/* -------------------------------------------------------------------------- */
/* Seller finance                                                              */
/* -------------------------------------------------------------------------- */

function sellerFinanceStructure({ price, noi, downPct, rate, amortMonths, label }) {
  const down = price * downPct;
  const loan = price - down;
  const monthlyRate = rate / 12;
  const n = amortMonths;
  const payment = monthlyRate > 0 ? (loan * monthlyRate) / (1 - (1 + monthlyRate) ** -n) : loan / n;
  const annualDebtService = payment * 12;
  const dscrVal = dscrOf(noi, annualDebtService);
  const cashFlow = noi !== null ? noi - annualDebtService : null;
  const cashOnCash = cashFlow !== null && down > 0 ? cashFlow / down : null;
  return {
    label,
    price: roundMoney(price),
    down_payment: roundMoney(down),
    down_payment_pct: round(downPct, 3),
    loan_amount: roundMoney(loan),
    interest_rate: round(rate, 4),
    amortization_months: amortMonths,
    monthly_payment: roundMoney(payment),
    annual_debt_service: roundMoney(annualDebtService),
    dscr: dscrVal,
    annual_cash_flow: cashFlow !== null ? roundMoney(cashFlow) : null,
    cash_on_cash: cashOnCash === null ? null : round(cashOnCash, 3),
    satisfies_target_dscr: dscrVal !== null && dscrVal >= SELLER_FINANCE.target_dscr,
  };
}

export function buildIncomeSellerFinance({ valuation, operatingStatement, family }) {
  const dominant = valuation?.values?.[
    family === ASSET_FAMILIES.SMALL_MULTI ? 'direct_adjusted_comparable' : 'stabilized_noi_market_cap'
  ];
  const price = dominant?.available ? dominant.mid : null;
  const noi = operatingStatement?.current_noi?.noi ?? null;
  if (price === null) {
    return { strategy: S.SELLER_FINANCE, qualification: SQ.DATA_REQUIRED, reason: 'no_value_basis' };
  }
  const incomeSupported = Boolean(operatingStatement?.income_supported);
  const rate = SELLER_FINANCE.default_rate;
  const amort = SELLER_FINANCE.default_amortization_months;

  const structures = {
    cash_flow_optimized: sellerFinanceStructure({ price, noi, downPct: SELLER_FINANCE.min_down_pct, rate, amortMonths: 480, label: 'cash_flow_optimized' }),
    balanced: sellerFinanceStructure({ price, noi, downPct: 0.15, rate, amortMonths: amort, label: 'balanced' }),
    seller_price_optimized: sellerFinanceStructure({ price, noi, downPct: SELLER_FINANCE.max_down_pct, rate: rate + 0.005, amortMonths: 300, label: 'seller_price_optimized' }),
  };

  const anySatisfies = Object.values(structures).some((s) => s.satisfies_target_dscr);
  const qualification = !incomeSupported
    ? SQ.PROVISIONAL_SCENARIO
    : anySatisfies
      ? SQ.UNDERWRITTEN_SHADOW
      : SQ.PROVISIONAL_SCENARIO;

  return {
    strategy: S.SELLER_FINANCE,
    qualification,
    income_supported: incomeSupported,
    structures,
    confidence: incomeSupported ? 50 : 25,
    note: incomeSupported ? null : 'Unsupported income — seller-finance economics are provisional.',
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                                */
/* -------------------------------------------------------------------------- */

export function buildIncomeStrategies({ family, contract, valuation, buyerExit, repairStab, demand = 50, confidence = 0 }) {
  const op = valuation?.operating_statement ?? null;
  const cash = buildIncomeCashOffer({ buyerExit, repairStab, family, demand, confidence });
  const novation = buildIncomeNovation({ family, valuation, buyerExit, cashRecommended: cash.recommended_cash_offer });
  const debtStrategy = buildIncomeDebtStrategy({ family, contract, operatingStatement: op });
  const sellerFinance = buildIncomeSellerFinance({ valuation, operatingStatement: op, family });
  return { cash, novation, debt_strategy: debtStrategy, seller_finance: sellerFinance };
}
