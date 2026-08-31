import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { scoreProperty } from "@/lib/acquisition/acquisitionDecisionEngine.js";

// FINANCE COMPLETENESS: SOURCE-AWARE APPLICABILITY
//
// Audit finding (2026-08-31): financeCompleteness counted a flat 10-field list
// unconditionally. mls_current_listing_price is populated for 0.1% of the
// estate (market_status_label is 'Off Market' for 123,143 of 123,234 rows), so
// a correctly off-market cash-acquisition subject lost a full 10 points of
// finance completeness -- ~1.5 points of overall confidence -- for the crime of
// not being listed on the MLS.
//
// featurePriority() already had this mechanism for comp features (it returns 0
// for beds/baths/sqft/units on land). The finance leg had none. listing_price
// is NOT deleted from the contract: it stays in the denominator whenever
// listing evidence exists or should exist.

const BASE = Object.freeze({
  property_id: "fin-subject",
  property_type: "Single Family",
  property_class: "Residential",
  property_address_zip: "75060",
  latitude: 32.811161,
  longitude: -96.953984,
  building_square_feet: 1350,
  total_bedrooms: 3,
  total_baths: 2,
  year_built: 1960,
  lot_square_feet: 7200,
  units_count: 1,
  building_condition: "Average",
  estimated_repair_cost: 40000,
  estimated_value: 300000,
  // finance/distress evidence an ordinary off-market record carries
  equity_percent: 100,
  total_loan_balance: 0,
  ownership_years: 15,
  out_of_state_owner: true,
  tax_delinquent: false,
  active_lien: false,
  structured_motivation_score: 45,
  tag_distress_score: 35,
});

async function financeFor(overrides = {}) {
  const r = await scoreProperty("fin-subject", {
    loadSubjectProperty: async () => ({ ...BASE, ...overrides }),
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    persistAcquisitionScore: async (row) => row,
    persistImmutableScoreSnapshot: async () => null,
  });
  assert.equal(r.ok, true, `scoreProperty failed: ${r.error ?? ""}`);
  return r.score.evidence.confidence_breakdown.finance_distress_completeness;
}

test("off-market subject: listing_price is NOT APPLICABLE, not a penalty", () => {
  return financeFor({ market_status_label: "Off Market" }).then((fin) => {
    assert.ok(
      fin.not_applicable.includes("listing_price"),
      "an off-market subject correctly has no MLS listing price"
    );
    assert.ok(
      !fin.missing.includes("listing_price"),
      "and must not be charged for it as missing"
    );
    assert.equal(fin.score, 100, "every applicable field present => full score");
  });
});

test("subject with NO market status at all: still not penalized for listing_price", () => {
  return financeFor({}).then((fin) => {
    // No listing evidence of any kind => listing_price is inapplicable.
    assert.ok(fin.not_applicable.includes("listing_price"));
    assert.ok(fin.missing.includes("market_status"), "market_status itself is still expected");
  });
});

test("LISTED subject: listing_price REMAINS expected evidence", () => {
  return financeFor({ market_status_label: "Active" }).then((fin) => {
    assert.ok(
      !fin.not_applicable.includes("listing_price"),
      "an actively listed subject should have a listing price"
    );
    assert.ok(
      fin.missing.includes("listing_price"),
      "and is correctly charged when it is absent"
    );
    assert.ok(fin.score < 100, "the missing listing price genuinely costs completeness");
  });
});

test("listed subject WITH a listing price scores it as available", () => {
  return financeFor({ market_status_label: "Active", mls_current_listing_price: 315000 }).then((fin) => {
    assert.ok(fin.available.includes("listing_price"));
    assert.ok(!fin.not_applicable.includes("listing_price"));
    assert.equal(fin.score, 100);
  });
});

test("a listing price present WITHOUT a listed status still counts (MLS evidence exists)", () => {
  return financeFor({ mls_current_listing_price: 315000 }).then((fin) => {
    assert.ok(fin.available.includes("listing_price"));
    assert.ok(!fin.not_applicable.includes("listing_price"));
  });
});

test("'Sold' is not a live listing, so listing_price is inapplicable", () => {
  return financeFor({ market_status_label: "Sold" }).then((fin) => {
    assert.ok(fin.not_applicable.includes("listing_price"));
  });
});

test("market_status behaviour is UNCHANGED: still required, still counted", () => {
  return Promise.all([
    financeFor({ market_status_label: "Off Market" }),
    financeFor({}),
  ]).then(([withStatus, withoutStatus]) => {
    assert.ok(withStatus.available.includes("market_status"), "present => available");
    assert.ok(!withStatus.not_applicable.includes("market_status"), "never made optional");
    assert.ok(withoutStatus.missing.includes("market_status"), "absent => missing");
    assert.ok(
      withoutStatus.score < withStatus.score,
      "losing market_status must still cost completeness"
    );
  });
});

test("no other finance field was made optional", () => {
  return financeFor({ market_status_label: "Active" }).then((fin) => {
    assert.deepEqual(
      fin.not_applicable,
      [],
      "only listing_price may ever be inapplicable, and only when unlisted"
    );
  });
});
