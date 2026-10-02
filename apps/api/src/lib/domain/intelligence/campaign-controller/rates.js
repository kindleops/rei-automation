/**
 * IC8 CAMPAIGN CONTROLLER v0 -- shrunk rates with credible intervals.
 *
 * Built only from the foundation's beta-binomial primitives (fitBetaPrior,
 * posteriorInterval): every campaign rate is shrunk market -> campaign (and
 * template rates market -> campaign -> template), and reported as a
 * posterior mean with an equal-tailed credible interval at the envelope's
 * credible_level. A raw ratio is kept for evidence only and never decides.
 */

import { fitBetaPrior, posteriorInterval } from "../models/beta-binomial.js";

/**
 * Prior strength cap, in pseudo-sends. The marginal-ML concentration runs to
 * its 1e5 boundary whenever a handful of groups look mutually consistent
 * (measured: 3 campaigns, 2/71 vs 13/640 vs 0/13 -> kappa 1e5, every interval
 * +-0.07pp around the pooled mean), which would let one campaign's data
 * "credibly" condemn another. No prior may outweigh 100 sends of the
 * campaign's own evidence.
 */
export const MAX_PRIOR_STRENGTH = 100;
const MIN_PRIOR_STRENGTH = 2;

const clampCount = (s, n) => Math.max(0, Math.min(Number(s) || 0, Number(n) || 0));
const cleanRows = (rows, keys) =>
  rows.map((r) => {
    const out = { trials: Math.max(0, Number(r.trials) || 0) };
    out.successes = clampCount(r.successes, out.trials);
    for (const k of keys) out[k] = String(r[k] ?? "unknown");
    return out;
  });

function aggregate(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    const g = groups.get(key) || { key, successes: 0, trials: 0 };
    g.successes += r.successes;
    g.trials += r.trials;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const strength = (prior) => Math.min(MAX_PRIOR_STRENGTH, Math.max(MIN_PRIOR_STRENGTH, prior.concentration));
const centred = (mean, kappa) => {
  const m = Math.min(1 - 1e-6, Math.max(1e-6, mean));
  return { alpha: m * kappa, beta: (1 - m) * kappa };
};
const asRate = (g, post, level) => ({ successes: g.successes, trials: g.trials, raw: g.trials ? g.successes / g.trials : null, mean: post.mean, lower: post.lower, upper: post.upper, level });

/**
 * Nested empirical-Bayes shrinkage built from the foundation primitives:
 * level 0 groups shrink toward a prior fitted across them (fitBetaPrior,
 * concentration capped at MAX_PRIOR_STRENGTH); each child shrinks toward its
 * parent's posterior mean with a strength fitted across all children of that
 * level (same cap). Returns one Map per level, keyed by the joined path.
 */
function nestedShrink(rows, levels, level) {
  const out = [];
  let parentMean = new Map();
  for (let depth = 0; depth < levels.length; depth += 1) {
    const keyOf = (r) => levels.slice(0, depth + 1).map((l) => r[l]).join("|");
    const parentOf = (r) => levels.slice(0, depth).map((l) => r[l]).join("|");
    const groups = aggregate(rows, keyOf);
    const parents = new Map(rows.map((r) => [keyOf(r), parentOf(r)]));
    const fitted = fitBetaPrior(groups, { maxConcentration: MAX_PRIOR_STRENGTH });
    const kappa = strength(fitted);
    const map = new Map();
    for (const g of groups) {
      const centre = depth === 0 ? fitted.mean : parentMean.get(parents.get(g.key));
      map.set(g.key, asRate(g, posteriorInterval(g.successes, g.trials, centred(centre, kappa), { level }), level));
    }
    out.push(map);
    parentMean = new Map([...map.entries()].map(([k, v]) => [k, v.mean]));
  }
  return out;
}

/**
 * rows: [{ market, campaign, successes, trials }] -> Map(campaign -> rate)
 * rate: { successes, trials, raw, mean, lower, upper, level }
 */
export function shrinkByCampaign(rows, { level = 0.9 } = {}) {
  const clean = cleanRows(rows, ["market", "campaign"]);
  const out = new Map();
  if (!clean.length) return out;
  const [, campaigns] = nestedShrink(clean, ["market", "campaign"], level);
  for (const [key, rate] of campaigns) out.set(key.split("|")[1], rate);
  return out;
}

/** Template rates: rows [{ market, campaign, template, successes, trials }] -> Map("campaign|template" -> rate). */
export function shrinkByTemplate(rows, { level = 0.9 } = {}) {
  const clean = cleanRows(rows, ["market", "campaign", "template"]);
  const out = new Map();
  if (!clean.length) return out;
  const levelsOut = nestedShrink(clean, ["market", "campaign", "template"], level);
  for (const [key, rate] of levelsOut[2]) {
    const [, campaign, template] = key.split("|");
    out.set(`${campaign}|${template}`, rate);
  }
  return out;
}

/**
 * Severity of a rate against a ceiling ("max") or floor ("min"):
 *   stop      the whole credible interval is on the wrong side
 *   throttle  the posterior mean is on the wrong side
 *   ok        otherwise
 */
export function severityOf(rate, limit, direction) {
  if (!rate) return "not_evaluable";
  if (direction === "max") {
    if (rate.lower > limit) return "stop";
    if (rate.mean > limit) return "throttle";
    return "ok";
  }
  if (rate.upper < limit) return "stop";
  if (rate.mean < limit) return "throttle";
  return "ok";
}

/** "clearly healthy" for scale: the interval's unfavourable end is still inside the limit. */
export function clearlyHealthy(rate, limit, direction) {
  if (!rate) return false;
  return direction === "max" ? rate.upper <= limit : rate.lower >= limit;
}
