/**
 * Acquisition Engine V3 — peer-relative outlier detection (comp-quality hardening).
 *
 * Absolute subject-anchor / PPSF caps are necessary but insufficient: a $1.03M
 * sale among $309–560k peers passes every absolute cap yet is clearly out of
 * line. This module compares each candidate against its PEERS (leave-one-out)
 * using multiple robust metrics so no extreme record validates itself, and is
 * safe for small samples (MAD=0 does not auto-accept). Pure & deterministic.
 */

import { num, round } from './modelConstants.js';
import { median } from './acquisitionMath.js';

export const PEER_STATUS = Object.freeze({
  PEER_CONSISTENT: 'PEER_CONSISTENT',
  PEER_HIGH_OUTLIER: 'PEER_HIGH_OUTLIER',
  PEER_LOW_OUTLIER: 'PEER_LOW_OUTLIER',
  INSUFFICIENT_PEER_DEPTH: 'INSUFFICIENT_PEER_DEPTH',
  METRIC_CONFLICT: 'METRIC_CONFLICT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
});

/** Minimum OTHER peers required to judge a candidate. */
const MIN_PEERS = 3;
const MAD_K = 3.5; // robust MAD multiplier
const IQR_K = 1.5;
const RATIO_HIGH = 2.5; // candidate/peerMedian
const RATIO_LOW = 0.4;
const MIN_REL_DEV = 0.2; // MAD/IQR fences ignored within ±20% of the peer median

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Classify one value vs its peer values (peers exclude the candidate). */
function judgeMetric(value, peers) {
  const xs = peers.filter((p) => Number.isFinite(p) && p > 0);
  if (xs.length < MIN_PEERS) return { vote: 'INSUFFICIENT', detail: { peer_count: xs.length } };
  const sorted = [...xs].sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(sorted.map((v) => Math.abs(v - med)));
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const iqr = p75 - p25;
  const ratio = med > 0 ? value / med : null;
  const logDist = med > 0 && value > 0 ? Math.abs(Math.log(value / med)) : null;

  // Robust high/low: agree if ANY robust rule that is DEFINED fires; MAD/IQR are
  // skipped when zero, falling back to the ratio rule (which always works).
  // The MAD/IQR fences are gated behind a minimum RELATIVE deviation so that a
  // value within MIN_REL_DEV of the peer median is never flagged on a tight
  // cluster (where MAD/IQR fences are razor-thin). This is a tight-cluster
  // false-positive guard, not a market-specific threshold.
  const relDev = med > 0 ? Math.abs(value - med) / med : 0;
  const highVotes = [];
  const lowVotes = [];
  if (mad > 0 && relDev >= MIN_REL_DEV) {
    if (value > med + MAD_K * mad) highVotes.push('mad');
    if (value < med - MAD_K * mad) lowVotes.push('mad');
  }
  if (iqr > 0 && relDev >= MIN_REL_DEV) {
    if (value > p75 + IQR_K * iqr) highVotes.push('iqr');
    if (value < p25 - IQR_K * iqr) lowVotes.push('iqr');
  }
  if (ratio !== null) {
    if (ratio >= RATIO_HIGH) highVotes.push('ratio');
    if (ratio <= RATIO_LOW) lowVotes.push('ratio');
  }
  let vote = 'CONSISTENT';
  if (highVotes.length && !lowVotes.length) vote = 'HIGH';
  else if (lowVotes.length && !highVotes.length) vote = 'LOW';
  return {
    vote,
    detail: {
      peer_count: xs.length,
      peer_median: round(med, 2),
      peer_p25: round(p25, 2),
      peer_p75: round(p75, 2),
      mad: round(mad, 2),
      iqr: round(iqr, 2),
      candidate_to_peer_ratio: ratio === null ? null : round(ratio, 3),
      log_distance: logDist === null ? null : round(logDist, 3),
      high_rules: highVotes,
      low_rules: lowVotes,
    },
  };
}

/**
 * @param {{ key:string, value:number, ppsf?:number, ppu?:number }[]} items
 * @returns Map<key,{ status, metrics, reasons }>
 */
export function classifyPeerOutliers(items = []) {
  const out = new Map();
  const metricsAvail = ['value', 'ppsf', 'ppu'].filter((m) => items.some((i) => Number.isFinite(num(i[m]))));

  for (const item of items) {
    const perMetric = {};
    const votes = [];
    for (const m of metricsAvail) {
      const v = num(item[m]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const peers = items.filter((o) => o.key !== item.key).map((o) => num(o[m]));
      const j = judgeMetric(v, peers);
      perMetric[m] = j;
      if (j.vote !== 'INSUFFICIENT') votes.push(j.vote);
    }
    let status;
    const reasons = [];
    if (!votes.length) {
      status = PEER_STATUS.INSUFFICIENT_PEER_DEPTH;
      reasons.push('insufficient_peer_depth');
    } else {
      const high = votes.filter((v) => v === 'HIGH').length;
      const low = votes.filter((v) => v === 'LOW').length;
      const consistent = votes.filter((v) => v === 'CONSISTENT').length;
      if (high && low) {
        status = PEER_STATUS.METRIC_CONFLICT;
        reasons.push('metric_conflict_high_and_low');
      } else if (high && high >= low && high >= consistent) {
        status = PEER_STATUS.PEER_HIGH_OUTLIER;
        reasons.push(`high_outlier_on:${Object.keys(perMetric).filter((m) => perMetric[m].vote === 'HIGH').join(',')}`);
      } else if (low && low >= consistent) {
        status = PEER_STATUS.PEER_LOW_OUTLIER;
        reasons.push(`low_outlier_on:${Object.keys(perMetric).filter((m) => perMetric[m].vote === 'LOW').join(',')}`);
      } else if (high || low) {
        // a single metric flags but others say consistent -> conflict/review
        status = PEER_STATUS.METRIC_CONFLICT;
        reasons.push('single_metric_flag_amid_consistent');
      } else {
        status = PEER_STATUS.PEER_CONSISTENT;
      }
    }
    out.set(item.key, { status, metrics: perMetric, reasons });
  }
  return out;
}

/** True if a peer status should be excluded from ordinary pricing. */
export function peerStatusExcludesPricing(status) {
  return status === PEER_STATUS.PEER_HIGH_OUTLIER || status === PEER_STATUS.PEER_LOW_OUTLIER;
}
/** True if a peer status should be review-only (kept visible, not priced). */
export function peerStatusReviewOnly(status) {
  return status === PEER_STATUS.METRIC_CONFLICT;
}
