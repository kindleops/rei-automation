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
/* Monetary tiers + strategy semantics (Item 5D.5 §2, §3)                       */
/* -------------------------------------------------------------------------- */

const UNDERWRITTEN_SET = new Set([SQ.UNDERWRITTEN_SHADOW, SQ.EXECUTABLE]);

/** Extract a strategy's primary offer figures for monetary tiering, or null. */
function extractOfferFigures(entry) {
  if (entry.strategy === S.CASH) {
    if (num(entry.recommended_cash_offer) === null) return null;
    return {
      opening: entry.opening_cash_offer ?? null,
      recommended: entry.recommended_cash_offer ?? null,
      maximum: entry.maximum_cash_offer ?? null,
      walkaway: entry.maximum_cash_offer ?? null, // max price before walking
    };
  }
  if (entry.strategy === STORAGE_DISPOSITION_STRATEGY) {
    if (num(entry.projected_seller_net) === null) return null;
    return {
      opening: null,
      recommended: entry.projected_seller_net ?? null,
      maximum: entry.expected_disposition_value ?? null,
      walkaway: null,
    };
  }
  // Seller-finance / commercial-debt carry structures/terms, not a single offer.
  return null;
}

/**
 * Split a strategy's primary offer figures into three mutually-exclusive tiers.
 * scenario_* exist only for PROVISIONAL_SCENARIO; shadow_* only for underwritten
 * economics; authorized_* only when LIVE authorization is granted (flags off ⇒
 * always null). No consumer should infer authorization from a generic figure.
 */
export function tierMonetary({ status, liveAuthorized, opening = null, recommended = null, maximum = null, walkaway = null }) {
  const scenario = status === SQ.PROVISIONAL_SCENARIO;
  const underwritten = UNDERWRITTEN_SET.has(status);
  const present = (v) => (v === null || v === undefined ? null : v);
  return {
    scenario_opening: scenario ? present(opening) : null,
    scenario_recommended: scenario ? present(recommended) : null,
    scenario_maximum: scenario ? present(maximum) : null,
    scenario_walkaway: scenario ? present(walkaway) : null,
    shadow_opening: underwritten ? present(opening) : null,
    shadow_recommended: underwritten ? present(recommended) : null,
    shadow_maximum: underwritten ? present(maximum) : null,
    shadow_walkaway: underwritten ? present(walkaway) : null,
    authorized_opening: liveAuthorized ? present(opening) : null,
    authorized_recommended: liveAuthorized ? present(recommended) : null,
    authorized_maximum: liveAuthorized ? present(maximum) : null,
    authorized_walkaway: liveAuthorized ? present(walkaway) : null,
  };
}

/**
 * Derive the full, unambiguous semantic-flag set for a single strategy.
 * Distinguishes: economically modeled / provisional scenario / fully
 * underwritten / shadow-eligible / shadow-approved / live-execution-eligible /
 * live-authorized. live_authorized is false while unsafe execution flags are off.
 */
function strategySemantics({ status, available, classFirstOk, buyerExitQualified, incomeLedRequired, incomeLedOk, recordGated, liveFlagsEnabled }) {
  const modeled = available && (UNDERWRITTEN_SET.has(status) || status === SQ.PROVISIONAL_SCENARIO);
  const scenarioOnly = status === SQ.PROVISIONAL_SCENARIO;
  const underwritten = UNDERWRITTEN_SET.has(status);
  const shadowEligible = underwritten && classFirstOk && !recordGated && (!incomeLedRequired || incomeLedOk);
  const shadowApproved = shadowEligible && buyerExitQualified;
  const liveExecutionEligible = shadowApproved && status === SQ.EXECUTABLE;
  const liveAuthorized = liveExecutionEligible && liveFlagsEnabled === true;

  const blockers = [];
  if (recordGated) blockers.push('record_class_not_pricing_eligible');
  if (!underwritten) blockers.push(scenarioOnly ? 'scenario_only_economics' : 'not_underwritten');
  if (!classFirstOk) blockers.push('class_first_gate');
  if (incomeLedRequired && !incomeLedOk) blockers.push('insufficient_income_evidence');
  if (!buyerExitQualified) blockers.push('no_qualified_buyer_exit');
  if (status !== SQ.EXECUTABLE) blockers.push('not_executable_economics');
  if (!liveFlagsEnabled) blockers.push('unsafe_execution_flags_disabled');

  return {
    modeled,
    scenario_only: scenarioOnly,
    underwritten,
    shadow_eligible: shadowEligible,
    shadow_approved: shadowApproved,
    live_execution_eligible: liveExecutionEligible,
    live_authorized: liveAuthorized,
    execution_basis_eligible: shadowApproved,
    authorization_blockers: [...new Set(blockers)],
  };
}

/* -------------------------------------------------------------------------- */
/* Qualification (§16) + execution-state basis (Item 5D.5 §2)                   */
/* -------------------------------------------------------------------------- */

/**
 * Class-first storage strategy qualification with hardened, unambiguous
 * authorization semantics. SHADOW_MODE_READY requires supportable asset
 * classification, transaction OR income evidence, reliable NRSF/physical size, a
 * qualified buyer exit and at least one shadow-approved underwritten strategy.
 * Income-led strategies additionally require rent/revenue, occupancy, expenses,
 * NOI and cap-rate evidence. AUTO / live authorization stay disabled.
 *
 * @param {object} args
 * @param {boolean} [args.recordGated]       record class is not pricing-eligible
 * @param {boolean} [args.liveFlagsEnabled]  unsafe execution flags (always false here)
 */
