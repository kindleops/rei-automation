// ─── comp-anchor-policy.js ───────────────────────────────────────────────────
// Deterministic disclosure-grade comp-anchor eligibility (spec §10).
//
// The ADE already filters and scores comps for VALUATION. Disclosing a comp to
// a seller is a higher bar: the anchor must be recent, close, similar, from a
// quality transaction, and confident enough that quoting it cannot mislead.
// The lowest sale is never exposed merely because it is numerically low, and
// no statement ever claims "similar condition" without condition-confidence
// evidence.
//
// The exact authorized statement is produced HERE and persisted — templates
// may only render this statement verbatim ({{comp_anchor_statement}}); the
// model/renderer never composes its own comp claim.
//
// Pure module — no I/O, no AI.

import { ASSET_CLASSES, normalizeAssetClass } from "@/lib/domain/seller-flow/negotiation-policy.js";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function monthsBetween(dateIso, now = Date.now()) {
  const t = Date.parse(dateIso || "");
  if (!Number.isFinite(t)) return null;
  return (now - t) / (1000 * 60 * 60 * 24 * 30.44);
}

/** Disclosure thresholds by asset class — deliberately stricter than valuation. */
const DISCLOSURE_RULES = Object.freeze({
  [ASSET_CLASSES.SFR]: { max_distance_miles: 1.0, max_age_months: 9, min_confidence: 0.6, size_ratio: [0.7, 1.4] },
  [ASSET_CLASSES.SMALL_MULTIFAMILY]: { max_distance_miles: 2.0, max_age_months: 12, min_confidence: 0.6, size_ratio: [0.6, 1.6] },
  [ASSET_CLASSES.LARGE_MULTIFAMILY]: { max_distance_miles: 5.0, max_age_months: 15, min_confidence: 0.55, size_ratio: [0.5, 2.0] },
  [ASSET_CLASSES.LAND]: { max_distance_miles: 5.0, max_age_months: 18, min_confidence: 0.5, size_ratio: [0.4, 2.5] },
  [ASSET_CLASSES.COMMERCIAL]: { max_distance_miles: 5.0, max_age_months: 18, min_confidence: 0.65, size_ratio: [0.5, 2.0] },
  [ASSET_CLASSES.MOBILE_HOME]: { max_distance_miles: 2.0, max_age_months: 12, min_confidence: 0.6, size_ratio: [0.6, 1.6] },
});

const PACKAGE_SOURCE_HINTS = ["package", "portfolio", "bulk", "multi_parcel", "multi-parcel"];
const INSTITUTIONAL_HINTS = ["institutional", "ibuyer", "reo_bulk"];

/**
 * Screen one comp for seller-disclosure eligibility.
 * Returns { eligible, reasons[] } — reasons list every failed gate.
 */
