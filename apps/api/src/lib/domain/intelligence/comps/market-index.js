/**
 * Market context for the IC8 comp micro-market challenger, computed AS OF a
 * date T from sales strictly before T only:
 *   - log-size elasticity beta (log price on log sqft, within-cell demeaned),
 *   - sale-regime offsets (investor / unknown vs the reference regime,
 *     estimated from within-cell paired medians so location does not leak in),
 *   - a simple market-level monthly index of location-demeaned residuals
 *     (trailing 3-month pooling, carried forward when thin).
 *
 * Every sale is then expressed as a "level": log price at the reference size,
 * net of regime offset and time-adjusted to the index month just before T.
 * Pure and deterministic.
 */
import { clamp, median, robustSd } from './stats.js';
import { monthIndex } from './comp-records.js';

export const MARKET_CONTEXT_PARAMS = Object.freeze({
  refSqft: 1500,
  betaPrior: 0.55,
  betaPriorWeight: 40,
  betaMin: 0.25,
  betaMax: 0.95,
  regimePriorCells: 5,
  regimePrior: { retail: 0, investor: -0.15, unknown: 0 },
  indexWindowMonths: 3,
  indexMinSales: 20,
  indexClamp: 0.25,
  minCellSalesForIndex: 3,
});

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function estimateBeta(rows, params) {
  const fit = (subset) => {
    let sxy = 0;
    let sxx = 0;
    let pairs = 0;
    for (const members of groupBy(subset, (r) => r.cell).values()) {
      if (members.length < 2) continue;
      const mx = members.reduce((s, r) => s + r.ls, 0) / members.length;
      const my = members.reduce((s, r) => s + r.lp, 0) / members.length;
      for (const r of members) {
        sxy += (r.ls - mx) * (r.lp - my);
        sxx += (r.ls - mx) ** 2;
      }
      pairs += members.length - 1;
    }
    return { beta: sxx > 1e-9 ? sxy / sxx : null, pairs };
  };
  const first = fit(rows);
  let estimate = first;
  if (first.beta !== null) {
    // One trimming pass: drop |residual| > 3 robust SD around a cell-median fit.
    const cellMed = new Map();
    for (const [cell, members] of groupBy(rows, (r) => r.cell)) {
      cellMed.set(cell, median(members.map((r) => r.lp - first.beta * r.ls)));
    }
    const resid = rows.map((r) => r.lp - first.beta * r.ls - cellMed.get(r.cell));
    const sd = robustSd(resid) || 0.3;
    const kept = rows.filter((_, i) => Math.abs(resid[i]) <= 3 * sd);
    const second = fit(kept);
    if (second.beta !== null) estimate = second;
  }
  const raw = estimate.beta ?? params.betaPrior;
  const shrunk = (raw * estimate.pairs + params.betaPrior * params.betaPriorWeight) / (estimate.pairs + params.betaPriorWeight);
  return { beta: clamp(shrunk, params.betaMin, params.betaMax), beta_raw: estimate.beta, pairs: estimate.pairs };
}

function estimateRegimeOffsets(rows, params) {
  const counts = { retail: 0, investor: 0, unknown: 0 };
  for (const r of rows) counts[r.regime] += 1;
  const total = rows.length || 1;
  const reference = counts.retail >= 0.25 * total
    ? 'retail'
    : Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const byCell = groupBy(rows, (r) => r.cell);
  const rho = { [reference]: 0 };
  const support = {};
  for (const regime of ['retail', 'investor', 'unknown']) {
    if (regime === reference) continue;
    const diffs = [];
    const weights = [];
    for (const members of byCell.values()) {
      const ref = members.filter((r) => r.regime === reference).map((r) => r.z0);
      const other = members.filter((r) => r.regime === regime).map((r) => r.z0);
      if (!ref.length || !other.length) continue;
      diffs.push(median(other) - median(ref));
      weights.push(Math.min(ref.length, other.length));
    }
    const cells = diffs.length;
    const prior = reference === 'retail' ? params.regimePrior[regime] : 0;
    let estimate = prior;
    if (cells) {
      // weighted median via expansion by integer weights (small counts)
      const expanded = [];
      diffs.forEach((d, i) => {
        for (let k = 0; k < weights[i]; k += 1) expanded.push(d);
      });
      const raw = median(expanded);
      estimate = (raw * cells + prior * params.regimePriorCells) / (cells + params.regimePriorCells);
    }
    rho[regime] = clamp(estimate, -0.8, 0.5);
    support[regime] = cells;
  }
  return { reference, rho, support, counts };
}

