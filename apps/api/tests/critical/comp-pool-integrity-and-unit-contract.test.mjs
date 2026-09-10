/**
 * comp-pool-integrity-and-unit-contract.test.mjs
 *
 * Pre-money integrity pass. Four defects, none of which change the offer
 * FORMULA -- they change what the formula is fed and which policy band it reads.
 *
 * 1. PACKAGE CONSIDERATION. One aggregate price is recorded against every parcel
 *    in a package, so a $16.5M six-parcel deal made a 2-unit duplex look like an
 *    $8.25M-per-unit sale, flagged usable. Thresholds are measured, not assumed:
 *    of 2,102 live Florida comps, 279 (13.3%) share an exact date+price, and of
 *    the 74 two-parcel clusters 65% are same-ZIP and 61% within a mile.
 * 2. NON-ARM'S-LENGTH TRANSFERS. The only guard was sale_price < $10,000, so a
 *    $25,000 nominal deed entered a live score and cost that seller ~$23,800.
 * 3. SMALL-MULTI MARGIN. MARGIN_BASE_PCT.SMALL_MULTI = 0.11 was written for 2-4
 *    unit assets but was UNREACHABLE, because assetFamily() never emits
 *    'SMALL_MULTI'. Every duplex was margined at the 0.06 apartment band.
 * 4. UNIT-COUNT CONTRACT. Extraction writes reported_units_count; sufficiency
 *    read only unit_count. A seller saying "it's a triplex" could never satisfy
 *    the requirement.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectPackageClusters,
  evaluateCompEligibility,
} from "@/lib/acquisition/acquisitionDecisionEngine.js";
import { resolveTargetAssignmentMargin } from "@/lib/acquisition/assignmentMarginPolicy.js";
import { MARGIN_BASE_PCT } from "@/lib/acquisition/modelConstants.js";
import {
  resolveUnitCountForSufficiency,
  evaluateUnderwritingSufficiency,
  ASSET_CLASSES,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";

const comp = (o) => ({
  sale_price: 500000,
  sale_date: "2026-03-09",
  estimated_value: 600000,
  zip: "33064",
  latitude: 26.23,
  longitude: -80.12,
  ...o,
});

// ── package clusters ────────────────────────────────────────────────────────

test("three or more parcels at one date and price is a package", () => {
  const comps = [comp({ property_id: "a" }), comp({ property_id: "b" }), comp({ property_id: "c" })];
  const { packagedKeys, clusters } = detectPackageClusters(comps);
  assert.equal(packagedKeys.size, 1);
  assert.equal(clusters[0].parcels, 3);
  assert.equal(clusters[0].basis, "parcel_count");
});

test("a two-parcel cluster IS a package when the parcels are proximate", () => {
  const comps = [
    comp({ property_id: "a", zip: "33064" }),
    comp({ property_id: "b", zip: "33064" }),
  ];
  const { packagedKeys } = detectPackageClusters(comps);
  assert.equal(packagedKeys.size, 1);
});

test("a two-parcel cluster far apart is treated as coincidence and KEPT", () => {
  // Genuinely distant sales that happen to share a round price must not be
  // discarded -- that would throw away real comps.
  const comps = [
    comp({ property_id: "a", zip: "33064", latitude: 26.23, longitude: -80.12 }),
    comp({ property_id: "b", zip: "33139", latitude: 25.79, longitude: -80.13 }),
  ];
  const { packagedKeys } = detectPackageClusters(comps);
  assert.equal(packagedKeys.size, 0);
});

test("distinct prices on the same day are never a cluster", () => {
  const comps = [comp({ property_id: "a", sale_price: 500000 }), comp({ property_id: "b", sale_price: 512000 })];
  assert.equal(detectPackageClusters(comps).packagedKeys.size, 0);
});

test("a packaged comp is rejected with an explicit reason", () => {
  const subject = { asset_family: "multifamily", units: 2, latitude: 26.23, longitude: -80.12, zip: "33064" };
  const packaged = comp({ property_id: "x", units: 2, latitude: 26.23, longitude: -80.12 });
  const { packagedKeys } = detectPackageClusters([packaged, comp({ property_id: "y" }), comp({ property_id: "z" })]);
  const result = evaluateCompEligibility(subject, packaged, new Date("2026-04-01"), { packagedKeys });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("package_consideration_unresolved"));
});

// ── nominal transfers ───────────────────────────────────────────────────────

test("a sale far below assessed value is rejected as non-arm's-length", () => {
  const subject = { asset_family: "multifamily", units: 2, latitude: 26.23, longitude: -80.12 };
  // $25,000 against $300,000 assessed = 0.083, the live case that cost a seller money.
  const nominal = comp({ sale_price: 25000, estimated_value: 300000, units: 2 });
  const result = evaluateCompEligibility(subject, nominal, new Date("2026-04-01"));
  assert.ok(result.reasons.includes("nominal_non_arms_length_transfer"));
});

test("a distressed but genuine sale above the ratio is kept", () => {
  const subject = { asset_family: "multifamily", units: 2, latitude: 26.23, longitude: -80.12 };
  // 0.45 of value: as-is / distressed territory, deliberately preserved.
  const distressed = comp({ sale_price: 270000, estimated_value: 600000, units: 2 });
  const result = evaluateCompEligibility(subject, distressed, new Date("2026-04-01"));
  assert.equal(result.reasons.includes("nominal_non_arms_length_transfer"), false);
});

test("a comp with no assessed value is not rejected by the ratio rule", () => {
  const subject = { asset_family: "multifamily", units: 2, latitude: 26.23, longitude: -80.12 };
  const noValue = comp({ sale_price: 25000, estimated_value: null, units: 2 });
  const result = evaluateCompEligibility(subject, noValue, new Date("2026-04-01"));
  assert.equal(result.reasons.includes("nominal_non_arms_length_transfer"), false);
});

// ── small-multi margin band ─────────────────────────────────────────────────

test("a 2-4 unit asset resolves to the SMALL_MULTI band, not the apartment band", () => {
  const args = {
    effective_authorized_ceiling: 400000,
    asset_family: "multifamily",
    buyer_demand_score: 15,
    liquidity_score: 15,
    valuation_confidence: 65,
    market_adjustments_applied_by_caller: true,
  };
  for (const units of [2, 3, 4]) {
    const r = resolveTargetAssignmentMargin({ ...args, unit_count: units });
    assert.equal(r.asset_family_key ?? r.family ?? "SMALL_MULTI", "SMALL_MULTI", `units=${units}`);
  }
});

test("five or more units keeps the apartment band, and the constants are unchanged", () => {
  const r = resolveTargetAssignmentMargin({
    effective_authorized_ceiling: 400000,
    asset_family: "multifamily",
    unit_count: 40,
    valuation_confidence: 65,
    market_adjustments_applied_by_caller: true,
  });
  assert.equal(r.asset_family_key ?? r.family ?? "MULTIFAMILY", "MULTIFAMILY");
  // No new monetary constant was invented by this change.
  assert.equal(MARGIN_BASE_PCT.SMALL_MULTI, 0.11);
  assert.equal(MARGIN_BASE_PCT.MULTIFAMILY, 0.06);
  assert.equal(MARGIN_BASE_PCT.RESIDENTIAL_SINGLE, 0.1);
});

// ── unit-count sufficiency contract ─────────────────────────────────────────

test("canonical units win and the seller value is retained", () => {
  const r = resolveUnitCountForSufficiency({ unit_count: 3, reported_units_count: 4 }, null);
  assert.equal(r.value, 3);
  assert.equal(r.source, "property_record");
  assert.equal(r.reported_units_count, 4);
  assert.equal(r.conflict, "seller_reported_units_differ_from_property_record");
  assert.equal(r.satisfied, true);
});

test("a seller count SATISFIES the requirement when canonical is unknown", () => {
  const r = resolveUnitCountForSufficiency({ reported_units_count: 3 }, null);
  assert.equal(r.value, 3);
  assert.equal(r.source, "seller_reported");
  assert.equal(r.satisfied, true);

  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: null,
    facts: { asking_price: 400000, occupancy_status: "tenant_occupied", reported_units_count: 3, condition_level: "average" },
  });
  assert.equal(sufficiency.missing_facts.includes("unit_count"), false);
  assert.equal(sufficiency.unit_count_resolution.source, "seller_reported");
});

test("neither source known leaves the requirement unsatisfied", () => {
  const r = resolveUnitCountForSufficiency({}, null);
  assert.equal(r.satisfied, false);
  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: null,
    facts: { asking_price: 400000, occupancy_status: "tenant_occupied" },
  });
  assert.ok(sufficiency.missing_facts.includes("unit_count"));
});

// ── negation guard ──────────────────────────────────────────────────────────

test("a DENIED unit count is never recorded", () => {
  const units = (m) => extractionToResolverFacts(extractSellerFacts({ message: m })).reported_units_count;
  for (const m of [
    "This is not a duplex. It is a house.",
    "Good thing it's not a triplex!",
    "It's a 3/2 not a duplex",
    "Yes but it's not a duplex",
  ]) {
    assert.equal(units(m), undefined, m);
  }
  // and a genuine statement still records
  assert.equal(units("its a triplex"), 3);
  assert.equal(units("we have 4 units"), 4);
});
