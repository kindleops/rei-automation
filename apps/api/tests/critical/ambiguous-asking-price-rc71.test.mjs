// RC 7.1 — a bare number is not silently a price in thousands.
//
// Property 273312064 (production, 2026-10-01): the seller wrote "$110,000",
// then "$40,000", then "65". The deal's reference price turned "65" into a
// $65,000 counter at confidence 0.65 (seller_counter = 65000, fact
// scaled_from_reference: true). A reference says how big the deal is, not
// which unit the seller types in. Thousands shorthand now needs the
// CONVERSATION to have established it (the seller already wrote "110k");
// otherwise the number is scale-ambiguous: surfaced, clarified, never
// persisted as the canonical ask, never a stage advance.

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMonetaryMentions,
  resolveAskingPriceSignal,
  establishesThousandsShorthand,
} from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveBurstAskingPriceSignal } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";
import {
  mergeSellerFacts,
  resolveSellerStageTransition,
} from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const REF = 110_000;
const BARE = ["65", "70", "125", "2.5", "250"];
const EXPLICIT = [
  ["65k", 65_000],
  ["$65k", 65_000],
  ["65,000", 65_000],
  ["$65000", 65_000],
  ["65 thousand", 65_000],
  ["sixty five thousand", 65_000],
  ["1.2m", 1_200_000],
  ["$1.2m", 1_200_000],
  ["650,000", 650_000],
  ["250000", 250_000],
  ["$250,000", 250_000],
  ["$110,000", 110_000],
  ["$40,000", 40_000],
];

// ── Extraction / confidence / normalization ───────────────────────────────

test("explicit magnitude stays valid, with or without a reference", () => {
  for (const [text, value] of EXPLICIT) {
    for (const options of [{}, { reference: REF }, { reference: REF, negotiationActive: true }]) {
      const signal = resolveAskingPriceSignal(text, options);
      assert.equal(signal.asking_price?.value, value, `${text} ${JSON.stringify(options)}`);
      assert.ok(signal.asking_price.confidence >= 0.5, `${text} is accepted`);
      assert.equal(signal.asking_price.scaled_from_reference, false, `${text} states its own magnitude`);
      assert.equal(signal.needs_clarification, false);
    }
  }
});

test("a bare number in a price conversation is scale-ambiguous: clarify, never a price", () => {
  for (const text of BARE) {
    for (const negotiationActive of [false, true]) {
      const signal = resolveAskingPriceSignal(text, { reference: REF, negotiationActive });
      assert.equal(signal.asking_price, null, `${text} must not become a price`);
      assert.equal(signal.needs_clarification, true, `${text} asks instead`);
      assert.equal(signal.clarification_reason, "ambiguous_price_scale", text);
      const mention = signal.all_mentions.find((m) => m.scale_ambiguous);
      assert.ok(mention, `${text} is surfaced as evidence`);
      assert.ok(mention.confidence < 0.5);
      assert.equal(mention.scaled_from_reference, false);
      assert.equal(mention.value, Number(text), "evidence keeps the literal the seller typed");
    }
  }
  // In a sentence too.
  for (const text of ["I want 65", "65 for it", "maybe 70", "at least 65", "I'd take 250"]) {
    const signal = resolveAskingPriceSignal(text, { reference: REF });
    assert.equal(signal.asking_price, null, text);
    assert.equal(signal.needs_clarification, true, text);
  }
});

test("without a reference a bare number is never a price either", () => {
  for (const text of BARE) {
    const signal = resolveAskingPriceSignal(text, {});
    assert.equal(signal.asking_price, null, text);
  }
});

test("thousands shorthand only when THIS conversation established it", () => {
  assert.equal(establishesThousandsShorthand(["110k"]), true);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "$95K" }]), true);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "110 thousand" }]), true);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "110 grand" }]), true);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "$110,000" }, { extracted_text: "$40,000" }]), false);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "65" }, null, {}]), false);
  assert.equal(establishesThousandsShorthand([{ extracted_text: "sixty five thousand" }]), false);
  assert.equal(establishesThousandsShorthand([]), false);

  const scaled = resolveAskingPriceSignal("65", { reference: REF, shorthandConvention: true });
  assert.equal(scaled.asking_price?.value, 65_000);
  assert.equal(scaled.asking_price.scaled_from_reference, true, "the inference is recorded");
  assert.equal(scaled.asking_price.extracted_text, "65");

  // The convention needs a deal-sized reference to read against.
  const noRef = resolveAskingPriceSignal("65", { shorthandConvention: true });
  assert.equal(noRef.asking_price, null);
});

