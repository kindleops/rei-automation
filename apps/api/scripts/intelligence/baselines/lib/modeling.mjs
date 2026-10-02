/**
 * IC8 baselines: model arms, rate baselines and the evaluation protocol.
 * Pure and seeded: the same snapshot records give byte-identical results.
 *
 * Every model here is built ONLY from the foundation primitives
 * (models/logistic.js, beta-binomial.js, metrics.js, splits.js); this file
 * decides which inputs each arm sees and how evaluation is run.
 */

import { trainLogisticModel, predictProba } from "../../../../src/lib/domain/intelligence/models/logistic.js";
import { shrinkRates } from "../../../../src/lib/domain/intelligence/models/beta-binomial.js";
import {
  auc,
  bootstrapCI,
  bootstrapDifferenceCI,
  brierScore,
  calibrationTable,
  evaluateBinary,
  logLoss,
  prAuc,
  psi,
  psiCategorical,
} from "../../../../src/lib/domain/intelligence/models/metrics.js";
import { monthlyOrigins, temporalSplit } from "../../../../src/lib/domain/intelligence/models/splits.js";
import { mulberry32, seedFrom } from "../../../../src/lib/domain/intelligence/util/rng.js";

/** Features that exist in the set but were not readable (seller.* via PostgREST): never model inputs. */
export const UNAVAILABLE_FEATURES = Object.freeze(["property.years_since_last_recorded_sale", "property.recorded_mortgage_count"]);

const signedLog1p = (v) => Math.sign(v) * Math.log1p(Math.abs(v));

/** market_investor_activity columns: counts log1p, count trends signed log1p, shares as-is. */
export function investorColumnSpec(key) {
  const name = key.replace(/^market\./, "mia_");
  if (/^market\.investor_purchases_/.test(key)) return { kind: "numeric", name, transform: (v) => Math.log1p(Math.max(0, v)), doc: "log1p(count)" };
  if (/^market\.investor_count_trend_/.test(key)) return { kind: "numeric", name, transform: signedLog1p, doc: "sign(x) * log1p(|x|)" };
  if (/^market\.investor_share(_trend)?_/.test(key)) return { kind: "numeric", name, transform: (v) => v, doc: "share as-is" };
  return null;
}

/** Model columns derived from set members. kind: numeric (with transform) | categorical. */
export const COLUMN_SPECS = Object.freeze({
  "send.recipient_local_hour": { kind: "categorical", name: "local_hour" },
  "send.recipient_local_weekday": { kind: "categorical", name: "local_weekday" },
  "property.market": { kind: "categorical", name: "market" },
  "property.asset_family": { kind: "categorical", name: "asset_family" },
  "property.unit_count": { kind: "numeric", name: "log1p_units", transform: (v) => Math.log1p(Math.min(v, 500)) },
  "property.living_sqft": { kind: "numeric", name: "log_sqft", transform: (v) => Math.log(Math.min(Math.max(v, 200), 200000)) },
  "property.bedrooms": { kind: "numeric", name: "bedrooms", transform: (v) => Math.min(v, 20) },
  "property.bathrooms": { kind: "numeric", name: "bathrooms", transform: (v) => Math.min(v, 15) },
  "property.year_built": { kind: "numeric", name: "year_built", transform: (v) => v },
  "template.use_case": { kind: "categorical", name: "use_case" },
  "template.template_id": { kind: "categorical", name: "template_id" },
  "seller.prior_touch_count": { kind: "numeric", name: "prior_touches", transform: (v) => Math.min(v, 10) },
  "seller.days_since_last_touch": { kind: "numeric", name: "log1p_days_since_touch", transform: (v) => Math.log1p(Math.max(0, v)) },
  "seller.prior_delivered_count": { kind: "numeric", name: "prior_delivered", transform: (v) => Math.min(v, 10) },
  "owner.entity_class": { kind: "categorical", name: "owner_entity_class" },
  "prospect.gender": { kind: "categorical", name: "pa_gender" },
  "prospect.marital_status": { kind: "categorical", name: "pa_marital_status" },
  "owner.language": { kind: "categorical", name: "pa_owner_language" },
  "owner.agent_persona": { kind: "categorical", name: "pa_agent_persona" },
  "prospect.age_band": { kind: "categorical", name: "pa_age_band" },
  "prospect.household_income_band": { kind: "categorical", name: "pa_income_band" },
  "prospect.education_level": { kind: "categorical", name: "pa_education" },
  "prospect.occupation_group": { kind: "categorical", name: "pa_occupation" },
  "property.school_district": { kind: "categorical", name: "school_district" },
  "prospect.net_asset_value_band": { kind: "categorical", name: "pa_net_asset_band" },
  "prospect.buying_power_band": { kind: "categorical", name: "pa_buying_power_band" },
  "owner.portfolio_property_count": { kind: "numeric", name: "log1p_portfolio_properties", transform: (v) => Math.log1p(Math.min(v, 10000)), doc: "log1p(min(property_count, 10000))" },
  "owner.portfolio_total_units": { kind: "numeric", name: "log1p_portfolio_units", transform: (v) => Math.log1p(Math.min(v, 100000)), doc: "log1p(min(units, 100000))" },
  "owner.max_ownership_years": { kind: "numeric", name: "max_ownership_years", transform: (v) => Math.min(v, 80), doc: "min(years, 80)" },
  "owner.portfolio_equity_share_band": { kind: "categorical", name: "portfolio_equity_band" },
  "owner.active_lien_count": { kind: "numeric", name: "log1p_active_liens", transform: (v) => Math.log1p(Math.min(v, 1000)), doc: "log1p(min(count, 1000))" },
  "owner.tax_delinquent_count": { kind: "numeric", name: "log1p_tax_delinquent", transform: (v) => Math.log1p(Math.min(v, 1000)), doc: "log1p(min(count, 1000))" },
});

