import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  VALUATION_AUTHORITY_VERSION,
  VALUATION_METHODS,
  normalizeOfferConfidence,
  resolveUnitsCount,
  resolveValuationMethod,
  resolveValuationAuthority,
} from "@/lib/domain/underwriting/valuation-authority.js";

// Plausible persisted ADE V2 score row (metadata.ade_snapshot shape).
const ADE = Object.freeze({
  valuation_low: 1_300_000,
  valuation_mid: 1_500_000,
  valuation_high: 1_650_000,
  valuation_confidence: 80, // ADE-native 0–100 scale
  comp_count: 6,
  investor_ceiling_mid: 1_200_000,
  investor_ceiling_high: 1_280_000,
  buyer_demand_score: 62,
  liquidity_score: 55,
  estimated_repairs: 150_000,
  recommended_cash_offer: 1_050_000,
  minimum_acceptable_offer: 1_000_000,
  evidence: { engine: { name: "acquisition_decision_engine", version: "2.0.0" } },
});

// ─── confidence scale: ONE 0–1 scale at the boundary ────────────────────────

test("normalizeOfferConfidence converts ADE 0–100 and passes 0–1 through", () => {
  assert.equal(normalizeOfferConfidence(80), 0.8);
  assert.equal(normalizeOfferConfidence(30), 0.3);
  assert.equal(normalizeOfferConfidence(0.8), 0.8);
  assert.equal(normalizeOfferConfidence(0.3), 0.3);
  assert.equal(normalizeOfferConfidence(1), 1); // full confidence on the 0–1 scale
  assert.equal(normalizeOfferConfidence(100), 1);
  assert.equal(normalizeOfferConfidence(150), 1); // clamped
  assert.equal(normalizeOfferConfidence(-5), 0);
  assert.equal(normalizeOfferConfidence(null), null, "unknown stays unknown, never passes a gate");
  assert.equal(normalizeOfferConfidence("not-a-number"), null);
});

// ─── method routing by unit count / asset class ─────────────────────────────

test("method routing: units dominate — 5+ ⇒ price per unit, 2–4 ⇒ PPU+PPSF, else SFR", () => {
  assert.equal(resolveValuationMethod({ units_count: 15 }), VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT);
  assert.equal(resolveValuationMethod({ units_count: 5 }), VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT);
  assert.equal(resolveValuationMethod({ units_count: 4 }), VALUATION_METHODS.SMALL_MULTI_PPU_PPSF);
  assert.equal(resolveValuationMethod({ units_count: 2 }), VALUATION_METHODS.SMALL_MULTI_PPU_PPSF);
  assert.equal(resolveValuationMethod({ units_count: 1 }), VALUATION_METHODS.SFR_COMP_PPSF_ARV);
  assert.equal(resolveValuationMethod({}), VALUATION_METHODS.SFR_COMP_PPSF_ARV);
});

test("method routing: property-type hints only decide when units are unknown", () => {
  assert.equal(
    resolveValuationMethod({ property_type: "Apartment Building" }),
    VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT
  );
  assert.equal(resolveValuationMethod({ property_type: "Duplex" }), VALUATION_METHODS.SMALL_MULTI_PPU_PPSF);
  assert.equal(
    resolveValuationMethod({ units_count: 1, property_type: "Apartment Building" }),
    VALUATION_METHODS.SFR_COMP_PPSF_ARV,
    "an explicit unit count outranks the type string"
  );
});

test("resolveUnitsCount reads units_count/unit_count/units across property, facts, ADE subject", () => {
  assert.equal(resolveUnitsCount({ property: { units_count: 15 } }), 15);
  assert.equal(resolveUnitsCount({ property: { unit_count: 3 } }), 3);
  assert.equal(resolveUnitsCount({ facts: { unit_count: 8 } }), 8);
  assert.equal(
    resolveUnitsCount({ ade_snapshot: { evidence: { subject: { normalized_features: { units: 12 } } } } }),
    12
  );
  assert.equal(resolveUnitsCount({}), null);
});

// ─── canonical contract from the live engine ────────────────────────────────