/**
 * @param {Array} sales  internal sales (comp-records.toSale) already filtered
 *                       to valid single-family evidence before `asOf`
 * @param {object} opts  { asOf: 'YYYY-MM-DD', cellOf: (lat,lng)=>({key}), params }
 */
export function buildMarketContext(sales, { asOf, cellOf, params = MARKET_CONTEXT_PARAMS } = {}) {
  const asOfMonth = monthIndex(asOf);
  const lnRef = Math.log(params.refSqft);
  const rows = [];
  for (const s of sales) {
    if (!(s.known_date < asOf) || !s.price || !s.sqft) continue;
    rows.push({
      id: s.id,
      lp: Math.log(s.price),
      ls: Math.log(s.sqft),
      m: monthIndex(s.sale_date),
      regime: s.regime,
      cell: cellOf(s.lat, s.lng).key,
    });
  }
  const betaFit = estimateBeta(rows, params);
  const beta = betaFit.beta;
  for (const r of rows) r.z0 = r.lp - beta * (r.ls - lnRef);
  const regimes = estimateRegimeOffsets(rows, params);
  for (const r of rows) r.z1 = r.z0 - (regimes.rho[r.regime] ?? 0);

  // Monthly index: alternate cell levels and month effects twice.
  const months = rows.length ? [Math.min(...rows.map((r) => r.m)), asOfMonth - 1] : [asOfMonth - 1, asOfMonth - 1];
  let index = new Map();
  const adjust = (m) => index.get(m) ?? 0;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const cellLevels = new Map();
    for (const [cell, members] of groupBy(rows, (r) => r.cell)) {
      if (members.length >= params.minCellSalesForIndex) cellLevels.set(cell, median(members.map((r) => r.z1 - adjust(r.m))));
    }
    const residualsByMonth = new Map();
    for (const r of rows) {
      if (!cellLevels.has(r.cell)) continue;
      if (!residualsByMonth.has(r.m)) residualsByMonth.set(r.m, []);
      residualsByMonth.get(r.m).push(r.z1 - cellLevels.get(r.cell));
    }
    const next = new Map();
    let carried = null;
    for (let m = months[0]; m <= months[1]; m += 1) {
      const pooled = [];
      for (let k = m - params.indexWindowMonths + 1; k <= m; k += 1) pooled.push(...(residualsByMonth.get(k) ?? []));
      if (pooled.length >= params.indexMinSales) carried = median(pooled);
      if (carried !== null) next.set(m, carried);
    }
    // Months before the first estimable window take the first estimate (flat).
    const firstValue = [...next.values()][0] ?? 0;
    for (let m = months[0]; m <= months[1]; m += 1) if (!next.has(m)) next.set(m, firstValue);
    index = next;
  }
  const refValue = index.get(months[1]) ?? 0;
  const timeAdjust = (saleDate) => {
    const m = monthIndex(saleDate);
    const value = index.has(m) ? index.get(m) : m < months[0] ? index.get(months[0]) ?? 0 : refValue;
    return clamp(refValue - value, -params.indexClamp, params.indexClamp);
  };

  const levelOf = (sale) => {
    if (!sale?.price || !sale?.sqft) return null;
    return Math.log(sale.price) - beta * (Math.log(sale.sqft) - lnRef) - (regimes.rho[sale.regime] ?? 0) + timeAdjust(sale.sale_date);
  };

  const levels = rows.map((r) => r.z1 + timeAdjust(`${Math.floor(r.m / 12)}-${String((r.m % 12) + 1).padStart(2, '0')}-01`));
  const cellResiduals = [];
  for (const members of groupBy(rows.map((r, i) => ({ ...r, z: levels[i] })), (r) => r.cell).values()) {
    if (members.length < 3) continue;
    const med = median(members.map((r) => r.z));
    for (const r of members) cellResiduals.push(r.z - med);
  }
  const sigmaWithin = clamp(robustSd(cellResiduals) ?? 0.3, 0.08, 0.8);

  return Object.freeze({
    asOf,
    n: rows.length,
    refSqft: params.refSqft,
    beta,
    betaRaw: betaFit.beta_raw,
    betaPairs: betaFit.pairs,
    regimeReference: regimes.reference,
    rho: Object.freeze({ retail: 0, investor: 0, unknown: 0, ...regimes.rho }),
    regimeSupportCells: regimes.support,
    regimeCounts: regimes.counts,
    indexMonths: months,
    index: Object.freeze(Object.fromEntries([...index.entries()].sort((x, y) => x[0] - y[0]).map(([m, v]) => [`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`, Math.round((v - refValue) * 10000) / 10000]))),
    sigmaWithin,
    timeAdjust,
    levelOf,
  });
}
