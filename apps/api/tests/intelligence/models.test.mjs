import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  auc,
  bootstrapCI,
  bootstrapDifferenceCI,
  brierScore,
  calibrationTable,
  decileLift,
  evaluateBinary,
  evaluateBySegment,
  logLoss,
  prAuc,
  psi,
  psiCategorical,
  supportFlags,
} from "../../src/lib/domain/intelligence/models/metrics.js";
import { monthlyOrigins, rollingOriginSplits, segmentHoldout, temporalSplit } from "../../src/lib/domain/intelligence/models/splits.js";
import { explainPrediction, fitLogisticRegression, predictProba, trainLogisticModel } from "../../src/lib/domain/intelligence/models/logistic.js";
import {
  betaQuantile,
  fitBetaPrior,
  hierarchicalShrink,
  regularizedIncompleteBeta,
  shrinkRates,
} from "../../src/lib/domain/intelligence/models/beta-binomial.js";
import { buildDatasetSnapshot } from "../../src/lib/domain/intelligence/datasets/snapshot-builder.js";
import { readNdjsonGz } from "../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";
import { mulberry32 } from "../../src/lib/domain/intelligence/util/rng.js";
import { SYNTHETIC_SPEC, TEST_SALT, createInMemorySource, syntheticSends } from "./helpers/synthetic-dataset.mjs";

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

