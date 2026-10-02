/**
 * IC8.1 price diagnostics. DIAGNOSTIC ONLY: nothing here is an eligibility
 * gate (owner correction 2026-10-02). The only eligibility rule is
 * isEligiblePricedSale() in eligibility.js (canonical deduped price > 0).
 *
 * priceDiagnosticOf(txn) describes the evidence behind an eligible price so
 * models, metrics and reports can segment, weight or study it:
 *   diagnostic_class  'reliable_actual'  HIGH/MEDIUM, verified actual consideration,
 *                                        not an estimate, no market-context flag
 *                     'weak_price'       estimate / unverified / non-disclosure price
 *                     'market_context'   the price is real-or-weak but the sale has
 *                                        context flags (package, distress deed,
 *                                        nominal, non-arm's-length, non-market amount)
 *                     'no_price'         price 0 / NULL (ineligible by the rule)
 *   diagnostic_strict reliable_actual AND HIGH
 *   diagnostic_reasons flags (segments / candidate features)
 *   label_weight      default confidence weight for weighted-training EXPERIMENTS
 *                     (never a filter; every eligible label stays in the set)
 *   eligible          isEligiblePricedSale(txn), repeated for convenience
 */

import { CONFIDENCE, PRICE_SOURCES, isReliablePrice } from "./price-taxonomy.js";
import { isEligiblePricedSale } from "./eligibility.js";

export const PRICE_DIAGNOSTICS_VERSION = "ic8_price_diagnostics@1";
export const LABEL_WEIGHTS = Object.freeze({ HIGH: 1, MEDIUM: 0.75, LOW: 0.25, UNKNOWN: 0.25 });

const DISTRESS_DOC_RE = /(quit\s*claim|trustee|sheriff|foreclos|tax deed|executor|personal representative|affidavit|gift|interfamily|intrafamily|redemption|public action)/i;

export function priceDiagnosticOf(txn) {
  const p = txn.price ?? {};
  const eligible = isEligiblePricedSale(txn);
  if (!eligible) return { eligible, diagnostic_class: "no_price", diagnostic_strict: false, diagnostic_reasons: ["no_positive_price"], label_weight: 0 };
  const context = [];
  if ((p.transaction_price ?? 0) < 10_000) context.push("price_below_10k");
  if (p.source === PRICE_SOURCES.NON_MARKET_AMOUNT) context.push("non_market_amount");
  if ((txn.package_n ?? 0) > 0) context.push("package_deed");
  if (DISTRESS_DOC_RE.test(String(txn.doc_type ?? ""))) context.push("distress_or_transfer_deed");
  if (txn.arms_length === false) context.push("not_arms_length");
  if (txn.nominal_flag === true) context.push("nominal_flag");
  if (txn.usable === false) context.push("missing_geo_or_date");
  const weak = [];
  if (!isReliablePrice(p)) weak.push(`price_${String(p.confidence).toLowerCase()}`);
  if (p.verified !== true) weak.push("price_unverified");
  if (p.is_estimated === true) weak.push("price_estimated");
  if (txn.price_conflict) weak.push("cross_source_price_conflict");
  for (const r of p.reasons ?? []) if (/NONDISCLOSURE|LOAN|EQUALS_LOAN|NOT_ROUND|PLACEHOLDER/.test(r)) weak.push(r.toLowerCase());
  const reasons = [...new Set([...context, ...weak])].sort();
  const cls = context.length ? "market_context" : weak.length ? "weak_price" : "reliable_actual";
  return {
    eligible,
    diagnostic_class: cls,
    diagnostic_strict: cls === "reliable_actual" && p.confidence === CONFIDENCE.HIGH,
    diagnostic_reasons: reasons,
    label_weight: LABEL_WEIGHTS[p.confidence] ?? LABEL_WEIGHTS.UNKNOWN,
  };
}