export function screenCompForDisclosure(comp = {}, {
  asset_class = null,
  subject_sqft = null,
  valuation_mid = null,
  now = Date.now(),
} = {}) {
  const rules = DISCLOSURE_RULES[normalizeAssetClass(asset_class)] || DISCLOSURE_RULES[ASSET_CLASSES.SFR];
  const reasons = [];

  const salePrice = num(comp.sale_price);
  if (salePrice === null || salePrice < 10_000) reasons.push("invalid_sale_price");

  const age = monthsBetween(comp.sale_date || comp.sold_date, now);
  if (age === null) reasons.push("unknown_sale_date");
  else if (age > rules.max_age_months) reasons.push("sale_too_old");

  const distance = num(comp.distance_miles);
  if (distance === null) reasons.push("unknown_distance");
  else if (distance > rules.max_distance_miles) reasons.push("too_far");

  const confidence = num(comp.comp_confidence) ?? num(comp.confidence);
  if (confidence === null || confidence < rules.min_confidence) reasons.push("insufficient_comp_confidence");

  const compScore = num(comp.comp_score) ?? num(comp.score);
  if (compScore !== null && compScore < 50) reasons.push("low_similarity_score");

  const subjectSqft = num(subject_sqft);
  const compSqft = num(comp.sqft);
  if (subjectSqft && compSqft) {
    const ratio = compSqft / subjectSqft;
    if (ratio < rules.size_ratio[0] || ratio > rules.size_ratio[1]) reasons.push("size_dissimilar");
  }

  const source = clean(comp.source || comp.sale_source).toLowerCase();
  if (PACKAGE_SOURCE_HINTS.some((h) => source.includes(h))) reasons.push("package_or_portfolio_sale");
  if (INSTITUTIONAL_HINTS.some((h) => source.includes(h))) reasons.push("institutional_anomaly");

  // An anchor far below the valuation midpoint is an outlier, not evidence —
  // never expose an obviously irrelevant lowest sale (spec §10).
  const valuation = num(valuation_mid);
  if (salePrice !== null && valuation !== null && valuation > 0 && salePrice < valuation * 0.55) {
    reasons.push("outlier_below_valuation_band");
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Select the single credible comp anchor for disclosure, if any.
 *
 * @param {object} params
 * @param {Array}  params.comps - ADE evidence selected_comps
 * @param {object} params.subject - { asset_class|asset_type, sqft }
 * @param {number} params.valuation_mid - ADE valuation midpoint
 * @param {Array}  params.previously_disclosed - comp_anchors_used from state
 * @returns {{ eligible: boolean, anchor: object|null, authorized_statement: string|null, rejected: Array }}
 */
export function selectCredibleCompAnchor({
  comps = [],
  subject = {},
  valuation_mid = null,
  previously_disclosed = [],
  now = Date.now(),
} = {}) {
  const assetClass = normalizeAssetClass(subject.asset_class || subject.asset_type);
  const rejected = [];
  const eligible = [];

  for (const comp of Array.isArray(comps) ? comps : []) {
    const screen = screenCompForDisclosure(comp, {
      asset_class: assetClass,
      subject_sqft: subject.sqft,
      valuation_mid,
      now,
    });
    if (screen.eligible) eligible.push(comp);
    else rejected.push({ comp_property_id: comp.property_id || comp.comp_id || null, reasons: screen.reasons });
  }

  if (!eligible.length) {
    return { eligible: false, anchor: null, authorized_statement: null, rejected };
  }

  // Anchor choice: the LOWEST eligible sale (it anchors the negotiation) —
  // but only from comps that already passed every credibility gate above.
  const sorted = [...eligible].sort((a, b) => num(a.sale_price) - num(b.sale_price));
  const chosen = sorted[0];
  const previouslyDisclosedIds = new Set(
    (Array.isArray(previously_disclosed) ? previously_disclosed : [])
      .map((a) => a.comp_property_id || a.sale_price)
      .filter(Boolean)
  );

  const confidence = num(chosen.comp_confidence) ?? num(chosen.confidence);
  const distance = num(chosen.distance_miles);
  const salePrice = num(chosen.sale_price);
  const saleDate = chosen.sale_date || chosen.sold_date || null;

  // The only statement templates may render. "Similar condition" is never
  // claimed — proximity and recency are the only asserted facts.
  const priceText = `$${salePrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const distanceText =
    distance !== null ? (distance <= 0.5 ? "nearby" : `about ${Math.round(distance * 10) / 10} miles away`) : "in the area";
  const monthsAgo = monthsBetween(saleDate, now);
  const whenText =
    monthsAgo === null ? "recently" : monthsAgo <= 2 ? "in the last couple of months" : `about ${Math.round(monthsAgo)} months ago`;
  const authorized_statement = `A comparable property ${distanceText} sold for ${priceText} ${whenText}.`;

  const anchor = {
    comp_property_id: chosen.property_id || chosen.comp_id || null,
    address: chosen.address || null,
    sale_price: salePrice,
    sale_date: saleDate,
    distance_miles: distance,
    similarity_score: num(chosen.comp_score) ?? num(chosen.score),
    condition_confidence: confidence,
    source: chosen.source || chosen.sale_source || null,
    why_selected: "lowest_credible_disclosure_grade_comp",
    previously_disclosed: previouslyDisclosedIds.has(chosen.property_id || chosen.comp_id || salePrice),
    authorized_statement,
    selected_at: new Date(now).toISOString(),
  };

  return { eligible: true, anchor, authorized_statement, rejected };
}

export default {
  screenCompForDisclosure,
  selectCredibleCompAnchor,
};
