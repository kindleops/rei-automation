/**
 * W8C Shadow Buyer Fit Evaluator — pure, deterministic scoring.
 *
 * Answers: given a subject property, which canonical W8C buyers WITH SUFFICIENT
 * EVIDENCE show the strongest observed fit, and why?
 *
 * This module is intentionally PURE. It imports nothing — no database, no W8C
 * client, no REI subsystem. It is a function from (subject, candidates) to a
 * ranked, fully-explained shadow list. That is the isolation guarantee: it
 * cannot reach a decision or write system because it cannot reach anything.
 *
 * The ranking it produces exists ONLY inside its own shadow output. It does not
 * touch REI buyer-match ranking, matchScore, matchGrade, MAO, offer pricing,
 * offers, campaigns, outreach, seller priority, suppressions, send_queue, or
 * autonomous workflows.
 *
 * LANGUAGE: this is observed fit, not prediction. Nothing here may describe a
 * buyer as guaranteed, probable, or likely to buy. The only permitted verdicts
 * are strong / partial / weak observed fit, and not_evaluable.
 *
 * MISSING ≠ MISMATCH. Every dimension returns `null` when either side lacks
 * defensible evidence, and null dimensions are dropped from the weighted mean
 * rather than scored as zero. A buyer is never penalised for what we failed to
 * observe.
 */

/**
 * Component weights — SET BY BACKTEST, NOT BY INTUITION.
 *
 * A leakage-controlled historical backtest (1,355 events, candidate profiles
 * rebuilt from strictly-prior acquisitions only) tested the weights that
 * "looked sensible" against simpler alternatives. Two of the a-priori guesses
 * were wrong, and the measured result is what is encoded here.
 *
 *  geography 0.40   CONFIRMED as the dominant signal. It eliminates 69.96% of
 *                   candidates outright, and geography-only already reaches
 *                   19.34% Top-1 / 55.50% Top-10 against a popularity baseline
 *                   of 3.84% / 21.40%. Geography is doing real work, not
 *                   proxying "this buyer buys a lot".
 *
 *  asset 0.20       Small but real: adding it to geography moved Top-1 from
 *                   19.34% to 20.22%. Low-entropy (506/528 buyers include
 *                   'sfr'), so it earns its weight by punishing mismatch rather
 *                   than rewarding the near-universal match.
 *
 *  robustPrice 0.00 REJECTED as a ranking input. This was proposed at 0.30 and
 *                   the backtest refuted it: Top-10 fell from 55.42% (no price)
 *                   to 50.70%, and degradation was monotone in the weight
 *                   (0.05 -> 55.79%, 0.10 -> 54.39%, 0.15 -> 53.87%). The cause
 *                   is a unit mismatch that cannot be fixed at serving time:
 *                   the buybox band is built from PURCHASE prices while a
 *                   subject only carries market value, and the observed ratio
 *                   is a median 0.788 with a p10-p90 spread of 0.53-1.14.
 *                   Calibrating by that median still lost (52.77%). The
 *                   dimension is therefore still COMPUTED AND DISPLAYED — "is
 *                   this inside their observed range?" is useful to a human —
 *                   but it does not move the rank.
 *
 *  characteristics 0.05  Kept small and positive. It is the only addition that
 *                   improved the held-out era (Top-10 50.43% -> 52.57%, mean
 *                   rank 21.0 -> 20.3) and it collapses ties from 780 to 243,
 *                   which is genuine discrimination rather than a tie-break
 *                   artifact. Larger weights regressed (0.20 -> 54.02%).
 *
 * Evidence is NOT a weighted dimension. Letting evidence add score would
 * manufacture fit for a well-documented buyer who matches nothing. It instead
 * multiplies the dimensional result within a bounded band (see EVIDENCE_FLOOR),
 * so it can temper or firm a fit but never create one.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  geography: 0.40,
  asset: 0.20,
  robustPrice: 0.00, // displayed, deliberately not ranked — see above
  characteristics: 0.05,
});

/** Evidence multiplies fit within [FLOOR, 1.0]; it can never create fit. */
export const EVIDENCE_FLOOR = 0.7;

