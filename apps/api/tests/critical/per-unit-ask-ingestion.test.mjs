// ─── per-unit-ask-ingestion.test.mjs ─────────────────────────────────────────
//
// A per-unit quote is NOT the property ask. Two defects made it become one:
//
//  1. INGESTION (negotiation-state.js §2) assigned the signal's value straight
//     to current_asking_price with no reference to its price kind, and §3b then
//     divided that by units_count AGAIN. "120k per door" on 8 units landed as a
//     $120,000 property ask plus a $15,000 per-door ask — and against a prior
//     $950,000 ask it manufactured an $830,000 concession the seller never
//     made, which is authority input for the offer engine.
//
//  2. CLASSIFICATION (monetary-understanding.js) never produced a per-unit
//     signal for the natural phrasings in the first place. The tokenizer's
//     amount span absorbs its own leading separator (" 120k"), so a cue BEFORE
//     the amount measured flush against it (gap 0) while a cue AFTER paid for
//     its own space (gap 1). Every trailing modifier lost to a leading intent
//     verb: "I want 120k per door" read as an absolute asking price, and
//     "I want 1450 a month" read a rent as a $1,450 house — the exact misread
//     the MONTHLY_AMOUNT cue list exists to prevent.
//
// Absolute asks must be completely unaffected.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAskingPriceSignal,
  extractMonetaryMentions,
  MONETARY_KINDS,
} from "@/lib/domain/seller-flow/monetary-understanding.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";

const NOW = "2030-06-10T01:20:08.000Z";

function signalFor(message, { negotiationActive = false } = {}) {
  return resolveAskingPriceSignal(message, { negotiationActive, now: NOW });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. CLASSIFICATION — a trailing modifier outranks a leading intent verb
// ════════════════════════════════════════════════════════════════════════════

test("a per-unit quote keeps its kind even behind a leading ask verb", () => {
  for (const message of [
    "I want 120k per door",
    "I need 120k per unit",
    "asking 120k per door",
    "I want 120k each unit",
  ]) {
    const [mention] = extractMonetaryMentions(message, {});
    assert.equal(mention.kind, MONETARY_KINDS.PER_UNIT_PRICE, message);
    assert.equal(mention.qualifiers.per_unit, true, message);
    assert.equal(mention.value, 120_000, message);
  }
});

test("the same bias hid every other trailing modifier, not just per-unit", () => {
  const cases = [
    ["I want 1450 a month", MONETARY_KINDS.MONTHLY_AMOUNT],
    ["I want 300k net", MONETARY_KINDS.NET_REQUIREMENT],
    ["I want 500k for both", MONETARY_KINDS.PACKAGE_PRICE],
  ];
  for (const [message, kind] of cases) {
    const [mention] = extractMonetaryMentions(message, {});
    assert.equal(mention.kind, kind, message);
  }
});

test("a leading cue still wins when it is genuinely nearer", () => {
  const mentions = extractMonetaryMentions("I owe 60k but I want 110k per unit", {});
  assert.equal(mentions[0].value, 60_000);
  assert.equal(mentions[0].kind, MONETARY_KINDS.MORTGAGE_PAYOFF, "the payoff stays a payoff");
  assert.equal(mentions[1].value, 110_000);
  assert.equal(mentions[1].kind, MONETARY_KINDS.PER_UNIT_PRICE);
});

test("plain absolute asks are untouched", () => {
  for (const [message, value] of [
    ["I want 1.5 million", 1_500_000],
    ["asking 250k", 250_000],
    ["I want 150 mil", 150_000],
  ]) {
    const [mention] = extractMonetaryMentions(message, {});
    assert.equal(mention.kind, MONETARY_KINDS.ASKING_PRICE, message);
    assert.equal(mention.value, value, message);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. INGESTION — per-unit × units, never per-unit verbatim
// ════════════════════════════════════════════════════════════════════════════

test('"120k per door" on 8 units is a $960,000 property ask at $120,000 a door', () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    units_count: 8,
    now: NOW,
  });

  assert.equal(state.current_asking_price, 960_000, "the ask is the whole property");
  assert.equal(state.asking_price_per_unit, 120_000, "the per-door figure is what he said");
  assert.equal(state.units_count, 8);
  assert.equal(state.initial_asking_price, 960_000);
  assert.notEqual(state.current_asking_price, 120_000, "never the raw per-unit number");
  assert.notEqual(state.asking_price_per_unit, 15_000, "never divided a second time");
});

test("the conversion is recorded on the history entry, not applied silently", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    units_count: 8,
    now: NOW,
  });

  const [entry] = state.asking_price_history;
  assert.equal(entry.value, 960_000);
  assert.equal(entry.price_type, "per_unit");
  assert.equal(entry.quoted_per_unit_value, 120_000);
  assert.equal(entry.units_multiplier, 8);
});

