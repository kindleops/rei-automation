// ─── negotiation-strategy-router.js ─────────────────────────────────────────
// The single deterministic strategy router for S5 negotiation (spec §7).
// Exactly one strategy per turn, resolved from: negotiation zone (spec §6),
// persisted negotiation state (spec §2), underwriting sufficiency (spec §4),
// ADE alternate-strategy scores + seller signals (spec §8), and the bounded
// concession ladder (spec §13).
//
// Invariants:
//   • every monetary amount returned here is derived from persisted ADE
//     authority and never exceeds the ceiling nor the seller's own ask
//   • a strategy with monetary=null authorizes NO monetary content in the
//     outbound template (renderer fails closed on monetary tokens)
//   • alternate strategies require positive eligibility signals — never
//     proposed merely because a direct-purchase offer was rejected
//   • the router never regresses lifecycle stage; stage outcomes are hints for
//     the canonical resolver, which owns stage monotonicity
//
// Pure module — no I/O, no AI.

import {
  NEGOTIATION_ZONES,
  resolveNegotiationPolicy,
  evaluateConcession,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import { CONTRACT_READINESS } from "@/lib/domain/seller-flow/negotiation-state.js";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

export const NEGOTIATION_STRATEGIES = Object.freeze({
  DIRECT_PURCHASE: "direct_purchase",
  EXPECTATION_RESET: "expectation_reset",
  CONDITION_DISCOVERY: "condition_discovery",
  OCCUPANCY_DISCOVERY: "occupancy_discovery",
  FLEXIBILITY_PROBE: "flexibility_probe",
  BEST_PRICE_REQUEST: "best_price_request",
  COMP_ANCHOR: "comp_anchor",
  REPAIR_ANCHOR: "repair_anchor",
  INITIAL_OFFER: "initial_offer",
  CONDITIONAL_OFFER: "conditional_offer",
  COUNTER_OFFER: "counter_offer",
  FINAL_AUTHORIZED_OFFER: "final_authorized_offer",
  ACCEPT_SELLER_TERMS: "accept_seller_terms",
  NOVATION_PROBE: "novation_probe",
  SELLER_FINANCE_PROBE: "seller_finance_probe",
  STRUCTURED_TERMS_REVIEW: "structured_terms_review",
  FUTURE_NURTURE: "future_nurture",
  HUMAN_REVIEW: "human_review",
});

/**
 * Static strategy contract (spec §7): required facts, prohibited conditions,
 * allowed template use cases, whether monetary content is permitted, next
 * action, follow-up policy and stage outcome hint.
 */
export const STRATEGY_CONTRACTS = Object.freeze({
  [NEGOTIATION_STRATEGIES.DIRECT_PURCHASE]: {
    template_use_cases: ["offer_reveal_cash", "initial_offer"],
    monetary_allowed: true,
    required_facts: ["asking_price", "ade_authority"],
    prohibited: ["terms_accepted", "opt_out"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.EXPECTATION_RESET]: {
    template_use_cases: ["expectation_reset", "justify_price"],
    monetary_allowed: false,
    required_facts: ["asking_price"],
    prohibited: ["terms_accepted"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.CONDITION_DISCOVERY]: {
    template_use_cases: ["condition_probe", "repair_clarification", "price_high_condition_probe"],
    monetary_allowed: false,
    required_facts: [],
    prohibited: ["seller_refused_condition_twice"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "discovery",
  },
  [NEGOTIATION_STRATEGIES.OCCUPANCY_DISCOVERY]: {
    template_use_cases: ["occupancy_probe"],
    monetary_allowed: false,
    required_facts: [],
    prohibited: [],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "discovery",
  },
  [NEGOTIATION_STRATEGIES.FLEXIBILITY_PROBE]: {
    template_use_cases: ["flexibility_probe", "narrow_range"],
    monetary_allowed: false,
    required_facts: ["asking_price"],
    prohibited: ["terms_accepted", "seller_firm_repeated"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.BEST_PRICE_REQUEST]: {
    template_use_cases: ["best_price_request"],
    monetary_allowed: false,
    required_facts: ["asking_price"],
    prohibited: ["terms_accepted"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.COMP_ANCHOR]: {
    template_use_cases: ["comp_anchor", "justify_price"],
    monetary_allowed: true, // the anchor statement, not an offer amount
    required_facts: ["credible_comp_anchor"],
    prohibited: ["terms_accepted", "no_credible_anchor"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.REPAIR_ANCHOR]: {
    template_use_cases: ["repair_anchor", "justify_price"],
    monetary_allowed: true,
    required_facts: ["repair_estimate"],
    prohibited: ["terms_accepted"],
    next_action: "send_message_now",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.INITIAL_OFFER]: {
    template_use_cases: ["initial_offer", "offer_reveal_cash"],
    monetary_allowed: true,
    required_facts: ["ade_authority", "underwriting_sufficient"],
    prohibited: ["terms_accepted", "offer_already_made"],
    next_action: "generate_offer",
    follow_up: null,
    stage_outcome: "offer_made",
  },
  [NEGOTIATION_STRATEGIES.CONDITIONAL_OFFER]: {
    template_use_cases: ["conditional_offer"],
    monetary_allowed: true,
    required_facts: ["ade_authority"],
    prohibited: ["terms_accepted"],
    next_action: "generate_offer",
    follow_up: null,
    stage_outcome: "offer_made",
  },
  [NEGOTIATION_STRATEGIES.COUNTER_OFFER]: {
    template_use_cases: ["counter_offer", "narrow_range"],
    monetary_allowed: true,
    required_facts: ["ade_authority", "concession_authorized"],
    prohibited: ["terms_accepted", "ceiling_reached"],
    next_action: "generate_offer",
    follow_up: null,
    stage_outcome: "negotiating",
  },
  [NEGOTIATION_STRATEGIES.FINAL_AUTHORIZED_OFFER]: {
    template_use_cases: ["final_offer"],
    monetary_allowed: true,
    required_facts: ["ade_authority"],
    prohibited: ["terms_accepted", "final_offer_already_made"],
    next_action: "generate_offer",
    follow_up: { create: true, days: 7 },
    stage_outcome: "final_offer",
  },
  [NEGOTIATION_STRATEGIES.ACCEPT_SELLER_TERMS]: {
    template_use_cases: ["accept_terms", "contract_information_request"],
    monetary_allowed: true,
    required_facts: ["ask_within_authority"],
    prohibited: [],
    next_action: "collect_contract_facts",
    follow_up: null,
    stage_outcome: "terms_accepted",
  },
  [NEGOTIATION_STRATEGIES.NOVATION_PROBE]: {
    template_use_cases: ["novation_probe"],
    monetary_allowed: false,
    required_facts: ["novation_eligibility"],
    prohibited: ["terms_accepted", "title_blocked"],
    next_action: "send_message_now",
    follow_up: { create: true, days: 5 },
    stage_outcome: "alternate_strategy",
  },
  [NEGOTIATION_STRATEGIES.SELLER_FINANCE_PROBE]: {
    template_use_cases: ["seller_finance_probe", "creative_probe"],
    monetary_allowed: false,
    required_facts: ["seller_finance_eligibility"],
    prohibited: ["terms_accepted"],
    next_action: "send_message_now",
    follow_up: { create: true, days: 5 },
    stage_outcome: "alternate_strategy",
  },
  [NEGOTIATION_STRATEGIES.STRUCTURED_TERMS_REVIEW]: {
    template_use_cases: [],
    monetary_allowed: false,
    required_facts: ["structured_terms_signal"],
    prohibited: [],
    next_action: "human_review",
    follow_up: null,
    stage_outcome: "review",
  },
  [NEGOTIATION_STRATEGIES.FUTURE_NURTURE]: {
    template_use_cases: ["future_nurture", "asking_price_follow_up"],
    monetary_allowed: false,
    required_facts: [],
    prohibited: ["opt_out"],
    next_action: "schedule_follow_up",
    follow_up: { create: true, days: 45 },
    stage_outcome: "nurture",
  },
  [NEGOTIATION_STRATEGIES.HUMAN_REVIEW]: {
    template_use_cases: [],
    monetary_allowed: false,
    required_facts: [],
    prohibited: [],
    next_action: "human_review",
    follow_up: null,
    stage_outcome: "review",
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ALTERNATE-STRATEGY ELIGIBILITY (spec §8) — positive signals required
// ═══════════════════════════════════════════════════════════════════════════

const ALT_SCORE_THRESHOLD = 60;
const ALT_SCORE_STRONG = 75;

export function evaluateNovationEligibility({ state = {}, flags = {}, facts = {} } = {}) {
  const alt = state.alternate_strategy_eligibility || {};
  const score = num(alt.novation_score);
  const arv = num(state.arv);
  const ask = num(state.current_asking_price);
  const repairs = num(state.repair_estimate);

  const reasons = [];
  const sellerSignal = Boolean(flags.novation);
  const scoreSignal = score !== null && score >= ALT_SCORE_THRESHOLD;
  if (!sellerSignal && !(score !== null && score >= ALT_SCORE_STRONG)) {
    reasons.push("no_positive_novation_signal");
  }
  if (!scoreSignal && !sellerSignal) reasons.push("novation_score_below_threshold");
  // Retail spread must remain: seller ask below (or near) retail value.
  if (arv !== null && ask !== null && ask > arv * 0.97) reasons.push("no_retail_spread_remaining");
  // Marketable or repairable.
  if (arv !== null && repairs !== null && repairs > arv * 0.35) reasons.push("repair_burden_exceeds_novation_policy");
  if (facts.title_constraint || facts.probate_constraint) reasons.push("title_not_workable");
  if (facts.urgent_timeline === true) reasons.push("seller_timing_inflexible");

  return { eligible: reasons.length === 0, reasons, score, seller_signal: sellerSignal };
}

export function evaluateSellerFinanceEligibility({ state = {}, flags = {}, facts = {} } = {}) {
  const alt = state.alternate_strategy_eligibility || {};
  const score = num(alt.seller_finance_score);
  const ask = num(state.current_asking_price);
  const payoff = num(facts.mortgage_payoff);

  const reasons = [];
  const sellerSignal = Boolean(flags.seller_finance || flags.creative_generic);
  if (!sellerSignal && !(score !== null && score >= ALT_SCORE_STRONG)) {
    reasons.push("no_positive_seller_finance_signal");
  }
  if (score !== null && score < ALT_SCORE_THRESHOLD && !sellerSignal) {
    reasons.push("seller_finance_score_below_threshold");
  }
  // Meaningful equity: debt must be low relative to the ask when known.
  if (payoff !== null && ask !== null && payoff > ask * 0.8) reasons.push("insufficient_equity");
  if (facts.needs_cash_now === true) reasons.push("seller_cash_urgent");

  return { eligible: reasons.length === 0, reasons, score, seller_signal: sellerSignal };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════

function decision(strategy, {
  reason_code,
  monetary = null,
  template_use_case = null,
  review_reason = null,
  trace = [],
  next_action_override = null,
  events = [],
}) {
  const contract = STRATEGY_CONTRACTS[strategy];
  // Fail closed: monetary content only when the contract allows it AND an
  // authorized amount/statement was actually resolved.
  const safeMonetary = contract.monetary_allowed ? monetary : null;
  return {
    strategy,
    reason_code,
    eligible: true,
    required_facts: contract.required_facts,
    prohibited_conditions: contract.prohibited,
    allowed_template_use_cases: contract.template_use_cases,
    template_use_case: template_use_case || contract.template_use_cases[0] || null,
    monetary: safeMonetary,
    next_action: next_action_override || contract.next_action,
    follow_up: contract.follow_up,
    stage_outcome: contract.stage_outcome,
    review_required: strategy === NEGOTIATION_STRATEGIES.HUMAN_REVIEW || strategy === NEGOTIATION_STRATEGIES.STRUCTURED_TERMS_REVIEW,
    review_reason,
    eligibility_trace: trace,
    events,
  };
}

/**
 * Route exactly one deterministic negotiation strategy for the current turn.
 *
 * @param {object} params
 * @param {object} params.zone - classifyNegotiationZone output
 * @param {object} params.state - normalized negotiation state (spec §2)
 * @param {object} params.sufficiency - evaluateUnderwritingSufficiency output
 * @param {object} params.flags - stage-5 engine phrase flags (firm/flex/accept/
 *        reject/counter_verb/needs_time/signoff/subject_to/seller_finance/
 *        novation/creative_generic/best_final/contract/proof)
 * @param {object} params.facts - merged seller facts
 * @param {object} params.policy - resolveNegotiationPolicy output
 * @param {object} params.comp_anchor - comp-anchor policy result ({eligible,anchor})
 * @param {object} params.engine_decision - stage-5 engine decision (outcome, counters)
 * @param {number} params.property_value - reference value for high-value review routing
 */
export function routeNegotiationStrategy({
  zone = null,
  state = {},
  sufficiency = null,
  flags = {},
  facts = {},
  policy = null,
  comp_anchor = null,
  engine_decision = null,
  property_value = null,
  seller_moved_amount = 0,
  new_material_fact = false,
} = {}) {
  const p = policy || resolveNegotiationPolicy({});
  const S = NEGOTIATION_STRATEGIES;
  const trace = [];
  const zoneKey = zone?.zone || NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE;

  const ask = num(state.current_asking_price);
  const ceiling = num(state.authorized_offer_ceiling);
  const recommended = num(state.recommended_offer);
  const offersMade = arr(state.offers_made);
  const latestOffer = num(state.latest_offer);
  const finalOfferMade = offersMade.some((o) => o.strategy === S.FINAL_AUTHORIZED_OFFER);
  const priorStrategies = arr(state.prior_strategies).map((s) => s.strategy);
  const usedStrategy = (s) => state.current_strategy === s || priorStrategies.includes(s);

  const note = (strategy, eligible, reason) => trace.push({ strategy, eligible, reason });

  // ── 0. Terms already locked → contract-fact collection only ─────────────
  if (state.terms_accepted === true) {
    const ready = state.contract_readiness === CONTRACT_READINESS.READY;
    return decision(S.ACCEPT_SELLER_TERMS, {
      reason_code: ready ? "TERMS_LOCKED_CONTRACT_READY" : "TERMS_LOCKED_COLLECTING_CONTRACT_FACTS",
      template_use_case: ready ? "accept_terms" : "contract_information_request",
      monetary: { amount: num(state.accepted_price), floor: num(state.accepted_price), ceiling: num(state.accepted_price) },
      next_action_override: ready ? "generate_contract" : "collect_contract_facts",
      trace,
      events: ready ? ["contract_ready"] : ["contract_information_requested"],
    });
  }

  // ── 1. Seller accepted our offer ─────────────────────────────────────────
  if (flags.accept && !flags.counter_verb && latestOffer !== null) {
    return decision(S.ACCEPT_SELLER_TERMS, {
      reason_code: "SELLER_ACCEPTED_OUR_OFFER",
      template_use_case: "accept_terms",
      monetary: { amount: latestOffer, floor: latestOffer, ceiling: latestOffer },
      trace,
      events: ["terms_accepted"],
    });
  }

  // ── 2. Structured-terms signal (subject-to) always goes to review ────────
  if (flags.subject_to) {
    return decision(S.STRUCTURED_TERMS_REVIEW, {
      reason_code: "SUBJECT_TO_SIGNAL_REQUIRES_REVIEW",
      review_reason: "structured_terms_signal",
      trace,
      events: ["review_required"],
    });
  }

  // ── 3. Within authority → conditionally accept (spec §6) ─────────────────
  if (zoneKey === NEGOTIATION_ZONES.WITHIN_AUTHORITY) {
    // Optional market policy: one soft concession probe. Default OFF — protect
    // the favorable deal rather than squeezing.
    if (
      p.single_concession_probe_enabled === true &&
      state.negotiation_round === 0 &&
      !usedStrategy(S.FLEXIBILITY_PROBE) &&
      !flags.firm
    ) {
      note(S.ACCEPT_SELLER_TERMS, true, "deferred_for_single_probe_policy");
      return decision(S.FLEXIBILITY_PROBE, {
        reason_code: "SINGLE_CONCESSION_PROBE_POLICY",
        trace,
        events: ["strategy_selected"],
      });
    }
    const acceptedAmount = ceiling !== null && ask !== null ? Math.min(ask, ceiling) : ask;
    return decision(S.ACCEPT_SELLER_TERMS, {
      reason_code: "ASK_WITHIN_AUTHORITY_CONDITIONAL_ACCEPT",
      template_use_case: "accept_terms",
      // Never more than the seller requested.
      monetary: { amount: acceptedAmount, floor: acceptedAmount, ceiling: acceptedAmount },
      trace,
      events: ["terms_accepted"],
    });
  }

  // ── 4. Insufficient confidence → discover facts, never fabricate ─────────
  if (zoneKey === NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE) {
    if (zone?.reason_code === "ASK_EXTRACTION_LOW_CONFIDENCE") {
      return decision(S.BEST_PRICE_REQUEST, {
        reason_code: "PRICE_UNCLEAR_ASK_FOR_CLARIFICATION",
        template_use_case: "best_price_request",
        trace,
        events: ["strategy_selected"],
      });
    }
    const nextDiscovery = sufficiency?.next_discovery;
    if (nextDiscovery === "occupancy_status" && !flags.refuses_condition) {
      return decision(S.OCCUPANCY_DISCOVERY, { reason_code: "MISSING_OCCUPANCY_FACT", trace, events: ["strategy_selected"] });
    }
    if (nextDiscovery && nextDiscovery !== "commercial_review" && !flags.refuses_condition) {
      return decision(S.CONDITION_DISCOVERY, { reason_code: `MISSING_FACT_${String(nextDiscovery).toUpperCase()}`, trace, events: ["strategy_selected"] });
    }
    return decision(S.HUMAN_REVIEW, {
      reason_code: "INSUFFICIENT_VALUATION_CONFIDENCE",
      review_reason: zone?.reason_code || "insufficient_confidence",
      trace,
      events: ["review_required"],
    });
  }

  // High-value assets with big gaps get a human, not a drip (spec §6/§20).
  const referenceValue = num(property_value) ?? num(state.arv) ?? ask;
  const highValue = referenceValue !== null && referenceValue >= p.human_review_value_threshold;

  const concession = evaluateConcession({
    negotiation_state: state,
    policy: p,
    new_material_fact,
    seller_moved_amount:
      num(seller_moved_amount) ??
      (arr(state.seller_concessions).length
        ? num(state.seller_concessions[state.seller_concessions.length - 1]?.amount) ?? 0
        : 0),
    improved_terms: false,
  });

  // ── 5. Ceiling exhausted → final offer once, then alternates ─────────────
  const ceilingExhausted =
    (latestOffer !== null && ceiling !== null && latestOffer >= ceiling) ||
    concession.reason_code === "MAX_MONETARY_TURNS_REACHED";
  if (ceilingExhausted || zoneKey === NEGOTIATION_ZONES.LARGE_GAP) {
    if (!finalOfferMade && ceilingExhausted && ask !== null) {
      return decision(S.FINAL_AUTHORIZED_OFFER, {
        reason_code: "CEILING_REACHED_COMMUNICATE_FINALITY",
        monetary: { amount: ceiling, floor: num(state.authorized_offer_floor), ceiling },
        trace,
        events: ["final_offer_reached"],
      });
    }

    // Alternates require positive signals (spec §8).
    const novation = evaluateNovationEligibility({ state, flags, facts });
    note(S.NOVATION_PROBE, novation.eligible, novation.reasons.join(",") || "eligible");
    if (novation.eligible && !usedStrategy(S.NOVATION_PROBE)) {
      return decision(S.NOVATION_PROBE, {
        reason_code: novation.seller_signal ? "NOVATION_SELLER_SIGNAL" : "NOVATION_SCORE_ELIGIBLE",
        trace,
        events: ["alternate_strategy_selected"],
      });
    }
    const sellerFinance = evaluateSellerFinanceEligibility({ state, flags, facts });
    note(S.SELLER_FINANCE_PROBE, sellerFinance.eligible, sellerFinance.reasons.join(",") || "eligible");
    if (sellerFinance.eligible && !usedStrategy(S.SELLER_FINANCE_PROBE)) {
      return decision(S.SELLER_FINANCE_PROBE, {
        reason_code: sellerFinance.seller_signal ? "SELLER_FINANCE_SELLER_SIGNAL" : "SELLER_FINANCE_SCORE_ELIGIBLE",
        trace,
        events: ["alternate_strategy_selected"],
      });
    }

    if (highValue) {
      return decision(S.HUMAN_REVIEW, {
        reason_code: "HIGH_VALUE_LARGE_GAP_REVIEW",
        review_reason: "high_value_asset_large_gap",
        trace,
        events: ["review_required"],
      });
    }

    // One expectation reset before parking the lead (large gap only).
    if (zoneKey === NEGOTIATION_ZONES.LARGE_GAP && !usedStrategy(S.EXPECTATION_RESET) && !ceilingExhausted) {
      return decision(S.EXPECTATION_RESET, {
        reason_code: "LARGE_GAP_EXPECTATION_RESET",
        trace,
        events: ["strategy_selected"],
      });
    }

    return decision(S.FUTURE_NURTURE, {
      reason_code: ceilingExhausted ? "CEILING_EXHAUSTED_NURTURE" : "LARGE_GAP_NURTURE",
      trace,
      events: ["strategy_selected"],
    });
  }

  // ── 6. Discovery before money in near/moderate gaps ──────────────────────
  if (sufficiency && sufficiency.sufficient !== true && !flags.refuses_condition) {
    if (sufficiency.next_discovery === "occupancy_status") {
      return decision(S.OCCUPANCY_DISCOVERY, { reason_code: "GAP_DISCOVERY_OCCUPANCY", trace, events: ["strategy_selected"] });
    }
    if (sufficiency.next_discovery && sufficiency.next_discovery !== "commercial_review") {
      return decision(S.CONDITION_DISCOVERY, { reason_code: "GAP_DISCOVERY_CONDITION", trace, events: ["strategy_selected"] });
    }
    if (sufficiency.next_discovery === "commercial_review") {
      return decision(S.HUMAN_REVIEW, {
        reason_code: "COMMERCIAL_UNDERWRITING_REVIEW",
        review_reason: "commercial_asset_class",
        trace,
        events: ["review_required"],
      });
    }
  }

  // ── 7. Seller counter → accept if within authority, else ladder ──────────
  const counterAmount = num(engine_decision?.counter_offer);
  if (counterAmount !== null && ceiling !== null && counterAmount <= ceiling) {
    return decision(S.ACCEPT_SELLER_TERMS, {
      reason_code: "COUNTER_WITHIN_AUTHORITY_ACCEPT",
      template_use_case: "accept_terms",
      monetary: { amount: Math.min(counterAmount, ceiling), floor: counterAmount, ceiling: counterAmount },
      trace,
      events: ["terms_accepted"],
    });
  }

  // ── 8. Near gap ladder (spec §6) ──────────────────────────────────────────
  if (zoneKey === NEGOTIATION_ZONES.NEAR_GAP) {
    if (offersMade.length === 0 && recommended !== null) {
      return decision(S.INITIAL_OFFER, {
        reason_code: "NEAR_GAP_INITIAL_OFFER",
        monetary: {
          amount: ask !== null ? Math.min(recommended, ask) : recommended,
          floor: num(state.authorized_offer_floor),
          ceiling,
        },
        trace,
        events: ["offer_authorized"],
      });
    }
    if (concession.allowed && concession.amount !== null) {
      return decision(S.COUNTER_OFFER, {
        reason_code: "NEAR_GAP_CONTROLLED_CONCESSION",
        monetary: { amount: concession.amount, floor: num(state.authorized_offer_floor), ceiling },
        trace,
        events: ["concession_authorized"],
      });
    }
    if (!usedStrategy(S.FLEXIBILITY_PROBE) && !flags.firm) {
      return decision(S.FLEXIBILITY_PROBE, { reason_code: "NEAR_GAP_FLEX_PROBE", trace, events: ["strategy_selected"] });
    }
    return decision(S.BEST_PRICE_REQUEST, { reason_code: "NEAR_GAP_BEST_PRICE", trace, events: ["strategy_selected"] });
  }

  // ── 9. Moderate gap ladder (spec §6) ─────────────────────────────────────
  if (comp_anchor?.eligible && !usedStrategy(S.COMP_ANCHOR)) {
    return decision(S.COMP_ANCHOR, {
      reason_code: "MODERATE_GAP_CREDIBLE_COMP_ANCHOR",
      monetary: { amount: null, floor: null, ceiling: null, anchor_statement: comp_anchor.authorized_statement || null },
      trace,
      events: ["comp_anchor_selected"],
    });
  }
  if (num(state.repair_estimate) !== null && !usedStrategy(S.REPAIR_ANCHOR) && (flags.challenge_repair || arr(state.repair_facts).length > 0)) {
    return decision(S.REPAIR_ANCHOR, {
      reason_code: "MODERATE_GAP_REPAIR_ANCHOR",
      monetary: { amount: null, floor: null, ceiling: null, repair_estimate: num(state.repair_estimate) },
      trace,
      events: ["strategy_selected"],
    });
  }
  if (offersMade.length === 0 && recommended !== null) {
    return decision(S.CONDITIONAL_OFFER, {
      reason_code: "MODERATE_GAP_ADE_AUTHORIZED_OFFER",
      monetary: {
        amount: ask !== null ? Math.min(recommended, ask) : recommended,
        floor: num(state.authorized_offer_floor),
        ceiling,
      },
      trace,
      events: ["offer_authorized"],
    });
  }
  if (concession.allowed && concession.amount !== null) {
    return decision(S.COUNTER_OFFER, {
      reason_code: "MODERATE_GAP_CONTROLLED_CONCESSION",
      monetary: { amount: concession.amount, floor: num(state.authorized_offer_floor), ceiling },
      trace,
      events: ["concession_authorized"],
    });
  }
  if (!usedStrategy(S.BEST_PRICE_REQUEST)) {
    return decision(S.BEST_PRICE_REQUEST, { reason_code: "MODERATE_GAP_BEST_PRICE", trace, events: ["strategy_selected"] });
  }
  if (!usedStrategy(S.EXPECTATION_RESET)) {
    return decision(S.EXPECTATION_RESET, { reason_code: "MODERATE_GAP_EXPECTATION_RESET", trace, events: ["strategy_selected"] });
  }
  return decision(S.FUTURE_NURTURE, { reason_code: "MODERATE_GAP_EXHAUSTED_NURTURE", trace, events: ["strategy_selected"] });
}

export default {
  NEGOTIATION_STRATEGIES,
  STRATEGY_CONTRACTS,
  routeNegotiationStrategy,
  evaluateNovationEligibility,
  evaluateSellerFinanceEligibility,
};