export const FIT_LABELS = Object.freeze({
  STRONG: "strong observed fit",
  PARTIAL: "partial observed fit",
  WEAK: "weak observed fit",
  NOT_EVALUABLE: "not evaluable",
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const upper = (v) => String(v ?? "").trim().toUpperCase();
const positive = (v) => (v === null || v <= 0 ? null : v);

/** "Riverside County" and "RIVERSIDE" must compare equal. */
export function normalizeCounty(value) {
  const base = upper(value).replace(/\bCOUNTY\b/g, "").replace(/[^A-Z0-9]+/g, " ").trim();
  return base || null;
}

const normalizeZip = (v) => {
  const digits = String(v ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
};

/** "CA|Riverside" -> { state: 'CA', county: 'RIVERSIDE' } */
export function parseCountyKey(key) {
  const [state, county] = String(key ?? "").split("|");
  return { state: upper(state) || null, county: normalizeCounty(county) };
}

/**
 * Map a REI property type onto the W8C asset-family vocabulary.
 *
 * W8C families: sfr, small_multifamily_2_4, multifamily_unspecified,
 * apartments_5plus, commercial_other, self_storage.
 *
 * Unmappable types return null (unknown) rather than a guess — land and "Other"
 * have no W8C counterpart and must not be scored as a mismatch.
 */
export function normalizeAssetFamily(propertyType, unitsCount) {
  const type = upper(propertyType).replace(/[^A-Z0-9]+/g, " ").trim();
  const units = num(unitsCount);
  if (!type) return null;

  if (/^(SINGLE FAMILY|SFR|TOWNHOUSE|CONDO|DUPLEX CONVERTED SFR)$/.test(type)) return "sfr";
  if (/^(APARTMENT|APARTMENTS|MULTIFAMILY 5|MULTI FAMILY 5)/.test(type)) return "apartments_5plus";
  if (/^(MULTI FAMILY|MULTIFAMILY)$/.test(type)) {
    if (units === null) return "multifamily_unspecified";
    if (units >= 5) return "apartments_5plus";
    if (units >= 2) return "small_multifamily_2_4";
    return "multifamily_unspecified";
  }
  if (/STORAGE/.test(type)) return "self_storage";
  if (/^(COMMERCIAL|RETAIL|OFFICE|INDUSTRIAL|STRIP CENTER)/.test(type)) return "commercial_other";
  return null; // land, mobile home, "Other" — no defensible W8C counterpart
}

/** Families that partially satisfy one another. Order-independent. */
const FAMILY_ADJACENCY = [
  ["multifamily_unspecified", "small_multifamily_2_4"],
  ["multifamily_unspecified", "apartments_5plus"],
];

function familyCompatible(subjectFamily, buyerFamily) {
  return FAMILY_ADJACENCY.some(
    ([a, b]) =>
      (a === subjectFamily && b === buyerFamily) || (b === subjectFamily && a === buyerFamily),
  );
}

/**
 * Normalize a subject property into the fields the evaluator can actually use.
 *
 * Deliberately absent: bedrooms, bathrooms, year built. W8C publishes no buybox
 * preference for any of them, so including them would be scoring against
 * nothing.
 */
export function normalizeSubject(property = {}) {
  const state = upper(property.state ?? property.property_address_state) || null;
  const county = normalizeCounty(property.county ?? property.property_address_county_name);
  const zip = normalizeZip(property.zip ?? property.property_address_zip);
  const propertyType = property.propertyType ?? property.property_type ?? null;
  const units = num(property.units ?? property.units_count);
  return {
    propertyId: property.propertyId ?? property.property_id ?? null,
    state,
    county,
    zip,
    countyKey: state && county ? `${state}|${county}` : null,
    propertyType,
    assetFamily: normalizeAssetFamily(propertyType, units),
    // Reference price is an estimated market value, NOT an offer or MAO figure.
    // Coupling this to offer pricing would make the evaluator a pricing input.
    referencePrice: positive(num(property.referencePrice ?? property.estimated_value)),
    // 0 sqft / 0 units means "not recorded" (vacant land records carry zeros),
    // not "a zero-square-foot building". Scoring them as real values produced
    // a nonsensical "sqft below range" against every buyer.
    buildingSqft: positive(num(property.buildingSqft ?? property.building_sqft ?? property.building_square_feet)),
    units: positive(units),
  };
}

/**
 * Geography, at the precision W8C actually publishes.
 * Tiers are distinguished rather than flattened: a ZIP hit is far stronger
 * evidence than "operates somewhere in this state".
 */
export function scoreGeography(subject, buyer) {
  if (!subject.state) return { fit: null, tier: "unknown", reason: "subject has no state" };

  const zips = new Set((buyer.zips ?? []).map(normalizeZip).filter(Boolean));
  if (subject.zip && zips.has(subject.zip)) {
    return { fit: 1.0, tier: "zip", reason: `has acquired in ZIP ${subject.zip}` };
  }

  const counties = (buyer.counties ?? []).map(parseCountyKey);
  if (subject.county && counties.some((c) => c.state === subject.state && c.county === subject.county)) {
    return { fit: 0.85, tier: "county", reason: `active in ${subject.state} ${subject.county} county` };
  }

  const states = new Set((buyer.states ?? []).map(upper).filter(Boolean));
  if (states.has(subject.state)) {
    return { fit: 0.45, tier: "state", reason: `active in ${subject.state}, different county` };
  }

  if (!states.size) return { fit: null, tier: "unknown", reason: "buyer has no geography evidence" };
  return { fit: 0.0, tier: "mismatch", reason: `no observed activity in ${subject.state}` };
}

export function scoreAsset(subject, buyer) {
  const families = buyer.assetFamilies ?? [];
  if (!subject.assetFamily) return { fit: null, tier: "unknown", reason: "subject asset class not mappable" };
  if (!families.length) return { fit: null, tier: "unknown", reason: "buyer has no asset evidence" };
  if (families.includes(subject.assetFamily)) {
    return { fit: 1.0, tier: "match", reason: `buys ${subject.assetFamily.replace(/_/g, " ")}` };
  }
  if (families.some((f) => familyCompatible(subject.assetFamily, f))) {
    return { fit: 0.6, tier: "compatible", reason: "adjacent asset family" };
  }
  return { fit: 0.0, tier: "mismatch", reason: `no observed ${subject.assetFamily.replace(/_/g, " ")} acquisitions` };
}

/**
 * Robust-band price fit. The robust band is the primary range; the p25-p75 core
 * band is never used as the filter.
 *
 * A zero lower bound is not "buys at $0" — it is the robust computation
 * flooring out, i.e. no meaningful lower constraint. Treating it literally
 * would wrongly reward implausibly cheap subjects.
 *
 * A degenerate band (low === high) is a single observed point, not an
 * infinitely narrow filter, so distance decays against a scale derived from the
 * band's own magnitude rather than its zero width.
 */
export function scoreRobustPrice(subject, buyer) {
  const price = subject.referencePrice;
  const low = num(buyer.priceRobustLow);
  const high = num(buyer.priceRobustHigh);

  if (price === null) return { fit: null, tier: "unknown", reason: "subject has no reference price" };
  if (low === null || high === null) return { fit: null, tier: "unknown", reason: "buyer has no robust price band" };
  if (high < low) return { fit: null, tier: "unknown", reason: "buyer price band is inverted" };

  const lowerUnbounded = low === 0;
  const aboveLow = lowerUnbounded || price >= low;
  if (aboveLow && price <= high) {
    return {
      fit: 1.0,
      tier: "inside",
      reason: lowerUnbounded
        ? `within observed range (up to ${Math.round(high).toLocaleString("en-US")})`
        : "within observed robust price range",
    };
  }

  // Tolerance scales with the band's own magnitude so a degenerate or very
  // narrow band still degrades smoothly instead of snapping to zero.
  const span = high - (lowerUnbounded ? 0 : low);
  const scale = Math.max(span, 0.25 * Math.max(high, 1), 1);
  const distance = price < low && !lowerUnbounded ? low - price : price - high;
  const fit = clamp01(1 - distance / scale);
  return {
    fit,
    tier: price > high ? "above" : "below",
    reason: price > high ? "above observed robust price range" : "below observed robust price range",
  };
}

/** Sqft and units only — the sole characteristics W8C publishes a range for. */
export function scoreCharacteristics(subject, buyer) {
  const parts = [];

  const band = (value, p25, p75, label) => {
    const v = num(value);
    const lo = num(p25);
    const hi = num(p75);
    if (v === null || lo === null || hi === null || hi < lo) return null;
    if (v >= lo && v <= hi) return { fit: 1.0, label, tier: "inside" };
    const scale = Math.max(hi - lo, 0.5 * Math.max(hi, 1), 1);
    const distance = v < lo ? lo - v : v - hi;
    return { fit: clamp01(1 - distance / scale), label, tier: v > hi ? "above" : "below" };
  };

  const sqft = band(subject.buildingSqft, buyer.buildingSqftP25, buyer.buildingSqftP75, "sqft");
  const units = band(subject.units, buyer.unitsP25, buyer.unitsP75, "units");
  if (sqft) parts.push(sqft);
  if (units) parts.push(units);

  if (!parts.length) return { fit: null, tier: "unknown", reason: "no comparable characteristics", parts: [] };
  const fit = parts.reduce((sum, p) => sum + p.fit, 0) / parts.length;
  return {
    fit,
    tier: parts.every((p) => p.tier === "inside") ? "inside" : "partial",
    reason: parts.map((p) => `${p.label} ${p.tier}`).join(", "),
    parts,
  };
}

/**
 * How much the record itself can be trusted. Qualifies a fit; never creates one.
 * Every input is already-computed W8B output, so this stays deterministic.
 */
export function evidenceConfidence(buyer) {
  const depth = num(buyer.evidenceDepth) ?? num(buyer.acquisitionCount) ?? 0;
  // Saturating rather than linear: the 3rd acquisition adds far more than the 30th.
  const depthFactor = clamp01(Math.log1p(Math.max(depth, 0)) / Math.log1p(20));
  const buyboxConfidence = clamp01(num(buyer.buyboxConfidence) ?? 0);
  const behaviorConfidence = clamp01(num(buyer.behaviorConfidence) ?? 0);

  const days = num(buyer.daysSinceLast);
  // Neutral (not favourable) when recency is unknown.
  const recencyFactor = days === null ? 0.5 : days <= 180 ? 1 : days <= 365 ? 0.75 : days <= 730 ? 0.45 : 0.2;

  const score = 0.35 * buyboxConfidence + 0.25 * behaviorConfidence + 0.25 * depthFactor + 0.15 * recencyFactor;
  return Math.round(clamp01(score) * 10000) / 10000;
}

/**
 * Price does not rank (the backtest refuted that), but it does CAP the claim.
 *
 * Without this, a subject far outside every observed price band still reads as
 * a "strong observed fit" on geography and asset alone — a $3.27M house scoring
 * 94/100 against buyers whose entire observed range tops out in the low
 * hundreds of thousands. Capping the label leaves the ranking untouched (labels
 * are not part of the sort) while refusing to overstate the evidence.
 */
function labelFor(score, evaluable, priceFit) {
  if (!evaluable) return FIT_LABELS.NOT_EVALUABLE;
  const outsideEveryBand = priceFit === 0;
  if (score >= 70) return outsideEveryBand ? FIT_LABELS.PARTIAL : FIT_LABELS.STRONG;
  if (score >= 45) return outsideEveryBand ? FIT_LABELS.WEAK : FIT_LABELS.PARTIAL;
  return FIT_LABELS.WEAK;
}

/**
 * Evaluate one candidate against the subject.
 * @param {object} subject normalized subject (see normalizeSubject)
 * @param {object} buyer   candidate with buybox + behaviour evidence
 * @param {object} [opts]  { weights } — baselines pass reduced weight sets
 */
export function evaluateBuyerFit(subject, buyer, opts = {}) {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  const geography = scoreGeography(subject, buyer);
  const asset = scoreAsset(subject, buyer);
  const robustPrice = scoreRobustPrice(subject, buyer);
  const characteristics = scoreCharacteristics(subject, buyer);

  const dimensions = [
    ["geography", geography, weights.geography],
    ["asset", asset, weights.asset],
    ["robustPrice", robustPrice, weights.robustPrice],
    ["characteristics", characteristics, weights.characteristics],
  ];

  let weighted = 0;
  let available = 0;
  const used = [];
  for (const [name, result, weight] of dimensions) {
    if (result.fit === null || !weight) continue;
    weighted += result.fit * weight;
    available += weight;
    used.push(name);
  }

  const ec = evidenceConfidence(buyer);
  const evaluable = available > 0;
  const base = evaluable ? weighted / available : 0;
  const multiplier = EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR) * ec;
  // Rounded to 4dp before scaling so the score is bit-stable across runs.
  const score = evaluable ? Math.round(base * multiplier * 1000000) / 10000 : 0;

  const reasons = [];
  if (geography.fit !== null) reasons.push(geography.reason);
  if (asset.fit !== null) reasons.push(asset.reason);
  if (robustPrice.fit !== null) reasons.push(robustPrice.reason);
  if (characteristics.fit !== null) reasons.push(characteristics.reason);
  if (!evaluable) reasons.push("no comparable dimension between subject and buyer");

  return {
    buyerRef: buyer.buyerRef,
    displayName: buyer.displayName ?? null,
    entityType: buyer.entityType ?? "unknown",
    geographyFit: geography.fit,
    geographyTier: geography.tier,
    assetFit: asset.fit,
    assetTier: asset.tier,
    robustPriceFit: robustPrice.fit,
    robustPriceTier: robustPrice.tier,
    characteristicsFit: characteristics.fit,
    characteristicsTier: characteristics.tier,
    evidenceConfidence: ec,
    evidenceDepth: num(buyer.evidenceDepth),
    dimensionsUsed: used,
    observedBuyboxFitScore: score,
    label: labelFor(score, evaluable, robustPrice.fit),
    evaluable,
    reasons,
  };
}

/**
 * Rank candidates. Ties break deterministically so the same inputs always
 * produce the same order regardless of input sequence or JS engine sort:
 * score, then evidence confidence, then depth, then buyerRef lexicographically.
 */
export function rankBuyerFits(subject, candidates = [], opts = {}) {
  const limit = opts.limit ?? 10;
  // A zero score means no dimension produced any fit — showing it as a
  // "top" result would pad the list with buyers who match nothing.
  const minScore = opts.minScore ?? 0;
  const evaluated = candidates
    .map((buyer) => evaluateBuyerFit(subject, buyer, opts))
    .filter((r) => (opts.includeNotEvaluable ? true : r.evaluable && r.observedBuyboxFitScore > minScore));

  evaluated.sort((a, b) =>
    b.observedBuyboxFitScore - a.observedBuyboxFitScore ||
    b.evidenceConfidence - a.evidenceConfidence ||
    (b.evidenceDepth ?? 0) - (a.evidenceDepth ?? 0) ||
    String(a.buyerRef).localeCompare(String(b.buyerRef)));

  return evaluated.slice(0, limit);
}

export default rankBuyerFits;
