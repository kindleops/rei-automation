// Composer value pickers: an empty list always says WHY (2026-10-07 audit).
// "Building Condition → No values found" while properties.building_condition is
// 100 % filled: the facet snapshot simply had no row for the field.
import test from "node:test";
import assert from "node:assert/strict";
import {
  queryCampaignFieldOptions,
  resetExactGraphFieldValuesProbe,
} from "@/lib/domain/campaigns/campaign-field-catalog.js";

function fakeSupabase({ facets = [], rpc = null } = {}) {
  const calls = { rpc: 0 };
  const client = {
    calls,
    from(table) {
      const state = { table, filters: [], head: false, search: null };
      const builder = {
        select(_cols, opts = {}) { state.head = Boolean(opts.head); state.count = opts.count; return builder; },
        eq(column, value) { state.filters.push([column, value]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        ilike(_column, pattern) { state.search = pattern.replace(/%/g, "").toLowerCase(); return builder; },
        then(resolve, reject) {
          let rows = [];
          if (table === "campaign_target_graph_facets") {
            rows = facets.filter((row) => state.filters.every(([c, v]) => row[c] === v));
            if (state.search) rows = rows.filter((row) => row.label.toLowerCase().includes(state.search));
          }
          const result = state.head ? { data: null, count: rows.length, error: null } : { data: rows, count: rows.length, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  if (rpc) {
    client.rpc = async (name, args) => {
      calls.rpc += 1;
      return rpc(name, args);
    };
  }
  return client;
}

const facetRow = (field_key, value, target_count, queueable_count) => ({
  field_key, value, label: value, target_count, queueable_count,
  clean_count: target_count, sender_covered_count: target_count, sms_eligible_count: queueable_count,
});

test("a field the facet snapshot never counted reports not_counted, not an empty success", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({ facets: [facetRow("properties.rehab_level", "Structural", 66033, 30000)] });
  const result = await queryCampaignFieldOptions({ field_key: "properties.building_condition", deps: { supabase } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.options, []);
  assert.equal(result.values_state, "not_counted");
  assert.equal(result.values_source, "facet_snapshot");
  assert.match(result.values_message, /haven’t been counted/);
});

test("options carry the queue-eligible count and say what both numbers mean", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({ facets: [facetRow("properties.property_flags_text", "Vacant Home", 7814, 3740)] });
  const result = await queryCampaignFieldOptions({ field_key: "properties.property_flags_text", deps: { supabase } });
  assert.equal(result.values_state, "ok");
  assert.equal(result.options[0].count, 7814);
  assert.equal(result.options[0].queueable_count, 3740);
  assert.match(result.count_basis.count, /properties/);
  assert.match(result.count_basis.queueable_count, /eligible/);
});

test("a search with no hit on a counted field is no_match", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({ facets: [facetRow("properties.rehab_level", "Structural", 66033, 30000)] });
  const result = await queryCampaignFieldOptions({ field_key: "properties.rehab_level", search: "zzz", deps: { supabase } });
  assert.equal(result.values_state, "no_match");
});

test("the exact grouped-count RPC wins over the snapshot when deployed", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({
    facets: [],
    rpc: async (name, args) => {
      assert.equal(name, "campaign_audience_field_values");
      assert.equal(args.p_field_key, "properties.building_condition");
      return { data: [{ value: "Average", label: "Average", target_count: 52509, queueable_count: 28000 }], error: null };
    },
  });
  const result = await queryCampaignFieldOptions({ field_key: "properties.building_condition", deps: { supabase } });
  assert.equal(result.values_source, "exact_group_count");
  assert.equal(result.values_state, "ok");
  assert.deepEqual(result.options.map((o) => [o.value, o.count]), [["Average", 52509]]);
});

test("a missing RPC falls back to the snapshot once, then stops asking", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({
    facets: [facetRow("properties.rehab_level", "Structural", 66033, 30000)],
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }),
  });
  const first = await queryCampaignFieldOptions({ field_key: "properties.rehab_level", deps: { supabase } });
  const second = await queryCampaignFieldOptions({ field_key: "properties.rehab_level", deps: { supabase } });
  assert.equal(first.values_source, "facet_snapshot");
  assert.equal(second.options[0].count, 66033);
  assert.equal(supabase.calls.rpc, 1);
});

test("an exact count with no values is empty (no property has a value), not not_counted", async () => {
  resetExactGraphFieldValuesProbe();
  const supabase = fakeSupabase({ rpc: async () => ({ data: [], error: null }) });
  const result = await queryCampaignFieldOptions({ field_key: "prospects.gender", deps: { supabase } });
  assert.equal(result.values_state, "empty");
});
