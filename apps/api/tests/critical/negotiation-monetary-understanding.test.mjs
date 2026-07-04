import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MONETARY_KINDS,
  extractMonetaryMentions,
  resolveAskingPriceSignal,
} from "@/lib/domain/seller-flow/monetary-understanding.js";

// ─── Spec §3 asking-price extraction matrix ──────────────────────────────────

const PRICE_CASES = [
  { message: "I want $100,000 for it", value: 100000, price_type: "exact" },
  { message: "I'd take 100k", value: 100000, price_type: "exact" },
  { message: "one hundred thousand", value: 100000, price_type: "exact" },
  { message: "I would want one hundred and fifty thousand for it", value: 150000, price_type: "exact" },
  { message: "$95K firm", value: 95000, price_type: "exact", firm: true },
  { message: "I need $90K net", value: 90000, price_type: "net" },
  { message: "at least 85k", value: 85000, price_type: "minimum" },
  { message: "$100K if you pay closing", value: 100000, price_type: "package_or_closing", closing: true },
  { message: "$80K per unit", value: 80000, price_type: "per_unit" },
  { message: "$500K for both properties", value: 500000, price_type: "package" },
];

for (const c of PRICE_CASES) {
  test(`§3 extraction: "${c.message}" → ${c.value}`, () => {
    const signal = resolveAskingPriceSignal(c.message, {});
    assert.ok(signal.asking_price, `expected a price from "${c.message}"`);
    assert.equal(signal.asking_price.value, c.value);
    assert.equal(signal.needs_clarification, false);
    if (c.firm) assert.equal(signal.asking_price.qualifiers.firm, true);
    if (c.price_type === "net") assert.equal(signal.asking_price.price_type, "net");
    if (c.price_type === "minimum") assert.equal(signal.asking_price.price_type, "minimum");
    if (c.price_type === "per_unit") assert.equal(signal.asking_price.price_type, "per_unit");
    if (c.price_type === "package") assert.equal(signal.asking_price.price_type, "package");
    if (c.closing) assert.equal(signal.asking_price.qualifiers.contingent_on_closing_costs, true);
  });
}

test("§3: 'around 100' with a same-magnitude reference scales to thousands", () => {
  const signal = resolveAskingPriceSignal("around 100", { reference: 120000 });
  assert.ok(signal.asking_price);
  assert.equal(signal.asking_price.value, 100000);
  assert.equal(signal.asking_price.price_type, "approximate");
});

test("§3: bare ambiguous number without reference asks for clarification", () => {
  const signal = resolveAskingPriceSignal("100", {});
  assert.equal(signal.asking_price, null);
  assert.equal(signal.needs_clarification, true);
  assert.equal(signal.clarification_reason, "low_confidence_monetary_extraction");
});

test("§3: price range takes the seller's low end and flags range", () => {
  const signal = resolveAskingPriceSignal("somewhere between $90,000 to $100,000", {});
  assert.ok(signal.asking_price);
  assert.equal(signal.asking_price.value, 90000);
  assert.equal(signal.asking_price.price_type, "range");
  assert.deepEqual(signal.asking_price.range, { low: 90000, high: 100000 });
});

test("§3: mortgage payoff is informational, never an asking price", () => {
  const signal = resolveAskingPriceSignal("I still owe $60,000 on the mortgage", {});
  assert.equal(signal.asking_price, null);
  const payoff = signal.informational_mentions.find((m) => m.kind === MONETARY_KINDS.MORTGAGE_PAYOFF);
  assert.ok(payoff);
  assert.equal(payoff.value, 60000);
});

test("§3: monthly payment amounts never become asking prices", () => {
  const signal = resolveAskingPriceSignal("my payment is $1,200 a month", {});
  assert.equal(signal.asking_price, null);
  const monthly = signal.informational_mentions.find((m) => m.kind === MONETARY_KINDS.MONTHLY_AMOUNT);
  assert.ok(monthly);
});

test("§3: repair quote is classified as repair amount", () => {
  const mentions = extractMonetaryMentions("the roof quote for repairs was $18,000", {});
  const repair = mentions.find((m) => m.kind === MONETARY_KINDS.REPAIR_AMOUNT);
  assert.ok(repair);
  assert.equal(repair.value, 18000);
});

test("§3: tax amounts are informational", () => {
  const mentions = extractMonetaryMentions("property taxes are $4,500 a year", {});
  const tax = mentions.find((m) => m.kind === MONETARY_KINDS.TAX_AMOUNT);
  assert.ok(tax);
});

test("§3: multiple prices with a payoff picks the ask and keeps the payoff", () => {
  const signal = resolveAskingPriceSignal("I owe $60,000 but I want $110,000 for it", {});
  assert.ok(signal.asking_price);
  assert.equal(signal.asking_price.value, 110000);
  const payoff = signal.informational_mentions.find((m) => m.kind === MONETARY_KINDS.MORTGAGE_PAYOFF);
  assert.equal(payoff?.value, 60000);
});

test("§3: conflicting asking prices in one message force clarification", () => {
  const signal = resolveAskingPriceSignal("I want $90,000. Actually I want $150,000.", {});
  assert.equal(signal.asking_price, null);
  assert.equal(signal.needs_clarification, true);
  assert.equal(signal.clarification_reason, "conflicting_price_statements");
});

test("§3: counters at S5 are marked is_counter", () => {
  const signal = resolveAskingPriceSignal("how about 160", {
    reference: 150000,
    negotiationActive: true,
  });
  assert.ok(signal.asking_price);
  assert.equal(signal.asking_price.value, 160000);
  assert.equal(signal.is_counter, true);
});

test("§3: time expressions never become prices", () => {
  const signal = resolveAskingPriceSignal("check back in 30 days", {});
  assert.equal(signal.asking_price, null);
  assert.equal(signal.needs_clarification, false);
});

test("§3: unit counts never become prices", () => {
  const signal = resolveAskingPriceSignal("it has 4 bedrooms and 2 baths", {});
  assert.equal(signal.asking_price, null);
});
