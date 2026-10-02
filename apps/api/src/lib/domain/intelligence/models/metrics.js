/**
 * IC8 EVALUATION METRICS (architecture §8). Pure, deterministic, seeded.
 *
 * Discrimination (AUC, PR-AUC) comes with percentile-bootstrap intervals;
 * calibration (log loss, Brier, ECE + reliability table) is reported separately
 * because calibration is not confidence. Every report carries a low_support
 * flag so a small segment is never celebrated. PSI measures drift.
 */

import { mulberry32, randomIndex, seedFrom } from "../util/rng.js";

export const DEFAULT_SUPPORT = Object.freeze({ minN: 200, minPositives: 20 });

export class MetricInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricInputError";
    this.code = "METRIC_INPUT";
  }
}

/** Labels as 0/1 numbers; throws on anything that is not binary. */
export function toBinaryLabels(yTrue) {
  return yTrue.map((y, i) => {
    if (y === true || y === 1) return 1;
    if (y === false || y === 0) return 0;
    throw new MetricInputError(`label at ${i} is not binary: ${JSON.stringify(y)}`);
  });
}

function checkPair(yTrue, scores) {
  if (!Array.isArray(yTrue) || !Array.isArray(scores)) throw new MetricInputError("labels and scores must be arrays");
  if (yTrue.length !== scores.length) throw new MetricInputError("labels and scores differ in length");
  const y = toBinaryLabels(yTrue);
  scores.forEach((s, i) => {
    if (typeof s !== "number" || !Number.isFinite(s)) throw new MetricInputError(`score at ${i} is not a finite number`);
  });
  return y;
}

/** Area under the ROC curve (Mann-Whitney with average ranks for ties). null with one class. */
export function auc(yTrue, scores) {
  const y = checkPair(yTrue, scores);
  const n = y.length;
  const order = [...Array(n).keys()].sort((a, b) => scores[a] - scores[b] || a - b);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k]] = avg;
    i = j + 1;
  }
  let positives = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k += 1) {
    if (y[k] === 1) {
      positives += 1;
      rankSum += ranks[k];
    }
  }
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Average precision (step-wise PR-AUC, tied scores evaluated as one threshold). null without positives. */
export function prAuc(yTrue, scores) {
  const y = checkPair(yTrue, scores);
  const n = y.length;
  const totalPositives = y.reduce((a, b) => a + b, 0);
  if (totalPositives === 0) return null;
  const order = [...Array(n).keys()].sort((a, b) => scores[b] - scores[a] || a - b);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j += 1;
    for (let k = i; k <= j; k += 1) {
      if (y[order[k]] === 1) tp += 1;
      else fp += 1;
    }
    const recall = tp / totalPositives;
    const precision = tp / (tp + fp);
    ap += (recall - prevRecall) * precision;
    prevRecall = recall;
    i = j + 1;
  }
  return ap;
}

export function logLoss(yTrue, probabilities, { eps = 1e-15 } = {}) {
  const y = checkPair(yTrue, probabilities);
  if (!y.length) return null;
  let total = 0;
  for (let i = 0; i < y.length; i += 1) {
    const p = Math.min(1 - eps, Math.max(eps, probabilities[i]));
    total += y[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return total / y.length;
}

export function brierScore(yTrue, probabilities) {
  const y = checkPair(yTrue, probabilities);
  if (!y.length) return null;
  let total = 0;
  for (let i = 0; i < y.length; i += 1) total += (probabilities[i] - y[i]) ** 2;
  return total / y.length;
}

/**
 * Reliability table + expected/maximum calibration error.
 * strategy "uniform" = equal-width bins on [0,1]; "quantile" = equal-count bins.
 */
export function calibrationTable(yTrue, probabilities, { bins = 10, strategy = "uniform" } = {}) {
  const y = checkPair(yTrue, probabilities);
  const n = y.length;
  const groups = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, positives: 0, lower: null, upper: null }));
  if (strategy === "quantile") {
    const order = [...Array(n).keys()].sort((a, b) => probabilities[a] - probabilities[b] || a - b);
    const base = Math.floor(n / bins);
    const extra = n % bins;
    let cursor = 0;
    for (let b = 0; b < bins; b += 1) {
      const size = base + (b < extra ? 1 : 0);
      for (let k = 0; k < size; k += 1) {
        const idx = order[cursor + k];
        const g = groups[b];
        g.n += 1;
        g.sumP += probabilities[idx];
        g.positives += y[idx];
        g.lower = g.lower === null ? probabilities[idx] : Math.min(g.lower, probabilities[idx]);
        g.upper = g.upper === null ? probabilities[idx] : Math.max(g.upper, probabilities[idx]);
      }
      cursor += size;
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const b = Math.min(bins - 1, Math.max(0, Math.floor(probabilities[i] * bins)));
      const g = groups[b];
      g.n += 1;
      g.sumP += probabilities[i];
      g.positives += y[i];
    }
    groups.forEach((g, b) => {
      g.lower = b / bins;
      g.upper = (b + 1) / bins;
    });
  }
  let ece = 0;
  let mce = 0;
  const table = groups.map((g, index) => {
    const meanPredicted = g.n ? g.sumP / g.n : null;
    const observedRate = g.n ? g.positives / g.n : null;
    const gap = g.n ? Math.abs(meanPredicted - observedRate) : null;
    if (g.n) {
      ece += (g.n / n) * gap;
      mce = Math.max(mce, gap);
    }
    return { index, lower: g.lower, upper: g.upper, n: g.n, positives: g.positives, mean_predicted: meanPredicted, observed_rate: observedRate, gap };
  });
  return { ece: n ? ece : null, mce: n ? mce : null, strategy, bins: table };
}

