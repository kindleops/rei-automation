import test from "node:test";
import assert from "node:assert/strict";

import { annotateMarketSale } from "../../src/lib/domain/intelligence/transactions/market-sales-provenance.js";
import { mvRowToSale, poolRowToSale } from "../../scripts/intelligence/baselines/extract-market-sales.mjs";
import { investorActivityStat } from "../../src/lib/domain/intelligence/features/market-investor-activity.js";
import { PIT_COLLECTIONS } from "../../src/lib/domain/intelligence/features/pit.js";

const mv = (over = {}) => ({ txn_id: 1, property_id: "p1", event_date: "2026-05-01", corpus: "comp_corpus", zip: "75216", lat: 32.7, lng: -96.8, buyer_kind: "company", buyer_archetype: null, state: "TX", price: 60000, price_code: "Estimated Sales Price", corpus_value: 300000, nominal_price: true, ...over });

test("a Texas vendor-estimate deed flagged nominal by the MV stays an activity event (weak price is not a reason to drop)", () => {
  const sale = mvRowToSale(mv());
  assert.equal(sale.nominal_price, false);
  assert.equal(sale.price_confidence, "LOW");
  assert.equal(sale.price_is_estimated, true);
  assert.equal(sale.transaction_reliable, true);
});

test("a truly nominal deed with a RELIABLE price is still nominal ($1 / $10 transfer in a disclosure state)", () => {
  const one = mvRowToSale(mv({ state: "FL", zip: "32209", price: 10, price_code: "Full amount stated on Document.", corpus_value: 180000 }));
  assert.equal(one.price_confidence, "HIGH");
  assert.equal(one.nominal_price, true);
  assert.equal(one.price_nominal_reliable, true);
  const lowRatio = mvRowToSale(mv({ state: "FL", price: 30000, price_code: null, corpus_value: 300000 }));
  assert.equal(lowRatio.nominal_price, true, "< 25% of corpus value with a reliable price");
  const market = mvRowToSale(mv({ state: "FL", price: 280000, price_code: null }));
  assert.equal(market.nominal_price, false);
});

test("pool rows: $0 placeholders in TX/MO are kept; a reliable < $10K pool price is nominal", () => {
  const tx = poolRowToSale({ id: "u1", property_id: "p2", property_address_state: "TX", property_address_zip: "75216", latitude: 32.7, longitude: -96.8, sale_date: "2026-04-01", sale_source: "Public Record Sold", sale_price: 0, mls_sold_price: null });
  assert.equal(tx.nominal_price, false);
  assert.equal(tx.price_confidence, "UNKNOWN");
  const mn = poolRowToSale({ id: "u2", property_id: "p3", property_address_state: "MN", property_address_zip: "55412", latitude: 45, longitude: -93.3, sale_date: "2026-04-01", sale_source: "Public Record Sold", sale_price: 5000, mls_sold_price: null });
  assert.equal(mn.nominal_price, true);
  const mls = poolRowToSale({ id: "u3", property_id: "p4", property_address_state: "TX", property_address_zip: "75216", latitude: 32.7, longitude: -96.8, sale_date: "2026-04-01", mls_sold_date: "2026-04-01", sale_source: "MLS Sold", sale_price: 219696, mls_sold_price: 219696 });
  assert.equal(mls.price_source, "MLS");
  assert.equal(mls.price_confidence, "LOW");
});

test("the provenance fields pass the market_sales PIT projection", () => {
  for (const f of ["price_source", "price_confidence", "price_verified", "price_is_estimated", "price_record_id", "transaction_reliable", "price_nominal_reliable", "nominal_price"]) {
    assert.equal(PIT_COLLECTIONS.market_sales.fields[f], "value", f);
  }
});

test("investor activity now counts Texas investor purchases whose price is only an estimate", () => {
  const asOf = Date.parse("2026-07-01T00:00:00Z");
  const property = { property_address_zip: "75216", latitude: 32.7, longitude: -96.8 };
  const sales = [
    mvRowToSale(mv({ txn_id: 1, property_id: "a" })),
    mvRowToSale(mv({ txn_id: 2, property_id: "b", buyer_kind: "person", price: 50000 })),
    mvRowToSale(mv({ txn_id: 3, property_id: "c", price: null, price_code: null })),
  ];
  const stat = (metric) => investorActivityStat({ asOf, property, sales, geography: "zip", months: 3, metric });
  assert.equal(stat("count"), 2, "both company buyers counted, priced or not");
  assert.equal(stat("share"), 0.666667);
  const before = sales.map((s, i) => ({ ...s, nominal_price: i < 2 })); // old rule: estimate < 25% of value => dropped
  assert.equal(investorActivityStat({ asOf, property, sales: before, geography: "zip", months: 3, metric: "count" }), 1);
});

test("annotateMarketSale: an undated transaction is not reliable as an event", () => {
  assert.equal(annotateMarketSale(mv(), { corpus: "comp_corpus", saleDate: null }).transaction_reliable, false);
});
