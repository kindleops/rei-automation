import test from "node:test";
import assert from "node:assert/strict";

import { loadPropertySaleRecord, shapeSaleRecord } from "../../src/lib/domain/comp-intelligence/property-sale-record.js";

// The production shape of the defect: comp 3722 Fremont Ave N carries property_id
// 273330226, which has a recorded sale but no `properties` row.
const FREMONT = {
  comp_id: "t:2843935", txn_id: 2843935, source: "public_record", sold_on: "2026-04-03", price: 110000,
  price_source: "recorded_full", is_priced: true, doc_type: "Warranty Deed", is_arms_length: true,
  is_cash_purchase: null, buyer: null, buyer_kind: null, is_investor: false,
  property_id: "273330226", address: "3722 Fremont Ave N, Minneapolis, MN 55412", city: "Minneapolis",
  state: "MN", zip: "55412", lat: 45.022873, lng: -93.29537, property_type: "Single Family",
  beds: 3, baths: 1, sqft: 1473, year_built: 1907, units: 1,
};

function fakeDb(rows, calls = []) {
  const q = {
    _filters: {},
    select(cols) { calls.push(["select", cols]); return q; },
    eq(col, val) { calls.push(["eq", col, val]); q._filters[col] = val; return q; },
    order(col, opts) { calls.push(["order", col, opts]); return q; },
    limit(n) { calls.push(["limit", n]); return Promise.resolve({ data: rows.filter((r) => r.property_id === q._filters.property_id), error: null }); },
  };
  return { from(table) { calls.push(["from", table]); q._filters = {}; return q; } };
}

test("a comp-derived id with recorded sales becomes a labelled sale record, never a property", async () => {
  const calls = [];
  const res = await loadPropertySaleRecord("273330226", { db: fakeDb([FREMONT], calls) });
  assert.equal(res.ok, true);
  assert.equal(res.data.kind, "sale_record");
  assert.equal(res.data.canonical_property, false);
  assert.equal(res.data.address, "3722 Fremont Ave N, Minneapolis, MN 55412");
  assert.deepEqual([res.data.beds, res.data.baths, res.data.sqft, res.data.year_built], [3, 1, 1473, 1907]);
  assert.equal(res.data.sales.length, 1);
  assert.deepEqual(
    { sold_on: res.data.sales[0].sold_on, price: res.data.sales[0].price, price_source: res.data.sales[0].price_source, doc_type: res.data.sales[0].doc_type },
    { sold_on: "2026-04-03", price: 110000, price_source: "recorded_full", doc_type: "Warranty Deed" },
  );
  // no property-record fields are invented
  for (const k of ["owner_name", "master_owner_id", "estimated_value", "equity_amount", "thread_key", "opportunity_id"]) {
    assert.equal(k in res.data, false, k);
  }
  // read-only: one SELECT on the published sales projection, by property_id
  assert.deepEqual(calls.filter((c) => c[0] === "from"), [["from", "mv_map_market_sales"]]);
  assert.deepEqual(calls.find((c) => c[0] === "eq"), ["eq", "property_id", "273330226"]);
});

test("an id with no recorded sale is not found (never a fabricated record)", async () => {
  const res = await loadPropertySaleRecord("999", { db: fakeDb([FREMONT]) });
  assert.equal(res.ok, false);
  assert.equal(res.error, "sale_record_not_found");
  assert.equal(res.data, null);
});

test("sales are newest first, unpriced sales stay unpriced, and rows for other ids are ignored", () => {
  const older = { ...FREMONT, comp_id: "t:1", txn_id: 1, sold_on: "2019-06-01", price: 52000 };
  const unpriced = { ...FREMONT, comp_id: "t:2", txn_id: 2, sold_on: "2024-01-15", price: 1, is_priced: false };
  const other = { ...FREMONT, property_id: "1", comp_id: "t:9" };
  const r = shapeSaleRecord("273330226", [older, FREMONT, unpriced, other]);
  assert.deepEqual(r.sales.map((s) => s.comp_id), ["t:2843935", "t:2", "t:1"]);
  assert.equal(r.sales[1].price, null);
  assert.equal(r.sale_count, 3);
});

test("a missing id is refused without a read", async () => {
  const res = await loadPropertySaleRecord("  ", { db: { from() { throw new Error("must not read"); } } });
  assert.equal(res.error, "missing_property_id");
});