export function qualifyStorageStrategies({
  classification, contract, valuation, noi, revenue, capRate, buyerExit, capital,
  strategies, recordGated = false, liveFlagsEnabled = false,
}) {
  const buyerExitQualified = buyerExit?.exit_classification === 'QUALIFIED';
  const requirements = {
    asset_classification: Boolean(classification?.is_self_storage && classification?.genuine_facility) && !recordGated,
    reliable_size: Boolean(num(contract?.physical?.net_rentable_square_feet?.value)),
    transaction_or_income_evidence:
      (valuation?.reconciliation?.qualified_method_count ?? 0) > 0 || Boolean(noi?.income_supported),
    buyer_exit: buyerExitQualified,
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

  const classFirstOk = !recordGated && requirements.asset_classification && requirements.reliable_size && requirements.transaction_or_income_evidence;
  const incomeLedOk = Object.values(incomeEvidence).every(Boolean);

  const ranked = [];
  const evaluate = (entry) => {
    if (!entry || entry.qualification === undefined) return;
    let status = entry.qualification;
    // Record gate: an ambiguous / false-positive record cannot be underwritten.
    if (recordGated && UNDERWRITTEN_SET.has(status)) status = SQ.DATA_REQUIRED;
    // Demote above-provisional economics when class-first gates fail.
    if (!classFirstOk && UNDERWRITTEN_SET.has(status)) {
      status = status === SQ.DATA_REQUIRED ? SQ.DATA_REQUIRED : SQ.PROVISIONAL_SCENARIO;
    }
    const isIncomeLed = entry.strategy === S.SELLER_FINANCE || entry.debt_model === STORAGE_DEBT_MODEL;
    if (isIncomeLed && !incomeLedOk && UNDERWRITTEN_SET.has(status)) status = SQ.PROVISIONAL_SCENARIO;

    const semantics = strategySemantics({
      status, available: Boolean(entry.available), classFirstOk, buyerExitQualified,
      incomeLedRequired: isIncomeLed, incomeLedOk, recordGated, liveFlagsEnabled,
    });

    // Tier the strategy's primary offer figures by the FINAL (post-demotion) status.
    const fig = extractOfferFigures(entry);
    const monetary = fig
      ? tierMonetary({ status, liveAuthorized: semantics.live_authorized, ...fig })
      : null;

    ranked.push({
      strategy: entry.strategy,
      debt_model: entry.debt_model ?? null,
      qualification_status: status,
      ...semantics,
      // Backward-compatible alias (consumers migrating to live_authorized).
      authorized_offer: semantics.live_authorized,
      available: Boolean(entry.available),
      monetary,
    });
  };
  evaluate(strategies.cash);
  evaluate(strategies.seller_finance);
  evaluate(strategies.commercial_debt);
  evaluate(strategies.disposition);

  const shadowApproved = ranked.filter((r) => r.shadow_approved);
  const shadowModeReady = shadowApproved.length >= 1;

  return {
    requirements,
    income_evidence: incomeEvidence,
    class_first_ok: classFirstOk,
    income_led_ok: incomeLedOk,
    record_gated: recordGated,
    ranked,
    shadow_approved_strategies: shadowApproved.map((r) => r.strategy),
    shadow_mode_ready: shadowModeReady,
    live_flags_enabled: liveFlagsEnabled,
    auto_states_enabled: false,
  };
}

/**
 * Build the decision-level execution-state basis with hardened semantics. The
 * underwritten shadow strategy's identity is preserved even though live
 * authorization is null while unsafe flags are disabled.
 */
export function buildStorageExecutionBasis({ ranked = [], executionState, liveFlagsEnabled = false }) {
  const underwritten = ranked.filter((r) => r.underwritten).map((r) => r.strategy);
  const shadowApproved = ranked.filter((r) => r.shadow_approved).map((r) => r.strategy);
  const provisional = ranked.filter((r) => r.scenario_only).map((r) => r.strategy);

  // SHADOW_MODE_READY must name a shadow-approved basis (prefer CASH).
  let basisStrategy = null;
  if (executionState === 'SHADOW_MODE_READY' && shadowApproved.length) {
    basisStrategy = shadowApproved.includes(S.CASH) ? S.CASH : shadowApproved[0];
  }

  const liveAuthorized = ranked.find((r) => r.live_authorized) ?? null; // null while flags off
  const cash = ranked.find((r) => r.strategy === S.CASH) ?? null;

  return {
    execution_state: executionState,
    execution_state_basis_strategy: basisStrategy,
    underwritten_strategies: underwritten,
    shadow_approved_strategies: shadowApproved,
    provisional_strategies: provisional,
    live_authorized_strategy: liveAuthorized ? liveAuthorized.strategy : null,
    live_authorized_offer_type: liveAuthorized ? `${liveAuthorized.strategy}_OFFER` : null,
    outbound_execution_enabled: false,
    // Per-cash explicit flags (mission §2 worked example).
    cash_underwritten: Boolean(cash?.underwritten),
    cash_shadow_approved: Boolean(cash?.shadow_approved),
    cash_scenario_only: Boolean(cash?.scenario_only),
    cash_live_authorized: Boolean(cash?.live_authorized),
    // Backward-compatible keys (now semantically precise: authorized == live).
    authorized_strategy: liveAuthorized ? liveAuthorized.strategy : null,
    authorized_offer_type: liveAuthorized ? `${liveAuthorized.strategy}_OFFER` : null,
    cash_authorized: Boolean(cash?.live_authorized),
    note: executionState === 'SHADOW_MODE_READY' && basisStrategy && !liveAuthorized
      ? `Global ${executionState} is justified by ${basisStrategy} (underwritten shadow); no strategy is live-authorized while execution flags are disabled.`
      : null,
  };
}
