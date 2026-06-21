/**
 * Acquisition Engine V3 — deterministic source reliability (mission Item 4 §6).
 *
 * source_reliability = transaction_quality × independence_quality
 *   × asset_match_quality × physical_match_quality × geographic_match_quality
 *   × recency_quality × source_completeness
 *
 * Every factor is bounded to [RELIABILITY_FLOOR, 1] and surfaced in evidence.
 * Effective-sample-depth and dispersion are UNIVERSE-level (applied in
 * universeConfidence), never per-comp — so raw row count and duplicated /
 * package transactions cannot inflate depth or consistency.
 */

import { RELIABILITY_FLOOR, clamp, round } from './modelConstants.js';

function bound(v) {
  return clamp(v, RELIABILITY_FLOOR, 1);
}

/** @returns {{ weight:number, factors:Record<string,number> }} */
export function compReliability(inputs = {}) {
  const factors = {
    transaction_quality: bound((inputs.qualification_score ?? 0) / 100),
    independence_quality: bound((inputs.independence_score ?? 0) / 100),
    asset_match_quality: bound(inputs.asset_match ?? 1),
    physical_match_quality: bound((inputs.physical_match ?? 0) / 100),
    geographic_match_quality: bound((inputs.geographic_match ?? 0) / 100),
    recency_quality: bound((inputs.recency ?? 50) / 100),
    source_completeness: bound((inputs.completeness ?? 50) / 100),
  };
  const weight = Object.values(factors).reduce((p, f) => p * f, 1);
  return { weight: round(weight, 5), factors };
}

/**
 * Universe confidence 0..100 from the accepted comps + depth + dispersion.
 * effective_sample_depth and dispersion_quality enter HERE only.
 */
export function universeConfidence(inputs = {}) {
  const ess = Math.max(0, inputs.effective_sample_size ?? 0);
  const depthScore = clamp((ess / (inputs.target_sample ?? 6)) * 100, 0, 100);
  const dispersion = inputs.dispersion ?? 1;
  const dispersionQuality = clamp(100 - dispersion * 160, 0, 100);
  const avgQual = clamp(inputs.avg_qualification ?? 0, 0, 100);
  const avgPhysical = clamp(inputs.avg_physical ?? 0, 0, 100);
  const avgGeo = clamp(inputs.avg_geographic ?? 0, 0, 100);
  const recency = clamp(inputs.avg_recency ?? 50, 0, 100);

  const components = {
    depth_score: round(depthScore, 1),
    dispersion_quality: round(dispersionQuality, 1),
    avg_qualification: round(avgQual, 1),
    avg_physical_match: round(avgPhysical, 1),
    avg_geographic_match: round(avgGeo, 1),
    avg_recency: round(recency, 1),
  };
  const confidence = clamp(
    depthScore * 0.32 +
      dispersionQuality * 0.2 +
      avgQual * 0.2 +
      avgPhysical * 0.15 +
      avgGeo * 0.08 +
      recency * 0.05,
    0,
    100,
  );
  // A single transaction can never be high-confidence on its own.
  const cap = ess <= 1 ? 40 : ess === 2 ? 60 : 100;
  return { confidence: Math.round(Math.min(confidence, cap)), components, confidence_cap: cap };
}
