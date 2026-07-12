// Multilingual lifecycle regression matrix (activation spec Mission 10).
// Composes the deterministic pieces exactly as the inbound orchestrator does —
// extraction → temperature signal → stage-transition resolver — for the
// message fixtures in the spec. Pure, deterministic, NO real SMS, NO I/O.
//
// Extraction-only and language-only fixtures live in
// seller-fact-extraction.test.mjs and lifecycle-stage-policy-registry.test.mjs;
// this file proves the lifecycle-level outcome for the classification →
// transition scenarios and the multilingual continuity cases.

import test from "node:test";
import assert from "node:assert/strict";

import { extractSellerFacts, extractionToResolverFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { computeTemperatureSignal } from "@/lib/domain/seller-flow/temperature-signal-model.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveThreadLanguage } from "@/lib/domain/seller-flow/resolve-thread-language.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

// Compose extraction + temperature + resolver the way the orchestrator does.
function runTurn({ message, intent, stageBefore = "ownership_confirmation", knownFacts = {}, priceRef = null }) {
  const priceSignal = resolveAskingPriceSignal(message, { reference: priceRef });
  const extraction = extractSellerFacts({ message, sourceMessageId: "evt", priceSignal });
  const extractionFacts = extractionToResolverFacts(extraction);
  const temperature = computeTemperatureSignal({
    intent,
    facts: { ...extractionFacts, asking_price: priceSignal.asking_price || null },
    objections: extraction.facts?.objections?.value || null,
    secondary: {},
  });
  const transition = resolveSellerStageTransition({
    stage_before: stageBefore,
    known_facts: knownFacts,
    new_facts: {
      ...extractionFacts,
      asking_price: priceSignal.asking_price || null,
    },
    intent,
    classification_confidence: 0.9,
    temperature_signal: temperature,
  });
  return { extraction, temperature, transition, priceSignal };
}

// ── Ownership confirmation (EN + ES) ─────────────────────────────────────────

test("English ownership confirmation advances past S1", () => {
  const { transition } = runTurn({ message: "Yes I own it", intent: "ownership_confirmed" });
  assert.equal(transition.stage_before, "ownership_confirmation");
  assert.ok(transition.stage_after_number >= 2, "ownership resolved → advances toward S2");
  assert.equal(transition.facts_patch.ownership_status, "confirmed");
});

test("Spanish ownership confirmation advances past S1", () => {
  const { transition, extraction } = runTurn({
    message: "Sí, soy el dueño de la casa",
    intent: "ownership_confirmed",
  });
  assert.ok(transition.stage_after_number >= 2);
  assert.equal(extraction.facts.ownership?.value?.ownership_claim, "confirmed");
});

// ── Non-owner / blocking outcomes ────────────────────────────────────────────

test("wrong number blocks contact and never advances", () => {
  const { transition } = runTurn({ message: "Wrong number", intent: "wrong_number" });
  assert.equal(transition.advanced, false);
  assert.equal(transition.contactability_patch.contactability_status, "invalid_number");
  assert.equal(transition.follow_up.cancel, true);
});

test("opt-out suppresses and cancels pending follow-ups", () => {
  const { transition } = runTurn({ message: "STOP", intent: "opt_out" });
  assert.equal(transition.contactability_patch.contactability_status, "opted_out");
  assert.equal(transition.follow_up.cancel, true);
  assert.equal(transition.advanced, false);
});

test("hostile/legal routes to human review and cancels follow-ups", () => {
  const { transition } = runTurn({ message: "I'll sue you, this is harassment", intent: "hostile_or_legal" });
  assert.equal(transition.review_required, true);
  assert.equal(transition.review_reason, "hostile_or_legal");
  assert.equal(transition.follow_up.cancel, true);
});

test("tenant occupancy is captured as an underwriting fact, not a brush-off", () => {
  const { transition, extraction } = runTurn({
    message: "Tenants live there right now",
    intent: "tenant_occupied",
  });
  assert.equal(extraction.facts.occupancy?.value?.occupancy_status, "tenant_occupied");
  assert.equal(transition.facts_patch.occupancy_status, "tenant_occupied");
});

// ── Multi-intent single messages ─────────────────────────────────────────────

test("owner + interested in one message advances beyond S2", () => {
  const { transition } = runTurn({
    message: "Yes I own it and I'd listen to an offer",
    intent: "ownership_confirmed",
    knownFacts: {},
  });
  assert.ok(transition.stage_after_number >= 2);
});

test("owner + asking price in one message advances to at least S3", () => {
  const { transition, priceSignal } = runTurn({
    message: "Yes I own it and I want $120,000",
    intent: "ownership_confirmed",
  });
  assert.equal(priceSignal.asking_price?.value, 120000);
  assert.ok(transition.stage_after_number >= 3, "price resolved → at least Asking Price stage");
  assert.equal(transition.lead_temperature, "hot");
});

test("asks for offer advances and floors hot", () => {
  const { transition } = runTurn({ message: "Just make me an offer", intent: "asks_offer" });
  assert.ok(transition.stage_after_number >= 2);
  assert.equal(transition.lead_temperature, "hot");
});

// ── Disengaging intents nurture without regression ───────────────────────────

test("not interested at S1 stays cold and schedules nurture, never regresses", () => {
  const { transition } = runTurn({ message: "Not interested", intent: "not_interested" });
  assert.equal(transition.lead_temperature, "cold");
  assert.equal(transition.follow_up.create, true);
  assert.ok(transition.stage_after_number >= transition.stage_before_number);
});

test("follow up later schedules a nurture window", () => {
  const { transition } = runTurn({ message: "Text me next month", intent: "need_time", stageBefore: "offer_interest" });
  assert.equal(transition.follow_up.create, true);
  assert.ok(transition.next_action_due_at);
});

// ── Asking-price discrimination ──────────────────────────────────────────────

test("explicit asking price resolves the price milestone", () => {
  const { transition, priceSignal } = runTurn({
    message: "I'd want 150k",
    intent: "asking_price_provided",
    stageBefore: "asking_price",
    knownFacts: { ownership_status: "confirmed", interest: "interested" },
  });
  assert.equal(priceSignal.asking_price?.value, 150000);
  assert.ok(transition.stage_after_number >= 3);
});

test("Spanish '120 mil' resolves as a price", () => {
  const signal = resolveAskingPriceSignal("Lo quiero vender por 120 mil");
  assert.equal(signal.asking_price?.value, 120000);
});

test("monthly rent, mortgage and repair amounts never resolve the price milestone", () => {
  for (const message of [
    "The tenants pay $1,200 a month",
    "I still owe $80,000 on the mortgage",
    "I got a quote for $15,000 to fix the roof",
  ]) {
    const signal = resolveAskingPriceSignal(message);
    assert.equal(signal.asking_price, null, message);
  }
});

test("ambiguous bare '120' never silently promotes to a canonical price", () => {
  const signal = resolveAskingPriceSignal("120");
  const promoted = signal.asking_price?.value === 120 && !signal.needs_clarification;
  assert.equal(promoted, false);
});

// ── Language continuity (established language preserved) ──────────────────────

test("established Spanish/Mandarin/Japanese thread language survives a terse reply", () => {
  for (const language of ["Spanish", "Mandarin", "Japanese"]) {
    const result = resolveThreadLanguage({
      threadLanguage: language,
      detectedLanguage: "English",
      messageText: "ok",
    });
    assert.equal(result.language, language, `${language} must be preserved`);
    assert.equal(result.source, "thread_language");
  }
});

test("unknown-language reply with no history resolves unknown, never English", () => {
  const result = resolveThreadLanguage({ detectedLanguage: "English", messageText: "ok" });
  assert.equal(result.is_unknown, true);
});

// ── Condition discrimination (feature vs defect) at the lifecycle level ──────

test("generic roof mention does not disclose a condition defect", () => {
  const { extraction } = runTurn({ message: "It has a roof and two bathrooms", intent: "unclear" });
  assert.equal(extraction.facts.repairs, undefined);
});

test("roof leak discloses a major repair", () => {
  const { extraction, transition } = runTurn({ message: "The roof leaks and needs replacing", intent: "condition_disclosed" });
  assert.ok(extraction.facts.repairs);
  assert.equal(extraction.facts.repairs.value.severity, "major");
  assert.equal(transition.facts_patch.condition_disclosed, true);
});

test("'I work nights' never reads as property work", () => {
  const { extraction } = runTurn({ message: "I work nights so text me", intent: "unclear" });
  assert.equal(extraction.facts.repairs, undefined);
});
