// ─── scoringRankComparison.js ───────────────────────────────────────────────
// Legacy (Podio-era properties.final_acquisition_score) vs canonical
// (property_acquisition_scores.aos_score) ranking comparison. Pure functions;
// the script scripts/ops/scoring-ranking-comparison.mjs feeds them rows.
//
// This is the evidence the owner needs BEFORE retiring the legacy score from
// Campaign Build ordering: do the two scores order the same properties the
// same way, overall and within each market, and how much of the legacy top
// decile survives in the canonical top decile?

function finite(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : n;
}

/** Average ranks (1-based), ties share the mean of their positions. */
export function averageRanks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rho with tie correction (Pearson on average ranks). */
export function spearman(pairs) {
  if (pairs.length < 3) return null;
  return pearson(averageRanks(pairs.map((p) => p.legacy)), averageRanks(pairs.map((p) => p.canonical)));
}

/**
 * Top-fraction overlap: of the legacy top k, how many are also in the
 * canonical top k (k = ceil(n * fraction)). Ties at the boundary are broken by
 * property_id so the result is deterministic.
 */
export function topFractionOverlap(pairs, fraction = 0.1) {
  const n = pairs.length;
  if (!n) return null;
  const k = Math.max(1, Math.ceil(n * fraction));
  const top = (key) =>
    new Set(
      [...pairs]
        .sort((a, b) => b[key] - a[key] || String(a.property_id).localeCompare(String(b.property_id)))
        .slice(0, k)
        .map((p) => p.property_id),
    );
  const a = top('legacy');
  const b = top('canonical');
  let both = 0;
  for (const id of a) if (b.has(id)) both += 1;
  return { k, overlap: both, share: both / k, expected_if_random: fraction };
}

function summarize(pairs, { minN = 30 } = {}) {
  const n = pairs.length;
  return {
    n,
    spearman: n >= 3 ? round(spearman(pairs)) : null,
    top_decile: n >= 10 ? roundObj(topFractionOverlap(pairs, 0.1)) : null,
    top_quintile: n >= 5 ? roundObj(topFractionOverlap(pairs, 0.2)) : null,
    low_sample: n < minN,
  };
}

function round(v, p = 3) {
  return v === null || v === undefined ? null : Math.round(v * 10 ** p) / 10 ** p;
}

function roundObj(o) {
  if (!o) return o;
  return { ...o, share: round(o.share) };
}

/**
 * @param {Array<{property_id, market, legacy, canonical, decision_tier?}>} rows
 * @returns comparison report (overall + by market + coverage)
 */
export function buildRankComparison(rows = [], { minN = 30 } = {}) {
  const coverage = { rows: rows.length, legacy_only: 0, canonical_only: 0, both: 0, neither: 0 };
  const pairs = [];
  for (const r of rows) {
    const legacy = finite(r.legacy);
    const canonical = finite(r.canonical);
    if (legacy !== null && canonical !== null) {
      coverage.both += 1;
      pairs.push({ property_id: String(r.property_id), market: r.market || '(none)', legacy, canonical, decision_tier: r.decision_tier ?? null });
    } else if (legacy !== null) coverage.legacy_only += 1;
    else if (canonical !== null) coverage.canonical_only += 1;
    else coverage.neither += 1;
  }
  const byMarket = new Map();
  for (const p of pairs) {
    if (!byMarket.has(p.market)) byMarket.set(p.market, []);
    byMarket.get(p.market).push(p);
  }
  const markets = [...byMarket.entries()]
    .map(([market, list]) => ({ market, ...summarize(list, { minN }) }))
    .sort((a, b) => b.n - a.n);

  // Where does the legacy top decile land under the canonical decision tier?
  const tierOfLegacyTop = {};
  if (pairs.length >= 10) {
    const k = Math.ceil(pairs.length * 0.1);
    const legacyTop = [...pairs].sort((a, b) => b.legacy - a.legacy).slice(0, k);
    for (const p of legacyTop) {
      const t = p.decision_tier || '(none)';
      tierOfLegacyTop[t] = (tierOfLegacyTop[t] || 0) + 1;
    }
  }

  const overall = summarize(pairs, { minN });
  const ready = overall.n >= 1000 && markets.filter((m) => !m.low_sample).length > 0;
  return {
    coverage,
    overall,
    markets,
    legacy_top_decile_by_canonical_tier: tierOfLegacyTop,
    verdict_inputs: {
      // Never a recommendation by itself: the owner decides. These are the
      // facts the decision needs.
      overlap_n: overall.n,
      sufficient_overlap_for_decision: ready,
      note: ready
        ? 'overlap large enough to compare rankings'
        : 'overlap too small — complete the backfill before deciding',
    },
  };
}

export default { averageRanks, buildRankComparison, spearman, topFractionOverlap };
