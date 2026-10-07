/**
 * INVESTOR VALUATION v3 — SHADOW ONLY (owner brief 2026-10-06).
 *
 * "Offers are way too low. Off-market in the area is 140-160K and our engine
 *  says offer 80-90K. It must be MASSIVELY recorrected."
 *
 * v3 values an SFR subject at what OFF-MARKET INVESTORS actually pay for it
 * as-is, from recorded sales (public.mv_map_market_sales + the owner-of-record
 * snapshot in comp_private.comp_properties). Nothing here is wired into
 * scoring, offers, crons or routes, and nothing here writes. The production
 * engine is not imported or modified.
 *
 * THE DOUBLE COUNT IT FIXES (evidence in tmp/valuation-v3/REPORT.txt):
 *   production value  = weighted comp price + (comp_repairs - subject_repairs)
 *   production MAO    = 0.70 x value - subject_repairs
 *   Both repair figures are the same formula ($35/sqft for ~88% of SFR
 *   records, regardless of condition), so the comp adjustment nets to ~0 and
 *   the value is an AS-IS value (comps priced as sold). The 0.70 rule is an
 *   ARV rule: it already reserves rehab, holding and profit. Applying it to an
 *   as-is value AND subtracting repairs counts the rehab twice and the
 *   investor discount once more on top -> offer ~0.45 x value.
 *   v3 prices the as-is investor purchase directly, so its buyer ceiling is
 *   the investor value itself; the offer is that ceiling less our assignment
 *   fee. Repairs enter ONLY as a condition DIFFERENCE between subject and comp
 *   (and only when the records actually differ in condition tier).
 *
 * SOURCE: public.mv_map_market_sales, whose 't:' rows ARE the canonical
 * recorded transactions (comp_private.comp_canonical_transactions, current to
 * the import), joined to comp_private.comp_properties for features, tract,
 * subdivision, lot, condition and the owner-of-record snapshot. Not the frozen
 * v_recent_sold_comps pool (max sale 2026-05-08). The production engine's comp
 * gates (normalizePropertyFeatures + evaluateCompEligibility) are injected by
 * the caller as `gate` and recorded as engine_gate:<reason>.
 *
 * MODEL v3.1 (every comp keeps its include/exclude reason and each weight factor):
 *   weight = distance x barrier x subdivision x recency x similarity x condition x buyer
 *   distance     SFR 0.5 ^ (miles / 0.5); >= 2.5 mi is not comparable (excluded).
 *                MF: radius 5 mi (2-4 units) / 10 mi (5+), adaptive half-life =
 *                distance of the 6th-nearest qualified sale, bounded.
 *   barrier      same census tract 1.0, other tract same county 0.55, other
 *                county 0.30, tract unknown 0.80. A tract boundary is the proxy
 *                for a major road / highway / river / rail line until TIGER road
 *                geometry is loaded (see report).
 *   subdivision  same recorded plat x2.0, same subdivision base name x1.6; a
 *                same-subdivision comp within 20% sqft / 10 years keeps
 *                similarity >= 0.9 (owner: small differences = strong comp)
 *   recency      0.5 ^ (months / 9) SFR, 24 months max (MF 12-18 / 24-36)
 *   similarity   sqft (gate +-35%), beds (gate +-2), baths, year built (gate:
 *                > 30 years or a modern-vs-older era), lot (gate: > 3x and
 *                > 0.5 acre bigger); MF: unit count band, sqft per door
 *   condition    repair-rate tier equal 1.0, different 0.7
 *   buyer        recorded investor / cash, off-market 1.0; inferred investor
 *                (owner model) strong 0.9, likely 0.75; off-market individual /
 *                unknown 0.30. MLS comps are MLS comps: investor via MLS 0.5,
 *                retail MLS 0.15, and never the investor basis.
 *   price adj.   SFR size elasticity (subject/comp sqft)^0.6 (clamped +-25%),
 *                condition tier delta x subject sqft x 0.5 (clamped +-15%);
 *                MF price per door x (sqft per door)^0.3 (clamped +-15%)
 *   outliers     absolute junk (< $25K, < $15/sqft, < $10K/door, distressed /
 *                non-arm's-length deeds, portfolio and multi-parcel
 *                considerations, builder / bank / government buyers, new
 *                construction, a flip resale), then within the set:
 *                |ln(p / weighted median)| > max(3 x 1.4826 x MAD, 0.35) is out;
 *                no comp may carry > 35% of the weight, and a dominant comp
 *                > 25% away from the rest is removed (no outlier drives an offer).
 *   estimate     weighted geometric mean of the top 12 investor comps (MF: per
 *                door x real unit count, with a per-door q25-q75 range). When
 *                fewer than 3 investor comps survive, the whole arm's-length
 *                set is valued and scaled by the local investor/all-sales ratio
 *                (method market_ratio_fallback).
 */
import { classifyOwner } from '../../domain/market-intelligence/mi-inferred-investor.js';

export const V3 = Object.freeze({
  version: 'investor-valuation-v3.1-shadow',
  lane: 'sfr',
  // SFR radius: comps at >= 2.5 mi are NOT comparable (owner rule); inside it
  // the distance half-life of 0.5 mi does the rest (1.5 mi -> 0.125 weight).
  radiusMiles: 2.5,
  months: 24,
  readCap: 9000,
  topK: 12,
  minInvestorComps: 3,
  minInvestorNeff: 1.5,
  distanceHalfLifeMiles: 0.5,
  recencyHalfLifeMonths: 9,
  barrier: Object.freeze({ sameTract: 1, otherTract: 0.55, otherCounty: 0.3, unknown: 0.8 }),
  subdivision: Object.freeze({ samePlat: 2, sameBase: 1.6, none: 1 }),
  buyer: Object.freeze({
    recorded_investor: 1, cash: 1, inferred_strong: 0.9, inferred_likely: 0.75,
    investor_mls: 0.5, public_other: 0.3, retail_mls: 0.15,
  }),
  maxSqftDiff: 0.35,
  maxBedDiff: 2,
  // Year-built ERA: > 30 years apart, or a modern (>= 2005) comp for a pre-1990
  // subject (and the reverse), is a different product, not a comp.
  maxYearBuiltDiff: 30,
  modernEra: 2005,
  olderEra: 1990,
  // Lot: a comp lot > 3x the subject's AND > 0.5 acre larger is a different product.
  maxLotRatio: 3,
  minLotExcessSqft: 21_780,
  // Same subdivision with small differences (<= 20% sqft, <= 10 years) is a strong comp.
  sameSubdivisionSqftTolerance: 0.2,
  sameSubdivisionYearTolerance: 10,
  sameSubdivisionSimilarityFloor: 0.9,
  // No single comp may carry more than 35% of the value, and a dominant comp
  // whose own price sits > 25% from the rest is removed (it would drive the offer).
  maxCompShare: 0.35,
  dominantOutlierLog: 0.25,
  sizeElasticity: 0.6,
  sizeAdjCap: 0.25,
  conditionAdjShare: 0.5,
  conditionAdjCap: 0.15,
  conditionTierMismatch: 0.7,
  junkMinPrice: 25_000,
  junkMinPpsf: 15,
  outlierMadK: 3,
  outlierMinLog: 0.35,
  flipResaleMonths: 12,
  flipResaleRatio: 1.3,
  fallbackMinInvestor: 8,
  fallbackMinAll: 15,
  defaultInvestorRatio: 0.85,
});

