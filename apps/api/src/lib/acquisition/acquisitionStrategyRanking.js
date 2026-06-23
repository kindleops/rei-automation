/**
 * Acquisition Engine V3 — strategy ranking + qualification states
 * (mission Item 4 §14, Item 4.5 §2).
 *
 * Every strategy carries an explicit qualification_status. Ranking sorts by
 * qualification CLASS first, then economics/confidence within the class, so a
 * PROVISIONAL_SCENARIO can never outrank an UNDERWRITTEN_SHADOW/EXECUTABLE
 * strategy on a nominal viability score. DATA_REQUIRED can't be primary;
 * DISQUALIFIED can't be primary or backup.
 *
 * Owner situation affects presentation downstream, never intrinsic value, so it
 * is not an input here.
 */

import {
  STRATEGIES,
  STRATEGY_QUALIFICATION as Q,
  QUALIFICATION_CLASS_RANK as RANK,
  PRIMARY_ELIGIBLE_STATUSES,
  EXECUTABLE_EXECUTION_STATES,
  VALUE_CLASSIFICATION as VC,
  clamp,
  round,
} from './modelConstants.js';

function entry(strategy, fields) {
  const status = fields.qualification_status;
  const rankingEligible = PRIMARY_ELIGIBLE_STATUSES.includes(status);
  const isCash = strategy === STRATEGIES.CASH;
  const offerFieldsPopulated = isCash && (status === Q.EXECUTABLE || status === Q.UNDERWRITTEN_SHADOW);
  return {
    strategy,
    qualification_status: status,
    viability: round(fields.viability ?? 0, 1),
    confidence: round(fields.confidence ?? 0, 1),
    economics_score: fields.economics_score ?? null,
    scenario_only: fields.scenario_only ?? (status !== Q.EXECUTABLE && status !== Q.UNDERWRITTEN_SHADOW),
    required_inputs: fields.required_inputs ?? [],
    missing_required_inputs: fields.missing_required_inputs ?? [],
    assumed_inputs: fields.assumed_inputs ?? [],
    failed_gates: fields.failed_gates ?? [],
    authorized_offer: offerFieldsPopulated,
    execution_eligible: status === Q.EXECUTABLE,
    ranking_eligible: rankingEligible,
    positions: fields.positions ?? null,
    reasons: fields.reasons ?? [],
    disqualifiers: fields.disqualifiers ?? [],
    class_rank: RANK[status] ?? 0,
    composite: round((RANK[status] ?? 0) * 1000 + (fields.viability ?? 0) * ((fields.confidence ?? 0) / 100), 2),
  };
}

