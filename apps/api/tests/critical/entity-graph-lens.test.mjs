/**
 * THE UNIVERSE LENS TELLS THE TRUTH ABOUT WHAT IT COUNTS (§3, §4, §12).
 *
 * The lens exists to answer "what does our whole universe look like". That
 * makes every number on it load-bearing: an operator sizing a cohort from a
 * chart is about to act on it. So these hold two properties —
 *
 *   1. nothing is fabricated. No fallback fixture, no synthetic bucket, no
 *      dimension the canonical data cannot support.
 *   2. no partial dimension masquerades as a whole one. Coverage differs
 *      enormously (state 100%, market 73%, owner type 24%), and a chart that
 *      silently omitted 76% of the universe would be worse than no chart.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityGraphLens } from "@/lib/domain/entity-graph/entity-graph-lens.js";

/** A stub standing in for `entity_graph_lens_aggregate`. */
const rpcReturning = (byDimension) => ({
  supabase: {
    rpc: async (fn, args) => {
      assert.equal(fn, "entity_graph_lens_aggregate");
      return { data: byDimension[args.p_dimension] ?? [], error: null };
    },
  },
});

const bucket = (key, count, covered, scope) => ({
  bucket_key: key, bucket_label: key, bucket_count: count,
  covered_total: covered, scope_total: scope,
});

test("the universe total and bucket counts come straight from the aggregate", async () => {
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({
    state: [bucket("FL", 34329, 169802, 169802), bucket("CA", 30470, 169802, 169802)],
    property_type: [bucket("Single Family", 126894, 169802, 169802)],
    market: [bucket("Miami, FL", 11756, 124052, 169802)],
  }));

  assert.equal(lens.total, 169802);
  const state = lens.dimensions.find((d) => d.key === "state");
  assert.equal(state.buckets[0].count, 34329);
  assert.equal(state.buckets[0].label, "FL");
});

test("A PARTIAL DIMENSION SAYS SO — share is of the COVERED population", async () => {
  // market is on 73% of rows. 11,756 of 124,052 is 9.5%; of 169,802 it would
  // read 6.9%. Dividing by the wrong denominator is how a chart lies.
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({
    state: [], property_type: [],
    market: [bucket("Miami, FL", 11756, 124052, 169802)],
  }));
  const market = lens.dimensions.find((d) => d.key === "market");

  assert.equal(market.covered, 124052);
  assert.ok(Math.abs(market.buckets[0].share - 11756 / 124052) < 1e-9);
  assert.match(market.coverage_note, /124,052 of 169,802/);
});

test("a FULLY covered dimension carries no coverage caveat", async () => {
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({
    state: [bucket("FL", 34329, 169802, 169802)], property_type: [], market: [],
  }));
  assert.equal(lens.dimensions.find((d) => d.key === "state").coverage_note, null);
});

test("A ZERO-DATA DIMENSION RETURNS NOTHING — never a placeholder", async () => {
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({
    state: [], property_type: [], market: [],
  }));
  for (const dimension of lens.dimensions) {
    assert.deepEqual(dimension.buckets, []);
    assert.equal(dimension.covered, 0);
  }
  // No buckets anywhere means no scope total to claim.
  assert.equal(lens.total, null);
});

test("a failing aggregate THROWS rather than returning an empty graph", async () => {
  // An unreadable universe must reach the UI as an error. Returning zero
  // buckets would render as "you own nothing", which is a lie.
  await assert.rejects(
    buildEntityGraphLens({ tab: "properties" }, {
      supabase: { rpc: async () => ({ data: null, error: new Error("statement timeout") }) },
    }),
    /statement timeout/,
  );
});

// ── drill-down

test("filters are passed to the aggregate, not applied client-side", async () => {
  const seen = [];
  await buildEntityGraphLens(
    { tab: "properties", state: "TX", market: "Houston, TX", property_type: "Single Family" },
    { supabase: { rpc: async (_fn, args) => { seen.push(args); return { data: [], error: null } } } },
  );
  assert.ok(seen.length > 0);
  for (const args of seen) {
    assert.equal(args.p_state, "TX");
    assert.equal(args.p_market, "Houston, TX");
    assert.equal(args.p_property_type, "Single Family");
  }
});

test("the scope label names the drill path", async () => {
  const lens = await buildEntityGraphLens(
    { tab: "properties", state: "TX", market: "Houston, TX" },
    rpcReturning({ state: [], property_type: [], market: [] }),
  );
  assert.equal(lens.scope, "TX · Houston, TX");
});

test("the bare universe is labelled as such", async () => {
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({}));
  assert.equal(lens.scope, "Universe");
});

// ── fast / deep

test("fast and deep return DIFFERENT dimensions, both real", async () => {
  const deps = rpcReturning({});
  const fast = await buildEntityGraphLens({ tab: "properties", part: "fast" }, deps);
  const deep = await buildEntityGraphLens({ tab: "properties", part: "deep" }, deps);

  const fastKeys = fast.dimensions.map((d) => d.key);
  const deepKeys = deep.dimensions.map((d) => d.key);
  assert.deepEqual(fastKeys, ["state", "property_type", "market"]);
  assert.deepEqual(deepKeys, ["county", "city", "owner_type"]);
  // The split is a latency decision; neither pass is less real than the other.
  assert.equal(fastKeys.some((k) => deepKeys.includes(k)), false);
});

// ── scope discipline

test("a non-property tab gets an EXPLICIT unsupported lens, not plausible wrong counts", async () => {
  /**
   * The lens counts PROPERTIES. Rendering it while standing in owners or
   * contacts would show numbers that look like that tab's population and are
   * not — the most dangerous kind of wrong.
   */
  const lens = await buildEntityGraphLens({ tab: "master_owners" }, {
    supabase: { rpc: async () => { throw new Error("must not aggregate for an unsupported tab") } },
  });
  assert.equal(lens.unsupported_tab, "master_owners");
  assert.deepEqual(lens.dimensions, []);
  assert.equal(lens.total, null);
});

test("NO DIMENSION IS OFFERED THAT THE DATA CANNOT SUPPORT", async () => {
  // `normalized_asset_class` is 0% populated on 169,802 rows. Offering it would
  // be a control that can only ever be empty.
  const lens = await buildEntityGraphLens({ tab: "properties" }, rpcReturning({}));
  const keys = lens.dimensions.map((d) => d.key);
  assert.ok(!keys.includes("normalized_asset_class"));
  assert.ok(!keys.includes("asset_class"));
});

test("the service never returns raw rows to the client", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/entity-graph/entity-graph-lens.js", import.meta.url), "utf8");
  // Aggregation is the RPC's job; a `.from('properties').select()` here would
  // mean 169k rows crossing the wire.
  assert.ok(!/\.from\(['"]properties['"]\)/.test(source));
  assert.match(source, /entity_graph_lens_aggregate/);
});
