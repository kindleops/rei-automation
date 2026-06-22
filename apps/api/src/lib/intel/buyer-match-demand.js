/**
 * Canonical buyer-demand and liquidity outputs for Acquisition Decision Engine.
 * Distinguishes source failure from genuine zero-market results.
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function buildCanonicalBuyerDemand({
  candidates = [],
  rollup = null,
  demand_score = null,
  liquidity_score = null,
  confidence = 0,
  fallback_level = 'none',
  source_failure = false,
  coordinates_unavailable = false,
  subject_incomplete = false,
  generated_at = null,
}) {
  const gradeCounts = { a_plus: 0, a: 0, b: 0, corporate: 0, repeat: 0, institutional: 0 };
  for (const c of candidates) {
    const grade = String(c.match_grade ?? '').toUpperCase();
    if (grade === 'A+') gradeCounts.a_plus += 1;
    else if (grade === 'A') gradeCounts.a += 1;
    else if (grade === 'B') gradeCounts.b += 1;
    if (c.is_corporate_buyer || c.buyer_type === 'corporate') gradeCounts.corporate += 1;
    if (c.is_repeat_buyer) gradeCounts.repeat += 1;
    if (c.buyer_type === 'institutional' || (num(c.institutional_score) ?? 0) >= 70) {
      gradeCounts.institutional += 1;
    }
  }

  const buyer_count = candidates.length;
  const qualified_buyer_count = candidates.filter(
    (c) => c.match_grade === 'A+' || c.match_grade === 'A' || c.match_grade === 'B',
  ).length;

  const prices = candidates
    .map((c) => num(c.avg_purchase_price) ?? num(c.median_purchase_price))
    .filter((p) => p !== null && p > 0);
  const likely_buyer_price_range =
    prices.length >= 2
      ? { low: Math.round(Math.min(...prices) * 0.92), high: Math.round(Math.max(...prices) * 1.05) }
      : prices.length === 1
        ? { low: Math.round(prices[0] * 0.9), high: Math.round(prices[0] * 1.08) }
        : rollup?.median_purchase_price
          ? {
              low: Math.round(num(rollup.median_purchase_price) * 0.85),
              high: Math.round(num(rollup.median_purchase_price) * 1.1),
            }
          : null;

  const investor_exit_range = likely_buyer_price_range
    ? {
        low: likely_buyer_price_range.low,
        high: likely_buyer_price_range.high,
      }
    : null;

  let data_state = 'ready';
  if (source_failure) data_state = 'source_unavailable';
  else if (coordinates_unavailable) data_state = 'coordinates_unavailable';
  else if (subject_incomplete) data_state = 'subject_incomplete';
  else if (fallback_level === 'none' && buyer_count === 0 && !rollup) data_state = 'no_data';
  else if (buyer_count === 0 && rollup) data_state = 'buyers_exist_no_match';
  else if (fallback_level === 'market' || fallback_level === 'state') data_state = 'market_only_fallback';
  else if (buyer_count === 0) data_state = 'no_buyers_in_market';

  const market_purchase_velocity = num(rollup?.purchase_velocity_90d) ?? num(rollup?.purchase_count_90d) ?? null;
  const estimated_disposition_timeline =
    liquidity_score !== null && liquidity_score >= 70
      ? { days_low: 14, days_high: 30 }
      : liquidity_score !== null && liquidity_score >= 40
        ? { days_low: 30, days_high: 60 }
        : buyer_count > 0
          ? { days_low: 45, days_high: 90 }
          : null;

  return {
    buyer_count,
    qualified_buyer_count,
    a_plus_count: gradeCounts.a_plus,
    a_count: gradeCounts.a,
    b_count: gradeCounts.b,
    repeat_buyer_count: gradeCounts.repeat,
    corporate_count: gradeCounts.corporate,
    institutional_count: gradeCounts.institutional,
    active_within_30d_count: candidates.filter((c) => {
      if (!c.last_purchase_date) return false;
      const days = (Date.now() - new Date(c.last_purchase_date).getTime()) / 86_400_000;
      return days <= 30;
    }).length,
    market_purchase_velocity,
    estimated_disposition_timeline,
    liquidity_score,
    demand_score,
    likely_buyer_price_range,
    investor_exit_range,
    buyer_confidence: confidence,
    data_freshness: generated_at ?? new Date().toISOString(),
    fallback_level,
    data_state,
    source_failure,
    coordinates_unavailable,
    subject_incomplete,
    rollup_purchase_count: num(rollup?.purchase_count) ?? 0,
    rollup_buyer_count: num(rollup?.buyer_count) ?? 0,
    model_version: 'buyer_match_v2.1',
  };
}