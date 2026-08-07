import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  NEGOTIATION_ZONES,
  resolveNegotiationPolicy,
  classifyNegotiationZone,
  evaluateUnderwritingSufficiency,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";
import { resolveSellerResponseStrategy } from "@/lib/domain/seller-flow/resolve-seller-response-strategy.js";
import { buildPersonalizationContext } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { ACQUISITION_OBJECTIVES } from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { FACT_RESOLUTION } from "@/lib/domain/seller-flow/resolve-seller-conversation-state.js";

const POLICY = resolveNegotiationPolicy({ asset_class: "sfr", reference_value: 130000 });

// ADE V2 emits valuation_confidence on its NATIVE 0–100 scale — exactly what
// production feeds these gates (the historical fixtures used 0–1 and hid the
// scale collision).
const ADE_NATIVE = Object.freeze({
  recommended_cash_offer: 80000,
  minimum_acceptable_offer: 70000,
  investor_ceiling_mid: 90000,
  investor_ceiling_high: 95000,
  valuation_mid: 130000,
  valuation_confidence: 80,
  estimated_repairs: 20000,
  comp_count: 5,
});

// ─── G6(b): the confidence-scale collision is fixed at the boundary ────────

test("G6: ADE-native confidence 30 (i.e. 0.30) now trips the low-confidence gate", () => {
  const zone = classifyNegotiationZone({
    current_ask: 100000,
    recommended_offer: 80000,
    authorized_offer_ceiling: 90000,
    valuation_confidence: 30,
    policy: POLICY,
  });
  assert.equal(zone.zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE);
  assert.equal(zone.reason_code, "VALUATION_CONFIDENCE_BELOW_POLICY");
});

test("G6: ADE-native confidence 80 (i.e. 0.80) passes and yields a monetary zone", () => {
  const zone = classifyNegotiationZone({
    current_ask: 100000,
    recommended_offer: 80000,
    authorized_offer_ceiling: 90000,
    valuation_confidence: 80,
    policy: POLICY,
  });
  assert.equal(zone.zone, NEGOTIATION_ZONES.MODERATE_GAP);
});

test("G6: 0–1 scale confidence keeps working unchanged (both scales accepted)", () => {
  const low = classifyNegotiationZone({
    current_ask: 100000,
    recommended_offer: 80000,
    authorized_offer_ceiling: 90000,
    valuation_confidence: 0.2,
    policy: POLICY,
  });
  assert.equal(low.zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE);
  const high = classifyNegotiationZone({
    current_ask: 85000,
    recommended_offer: 80000,
    authorized_offer_ceiling: 90000,
    valuation_confidence: 0.8,
    policy: POLICY,
  });
  assert.equal(high.zone, NEGOTIATION_ZONES.WITHIN_AUTHORITY);
});

test("G6: reducer ingests ADE-native confidence onto the canonical 0–1 scale", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: { asking_price: { value: 100000, price_type: "exact", confidence: 0.9 } },
    ade_snapshot: ADE_NATIVE,
    now: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(state.comp_confidence, 0.8, "0–100 converted at state ingestion");
  const zone = classifyNegotiationZone({
    current_ask: state.current_asking_price,
    recommended_offer: state.recommended_offer,
    authorized_offer_ceiling: state.authorized_offer_ceiling,
    valuation_confidence: state.comp_confidence,
    policy: POLICY,
  });
  assert.notEqual(zone.zone, NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE);
});

test("G6: sufficiency's valuation-reliable shortcut no longer treats native 30 as reliable", () => {
  const lowConfidence = evaluateUnderwritingSufficiency({
    asset_class: "sfr",
    facts: { asking_price: { value: 100000 } },
    ade_snapshot: { ...ADE_NATIVE, valuation_confidence: 30 },
  });
  assert.equal(lowConfidence.sufficient, false, "30/100 confidence must not skip discovery");
  const highConfidence = evaluateUnderwritingSufficiency({
    asset_class: "sfr",
    facts: { asking_price: { value: 100000 } },
    ade_snapshot: ADE_NATIVE,
  });
  assert.equal(highConfidence.sufficient, true);
});

// ─── G6(a): the comp-intelligence ceiling fallback is retired ──────────────

function conversationStateFixture({ ceiling = null } = {}) {
  return {
    safety: { offer_permission: true, contract_progression_permission: true },
    authority: {
      offer_progression_allowed: true,
      can_execute_alone: true,
      additional_signers_claimed: [],
      estate_context: false,
    },
    identity: { owner_confirmed: true },
    acquisition: {
      asking_price: { resolution: FACT_RESOLUTION.KNOWN, value: { value: 100000 } },
    },
    negotiation: { recommended_offer: null, authorized_offer_ceiling: ceiling },
    seller_requests_offer: false,
  };
}

const NBA_NEGOTIATE = {
  objective: ACQUISITION_OBJECTIVES.NEGOTIATE,
  offer_allowed: true,
  suppression_required: false,
  human_review_required: false,
  reason_code: "negotiate",
};

test("G6: a comp-intelligence max_allowable_offer can no longer become the exposed ceiling", () => {
  const strategy = resolveSellerResponseStrategy({
    conversation_state: conversationStateFixture(),
    next_best_action: NBA_NEGOTIATE,
    // Comp-intelligence-style payload (ARV×0.75) — a DIFFERENT engine.
    underwriting: { max_allowable_offer: 97500, recommended_cash_offer: null },
    ade_snapshot: null,
  });
  assert.equal(
    strategy.acquisition_context.max_allowable_offer,
    null,
    "absent ADE authority the ceiling is null — never another engine's number"
  );
});

test("G6: with ADE authority present the exposed ceiling is the investor ceiling", () => {
  const strategy = resolveSellerResponseStrategy({
    conversation_state: conversationStateFixture(),
    next_best_action: NBA_NEGOTIATE,
    underwriting: { max_allowable_offer: 97500 },
    ade_snapshot: ADE_NATIVE,
  });
  assert.equal(strategy.acquisition_context.max_allowable_offer, 90000);
});

test("G6: negotiation-state ADE ceiling still backs the exposure when no snapshot rides the turn", () => {
  const strategy = resolveSellerResponseStrategy({
    conversation_state: conversationStateFixture({ ceiling: 90000 }),
    next_best_action: NBA_NEGOTIATE,
    underwriting: { max_allowable_offer: 97500 },
    ade_snapshot: null,
  });
  assert.equal(strategy.acquisition_context.max_allowable_offer, 90000);
});

// ─── G6: the renderer refuses ANY monetary token without a ceiling ─────────

test("G6: offer tokens stay empty without ceiling authority — even for a recommended offer", () => {
  const context = buildPersonalizationContext({
    message: "What can you offer?",
    dealAuthority: {
      recommended_offer: 80000,
      authorized_offer_amount: 80000,
      authorized_offer_ceiling: null,
    },
  });
  assert.equal(context.offer_price, null, "no ceiling ⇒ no monetary render, fail closed");
  assert.equal(context.smart_cash_offer_display, null);
});

test("G6: bounded amounts still render, over-ceiling amounts still fail closed", () => {
  const bounded = buildPersonalizationContext({
    dealAuthority: {
      recommended_offer: 80000,
      authorized_offer_amount: 80000,
      authorized_offer_ceiling: 90000,
    },
  });
  assert.equal(bounded.offer_price, "$80,000");

  const overCeiling = buildPersonalizationContext({
    dealAuthority: {
      recommended_offer: null,
      authorized_offer_amount: 99000,
      authorized_offer_ceiling: 90000,
    },
  });
  assert.equal(overCeiling.offer_price, null);
});
