/**
 * Acquisition Engine V3 — Item 5C: deterministic field-level source priority,
 * conflict detection (mission §8) and staleness (mission §9).
 *
 * Given several candidate values for one canonical field, select the value by
 * basis priority (NOT recency) while surfacing rejected alternatives, conflict
 * severity, and staleness. A material conflict in a decision-critical field must
 * be allowed to block underwritten status downstream — this module reports it;
 * it never silently averages.
 *
 * Pure & deterministic — `now` is always passed in.
 */

import {
  EVIDENCE_BASIS,
  CONFLICT_STATUS,
  VALIDATION_STATUS,
  BASIS_CONFIDENCE,
  basisRank,
  provField,
} from './incomeSnapshotContract.js';
import { num } from './modelConstants.js';

/**
 * Per-data-type freshness windows (days). Distinct by type — never one global
 * threshold (mission §9). Beyond `stale_days` a confidence penalty applies;
 * beyond `expired_days` the value is flagged STALE and requires refresh.
 */
export const FRESHNESS_WINDOWS = Object.freeze({
  rent_roll: { fresh_days: 90, stale_days: 180, expired_days: 365 },
  occupancy: { fresh_days: 45, stale_days: 120, expired_days: 270 },
  market_rent: { fresh_days: 120, stale_days: 270, expired_days: 540 },
  expenses: { fresh_days: 365, stale_days: 540, expired_days: 730 },
  taxes: { fresh_days: 400, stale_days: 730, expired_days: 1095 },
  insurance: { fresh_days: 365, stale_days: 540, expired_days: 730 },
  debt_balance: { fresh_days: 120, stale_days: 270, expired_days: 540 },
  loan_payment: { fresh_days: 120, stale_days: 270, expired_days: 540 },
  cap_rate_evidence: { fresh_days: 270, stale_days: 540, expired_days: 1095 },
  default: { fresh_days: 180, stale_days: 365, expired_days: 730 },
});

export const FRESHNESS_STATUS = Object.freeze({
  FRESH: 'FRESH',
  AGING: 'AGING',
  STALE: 'STALE',
  EXPIRED: 'EXPIRED',
  UNKNOWN_AGE: 'UNKNOWN_AGE',
});

function daysBetween(observedAt, now) {
  if (!observedAt) return null;
  const t = new Date(observedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 86_400_000));
}

/** Freshness assessment for a single field value. */
export function assessFreshness(observedAt, dataType, now = new Date()) {
  const w = FRESHNESS_WINDOWS[dataType] ?? FRESHNESS_WINDOWS.default;
  const age = daysBetween(observedAt, now);
  if (age === null) {
    return { age_days: null, status: FRESHNESS_STATUS.UNKNOWN_AGE, confidence_penalty: 15, refresh_required: false, data_type: dataType };
  }
  let status; let penalty; let refresh = false;
  if (age <= w.fresh_days) { status = FRESHNESS_STATUS.FRESH; penalty = 0; }
  else if (age <= w.stale_days) { status = FRESHNESS_STATUS.AGING; penalty = 8; }
  else if (age <= w.expired_days) { status = FRESHNESS_STATUS.STALE; penalty = 20; refresh = true; }
  else { status = FRESHNESS_STATUS.EXPIRED; penalty = 40; refresh = true; }
  return { age_days: age, status, confidence_penalty: penalty, refresh_required: refresh, data_type: dataType };
}

/** Relative spread between the two most-reliable disagreeing numeric candidates. */
function relativeVariance(a, b) {
  const x = num(a); const y = num(b);
  if (x === null || y === null) return null;
  const denom = Math.max(Math.abs(x), Math.abs(y), 1);
  return Math.abs(x - y) / denom;
}

/**
 * Select a canonical field value from candidates by deterministic basis
 * priority. Candidates: { value, basis, observed_at, source, source_record_id,
 * confidence?, data_type?, extraction_method?, validation_status? }.
 *
 * @returns provField-shaped object augmented with selection lineage:
 *   { ...provField, rejected, reason, conflict, variance, staleness, candidates_considered }
 */
