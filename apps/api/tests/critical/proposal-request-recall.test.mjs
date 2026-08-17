// proposal_request recall fix (classify.js).
//
// The deterministic heuristic recognized some offer solicitations but missed
// superlative ("best offer/price"), modal/interrogative ("can you offer",
// "what/how much/the most ... you ... pay|offer|give"), and willingness
// ("you willing to pay") phrasings — ~53% recall on obvious offer intent.
// The fix adds a narrow `offer_price_solicitation` branch (second-person ask
// directed at us only). These tests pin recall AND the no-false-positive
// boundary. Production inbound path is heuristicOnly (handle-textgrid-inbound.js:1802).

import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "@/lib/domain/classification/classify.js";

const intentOf = async (p) =>
  (await classify(p, null, { heuristicOnly: true })).primary_intent;

// 14 DIRECT offer-solicitation phrases (all 6 previously-missed + 8 already-passing).
const DIRECT_OFFER = [
  "What's your best offer?",
  "What can you offer me?",
  "How much would you pay?",
  "How much are you offering?",
  "What's your offer?",
  "Make me an offer.",
  "Send me an offer.",
  "What price can you give me?",
  "What's the most you can pay?",
  "How much cash can you offer?",
  "What would you pay for the property?",
  "Give me your best price.",
  "What are you willing to pay?",
  "I'd sell. What's your offer?",
];

test("recall: every direct offer-solicitation phrase classifies asks_offer", async () => {
  for (const p of DIRECT_OFFER) {
    assert.equal(await intentOf(p), "asks_offer", `expected asks_offer for: ${p}`);
  }
});

test("15th audit phrase: conditional interest stays a positive non-offer intent (not unclear, not a false offer)", async () => {
  const i = await intentOf("I'm interested if the price is right.");
  assert.notEqual(i, "unclear", "conditional interest must be a recognized positive signal");
  assert.notEqual(i, "asks_offer", "conditional interest is not a direct offer solicitation");
});

// Original 5 controls — unaffected, no false offer positives.
test("controls: original 5 controls unaffected", async () => {
  assert.equal(await intentOf("Yes, I own it."), "ownership_confirmed");
  assert.equal(await intentOf("STOP"), "opt_out");
  assert.equal(await intentOf("Who is this?"), "who_is_this");
  for (const p of ["Ok thanks.", "What time is it?"]) {
    assert.notEqual(await intentOf(p), "asks_offer", `false positive control: ${p}`);
  }
});

// Expanded negatives: price / pay / offer / best in NON-solicitation contexts.
// (The pre-existing "How much do I owe on it?" -> asks_offer FP is intentionally
//  excluded — it predates this fix and lies outside the recall scope; reported
//  separately.)
const NEGATIVES = [
  "I already paid.",
  "The price is too high.",
  "I got another offer.",
  "Best time to call is tomorrow.",
  "Do I have to pay anything?",
  "Your offer was too low.",
  "What price did it sell for?",
  "I'm not accepting offers.",
  "I paid cash for it.",
  "Can you give me a call?",
  "Will you pay for repairs?",
  "The offer you sent was too low.",
  "Best realtor in town listed it.",
  "I can't pay the mortgage.",
  "Did you offer on the other house?",
];

test("no false-positive expansion: price/pay/offer/best in non-solicitation contexts stay non-offer", async () => {
  for (const p of NEGATIVES) {
    assert.notEqual(await intentOf(p), "asks_offer", `false positive: ${p}`);
  }
});