test("§6: ADE snapshot normalizes into the full canonical contract", () => {
  const authority = resolveValuationAuthority({
    property: { units_count: 15, property_type: "Multifamily" },
    ade_snapshot: ADE,
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT);
  assert.equal(authority.estimated_value_low, 1_300_000);
  assert.equal(authority.estimated_value_mid, 1_500_000);
  assert.equal(authority.estimated_value_high, 1_650_000);
  assert.equal(authority.target_acquisition_price, 1_050_000);
  assert.equal(authority.maximum_acquisition_price, 1_200_000, "ceiling = investor_ceiling_mid, matching live negotiation-state ingestion");
  assert.equal(authority.initial_offer, 1_000_000);
  assert.equal(authority.offer_confidence, 0.8, "0–100 converted at the boundary");
  assert.equal(authority.buyer_demand, 62);
  assert.equal(authority.liquidity, 55);
  assert.equal(authority.supporting_comp_count, 6);
  assert.equal(authority.units_count, 15);
  assert.equal(authority.estimated_value_per_unit, 100_000);
  assert.equal(authority.maximum_acquisition_price_per_unit, 80_000);
  assert.equal(authority.calculation_version, "ade_2.0.0/valuation_authority_1.0.0");
  assert.deepEqual(authority.reason_codes, []);
  assert.equal(authority.version, VALUATION_AUTHORITY_VERSION);
});

test("§6: initial_offer falls back to the recommended offer when no band minimum exists", () => {
  const authority = resolveValuationAuthority({
    ade_snapshot: { ...ADE, minimum_acceptable_offer: null },
  });
  assert.equal(authority.initial_offer, 1_050_000);
});

test("§6: ceiling falls back to investor_ceiling_high exactly like the live reducer", () => {
  const authority = resolveValuationAuthority({
    ade_snapshot: { ...ADE, investor_ceiling_mid: null },
  });
  assert.equal(authority.maximum_acquisition_price, 1_280_000);
});

// ─── fail-closed paths — never fabricated numbers ───────────────────────────

test("fail closed: no ADE snapshot ⇒ insufficient_data + valuation_authority_absent, all authority null", () => {
  const authority = resolveValuationAuthority({ property: { units_count: 15 } });
  assert.equal(authority.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.deepEqual(authority.reason_codes, ["valuation_authority_absent"]);
  assert.equal(authority.target_acquisition_price, null);
  assert.equal(authority.maximum_acquisition_price, null);
  assert.equal(authority.initial_offer, null);
  assert.equal(authority.offer_confidence, null);
  assert.equal(authority.calculation_version, "ade_none/valuation_authority_1.0.0");
});

test("fail closed: engine ran but produced no offer band ⇒ insufficient_data, estimates reported, authority null", () => {
  const authority = resolveValuationAuthority({
    ade_snapshot: { ...ADE, recommended_cash_offer: null },
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.ok(authority.reason_codes.includes("ade_authority_incomplete"));
  assert.equal(authority.estimated_value_mid, 1_500_000, "real estimates are evidence, not fabrication");
  assert.equal(authority.target_acquisition_price, null);
  assert.equal(authority.maximum_acquisition_price, null);
});

test("fail closed: ADE confidence 30 (0–100 scale) is BELOW the 0.45 policy floor ⇒ review", () => {
  const authority = resolveValuationAuthority({
    ade_snapshot: { ...ADE, valuation_confidence: 30 },
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.ok(authority.reason_codes.includes("valuation_confidence_below_policy"));
  assert.equal(authority.offer_confidence, 0.3);
  assert.equal(authority.maximum_acquisition_price, null, "low confidence authorizes nothing");
});

test("ADE confidence 80 (0–100 scale) passes the policy floor", () => {
  const authority = resolveValuationAuthority({ ade_snapshot: { ...ADE, valuation_confidence: 80 } });
  assert.equal(authority.valuation_method, VALUATION_METHODS.SFR_COMP_PPSF_ARV);
  assert.equal(authority.offer_confidence, 0.8);
  assert.equal(authority.maximum_acquisition_price, 1_200_000);
});

test("fail closed: unknown confidence never passes the gate", () => {
  const authority = resolveValuationAuthority({
    ade_snapshot: { ...ADE, valuation_confidence: null },
  });
  assert.equal(authority.valuation_method, VALUATION_METHODS.INSUFFICIENT_DATA);
  assert.ok(authority.reason_codes.includes("valuation_confidence_unknown"));
});

test("thin comp support annotates but does not invalidate ADE authority", () => {
  const authority = resolveValuationAuthority({ ade_snapshot: { ...ADE, comp_count: 2 } });
  assert.ok(authority.reason_codes.includes("comp_support_thin"));
  assert.equal(authority.maximum_acquisition_price, 1_200_000);
});
