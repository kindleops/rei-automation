/**
 * Small deterministic statistics helpers for the IC8 comp micro-market
 * challenger. Pure functions; no I/O; seeded randomness only.
 */

export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function sortedNumbers(values) {
  return values.filter(isNum).sort((a, b) => a - b);
}

/** Linear-interpolated quantile (type 7) of an ascending array. */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantile(values, q) {
  return quantileSorted(sortedNumbers(values), q);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function medianSorted(sorted) {
  return quantileSorted(sorted, 0.5);
}

/** Median absolute deviation (raw, not scaled). */
export function mad(values, center = median(values)) {
  if (center === null) return null;
  return median(values.filter(isNum).map((v) => Math.abs(v - center)));
}

/** Robust standard deviation: 1.4826 x MAD. */
export function robustSd(values) {
  const m = mad(values);
  return m === null ? null : 1.4826 * m;
}

/**
 * Weighted quantile: interpolates on the cumulative weight midpoints, which is
 * continuous in the weights (no step when a weight changes slightly).
 */
export function weightedQuantile(values, weights, q) {
  const pairs = [];
  for (let i = 0; i < values.length; i += 1) {
    const w = weights[i];
    if (isNum(values[i]) && isNum(w) && w > 0) pairs.push([values[i], w]);
  }
  if (!pairs.length) return null;
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pairs.length === 1) return pairs[0][0];
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let cum = 0;
  const points = pairs.map(([v, w]) => {
    const mid = (cum + w / 2) / total;
    cum += w;
    return [mid, v];
  });
  const target = Math.min(1, Math.max(0, q));
  if (target <= points[0][0]) return points[0][1];
  if (target >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i += 1) {
    if (target <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (target - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

export function weightedMedian(values, weights) {
  return weightedQuantile(values, weights, 0.5);
}

export function weightedMean(values, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (isNum(values[i]) && isNum(weights[i]) && weights[i] > 0) {
      num += values[i] * weights[i];
      den += weights[i];
    }
  }
  return den > 0 ? num / den : null;
}

/** Deterministic 32-bit string hash (FNV-1a). */
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-th smallest of buf[0..n) in place (Hoare quickselect). */
function selectInPlace(buf, n, k) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = buf[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (buf[i] < pivot) i += 1;
      while (buf[j] > pivot) j -= 1;
      if (i <= j) {
        const t = buf[i];
        buf[i] = buf[j];
        buf[j] = t;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return buf[k];
  }
  return buf[k];
}

function resampleMedian(values, rng, buf) {
  const n = values.length;
  for (let i = 0; i < n; i += 1) buf[i] = values[Math.floor(rng() * n)];
  const upper = selectInPlace(buf, n, n >> 1);
  if (n % 2) return upper;
  let lowerMax = -Infinity;
  for (let i = 0; i < n >> 1; i += 1) if (buf[i] > lowerMax) lowerMax = buf[i];
  return (lowerMax + upper) / 2;
}

/**
 * Bootstrap confidence interval of median(a) - median(b).
 * Returns { diff, lo, hi, iterations } with a percentile CI at level (1 - alpha).
 */
export function bootstrapMedianGap(a, b, { iterations = 200, alpha = 0.1, seed = 1 } = {}) {
  const sa = sortedNumbers(a);
  const sb = sortedNumbers(b);
  if (!sa.length || !sb.length) return null;
  const rng = mulberry32(seed);
  const bufA = new Float64Array(sa.length);
  const bufB = new Float64Array(sb.length);
  const diffs = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) diffs[i] = resampleMedian(sa, rng, bufA) - resampleMedian(sb, rng, bufB);
  diffs.sort((x, y) => x - y);
  return {
    diff: medianSorted(sa) - medianSorted(sb),
    lo: quantileSorted(diffs, alpha / 2),
    hi: quantileSorted(diffs, 1 - alpha / 2),
    iterations,
  };
}

/** Bootstrap standard error of a weighted median (resampling the comps). */
export function bootstrapWeightedMedianSe(values, weights, { iterations = 200, seed = 1 } = {}) {
  const n = values.length;
  if (n < 2) return null;
  const rng = mulberry32(seed);
  const meds = [];
  for (let i = 0; i < iterations; i += 1) {
    const v = new Array(n);
    const w = new Array(n);
    for (let j = 0; j < n; j += 1) {
      const k = Math.floor(rng() * n);
      v[j] = values[k];
      w[j] = weights[k];
    }
    const m = weightedMedian(v, w);
    if (m !== null) meds.push(m);
  }
  if (meds.length < 2) return null;
  const mean = meds.reduce((s, x) => s + x, 0) / meds.length;
  const variance = meds.reduce((s, x) => s + (x - mean) ** 2, 0) / (meds.length - 1);
  return Math.sqrt(variance);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** Standard normal quantile (Acklam's rational approximation). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function round(value, digits = 0) {
  if (!isNum(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}