/** Lift by score decile (highest scores first); ties broken by input order. */
export function decileLift(yTrue, scores, { groups = 10 } = {}) {
  const y = checkPair(yTrue, scores);
  const n = y.length;
  const totalPositives = y.reduce((a, b) => a + b, 0);
  const baseRate = n ? totalPositives / n : null;
  const order = [...Array(n).keys()].sort((a, b) => scores[b] - scores[a] || a - b);
  const base = Math.floor(n / groups);
  const extra = n % groups;
  const rows = [];
  let cursor = 0;
  let cumulativePositives = 0;
  let cumulativeN = 0;
  for (let g = 0; g < groups; g += 1) {
    const size = base + (g < extra ? 1 : 0);
    let positives = 0;
    for (let k = 0; k < size; k += 1) positives += y[order[cursor + k]];
    cursor += size;
    cumulativePositives += positives;
    cumulativeN += size;
    const rate = size ? positives / size : null;
    rows.push({
      decile: g + 1,
      n: size,
      positives,
      rate,
      lift: rate !== null && baseRate ? rate / baseRate : null,
      cumulative_capture: totalPositives ? cumulativePositives / totalPositives : null,
      cumulative_lift: cumulativeN && baseRate ? cumulativePositives / cumulativeN / baseRate : null,
    });
  }
  return { base_rate: baseRate, rows };
}

/** Linear-interpolated percentile (R type 7) of a SORTED array. */
export function percentileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

/** Population stability index of `actual` against `expected` on expected-quantile bins. */
export function psi(expected, actual, { bins = 10, epsilon = 1e-4 } = {}) {
  const exp = expected.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  const act = actual.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!exp.length || !act.length) return { psi: null, bins: [], edges: [] };
  const edges = [];
  for (let b = 1; b < bins; b += 1) {
    const edge = percentileSorted(exp, b / bins);
    if (!edges.length || edge > edges[edges.length - 1]) edges.push(edge);
  }
  const binOf = (v) => {
    let b = 0;
    while (b < edges.length && v > edges[b]) b += 1;
    return b;
  };
  const expCounts = new Array(edges.length + 1).fill(0);
  const actCounts = new Array(edges.length + 1).fill(0);
  for (const v of exp) expCounts[binOf(v)] += 1;
  for (const v of act) actCounts[binOf(v)] += 1;
  let total = 0;
  const rows = expCounts.map((ec, b) => {
    const e = Math.max(epsilon, ec / exp.length);
    const a = Math.max(epsilon, actCounts[b] / act.length);
    const contribution = (a - e) * Math.log(a / e);
    total += contribution;
    return { bin: b, expected_share: ec / exp.length, actual_share: actCounts[b] / act.length, contribution };
  });
  return { psi: total, bins: rows, edges };
}

/** PSI over categorical values (category shares). */
export function psiCategorical(expected, actual, { epsilon = 1e-4 } = {}) {
  const share = (list) => {
    const counts = new Map();
    for (const v of list) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
    return { counts, n: list.length };
  };
  const e = share(expected);
  const a = share(actual);
  if (!e.n || !a.n) return { psi: null, categories: [] };
  const keys = [...new Set([...e.counts.keys(), ...a.counts.keys()])].sort();
  let total = 0;
  const categories = keys.map((key) => {
    const es = Math.max(epsilon, (e.counts.get(key) || 0) / e.n);
    const as = Math.max(epsilon, (a.counts.get(key) || 0) / a.n);
    const contribution = (as - es) * Math.log(as / es);
    total += contribution;
    return { category: key, expected_share: (e.counts.get(key) || 0) / e.n, actual_share: (a.counts.get(key) || 0) / a.n, contribution };
  });
  return { psi: total, categories };
}

