/**
 * Naive baseline for the IC8 comp backtest: median price-per-sqft of valid,
 * same-family sales within 1 mile in the prior 12 months, times the subject's
 * square footage. Same validity rules and as-of bound as the challenger; no
 * micro-markets, no time index, no size elasticity. Interval: the 10th-90th
 * percentile PPSF of the same comps.
 */
import { haversineMiles } from './geo.js';
import { quantile } from './stats.js';
import { sameProperty, subtractMonths } from './comp-records.js';

export const BASELINE_VERSION = 'baseline-median-ppsf-1mi-v1';

export function valueSubjectBaseline({ subject, asOf, candidates, radiusMiles = 1, monthsBack = 12, minComps = 3 }) {
  if (!subject.sqft) return { value: null, reason: 'subject_size_unknown', n: 0 };
  const start = subtractMonths(asOf, monthsBack);
  const ppsf = [];
  for (const c of candidates) {
    if (!(c.known_date < asOf) || c.sale_date < start) continue;
    if (!c.valid || c.dedup_role === 'loser' || c.family !== subject.family || !c.sqft || !c.price) continue;
    if (sameProperty(subject, c) || c.id === subject.id) continue;
    if (haversineMiles(subject.lat, subject.lng, c.lat, c.lng) > radiusMiles) continue;
    ppsf.push(c.price / c.sqft);
  }
  if (ppsf.length < minComps) return { value: null, reason: 'insufficient_comps', n: ppsf.length };
  return {
    value: Math.round(quantile(ppsf, 0.5) * subject.sqft),
    p80: [Math.round(quantile(ppsf, 0.1) * subject.sqft), Math.round(quantile(ppsf, 0.9) * subject.sqft)],
    n: ppsf.length,
  };
}
