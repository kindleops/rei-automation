// ─── negotiation-signal-shadow.js ───────────────────────────────────────────
// SHADOW EVALUATOR for the signal-based opening (negotiation-signal-opening.js).
//
// For every real S3+ conversation and every offer-ready property it computes
// the opening, the planned ladder, the walk-away and (when the seller has
// countered) the next ladder move, and shapes ONE row for the PROPOSED
// public.negotiation_shadow table (quote_type 'shadow_opening'). It never
// sends, never writes a quote, never changes a live price: `would_send` is
// always false, and the row is not a negotiation_quotes row, so it can never
// satisfy the Autopilot v2 "monetary sends need a quote row" gate.
//
// Pure. The read-only script scripts/ops/negotiation-signal-opening-shadow.mjs
// does the I/O and writes the report locally.

import {
  collectSignalInputs,
  computeSignalOpening,
  nextConcession,
  SIGNAL_OPENING_ENGINE_VERSION,
} from "./negotiation-signal-opening.js";
import { SIGNAL_OPENING_CONFIG_VERSION } from "./negotiation-signal-opening-config.js";

export const NEGOTIATION_SHADOW_TABLE = "negotiation_shadow";
export const SHADOW_QUOTE_TYPE = "shadow_opening";
export const SHADOW_SUBJECTS = Object.freeze({ CONVERSATION: "s3_plus_conversation", OFFER_READY: "offer_ready_property" });
// S3+ seller stages as persisted on inbox_thread_state.seller_stage.
export const S3_PLUS_STAGES = Object.freeze(["asking_price", "property_condition", "offer", "formal_contract", "negotiation", "contract"]);

/** Where the seller's latest position sits against the opening / walk-away. */
export function classifyAskPosition(ask, { opening = null, walk_away = null, floor = null } = {}) {
  if (ask == null) return "no_ask";
  if (floor != null && ask < floor) return "below_fair_floor_review";
  if (opening != null && ask <= opening) return "at_or_below_opening_accept_ask";
  if (walk_away != null && ask <= walk_away) return "within_ladder";
  return "above_walk_away";
}

export function evaluateShadowOpening({ property, owner = null, prospect = null, score, conversation = null, now, owner_overrides = null } = {}) {
  const inputs = collectSignalInputs({ property, owner, prospect, score, conversation, now, owner_overrides });
  const evaluation = computeSignalOpening(inputs, { owner_overrides, now });
  const positions = inputs.conversation.seller_positions;
  const latest_ask = positions.length ? positions[positions.length - 1].value : null;
  const next_move =
    evaluation.status === "ok" && positions.length
      ? nextConcession({ opening: evaluation.opening, walk_away: evaluation.walk_away, floor: evaluation.floor, our_offers: [evaluation.opening], seller_positions: positions })
      : null;
  return {
    inputs,
    evaluation,
    latest_ask,
    ask_position: classifyAskPosition(latest_ask, evaluation),
    next_move,
  };
}

/** Shape the PROPOSED negotiation_shadow row. Throws if the shadow contract would be violated. */
export function buildShadowRow({ subject_kind, thread_key = null, property_id, master_owner_id = null, seller_stage = null, offer_ready = null, offer_ready_reason = null, result, evaluated_at }) {
  const ev = result?.evaluation || {};
  if (!Object.values(SHADOW_SUBJECTS).includes(subject_kind)) throw new Error(`negotiation_shadow_invalid_subject:${subject_kind}`);
  if (!property_id) throw new Error("negotiation_shadow_missing_property");
  if (ev.status === "ok") {
    if (!(ev.opening > 0) || ev.opening > ev.mao || ev.opening > ev.walk_away) throw new Error("negotiation_shadow_opening_above_mao");
    if (ev.opening < ev.floor) throw new Error("negotiation_shadow_opening_below_floor");
  }
  return {
    shadow_key: `${SIGNAL_OPENING_CONFIG_VERSION}:${subject_kind}:${thread_key || property_id}:${String(evaluated_at).slice(0, 10)}`,
    quote_type: SHADOW_QUOTE_TYPE,
    subject_kind,
    thread_key,
    property_id: String(property_id),
    master_owner_id: master_owner_id ? String(master_owner_id) : null,
    seller_stage,
    // Offer-ready (offerReadiness.js) — a shadow opening on a non-ready score is diagnostic only.
    offer_ready,
    offer_ready_reason,
    status: ev.status || "hold",
    reason: ev.reason || null,
    opening: ev.opening ?? null,
    walk_away: ev.walk_away ?? null,
    max_offer_at_eval: ev.mao ?? null,
    recommended_offer_at_eval: ev.recommended_cash_offer ?? null,
    fair_floor: ev.floor ?? null,
    as_is_value: ev.as_is_value ?? null,
    spread: ev.spread ?? null,
    raw_spread: ev.raw_spread ?? null,
    latest_seller_ask: result?.latest_ask ?? null,
    ask_position: result?.ask_position ?? null,
    signals: ev.signals || [],
    ladder: ev.ladder || [],
    next_move: result?.next_move || null,
    state: ev.state ?? null,
    market: ev.market ?? null,
    asset_class: ev.asset_class ?? null,
    engine_version: SIGNAL_OPENING_ENGINE_VERSION,
    config_version: SIGNAL_OPENING_CONFIG_VERSION,
    score_snapshot_id: ev.authority?.score_snapshot_id ?? null,
    score_computed_at: ev.authority?.computed_at ?? null,
    would_send: false,
    evaluated_at,
  };
}

export default evaluateShadowOpening;
