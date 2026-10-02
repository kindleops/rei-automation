import test from "node:test";
import assert from "node:assert/strict";

import * as tsSaleType from "../../../dashboard/src/domain/comp-intelligence/comp-sale-type.ts";
import { INSTITUTIONAL_ARCHETYPES, INVESTOR_ARCHETYPES, buyerClassOf, classifySaleType, isInvestorPurchase } from "../../src/lib/domain/intelligence/features/sale-type.js";
import { MARKET_INVESTOR_ACTIVITY_MEMBERS, investorActivityStat } from "../../src/lib/domain/intelligence/features/market-investor-activity.js";
import { computeFeatureVector } from "../../src/lib/domain/intelligence/features/pit.js";
import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

test("the JS sale-type port agrees with the comps badge (TypeScript original) on the full input matrix", () => {
  const archetypes = [null, "", ...INVESTOR_ARCHETYPES, "some_unknown_archetype"];
  const kinds = [null, "company", "person", "individual", "unknown"];
  let checked = 0;
  for (const buyerArchetype of archetypes) {
    for (const buyerKind of kinds) {
      const ts = tsSaleType.buyerClassOf({ buyerKind, buyerArchetype });
      assert.equal(buyerClassOf({ buyerKind, buyerArchetype }), ts.buyer, `${buyerKind}/${buyerArchetype}`);
      for (const corpus of [null, "engine_pool", "transaction_corpus"]) {
        for (const mls of [null, true, false]) {
          for (const rawSource of [null, "MLS Sold", "Public Record Sold", "Off-Market Sold", "Something Else"]) {
            for (const engineSource of [null, "mls_sold", "public_record_sold", "investor_purchase"]) {
              const input = { corpus, mls, rawSource, engineSource, buyerKind, buyerArchetype };
              assert.equal(classifySaleType(input), tsSaleType.classifySaleType(input).type, JSON.stringify(input));
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 10_000);
  assert.deepEqual([...INSTITUTIONAL_ARCHETYPES], ["institutional_high_volume_buyer"]);
  assert.equal(isInvestorPurchase({ buyerKind: "company" }), true);
  assert.equal(isInvestorPurchase({ buyerKind: "person", buyerArchetype: "active_flipper" }), true);
  assert.equal(isInvestorPurchase({ buyerKind: "person" }), false);
  assert.equal(isInvestorPurchase({ engineSource: "investor_purchase" }), true);
});

const AS_OF = Date.parse("2026-07-15T14:30:00Z");
const DAY = 86_400_000;
const property = { property_address_zip: "55411", latitude: 45.0045, longitude: -93.3 };
const date = (daysAgo) => new Date(AS_OF - daysAgo * DAY).toISOString().slice(0, 10);
// ~0.1 mi (same ~1 km cell), ~1.5 mi and ~5 mi north of the subject
const near = { latitude: 45.006, longitude: -93.3 };
const mid = { latitude: 45.0262, longitude: -93.3 };
const far = { latitude: 45.0765, longitude: -93.3 };
const sale = (id, daysAgo, where, extra = {}) => ({ sale_id: id, property_id: `p-${id}`, sale_date: date(daysAgo), zip: "55411", corpus: "transaction_corpus", ...where, ...extra });

const SALES = [
  sale("a", 30, near, { buyer_kind: "company" }),
  sale("b", 40, near, { buyer_kind: "person" }),
  sale("c", 100, mid, { buyer_kind: "person", buyer_archetype: "active_flipper" }),
  sale("d", 200, near, { buyer_kind: "person" }),
  sale("e", 250, far, { buyer_kind: "company", zip: "55430" }),
  sale("f", 20, near, { buyer_kind: "company", nominal_price: true }), // $1 transfer: not a market sale
  sale("g", -1, near, { buyer_kind: "company" }), // after the decision: invisible
  sale("h", 0, near, { buyer_kind: "company" }), // decision day: not yet knowable
  // the same sale seen in the engine pool: counted once
  { sale_id: "a-pool", property_id: "p-a", sale_date: date(30), zip: "55411", corpus: "engine_pool", ...near, raw_source: "Public Record Sold" },
];

test("investor counts, shares and trends by geography and window", () => {
  const stat = (geography, months, metric) => investorActivityStat({ asOf: AS_OF, property, sales: SALES, geography, months, metric });
  assert.equal(stat("r0_5mi", 3, "count"), 1, "a (b is an individual; f nominal; g/h not before T)");
  assert.equal(stat("r0_5mi", 3, "share"), 0.5);
  assert.equal(stat("r2mi", 6, "count"), 2, "a + c (flipper archetype)");
  assert.equal(stat("r2mi", 12, "share"), 0.5, "a, c of a, b, c, d");
  assert.equal(stat("zip", 12, "count"), 2, "e is in another ZIP");
  assert.equal(stat("cell1km", 12, "count"), 1, "only the nearby cell");
  assert.equal(stat("r2mi", 6, "count_trend"), 2, "2 in the last 6 months, 0 in the prior 6");
  assert.equal(stat("r2mi", 6, "share_trend"), 0.666667, "2/3 in the last 6 months vs 0/1 (sale d) in the prior 6");
  assert.equal(stat("r0_5mi", 6, "share_trend"), 0.5, "a,b in the last 6 months (1/2) vs d (0/1)");
  assert.equal(investorActivityStat({ asOf: AS_OF, property: { property_address_zip: "" }, sales: SALES, geography: "zip", months: 3, metric: "count" }), null);
});

test("the group computes through the PIT harness without leakage and sits in both @2 sets", () => {
  const registry = createV1Registry();
  assert.equal(MARKET_INVESTOR_ACTIVITY_MEMBERS.length, 40);
  for (const setId of ["seller_first_touch@2", "seller_first_touch_all@2"]) {
    const members = registry.getSet(setId).members.map((m) => `${m.key}@${m.version}`);
    for (const id of MARKET_INVESTOR_ACTIVITY_MEMBERS) assert.ok(members.includes(id), `${setId} lacks ${id}`);
    assert.deepEqual(registry.lintSetForFamily(setId, "seller_first_touch_reply"), []);
  }
  const vector = computeFeatureVector({
    registry,
    featureSetId: "seller_first_touch@2",
    entity: { id: "s1", thread_key: "+16125550100", property_id: "p1", sent_at: new Date(AS_OF).toISOString() },
    asOf: AS_OF,
    bundle: { property: { property_id: "p1", property_address_state: "MN", ...property }, market_sales: SALES },
  });
  assert.equal(vector.values["market.investor_purchases_r0_5mi_3m"], 1);
  assert.equal(vector.values["market.investor_share_r2mi_12m"], 0.5);
  assert.ok(Date.parse(vector.max_input_time) < AS_OF, "the decision-day and later sales never entered");
});
