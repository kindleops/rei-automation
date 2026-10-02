/**
 * IC8 baselines: off-policy evaluation of template policies on LOGGED data
 * (evaluation on logged data, not a counterfactual guarantee). Pure, seeded.
 *
 * Logging policy: the legacy feeder drew the template hash-uniformly from a
 * logged pool, so mu(a | pool) = 1 / |pool| for every member
 * (supabase-candidate-feeder.js stableSeedModulo / chooseRotatingTemplate).
 * A target policy pi(. | pool) gives each row the weight
 * w = pi(a_logged | pool) / mu(a_logged | pool) = pi(a | pool) * |pool|.
 *
 *   IPW    V = (1/n) sum w_i r_i              (unbiased, high variance)
 *   SNIPW  V = sum w_i r_i / sum w_i          (self-normalised, small bias)
 *   ESS    (sum w)^2 / sum w^2
 *
 * Positivity: a template outside a row's pool has mu = 0; a policy may only
 * put mass on pool members, so estimands are always conditional on the pool.
 */

import { mulberry32, randomIndex, seedFrom } from "../../../../src/lib/domain/intelligence/util/rng.js";
import { percentileSorted } from "../../../../src/lib/domain/intelligence/models/metrics.js";

/** Rows: { pool: string[], action: string, reward: 0|1 }. Valid only when action is in pool. */
export function validLoggedRows(rows) {
  return rows.filter((r) => Array.isArray(r.pool) && r.pool.length > 0 && r.pool.includes(r.action) && (r.reward === 0 || r.reward === 1));
}

/**
 * Weights of a target policy. `policy(pool)` returns a Map template -> prob
 * over pool members (sums to 1), or null to defer to the logging policy
 * (weight 1) for that row.
 */
export function policyWeights(rows, policy) {
  return rows.map((r) => {
    const dist = policy(r.pool);
    if (dist === null) return 1;
    return (dist.get(r.action) || 0) * r.pool.length;
  });
}

export function ipwValue(rows, weights) {
  if (!rows.length) return null;
  let sum = 0;
  for (let i = 0; i < rows.length; i += 1) sum += weights[i] * rows[i].reward;
  return sum / rows.length;
}

export function snipwValue(rows, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < rows.length; i += 1) {
    num += weights[i] * rows[i].reward;
    den += weights[i];
  }
  return den > 0 ? num / den : null;
}

export function effectiveSampleSize(weights) {
  let s = 0;
  let s2 = 0;
  for (const w of weights) {
    s += w;
    s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

function bootstrap(n, iterations, seed, fn) {
  const next = mulberry32(seedFrom(seed));
  const values = [];
  for (let it = 0; it < iterations; it += 1) {
    const idx = new Array(n);
    for (let i = 0; i < n; i += 1) idx[i] = randomIndex(next, n);
    const v = fn(idx);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  return values;
}

const ci = (values, level) => ({ lower: percentileSorted(values, (1 - level) / 2), upper: percentileSorted(values, 1 - (1 - level) / 2) });

/** Value of one policy with percentile-bootstrap CIs (rows resampled). */
export function evaluatePolicy(rows, policy, { iterations = 1000, level = 0.95, seed = "ope" } = {}) {
  const weights = policyWeights(rows, policy);
  const pick = (idx) => ({ r: idx.map((i) => rows[i]), w: idx.map((i) => weights[i]) });
  const ipwBoot = bootstrap(rows.length, iterations, `${seed}:ipw`, (idx) => {
    const { r, w } = pick(idx);
    return ipwValue(r, w);
  });
  const snBoot = bootstrap(rows.length, iterations, `${seed}:snipw`, (idx) => {
    const { r, w } = pick(idx);
    return snipwValue(r, w);
  });
  return {
    n: rows.length,
    rows_with_mass: weights.filter((w) => w > 0).length,
    ess: effectiveSampleSize(weights),
    ipw: { estimate: ipwValue(rows, weights), ...ci(ipwBoot, level) },
    snipw: { estimate: snipwValue(rows, weights), ...ci(snBoot, level) },
    level,
    iterations,
  };
}

/** Paired bootstrap of SNIPW(policy) - on-policy mean (the logged policy's value). */
export function policyVsLogged(rows, policy, { iterations = 1000, level = 0.95, seed = "ope-diff" } = {}) {
  const weights = policyWeights(rows, policy);
  const diff = (idx) => {
    const r = idx.map((i) => rows[i]);
    const w = idx.map((i) => weights[i]);
    const v = snipwValue(r, w);
    const logged = r.reduce((a, x) => a + x.reward, 0) / r.length;
    return v === null ? null : v - logged;
  };
  const all = rows.map((_, i) => i);
  const values = bootstrap(rows.length, iterations, seed, diff);
  const bounds = ci(values, level);
  return { estimate: diff(all), ...bounds, excludes_zero: bounds.lower > 0 || bounds.upper < 0, level };
}

/**
 * Per-template reply rate: estimand E[r(t) | t in pool].
 *   naive  mean reward over rows that logged t;
 *   IPW    sum_{t in pool_i} 1[a_i = t] |pool_i| r_i / #{i : t in pool_i};
 *   SNIPW  same numerator / sum 1[a_i = t] |pool_i|.
 */
export function perTemplateEstimates(rows, { minEligible = 1, iterations = 500, level = 0.95, seed = "ope-template" } = {}) {
  const templates = new Set();
  for (const r of rows) for (const t of r.pool) templates.add(t);
  const out = [];
  for (const t of [...templates].sort()) {
    const eligible = rows.filter((r) => r.pool.includes(t));
    if (eligible.length < minEligible) continue;
    const chosen = rows.filter((r) => r.action === t);
    const policy = (pool) => (pool.includes(t) ? new Map([[t, 1]]) : null);
    const evald = evaluatePolicy(eligible, policy, { iterations, level, seed: `${seed}:${t}` });
    const naiveN = chosen.length;
    const naivePos = chosen.reduce((a, r) => a + r.reward, 0);
    out.push({
      template_id: t,
      eligible: eligible.length,
      logged: naiveN,
      positives: naivePos,
      naive: naiveN ? naivePos / naiveN : null,
      ipw: evald.ipw,
      snipw: evald.snipw,
      ess: evald.ess,
    });
  }
  return out;
}

/** Uniform over the pool members a predicate keeps; null (defer to logged) when it keeps none. */
export function restrictPolicy(keep) {
  return (pool) => {
    const kept = pool.filter((t) => keep(t));
    if (!kept.length) return null;
    return new Map(kept.map((t) => [t, 1 / kept.length]));
  };
}

export const uniformPolicy = (pool) => new Map(pool.map((t) => [t, 1 / pool.length]));
