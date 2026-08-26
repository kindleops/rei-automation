// ─── price-address-disambiguation.test.mjs ──────────────────────────────────
// Certification regression: non-price numbers must never become monetary
// values, and street numbers must never hijack the asking-price intent.
//
// Root defects locked here (backend certification pass, 2026-08-25):
//   * extractPrice read "123 Main" as $123M (boundary-free "m" suffix) and
//     fed seller_state.price_mentioned → reply-template personalization.
//   * "I live at 1503 Maple Drive" satisfied the "at <4+ digits>" money cue
//     in ASKING_PRICE_PATTERNS → primary_intent asking_price_provided @0.88
//     → the auto-reply price lane, with a $1.5B "price".
// price_mentioned now derives ONLY from the qualified structured parse, and
// parseSellerAskingPrice refuses street-address numbers (span-aware).
//
// Deterministic: heuristicOnly, no network, no AI.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify, parseSellerAskingPrice } from "@/lib/domain/classification/classify.js";
import {
  extractAddressCandidates,
  findHighConfidenceAddressSpans,
} from "@/lib/domain/classification/extract-address-signals.js";

async function heuristic(body) {
  return classify(body, null, { heuristicOnly: true });
}

test("street numbers, times, phones, years and zips are never prices", async () => {
  const NEVER_PRICE = [
    "123 Main is not for sale.",
    "That house isn't for sale, but I might sell 123 Oak Street.",
    "I live at 1503 Maple Drive",
    "Yes I own 456 Oak Ave",
    "Call me at 5:30",
    "Call me after 3pm",
    "My number is 305-555-1212",
    "The zip is 33101",
    "Sold it in 2019",
  ];
  const violations = [];
  for (const text of NEVER_PRICE) {
    const r = await heuristic(text);
    const price = r.seller_state?.price_mentioned ?? null;
    if (price !== null) {
      violations.push(`"${text}" produced price_mentioned=${price}`);
    }
    if (r.primary_intent === "asking_price_provided") {
      violations.push(`"${text}" hijacked primary_intent=asking_price_provided`);
    }
  }
  assert.deepEqual(violations, []);
});

test("an address message never qualifies as a seller asking price", () => {
  for (const text of [
    "I live at 1503 Maple Drive",
    "123 Main is not for sale",
    "we're at 2200 Oak Street, Bonita CA 91902",
  ]) {
    const parse = parseSellerAskingPrice(text);
    assert.equal(parse.qualifies_as_seller_asking_price, false, text);
  }
  // The rejection is auditable, not silent.
  const rejected = parseSellerAskingPrice("I live at 1503 Maple Drive");
  assert.equal(rejected.semantic_role, "street_address");
  assert.equal(rejected.price_rule_id, "price_reject_address");
});

test("real prices still parse — including alongside an address", async () => {
  const cases = [
    { text: "we want 150k for it", value: 150000 },
    { text: "I want 150,000 for it", value: 150000 },
    { text: "I'd take 250,000", value: 250000 },
    { text: "I want 150k for 123 Main St", value: 150000 },
    { text: "asking $95,000", value: 95000 },
  ];
  for (const { text, value } of cases) {
    const parse = parseSellerAskingPrice(text);
    assert.equal(parse.qualifies_as_seller_asking_price, true, text);
    assert.equal(Number(parse.value), value, `${text} → ${parse.value}`);
    const r = await heuristic(text);
    assert.equal(Number(r.seller_state?.price_mentioned), value, text);
  }
});

test("canonical compound probate+executor+150k price still parses exactly", async () => {
  const r = await heuristic(
    "Property is in probate, my sister is executor, and we want 150k for it"
  );
  assert.equal(Number(r.seller_state?.price_mentioned), 150000);
});

test("address extraction: suffix-bearing candidates with optional city/state/zip", () => {
  const candidates = extractAddressCandidates(
    "That house isn't for sale, but I might sell 123 Oak Street."
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confidence, "high");
  assert.equal(candidates[0].street_number, "123");
  assert.match(candidates[0].street_name, /oak/i);

  const full = extractAddressCandidates("No la Mia es 2711 Degen Dr. Bonita CA 91902");
  assert.equal(full.length, 1);
  assert.equal(full[0].confidence, "high");
  assert.equal(full[0].zip, "91902");
  assert.equal(full[0].state, "CA");
});

test("address extraction: bare pairs need a transactional cue; units never match", () => {
  // Transactional cue present → low-confidence candidate allowed.
  const low = extractAddressCandidates("123 Main isn't for sale but 456 Oak might be");
  assert.ok(low.some((c) => c.street_number === "456"), JSON.stringify(low));
  // No cue → no candidates from bare pairs.
  assert.deepEqual(extractAddressCandidates("Call me at 5:30"), []);
  // Unit words never become street names even with a cue.
  const units = extractAddressCandidates("we sold it 10 yrs ago");
  assert.ok(!units.some((c) => /yrs|years/.test(c.street_name)), JSON.stringify(units));
});

test("high-confidence spans cover the address, and only the address", () => {
  const text = "I want 150k for 123 Main St";
  const spans = findHighConfidenceAddressSpans(text);
  assert.equal(spans.length, 1);
  const [start, end] = spans[0];
  assert.equal(text.slice(start, end).trim(), "123 Main St");
});

test("classification result carries address_signals for the decision layer", async () => {
  const r = await heuristic("No that property is not for sale. But what would you pay for 456 Oak Ave?");
  assert.ok(Array.isArray(r.address_signals));
  assert.ok(
    r.address_signals.some((c) => c.street_number === "456" && c.confidence === "high"),
    JSON.stringify(r.address_signals)
  );
});