export function buildStrategyRanking({
  cashOffer = {},
  novation = {},
  subjectTo = {},
  sellerFinance = {},
  executionState,
  reconciliation = {},
  autoOfferEligible = false,
  autoCreativeEligible = false,
}) {
  const globalExecutable = EXECUTABLE_EXECUTION_STATES.includes(executionState);
  const qualifiedExit = reconciliation.investor_exit_classification === VC.QUALIFIED;
  const candidates = [];

  // -------------------------- CASH --------------------------
  {
    let status;
    const failed = [];
    const missing = [];
    const assumed = [];
    if (!cashOffer.available) {
      status = Q.DATA_REQUIRED;
      missing.push('conservative_buyer_exit');
    } else if (!qualifiedExit) {
      status = Q.PROVISIONAL_SCENARIO;
      missing.push('qualified_buyer_exit');
      assumed.push(`buyer_exit_basis=${reconciliation.investor_exit_classification}`);
      failed.push('no_qualified_buyer_exit');
    } else if (globalExecutable && autoOfferEligible) {
      status = Q.EXECUTABLE;
    } else if (globalExecutable) {
      status = Q.UNDERWRITTEN_SHADOW;
      failed.push('execution_flag_disabled_or_shadow');
    } else {
      status = Q.PROVISIONAL_SCENARIO;
      failed.push(`execution_state:${executionState}`);
    }
    candidates.push(
      entry(STRATEGIES.CASH, {
        qualification_status: status,
        viability: cashOffer.available ? clamp(50 + (cashOffer.margin_on_exit ?? 0) * 200, 0, 100) : 0,
        confidence: reconciliation.investor_exit_confidence ?? 0,
        economics_score: round((cashOffer.margin_on_exit ?? 0) * 100, 1),
        required_inputs: ['qualified_buyer_exit', 'repair_estimate'],
        missing_required_inputs: missing,
        assumed_inputs: assumed,
        failed_gates: failed,
        positions: cashOffer.available
          ? {
              opening: cashOffer.opening_cash_offer,
              target: cashOffer.target_cash_offer,
              recommended: cashOffer.recommended_cash_offer,
              maximum: cashOffer.maximum_cash_offer,
              walkaway: cashOffer.walkaway_cash_price,
            }
          : null,
        reasons: ['offer derived from conservative buyer exit'],
        disqualifiers: cashOffer.available ? [] : ['no_conservative_buyer_exit'],
      }),
    );
  }

  // -------------------------- NOVATION --------------------------
  {
    let status;
    const dq = novation.novation_disqualifiers ?? [];
    if (!novation.available) {
      status = dq.includes('insufficient_retail_liquidity') ? Q.DISQUALIFIED : Q.DATA_REQUIRED;
    } else if (!novation.novation_recommended) {
      status = Q.PROVISIONAL_SCENARIO;
    } else if (globalExecutable) {
      status = Q.UNDERWRITTEN_SHADOW; // listing strategy: never auto-authorized via flag
    } else {
      status = Q.PROVISIONAL_SCENARIO;
    }
    candidates.push(
      entry(STRATEGIES.NOVATION, {
        qualification_status: status,
        viability: novation.novation_viability_score ?? 0,
        confidence: novation.novation_confidence ?? 0,
        economics_score: round((novation.seller_net_advantage_vs_cash ?? 0) * 100, 1),
        required_inputs: ['qualified_retail_depth', 'retail_liquidity'],
        missing_required_inputs: novation.available ? [] : dq,
        failed_gates: novation.available ? [] : dq,
        reasons: novation.novation_reasoning ?? [],
        disqualifiers: dq,
      }),
    );
  }

  // -------------------------- SUBJECT_TO --------------------------
  {
    let status;
    const dq = subjectTo.subject_to_disqualifiers ?? [];
    if (!subjectTo.available) {
      status = Q.DATA_REQUIRED;
    } else if (dq.includes('fails_stressed_dscr')) {
      status = Q.DISQUALIFIED;
    } else if (subjectTo.dscr == null) {
      status = Q.PROVISIONAL_SCENARIO;
    } else if (subjectTo.executable && globalExecutable && autoCreativeEligible) {
      status = Q.EXECUTABLE;
    } else if (subjectTo.executable && globalExecutable) {
      status = Q.UNDERWRITTEN_SHADOW;
    } else {
      status = Q.PROVISIONAL_SCENARIO;
    }
    candidates.push(
      entry(STRATEGIES.SUBJECT_TO, {
        qualification_status: status,
        viability: subjectTo.subject_to_viability_score ?? 0,
        confidence: subjectTo.subject_to_confidence ?? 0,
        economics_score: subjectTo.cash_on_cash_return != null ? round(subjectTo.cash_on_cash_return * 100, 1) : null,
        required_inputs: ['loan_balance', 'loan_payment', 'market_rent', 'taxes', 'insurance'],
        missing_required_inputs: subjectTo.missing_required_information ?? [],
        assumed_inputs: subjectTo.assumptions ?? [],
        failed_gates: dq,
        reasons: subjectTo.executable ? ['debt-supported, passes stressed DSCR'] : ['scenario only'],
        disqualifiers: dq,
      }),
    );
  }

  // -------------------------- SELLER_FINANCE --------------------------
  {
    let status;
    const dq = sellerFinance.seller_finance_disqualifiers ?? [];
    const best = (sellerFinance.structures ?? []).find((s) => s.structure === sellerFinance.recommended_structure);
    if (!sellerFinance.available) {
      status = Q.DATA_REQUIRED;
    } else if (dq.length) {
      status = Q.DISQUALIFIED;
    } else if (!best || best.dscr == null) {
      status = Q.PROVISIONAL_SCENARIO; // price/payment scenario, not an underwritten return
    } else if (globalExecutable && autoCreativeEligible) {
      status = Q.EXECUTABLE;
    } else if (globalExecutable) {
      status = Q.UNDERWRITTEN_SHADOW;
    } else {
      status = Q.PROVISIONAL_SCENARIO;
    }
    candidates.push(
      entry(STRATEGIES.SELLER_FINANCE, {
        qualification_status: status,
        viability: sellerFinance.seller_finance_viability_score ?? 0,
        confidence: sellerFinance.seller_finance_confidence ?? 0,
        economics_score: best?.cash_on_cash_return != null ? round(best.cash_on_cash_return * 100, 1) : null,
        required_inputs: ['rent_or_noi', 'price_basis'],
        missing_required_inputs: sellerFinance.missing_required_information ?? [],
        assumed_inputs: sellerFinance.labels?.assumptions ?? [],
        failed_gates: dq,
        reasons: ['terms solved toward target DSCR/CoC'],
        disqualifiers: dq,
      }),
    );
  }

  // -------------------------- LEASE_OPTION (reserved) --------------------------
  candidates.push(
    entry(STRATEGIES.LEASE_OPTION, {
      qualification_status: Q.DISQUALIFIED,
      viability: 0,
      confidence: 0,
      failed_gates: ['not_implemented'],
      reasons: ['reserved_for_later_implementation'],
      disqualifiers: ['not_implemented'],
    }),
  );

  const ranked = [...candidates].sort((a, b) => b.composite - a.composite);

  // Primary selection (class-first, never DATA_REQUIRED/DISQUALIFIED).
  let primary = STRATEGIES.NO_OFFER;
  let backup = null;
  if (globalExecutable) {
    const underwritten = ranked.filter((c) => c.qualification_status === Q.EXECUTABLE || c.qualification_status === Q.UNDERWRITTEN_SHADOW);
    const provisional = ranked.filter((c) => c.qualification_status === Q.PROVISIONAL_SCENARIO);
    const pool = underwritten.length ? underwritten : provisional;
    primary = pool[0]?.strategy ?? STRATEGIES.NO_OFFER;
    const eligible = ranked.filter((c) => c.ranking_eligible && c.strategy !== primary);
    backup = eligible[0]?.strategy ?? null;
  } else {
    primary = STRATEGIES.NO_OFFER;
    const prov = ranked.find((c) => c.qualification_status === Q.PROVISIONAL_SCENARIO);
    backup = prov?.strategy ?? null; // scenario-only, for analysis
  }

  // display_priority: 1-based position among ranked eligible
  ranked.forEach((c, i) => {
    c.display_priority = i + 1;
  });

  return {
    ranked,
    primary_strategy: primary,
    backup_strategy: backup,
    no_offer_reason: globalExecutable ? null : `non_executable_state:${executionState}`,
  };
}