test("AUC / PR-AUC on known cases, including ties and a single class", () => {
  assert.equal(auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  assert.equal(auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0);
  assert.equal(auc([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]), 0.5);
  close(auc([0, 1, 1, 0, 1], [0.1, 0.4, 0.35, 0.8, 0.9]), 4 / 6);
  assert.equal(auc([1, 1], [0.2, 0.3]), null);
  assert.equal(prAuc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  close(prAuc([1, 0, 1, 0], [0.9, 0.8, 0.7, 0.1]), (1 * 0.5) + (2 / 3) * 0.5);
  assert.equal(prAuc([0, 0], [0.1, 0.2]), null);
  assert.throws(() => auc([0, 2], [0.1, 0.2]), /not binary/);
});

test("log loss, Brier, ECE + reliability table, decile lift, PSI", () => {
  close(logLoss([1, 0], [0.8, 0.2]), -Math.log(0.8));
  close(brierScore([1, 0], [0.8, 0.2]), 0.04);
  const calib = calibrationTable([0, 0, 1, 1], [0.1, 0.1, 0.9, 0.9], { bins: 10 });
  close(calib.ece, 0.1);
  assert.equal(calib.bins[1].n, 2);
  assert.equal(calib.bins[9].observed_rate, 1);
  const lift = decileLift([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], [0.99, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.04, 0.03, 0.02, 0.98, 0.01]);
  assert.deepEqual(lift.rows.map((r) => r.n), [2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(lift.rows[0].positives, 2);
  close(lift.rows[0].cumulative_capture, 1);
  const same = Array.from({ length: 200 }, (_, i) => i / 200);
  close(psi(same, same).psi, 0, 1e-12);
  assert.ok(psi(same, same.map((v) => v * 0.5)).psi > 0.25);
  assert.ok(psiCategorical(["a", "a", "b"], ["b", "b", "b"]).psi > 0.1);
});

test("seeded bootstrap intervals are reproducible and bracket the estimate; support flags are honest", () => {
  const next = mulberry32(7);
  const y = [];
  const p = [];
  for (let i = 0; i < 400; i += 1) {
    const score = next();
    p.push(score);
    y.push(next() < score ? 1 : 0);
  }
  const a = bootstrapCI(auc, y, p, { iterations: 200, seed: 42 });
  const b = bootstrapCI(auc, y, p, { iterations: 200, seed: 42 });
  assert.deepEqual(a, b);
  assert.ok(a.lower <= a.estimate && a.estimate <= a.upper);
  const c = bootstrapCI(auc, y, p, { iterations: 200, seed: 43 });
  assert.notEqual(c.lower, a.lower);
  const diff = bootstrapDifferenceCI(auc, y, p, p.map(() => 0.5), { iterations: 200, seed: 1 });
  assert.equal(diff.excludes_zero, true);
  assert.equal(supportFlags({ n: 100, positives: 50 }).low_support, true);
  assert.equal(supportFlags({ n: 1000, positives: 84 }).low_support, false);
  const report = evaluateBinary(y, p, { bootstrap: { iterations: 100, seed: 3 } });
  assert.equal(report.n, 400);
  assert.ok(report.auc.estimate > 0.6);
  const bySegment = evaluateBySegment(
    y.map((label, i) => ({ label, score: p[i], market: i % 10 === 0 ? "tiny" : "big" })),
    { segmentOf: (r) => r.market, labelOf: (r) => r.label, scoreOf: (r) => r.score, bootstrap: null },
  );
  assert.equal(bySegment.tiny.low_support, true);
  assert.deepEqual(Object.keys(bySegment), ["big", "tiny"]);
});

test("temporal split: train < T <= test, label windows crossing T are purged; rolling origins", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, t: Date.UTC(2026, 5, 25 + i) }));
  const split = temporalSplit(rows, { timeOf: (r) => r.t, cutoff: "2026-06-30T00:00:00Z", horizonMs: 3 * 86400000, idOf: (r) => r.id });
  assert.deepEqual(split.train.map((r) => r.id), ["r0", "r1"]);
  assert.deepEqual(split.purged.map((r) => r.id), ["r2", "r3", "r4"]);
  assert.deepEqual(split.test.map((r) => r.id), ["r5", "r6", "r7", "r8", "r9"]);
  const origins = monthlyOrigins("2026-04-20T00:00:00Z", "2026-09-29T00:00:00Z");
  assert.deepEqual(origins, ["2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
  const rolling = rollingOriginSplits(rows, { timeOf: (r) => r.t, origins: ["2026-06-28T00:00:00Z", "2026-07-01T00:00:00Z"], testWindowMs: 2 * 86400000, idOf: (r) => r.id });
  assert.deepEqual(rolling.map((s) => s.test.map((r) => r.id)), [["r3", "r4"], ["r6", "r7"]]);
  const held = segmentHoldout(rows, { segmentOf: (r) => (r.id === "r1" ? "minneapolis" : "other"), holdout: ["minneapolis"] });
  assert.deepEqual(held.test.map((r) => r.id), ["r1"]);
});

test("L2 logistic regression is deterministic and recovers the sign of the signal", () => {
  const next = mulberry32(11);
  const X = [];
  const y = [];
  for (let i = 0; i < 300; i += 1) {
    const x1 = next() * 2 - 1;
    const x2 = next() * 2 - 1;
    X.push([x1, x2]);
    y.push(next() < 1 / (1 + Math.exp(-(2 * x1 - 1 * x2))) ? 1 : 0);
  }
  const a = fitLogisticRegression(X, y, { l2: 1 });
  const b = fitLogisticRegression(X, y, { l2: 1 });
  assert.deepEqual(a, b);
  assert.equal(a.converged, true);
  assert.ok(a.coef[0] > 0.8 && a.coef[1] < -0.3);
  const strong = fitLogisticRegression(X, y, { l2: 1000 });
  assert.ok(Math.abs(strong.coef[0]) < Math.abs(a.coef[0]), "L2 shrinks coefficients");
});

test("reproducibility: same snapshot + model + params -> identical predictions", async () => {
  const rows = syntheticSends(30);
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), "ic8-repro-")), fs.mkdtempSync(path.join(os.tmpdir(), "ic8-repro-"))];
  try {
    const manifests = [];
    for (const outDir of dirs) {
      manifests.push(
        await buildDatasetSnapshot(SYNTHETIC_SPEC, {
          source: createInMemorySource(rows),
          registry: createV1Registry(),
          outDir,
          codeCommit: "test",
          salt: TEST_SALT,
          sleep: async () => {},
        }),
      );
    }
    assert.equal(manifests[0].sha256, manifests[1].sha256);
    const trainOn = (dir) => {
      const records = readNdjsonGz(path.join(dir, `${SYNTHETIC_SPEC.name}.ndjson.gz`)).filter((r) => r.outcomes["reply_any@1"].status === "mature");
      const features = records.map((r) => r.features);
      const labels = records.map((r) => (r.outcomes["reply_any@1"].value ? 1 : 0));
      const params = { l2: 2, maxIter: 50 };
      const encoder = {
        numeric: ["send.recipient_local_hour", "seller.prior_touch_count", "property.living_sqft"],
        categorical: ["property.market", "template.template_id", "owner.entity_class"],
      };
      const model = trainLogisticModel(features, labels, { encoder, params });
      return { model, predictions: predictProba(model, features), features };
    };
    const first = trainOn(dirs[0]);
    const again = trainOn(dirs[0]);
    const other = trainOn(dirs[1]);
    assert.equal(JSON.stringify(first.model), JSON.stringify(again.model));
    assert.deepEqual(first.predictions, again.predictions);
    assert.deepEqual(first.predictions, other.predictions);
    assert.ok(Buffer.byteLength(JSON.stringify(first.model)) < 100 * 1024, "small enough to live inline in model_versions");
    const why = explainPrediction(first.model, first.features[0], { top: 3 });
    assert.ok(why.length <= 3 && why.every((w) => typeof w.feature === "string" && Number.isFinite(w.contribution)));
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("beta-binomial: incomplete beta and quantiles, EB prior, shrinkage with credible intervals", () => {
  close(regularizedIncompleteBeta(0.5, 2, 2), 0.5, 1e-12);
  close(regularizedIncompleteBeta(0.3, 1, 1), 0.3, 1e-12);
  close(regularizedIncompleteBeta(0.2, 2, 3), 0.1808, 1e-12);
  close(betaQuantile(0.5, 2, 2), 0.5, 1e-9);
  close(regularizedIncompleteBeta(betaQuantile(0.95, 3, 40), 3, 40), 0.95, 1e-9);

  const groups = [
    { key: "a", successes: 69, trials: 899 },
    { key: "b", successes: 62, trials: 805 },
    { key: "c", successes: 15, trials: 331 },
    { key: "d", successes: 41, trials: 369 },
    { key: "e", successes: 1, trials: 9 },
  ];
  const prior = fitBetaPrior(groups);
  assert.equal(prior.method, "marginal_mle");
  assert.ok(prior.mean > 0.05 && prior.mean < 0.12);
  const again = fitBetaPrior(groups);
  assert.deepEqual(prior, again, "deterministic");
  const { rates } = shrinkRates(groups, { prior, level: 0.9 });
  const small = rates.find((r) => r.key === "e");
  assert.equal(small.low_support, true);
  assert.ok(Math.abs(small.posterior_mean - prior.mean) < Math.abs(small.raw_rate - prior.mean), "a tiny group shrinks toward the prior");
  for (const r of rates) assert.ok(r.lower <= r.posterior_mean && r.posterior_mean <= r.upper);
  assert.equal(fitBetaPrior([{ successes: 1, trials: 10 }]).method, "weak_pooled_fallback");

  const levels = hierarchicalShrink(
    [
      { market: "dallas", template: "t1", successes: 5, trials: 60 },
      { market: "dallas", template: "t2", successes: 1, trials: 40 },
      { market: "minneapolis", template: "t1", successes: 9, trials: 70 },
      { market: "minneapolis", template: "t2", successes: 0, trials: 3 },
      { market: "phoenix", template: "t1", successes: 4, trials: 80 },
    ],
    { levels: ["market", "template"] },
  );
  assert.deepEqual(levels.map((l) => l.level), ["market", "template"]);
  const tiny = levels[1].rates.find((r) => r.key === "minneapolis / t2");
  const parent = levels[0].rates.find((r) => r.key === "minneapolis");
  assert.ok(tiny.posterior_mean > 0.02, "0/3 is not reported as a 0% rate");
  assert.ok(Math.abs(tiny.posterior_mean - parent.posterior_mean) < 0.05, "it shrinks toward its own market");
});

test("prior strength cap: homogeneous groups no longer collapse credible intervals (controller finding)", () => {
  // Five markets with near-identical rates: the marginal MLE concentration runs to its 1e5 boundary.
  const groups = [
    { key: "dallas", successes: 30, trials: 400 },
    { key: "minneapolis", successes: 31, trials: 410 },
    { key: "phoenix", successes: 29, trials: 390 },
    { key: "tulsa", successes: 30, trials: 405 },
    { key: "tiny", successes: 0, trials: 12 },
  ];
  const uncapped = fitBetaPrior(groups, { maxPriorStrength: Infinity });
  assert.ok(uncapped.concentration > 1e4, `uncapped concentration ${uncapped.concentration}`);
  const collapsed = shrinkRates(groups, { prior: uncapped }).rates.find((r) => r.key === "tiny");
  assert.ok(collapsed.upper - collapsed.lower < 0.005, "uncapped: a 0/12 market gets a ~0.4 pp interval borrowed from the others");

  const capped = fitBetaPrior(groups);
  assert.equal(capped.concentration, 100);
  assert.equal(capped.strength_capped, true);
  assert.ok(capped.mle_concentration > 1e4, "the uncapped MLE is still reported");
  const { rates } = shrinkRates(groups);
  const tiny = rates.find((r) => r.key === "tiny");
  assert.ok(tiny.upper - tiny.lower > 0.05, `capped interval width ${tiny.upper - tiny.lower}`);
  assert.ok(tiny.lower <= tiny.posterior_mean && tiny.posterior_mean <= tiny.upper);
  // heterogeneous groups fit below the cap and are untouched
  const spread = fitBetaPrior([{ successes: 2, trials: 100 }, { successes: 30, trials: 100 }, { successes: 12, trials: 100 }]);
  assert.equal(spread.strength_capped, false);
  assert.equal(spread.concentration, spread.mle_concentration);
  const levels = hierarchicalShrink(groups.map((g) => ({ market: g.key, ...g })), { levels: ["market"] });
  assert.equal(levels[0].prior.strength_capped, true);
});