test("no concession is fabricated against a prior absolute ask", () => {
  const first = applyNegotiationTurn(null, {
    price_signal: signalFor("I'm asking 950,000"),
    units_count: 8,
    now: NOW,
  });
  assert.equal(first.current_asking_price, 950_000, "the absolute ask is unchanged");

  const second = applyNegotiationTurn(first, {
    price_signal: signalFor("I want 120k per door", { negotiationActive: true }),
    units_count: 8,
    now: NOW,
  });

  assert.equal(second.current_asking_price, 960_000);
  assert.deepEqual(second.seller_concessions, [], "the seller conceded nothing — he went UP");
  assert.equal(second.cumulative_concession_amount, 0);
  assert.equal(second.cumulative_concession_percentage, 0);
});

test("a genuine per-unit reduction still records a real concession", () => {
  const first = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    units_count: 8,
    now: NOW,
  });
  const second = applyNegotiationTurn(first, {
    price_signal: signalFor("ok, 110k per door", { negotiationActive: true }),
    units_count: 8,
    now: NOW,
  });

  assert.equal(second.current_asking_price, 880_000);
  assert.equal(second.asking_price_per_unit, 110_000);
  assert.equal(second.seller_concessions.length, 1);
  assert.equal(second.seller_concessions[0].amount, 80_000, "8 doors × $10k, not $10k");
  assert.equal(second.seller_concessions[0].from, 960_000);
  assert.equal(second.seller_concessions[0].to, 880_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. UNKNOWN UNITS — clarify, never guess a multiplier
// ════════════════════════════════════════════════════════════════════════════

test("a per-door ask with unknown units sets NO ask and asks for clarification", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    now: NOW,
  });

  assert.equal(state.current_asking_price, null, "no property ask can be derived");
  assert.equal(state.initial_asking_price, null);
  assert.deepEqual(state.asking_price_history, [], "nothing enters the ledger");
  assert.equal(state.asking_price_needs_clarification, true);
  assert.equal(state.asking_price_clarification_reason, "per_unit_price_units_unknown");
  assert.equal(state.human_review_reason, "per_unit_price_units_unknown");
});

test("a single-unit property cannot silently absorb a per-door quote", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    units_count: 1,
    now: NOW,
  });
  assert.equal(state.current_asking_price, null);
  assert.equal(state.asking_price_needs_clarification, true);
});

test("no concession or authority math runs on an unresolvable per-unit number", () => {
  const first = applyNegotiationTurn(null, {
    price_signal: signalFor("I'm asking 950,000"),
    now: NOW,
  });
  const second = applyNegotiationTurn(first, {
    price_signal: signalFor("I want 120k per door", { negotiationActive: true }),
    now: NOW,
  });

  assert.equal(second.current_asking_price, 950_000, "the prior ask stands untouched");
  assert.deepEqual(second.seller_concessions, []);
  assert.equal(second.negotiation_round, first.negotiation_round, "no counter was recorded");
  assert.equal(second.asking_price_needs_clarification, true);
});

test("the clarification verdict is per-turn and never inherited", () => {
  const flagged = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 120k per door"),
    now: NOW,
  });
  assert.equal(flagged.asking_price_needs_clarification, true);

  const resolved = applyNegotiationTurn(flagged, {
    price_signal: signalFor("sorry — 960,000 for the building"),
    now: NOW,
  });
  assert.equal(resolved.asking_price_needs_clarification, false);
  assert.equal(resolved.asking_price_clarification_reason, null);
  assert.equal(resolved.current_asking_price, 960_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. ABSOLUTE ASKS — unchanged, including the 15-unit acceptance shape
// ════════════════════════════════════════════════════════════════════════════

test("an absolute $1.5M ask on 15 units is unchanged and derives $100k a door", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 1.5 million"),
    units_count: 15,
    now: NOW,
  });

  assert.equal(state.current_asking_price, 1_500_000, "absolute means absolute");
  assert.equal(state.asking_price_per_unit, 100_000);
  assert.equal(state.units_count, 15);
  assert.equal(state.asking_price_needs_clarification, false);
});

test("an absolute ask on a property with unknown units still records the ask", () => {
  const state = applyNegotiationTurn(null, {
    price_signal: signalFor("I want 1.5 million"),
    now: NOW,
  });
  assert.equal(state.current_asking_price, 1_500_000);
  assert.equal(state.asking_price_per_unit, null, "never fabricated");
  assert.equal(state.asking_price_needs_clarification, false);
});
