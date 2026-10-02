import test from "node:test";
import assert from "node:assert/strict";

import {
  effectiveSampleSize,
  evaluatePolicy,
  perTemplateEstimates,
  policyVsLogged,
  restrictPolicy,
  snipwValue,
  uniformPolicy,
  validLoggedRows,
} from "../../scripts/intelligence/baselines/lib/ope.mjs";
import { mulberry32 } from "../../src/lib/domain/intelligence/util/rng.js";

/** Logged data from a known world: template "a" replies 30%, "b" 10%, "c" 10%; uniform logging over pools. */
function world(n = 6000, seed = 7) {
  const next = mulberry32(seed);
  const rates = { a: 0.3, b: 0.1, c: 0.1 };
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const pool = i % 2 ? ["a", "b", "c"] : ["b", "c"];
    const action = pool[Math.floor(next() * pool.length)];
    rows.push({ pool, action, reward: next() < rates[action] ? 1 : 0 });
  }
  return rows;
}

test("uniform target policy equals the logged policy: weights 1, SNIPW = on-policy mean", () => {
  const rows = world(600);
  const res = evaluatePolicy(rows, uniformPolicy, { iterations: 50 });
  const mean = rows.reduce((a, r) => a + r.reward, 0) / rows.length;
  assert.ok(Math.abs(res.snipw.estimate - mean) < 1e-12);
  assert.ok(Math.abs(res.ipw.estimate - mean) < 1e-12);
  assert.equal(Math.round(res.ess), rows.length);
});

test("per-template IPW recovers the true rate where the naive rate is confounded-free here", () => {
  const rows = world();
  const est = perTemplateEstimates(rows, { iterations: 100 });
  const a = est.find((e) => e.template_id === "a");
  assert.equal(a.eligible, 3000);
  assert.ok(Math.abs(a.snipw.estimate - 0.3) < 0.04, `snipw ${a.snipw.estimate}`);
  assert.ok(a.snipw.lower <= 0.3 && a.snipw.upper >= 0.3);
});

test("restricting to the better template is detected against the logged policy", () => {
  const rows = world();
  const onlyA = restrictPolicy((t) => t === "a");
  const diff = policyVsLogged(rows, onlyA, { iterations: 200 });
  // rows whose pool lacks "a" defer to the logged policy; half the rows gain ~0.3-0.167
  assert.ok(diff.estimate > 0.03 && diff.excludes_zero, JSON.stringify(diff));
});

test("weights, ESS and validity filters", () => {
  assert.equal(effectiveSampleSize([1, 1, 1, 1]), 4);
  assert.equal(effectiveSampleSize([4, 0, 0, 0]), 1);
  assert.equal(snipwValue([{ reward: 1 }, { reward: 0 }], [0, 0]), null);
  const valid = validLoggedRows([
    { pool: ["a"], action: "a", reward: 1 },
    { pool: ["a"], action: "b", reward: 1 },
    { pool: [], action: "a", reward: 0 },
  ]);
  assert.equal(valid.length, 1);
});

test("deterministic: same rows and seed give identical intervals", () => {
  const rows = world(800);
  const a = evaluatePolicy(rows, restrictPolicy((t) => t !== "c"), { iterations: 100, seed: "s" });
  const b = evaluatePolicy(rows, restrictPolicy((t) => t !== "c"), { iterations: 100, seed: "s" });
  assert.deepEqual(a, b);
});