/** An arm = a registry feature set minus unavailable members, mapped to model columns. */
export function columnSpec(key) {
  return COLUMN_SPECS[key] || investorColumnSpec(key);
}

export function armFromSet(set, name) {
  const members = set.members.map((m) => m.key).filter((k) => !UNAVAILABLE_FEATURES.includes(k));
  const unknown = members.filter((k) => !columnSpec(k));
  if (unknown.length) throw new Error(`arm ${name}: no column spec for ${unknown.join(", ")}`);
  const numeric = [];
  const categorical = [];
  for (const key of members) (columnSpec(key).kind === "numeric" ? numeric : categorical).push(key);
  return Object.freeze({
    name,
    featureSetId: set.featureSetId,
    featureSetHash: set.definitionHash,
    members: Object.freeze(members),
    excluded_unavailable: Object.freeze(set.members.map((m) => m.key).filter((k) => UNAVAILABLE_FEATURES.includes(k))),
    numeric: Object.freeze(numeric.map((k) => columnSpec(k).name)),
    categorical: Object.freeze(categorical.map((k) => columnSpec(k).name)),
    transforms: Object.freeze(Object.fromEntries(numeric.map((k) => [columnSpec(k).name, columnSpec(k).doc || null]))),
  });
}

/**
 * Snapshot features -> model record for an arm (only the arm's members are
 * read). Missingness is never zero-filled: a numeric gap stays null (the
 * encoder adds an explicit __missing__ indicator); a categorical gap becomes
 * its tri-state kind (__unknown__ / __not_applicable__) or null (__missing__).
 */
export function toModelRecord(features, arm, missingness = {}) {
  const out = {};
  for (const key of arm.members) {
    const spec = columnSpec(key);
    const value = features[key];
    if (value === null || value === undefined) {
      const kind = missingness[key];
      out[spec.name] = spec.kind === "categorical" && (kind === "unknown" || kind === "not_applicable") ? `__${kind}__` : null;
    } else if (spec.kind === "numeric") {
      const n = spec.transform(Number(value));
      out[spec.name] = Number.isFinite(n) ? n : null;
    } else {
      out[spec.name] = String(value);
    }
  }
  return out;
}

export const ENCODER_DEFAULTS = Object.freeze({ minCategoryCount: 20, maxLevels: 80 });

export function fitArm(trainRows, arm, { l2 }) {
  const records = trainRows.map((r) => toModelRecord(r.features, arm, r.missingness));
  return trainLogisticModel(records, trainRows.map((r) => r.y), {
    encoder: { numeric: [...arm.numeric], categorical: [...arm.categorical], ...ENCODER_DEFAULTS },
    params: { l2, maxIter: 50, tol: 1e-7 },
  });
}

