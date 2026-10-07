// Reach's per-filter "why" (2026-10-07 composer filter audit): every applied
// filter shows the rows it removed, eligible rows after it and its column
// coverage; every filter that could not be applied is listed with its reason.
import test from "node:test";
import assert from "node:assert/strict";
import { measureCampaignFilterEffects } from "@/lib/domain/campaigns/campaign-automation-service.js";

const ROWS = [
  { graph_id: "a1", property_id: "p1", market: "Dallas, TX", building_condition: "Poor", queue_eligible: true },
  { graph_id: "a2", property_id: "p2", market: "Dallas, TX", building_condition: "Average", queue_eligible: true },
  { graph_id: "a3", property_id: "p3", market: "Dallas, TX", building_condition: null, queue_eligible: false },
  { graph_id: "a4", property_id: "p4", market: "Dallas, TX", building_condition: null, queue_eligible: true },
  { graph_id: "b1", property_id: "p5", market: "Tulsa, OK", building_condition: "Poor", queue_eligible: true },
];

function fakeSupabase() {
  return {
    from() {
      const preds = [];
      const q = {
        select() { return q; },
        eq(c, v) { preds.push((r) => r[c] === v); return q; },
        in(c, vs) { preds.push((r) => vs.includes(r[c])); return q; },
        is(c, v) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
        not(c, op, v) {
          if (op === "is" && v === null) preds.push((r) => r[c] != null);
          else if (op === "in") { const vs = String(v).replace(/[()"]/g, "").split(","); preds.push((r) => !vs.includes(String(r[c]))); }
          return q;
        },
        gte(c, v) { preds.push((r) => r[c] >= v); return q; },
        lte(c, v) { preds.push((r) => r[c] <= v); return q; },
        filter() { return q; },
        or() { return q; },
        ilike() { return q; },
        then(resolve, reject) {
          const count = ROWS.filter((r) => preds.every((p) => p(r))).length;
          return Promise.resolve({ data: null, count, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const spec = (properties) => ({ filters: { properties, prospects: [], master_owners: [], phones: [], outreach: [], sender_coverage: [] } });

test("each filter reports rows removed, eligible after, and coverage of its column", async () => {
  const result = await measureCampaignFilterEffects(spec([
    { field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] },
    { field_key: "properties.building_condition", operator: "is_any_of", value: ["Poor"] },
  ]), { supabase: fakeSupabase(), graphColumnPopulation: new Map() });
  assert.equal(result.ok, true);
  assert.equal(result.base_count, 5);
  assert.equal(result.universe_count, 4);
  const [market, condition] = result.effects;
  assert.equal(market.stage, "location");
  assert.equal(market.removed, 1);
  assert.equal(market.count_after, 4);
  assert.equal(condition.stage, "targeting");
  assert.equal(condition.count_after, 1);
  assert.equal(condition.removed, 3);
  assert.equal(condition.eligible_after, 1);
  // 2 of the 4 Dallas properties have any building condition at all
  assert.deepEqual(condition.coverage, { with_value: 2, of: 4, pct: 50 });
  assert.equal(result.final_count, 1);
});

test("a filter that can't be applied is listed with its reason, never silently dropped", async () => {
  const result = await measureCampaignFilterEffects(spec([
    { field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] },
    { field_key: "properties.zoning", operator: "is_any_of", value: ["R1"] },
    { field_key: "properties.rehab_level", operator: "is_any_of", value: [] },
  ]), { supabase: fakeSupabase(), graphColumnPopulation: new Map() });
  const keys = result.refused.map((r) => r.field_key);
  assert.ok(keys.includes("properties.zoning"), "unmapped field is refused by name");
  assert.ok(keys.includes("properties.rehab_level"), "a filter without a value is listed");
  for (const r of result.refused) assert.match(r.message, /Not applied/);
  assert.equal(result.effects.length, 1);
});