function resample(next, n) {
  const idx = new Array(n);
  for (let i = 0; i < n; i += 1) idx[i] = randomIndex(next, n);
  return idx;
}

/**
 * Seeded percentile bootstrap for metric(yTrue, scores). Resamples on which the
 * metric is undefined (e.g. one class for AUC) are counted, not imputed.
 */
export function bootstrapCI(metricFn, yTrue, scores, { iterations = 1000, level = 0.95, seed = 1 } = {}) {
  const y = checkPair(yTrue, scores);
  const estimate = metricFn(y, scores);
  const next = mulberry32(seedFrom(seed));
  const values = [];
  let degenerate = 0;
  for (let it = 0; it < iterations; it += 1) {
    const idx = resample(next, y.length);
    const value = metricFn(
      idx.map((i) => y[i]),
      idx.map((i) => scores[i]),
    );
    if (value === null || !Number.isFinite(value)) degenerate += 1;
    else values.push(value);
  }
  values.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    estimate,
    lower: percentileSorted(values, alpha),
    upper: percentileSorted(values, 1 - alpha),
    level,
    iterations,
    valid: values.length,
    degenerate,
    seed,
    method: "percentile_bootstrap",
  };
}

/** Paired bootstrap of metric(A) - metric(B) on identical resamples. */
export function bootstrapDifferenceCI(metricFn, yTrue, scoresA, scoresB, { iterations = 1000, level = 0.95, seed = 1 } = {}) {
  const y = checkPair(yTrue, scoresA);
  checkPair(yTrue, scoresB);
  const a0 = metricFn(y, scoresA);
  const b0 = metricFn(y, scoresB);
  const estimate = a0 === null || b0 === null ? null : a0 - b0;
  const next = mulberry32(seedFrom(seed));
  const values = [];
  let degenerate = 0;
  for (let it = 0; it < iterations; it += 1) {
    const idx = resample(next, y.length);
    const ys = idx.map((i) => y[i]);
    const a = metricFn(ys, idx.map((i) => scoresA[i]));
    const b = metricFn(ys, idx.map((i) => scoresB[i]));
    if (a === null || b === null) degenerate += 1;
    else values.push(a - b);
  }
  values.sort((x, z) => x - z);
  const alpha = (1 - level) / 2;
  const lower = percentileSorted(values, alpha);
  const upper = percentileSorted(values, 1 - alpha);
  return {
    estimate,
    lower,
    upper,
    excludes_zero: lower !== null && upper !== null && (lower > 0 || upper < 0),
    level,
    iterations,
    valid: values.length,
    degenerate,
    seed,
    method: "paired_percentile_bootstrap",
  };
}

export function supportFlags({ n, positives }, support = DEFAULT_SUPPORT) {
  const negatives = n - positives;
  return {
    n,
    positives,
    low_support: n < support.minN || positives < support.minPositives || negatives < support.minPositives,
    thresholds: { ...support },
  };
}

/** Full binary evaluation report for one population. */
export function evaluateBinary(
  yTrue,
  probabilities,
  { bootstrap = { iterations: 1000, level: 0.95, seed: 1 }, calibrationBins = 10, support = DEFAULT_SUPPORT } = {},
) {
  const y = checkPair(yTrue, probabilities);
  const n = y.length;
  const positives = y.reduce((a, b) => a + b, 0);
  const flags = supportFlags({ n, positives }, support);
  const withCi = (fn) => (bootstrap ? bootstrapCI(fn, y, probabilities, bootstrap) : { estimate: fn(y, probabilities) });
  return {
    n,
    positives,
    base_rate: n ? positives / n : null,
    auc: withCi(auc),
    pr_auc: withCi(prAuc),
    log_loss: logLoss(y, probabilities),
    brier: brierScore(y, probabilities),
    calibration: calibrationTable(y, probabilities, { bins: calibrationBins }),
    lift: decileLift(y, probabilities),
    low_support: flags.low_support,
    support: flags,
  };
}

/** evaluateBinary per segment (sorted keys); every segment carries its own low_support flag. */
export function evaluateBySegment(records, { segmentOf, labelOf, scoreOf, ...options } = {}) {
  const groups = new Map();
  for (const record of records) {
    const segment = String(segmentOf(record) ?? "unknown");
    if (!groups.has(segment)) groups.set(segment, { y: [], p: [] });
    groups.get(segment).y.push(labelOf(record));
    groups.get(segment).p.push(scoreOf(record));
  }
  const out = {};
  for (const segment of [...groups.keys()].sort()) {
    const { y, p } = groups.get(segment);
    out[segment] = evaluateBinary(y, p, options);
  }
  return out;
}