export function predictArm(model, rows, arm) {
  return predictProba(
    model,
    rows.map((r) => toModelRecord(r.features, arm, r.missingness)),
  );
}

/**
 * L2 strength chosen on a time-ordered inner validation: the last
 * `share` of training rows (by time) is held out, purged by the horizon.
 */
export function selectL2(trainRows, arm, { grid = [1, 3, 10, 30, 100, 300], share = 0.2, horizonMs = 0 } = {}) {
  const ordered = [...trainRows].sort((a, b) => Date.parse(a.as_of) - Date.parse(b.as_of) || a.subject_id.localeCompare(b.subject_id));
  const cutIndex = Math.floor(ordered.length * (1 - share));
  const cutoff = ordered[cutIndex]?.as_of;
  const split = temporalSplit(ordered, { timeOf: (r) => r.as_of, cutoff, horizonMs, idOf: (r) => r.subject_id });
  const results = [];
  for (const l2 of grid) {
    if (!split.train.length || !split.test.length || new Set(split.train.map((r) => r.y)).size < 2) break;
    const model = fitArm(split.train, arm, { l2 });
    const p = predictArm(model, split.test, arm);
    results.push({ l2, val_log_loss: logLoss(split.test.map((r) => r.y), p), val_auc: auc(split.test.map((r) => r.y), p) });
  }
  const best = results.length ? [...results].sort((a, b) => a.val_log_loss - b.val_log_loss || a.l2 - b.l2)[0].l2 : 10;
  return { l2: best, inner_cutoff: cutoff, inner_train: split.train.length, inner_val: split.test.length, grid: results };
}

// ── rate baselines ──────────────────────────────────────────────────────

export function fitRateBaseline(trainRows, keyOf, { name }) {
  if (!keyOf) {
    const rate = trainRows.reduce((a, r) => a + r.y, 0) / Math.max(1, trainRows.length);
    return { name, kind: "base_rate", rate, predict: () => rate, table: null };
  }
  const groups = new Map();
  for (const r of trainRows) {
    const key = String(keyOf(r) ?? "__missing__");
    if (!groups.has(key)) groups.set(key, { key, successes: 0, trials: 0 });
    const g = groups.get(key);
    g.trials += 1;
    g.successes += r.y;
  }
  const list = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const shrunk = shrinkRates(list, { level: 0.9 });
  const table = new Map(shrunk.rates.map((x) => [x.key, x.posterior_mean]));
  const fallback = shrunk.prior.mean;
  return {
    name,
    kind: "beta_binomial_shrunk_rate",
    prior: shrunk.prior,
    groups: list.length,
    predict: (r) => {
      const v = table.get(String(keyOf(r) ?? "__missing__"));
      return v === undefined ? fallback : v;
    },
    table: shrunk.rates,
  };
}

export const BASELINE_KEYS = Object.freeze({
  base_rate: null,
  market_rate: (r) => r.features["property.market"],
  template_rate: (r) => r.features["template.template_id"],
});

export function fitBaselines(trainRows) {
  return Object.fromEntries(Object.entries(BASELINE_KEYS).map(([name, keyOf]) => [name, fitRateBaseline(trainRows, keyOf, { name })]));
}

// ── evaluation ──────────────────────────────────────────────────────────

export function fullMetrics(y, p, { seed, iterations = 1000 }) {
  const report = evaluateBinary(y, p, { bootstrap: { iterations, level: 0.95, seed } });
  report.reliability_quantile = calibrationTable(y, p, { bins: 10, strategy: "quantile" });
  return report;
}

/** Paired bootstrap differences (A - B) on the same test resamples. */
export function compareScores(y, pA, pB, { seed, iterations = 1000 }) {
  const opts = { iterations, level: 0.95, seed };
  return {
    auc: bootstrapDifferenceCI(auc, y, pA, pB, opts),
    pr_auc: bootstrapDifferenceCI(prAuc, y, pA, pB, opts),
    log_loss: bootstrapDifferenceCI((yy, pp) => logLoss(yy, pp), y, pA, pB, opts),
    brier: bootstrapDifferenceCI(brierScore, y, pA, pB, opts),
  };
}

function scoresFor(rows, baselines, models) {
  const out = {};
  for (const [name, b] of Object.entries(baselines)) out[name] = rows.map((r) => b.predict(r));
  for (const { arm, model } of models) out[arm.name] = predictArm(model, rows, arm);
  return out;
}