test("a sub-$1,000 literal is never lifted into a price by a qualifier cue", () => {
  for (const text of ["at least 300", "no less than 400", "I need 300 net", "300 minimum"]) {
    const signal = resolveAskingPriceSignal(text, {});
    assert.equal(signal.asking_price, null, text);
  }
  assert.ok(extractMonetaryMentions("I need 300 Net").length >= 1, "the amount is still surfaced");
});

// ── The production case ───────────────────────────────────────────────────

test("REAL CASE: '$110,000' → '$40,000' → '65' never becomes a $65,000 ask", () => {
  // Turn by turn, the way process-seller-inbound-message builds its options:
  // the reference is the current ask; the convention comes from the history.
  const history = [];
  let known = {};
  let reference = null;
  for (const [message, expected] of [["$110,000", 110_000], ["$40,000", 40_000], ["65", null]]) {
    const signal = resolveAskingPriceSignal(message, {
      reference,
      negotiationActive: true,
      shorthandConvention: establishesThousandsShorthand(history),
      sourceMessageId: `sm_${message}`,
    });
    assert.equal(signal.asking_price?.value ?? null, expected, message);
    if (signal.asking_price) {
      history.push(signal.asking_price);
      reference = signal.asking_price.value;
    }

    // Persistence: what the transition merges is the canonical fact.
    const extraction = extractSellerFacts({ message, sourceMessageId: `sm_${message}`, priceSignal: signal });
    const facts = extractionToResolverFacts(extraction);
    known = mergeSellerFacts(known, facts);
    if (expected === null) {
      assert.equal(facts.asking_price ?? null, null, "65 is not a fact");
      assert.equal(facts.asking_price_needs_clarification, true, "65 asks for clarification");
    }
  }
  assert.equal(known.asking_price.value, 40_000, "the canonical ask stays the seller's last explicit $40,000");
  assert.notEqual(known.asking_price.scaled_from_reference, true);
});

test("REAL CASE as one burst: the explicit $40,000 survives the bare 65", () => {
  const burst = resolveBurstAskingPriceSignal(
    [
      { body: "$110,000", received_at: "2026-10-01T12:50:00Z", message_id: "a" },
      { body: "$40,000", received_at: "2026-10-01T12:55:00Z", message_id: "b" },
      { body: "65", received_at: "2026-10-01T12:58:00Z", message_id: "c" },
    ],
    { reference: REF, negotiationActive: true }
  );
  assert.equal(burst.asking_price?.value, 40_000);
  assert.notEqual(burst.asking_price?.value, 65_000);
});

test("a burst fragment written as '110k' establishes the convention for the next one", () => {
  const burst = resolveBurstAskingPriceSignal(
    [
      { body: "I was thinking 110k", received_at: "2026-10-01T12:50:00Z", message_id: "a" },
      { body: "actually 95", received_at: "2026-10-01T12:51:00Z", message_id: "b" },
    ],
    { reference: REF }
  );
  assert.equal(burst.asking_price?.value, 95_000);
  assert.equal(burst.asking_price.scaled_from_reference, true);
});

// ── Stage behaviour ───────────────────────────────────────────────────────

test("an ambiguous bare number never advances the stage or writes a price", () => {
  const signal = resolveAskingPriceSignal("65", { reference: REF });
  const extraction = extractSellerFacts({ message: "65", sourceMessageId: "sm_65", priceSignal: signal });
  const new_facts = extractionToResolverFacts(extraction);

  const transition = resolveSellerStageTransition({
    stage_before: "asking_price",
    known_facts: { ownership_status: "confirmed" },
    new_facts,
    intent: "asking_price_provided",
    classification_confidence: 0.9,
  });
  assert.equal(transition.facts_patch?.asking_price ?? null, null, "no canonical ask written");
  assert.ok(
    Number(transition.stage_after_number || 0) <= 3,
    `stays at or before the asking-price stage, got ${transition.stage_after}`
  );

  // Explicit "$65,000" in the same position IS a price.
  const explicit = resolveAskingPriceSignal("$65,000", { reference: REF });
  const explicitFacts = extractionToResolverFacts(
    extractSellerFacts({ message: "$65,000", sourceMessageId: "sm_65k", priceSignal: explicit })
  );
  const advanced = resolveSellerStageTransition({
    stage_before: "asking_price",
    known_facts: { ownership_status: "confirmed" },
    new_facts: explicitFacts,
    intent: "asking_price_provided",
    classification_confidence: 0.9,
  });
  assert.equal(advanced.facts_patch?.asking_price?.value, 65_000);
});