export function selectField(candidates = [], { dataType = 'default', now = new Date(), materialVariance = 0.1 } = {}) {
  const present = (candidates ?? []).filter((c) => c && c.value !== null && c.value !== undefined && c.value !== '');
  if (!present.length) {
    return { ...provField(null), rejected: [], reason: 'no_candidate_values', conflict: CONFLICT_STATUS.NONE, variance: null, staleness: null, candidates_considered: 0 };
  }

  // Stable sort: basis priority first, then most recent observed_at, then confidence.
  const ranked = [...present].sort((a, b) => {
    const r = basisRank(a.basis) - basisRank(b.basis);
    if (r !== 0) return r;
    const ta = a.observed_at ? new Date(a.observed_at).getTime() : 0;
    const tb = b.observed_at ? new Date(b.observed_at).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return (b.confidence ?? BASIS_CONFIDENCE[b.basis] ?? 0) - (a.confidence ?? BASIS_CONFIDENCE[a.basis] ?? 0);
  });

  const winner = ranked[0];
  const rejected = ranked.slice(1).map((c) => ({
    value: c.value, basis: c.basis, source: c.source, source_record_id: c.source_record_id ?? null, observed_at: c.observed_at ?? null,
  }));

  // Conflict: compare the winner against the next candidate of EQUAL OR ADJACENT
  // reliability that disagrees materially (numeric fields only).
  let conflict = CONFLICT_STATUS.NONE;
  let variance = null;
  const numericWinner = num(winner.value);
  if (numericWinner !== null && ranked.length > 1) {
    let worst = 0;
    for (const c of ranked.slice(1)) {
      const v = relativeVariance(winner.value, c.value);
      if (v === null) continue;
      // Only competing reliability tiers can create a meaningful conflict; a far
      // weaker source disagreeing with a verified value is expected, not a conflict.
      const tierGap = basisRank(c.basis) - basisRank(winner.basis);
      if (tierGap <= 1 && v > worst) worst = v;
    }
    variance = Number.isFinite(worst) ? Math.round(worst * 1000) / 1000 : null;
    if (worst >= materialVariance * 2) conflict = CONFLICT_STATUS.MATERIAL;
    else if (worst >= materialVariance) conflict = CONFLICT_STATUS.MINOR;
  }

  const staleness = assessFreshness(winner.observed_at, winner.data_type ?? dataType, now);
  const baseConf = winner.confidence ?? BASIS_CONFIDENCE[winner.basis] ?? 0;
  const adjustedConf = Math.max(0, baseConf - staleness.confidence_penalty - (conflict === CONFLICT_STATUS.MATERIAL ? 20 : conflict === CONFLICT_STATUS.MINOR ? 8 : 0));

  const selected = provField(winner.value, {
    source: winner.source ?? null,
    source_record_id: winner.source_record_id ?? null,
    observed_at: winner.observed_at ?? null,
    effective_date: winner.effective_date ?? null,
    confidence: Math.round(adjustedConf),
    basis: winner.basis,
    extraction_method: winner.extraction_method ?? null,
    validation_status: staleness.status === FRESHNESS_STATUS.STALE || staleness.status === FRESHNESS_STATUS.EXPIRED
      ? VALIDATION_STATUS.STALE
      : (winner.validation_status ?? VALIDATION_STATUS.UNVALIDATED),
    conflict_status: conflict,
  });

  return {
    ...selected,
    rejected,
    reason: rejected.length
      ? `selected_${winner.basis}_over_${ranked[1].basis}_by_${basisRank(ranked[1].basis) > basisRank(winner.basis) ? 'basis_priority' : 'recency'}`
      : `single_source_${winner.basis}`,
    conflict,
    variance,
    staleness,
    candidates_considered: present.length,
  };
}