const ymean = (rows) => (rows.length ? rows.reduce((a, r) => a + r.y, 0) / rows.length : null);

/** Best baseline on the TEST set by log loss (the reference the model must beat). */
function bestBaseline(metrics, names) {
  return [...names].sort((a, b) => metrics[a].log_loss - metrics[b].log_loss || a.localeCompare(b))[0];
}

export function segmentReport(rows, scores, { segmentOf, names, seed }) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = String(segmentOf(r) ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const out = {};
  for (const key of [...groups.keys()].sort()) {
    const idx = groups.get(key);
    const y = idx.map((i) => rows[i].y);
    const positives = y.reduce((a, b) => a + b, 0);
    const entry = { n: idx.length, positives, rate: positives / idx.length, low_support: idx.length < 200 || positives < 20 || idx.length - positives < 20 };
    for (const name of names) {
      const p = idx.map((i) => scores[name][i]);
      const a = positives > 0 && positives < idx.length ? bootstrapCI(auc, y, p, { iterations: 200, seed: `${seed}:${key}:${name}` }) : null;
      entry[name] = { auc: a ? { estimate: a.estimate, lower: a.lower, upper: a.upper } : null, log_loss: logLoss(y, p), mean_score: p.reduce((s, v) => s + v, 0) / p.length };
    }
    out[key] = entry;
  }
  return out;
}

export function driftReport(train, test, arm, scoresTrain, scoresTest) {
  const features = {};
  for (const key of arm.members) {
    const spec = columnSpec(key);
    const get = (r) => r.features[key];
    if (spec.kind === "numeric") {
      const value = psi(train.map(get).filter((v) => v !== null && v !== undefined), test.map(get).filter((v) => v !== null && v !== undefined));
      features[key] = { kind: "numeric", psi: value.psi };
    } else {
      const value = psiCategorical(train.map((r) => get(r) ?? "__missing__"), test.map((r) => get(r) ?? "__missing__"));
      features[key] = { kind: "categorical", psi: value.psi };
    }
  }
  return { features, score_psi: psi(scoresTrain, scoresTest).psi };
}

/**
 * The full protocol for one family.
 * rows: mature population records with `y`; arms: [{ arm }] in comparison order.
 */
export function runFamily({ family, rows, arms, pairs = [], horizonMs, cutoff = "2026-07-01T00:00:00.000Z", testEnd = "2026-09-29T00:00:00.000Z", seed, segments }) {
  const split = temporalSplit(rows, { timeOf: (r) => r.as_of, cutoff, testEnd, horizonMs, idOf: (r) => r.subject_id });
  const { train, test } = split;
  const baselines = fitBaselines(train);
  const l2Selection = {};
  const models = arms.map((arm) => {
    const sel = selectL2(train, arm, { horizonMs });
    l2Selection[arm.name] = sel;
    return { arm, model: fitArm(train, arm, { l2: sel.l2 }), l2: sel.l2 };
  });
  const yTest = test.map((r) => r.y);
  const scores = scoresFor(test, baselines, models);
  const names = Object.keys(scores);
  const metrics = {};
  for (const name of names) metrics[name] = fullMetrics(yTest, scores[name], { seed: `${seed}:${family}:${name}` });
  const baselineNames = Object.keys(baselines);
  const reference = bestBaseline(metrics, baselineNames);
  const comparisons = {};
  for (const { arm } of models) comparisons[`${arm.name}_vs_${reference}`] = compareScores(yTest, scores[arm.name], scores[reference], { seed: `${seed}:${family}:cmp:${arm.name}` });
  for (const [a, b] of pairs) {
    comparisons[`${a}_vs_${b}`] = compareScores(yTest, scores[a], scores[b], { seed: `${seed}:${family}:cmp:${a}:${b}` });
  }
  const segmentResults = {};
  for (const [segName, segmentOf] of Object.entries(segments)) {
    segmentResults[segName] = segmentReport(test, scores, { segmentOf, names: [reference, ...models.map((m) => m.arm.name)], seed: `${seed}:${family}:seg:${segName}` });
  }
  const trainScores = scoresFor(train, {}, models);
  const drift = {};
  for (const { arm } of models) drift[arm.name] = driftReport(train, test, arm, trainScores[arm.name], scores[arm.name]);

  const rolling = rollingOrigin({ rows, arms: models.map((m) => ({ arm: m.arm, l2: m.l2 })), horizonMs, seed: `${seed}:${family}:rolling` });
  const learningCurve = learningCurveReport({ train, test, models, seed: `${seed}:${family}:lc` });

  return {
    family,
    split: {
      cutoff: split.cutoff,
      test_end: split.testEnd,
      horizon_ms: horizonMs,
      train: { n: train.length, positives: train.reduce((a, r) => a + r.y, 0), rate: ymean(train), from: train[0]?.as_of, to: train[train.length - 1]?.as_of },
      test: { n: test.length, positives: yTest.reduce((a, b) => a + b, 0), rate: ymean(test), from: test[0]?.as_of, to: test[test.length - 1]?.as_of },
      purged: split.purged.length,
    },
    baselines: Object.fromEntries(
      Object.entries(baselines).map(([name, b]) => [name, { kind: b.kind, rate: b.rate ?? null, prior: b.prior ?? null, groups: b.groups ?? null }]),
    ),
    l2_selection: l2Selection,
    models,
    scores,
    test,
    train,
    metrics,
    reference_baseline: reference,
    comparisons,
    segments: segmentResults,
    drift,
    rolling,
    learning_curve: learningCurve,
  };
}

