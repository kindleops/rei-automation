// Time-based backtesting harness. NEVER random splits: scoring as-of T uses
// features with inputs <= T; labels come from the (T, T+h] window; rows without
// full windows are censored and excluded from rate denominators (reported).
// Metrics unavailable in a run are reported as 'UNAVAILABLE', never 0.
export const TOP_FRACTIONS = [0.005, 0.01, 0.02, 0.05, 0.10];

export function liftAtK(scored, { fraction }) {
  // scored: [{ score, label }] with label in {1,0}; censored rows must be
  // filtered by the caller BEFORE this function (they have no denominator).
  const eligible = scored.filter((r) => r.label === 0 || r.label === 1);
  if (eligible.length === 0) return { state: 'UNAVAILABLE', reason: 'no labeled rows' };
  const base = eligible.reduce((s, r) => s + r.label, 0) / eligible.length;
  if (base === 0) return { state: 'UNAVAILABLE', reason: 'no positive labels in split' };
  const k = Math.max(1, Math.floor(eligible.length * fraction));
  const top = [...eligible].sort((a, b) => b.score - a.score).slice(0, k);
  const topRate = top.reduce((s, r) => s + r.label, 0) / k;
  return {
    state: 'ok', k, base_rate: round(base), top_rate: round(topRate),
    lift: round(topRate / base),
    precision: round(topRate),
    recall: round(top.reduce((s, r) => s + r.label, 0) / eligible.reduce((s, r) => s + r.label, 0)),
  };
}

export function calibrationBins(scored, bins = 10) {
  const eligible = scored.filter((r) => r.label === 0 || r.label === 1);
  if (eligible.length < bins * 5) return { state: 'UNAVAILABLE', reason: 'insufficient rows for calibration' };
  const sorted = [...eligible].sort((a, b) => a.score - b.score);
  const out = [];
  const per = Math.floor(sorted.length / bins);
  for (let b = 0; b < bins; b += 1) {
    const chunk = sorted.slice(b * per, b === bins - 1 ? sorted.length : (b + 1) * per);
    out.push({
      bin: b, mean_score: round(chunk.reduce((s, r) => s + r.score, 0) / chunk.length),
      observed_rate: round(chunk.reduce((s, r) => s + r.label, 0) / chunk.length),
      n: chunk.length,
    });
  }
  return { state: 'ok', bins: out };
}

// Compare scorers across time-ordered as-of points.
export function compareScorers({ rows, scorers, horizons }) {
  // rows: [{ property_id, as_of, labels: {sale_90d:'positive'|'negative'|'censored'}, scores: {scorerName: number} }]
  const report = {};
  for (const h of horizons) {
    const key = `sale_${h}d`;
    const labeled = rows
      .filter((r) => r.labels[key] === 'positive' || r.labels[key] === 'negative')
      .map((r) => ({ ...r, label: r.labels[key] === 'positive' ? 1 : 0 }));
    const censored = rows.filter((r) => r.labels[key] === 'censored').length;
    report[key] = { eligible: labeled.length, censored_excluded: censored, scorers: {} };
    for (const s of scorers) {
      const scored = labeled.map((r) => ({ score: r.scores[s] ?? 0, label: r.label }));
      report[key].scorers[s] = {
        lift: Object.fromEntries(TOP_FRACTIONS.map((f) => [String(f), liftAtK(scored, { fraction: f })])),
        calibration: calibrationBins(scored),
      };
    }
  }
  return report;
}

// Stability / sensitivity (T-15): perturb one input, bound score movement.
export function stabilityProbe(scoreFn, bundle, mutate, { maxDelta }) {
  const before = scoreFn(bundle);
  const after = scoreFn(mutate(structuredClone(bundle)));
  const delta = Math.abs((after.execution_priority ?? after.priority ?? 0) - (before.execution_priority ?? before.priority ?? 0));
  return { delta, within_bound: delta <= maxDelta, maxDelta };
}

const round = (x) => Math.round(x * 1000) / 1000;
