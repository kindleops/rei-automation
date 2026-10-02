/**
 * IC8.1 first-text variants: evaluation helpers beyond the shared protocol.
 * Pure and seeded.
 *   - precision / recall at top-k shares and probability thresholds;
 *   - market-balanced (macro over supported markets) vs pooled metrics, with a
 *     market-stratified bootstrap CI;
 *   - market-level calibration test (observed vs expected per market,
 *     z per market, chi-square over markets);
 *   - block permutation importance (a whole feature block permuted jointly
 *     across test rows, repeated, seeded).
 */

import { auc, brierScore, logLoss, percentileSorted } from "../../../../src/lib/domain/intelligence/models/metrics.js";
import { logGamma } from "../../../../src/lib/domain/intelligence/models/beta-binomial.js";
import { mulberry32, randomIndex, seedFrom } from "../../../../src/lib/domain/intelligence/util/rng.js";

export function precisionRecall(y, p, { topShares = [0.05, 0.1, 0.2, 0.3], thresholds = [0.1, 0.15, 0.2, 0.3] } = {}) {
  const n = y.length;
  const positives = y.reduce((a, b) => a + b, 0);
  const order = [...Array(n).keys()].sort((a, b) => p[b] - p[a] || a - b);
  const top = topShares.map((share) => {
    const k = Math.max(1, Math.round(n * share));
    const tp = order.slice(0, k).reduce((a, i) => a + y[i], 0);
    return { rule: `top ${Math.round(share * 100)}%`, selected: k, precision: tp / k, recall: positives ? tp / positives : null };
  });
  const byThreshold = thresholds.map((t) => {
    const sel = order.filter((i) => p[i] >= t);
    const tp = sel.reduce((a, i) => a + y[i], 0);
    return { rule: `p >= ${t}`, selected: sel.length, precision: sel.length ? tp / sel.length : null, recall: positives ? tp / positives : null };
  });
  return [...top, ...byThreshold];
}

/** Upper regularized gamma Q(a, x) (series / continued fraction). */
export function gammaQ(a, x) {
  if (x <= 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let i = 0; i < 1000; i += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

export const chiSquareSurvival = (x, df) => gammaQ(df / 2, x / 2);

function normalTwoSided(z) {
  // Abramowitz-Stegun erfc approximation (7.1.26)
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-(z * z) / 2);
  return Math.min(1, erfc);
}

const groupIdx = (rows, segmentOf) => {
  const g = new Map();
  rows.forEach((r, i) => {
    const k = String(segmentOf(r) ?? "unknown");
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(i);
  });
  return g;
};

/** Markets eligible for balanced metrics / calibration tests. */
export const MARKET_SUPPORT = Object.freeze({ minN: 30, minPositives: 3, minNegatives: 3 });

export function marketCalibration(rows, p, { segmentOf, support = MARKET_SUPPORT } = {}) {
  const groups = groupIdx(rows, segmentOf);
  const markets = [];
  let chi = 0;
  for (const key of [...groups.keys()].sort()) {
    const idx = groups.get(key);
    if (idx.length < support.minN) continue;
    const observed = idx.reduce((a, i) => a + rows[i].y, 0);
    const expected = idx.reduce((a, i) => a + p[i], 0);
    const variance = idx.reduce((a, i) => a + p[i] * (1 - p[i]), 0);
    const z = variance > 0 ? (observed - expected) / Math.sqrt(variance) : 0;
    chi += z * z;
    markets.push({ market: key, n: idx.length, observed, expected, observed_over_expected: expected > 0 ? observed / expected : null, z, p_value: normalTwoSided(z) });
  }
  return { markets, chi_square: chi, df: markets.length, p_value: markets.length ? chiSquareSurvival(chi, markets.length) : null, min_n: support.minN };
}

export function marketBalanced(rows, p, { segmentOf, support = MARKET_SUPPORT, iterations = 200, seed = "mb" } = {}) {
  const groups = groupIdx(rows, segmentOf);
  const eligible = [...groups.entries()]
    .filter(([, idx]) => {
      const pos = idx.reduce((a, i) => a + rows[i].y, 0);
      return idx.length >= support.minN && pos >= support.minPositives && idx.length - pos >= support.minNegatives;
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
  const macro = (pick) => {
    const vals = { auc: [], log_loss: [], brier: [] };
    for (const [, idx] of eligible) {
      const sample = pick(idx);
      const y = sample.map((i) => rows[i].y);
      const s = sample.map((i) => p[i]);
      const a = auc(y, s);
      if (a !== null) vals.auc.push(a);
      vals.log_loss.push(logLoss(y, s));
      vals.brier.push(brierScore(y, s));
    }
    const mean = (v) => (v.length ? v.reduce((x, z) => x + z, 0) / v.length : null);
    return { auc: mean(vals.auc), log_loss: mean(vals.log_loss), brier: mean(vals.brier) };
  };
  const estimate = macro((idx) => idx);
  const next = mulberry32(seedFrom(seed));
  const boots = [];
  for (let it = 0; it < iterations; it += 1) boots.push(macro((idx) => idx.map(() => idx[randomIndex(next, idx.length)])));
  const ci = (k) => {
    const v = boots.map((b) => b[k]).filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    return { lower: percentileSorted(v, 0.025), upper: percentileSorted(v, 0.975) };
  };
  return {
    markets: eligible.map(([k, idx]) => ({ market: k, n: idx.length })),
    macro_auc: { estimate: estimate.auc, ...ci("auc") },
    macro_log_loss: { estimate: estimate.log_loss, ...ci("log_loss") },
    macro_brier: { estimate: estimate.brier, ...ci("brier") },
    support,
  };
}

/**
 * Block permutation importance. predict(rows) -> scores. Each repetition
 * permutes the block's feature values (and missingness) jointly across rows.
 */
export function blockPermutationImportance(rows, predict, blocks, { repeats = 20, seed = "perm" } = {}) {
  const y = rows.map((r) => r.y);
  const base = predict(rows);
  const baseAuc = auc(y, base);
  const baseLl = logLoss(y, base);
  const out = {};
  for (const [block, keys] of Object.entries(blocks)) {
    const next = mulberry32(seedFrom(`${seed}:${block}`));
    const aucDrops = [];
    const llRises = [];
    for (let rep = 0; rep < repeats; rep += 1) {
      const perm = [...rows.keys()];
      for (let i = perm.length - 1; i > 0; i -= 1) {
        const j = randomIndex(next, i + 1);
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const shuffled = rows.map((r, i) => {
        const donor = rows[perm[i]];
        const features = { ...r.features };
        const missingness = { ...(r.missingness || {}) };
        for (const k of keys) {
          if (donor.features[k] === undefined) delete features[k];
          else features[k] = donor.features[k];
          if (donor.missingness && donor.missingness[k] !== undefined) missingness[k] = donor.missingness[k];
          else delete missingness[k];
        }
        return { ...r, features, missingness };
      });
      const s = predict(shuffled);
      aucDrops.push(baseAuc - auc(y, s));
      llRises.push(logLoss(y, s) - baseLl);
    }
    const summarize = (v) => {
      const sorted = [...v].sort((a, b) => a - b);
      return { mean: v.reduce((a, b) => a + b, 0) / v.length, lower: percentileSorted(sorted, 0.025), upper: percentileSorted(sorted, 0.975) };
    };
    out[block] = { features: keys.length, auc_drop: summarize(aucDrops), log_loss_increase: summarize(llRises) };
  }
  return { base_auc: baseAuc, base_log_loss: baseLl, repeats, blocks: out };
}
