/**
 * IC8 BETA-BINOMIAL / EMPIRICAL-BAYES RATES (architecture §8, §12.5).
 *
 * For sparse rates (market -> campaign -> template reply rates, campaign-day
 * rates) a raw ratio of 2/9 is noise. A Beta(alpha, beta) prior is fitted
 * across groups by marginal maximum likelihood (deterministic golden-section
 * coordinate ascent; no randomness), each group's posterior is
 * Beta(alpha + s, beta + n - s), and every rate is reported with an
 * equal-tailed credible interval. Small groups are flagged low_support.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

function betaContinuedFraction(x, a, b) {
  const MAXIT = 5000;
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** I_x(a, b), the Beta(a, b) CDF at x. */
export function regularizedIncompleteBeta(x, a, b) {
  if (!(a > 0) || !(b > 0)) throw new RangeError("beta parameters must be > 0");
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Beta(a, b) quantile by bisection (deterministic). */
export function betaQuantile(p, a, b, { iterations = 100 } = {}) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Sum over groups of log BetaBinomial(s | n, alpha, beta), without the binomial coefficient. */
export function betaBinomialLogLikelihood(groups, alpha, beta) {
  let total = 0;
  const base = logBeta(alpha, beta);
  for (const g of groups) total += logBeta(g.successes + alpha, g.trials - g.successes + beta) - base;
  return total;
}

function goldenSectionMax(f, lo, hi, iterations = 80) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i += 1) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

const logit = (p) => Math.log(p / (1 - p));
const expit = (z) => 1 / (1 + Math.exp(-z));
const MU_MIN = 1e-6;
const MU_MAX = 1 - 1e-6;

function validateGroups(groups) {
  return groups.map((g, i) => {
    const successes = Number(g.successes);
    const trials = Number(g.trials);
    if (!Number.isFinite(successes) || !Number.isFinite(trials) || successes < 0 || trials < 0 || successes > trials) {
      throw new RangeError(`group ${g.key ?? i} has invalid successes/trials`);
    }
    return { ...g, successes, trials };
  });
}

/**
 * Fit a Beta prior across groups by marginal maximum likelihood over
 * (mean, concentration). With fewer than two informative groups the prior
 * falls back to the pooled mean with a weak concentration (2), flagged.
 */
export function fitBetaPrior(rawGroups, { minConcentration = 1e-2, maxConcentration = 1e5, rounds = 40 } = {}) {
  const groups = validateGroups(rawGroups).filter((g) => g.trials > 0);
  const totalS = groups.reduce((a, g) => a + g.successes, 0);
  const totalN = groups.reduce((a, g) => a + g.trials, 0);
  const pooled = totalN > 0 ? Math.min(MU_MAX, Math.max(MU_MIN, totalS / totalN)) : 0.5;
  if (groups.length < 2) {
    return { alpha: pooled * 2, beta: (1 - pooled) * 2, mean: pooled, concentration: 2, method: "weak_pooled_fallback", boundary: false, groups: groups.length };
  }
  let mu = pooled;
  let logKappa = Math.log(10);
  const ll = (m, lk) => {
    const kappa = Math.exp(lk);
    return betaBinomialLogLikelihood(groups, m * kappa, (1 - m) * kappa);
  };
  for (let round = 0; round < rounds; round += 1) {
    const z = goldenSectionMax((value) => ll(expit(value), logKappa), logit(MU_MIN), logit(MU_MAX));
    mu = Math.min(MU_MAX, Math.max(MU_MIN, expit(z)));
    logKappa = goldenSectionMax((value) => ll(mu, value), Math.log(minConcentration), Math.log(maxConcentration));
  }
  const concentration = Math.exp(logKappa);
  return {
    alpha: mu * concentration,
    beta: (1 - mu) * concentration,
    mean: mu,
    concentration,
    method: "marginal_mle",
    boundary: concentration > maxConcentration * 0.99 || concentration < minConcentration * 1.01,
    groups: groups.length,
  };
}

export function posteriorInterval(successes, trials, prior, { level = 0.9 } = {}) {
  const alpha = prior.alpha + successes;
  const beta = prior.beta + trials - successes;
  const tail = (1 - level) / 2;
  return {
    alpha,
    beta,
    mean: alpha / (alpha + beta),
    lower: betaQuantile(tail, alpha, beta),
    upper: betaQuantile(1 - tail, alpha, beta),
    level,
  };
}

