/**
 * rent-vs-asking-price.test.mjs
 *
 * A rent figure must never become the seller's asking price.
 *
 * Sellers quote rent without ever saying "month" -- "rents are 1200 and 1350",
 * "each unit rents for 1500", "they bring in 3200". Before 2026-09-09 those
 * classified as ASKING_PRICE, so a duplex looked like it was for sale for
 * $1,200 and the rent figure became the negotiation anchor and the price
 * signal reference. This matters most on the live Miami campaign, which is
 * ~99% two-to-four unit multifamily.
 *
 * The fix adds rent cues to MONETARY_KINDS.MONTHLY_AMOUNT. This file pins BOTH
 * directions: rent language must read as monthly, and ordinary asking-price
 * language must be completely unaffected.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMonetaryMentions,
  MONETARY_KINDS,
} from "@/lib/domain/seller-flow/monetary-understanding.js";
import { parseSellerAskingPrice } from "@/lib/domain/classification/classify.js";

function kindsOf(message) {
  const result = extractMonetaryMentions(message);
  const mentions = Array.isArray(result) ? result : result?.mentions || [];
  return mentions.map((m) => ({ kind: m.kind, value: m.value }));
}

test("rent language reads as a monthly amount, never an asking price", () => {
  const cases = [
    ["rents are 1200 and 1350", [1200, 1350]],
    ["each unit rents for 1500", [1500]],
    ["they pay 1800 a month", [1800]],
    ["$2,400/mo total", [2400]],
    ["both units bring in 3200 a month", [3200]],
    ["tenant pays $1,750 monthly", [1750]],
  ];
  for (const [message, expectedValues] of cases) {
    const mentions = kindsOf(message);
    assert.ok(mentions.length > 0, `no mention parsed: ${message}`);
    for (const m of mentions) {
      assert.notEqual(
        m.kind,
        MONETARY_KINDS.ASKING_PRICE,
        `rent read as an asking price: ${message} -> ${m.value}`
      );
    }
    // Every quoted rent must be captured, not just the first.
    for (const value of expectedValues) {
      assert.ok(
        mentions.some((m) => m.value === value),
        `missing ${value} from: ${message}`
      );
    }
  }
});

test("ordinary asking-price language is unaffected", () => {
  const cases = [
    ["250k", 250000],
    ["$250,000", 250000],
    ["I want 250,000", 250000],
    ["around 300k", 300000],
    ["I'd take 275k", 275000],
    ["3.5 million", 3500000],
    ["$1.2M", 1200000],
    ["quiero 250 mil", 250000],
    ["no less than 400k", 400000],
    ["make it 240k and its yours", 240000],
  ];
  for (const [message, expected] of cases) {
    const mentions = kindsOf(message);
    assert.ok(
      mentions.some((m) => m.value === expected),
      `asking price lost: ${message}`
    );
    assert.ok(
      mentions.every((m) => m.kind !== MONETARY_KINDS.MONTHLY_AMOUNT),
      `asking price misread as rent: ${message}`
    );
  }
});

test("a rental mentioned in a sale sentence is still an asking price", () => {
  // "rental" must NOT trigger the rent cues -- the matcher is word-boundary
  // based specifically so this stays a sale price.
  const mentions = kindsOf("I want 400k for the rental");
  assert.ok(mentions.some((m) => m.value === 400000));
  assert.ok(mentions.every((m) => m.kind !== MONETARY_KINDS.MONTHLY_AMOUNT));
});

test("non-money numbers never become an asking price fact", () => {
  // Asserted at parseSellerAskingPrice, which is the layer that actually feeds
  // facts.asking_price. extractMonetaryMentions is a lower-level tokenizer and
  // deliberately emits candidates that the phone/date/quantity guards above it
  // then reject -- asserting there would test the wrong contract.
  for (const message of [
    "my phone is 5551234567",
    "call me at 2 pm",
    "I have 3 units",
    "it was built in 1965",
  ]) {
    const parsed = parseSellerAskingPrice(message);
    const value = parsed && typeof parsed === "object" ? parsed.value : parsed;
    assert.equal(value ?? null, null, `non-money read as a price: ${message}`);
  }
});
