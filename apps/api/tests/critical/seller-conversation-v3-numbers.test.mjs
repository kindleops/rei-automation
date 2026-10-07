/**
 * SELLER CONVERSATION MACHINE v3 — number extraction rules (owner brief
 * 2026-10-06 late), implemented in the ONE money path
 * (seller-flow/monetary-understanding.js) and therefore shared by classify.js,
 * the orchestrator slot and the burst reduction.
 *
 *   3 digits ("250", "$250", "250k")       -> price in thousands
 *   3,3 / 6+ digits / "$250000"            -> price
 *   "1.5 million" / "2M" / "1 million"     -> price
 *   1,3 ("1,500")                          -> rent, never a price
 *   bare 4 digits ("2020", "1500")         -> a year or a rent, never a price
 *   condition word + year ("roof 2020")    -> an update-year fact
 *
 * Flag SELLER_CONVERSATION_V3 (default OFF): with the flag off the RC 7.1
 * rules are byte-identical (a bare "250" is scale-ambiguous).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAskingPriceSignal,
  extractMonetaryMentions,
  extractUpdateYears,
  interpretSellerNumbers,
  resolveNumberRules,
  NUMBER_RULES,
  MONETARY_KINDS,
} from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveCanonicalAskingPrice, isCommittedAskingPrice } from "@/lib/domain/seller-flow/canonical-asking-price.js";
import { isSellerConversationV3Enabled } from "@/lib/domain/seller-flow/seller-conversation-v3-flag.js";
import { classify } from "@/lib/domain/classification/classify.js";

const v3 = (m, o = {}) => resolveAskingPriceSignal(m, { ...o, numberRules: "v3" });
const rc71 = (m, o = {}) => resolveAskingPriceSignal(m, { ...o, numberRules: "rc71" });
const NOW = Date.parse("2026-10-06T12:00:00Z");

test("flag: default OFF, explicit truthy only", () => {
  assert.equal(isSellerConversationV3Enabled({}), false);
  assert.equal(isSellerConversationV3Enabled({ SELLER_CONVERSATION_V3: "false" }), false);
  assert.equal(isSellerConversationV3Enabled({ SELLER_CONVERSATION_V3: "1" }), true);
  assert.equal(resolveNumberRules(null, {}), NUMBER_RULES.RC71);
  assert.equal(resolveNumberRules(null, { SELLER_CONVERSATION_V3: "true" }), NUMBER_RULES.V3);
  assert.equal(resolveNumberRules("rc71", { SELLER_CONVERSATION_V3: "true" }), NUMBER_RULES.RC71);
});

test("3-digit number = price in thousands (with or without $ / K)", () => {
  for (const [m, want] of [
    ["250", 250_000], ["$250", 250_000], ["250k", 250_000], ["250K", 250_000],
    ["I want 250", 250_000], ["I'd take 185 for it", 185_000], ["3/1 $167 let me know", 167_000],
    ["I need 300 net", 300_000], ["between 240 and 260", 240_000],
  ]) {
    assert.equal(v3(m).asking_price?.value, want, m);
  }
  // The RC 7.1 rule is untouched with the flag off: "250" asks for the scale.
  assert.equal(rc71("250").asking_price, null);
  assert.equal(rc71("250").needs_clarification, true);
});

test("3,3 / 6+ digits / $250000 = price as written", () => {
  for (const [m, want] of [["250,000", 250_000], ["$250000", 250_000], ["250000", 250_000], ["$1,500,000", 1_500_000], ["95000", 95_000]]) {
    assert.equal(v3(m).asking_price?.value, want, m);
  }
});

test("'1.5 million' / '2M' / '1 million' = price", () => {
  for (const [m, want] of [["1.5 million", 1_500_000], ["2M", 2_000_000], ["1 million", 1_000_000], ["half a million", 500_000]]) {
    assert.equal(v3(m).asking_price?.value, want, m);
  }
});

test("1,3 ('1,500') = rent, never a price", () => {
  for (const m of ["1,500", "$1,500", "they pay 1,200", "1,500 a month"]) {
    const r = v3(m);
    assert.equal(r.asking_price, null, m);
    const rents = extractMonetaryMentions(m, { numberRules: "v3" }).filter((x) => x.kind === MONETARY_KINDS.MONTHLY_AMOUNT);
    assert.equal(rents.length, 1, m);
  }
});

test("bare 4-digit = a year or a rent, never a price", () => {
  for (const m of ["2020", "1500", "2000", "$2500", "rents 1500", "I'd want 4500", "9999"]) {
    assert.equal(v3(m).asking_price, null, m);
  }
  const rent = interpretSellerNumbers("rents 1500");
  assert.deepEqual(rent.rents.map((r) => r.value), [1500]);
  const year = interpretSellerNumbers("2020");
  assert.deepEqual(year.years.map((y) => y.year), [2020]);
  assert.equal(year.rents.length, 0);
});

test("condition word + year = update-year fact; a year without one is not", () => {
  const facts = extractUpdateYears("new roof 2019, kitchen and baths 2018, AC is 5 years old, water heater '21", { now: NOW });
  const by = Object.fromEntries(facts.map((f) => [f.component, f.year]));
  assert.deepEqual(by, { roof: 2019, kitchen: 2018, bathrooms: 2018, hvac: 2021, water_heater: 2021 });
  assert.deepEqual(extractUpdateYears("roof 2020", { now: NOW }).map((f) => [f.component, f.year]), [["roof", 2020]]);
  assert.deepEqual(extractUpdateYears("2018 roof", { now: NOW }).map((f) => [f.component, f.year]), [["roof", 2018]]);
  assert.deepEqual(extractUpdateYears("Kitchen updated last year", { now: NOW }).map((f) => [f.component, f.year]), [["kitchen", 2025]]);
  assert.deepEqual(extractUpdateYears("El techo es de 2015", { now: NOW }).map((f) => [f.component, f.year]), [["roof", 2015]]);
  assert.deepEqual(extractUpdateYears("Built in 1985", { now: NOW }), []);
  // "Roof 2020. Rents 1500": the year is a roof year, the 1500 a rent, 350 a price.
  const all = interpretSellerNumbers("Roof 2020. Rents 1500 and 1,200. Want 350", { now: NOW });
  assert.deepEqual(all.prices.map((p) => p.value), [350_000]);
  assert.deepEqual(all.rents.map((r) => r.value).sort(), [1200, 1500]);
  assert.deepEqual(all.update_years.map((f) => [f.component, f.year]), [["roof", 2020]]);
  // A roof year never becomes a price.
  assert.equal(v3("roof 2020").asking_price, null);
});

test("cues still decide what a number IS: rent, tax, payoff, refusal, phone, address", () => {
  const kinds = (m) => extractMonetaryMentions(m, { numberRules: "v3" }).map((x) => `${x.kind}:${x.value}`);
  assert.deepEqual(kinds("rent 950"), ["monthly_amount:950"]);
  assert.deepEqual(kinds("taxes 900"), ["tax_amount:900"]);
  assert.deepEqual(kinds("I owe 120"), ["mortgage_payoff:120000"]);
  assert.deepEqual(kinds("2 units, 950 each in rent"), ["monthly_amount:950"]);
  assert.equal(v3("not for sale 300").asking_price, null);
  assert.equal(v3("call me 209-505-5314").asking_price, null);
  assert.equal(v3("For 327 Pennsylvania alone 130,000").asking_price?.value, 130_000);
  assert.equal(v3("built in 1985").asking_price, null);
  assert.equal(v3("65").asking_price, null, "two digits stay ambiguous");
});

test("the canonical money path (classifier + orchestrator) commits a v3 3-digit price", () => {
  const signal = resolveCanonicalAskingPrice("250", { numberRules: "v3", lastOutboundBody: "Do you have an asking price in mind?" });
  assert.equal(isCommittedAskingPrice(signal), true);
  assert.equal(signal.asking_price.value, 250_000);
  assert.equal(signal.asking_price.scaled_from_reference, true, "the magnitude is a rule's reading, not the seller's");
  // A bare number answering a size question is still not a price.
  const sqft = resolveCanonicalAskingPrice("250", { numberRules: "v3", lastOutboundBody: "How many square feet is it?" });
  assert.equal(isCommittedAskingPrice(sqft), false);
});

test("classify.js reads the same parser when the flag is on", async () => {
  const before = process.env.SELLER_CONVERSATION_V3;
  try {
    process.env.SELLER_CONVERSATION_V3 = "1";
    const on = await classify("I'd want 250", null, { heuristicOnly: true });
    assert.equal(on.primary_intent, "asking_price_provided");
    assert.equal(on.price_parse?.value, 250_000);
    const rent = await classify("rents are 1,500", null, { heuristicOnly: true });
    assert.notEqual(rent.primary_intent, "asking_price_provided");
    delete process.env.SELLER_CONVERSATION_V3;
    const off = await classify("I'd want 250", null, { heuristicOnly: true });
    assert.equal(off.price_parse?.value ?? null, null, "flag off: RC 7.1 scale clarification");
  } finally {
    if (before === undefined) delete process.env.SELLER_CONVERSATION_V3;
    else process.env.SELLER_CONVERSATION_V3 = before;
  }
});
