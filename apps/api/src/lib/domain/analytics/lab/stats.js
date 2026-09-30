/**
 * ANALYTICS LAB — statistics. Small, dependency-free, tested.
 *
 * Every "what changed" claim passes through one of these tests; a change that
 * does not pass is reported as "not a meaningful change", never as a finding.
 * Language contract: results are ASSOCIATIONS; contribution analysis says what
 * "contributed to the observed change", never what caused it.
 */

export const Z95 = 1.959963984540054

/** Wilson score interval for x successes in n trials. */
export function wilson(x, n, z = Z95) {
  if (!(n > 0)) return null
  const p = x / n
  const z2 = z * z
  const den = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
const twoSided = (z) => Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.abs(z)))))

/**
 * Two-proportion comparison: difference in points, Newcombe (hybrid Wilson)
 * 95% interval, pooled z-test p-value.
 */
export function compareProportions(x1, n1, x0, n0) {
  if (!(n1 > 0) || !(n0 > 0)) return null
  const p1 = x1 / n1
  const p0 = x0 / n0
  const w1 = wilson(x1, n1)
  const w0 = wilson(x0, n0)
  const d = p1 - p0
  const low = d - Math.sqrt((p1 - w1.low) ** 2 + (w0.high - p0) ** 2)
  const high = d + Math.sqrt((w1.high - p1) ** 2 + (p0 - w0.low) ** 2)
  const pool = (x1 + x0) / (n1 + n0)
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n0))
  const z = se > 0 ? d / se : 0
  return { diff: d, low, high, z, p: se > 0 ? twoSided(z) : 1 }
}

function logChoose(n, k) {
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i)
  return s
}
/**
 * Counts in two windows of (possibly unequal) length: conditional on the
 * total, the current count is Binomial(total, w) with w = len1/(len1+len0)
 * under "same rate per unit time". Exact below 200 events, normal above.
 */
export function compareCounts(c1, c0, len1 = 1, len0 = 1) {
  const n = c1 + c0
  if (!(n > 0)) return { p: 1, z: 0, expected: 0 }
  const w = len1 / (len1 + len0)
  const expected = n * w
  if (n > 200) {
    const z = (c1 - expected) / Math.sqrt(n * w * (1 - w))
    return { p: twoSided(z), z, expected }
  }
  // exact two-sided: sum probabilities no larger than the observed one
  const lw = Math.log(w)
  const l1w = Math.log(1 - w)
  const logp = (k) => logChoose(n, k) + k * lw + (n - k) * l1w
  const obs = logp(c1)
  let p = 0
  for (let k = 0; k <= n; k++) { const lk = logp(k); if (lk <= obs + 1e-9) p += Math.exp(lk) }
  const z = (c1 - expected) / Math.sqrt(Math.max(1e-9, n * w * (1 - w)))
  return { p: Math.min(1, p), z, expected }
}

/** Mann–Whitney U (normal approximation, tie-corrected ranks). For durations. */
export function mannWhitney(a, b) {
  const n1 = a.length
  const n2 = b.length
  if (n1 < 8 || n2 < 8) return null
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0])
  const ranks = new Array(all.length)
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++
    const r = (i + j + 2) / 2
    for (let k = i; k <= j; k++) ranks[k] = r
    i = j + 1
  }
  let r1 = 0
  all.forEach(([, g], i) => { if (g === 0) r1 += ranks[i] })
  const u1 = r1 - (n1 * (n1 + 1)) / 2
  const mu = (n1 * n2) / 2
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)
  const z = sigma > 0 ? (u1 - mu) / sigma : 0
  return { u: u1, z, p: twoSided(z) }
}

/** Linear-interpolated percentile of a numeric list (q in [0,1]). */
export function percentile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo] + (v[hi] - v[lo]) * (pos - lo)
}
export function distribution(values) {
  const v = values.filter((x) => Number.isFinite(x))
  return { n: v.length, p25: percentile(v, 0.25), p50: percentile(v, 0.5), p75: percentile(v, 0.75), p90: percentile(v, 0.9), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null }
}

/**
 * Rate change decomposition across groups (midpoint / Shapley form): for each
 * group g, contribution = s̄_g·Δr_g (rate effect) + Δs_g·r̄_g (mix effect),
 * where s is the group's share of the denominator and r its rate. The
 * contributions sum EXACTLY to the total change in the rate.
 */
export function decomposeRateChange(groups) {
  const D1 = groups.reduce((a, g) => a + g.d1, 0)
  const D0 = groups.reduce((a, g) => a + g.d0, 0)
  if (!(D1 > 0) || !(D0 > 0)) return null
  const R1 = groups.reduce((a, g) => a + g.n1, 0) / D1
  const R0 = groups.reduce((a, g) => a + g.n0, 0) / D0
  const rows = groups.map((g) => {
    const s1 = g.d1 / D1
    const s0 = g.d0 / D0
    const r1 = g.d1 > 0 ? g.n1 / g.d1 : null
    const r0 = g.d0 > 0 ? g.n0 / g.d0 : null
    let rateEffect = 0
    let mixEffect = 0
    if (r1 !== null && r0 !== null) {
      rateEffect = ((s1 + s0) / 2) * (r1 - r0)
      mixEffect = (s1 - s0) * ((r1 + r0) / 2)
    } else if (r1 !== null) mixEffect = s1 * r1 // group new in the current period
    else if (r0 !== null) mixEffect = -s0 * r0 // group absent now
    return { ...g, s1, s0, r1, r0, rateEffect, mixEffect, contribution: rateEffect + mixEffect }
  })
  return { total: R1 - R0, r1: R1, r0: R0, rows }
}