export function rollingOrigin({ rows, arms, horizonMs, seed, from = "2026-05-01T00:00:00.000Z", to = "2026-10-01T00:00:00.000Z" }) {
  const origins = monthlyOrigins(from, to);
  return origins.map((origin) => {
    const end = new Date(Date.parse(origin));
    end.setUTCMonth(end.getUTCMonth() + 1);
    const split = temporalSplit(rows, { timeOf: (r) => r.as_of, cutoff: origin, testEnd: end.toISOString(), horizonMs, idOf: (r) => r.subject_id });
    const y = split.test.map((r) => r.y);
    const positives = y.reduce((a, b) => a + b, 0);
    const entry = { origin, test_end: end.toISOString(), train_n: split.train.length, test_n: split.test.length, test_positives: positives, purged: split.purged.length };
    if (!split.test.length || positives === 0 || positives === split.test.length || new Set(split.train.map((r) => r.y)).size < 2) {
      entry.skipped = "test window has a single class or no rows";
      return entry;
    }
    entry.low_support = split.test.length < 200 || positives < 20;
    const baselines = fitBaselines(split.train);
    const scores = {};
    for (const [name, b] of Object.entries(baselines)) scores[name] = split.test.map((r) => b.predict(r));
    for (const { arm, l2 } of arms) scores[arm.name] = predictArm(fitArm(split.train, arm, { l2 }), split.test, arm);
    entry.results = {};
    for (const [name, p] of Object.entries(scores)) {
      const a = bootstrapCI(auc, y, p, { iterations: 300, seed: `${seed}:${origin}:${name}` });
      entry.results[name] = { auc: { estimate: a.estimate, lower: a.lower, upper: a.upper }, log_loss: logLoss(y, p), brier: brierScore(y, p) };
    }
    return entry;
  });
}

export function learningCurveReport({ train, test, models, seed, fractions = [0.1, 0.25, 0.5, 0.75, 1] }) {
  const y = test.map((r) => r.y);
  return fractions.map((fraction) => {
    const next = mulberry32(seedFrom(`${seed}:${fraction}`));
    const keyed = train.map((r) => ({ r, k: next() })).sort((a, b) => a.k - b.k || a.r.subject_id.localeCompare(b.r.subject_id));
    const sample = keyed.slice(0, Math.max(50, Math.round(train.length * fraction))).map((e) => e.r);
    const entry = { fraction, train_n: sample.length, train_positives: sample.reduce((a, r) => a + r.y, 0), results: {} };
    for (const { arm, l2 } of models) {
      const p = predictArm(fitArm(sample, arm, { l2 }), test, arm);
      const a = bootstrapCI(auc, y, p, { iterations: 300, seed: `${seed}:${fraction}:${arm.name}` });
      entry.results[arm.name] = { auc: { estimate: a.estimate, lower: a.lower, upper: a.upper }, log_loss: logLoss(y, p) };
    }
    return entry;
  });
}
