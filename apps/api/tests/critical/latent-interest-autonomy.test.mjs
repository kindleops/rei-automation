import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

// Classifier-coverage seam (reconciliation, not gate-weakening): phrase-anchored
// conditional-sale interest ("for the right price", "depends on the offer",
// "might/mite sell", "open to an offer") is a real, understood seller signal. It
// routes to seller_asking_price (auto-safe template) but previously defaulted to
// 0.60 and fell to human review. It now clears the 0.82 autonomy gate
// (FIXED_CONFIDENCE.latent_interest = 0.85) and advances the deal.
//
// The ambiguity gate is explicitly PRESERVED: bare hedges ("maybe", "depends",
// "possibly") are excluded from the trigger and stay unclear at 0.60, below the
// gate. Slang conditional interest ("mite sell depends payin") is caught by its
// SELL FRAME ("mite sell"), not by bare "depends".
//
// Safe to raise only after the staleness invariant became chronology-driven
// (a stale positive can no longer reopen automation regardless of confidence).

const c = (text) => classify(text, null, { heuristicOnly: true });

test("phrase-anchored / slang conditional interest advances autonomously (latent_interest >= 0.82)", async () => {
  const autonomous = [
    "for the right price",
    "if the price is right",
    "depends on the offer",
    "depends on price",
    "I might sell",
    "mite sell depends payin", // slang: possible sale + conditional price
    "open to an offer",
    "could be interested",
    // Sell-framed re-engagement (renewed selling interest)
    "reconsidering selling",
    "still open to selling",
    "changed my mind about selling",
  ];
  for (const text of autonomous) {
    const r = await c(text);
    assert.equal(
      r.primary_intent,
      "latent_interest",
      `"${text}" expected latent_interest, got ${r.primary_intent}`
    );
    assert.ok(
      r.confidence >= 0.82,
      `"${text}" confidence ${r.confidence} must clear the 0.82 autonomy gate`
    );
  }
});

test("bare hedges stay below the autonomy gate (ambiguity gate NOT weakened)", async () => {
  for (const text of ["maybe", "depends", "possibly", "what"]) {
    const r = await c(text);
    assert.ok(
      r.confidence < 0.82,
      `bare hedge "${text}" must stay < 0.82, got ${r.confidence} (intent ${r.primary_intent})`
    );
  }
});

test("buyer-directed meta-questions do NOT inflate into seller latent_interest", async () => {
  // "Are you still buying?" is a question TO us, not the seller's own renewed
  // interest. It must not become latent_interest (mission re-engagement rule).
  for (const text of [
    "You still buying houses?",
    "are you guys still purchasing",
    "do you still buy in this area",
  ]) {
    const r = await c(text);
    assert.notEqual(
      r.primary_intent,
      "latent_interest",
      `buyer-directed "${text}" must not be latent_interest, got ${r.primary_intent}`
    );
  }
});
