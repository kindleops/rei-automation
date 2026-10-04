import test from "node:test";
import assert from "node:assert/strict";

import {
  countPropertiesInBounds,
  createMarketAggregatesReader,
  sumMarketPropertyCount,
} from "@/lib/domain/map/map-bounds-counts.js";

function fakeQueryClient(result) {
  const calls = [];
  const builder = {
    select(cols, opts) { calls.push(["select", cols, opts]); return builder; },
    not(col, op, v) { calls.push(["not", col, op, v]); return builder; },
    gte(col, v) { calls.push(["gte", col, v]); return builder; },
    lte(col, v) { calls.push(["lte", col, v]); return builder; },
    in(col, v) { calls.push(["in", col, v]); return builder; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return {
    calls,
    from(table) { calls.push(["from", table]); return builder; },
  };
}

test("bbox count issues the same predicate as get_map_bounds_property_count, head + exact", async () => {
  const client = fakeQueryClient({ count: 460, error: null });
  const n = await countPropertiesInBounds(client, {
    lat_min: 44.95, lat_max: 45, lng_min: -93.3, lng_max: -93.2, markets: ["Minneapolis"], states: null,
  });
  assert.equal(n, 460);
  assert.deepEqual(client.calls, [
    ["from", "properties"],
    ["select", "property_id", { count: "exact", head: true }],
    ["not", "latitude", "is", null],
    ["not", "longitude", "is", null],
    ["gte", "latitude", 44.95],
    ["lte", "latitude", 45],
    ["gte", "longitude", -93.3],
    ["lte", "longitude", -93.2],
    ["in", "market", ["Minneapolis"]],
  ]);
});

test("bbox count surfaces errors (never reports a fake zero)", async () => {
  const client = fakeQueryClient({ count: null, error: { code: "57014" } });
  await assert.rejects(
    countPropertiesInBounds(client, { lat_min: 0, lat_max: 1, lng_min: 0, lng_max: 1 }),
    (e) => e.code === "57014",
  );
});

test("market aggregates are single-flight, cached by scope, and expire", async () => {
  let t = 0;
  let calls = 0;
  const client = {
    rpc: async (name, args) => {
      calls += 1;
      assert.equal(name, "get_map_market_aggregates");
      return { data: [{ property_count: args.p_markets ? 5 : 10 }, { property_count: 2 }], error: null };
    },
  };
  const read = createMarketAggregatesReader({ ttlMs: 1000, now: () => t });
  const [a, b] = await Promise.all([read(client, {}), read(client, {})]);
  assert.equal(calls, 1);
  assert.equal(sumMarketPropertyCount(a.rows), 12);
  assert.equal(b.rows, a.rows);
  assert.equal((await read(client, {})).cached, true);
  await read(client, { markets: ["B", "A"] });
  await read(client, { markets: ["A", "B"] });
  assert.equal(calls, 2);
  t = 1001;
  await read(client, {});
  assert.equal(calls, 3);
});

test("market aggregate failure is returned, not thrown, and not cached", async () => {
  let fail = true;
  const client = {
    rpc: async () => (fail ? { data: null, error: { code: "57014" } } : { data: [{ property_count: 3 }], error: null }),
  };
  const read = createMarketAggregatesReader();
  const bad = await read(client, {});
  assert.equal(bad.rows, null);
  assert.equal(bad.error.code, "57014");
  assert.equal(sumMarketPropertyCount(bad.rows), null);
  fail = false;
  const good = await read(client, {});
  assert.equal(sumMarketPropertyCount(good.rows), 3);
});
