// ─── stage3-asking-price-engine.js ─────────────────────────────────────────
// Stage 3 — Asking Price Engine (DETERMINISTIC, NO AI).
//
// Stage 2 captures that a seller gave a price; Stage 3 EVALUATES that price
// against underwriting and decides where the deal goes. It is a pure decision
// engine: it takes a normalized seller asking price (handed over from Stage 2,
// or extracted from the inbound text) plus the underwriting numbers, runs the
// acquisition decision, classifies the offer gap into a band, and routes to the
// correct next stage / inbox bucket / template / acquisition action.
//
// Design rules (identical posture to the Stage 2 engine — nothing is wired into
// production, no DB writes happen here):
//   1. Everything is heuristic + table driven. No AI.
//   2. Stages are jump-capable (S3 → S6 / S5 / S4) but never regress.
//   3. Price decisions are never auto-sent — they default to REVIEW so a human
//      verifies signers/email before any contract is generated.
//   4. The engine BUILDS canonical lifecycle events; persistence/fan-out is the
//      caller's job.
//
// Standalone: this module is not imported by the live inbound path.

import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { SELLER_FLOW_SAFETY_TIERS } from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { CONVERSATION_STAGES } from "@/lib/domain/communications-engine/state-machine.js";
import {
  ACQUISITION_LIFECYCLE_EVENTS as EV,
  buildLifecycleEvent,
} from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";
import { extractAskingPrice } from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";

const T = SELLER_FLOW_SAFETY_TIERS;
const S = SELLER_FLOW_STAGES;

// ══════════════════════════════════════════════════════════════════════════
// OFFER BANDS
// ══════════════════════════════════════════════════════════════════════════

export const STAGE3_OFFER_BANDS = Object.freeze({
  AUTO_ACCEPT: "auto_accept",     // ask <= recommended cash offer
  CLOSE_RANGE: "close_range",     // ask within max allowable offer
  NEGOTIABLE: "negotiable",       // ask modestly above MAO
  WIDE_GAP: "wide_gap",           // ask well above MAO (creative territory)
  VERY_WIDE_GAP: "very_wide_gap", // ask far above MAO (nurture)
  UNKNOWN: "unknown",             // no underwriting available
});

// Gap thresholds, expressed as multiples of the max allowable offer (MAO).
const NEGOTIABLE_CEILING_FACTOR = 1.15; // ask <= MAO * 1.15  → negotiable
const WIDE_GAP_CEILING_FACTOR = 1.40;   // ask <= MAO * 1.40  → wide_gap, else very_wide_gap

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════════════
// ACQUISITION DECISION
// ══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a seller asking price against underwriting.
 *
 * @param {number} seller_asking_price
 * @param {object} underwriting - { recommended_cash_offer, max_allowable_offer | maximum_allowable_offer, contract_ceiling, repair_estimate, lowest_relevant_comp }
 * @returns {object} metrics + offer_band + recommended_strategy
 */
export function evaluateAskingPrice(seller_asking_price, underwriting = {}) {
  const ask = numberOrNull(seller_asking_price);
  const recommended_cash_offer = numberOrNull(underwriting.recommended_cash_offer);
  // Accept either max_allowable_offer or maximum_allowable_offer for ergonomics.
  const max_allowable_offer =
    numberOrNull(underwriting.max_allowable_offer) ??
    numberOrNull(underwriting.maximum_allowable_offer) ??
    recommended_cash_offer;
  const contract_ceiling = numberOrNull(underwriting.contract_ceiling) ?? max_allowable_offer;
  const repair_estimate = numberOrNull(underwriting.repair_estimate);
  const lowest_relevant_comp = numberOrNull(underwriting.lowest_relevant_comp);

  const has_underwriting = recommended_cash_offer !== null && ask !== null && ask > 0;

  let offer_gap_amount = null;
  let offer_gap_pct = null;
  let offer_to_ask_ratio = null;
  let ask_to_offer_ratio = null;

  if (has_underwriting) {
    offer_gap_amount = ask - recommended_cash_offer;
    offer_gap_pct = round2((offer_gap_amount / ask) * 100);
    offer_to_ask_ratio = round2(recommended_cash_offer / ask);
    ask_to_offer_ratio =
      recommended_cash_offer > 0 ? round2(ask / recommended_cash_offer) : null;
  }

  let offer_band = STAGE3_OFFER_BANDS.UNKNOWN;
  if (has_underwriting) {
    if (ask <= recommended_cash_offer) {
      offer_band = STAGE3_OFFER_BANDS.AUTO_ACCEPT;
    } else if (ask <= max_allowable_offer) {
      offer_band = STAGE3_OFFER_BANDS.CLOSE_RANGE;
    } else if (ask <= max_allowable_offer * NEGOTIABLE_CEILING_FACTOR) {
      offer_band = STAGE3_OFFER_BANDS.NEGOTIABLE;
    } else if (ask <= max_allowable_offer * WIDE_GAP_CEILING_FACTOR) {
      offer_band = STAGE3_OFFER_BANDS.WIDE_GAP;
    } else {
      offer_band = STAGE3_OFFER_BANDS.VERY_WIDE_GAP;
    }
  }

  const recommended_strategy = STRATEGY_BY_BAND[offer_band];

  return {
    has_underwriting,
    seller_asking_price: ask,
    recommended_cash_offer,
    max_allowable_offer,
    contract_ceiling,
    repair_estimate,
    lowest_relevant_comp,
    offer_gap_amount,
    offer_gap_pct,
    offer_to_ask_ratio,
    ask_to_offer_ratio,
    offer_band,
    recommended_strategy,
  };
}

