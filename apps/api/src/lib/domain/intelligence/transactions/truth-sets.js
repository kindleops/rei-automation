/**
 * IC8.1 valuation truth sets. Pure.
 *
 * Two label sets, never mixed without a flag:
 *   primary    reliable actual-price evidence: HIGH/MEDIUM confidence, a verified
 *              actual consideration, not an estimate, and a market sale (no
 *              package, distress/transfer deed, nominal price, non-arm's-length
 *              or cross-source price conflict). `primary_strict` = HIGH only.
 *              Used for MAE / MdAPE, calibration and promotion decisions.
 *   secondary  weak labels: a market-looking sale whose PRICE is weak (vendor or
 *              loan-derived estimate, uncoded price in a non-disclosure state,
 *              stated amount that equals the loan, ...). Supplementary learning,
 *              coverage and sensitivity analysis only.
 *   excluded   not a valuation label at all (no price, non-market amount,
 *              package, distress deed, nominal). The transaction itself is
 *              still kept for activity / turnover features.
 */

import { CONFIDENCE, PRICE_SOURCES, isReliablePrice } from "./price-taxonomy.js";

export const TRUTH_SETS_VERSION = "ic8_truth_sets@1";
export const MIN_LABEL_PRICE = 10_000;

/**
 * Default label weights for confidence-weighted training (brief: HIGH full,
 * LOW reduced, UNKNOWN excluded). A starting point to be TESTED against the
 * high-confidence-only variant, not a tuned value.
 */
export const LABEL_WEIGHTS = Object.freeze({ HIGH: 1, MEDIUM: 0.75, LOW: 0.25, UNKNOWN: 0 });

const DISTRESS_DOC_RE = /(quit\s*claim|trustee|sheriff|foreclos|tax deed|executor|personal representative|affidavit|gift|interfamily|intrafamily|redemption|public action)/i;

/**
 * @param txn  {price (normalizeTransactionPrice output), price_conflict, package_n,
 *              doc_type, arms_length, nominal_flag, usable (geo+date present)}
 */
export function truthSetOf(txn) {
  const p = txn.price ?? {};
  const reasons = [];
  const price = p.transaction_price;
  if (price === null || price === undefined) reasons.push("no_price");
  else if (price < MIN_LABEL_PRICE) reasons.push("price_below_10k");
  if (p.source === PRICE_SOURCES.NON_MARKET_AMOUNT) reasons.push("non_market_amount");
  if ((txn.package_n ?? 0) > 0) reasons.push("package_deed");
  if (DISTRESS_DOC_RE.test(String(txn.doc_type ?? ""))) reasons.push("distress_or_transfer_deed");
  if (txn.arms_length === false) reasons.push("not_arms_length");
  if (txn.nominal_flag === true && isReliablePrice(p)) reasons.push("nominal_price");
  if (txn.usable === false) reasons.push("missing_geo_or_date");
  if (reasons.length) return { truth_set: "excluded", primary_strict: false, label_weight: 0, reasons };

  const weak = [];
  if (!isReliablePrice(p)) weak.push(`price_${String(p.confidence).toLowerCase()}`);
  if (p.verified !== true) weak.push("price_unverified");
  if (p.is_estimated === true) weak.push("price_estimated");
  if (txn.price_conflict) weak.push("cross_source_price_conflict");
  for (const r of p.reasons ?? []) if (/NONDISCLOSURE|LOAN|EQUALS_LOAN|NOT_ROUND/.test(r)) weak.push(r.toLowerCase());
  if (weak.length) {
    return { truth_set: "secondary", primary_strict: false, label_weight: LABEL_WEIGHTS[p.confidence] ?? 0, reasons: [...new Set(weak)].sort() };
  }
  return { truth_set: "primary", primary_strict: p.confidence === CONFIDENCE.HIGH, label_weight: LABEL_WEIGHTS[p.confidence] ?? 0, reasons: [] };
}
