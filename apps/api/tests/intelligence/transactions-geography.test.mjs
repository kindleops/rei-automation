import test from "node:test";
import assert from "node:assert/strict";

import { resolveTransactionGeography } from "../../src/lib/domain/intelligence/transactions/geography.js";

const zipMarket = (z) => ({ "33147": "miami-fl", "38109": "memphis-tn" })[z] ?? null;

test("fips first: state from the FIPS prefix even without any property row", () => {
  const g = resolveTransactionGeography({ txn: { fips: "48113" }, zipMarket });
  assert.equal(g.state, "TX");
  assert.equal(g.fips, "48113");
  assert.equal(g.geo_source, "fips");
});

test("fips NULL (seller corpus): the properties join places Miami and Memphis", () => {
  const miami = resolveTransactionGeography({
    txn: { fips: null },
    property: { property_address_state: "FL", property_address_county_name: "Miami-Dade County", property_address_zip: "33147", canonical_market_id: "miami-fl" },
    zipMarket,
  });
  assert.deepEqual([miami.state, miami.county, miami.canonical_market_id, miami.geo_source, miami.market_source], ["FL", "MIAMI-DADE", "miami-fl", "property", "properties"]);
  const memphis = resolveTransactionGeography({ txn: {}, property: { property_address_state: "TN", property_address_county_name: "Shelby", property_address_zip: "38109" }, zipMarket });
  assert.equal(memphis.canonical_market_id, "memphis-tn", "market falls back to the ZIP membership");
  assert.equal(memphis.market_source, "zip5");
});

test("zip5 last; nothing at all is counted as unattributed, never dropped", () => {
  assert.equal(resolveTransactionGeography({ txn: { zip5: "3314" }, zipMarket }).zip5, "03314");
  const z = resolveTransactionGeography({ txn: { zip5: "38109" }, zipMarket });
  assert.deepEqual([z.geo_source, z.canonical_market_id], ["zip5", "memphis-tn"]);
  const none = resolveTransactionGeography({ txn: {}, zipMarket });
  assert.deepEqual([none.geo_source, none.market_source, none.state], ["unattributed", "unattributed", null]);
});

test("comp_properties wins over properties for county/zip; fips on comp_properties is used when the txn has none", () => {
  const g = resolveTransactionGeography({ txn: {}, compProperty: { fips: "12086", state: "FL", county_name: "MIAMI-DADE", zip5: "33147" }, property: { canonical_market_id: "miami-fl" }, zipMarket });
  assert.deepEqual([g.fips, g.state, g.county, g.geo_source, g.canonical_market_id], ["12086", "FL", "MIAMI-DADE", "fips", "miami-fl"]);
});

test("county names are unified across providers", async () => {
  const { normalizeCountyName } = await import("../../src/lib/domain/intelligence/transactions/geography.js");
  assert.equal(normalizeCountyName("St. Louis County"), "SAINT LOUIS");
  assert.equal(normalizeCountyName("SAINT LOUIS"), "SAINT LOUIS");
  assert.equal(normalizeCountyName("Saint Louis City"), "SAINT LOUIS CITY");
  assert.equal(normalizeCountyName("De Kalb"), "DEKALB");
  assert.equal(normalizeCountyName("  "), null);
});
