/**
 * Backtest metrics for the IC8 comp challenger: point error (MAE, MdAE, MAPE,
 * MdAPE), error distribution, interval coverage, PIT calibration, and seeded
 * bootstrap CIs for paired method differences. Pure and deterministic.
 */
import { mulberry32, normCdf, quantile, round } from './stats.js';

export const LOW_SUPPORT_N = 30;

function finite(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Summary of point and interval accuracy for [{ label, value, interval:[lo,hi]?, interval50? }]. */
export function summarize(rows) {
  const valued = rows.filter((r) => finite(r.value) && finite(r.label) && r.label > 0);
  const n = valued.length;
  const out = { n, low_support: n < LOW_SUPPORT_N };
  if (!n) return out;
  const abs = valued.map((r) => Math.abs(r.value - r.label));
  const ape = valued.map((r) => Math.abs(r.value - r.label) / r.label);
  const signed = valued.map((r) => (r.value - r.label) / r.label);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  out.mae = Math.round(mean(abs));
  out.mdae = Math.round(quantile(abs, 0.5));
  out.mape_pct = round(100 * mean(ape), 1);
  out.mdape_pct = round(100 * quantile(ape, 0.5), 1);
  out.median_signed_error_pct = round(100 * quantile(signed, 0.5), 1);
  out.within_10_pct = round((100 * ape.filter((x) => x <= 0.1).length) / n, 1);
  out.within_20_pct = round((100 * ape.filter((x) => x <= 0.2).length) / n, 1);
  out.ape_pct_quantiles = Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9].map((q) => [`p${Math.round(q * 100)}`, round(100 * quantile(ape, q), 1)]));
  const withInterval = valued.filter((r) => Array.isArray(r.interval) && finite(r.interval[0]) && finite(r.interval[1]));
  if (withInterval.length) {
    out.interval_n = withInterval.length;
    out.interval_coverage_pct = round((100 * withInterval.filter((r) => r.label >= r.interval[0] && r.label <= r.interval[1]).length) / withInterval.length, 1);
    out.interval_median_width_pct = round(100 * quantile(withInterval.map((r) => (r.interval[1] - r.interval[0]) / r.value), 0.5), 1);
  }
  const with50 = valued.filter((r) => Array.isArray(r.interval50));
  if (with50.length) {
    out.interval50_coverage_pct = round((100 * with50.filter((r) => r.label >= r.interval50[0] && r.label <= r.interval50[1]).length) / with50.length, 1);
  }
  return out;
}

/** PIT histogram (deciles) and coverage at nominal levels for log-normal predictive distributions. */
export function pitCalibration(rows) {
  const usable = rows.filter((r) => finite(r.label) && r.label > 0 && finite(r.logCenter) && finite(r.sigma) && r.sigma > 0);
  if (!usable.length) return { n: 0 };
  const u = usable.map((r) => normCdf((Math.log(r.label) - r.logCenter) / r.sigma));
  const bins = new Array(10).fill(0);
  for (const x of u) bins[Math.min(9, Math.floor(x * 10))] += 1;
  const coverage = {};
  for (const level of [0.5, 0.8, 0.9]) {
    const lo = 0.5 - level / 2;
    const hi = 0.5 + level / 2;
    coverage[`nominal_${Math.round(level * 100)}`] = round((100 * u.filter((x) => x >= lo && x <= hi).length) / u.length, 1);
  }
  return { n: u.length, pit_decile_share_pct: bins.map((b) => round((100 * b) / u.length, 1)), coverage_pct: coverage };
}

/**
 * Paired comparison on the subjects both methods valued: median of the
 * per-subject APE difference (A - B), with a seeded bootstrap 90% CI.
 * Negative => A is more accurate.
 */
export function pairedApeDifference(pairs, { iterations = 500, seed = 7 } = {}) {
  const diffs = pairs
    .filter((p) => finite(p.a) && finite(p.b) && finite(p.label) && p.label > 0)
    .map((p) => Math.abs(p.a - p.label) / p.label - Math.abs(p.b - p.label) / p.label);
  if (!diffs.length) return { n: 0 };
  const rng = mulberry32(seed);
  const meds = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = new Array(diffs.length);
    for (let j = 0; j < diffs.length; j += 1) sample[j] = diffs[Math.floor(rng() * diffs.length)];
    meds.push(quantile(sample, 0.5));
  }
  meds.sort((x, y) => x - y);
  return {
    n: diffs.length,
    median_ape_diff_pp: round(100 * quantile(diffs, 0.5), 2),
    ci90_pp: [round(100 * quantile(meds, 0.05), 2), round(100 * quantile(meds, 0.95), 2)],
    share_a_better_pct: round((100 * diffs.filter((d) => d < 0).length) / diffs.length, 1),
  };
}

export function priceBand(price) {
  if (price < 100_000) return '<100k';
  if (price < 200_000) return '100-200k';
  if (price < 350_000) return '200-350k';
  if (price < 600_000) return '350-600k';
  return '600k+';
}

export function densityClassFromCount(count) {
  if (count >= 20) return 'dense(>=20)';
  if (count >= 5) return 'medium(5-19)';
  return 'sparse(<5)';
}