/**
 * MULTIFAMILY lanes. Fewer sales, so a wider radius is acceptable; value is
 * PRICE PER DOOR x the subject's real unit count, with a per-door range for
 * anchoring. A comp needs a real positive unit count (v2.1 rule: no inferred 1).
 *   2-4 units: 2-4 unit comps, radius 5 mi (half-life 1.0 mi), 24 months.
 *   5+ units:  0.5x-2x the door count, radius 10 mi (half-life 2.5 mi), 36 months.
 */
export const V3_MF24 = Object.freeze({
  ...V3,
  version: 'investor-valuation-v3.1-mf24-shadow',
  lane: 'mf24',
  radiusMiles: 5,
  distanceHalfLifeMiles: 1,
  months: 24,
  recencyHalfLifeMonths: 12,
  junkMinPrice: 40_000,
  junkMinPerDoor: 10_000,
  sizeElasticity: 0.3,
  sizeAdjCap: 0.15,
  maxLotRatio: Infinity,
  maxYearBuiltDiff: 40,
  adaptiveK: 6,
  minHalfLifeMiles: 0.5,
  perDoorBandMinLog: 0.15,
});
export const V3_MF5 = Object.freeze({
  ...V3_MF24,
  version: 'investor-valuation-v3.1-mf5-shadow',
  lane: 'mf5',
  radiusMiles: 10,
  distanceHalfLifeMiles: 2.5,
  minHalfLifeMiles: 0.75,
  months: 36,
  recencyHalfLifeMonths: 18,
  junkMinPrice: 150_000,
  unitRatioMin: 0.5,
  unitRatioMax: 2,
});
/** The lane for a subject: real unit count first, then the recorded type. */
export function laneFor(subject = {}) {
  const u = num(subject.units) !== null && num(subject.units) > 0 ? num(subject.units) : null;
  if (u !== null && u >= 5) return V3_MF5;
  if (u !== null && u >= 2) return V3_MF24;
  return V3;
}

export const V3_REASONS = Object.freeze({
  unpriced: 'v3_unpriced',
  self: 'v3_subject_own_sale',
  leak: 'v3_on_or_after_as_of',
  outsideRadius: 'v3_outside_radius',
  beyondSfrMax: 'v3_beyond_2_5mi_not_comparable_for_sfr',
  yearEra: 'v3_year_built_era_mismatch',
  lotMuchBigger: 'v3_lot_much_bigger_than_subject',
  dominantOutlier: 'v3_dominant_comp_out_of_line_with_rest',
  unitsUnknown: 'v3_unit_count_unknown_no_per_door',
  unitBand: 'v3_unit_count_outside_band',
  junkPerDoor: 'v3_junk_price_per_door',
  tooOld: 'v3_older_than_window',
  noCoords: 'v3_no_coordinates',
  junkPrice: 'v3_junk_price_below_floor',
  junkPpsf: 'v3_junk_price_per_sqft',
  nonArms: 'v3_non_arms_length',
  distressedDeed: 'v3_distressed_or_non_sale_instrument',
  portfolio: 'v3_portfolio_deed',
  bulk: 'v3_bulk_multi_parcel_consideration',
  excludedBuyer: 'v3_builder_bank_or_government_buyer',
  newConstruction: 'v3_new_construction',
  flipResale: 'v3_renovated_flip_resale',
  asset: 'v3_not_single_family',
  sqft: 'v3_sqft_outside_35pct',
  beds: 'v3_beds_differ_more_than_2',
  duplicate: 'v3_duplicate_economic_sale',
  outlierLow: 'v3_outlier_low_within_set',
  outlierHigh: 'v3_outlier_high_within_set',
  outsideTopK: 'v3_outside_top_weight',
});

// Instruments that are not an open-market sale price: foreclosure / trustee /
// sheriff / in-lieu, court and administrative transfers, corrections and
// re-recordings (duplicates), gifts and family transfers, financing documents.
const DISTRESSED_DEED = /(trustee|sheriff|in lieu|foreclos|certificate of transfer|public action|correction|re-recorded|mortgage|gift|intrafamily|transfer on death|distribution|affidavit|referee|commissioner|special master|quit ?claim|exchange|contract of sale|agreement of sale)/i;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// A physical fact is known only when it is a positive number (0 beds / 0 sqft = not recorded).
const pos = (v) => (num(v) !== null && num(v) > 0 ? num(v) : null);
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const round = (v, d = 0) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const roundMoney = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v / 100) * 100);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundThousand = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v / 1000) * 1000);

