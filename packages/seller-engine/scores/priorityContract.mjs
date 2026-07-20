// Execution-priority OUTPUT CONTRACT (display/prioritization layer).
//
// The engine's raw mathematical output (families.execution_priority.score) is
// NEVER modified here — it is exposed verbatim as execution_priority_raw. This
// module adds two DERIVED representations on top of it:
//   - execution_priority_score_0_100: a fixed, cohort-independent, strictly
//     monotonic squash of the raw score into [0,100). Order-preserving and
//     reproducible; two raw values can never reverse after transformation.
//   - execution_priority_percentile: a cohort-relative rank in [0,1], with an
//     explicit fallback ladder and a null result when data is insufficient.
//
// DISPLAY_SCALE_K is a presentation constant, NOT a scoring weight: it cannot
// change ordering (the transform is strictly increasing for any K>0) and does
// not touch families.mjs / the locked config. Routing consumes the RAW score
// (declared in SELLER_EXECUTION_PRIORITY_CONTRACT.md); explanations reference
// the raw family contributors, never this display layer.
export const PRIORITY_CONTRACT_VERSION = 'priority-contract-v1';
export const DISPLAY_SCALE_K = 40;   // display scale only; order-invariant
export const COHORT_MIN_N = 30;      // minimum cohort size for a percentile

// strictly monotonic, bounded [0,100), reproducible, cohort-independent
export function priorityScore0100(raw) {
  const r = Math.max(0, Number(raw) || 0);
  return Math.round((100 * r / (r + DISPLAY_SCALE_K)) * 100) / 100;
}

// fraction of the cohort at or below `raw` (>= COHORT_MIN_N required)
export function cohortPercentile(raw, cohortValues) {
  if (!Array.isArray(cohortValues) || cohortValues.length < COHORT_MIN_N) return null;
  const n = cohortValues.length;
  let below = 0;
  for (const v of cohortValues) if (v <= raw) below += 1;
  return Math.round((below / n) * 10000) / 10000;
}

// Build the cohort ladder for one subject from precomputed cohort buckets.
// buckets: { assetState: Map<key,number[]>, asset: Map<key,number[]>, all: number[] }
export function cohortLadder(subject, buckets) {
  const asset = subject.asset_class ?? 'unknown';
  const state = subject.situs_state ?? subject.state ?? 'unknown';
  return [
    { basis: 'asset_class_x_state', key: `${asset}|${state}`, values: buckets.assetState?.get(`${asset}|${state}`) },
    { basis: 'asset_class', key: asset, values: buckets.asset?.get(asset) },
    { basis: 'whole_batch', key: 'all', values: buckets.all },
  ];
}

// Apply the full contract to a raw score given a subject + precomputed buckets.
export function formalizePriority(raw, subject, buckets) {
  const raw_ = Number(raw) || 0;
  const score = priorityScore0100(raw_);
  let percentile = null; let percentile_basis = 'insufficient_data';
  let cohort_key = null; let cohort_n = 0;
  if (buckets) {
    for (const rung of cohortLadder(subject, buckets)) {
      if (Array.isArray(rung.values) && rung.values.length >= COHORT_MIN_N) {
        percentile = cohortPercentile(raw_, rung.values);
        percentile_basis = rung.basis; cohort_key = rung.key; cohort_n = rung.values.length;
        break;
      }
    }
  }
  return {
    execution_priority_raw: raw_,
    execution_priority_score_0_100: score,
    execution_priority_percentile: percentile,
    percentile_basis, cohort_key, cohort_n,
    contract_version: PRIORITY_CONTRACT_VERSION,
    routing_consumes: 'execution_priority_raw',
  };
}

// Build cohort buckets from an array of { asset_class, situs_state|state, raw }.
export function buildCohortBuckets(rows) {
  const assetState = new Map(); const asset = new Map(); const all = [];
  for (const r of rows) {
    const a = r.asset_class ?? 'unknown';
    const s = r.situs_state ?? r.state ?? 'unknown';
    const raw = Number(r.raw) || 0;
    (assetState.get(`${a}|${s}`) ?? assetState.set(`${a}|${s}`, []).get(`${a}|${s}`)).push(raw);
    (asset.get(a) ?? asset.set(a, []).get(a)).push(raw);
    all.push(raw);
  }
  return { assetState, asset, all };
}
