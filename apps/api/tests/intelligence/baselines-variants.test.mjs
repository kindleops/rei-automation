import test from "node:test";
import assert from "node:assert/strict";

import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";
import { computeFeatureVector } from "../../src/lib/domain/intelligence/features/pit.js";
import { BLOCKS, EXTRA_COLLECTIONS, registerVariantSets, VARIANTS } from "../../scripts/intelligence/baselines/lib/variant-sets.mjs";
import { blockPermutationImportance, chiSquareSurvival, marketCalibration, precisionRecall } from "../../scripts/intelligence/baselines/lib/variant-eval.mjs";
import { wilson } from "../../scripts/intelligence/baselines/template-ope.mjs";

test("variant sets: A-F nest as specified, wealth and school district are separate blocks, lint passes", () => {
  const registry = createV1Registry();
  const sets = registerVariantSets(registry);
  const keys = (n) => new Set(sets[n].members.map((m) => `${m.key}@${m.version}`));
  const b = keys("B_property");
  for (const k of BLOCKS.prospect_fields) assert.ok(!b.has(k), "B has no prospect field");
  for (const k of BLOCKS.investor_activity) assert.ok(!b.has(k), "B has no investor feature");
  assert.ok(b.has("property.school_district@1"));
  const f = keys("F_broad_graph");
  for (const block of VARIANTS.F_broad_graph.blocks) for (const k of BLOCKS[block]) assert.ok(f.has(k), `F has ${k}`);
  assert.ok(sets.F_minus_wealth_fields && sets.F_minus_school_district, "separate ablation rows");
  assert.ok(![...f].some((k) => k.startsWith("property.equity_estimate_ratio")), "decision-snapshot-only never trained");
});

test("owner portfolio features are placed at the owner row's import time (PIT)", () => {
  const registry = createV1Registry();
  registerVariantSets(registry);
  const owner = { master_owner_id: "mo", created_at: "2026-04-25T00:00:00Z", property_count: 3, portfolio_total_value: 100, portfolio_total_equity: 60 };
  const at = (asOf) =>
    computeFeatureVector({ registry, featureSetId: "ft_graph_extras@1", entity: { id: "s" }, asOf, bundle: { owner_portfolio: [owner] }, collections: EXTRA_COLLECTIONS });
  const before = at("2026-04-21T00:00:00Z");
  assert.equal(before.values["owner.portfolio_property_count"], undefined, "not visible before import");
  const after = at("2026-05-01T00:00:00Z");
  assert.equal(after.values["owner.portfolio_property_count"], 3);
  assert.equal(after.values["owner.portfolio_equity_share_band"], "vendor_estimate:50_75", "estimate carries its source");
});

test("chi-square survival, thresholds, market calibration", () => {
  assert.ok(Math.abs(chiSquareSurvival(3.841459, 1) - 0.05) < 1e-4);
  assert.ok(Math.abs(chiSquareSurvival(18.307, 10) - 0.05) < 1e-3);
  const pr = precisionRecall([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1], { topShares: [0.5], thresholds: [0.75] });
  assert.equal(pr[0].precision, 0.5);
  assert.equal(pr[1].selected, 2);
  const rows = Array.from({ length: 60 }, (_, i) => ({ y: i < 30 ? 1 : 0, features: { m: "x" } }));
  const cal = marketCalibration(rows, rows.map(() => 0.1), { segmentOf: (r) => r.features.m });
  assert.equal(cal.markets[0].observed, 30);
  assert.ok(cal.p_value < 1e-6, "observed 50% vs predicted 10% is flagged");
});

test("block permutation importance: an informative block matters, a noise block does not", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ y: i % 2, features: { a: i % 2, b: (i * 7) % 3 } }));
  const predict = (rs) => rs.map((r) => 0.2 + 0.6 * r.features.a);
  const res = blockPermutationImportance(rows, predict, { signal: ["a"], noise: ["b"] }, { repeats: 5, seed: "t" });
  assert.ok(res.blocks.signal.auc_drop.mean > 0.3);
  assert.equal(res.blocks.noise.auc_drop.mean, 0);
});

test("wilson interval", () => {
  const w = wilson(10, 100);
  assert.ok(w.lower < 0.1 && w.upper > 0.1 && w.lower > 0.04 && w.upper < 0.18);
  assert.equal(wilson(0, 0).rate, null);
});
