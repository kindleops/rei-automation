/**
 * Acquisition Engine V3 — Item 5C: cap-rate evidence rules (mission §6).
 *
 * Cleanly separates three cap-rate kinds and never lets a modeled NOI masquerade
 * as observed market evidence:
 *   - OBSERVED_CAP_RATE      : qualified single-asset sale with supportable,
 *                              time-aligned, same-property NOI (real evidence)
 *   - IMPLIED_CAP_RATE       : NOI / our own valuation (derived, not market)
 *   - MODELED_MARKET_CAP_RATE: market prior assumption (labeled)
 *
 * Pure & deterministic.
 */

import { EVIDENCE_BASIS } from './incomeSnapshotContract.js';
import { DEFAULT_CAP_RATE, ASSET_FAMILIES, num, lower, round } from './modelConstants.js';

export const CAP_RATE_KIND = Object.freeze({
  OBSERVED: 'OBSERVED_CAP_RATE',
  IMPLIED: 'IMPLIED_CAP_RATE',
  MODELED_MARKET: 'MODELED_MARKET_CAP_RATE',
});

/** Plausible cap-rate band (anything outside is rejected as evidence). */
const CAP_MIN = 0.02;
const CAP_MAX = 0.2;

/**
 * Qualify a single transaction's contribution to OBSERVED cap-rate evidence.
 * A txn qualifies only when ALL hold (mission §6):
 *   - individual-asset (non-package) qualified consideration
 *   - supportable NOI whose basis is itself observed/verified (NOT modeled)
 *   - income & sale refer to the SAME property and time-aligned period
 *   - asset lane / size band compatible with the subject
 *   - complete source lineage
 *
 * @returns {{ qualified:boolean, cap_rate:number|null, reasons:string[] }}
 */
export function qualifyObservedCapRate(txn = {}, { subjectBand = null } = {}) {
  const reasons = [];
  const consideration = num(txn.consideration ?? txn.sale_price);
  const noi = num(txn.noi);
  const noiBasis = txn.noi_basis;
  const monthsBetween = num(txn.income_sale_month_gap);

  if (txn.is_package === true) reasons.push('package_consideration');
  if (consideration === null || consideration <= 0) reasons.push('no_individual_asset_consideration');
  if (txn.consideration_qualified === false) reasons.push('consideration_not_qualified');
  if (noi === null || noi <= 0) reasons.push('no_supportable_noi');
  // NOI must be real evidence, never a modeled figure presented as observed.
  if (noiBasis && ![EVIDENCE_BASIS.ACTUAL, EVIDENCE_BASIS.VERIFIED_DOCUMENT, EVIDENCE_BASIS.OWNER_REPORTED].includes(noiBasis)) {
    reasons.push('noi_not_observed_basis');
  }
  if (!noiBasis) reasons.push('noi_basis_unknown');
  if (monthsBetween !== null && Math.abs(monthsBetween) > 12) reasons.push('income_sale_not_time_aligned');
  if (txn.same_property === false) reasons.push('income_sale_property_mismatch');
  if (subjectBand && txn.size_band && txn.size_band !== subjectBand) reasons.push('size_band_incompatible');
  if (!clean(txn.source_record_id)) reasons.push('incomplete_lineage');

  const qualified = reasons.length === 0;
  const capRate = qualified && consideration > 0 ? round(noi / consideration, 4) : null;
  if (qualified && (capRate < CAP_MIN || capRate > CAP_MAX)) {
    return { qualified: false, cap_rate: null, reasons: ['cap_rate_out_of_band'] };
  }
  return { qualified, cap_rate: capRate, reasons };
}

function clean(v) { return String(v ?? '').trim(); }

/**
 * Build the three cap-rate views from a set of candidate transactions + an
 * optional implied (NOI/our-value) input + a family default market prior.
 */
export function buildCapRateEvidence({ transactions = [], impliedNoi = null, impliedValue = null, family = ASSET_FAMILIES.MULTIFAMILY, subjectBand = null } = {}) {
  const observedRates = [];
  const rejected = [];
  for (const t of transactions) {
    const q = qualifyObservedCapRate(t, { subjectBand });
    if (q.qualified) observedRates.push({ cap_rate: q.cap_rate, source_record_id: t.source_record_id, size_band: t.size_band ?? null });
    else rejected.push({ source_record_id: t.source_record_id ?? null, reasons: q.reasons });
  }
  observedRates.sort((a, b) => a.cap_rate - b.cap_rate);
  const observedMid = observedRates.length ? observedRates[Math.floor((observedRates.length - 1) / 2)].cap_rate : null;

  const impliedCap = num(impliedNoi) !== null && num(impliedValue) > 0 ? round(num(impliedNoi) / num(impliedValue), 4) : null;
  const modeledMarket = DEFAULT_CAP_RATE[family] ?? DEFAULT_CAP_RATE.UNKNOWN;

  return {
    observed: {
      kind: CAP_RATE_KIND.OBSERVED,
      cap_rate: observedMid,
      basis: observedMid !== null ? EVIDENCE_BASIS.COMPARABLE_DERIVED : EVIDENCE_BASIS.UNKNOWN,
      evidence_count: observedRates.length,
      qualified: observedRates.length >= 3,
      confidence: observedRates.length >= 3 ? 70 : observedRates.length >= 1 ? 45 : 0,
      rejected_count: rejected.length,
      rejected,
    },
    implied: {
      kind: CAP_RATE_KIND.IMPLIED,
      cap_rate: impliedCap,
      basis: impliedCap !== null ? EVIDENCE_BASIS.SYSTEM_INFERRED : EVIDENCE_BASIS.UNKNOWN,
      confidence: impliedCap !== null ? 30 : 0,
      note: 'NOI / engine value — derived, NOT market-observed.',
    },
    modeled_market: {
      kind: CAP_RATE_KIND.MODELED_MARKET,
      cap_rate: modeledMarket,
      basis: EVIDENCE_BASIS.MARKET_MODELED,
      confidence: 30,
      note: `family default for ${family}`,
    },
  };
}
