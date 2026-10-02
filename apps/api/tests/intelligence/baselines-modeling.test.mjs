import test from "node:test";
import assert from "node:assert/strict";

import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";
import {
  armFromSet,
  fitRateBaseline,
  investorColumnSpec,
  runFamily,
  toModelRecord,
  UNAVAILABLE_FEATURES,
} from "../../scripts/intelligence/baselines/lib/modeling.mjs";
import { verdictOf } from "../../scripts/intelligence/baselines/lib/report-writers.mjs";
import { mulberry32 } from "../../src/lib/domain/intelligence/util/rng.js";

const PERSONAL = ["prospect.gender", "prospect.marital_status", "owner.language", "owner.agent_persona", "prospect.age_band", "prospect.household_income_band", "prospect.education_level", "prospect.occupation_group"];

test("arms: base sets carry no personal attribute; all-fields sets carry all eight; unreadable features never enter", () => {
  const registry = createV1Registry();
  const base1 = armFromSet(registry.getSet("seller_first_touch@1"), "base_v1");
  const all2 = armFromSet(registry.getSet("seller_first_touch_all@2"), "all_fields");
  const base2 = armFromSet(registry.getSet("seller_first_touch@2"), "base");
  for (const key of PERSONAL) {
    assert.ok(!base1.members.includes(key) && !base2.members.includes(key), `${key} not in base arms`);
    assert.ok(all2.members.includes(key), `${key} in all-fields arm`);
  }
  for (const key of UNAVAILABLE_FEATURES) assert.ok(!all2.members.includes(key));
  assert.equal(base2.members.length - base1.members.length, 40, "@2 adds the 40 investor-activity features");
  const record = toModelRecord({ "prospect.gender": "f", "property.market": "x" }, base1);
  assert.ok(!Object.keys(record).some((k) => k.startsWith("pa_")), "base model records never read personal attributes");
  assert.equal(investorColumnSpec("market.investor_purchases_zip_3m").transform(0), 0);
  assert.equal(investorColumnSpec("market.investor_count_trend_r1mi_6v6").transform(-3), -Math.log1p(3));
});

test("rate baselines shrink small groups and fall back to the prior for unseen keys", () => {
  const rows = [];
  for (let i = 0; i < 400; i += 1) rows.push({ y: i % 10 === 0 ? 1 : 0, key: "big" });
  rows.push({ y: 1, key: "tiny" });
  const b = fitRateBaseline(rows, (r) => r.key, { name: "x" });
  const tiny = b.predict({ key: "tiny" });
  assert.ok(tiny < 0.5 && tiny > 0.1 - 0.05, `tiny shrunk toward the prior (${tiny})`);
  assert.equal(b.predict({ key: "unseen" }), b.prior.mean);
  const base = fitRateBaseline(rows, null, { name: "base_rate" });
  assert.ok(Math.abs(base.predict({}) - 41 / 401) < 1e-12);
});

function synthetic(n = 1600) {
  const next = mulberry32(11);
  const rows = [];
  const start = Date.parse("2026-04-20T00:00:00Z");
  for (let i = 0; i < n; i += 1) {
    const market = next() < 0.5 ? "a" : "b";
    const hour = Math.floor(next() * 12) + 8;
    const p = market === "a" ? 0.2 : 0.05;
    rows.push({
      subject_id: `s${String(i).padStart(5, "0")}`,
      as_of: new Date(start + i * 3 * 3600e3).toISOString(),
      features: { "property.market": market, "send.recipient_local_hour": hour, "template.template_id": `t${i % 3}`, "seller.prior_touch_count": 0, "seller.prior_delivered_count": 0 },
      strata: { template_language: "english" },
      y: next() < p ? 1 : 0,
    });
  }
  return rows;
}

test("runFamily is deterministic and finds a planted market effect", () => {
  const registry = createV1Registry();
  const arm = armFromSet(registry.getSet("seller_first_touch@1"), "base");
  const rows = synthetic();
  const opts = { family: "t", rows, arms: [arm], horizonMs: 72 * 3600e3, cutoff: "2026-08-20T00:00:00Z", testEnd: "2026-12-31T00:00:00Z", seed: "x", segments: { market: (r) => r.features["property.market"] } };
  const a = runFamily(opts);
  const b = runFamily(opts);
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.comparisons, b.comparisons);
  assert.ok(a.metrics.base.auc.estimate > 0.6, `auc ${a.metrics.base.auc.estimate}`);
  assert.ok(a.metrics.market_rate.auc.estimate > 0.6);
  assert.ok(typeof verdictOf(a.comparisons[`base_vs_${a.reference_baseline}`]) === "string");
});
