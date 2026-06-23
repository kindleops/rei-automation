/**
 * Acquisition Engine V3 — hard invariants (mission §23).
 *
 * Pure assertions over a (partial) decision object. Returns a structured
 * { ok, violations } result; can optionally throw. Any violation must prevent
 * autonomous execution upstream. Missing fields are skipped (not invented).
 */

import {
  VALUATION_ANCHOR_HARD_MULTIPLE,
  MAX_SINGLE_COMP_VALUATION_SHARE,
  num,
} from './modelConstants.js';

function isCleanNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(v);
}

/** True if value is present (not null/undefined). */
function present(v) {
  return v !== null && v !== undefined;
}

/**
 * @param {object} d decision-like object (any subset of the fields below)
 * @param {{ throwOnViolation?: boolean }} [opts]
 * @returns {{ ok: boolean, violations: {code:string, detail?:any}[], checked:number }}
 */
export function assertAcquisitionInvariants(d = {}, opts = {}) {
  const violations = [];
  let checked = 0;
  const fail = (code, detail) => violations.push(detail === undefined ? { code } : { code, detail });

  const fields = [
    'valuation_low', 'valuation_mid', 'valuation_high',
    'recommended_cash_offer', 'maximum_cash_offer', 'conservative_buyer_exit',
    'estimated_repairs', 'anchor_value', 'single_comp_max_share',
  ];

  // 1) finiteness + no NaN/Infinity + non-negative money
  for (const f of fields) {
    if (!present(d[f])) continue;
    checked += 1;
    if (!isCleanNumber(d[f])) {
      fail('non_finite_value', { field: f, value: String(d[f]) });
    } else if (
      d[f] < 0 &&
      ['valuation_low', 'valuation_mid', 'valuation_high', 'recommended_cash_offer', 'maximum_cash_offer', 'conservative_buyer_exit', 'estimated_repairs'].includes(f)
    ) {
      fail('negative_value', { field: f, value: d[f] });
    }
  }

  // 2) valuation ordering
  if (isCleanNumber(d.valuation_low) && isCleanNumber(d.valuation_mid)) {
    checked += 1;
    if (d.valuation_low > d.valuation_mid) fail('valuation_low_gt_mid', { low: d.valuation_low, mid: d.valuation_mid });
  }
  if (isCleanNumber(d.valuation_mid) && isCleanNumber(d.valuation_high)) {
    checked += 1;
    if (d.valuation_mid > d.valuation_high) fail('valuation_mid_gt_high', { mid: d.valuation_mid, high: d.valuation_high });
  }

  // 3) offer bounds
  if (isCleanNumber(d.recommended_cash_offer) && isCleanNumber(d.maximum_cash_offer)) {
    checked += 1;
    if (d.recommended_cash_offer > d.maximum_cash_offer) {
      fail('recommended_gt_maximum', { recommended: d.recommended_cash_offer, maximum: d.maximum_cash_offer });
    }
  }
  if (isCleanNumber(d.maximum_cash_offer) && isCleanNumber(d.conservative_buyer_exit)) {
    checked += 1;
    if (d.maximum_cash_offer > d.conservative_buyer_exit) {
      fail('maximum_gt_conservative_buyer_exit', { maximum: d.maximum_cash_offer, exit: d.conservative_buyer_exit });
    }
  }
  if (isCleanNumber(d.recommended_cash_offer) && isCleanNumber(d.valuation_high)) {
    checked += 1;
    if (d.recommended_cash_offer > d.valuation_high) {
      fail('recommended_gt_valuation_high', { recommended: d.recommended_cash_offer, high: d.valuation_high });
    }
  }

  // 4) anchor sanity: value / offer cannot exceed 10× a defensible anchor
  const anchor = num(d.anchor_value);
  if (anchor !== null && anchor > 0) {
    if (isCleanNumber(d.valuation_mid)) {
      checked += 1;
      if (d.valuation_mid > anchor * VALUATION_ANCHOR_HARD_MULTIPLE) {
        fail('valuation_exceeds_anchor_hard_multiple', {
          valuation_mid: d.valuation_mid, anchor, multiple: VALUATION_ANCHOR_HARD_MULTIPLE,
        });
      }
    }
    if (isCleanNumber(d.recommended_cash_offer)) {
      checked += 1;
      if (d.recommended_cash_offer > anchor * VALUATION_ANCHOR_HARD_MULTIPLE) {
        fail('offer_exceeds_anchor_hard_multiple', {
          recommended_cash_offer: d.recommended_cash_offer, anchor, multiple: VALUATION_ANCHOR_HARD_MULTIPLE,
        });
      }
    }
  }

  // 5) no single comp may control more than the configured share of valuation
  if (isCleanNumber(d.single_comp_max_share)) {
    checked += 1;
    if (d.single_comp_max_share > MAX_SINGLE_COMP_VALUATION_SHARE) {
      fail('single_comp_share_exceeded', {
        share: d.single_comp_max_share, max: MAX_SINGLE_COMP_VALUATION_SHARE,
      });
    }
  }

  const ok = violations.length === 0;
  if (!ok && opts.throwOnViolation) {
    const err = new Error(`acquisition_invariant_violation: ${violations.map((v) => v.code).join(', ')}`);
    err.violations = violations;
    throw err;
  }
  return { ok, violations, checked };
}