/** Shrink every group toward a fitted (or given) prior; intervals and low_support per group. */
export function shrinkRates(rawGroups, { prior = null, level = 0.9, lowSupportTrials = 30 } = {}) {
  const groups = validateGroups(rawGroups);
  const fitted = prior || fitBetaPrior(groups);
  const rates = groups.map((g) => {
    const post = posteriorInterval(g.successes, g.trials, fitted, { level });
    return {
      key: g.key ?? null,
      successes: g.successes,
      trials: g.trials,
      raw_rate: g.trials ? g.successes / g.trials : null,
      posterior_mean: post.mean,
      lower: post.lower,
      upper: post.upper,
      alpha: post.alpha,
      beta: post.beta,
      level,
      low_support: g.trials < lowSupportTrials,
    };
  });
  return { prior: fitted, rates };
}

function fitChildConcentration(children, { minConcentration = 1e-2, maxConcentration = 1e5 } = {}) {
  const informative = children.filter((c) => c.trials > 0);
  if (informative.length < 2) return { concentration: 2, method: "weak_fallback" };
  const ll = (lk) => {
    const kappa = Math.exp(lk);
    let total = 0;
    for (const c of informative) {
      const m = Math.min(MU_MAX, Math.max(MU_MIN, c.parentMean));
      total += logBeta(c.successes + m * kappa, c.trials - c.successes + (1 - m) * kappa) - logBeta(m * kappa, (1 - m) * kappa);
    }
    return total;
  };
  const lk = goldenSectionMax(ll, Math.log(minConcentration), Math.log(maxConcentration));
  return { concentration: Math.exp(lk), method: "marginal_mle_given_parent" };
}

/**
 * Nested shrinkage, e.g. levels ["market", "campaign", "template"]: markets
 * shrink toward a global prior, each campaign toward its market's posterior
 * mean, each template toward its campaign's, with one concentration fitted
 * per level. rows: atomic { [level]: key, successes, trials }.
 */
export function hierarchicalShrink(rows, { levels, level = 0.9, lowSupportTrials = 30 } = {}) {
  if (!Array.isArray(levels) || !levels.length) throw new RangeError("levels are required");
  const clean = validateGroups(rows);
  const out = [];
  let parentMeans = new Map([["", null]]);
  for (let depth = 0; depth < levels.length; depth += 1) {
    const groups = new Map();
    for (const row of clean) {
      const path = levels.slice(0, depth + 1).map((l) => String(row[l] ?? "unknown"));
      const key = path.join(" / ");
      if (!groups.has(key)) groups.set(key, { key, path, parentKey: path.slice(0, -1).join(" / "), successes: 0, trials: 0 });
      const g = groups.get(key);
      g.successes += row.successes;
      g.trials += row.trials;
    }
    const list = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
    let priorInfo;
    const posteriors = new Map();
    if (depth === 0) {
      const prior = fitBetaPrior(list);
      priorInfo = { method: prior.method, mean: prior.mean, concentration: prior.concentration };
      for (const g of list) posteriors.set(g.key, posteriorInterval(g.successes, g.trials, prior, { level }));
    } else {
      const children = list.map((g) => ({ ...g, parentMean: parentMeans.get(g.parentKey) }));
      const fit = fitChildConcentration(children);
      priorInfo = { method: fit.method, concentration: fit.concentration };
      for (const c of children) {
        const m = Math.min(MU_MAX, Math.max(MU_MIN, c.parentMean));
        posteriors.set(c.key, posteriorInterval(c.successes, c.trials, { alpha: m * fit.concentration, beta: (1 - m) * fit.concentration }, { level }));
      }
    }
    const nextParentMeans = new Map();
    const rates = list.map((g) => {
      const post = posteriors.get(g.key);
      nextParentMeans.set(g.key, post.mean);
      return {
        key: g.key,
        path: g.path,
        successes: g.successes,
        trials: g.trials,
        raw_rate: g.trials ? g.successes / g.trials : null,
        posterior_mean: post.mean,
        lower: post.lower,
        upper: post.upper,
        level,
        low_support: g.trials < lowSupportTrials,
      };
    });
    out.push({ level: levels[depth], prior: priorInfo, rates });
    parentMeans = nextParentMeans;
  }
  return out;
}