export function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => !Number.isFinite(v))) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const monthsBetween = (fromDay, toDay) => {
  const a = Date.parse(`${day(fromDay)}T00:00:00Z`);
  const b = Date.parse(`${day(toDay)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / (86_400_000 * 30.4375) : null;
};

// ── subdivision ──────────────────────────────────────────────────────────────
const SUBDIV_NOISE = new Set([
  'ADDN', 'ADDITION', 'ADD', 'ADDTN', 'TO', 'MPLS', 'MINNEAPOLIS', 'SEC', 'SECT', 'SECTION', 'PHASE', 'PH', 'UNIT', 'UNITS',
  'NO', 'NUM', 'BLK', 'BLKS', 'BLOCK', 'BLOCKS', 'LOT', 'LOTS', 'REPLAT', 'RPLT', 'REV', 'REVISED', 'MAP', 'AMENDED', 'AMND',
  'AMD', 'RESUB', 'RESUBDIVISION', 'SUBDIVISION', 'SUBD', 'SUB', 'THE', 'OF', 'AND', 'PT', 'PART', 'TR', 'TRACT', 'PLAT',
  'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'A', 'B', 'C', 'D', 'E', 'N', 'S', 'W',
]);

/**
 * { plat, base }: plat = the recorded name with punctuation/whitespace
 * normalized (same plat = same recorded subdivision filing); base = the name
 * with section/phase/unit/addition/number tokens removed ("WESTBURY SEC 3" and
 * "WESTBURY SEC 4" share the base "WESTBURY"). Null when nothing is left.
 */
export function normalizeSubdivision(name) {
  const raw = text(name).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return { plat: null, base: null };
  const words = raw.split(' ').filter((w) => !SUBDIV_NOISE.has(w) && !/^\d+(ST|ND|RD|TH)?$/.test(w));
  const base = words.join(' ').trim();
  return { plat: raw, base: base.length >= 3 ? base : null };
}

// ── buyer type ───────────────────────────────────────────────────────────────
/**
 * The comp's buyer type. Recorded evidence (deed buyer class, cash flag) wins;
 * otherwise the inferred-investor owner model (mi_owner_link@1 + mi_owner_tier@2)
 * when the sale is linked to today's owner of record.
 * Returns { type, investor, weight, evidence[] }.
 */
export function classifyCompBuyer(row = {}, params = V3) {
  const mls = row.source === 'mls';
  const cls = text(row.buyer_class);
  const evidence = [];
  const recordedInvestor = row.is_investor === true || ['llc_investor', 'institutional', 'portfolio'].includes(cls);
  if (recordedInvestor) evidence.push(`recorded_buyer_${cls || 'investor'}`);
  if (row.is_cash_purchase === true) evidence.push('recorded_cash_purchase');
  let inferred = null;
  if (!recordedInvestor && row.owner_linked === true) {
    inferred = classifyOwner({
      corporate: row.owner_corporate === true, trust: row.owner_trust === true, outOfState: row.owner_out_of_state === true,
      mailStack: row.owner_mail_stack, residentOwner: row.owner_resident === true,
    });
    if (inferred.investor) evidence.push(`inferred_${inferred.tier}`, ...inferred.evidence);
  }
  const investor = recordedInvestor || row.is_cash_purchase === true || Boolean(inferred?.investor);
  let type;
  if (mls) type = investor ? 'investor_mls' : 'retail_mls';
  else if (recordedInvestor) type = 'recorded_investor';
  else if (row.is_cash_purchase === true) type = 'cash';
  else if (inferred?.investor) type = inferred.tier === 'strong' ? 'inferred_strong' : 'inferred_likely';
  else type = 'public_other';
  return { type, investor: investor && !mls, weight: params.buyer[type], evidence };
}

// ── repair / condition tier ───────────────────────────────────────────────────
/** The record's repair rate in $/sqft (the data's estimate is a flat tiered rate). */
export function repairRate(repairs, sqft) {
  const r = num(repairs);
  const s = num(sqft);
  if (r === null || !s || s <= 0) return null;
  return Math.round(r / s);
}

// ── qualification ─────────────────────────────────────────────────────────────
/** Deed / record level junk rules. Returns the exclusion reasons ([] = usable). */
export function qualifyRow(row, subject, ctx = {}, params = V3) {
  const reasons = [];
  const price = num(row.price);
  if (!(price > 0)) return [V3_REASONS.unpriced];
  if (text(row.property_id) && text(row.property_id) === text(subject.property_id)) reasons.push(V3_REASONS.self);
  if (ctx.asOf && day(row.sold_on) >= day(ctx.asOf)) reasons.push(V3_REASONS.leak);
  if (!Number.isFinite(num(row.lat)) || !Number.isFinite(num(row.lng))) reasons.push(V3_REASONS.noCoords);
  const type = text(row.property_type);
  const mf = params.lane !== 'sfr';
  if (!mf && (!['Single Family', 'SFR', 'Townhouse', ''].includes(type) || (num(row.units) ?? 1) > 1)) reasons.push(V3_REASONS.asset);
  if (mf) {
    const cu = pos(row.units);
    const su = pos(subject.units);
    if (cu === null || su === null) reasons.push(V3_REASONS.unitsUnknown);
    else if (!unitBandOk(su, cu, params)) reasons.push(V3_REASONS.unitBand);
    else if (price / cu < params.junkMinPerDoor) reasons.push(V3_REASONS.junkPerDoor);
  }
  if (price < params.junkMinPrice) reasons.push(V3_REASONS.junkPrice);
  const sqft = pos(row.sqft);
  if (!mf && sqft && price / sqft < params.junkMinPpsf) reasons.push(V3_REASONS.junkPpsf);
  if (row.is_arms_length === false) reasons.push(V3_REASONS.nonArms);
  if (row.doc_type && DISTRESSED_DEED.test(row.doc_type)) reasons.push(V3_REASONS.distressedDeed);
  if ((num(row.portfolio_size) ?? 1) >= 2) reasons.push(V3_REASONS.portfolio);
  if (ctx.bulkOf && ctx.bulkOf(row)) reasons.push(V3_REASONS.bulk);
  if (['builder', 'bank', 'government'].includes(text(row.buyer_class))) reasons.push(V3_REASONS.excludedBuyer);
  const yb = pos(row.year_built);
  const saleYear = Number(String(day(row.sold_on)).slice(0, 4));
  if (yb && saleYear && yb >= saleYear - 1) reasons.push(V3_REASONS.newConstruction);
  if (ctx.flipResaleIds?.has(row.comp_id)) reasons.push(V3_REASONS.flipResale);
  const sSqft = pos(subject.sqft);
  if (!mf && sSqft && sqft && Math.abs(sqft - sSqft) / sSqft > params.maxSqftDiff) reasons.push(V3_REASONS.sqft);
  const sBeds = pos(subject.beds);
  const beds = pos(row.beds);
  if (!mf && sBeds !== null && beds !== null && Math.abs(beds - sBeds) > params.maxBedDiff) reasons.push(V3_REASONS.beds);
  const sYb = pos(subject.year_built);
  if (sYb && yb && (Math.abs(yb - sYb) > params.maxYearBuiltDiff
    || (yb >= params.modernEra && sYb < params.olderEra) || (sYb >= params.modernEra && yb < params.olderEra))) reasons.push(V3_REASONS.yearEra);
  const sLot = pos(subject.lot_sqft);
  const lot = pos(row.lot_sqft);
  if (sLot && lot && lot > sLot * params.maxLotRatio && lot - sLot > params.minLotExcessSqft) reasons.push(V3_REASONS.lotMuchBigger);
  return reasons;
}

/** Multifamily unit band: 2-4 unit subjects take 2-4 unit comps; 5+ take 0.5x-2x the count. */
export function unitBandOk(subjectUnits, compUnits, params = V3_MF24) {
  if (params.lane === 'mf24') return compUnits >= 2 && compUnits <= 4;
  return compUnits >= 5 && compUnits / subjectUnits >= params.unitRatioMin && compUnits / subjectUnits <= params.unitRatioMax;
}

/**
 * A parcel that sold twice inside the window, the second time within 12
 * months at >= 1.3x the first: the later sale is a renovated resale (retail
 * ARV evidence), not an as-is investor price. Returns the later comp ids.
 */
export function flipResaleIds(rows, params = V3) {
  const byParcel = new Map();
  for (const r of rows) {
    if (!text(r.property_id) || !(num(r.price) > 0)) continue;
    if (!byParcel.has(r.property_id)) byParcel.set(r.property_id, []);
    byParcel.get(r.property_id).push(r);
  }
  const out = new Set();
  for (const sales of byParcel.values()) {
    if (sales.length < 2) continue;
    sales.sort((a, b) => String(a.sold_on).localeCompare(String(b.sold_on)));
    for (let i = 1; i < sales.length; i += 1) {
      const m = monthsBetween(sales[i - 1].sold_on, sales[i].sold_on);
      if (m !== null && m <= params.flipResaleMonths && num(sales[i].price) >= num(sales[i - 1].price) * params.flipResaleRatio) out.add(sales[i].comp_id);
    }
  }
  return out;
}

/** Multi-parcel consideration (same date + price on 2+ parcels in a zip / 3+ in a city). */
export function bulkIndex(bulkRows = []) {
  const city = new Map();
  const zip = new Map();
  for (const b of bulkRows) {
    const k = `${day(b.sold_on)}|${num(b.price)}`;
    const ck = `${k}|${text(b.city).toLowerCase()}|${text(b.state).toUpperCase()}`;
    const zk = `${k}|${text(b.zip).slice(0, 5)}`;
    city.set(ck, (city.get(ck) ?? 0) + (num(b.parcels) ?? 0));
    zip.set(zk, (zip.get(zk) ?? 0) + (num(b.parcels) ?? 0));
  }
  return (row) => {
    const k = `${day(row.sold_on)}|${num(row.price)}`;
    return (city.get(`${k}|${text(row.city).toLowerCase()}|${text(row.state).toUpperCase()}`) ?? 1) >= 3
      || (zip.get(`${k}|${text(row.zip).slice(0, 5)}`) ?? 1) >= 2;
  };
}

// ── weights + adjustments ─────────────────────────────────────────────────────
export function compWeight(row, subject, asOf, params = V3) {
  const d = num(row.distance_miles);
  const distance = d === null ? 0 : 0.5 ** (d / params.distanceHalfLifeMiles);

  let barrier;
  let barrierBasis;
  const sTract = text(subject.census_tract);
  const cTract = text(row.census_tract);
  const sameCounty = text(subject.fips) && text(row.fips) && text(subject.fips) === text(row.fips);
  if (!sTract || !cTract || !text(subject.fips) || !text(row.fips)) { barrier = params.barrier.unknown; barrierBasis = 'tract_unknown'; }
  else if (!sameCounty) { barrier = params.barrier.otherCounty; barrierBasis = 'other_county'; }
  else if (sTract === cTract) { barrier = params.barrier.sameTract; barrierBasis = 'same_tract'; }
  else { barrier = params.barrier.otherTract; barrierBasis = 'other_tract_possible_barrier'; }

  const sSub = normalizeSubdivision(subject.subdivision_name);
  const cSub = normalizeSubdivision(row.subdivision_name);
  let subdivision = params.subdivision.none;
  let subdivisionBasis = 'different_or_unknown';
  if (sameCounty && sSub.plat && sSub.plat === cSub.plat) { subdivision = params.subdivision.samePlat; subdivisionBasis = 'same_plat'; }
  else if (sameCounty && sSub.base && sSub.base === cSub.base) { subdivision = params.subdivision.sameBase; subdivisionBasis = 'same_subdivision'; }

  const age = monthsBetween(row.sold_on, asOf);
  const recency = age === null ? 0 : 0.5 ** (Math.max(0, age) / params.recencyHalfLifeMonths);

  const sSqft = pos(subject.sqft);
  const sqft = pos(row.sqft);
  const sqftPart = sSqft && sqft ? clamp(1 - Math.abs(sqft - sSqft) / sSqft / params.maxSqftDiff, 0, 1) * 0.6 + 0.4 : 0.6;
  const bedDiff = pos(subject.beds) !== null && pos(row.beds) !== null ? Math.abs(pos(row.beds) - pos(subject.beds)) : null;
  const bathDiff = pos(subject.baths) !== null && pos(row.baths) !== null ? Math.abs(pos(row.baths) - pos(subject.baths)) : null;
  const ybDiff = pos(subject.year_built) && pos(row.year_built) ? Math.abs(pos(row.year_built) - pos(subject.year_built)) : null;
  const bedPart = bedDiff === null ? 0.85 : clamp(1 - 0.2 * bedDiff, 0.5, 1);
  const bathPart = bathDiff === null ? 0.9 : clamp(1 - 0.15 * bathDiff, 0.6, 1);
  const ybPart = ybDiff === null ? 0.85 : clamp(1 - ybDiff / 40, 0.4, 1);
  const sLot = pos(subject.lot_sqft);
  const lot = pos(row.lot_sqft);
  const lotRatio = sLot && lot ? Math.max(lot / sLot, sLot / lot) : null;
  const lotPart = lotRatio === null ? 0.95 : clamp(1 - (lotRatio - 1.5) / 3, 0.5, 1);
  let similarity;
  if (params.lane === 'sfr') {
    similarity = sqftPart * bedPart * bathPart * ybPart * lotPart;
  } else {
    const su = pos(subject.units);
    const cu = pos(row.units);
    const unitPart = su && cu ? (params.lane === 'mf24' ? [1, 0.7, 0.5][Math.min(2, Math.abs(cu - su))] : clamp(1 - Math.abs(Math.log(cu / su)) / Math.log(2), 0.3, 1)) : 0.5;
    const spuS = sSqft && su ? sSqft / su : null;
    const spuC = sqft && cu ? sqft / cu : null;
    const spuPart = spuS && spuC ? clamp(1 - Math.abs(spuC - spuS) / spuS / 0.5, 0.4, 1) : 0.8;
    similarity = unitPart * spuPart * ybPart;
  }
  if (params.lane === 'sfr' && subdivisionBasis !== 'different_or_unknown'
    && (!sSqft || !sqft || Math.abs(sqft - sSqft) / sSqft <= params.sameSubdivisionSqftTolerance)
    && (ybDiff === null || ybDiff <= params.sameSubdivisionYearTolerance)) {
    similarity = Math.max(similarity, params.sameSubdivisionSimilarityFloor);
  }

  const sRate = repairRate(subject.estimated_repairs, subject.sqft);
  const cRate = repairRate(row.estimated_repair_cost, row.sqft);
  const condition = sRate !== null && cRate !== null && sRate !== cRate ? params.conditionTierMismatch : 1;

  const buyer = classifyCompBuyer(row, params);
  const total = distance * barrier * subdivision * recency * similarity * condition * buyer.weight;
  return {
    total,
    factors: {
      distance: round(distance, 4), barrier: round(barrier, 2), barrier_basis: barrierBasis,
      subdivision: round(subdivision, 2), subdivision_basis: subdivisionBasis,
      recency: round(recency, 4), age_months: round(age, 1), similarity: round(similarity, 3),
      condition: round(condition, 2), buyer: round(buyer.weight, 2), buyer_type: buyer.type,
    },
    buyer,
  };
}

export function adjustCompPrice(row, subject, params = V3) {
  const price = num(row.price);
  const adjustments = [];
  if (params.lane !== 'sfr') {
    // MULTIFAMILY: price per door, with a light size-per-door adjustment.
    const cu = pos(row.units);
    const su = pos(subject.units);
    const perDoor = price / cu;
    let v = perDoor;
    const spuS = pos(subject.sqft) && su ? pos(subject.sqft) / su : null;
    const spuC = pos(row.sqft) && cu ? pos(row.sqft) / cu : null;
    if (spuS && spuC) {
      const f = clamp((spuS / spuC) ** params.sizeElasticity, 1 - params.sizeAdjCap, 1 + params.sizeAdjCap);
      v = perDoor * f;
      adjustments.push({ basis: 'sqft_per_door_elasticity', factor: round(f, 4) });
    }
    adjustments.push({ basis: 'price_per_door', comp_units: cu, per_door: roundMoney(perDoor) });
    return { adjusted_price: v, adjustments };
  }
  let value = price;
  const sSqft = pos(subject.sqft);
  const sqft = pos(row.sqft);
  if (sSqft && sqft) {
    const f = clamp((sSqft / sqft) ** params.sizeElasticity, 1 - params.sizeAdjCap, 1 + params.sizeAdjCap);
    value = price * f;
    adjustments.push({ basis: 'size_elasticity_0_6', factor: round(f, 4), amount: roundMoney(value - price) });
  }
  const sRate = repairRate(subject.estimated_repairs, subject.sqft);
  const cRate = repairRate(row.estimated_repair_cost, row.sqft);
  if (sRate !== null && cRate !== null && sRate !== cRate && sSqft) {
    const raw = (cRate - sRate) * sSqft * params.conditionAdjShare;
    const amt = clamp(raw, -price * params.conditionAdjCap, price * params.conditionAdjCap);
    value += amt;
    adjustments.push({ basis: 'condition_tier_difference', comp_rate: cRate, subject_rate: sRate, amount: roundMoney(amt) });
  } else {
    adjustments.push({ basis: 'condition_tier_difference', amount: 0, note: sRate === null || cRate === null ? 'repair_rate_unknown_no_adjustment' : 'same_repair_tier_no_adjustment' });
  }
  return { adjusted_price: value, adjustments };
}

// ── robust statistics ─────────────────────────────────────────────────────────
export function weightedQuantile(items, key, q) {
  const v = items.filter((x) => Number.isFinite(x[key]) && x.weight > 0).sort((a, b) => a[key] - b[key]);
  const total = v.reduce((s, x) => s + x.weight, 0);
  if (!total) return null;
  let acc = 0;
  for (const x of v) { acc += x.weight; if (acc >= q * total) return x[key]; }
  return v.at(-1)[key];
}

/** Within-set outliers on log price around the weighted median. Mutates status. */
export function rejectOutliers(comps, params = V3) {
  if (comps.length < 3) return { median: null, mad: null, fence: null, method: 'insufficient_count' };
  const logs = comps.map((c) => ({ ...c, lp: Math.log(c.adjusted_price) }));
  const med = weightedQuantile(logs, 'lp', 0.5);
  const dev = logs.map((c) => ({ weight: c.weight, d: Math.abs(c.lp - med) }));
  const mad = weightedQuantile(dev, 'd', 0.5) ?? 0;
  const fence = Math.max(params.outlierMadK * 1.4826 * mad, params.outlierMinLog);
  for (const c of comps) {
    const d = Math.log(c.adjusted_price) - med;
    if (Math.abs(d) > fence) { c.status = 'excluded'; c.reasons = [d < 0 ? V3_REASONS.outlierLow : V3_REASONS.outlierHigh]; }
  }
  return { median: round(Math.exp(med)), mad: round(mad, 4), fence: round(fence, 4), method: 'weighted_log_mad' };
}

/** Cap any single comp at maxShare of the total weight (iteratively); records the cap. */
export function capShares(top, maxShare) {
  if (top.length * maxShare < 1) return; // too few comps to cap (e.g. 2 comps at 35%)
  for (let i = 0; i < 6; i += 1) {
    const W = top.reduce((s, c) => s + c.weight, 0);
    const over = top.filter((c) => c.weight / W > maxShare + 1e-9);
    if (!over.length) return;
    const rest = top.filter((c) => !over.includes(c)).reduce((s, c) => s + c.weight, 0);
    const target = (maxShare * rest) / (1 - maxShare * over.length);
    for (const c of over) { c.weight_uncapped = c.weight_uncapped ?? c.weight; c.weight = target; c.share_capped = true; }
  }
}

function estimateFrom(comps, params = V3) {
  const top = [...comps].sort((a, b) => b.weight - a.weight).slice(0, params.topK);
  for (const c of comps) if (!top.includes(c)) { c.status = 'excluded'; c.reasons = [V3_REASONS.outsideTopK]; }
  if (!top.length || !top.reduce((s, c) => s + c.weight, 0)) return null;
  capShares(top, params.maxCompShare);
  const W = top.reduce((s, c) => s + c.weight, 0);
  const lmean = top.reduce((s, c) => s + c.weight * Math.log(c.adjusted_price), 0) / W;
  const lvar = top.reduce((s, c) => s + c.weight * (Math.log(c.adjusted_price) - lmean) ** 2, 0) / W;
  const neff = W ** 2 / top.reduce((s, c) => s + c.weight ** 2, 0);
  for (const c of top) c.share = round(c.weight / W, 4);
  return {
    mid: Math.exp(lmean), sd_log: Math.sqrt(lvar), n: top.length, n_eff: neff, total_weight: W,
    q25: weightedQuantile(top, 'adjusted_price', 0.25), q75: weightedQuantile(top, 'adjusted_price', 0.75),
    same_tract_share: top.filter((c) => c.factors.barrier_basis === 'same_tract').reduce((s, c) => s + c.weight, 0) / W,
    same_subdivision_share: top.filter((c) => c.factors.subdivision_basis !== 'different_or_unknown').reduce((s, c) => s + c.weight, 0) / W,
    weighted_distance: top.reduce((s, c) => s + c.weight * (c.distance_miles ?? 0), 0) / W,
  };
}

function confidenceOf(est, method) {
  if (!est) return 0;
  const depth = clamp(est.n_eff / 5, 0, 1) * 35;
  const tight = clamp(1 - est.sd_log / 0.4, 0, 1) * 30;
  const local = clamp(1 - est.weighted_distance / 1.5, 0, 1) * 20;
  const neighborhood = clamp(est.same_tract_share + est.same_subdivision_share * 0.5, 0, 1) * 15;
  const c = depth + tight + local + neighborhood;
  return Math.round(method === 'investor_comps' ? c : c * 0.75);
}

// ── main ──────────────────────────────────────────────────────────────────────
/**
 * Pure. subject: { property_id, latitude, longitude, sqft, beds, baths,
 * year_built, estimated_repairs, census_tract, fips, subdivision_name }.
 * rows: candidate sales (CANDIDATE_ROWS_SQL shape). asOf: valuation date
 * (sales strictly before it). Returns value, the explained comp ledger and
 * the v3 offer.
 */
export function valueSubjectV3({ subject, rows = [], bulkRows = [], asOf, offerParams = undefined, params = laneFor(subject), gate = null }) {
  const ledger = [];
  const bulkOf = bulkIndex(bulkRows);
  const lat = num(subject.latitude);
  const lng = num(subject.longitude);
  const priorRows = rows.filter((r) => !asOf || day(r.sold_on) < day(asOf));
  const flips = flipResaleIds(priorRows, params);
  const seen = new Set();
  const usable = [];
  for (const r0 of rows) {
    const d = haversineMiles(lat, lng, num(r0.lat), num(r0.lng));
    const r = { ...r0, distance_miles: d === null ? null : round(d, 2) };
    const age = monthsBetween(r.sold_on, asOf);
    const reasons = qualifyRow(r, subject, { asOf, bulkOf, flipResaleIds: flips }, params);
    // The production engine's comp gates (normalizePropertyFeatures + evaluateCompEligibility),
    // injected by the caller so this module stays engine-free. Radius / age come from the lane.
    if (gate) for (const g of gate(r)) reasons.push(`engine_gate:${g}`);
    if (d === null || d >= params.radiusMiles) reasons.push(params.lane === 'sfr' && d !== null ? V3_REASONS.beyondSfrMax : V3_REASONS.outsideRadius);
    if (age !== null && age > params.months) reasons.push(V3_REASONS.tooOld);
    const key = `${text(r.property_id) || r.comp_id}|${day(r.sold_on)}`;
    if (!reasons.length && seen.has(key)) reasons.push(V3_REASONS.duplicate);
    if (reasons.length) { ledger.push(explainRow(r, 'excluded', reasons)); continue; }
    seen.add(key);
    usable.push(r);
  }
  // Multifamily: the radius is wide because MF sales are sparse, but where the
  // neighbourhood HAS sales the decay tightens to them (adaptive bandwidth: the
  // half-life is the distance to the k-th nearest qualified sale, bounded).
  let wp = params;
  let bandwidth = null;
  if (params.lane !== 'sfr' && usable.length) {
    const ds = usable.map((r) => r.distance_miles).filter(Number.isFinite).sort((a, b) => a - b);
    const dk = ds[Math.min(ds.length, params.adaptiveK) - 1];
    const h = clamp(dk, params.minHalfLifeMiles, params.distanceHalfLifeMiles);
    wp = { ...params, distanceHalfLifeMiles: h };
    bandwidth = { k: params.adaptiveK, kth_distance_miles: round(dk, 2), half_life_miles: round(h, 2) };
  }
  for (let i = 0; i < usable.length; i += 1) {
    const r = usable[i];
    const w = compWeight(r, subject, asOf, wp);
    const adj = adjustCompPrice(r, subject, wp);
    usable[i] = { ...r, weight: w.total, factors: w.factors, buyer_evidence: w.buyer.evidence, investor: w.buyer.investor,
      adjusted_price: adj.adjusted_price, adjustments: adj.adjustments, status: 'candidate', reasons: [] };
  }

  const investorSet = usable.filter((c) => c.investor);
  const invOut = rejectOutliers(investorSet, params);
  const invSurvivors = investorSet.filter((c) => c.status !== 'excluded');
  const invNeffPre = (() => { const W = invSurvivors.reduce((s, c) => s + c.weight, 0); return W ? W ** 2 / invSurvivors.reduce((s, c) => s + c.weight ** 2, 0) : 0; })();

  let method;
  let est;
  let outlier;
  let ratio = null;
  if (invSurvivors.length >= params.minInvestorComps && invNeffPre >= params.minInvestorNeff) {
    method = 'investor_comps';
    outlier = invOut;
    est = estimateFrom(invSurvivors, params);
    for (const c of usable) if (!c.investor) { c.status = 'context_only'; c.reasons = ['v3_not_investor_buyer_context_only']; }
  } else {
    method = 'market_ratio_fallback';
    for (const c of investorSet) if (c.status === 'excluded') { c.status = 'candidate'; c.reasons = []; }
    outlier = rejectOutliers(usable, params);
    const survivors = usable.filter((c) => c.status !== 'excluded');
    est = estimateFrom(survivors, params);
    ratio = localInvestorRatio(usable, params);
    if (est) est.mid *= ratio.ratio;
  }
  // Dominant-comp guard: no outlier ever drives the offer. If the heaviest comp
  // sits > 25% away from the value of the rest, it is removed and re-estimated.
  let dominant = null;
  if (est) {
    const pool = usable.filter((c) => c.status === 'candidate' && c.share != null);
    const top = [...pool].sort((a, b) => b.share - a.share)[0];
    const rest = pool.filter((c) => c !== top);
    if (top && rest.length >= 2) {
      const W = rest.reduce((s, c) => s + c.weight, 0);
      const restMid = Math.exp(rest.reduce((s, c) => s + c.weight * Math.log(c.adjusted_price), 0) / W);
      if (Math.abs(Math.log(top.adjusted_price / restMid)) > params.dominantOutlierLog && top.share >= 0.2) {
        top.status = 'excluded'; top.reasons = [V3_REASONS.dominantOutlier];
        dominant = { comp_id: top.comp_id, share: top.share, adjusted_price: roundMoney(top.adjusted_price), rest_value: roundMoney(restMid) };
        for (const c of pool) if (c !== top) { c.weight = c.weight_uncapped ?? c.weight; delete c.share; }
        const ratioMul = method === 'investor_comps' ? 1 : ratio.ratio;
        est = estimateFrom(rest, params);
        if (est) est.mid *= ratioMul;
      }
    }
  }
  for (const c of usable) if (c.status === 'candidate') c.status = 'selected';

  const confidence = confidenceOf(est, method);
  const mid = est ? est.mid : null;
  const spread = est ? clamp(est.sd_log, 0.06, 0.3) : null;
  const value = {
    version: params.version, method, mid: roundMoney(mid),
    low: mid ? roundMoney(mid * Math.exp(-spread)) : null, high: mid ? roundMoney(mid * Math.exp(spread)) : null,
    confidence, basis: 'as_is_off_market_investor_purchase_price',
    selected: est?.n ?? 0, n_eff: round(est?.n_eff ?? 0, 2), dispersion_log: round(est?.sd_log ?? null, 4),
    weighted_distance_miles: round(est?.weighted_distance ?? null, 2), same_tract_share: round(est?.same_tract_share ?? null, 3),
    same_subdivision_share: round(est?.same_subdivision_share ?? null, 3), investor_candidates: investorSet.length,
    investor_ratio: ratio, outlier_rule: outlier, dominant_comp_removed: dominant, lane: params.lane,
    radius_miles: params.radiusMiles, distance_half_life_miles: wp.distanceHalfLifeMiles, adaptive_bandwidth: bandwidth,
  };
  if (params.lane !== 'sfr' && est) {
    const units = pos(subject.units);
    const sel = usable.filter((c) => c.status === 'selected');
    // Anchoring band: the per-door mid x exp(-/+ max(dispersion, 0.15)). Backtest
    // coverage of the actual per-door price: 5+ units 15/30, 2-4 units 12/38.
    const band = Math.max(est.sd_log ?? 0, params.perDoorBandMinLog);
    value.per_door = {
      mid: roundMoney(est.mid), low: roundThousand(est.mid * Math.exp(-band)), high: roundThousand(est.mid * Math.exp(band)), units,
      basis: 'per_door_mid_x_exp_pm_max_dispersion_0_15', selected_doors_q25: roundThousand(weightedQuantile(sel, 'adjusted_price', 0.25)),
      selected_doors_q75: roundThousand(weightedQuantile(sel, 'adjusted_price', 0.75)),
    };
    value.per_door.label = `$${Math.round(value.per_door.low / 1000)}-${Math.round(value.per_door.high / 1000)}K/door x ${units} doors`;
    value.mid = roundMoney(est.mid * units);
    value.low = roundMoney(est.mid * units * Math.exp(-spread));
    value.high = roundMoney(est.mid * units * Math.exp(spread));
  }
  const retail = retailContext(usable, params, subject);
  const comps = [...usable.map((c) => explainComp(c)), ...ledger];
  return { value, retail_context: retail, offer: computeOfferV3({ value, subject, retail }, offerParams), comps,
    census: { rows: rows.length, usable: usable.length, investor: investorSet.length, excluded: ledger.length } };
}

/** Local investor / all-sales $/sqft ratio (weighted medians) for the fallback. */
export function localInvestorRatio(usable, params = V3) {
  const mf = params.lane !== 'sfr';
  const ok = (c) => (mf ? pos(c.units) > 0 : num(c.sqft) > 0) && num(c.price) > 0;
  const pt = (c) => ({ weight: c.factors.distance * c.factors.recency + 1e-9, v: mf ? c.price / c.units : c.price / c.sqft });
  const inv = usable.filter((c) => c.investor && ok(c)).map(pt);
  const all = usable.filter(ok).map(pt);
  if (inv.length >= params.fallbackMinInvestor && all.length >= params.fallbackMinAll) {
    const r = weightedQuantile(inv, 'v', 0.5) / weightedQuantile(all, 'v', 0.5);
    return { ratio: round(clamp(r, 0.6, 1), 3), basis: 'local_investor_to_all_ppsf', investor_n: inv.length, all_n: all.length };
  }
  return { ratio: params.defaultInvestorRatio, basis: 'default_insufficient_local_investor_sales', investor_n: inv.length, all_n: all.length };
}

/** Retail (MLS) as-sold context for the fair-market guard: never above market. */
function retailContext(usable, params = V3, subject = {}) {
  const r = usable.filter((c) => c.source === 'mls').map((c) => ({ weight: c.factors.distance * c.factors.recency * c.factors.similarity, adjusted_price: c.adjusted_price }));
  if (r.length < 3) return { mid: null, n: r.length };
  const m = weightedQuantile(r, 'adjusted_price', 0.5);
  return { mid: roundMoney(params.lane === 'sfr' ? m : m * (pos(subject.units) ?? 0)), n: r.length };
}

function explainComp(c) {
  return {
    comp_id: c.comp_id, property_id: c.property_id, address: c.address, sold_on: day(c.sold_on), price: num(c.price), source: c.source,
    distance_miles: c.distance_miles, sqft: num(c.sqft), beds: num(c.beds), baths: num(c.baths), year_built: num(c.year_built),
    subdivision: c.subdivision_name ?? null, census_tract: c.census_tract ?? null, doc_type: c.doc_type ?? null,
    buyer_type: c.factors.buyer_type, buyer_evidence: c.buyer_evidence, adjusted_price: roundMoney(c.adjusted_price), adjustments: c.adjustments,
    weight: round(c.weight, 6), share: c.share ?? null, factors: c.factors, status: c.status, reasons: c.status === 'selected' ? ['v3_selected'] : c.reasons,
  };
}
function explainRow(r, status, reasons) {
  return { comp_id: r.comp_id, property_id: r.property_id, sold_on: day(r.sold_on), price: num(r.price), source: r.source,
    distance_miles: r.distance_miles, doc_type: r.doc_type ?? null, buyer_class: r.buyer_class ?? null, status, reasons };
}

// ── offer ─────────────────────────────────────────────────────────────────────
/**
 * PROPOSED v3 offer parameters (owner approval required). The value is the
 * as-is investor purchase price, so it IS the buyer ceiling (less a
 * confidence haircut). Repairs are never subtracted again.
 */
export const V3_OFFER = Object.freeze({
  version: 'investor-offer-v3.1-proposed',
  haircutByConfidence: Object.freeze([[70, 0], [50, 0.03], [0, 0.06]]),
  fallbackExtraHaircut: 0.03,
  // Backtest calibration (post-2026-05-08 recorded off-market investor purchases):
  // the v3 value's median bias vs the actual price was SFR +8.9%, 2-4 units
  // +15.3%, 5+ units +11.5%. The ceiling removes it before the fee.
  calibrationByLane: Object.freeze({ sfr: 0.08, mf24: 0.15, mf5: 0.12 }),
  // Assignment fee = the existing margin-policy bands (assignmentMarginPolicy):
  // SFR 10% (+2% under a $150K ceiling), 2-4 units 11%, 5+ units 6%; $15K floor.
  feePct: 0.1,
  feePctSmallDeal: 0.12,
  feePctByLane: Object.freeze({ mf24: 0.11, mf5: 0.06 }),
  smallDealCeiling: 150_000,
  feeFloor: 15_000,
  feeCap: 40_000,
  feeCapByLane: Object.freeze({ mf24: 60_000, mf5: Infinity }),
  negotiationBandPct: 0.03,
  negotiationBandMin: 5_000,
  minOfferToValue: 0.35,
  maxOfferToValue: 0.9,
});

/**
 * The value is the as-is investor purchase price, so it IS the buyer ceiling
 * (less a confidence haircut). Repairs are never subtracted again. MLS is
 * secondary evidence: an investor value above the retail as-sold context is a
 * REVIEW flag, not a price input.
 */
/**
 * The record's repair figure is an import formula ($15 / $35 / $75 per sqft by
 * rehab tier), not an inspection. It is LOW confidence unless a real condition
 * is recorded, and it is never subtracted from an as-is value.
 */
export function repairEvidence(subject = {}) {
  const rate = repairRate(subject.estimated_repairs, subject.sqft);
  const formula = rate !== null && [15, 35, 75].includes(rate);
  const cond = text(subject.condition).toLowerCase();
  const known = cond && !['unknown', 'average', ''].includes(cond);
  return {
    amount: num(subject.estimated_repairs), rate_per_sqft: rate,
    source: formula ? 'import_flat_rate_per_sqft' : rate === null ? 'none' : 'record_estimate',
    confidence: formula && !known ? 'low' : rate === null ? 'none' : 'medium',
    used_as: 'condition_tier_difference_only',
  };
}

export function computeOfferV3({ value, subject = {}, retail = null }, p = V3_OFFER) {
  const mid = num(value?.mid);
  if (!mid) return { recommended_cash_offer: null, buyer_ceiling: null, reasons: ['no_value'], params_version: p.version };
  const lane = value.lane ?? 'sfr';
  const conf = num(value.confidence) ?? 0;
  let haircut = p.haircutByConfidence.find(([min]) => conf >= min)[1];
  if (value.method !== 'investor_comps') haircut += p.fallbackExtraHaircut;
  const reasons = [];
  const calibration = p.calibrationByLane?.[lane] ?? 0;
  const ceiling = mid * (1 - calibration) * (1 - haircut);
  const retailMid = num(retail?.mid);
  if (retailMid && ceiling > retailMid) reasons.push('investor_ceiling_above_retail_context_review');
  const pct = lane === 'sfr' ? (ceiling < p.smallDealCeiling ? p.feePctSmallDeal : p.feePct) : p.feePctByLane[lane];
  const cap = lane === 'sfr' ? p.feeCap : p.feeCapByLane[lane];
  const fee = clamp(ceiling * pct, p.feeFloor, cap);
  const offer = Math.max(0, ceiling - fee);
  const band = Math.max(p.negotiationBandMin, mid * p.negotiationBandPct);
  const repairs = num(subject.estimated_repairs);
  const sanity = {
    offer_to_value: round(offer / mid, 3),
    within_bounds: offer / mid >= p.minOfferToValue && offer / mid <= p.maxOfferToValue,
    repairs_to_value: repairs !== null ? round(repairs / mid, 3) : null,
  };
  if (!sanity.within_bounds) reasons.push('offer_outside_sanity_bounds_review');
  const out = {
    params_version: p.version,
    lane,
    buyer_ceiling: roundMoney(ceiling), // the MAO: what the end investor pays as-is
    assignment_fee_target: roundMoney(fee),
    recommended_cash_offer: roundMoney(offer),
    minimum_acceptable_offer: roundMoney(Math.max(0, offer - band)),
    confidence_haircut_pct: round(haircut * 100, 1),
    calibration_pct: round(calibration * 100, 1),
    repairs_basis: 'embedded_in_as_is_investor_comps_not_subtracted_again',
    repairs_evidence: repairEvidence(subject),
    sanity, reasons,
  };
  const units = num(value.per_door?.units);
  if (lane !== 'sfr' && units) {
    out.per_door = { offer: roundMoney(offer / units), ceiling: roundMoney(ceiling / units), value_range: value.per_door.label };
  }
  return out;
}

// ── read-only SQL ────────────────────────────────────────────────────────────
/**
 * Candidate sales in the bbox with the comp's geography, condition and the
 * owner-of-record signals for the inferred-investor link (mi_owner_link@1):
 * latest sale of the parcel, no later recorded sale > 45 days after, owner
 * snapshot observed >= 30 days after the sale.
 * $1 lat, $2 lng, $3 radius mi, $4 since (incl), $5 as-of (excl), $6 cap.
 */
export const CANDIDATE_ROWS_SQL = `
select m.comp_id, m.source, m.sold_on::text sold_on, m.price::float8 price, m.lat, m.lng, m.property_id, m.address, m.city, m.state, m.zip,
  m.property_type, m.beds::float8 beds, m.baths::float8 baths, m.sqft::float8 sqft, m.year_built, m.units::float8 units,
  m.portfolio_size, m.buyer_class, m.is_investor, m.buyer_kind, m.doc_type, m.is_cash_purchase, m.is_arms_length, m.price_source,
  m.estimated_value::float8 estimated_value,
  cp.subdivision_name, cp.census_tract, cp.fips, cp.estimated_repair_cost::float8 estimated_repair_cost, cp.condition_code,
  cp.lot_sqft::float8 lot_sqft,
  (m.buyer is null and m.buyer_kind is null
    and not exists (select 1 from public.mv_map_market_sales m2 where m2.property_id = m.property_id and m2.sold_on > m.sold_on + 45)
    and cp.last_observed_at::date >= m.sold_on + 30) as owner_linked,
  cp.is_corporate_owner as owner_corporate, cp.is_trust as owner_trust, cp.out_of_state_owner as owner_out_of_state,
  case when cp.owner_mailing_identity_key_v1 is null or cp.is_corporate_owner is true then null
       else (select count(*) from (select 1 from comp_private.comp_properties c2 where c2.owner_mailing_identity_key_v1 = cp.owner_mailing_identity_key_v1 limit 5) s)::int end as owner_mail_stack
from public.mv_map_market_sales m
left join comp_private.comp_properties cp on cp.property_id = m.property_id
where m.sold_on >= $4::date and m.sold_on < $5::date and m.price > 0
  and m.lat between $1::float8 - $3::float8 / 68.5 and $1::float8 + $3::float8 / 68.5
  and m.lng between $2::float8 - $3::float8 / (68.5 * greatest(cos(radians($1::float8)), 0.05))
              and $2::float8 + $3::float8 / (68.5 * greatest(cos(radians($1::float8)), 0.05))
  and coalesce(m.property_type, 'Single Family') in ('Single Family', 'SFR', 'Townhouse')
order by m.sold_on desc
limit $6`;

/** The same read for the multifamily lanes (recorded MF types or a real count >= 2). */
export const CANDIDATE_ROWS_MF_SQL = CANDIDATE_ROWS_SQL.replace(
  "and coalesce(m.property_type, 'Single Family') in ('Single Family', 'SFR', 'Townhouse')",
  "and (m.property_type in ('Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex') or m.units >= 2)",
);

/**
 * Subject geography: the 7 nearest parcels of the owner snapshot around the
 * subject point (public.properties ids are not comp_properties ids, and
 * properties.situs_census_tract is ~32% filled). $1 lat, $2 lng.
 */
export const SUBJECT_GEO_SQL = `
select cp.fips, cp.county_name, cp.census_tract, cp.subdivision_name,
  (3958.8 * 2 * asin(sqrt(sin(radians(cp.latitude - $1::float8) / 2) ^ 2 + cos(radians($1::float8)) * cos(radians(cp.latitude)) * sin(radians(cp.longitude - $2::float8) / 2) ^ 2)))::float8 as miles
from comp_private.comp_properties cp
where cp.latitude between $1::float8 - 0.003 and $1::float8 + 0.003 and cp.longitude between $2::float8 - 0.0036 and $2::float8 + 0.0036
order by miles asc limit 7`;

/**
 * Pure: the subject's { fips, census_tract, subdivision_name } from its own
 * record first (tract left-padded to the 6-digit code), else the nearest
 * parcel within 0.01 mi (the same building), else the majority of the
 * nearest parcels within 0.2 mi. Basis recorded.
 */
export function resolveSubjectGeography({ own = {}, neighbors = [] } = {}) {
  const near = neighbors.filter((n) => num(n.miles) !== null && num(n.miles) <= 0.2);
  const countyName = text(own.county_name).toLowerCase();
  const fipsFromCounty = near.find((n) => text(n.county_name).toLowerCase() === countyName && text(n.fips))?.fips ?? null;
  const ownTract = text(own.census_tract) ? text(own.census_tract).replace(/\D/g, '').padStart(6, '0') : null;
  const majority = (key) => {
    const counts = new Map();
    for (const n of near) if (text(n[key])) counts.set(`${text(n.fips)}|${text(n[key])}`, (counts.get(`${text(n.fips)}|${text(n[key])}`) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? { fips: best[0].split('|')[0], value: best[0].split('|').slice(1).join('|') } : null;
  };
  const same = near.find((n) => num(n.miles) <= 0.01) ?? null;
  let fips = fipsFromCounty ?? same?.fips ?? majority('census_tract')?.fips ?? null;
  let census_tract = ownTract;
  let tractBasis = ownTract ? 'subject_record' : null;
  if (!census_tract && same?.census_tract) { census_tract = same.census_tract; fips = same.fips; tractBasis = 'same_point_parcel'; }
  if (!census_tract) { const m = majority('census_tract'); if (m) { census_tract = m.value; fips = m.fips; tractBasis = 'nearest_parcels_majority'; } }
  let subdivision_name = text(own.subdivision_name) || null;
  let subdivisionBasis = subdivision_name ? 'subject_record' : null;
  if (!subdivision_name && same?.subdivision_name) { subdivision_name = same.subdivision_name; subdivisionBasis = 'same_point_parcel'; }
  return { fips, census_tract, subdivision_name, basis: { tract: tractBasis, subdivision: subdivisionBasis } };
}

export default { V3, V3_MF24, V3_MF5, laneFor, V3_OFFER, V3_REASONS, valueSubjectV3, computeOfferV3, normalizeSubdivision, classifyCompBuyer, qualifyRow, compWeight, adjustCompPrice, rejectOutliers, flipResaleIds, bulkIndex };
