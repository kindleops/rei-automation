/**
 * Acquisition Engine V3 — shared deterministic math helpers.
 * No I/O, no randomness, no Date.now (callers pass `now`).
 */

import { num, clamp, round } from './modelConstants.js';

/** Population mean of finite numbers. */
export function mean(values = []) {
  const xs = values.map((v) => num(v)).filter((v) => v !== null);
  if (!xs.length) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Population standard deviation. */
export function stddev(values = []) {
  const xs = values.map((v) => num(v)).filter((v) => v !== null);
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Simple (unweighted) median. */
export function median(values = []) {
  const xs = values.map((v) => num(v)).filter((v) => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Weighted quantile over [{ value, weight }]. q in [0,1].
 * Deterministic; ignores non-finite values/weights.
 */
export function weightedQuantile(rows = [], q = 0.5) {
  const pts = rows
    .map((r) => ({ value: num(r.value), weight: num(r.weight, 0) }))
    .filter((r) => r.value !== null && r.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!pts.length) return null;
  const total = pts.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return null;
  const target = clamp(q, 0, 1) * total;
  let cum = 0;
  for (const p of pts) {
    cum += p.weight;
    if (cum >= target) return p.value;
  }
  return pts[pts.length - 1].value;
}

export function weightedMean(rows = []) {
  const pts = rows
    .map((r) => ({ value: num(r.value), weight: num(r.weight, 0) }))
    .filter((r) => r.value !== null && r.weight > 0);
  const total = pts.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return null;
  return pts.reduce((s, p) => s + p.value * p.weight, 0) / total;
}

/** Coefficient of dispersion (stddev / mid), bounded [0, ~]. */
export function dispersionRatio(values = [], center = null) {
  const c = center ?? mean(values);
  if (!c) return 1;
  return stddev(values) / c;
}

/** Whole months between an ISO/date-ish value and `now` (>= 0). */
export function monthsBetween(dateValue, now = new Date()) {
  if (!dateValue) return null;
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const ms = now.getTime() - d.getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24 * 30.4375));
}

/** Exponential recency score 0..100 with configurable half-life (months). */
export function recencyScore(months, halfLifeMonths = 18) {
  if (months === null || months === undefined) return 50; // unknown → neutral
  const m = Math.max(0, num(months, 0));
  return clamp(100 * 0.5 ** (m / halfLifeMonths), 0, 100);
}

/** Monthly amortizing payment (principal & interest). */
export function amortizedPayment(principal, annualRate, termMonths) {
  const p = num(principal, 0);
  const n = Math.max(1, Math.round(num(termMonths, 0)));
  const r = num(annualRate, 0) / 12;
  if (p <= 0) return 0;
  if (r === 0) return p / n;
  return (p * r) / (1 - (1 + r) ** -n);
}

/** Remaining balance on an amortizing loan after k payments. */
export function remainingBalance(principal, annualRate, termMonths, paidMonths) {
  const p = num(principal, 0);
  const r = num(annualRate, 0) / 12;
  const n = Math.max(1, Math.round(num(termMonths, 0)));
  const k = clamp(num(paidMonths, 0), 0, n);
  if (p <= 0) return 0;
  if (r === 0) return Math.max(0, p * (1 - k / n));
  const pmt = amortizedPayment(p, annualRate, n);
  return Math.max(0, p * (1 + r) ** k - pmt * (((1 + r) ** k - 1) / r));
}

/** Net present value at a periodic rate. cashflows[0] is t=0. */
export function npv(rate, cashflows = []) {
  return cashflows.reduce((s, cf, t) => s + num(cf, 0) / (1 + rate) ** t, 0);
}

/** IRR via bisection over a bounded range. Returns null if no sign change. */
export function irr(cashflows = [], { lo = -0.95, hi = 2, iterations = 80 } = {}) {
  const f = (r) => npv(r, cashflows);
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  if (!(Number.isFinite(fa) && Number.isFinite(fb)) || fa * fb > 0) return null;
  for (let i = 0; i < iterations; i += 1) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.abs(fm) < 1e-6) return m;
    if (fa * fm < 0) {
      b = m;
      fb = fm;
    } else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/** Bounded linear factor: maps x in [inLo,inHi] to [outLo,outHi], clamped. */
export function boundedFactor(x, inLo, inHi, outLo, outHi) {
  const v = num(x);
  if (v === null || inHi === inLo) return outLo;
  const t = clamp((v - inLo) / (inHi - inLo), 0, 1);
  return outLo + t * (outHi - outLo);
}

export { round };