const STRATEGY_BY_BAND = Object.freeze({
  [STAGE3_OFFER_BANDS.AUTO_ACCEPT]: "accept_and_contract",
  [STAGE3_OFFER_BANDS.CLOSE_RANGE]: "negotiate_within_buy_box",
  [STAGE3_OFFER_BANDS.NEGOTIABLE]: "justify_with_condition",
  [STAGE3_OFFER_BANDS.WIDE_GAP]: "creative_or_condition",
  [STAGE3_OFFER_BANDS.VERY_WIDE_GAP]: "nurture_drip",
  [STAGE3_OFFER_BANDS.UNKNOWN]: "capture_price_human_review",
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTING BY BAND
// ══════════════════════════════════════════════════════════════════════════

function routeForBand(band, { creative_allowed = false } = {}) {
  switch (band) {
    case STAGE3_OFFER_BANDS.AUTO_ACCEPT:
      // Ask at/below our cash number → move to Seller Contract (S6).
      return {
        stage_code: "S6",
        next_stage: S.CLOSE_HANDOFF,
        brain_stage: CONVERSATION_STAGES.VERBAL_ACCEPTANCE_LOCK,
        status: "asks_contract",
        template_use_case: "asks_contract",
        inbox_bucket: "priority",
        acquisition_action: "verify_signers_and_generate_contract",
        route: "s6_contract",
        follow_up_policy: null,
        event_type: EV.ADVANCED_TO_SELLER_CONTRACT,
      };
    case STAGE3_OFFER_BANDS.CLOSE_RANGE:
      // Ask within MAO → negotiate to land near our target (S5).
      return {
        stage_code: "S5",
        next_stage: S.NARROW_RANGE,
        brain_stage: CONVERSATION_STAGES.NEGOTIATION,
        status: "negotiating",
        template_use_case: "narrow_range",
        inbox_bucket: "priority",
        acquisition_action: "negotiate_within_buy_box",
        route: "s5_negotiation",
        follow_up_policy: null,
        event_type: EV.OFFER_NEGOTIATION_OPENED,
      };
    case STAGE3_OFFER_BANDS.NEGOTIABLE:
      // Modestly above MAO → gather condition to justify a lower number (S4).
      return {
        stage_code: "S4",
        next_stage: S.PRICE_HIGH_CONDITION_PROBE,
        brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
        status: "justify_with_condition",
        template_use_case: "price_high_condition_probe",
        inbox_bucket: "priority",
        acquisition_action: "gather_condition_to_justify",
        route: "s4_condition",
        follow_up_policy: null,
        event_type: EV.CONDITION_PROBE_REQUESTED,
      };
    case STAGE3_OFFER_BANDS.WIDE_GAP:
      // Well above cash range → creative finance if allowed, else condition probe.
      if (creative_allowed) {
        return {
          stage_code: "S5",
          next_stage: S.CREATIVE_PROBE,
          brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING,
          status: "creative_finance_probe",
          template_use_case: "creative_probe",
          inbox_bucket: "needs_review",
          acquisition_action: "propose_creative_finance",
          route: "creative_finance",
          follow_up_policy: null,
          event_type: EV.CREATIVE_FINANCE_PROPOSED,
        };
      }
      return {
        stage_code: "S4",
        next_stage: S.PRICE_HIGH_CONDITION_PROBE,
        brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
        status: "gather_condition",
        template_use_case: "price_high_condition_probe",
        inbox_bucket: "needs_review",
        acquisition_action: "gather_condition_then_reveal",
        route: "s4_condition",
        follow_up_policy: null,
        event_type: EV.CONDITION_PROBE_REQUESTED,
      };
    case STAGE3_OFFER_BANDS.VERY_WIDE_GAP:
      // Far above range → park in a nurture drip (deal stays alive, not a fit now).
      return {
        stage_code: "S3F",
        next_stage: S.ASKING_PRICE_FOLLOW_UP,
        brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
        status: "nurture",
        template_use_case: "asking_price_follow_up",
        inbox_bucket: "follow_up",
        acquisition_action: "enter_nurture_drip",
        route: "nurture",
        follow_up_policy: { schedule: true, step: "nurture", default_delay_days: 60 },
        event_type: EV.DEAL_NURTURE_TRIGGERED,
      };
    case STAGE3_OFFER_BANDS.UNKNOWN:
    default:
      // No underwriting → capture and route to human review (never blind-route).
      return {
        stage_code: "S3",
        next_stage: S.ASKING_PRICE,
        brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
        status: "price_captured_review",
        template_use_case: "seller_asking_price",
        inbox_bucket: "needs_review",
        acquisition_action: "run_underwriting",
        route: "human_review",
        follow_up_policy: null,
        event_type: null,
      };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a Stage 3 asking price and produce a deterministic routing decision.
 *
 * @param {object} params
 * @param {number} [params.seller_asking_price] - Normalized price handed over from Stage 2.
 * @param {string} [params.message] - Optional raw text (used only to recover the
 *        price if seller_asking_price was not supplied).
 * @param {object} [params.underwriting] - Acquisition numbers (see evaluateAskingPrice).
 * @param {object} [params.context]
 * @param {boolean} [params.context.creative_allowed] - Creative finance eligible for this deal.
 * @param {object}  [params.context.entities] - { property_id, master_owner_id, prospect_id, contact_point_id }
 * @param {string|number} [params.context.source_message_id]
 * @param {string|Date}   [params.context.now] - Injectable timestamp.
 * @returns {object} decision
 */
export function classifyStage3AskingPrice({
  seller_asking_price = null,
  message = "",
  underwriting = {},
  context = {},
} = {}) {
  const entities = context?.entities || {};
  const source_message_id = context?.source_message_id ?? null;
  const now = context?.now ?? null;
  const creative_allowed = Boolean(context?.creative_allowed);

  // 1. Accept the asking price from Stage 2; fall back to extracting from text.
  let ask = numberOrNull(seller_asking_price);
  if (ask === null) {
    const extracted = extractAskingPrice(message);
    ask = extracted ? extracted.value : null;
  }

  // 2. Run the acquisition decision.
  const decision = evaluateAskingPrice(ask, underwriting);

  // 3. Route by band.
  const route = routeForBand(decision.offer_band, { creative_allowed });

  // 4. Build canonical events: always emit ASKING_PRICE_EVALUATED, plus the
  //    band-specific routing event when one applies.
  const events = [
    buildLifecycleEvent(EV.ASKING_PRICE_EVALUATED, {
      entities,
      stage_code: route.stage_code,
      status: route.status,
      source_message_id,
      occurred_at: now,
      data: { ...decision },
    }),
  ];
  if (route.event_type) {
    events.push(
      buildLifecycleEvent(route.event_type, {
        entities,
        stage_code: route.stage_code,
        status: route.status,
        source_message_id,
        occurred_at: now,
        data: {
          offer_band: decision.offer_band,
          seller_asking_price: decision.seller_asking_price,
          offer_gap_amount: decision.offer_gap_amount,
          offer_gap_pct: decision.offer_gap_pct,
        },
      })
    );
  }

  return buildDecision({ decision, route, events });
}

// ══════════════════════════════════════════════════════════════════════════
// DECISION SHAPE
// ══════════════════════════════════════════════════════════════════════════

function buildDecision({ decision, route, events }) {
  // Price decisions are never auto-sent — a human verifies before contract.
  const safety_tier = T.REVIEW;

  return {
    engine: "stage3_asking_price",
    offer_band: decision.offer_band,

    // Canonical stage routing
    stage_code: route.stage_code,
    next_stage: route.next_stage,
    brain_stage: route.brain_stage,
    status: route.status,
    route: route.route,

    // Inbox + templating + follow-up
    inbox_bucket: route.inbox_bucket,
    template_use_case: route.template_use_case,
    follow_up_policy: route.follow_up_policy ?? null,

    // Acquisition decision math (requirement #3 keys)
    acquisition_action: route.acquisition_action,
    seller_asking_price: decision.seller_asking_price,
    recommended_cash_offer: decision.recommended_cash_offer,
    max_allowable_offer: decision.max_allowable_offer,
    offer_gap_amount: decision.offer_gap_amount,
    offer_gap_pct: decision.offer_gap_pct,
    offer_to_ask_ratio: decision.offer_to_ask_ratio,
    ask_to_offer_ratio: decision.ask_to_offer_ratio,
    recommended_strategy: decision.recommended_strategy,
    acquisition: decision,

    // Safety flags (advisory)
    safety_tier,
    auto_send_eligible: false,
    should_queue_reply: Boolean(route.template_use_case),
    should_mark_human_review: true,

    // Canonical lifecycle events
    events,
  };
}

export default classifyStage3AskingPrice;
