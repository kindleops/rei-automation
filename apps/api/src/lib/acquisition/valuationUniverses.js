/**
 * Acquisition Engine V3 — separate valuation universes (mission Item 4 §2-§5).
 *
 * Each universe is computed INDEPENDENTLY from qualified, de-duplicated,
 * package-free transactions. Package/duplicate/implausible comps were already
 * removed by qualifyComps, so nothing here can be contaminated by a broadcast
 * consideration. Universes:
 *   LOCAL_INVESTOR_VALUE, INSTITUTIONAL_VALUE, RETAIL_MLS_VALUE,
 *   PUBLIC_RECORD_ARM_LENGTH_VALUE, INCOME_VALUE, LIQUIDATION_VALUE,
 *   SUBJECT_ANCHOR_SCENARIO.
 *
 * SUBJECT_ANCHOR_SCENARIO is always labeled VALUE_CLASSIFICATION.SUBJECT_ANCHOR_SCENARIO
 * and never presented as transaction-supported market value.
 */

import {
  VALUATION_UNIVERSES as U,
  VALUE_CLASSIFICATION as VC,
  ASSET_FAMILIES,
  LANE_FAMILY,
  TX_CHANNELS,
  DEFAULT_CAP_RATE,
  LIQUIDATION_FACTOR,
  num,
  lower,
  clean,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import { compReliability, universeConfidence } from './sourceReliability.js';
import { classifyPeerOutliers, peerStatusExcludesPricing, peerStatusReviewOnly } from './peerRelativeOutliers.js';
import {
  weightedQuantile,
  weightedMean,
  stddev,
  recencyScore,
  monthsBetween,
} from './acquisitionMath.js';

/** Configurable institutional buyer registry (seedable from buyer_entities_v2). */
export const INSTITUTIONAL_BUYER_PATTERNS = [
  /amherst/, /invitation homes/, /tricon/, /home partners/, /divvy/,
  /progress residential/, /american homes 4 rent|ah4r/, /firstkey/, /vinebrook/,
  /pretium/, /sfr3/, /roofstock/, /mynd/, /front yard/, /cerberus/, /blackstone/,
];

const ENTITY_RE = /\b(llc|inc|corp|company|co|lp|llp|ltd|trust|holdings|properties|capital|group|partners|investments|homes|reit|fund)\b/;

function haversineMiles(lat1, lng1, lat2, lng2) {
  const a = num(lat1); const b = num(lng1); const c = num(lat2); const d = num(lng2);
  if ([a, b, c, d].some((v) => v === null)) return null;
  const R = 3958.8;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function buyerArchetype(raw) {
  const name = lower(raw.buyer_name_clean ?? raw.buyer_name ?? raw.buyer_key ?? '');
  if (name && INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(name))) return 'INSTITUTIONAL';
  if (name && ENTITY_RE.test(name)) return 'INVESTOR';
  const bt = lower(raw.buyer_type ?? '');
  if (/institution|hedge|reit|private equity/.test(bt)) return 'INSTITUTIONAL';
  if (/investor|llc|corporate/.test(bt) || raw.is_corporate_buyer === true) return 'INVESTOR';
  return 'UNKNOWN';
}

/** Classify the transaction channel + the universe it feeds. */
export function classifyChannel(raw) {
  // Prefer the deterministic channel/universe resolved by the V3 comp loader
  // (identity-aware). Falls back to inline heuristics for non-enriched rows.
  if (raw.v3_universe_hint) {
    return { channel: raw.v3_channel ?? raw.transaction_channel ?? 'UNKNOWN', universe: raw.v3_universe_hint };
  }
  const docType = lower(raw.document_type ?? raw.last_sale_doc_type ?? '');
  const priceSrc = lower(raw.sale_price_source ?? raw.purchase_price_source ?? '');
  const hasMls = num(raw.mls_sold_price) > 0 || /mls|listing|realtor/.test(priceSrc);

  if (raw.auction_date || /auction/.test(docType)) {
    return { channel: TX_CHANNELS.AUCTION, universe: U.LIQUIDATION_VALUE };
  }
  if (/foreclos|reo|trustee|sheriff/.test(docType)) {
    return { channel: TX_CHANNELS.FORECLOSURE, universe: U.LIQUIDATION_VALUE };
  }
  if (/tax (deed|sale|lien)/.test(docType)) {
    return { channel: TX_CHANNELS.TAX_SALE, universe: U.LIQUIDATION_VALUE };
  }
  if (hasMls) {
    return { channel: TX_CHANNELS.MLS_ARM_LENGTH, universe: U.RETAIL_MLS_VALUE };
  }
  const archetype = buyerArchetype(raw);
  if (archetype === 'INSTITUTIONAL') {
    return { channel: TX_CHANNELS.INSTITUTIONAL_SINGLE_ASSET, universe: U.INSTITUTIONAL_VALUE };
  }
  if (archetype === 'INVESTOR') {
    return { channel: TX_CHANNELS.INVESTOR_OFF_MARKET, universe: U.LOCAL_INVESTOR_VALUE };
  }
  return { channel: TX_CHANNELS.PUBLIC_RECORD_UNVERIFIED, universe: U.PUBLIC_RECORD_ARM_LENGTH_VALUE };
}

function physicalSimilarity(subjectRow, raw, family) {
  const ssqft = num(subjectRow.building_square_feet) ?? num(subjectRow.sqft);
  const csqft = num(raw.building_square_feet) ?? num(raw.sqft);
  let sim = 100;
  if (ssqft && csqft) sim -= clamp(Math.abs(1 - csqft / ssqft) * 120, 0, 40);
  else sim -= 12;
  const sb = num(subjectRow.total_bedrooms) ?? num(subjectRow.beds);
  const cb = num(raw.total_bedrooms) ?? num(raw.beds);
  if (sb && cb) sim -= clamp(Math.abs(sb - cb) * 8, 0, 16);
  else sim -= 4;
  const sy = num(subjectRow.effective_year_built) ?? num(subjectRow.year_built);
  const cy = num(raw.effective_year_built) ?? num(raw.year_built);
  if (sy && cy) sim -= clamp(Math.abs(sy - cy) / 2, 0, 15);
  else sim -= 5;
  if (family === ASSET_FAMILIES.SMALL_MULTI || family === ASSET_FAMILIES.MULTIFAMILY) {
    const su = num(subjectRow.units_count);
    const cu = num(raw.units_count);
    if (su && cu) sim -= clamp(Math.abs(su - cu) * 10, 0, 25);
    else sim -= 8;
  }
  return clamp(sim, 0, 100);
}

function geographicSimilarity(subjectRow, raw) {
  const dist = haversineMiles(subjectRow.latitude, subjectRow.longitude, raw.latitude, raw.longitude);
  if (dist !== null) return { score: clamp(100 - dist * 12, 25, 100), distance_miles: round(dist, 2) };
  const szip = clean(subjectRow.property_address_zip ?? subjectRow.property_zip ?? subjectRow.zip);
  const czip = clean(raw.property_address_zip ?? raw.property_zip ?? raw.zip);
  const scity = lower(subjectRow.property_address_city ?? subjectRow.property_city);
  const ccity = lower(raw.property_address_city ?? raw.property_city);
  if (szip && czip && szip === czip) return { score: 85, distance_miles: null };
  if (scity && ccity && scity === ccity) return { score: 60, distance_miles: null };
  return { score: 45, distance_miles: null };
}

function adjustedValue(subjectRow, raw, consideration, family) {
  const ssqft = num(subjectRow.building_square_feet) ?? num(subjectRow.sqft);
  const csqft = num(raw.building_square_feet) ?? num(raw.sqft);
  const su = num(subjectRow.units_count);
  const cu = num(raw.units_count);
  const candidates = [];
  if (csqft && ssqft) candidates.push(consideration * (ssqft / csqft));
  if ((family === ASSET_FAMILIES.SMALL_MULTI || family === ASSET_FAMILIES.MULTIFAMILY) && cu && su) {
    candidates.push(consideration * (su / cu));
  }
  if (!candidates.length) candidates.push(consideration);
  const blended = candidates.reduce((s, v) => s + v, 0) / candidates.length;
  // Never let sqft/unit scaling distort more than ±60% of the actual price.
  return clamp(blended, consideration * 0.6, consideration * 1.6);
}

function spreadForConfidence(confidence) {
  return 0.05 + ((100 - clamp(confidence, 0, 100)) / 100) * 0.1;
}

function buildUniverse(universeName, comps, { targetSample = 6 } = {}) {
  if (!comps.length) {
    return {
      universe: universeName,
      available: false,
      unavailable_reason: 'no_qualified_transactions_in_universe',
      value_classification: null,
      low: null, mid: null, high: null,
      effective_sample_size: 0,
      accepted_independent_transaction_count: 0,
      confidence: 0,
      comps: [],
    };
  }
  // ---- Peer-relative outlier filtering within this universe (comp-quality) ----
  const peerMap = classifyPeerOutliers(comps.map((c, i) => ({ key: String(i), value: c.adjusted_value, ppsf: c.ppsf })));
  const peerExcluded = [];
  const peerReviewOnly = [];
  const kept = [];
  comps.forEach((c, i) => {
    const k = peerMap.get(String(i));
    c.peer_status = k?.status ?? null;
    c.peer_metrics = k?.metrics ?? null;
    const rec = { address: c.address, consideration: c.consideration, adjusted_value: roundMoney(c.adjusted_value), status: k?.status ?? null, reasons: k?.reasons ?? [] };
    if (k && peerStatusExcludesPricing(k.status)) { peerExcluded.push(rec); return; }
    if (k && peerStatusReviewOnly(k.status)) { peerReviewOnly.push(rec); return; }
    kept.push(c);
  });
  if (!kept.length) {
    return {
      universe: universeName, available: false, unavailable_reason: 'all_comps_rejected_as_peer_outliers',
      value_classification: null, low: null, mid: null, high: null,
      effective_sample_size: 0, accepted_independent_transaction_count: 0, confidence: 0, comps: [],
      peer_excluded: peerExcluded, peer_review_only: peerReviewOnly,
    };
  }
  comps = kept;

  const rows = comps.map((c) => ({ value: c.adjusted_value, weight: c.weight }));
  const mid = weightedQuantile(rows, 0.5);
  const p25 = weightedQuantile(rows, 0.25);
  const p75 = weightedQuantile(rows, 0.75);
  const wmean = weightedMean(rows);
  const values = comps.map((c) => c.adjusted_value);
  const dispersion = mid ? stddev(values) / mid : 1;
  const ess = comps.length;
  const avgQual = weightedMean(comps.map((c) => ({ value: c.qualification_score, weight: c.weight }))) ?? 0;
  const avgPhysical = weightedMean(comps.map((c) => ({ value: c.physical_match, weight: c.weight }))) ?? 0;
  const avgGeo = weightedMean(comps.map((c) => ({ value: c.geographic_match, weight: c.weight }))) ?? 0;
  const avgRecency = weightedMean(comps.map((c) => ({ value: c.recency, weight: c.weight }))) ?? 50;
  const conf = universeConfidence({
    effective_sample_size: ess,
    target_sample: targetSample,
    dispersion,
    avg_qualification: avgQual,
    avg_physical: avgPhysical,
    avg_geographic: avgGeo,
    avg_recency: avgRecency,
  });
  const spread = spreadForConfidence(conf.confidence);
  const low = Math.min(p25 ?? mid, mid * (1 - spread));
  const high = Math.max(p75 ?? mid, mid * (1 + spread));

  return {
    universe: universeName,
    available: true,
    unavailable_reason: null,
    value_classification: VC.QUALIFIED,
    low: roundMoney(low),
    mid: roundMoney(mid),
    high: roundMoney(high),
    weighted_median: roundMoney(mid),
    weighted_mean: roundMoney(wmean),
    p25: roundMoney(p25),
    p75: roundMoney(p75),
    raw_row_count: comps.length,
    transaction_cluster_count: comps.length,
    accepted_independent_transaction_count: comps.length,
    effective_sample_size: ess,
    avg_qualification_score: round(avgQual, 1),
    avg_similarity: round(avgPhysical, 1),
    geographic_score: round(avgGeo, 1),
    recency_score: round(avgRecency, 1),
    dispersion: round(dispersion, 4),
    confidence: conf.confidence,
    confidence_components: conf.components,
    source_lineage: [...new Set(comps.map((c) => c.channel))],
    peer_excluded: peerExcluded,
    peer_review_only: peerReviewOnly,
    comps: comps.slice(0, 25).map((c) => ({
      address: c.address,
      consideration: c.consideration,
      adjusted_value: roundMoney(c.adjusted_value),
      channel: c.channel,
      evidence_role: c.evidence_role ?? null,
      qualification_score: c.qualification_score,
      physical_match: round(c.physical_match, 1),
      geographic_match: round(c.geographic_match, 1),
      recency: round(c.recency, 1),
      peer_status: c.peer_status ?? null,
      weight: c.weight,
    })),
  };
}

function subjectAnchorScenario(anchors) {
  if (!anchors.has_anchor) {
    return {
      universe: U.SUBJECT_ANCHOR_SCENARIO,
      available: false,
      unavailable_reason: 'no_subject_anchor',
      value_classification: VC.SUBJECT_ANCHOR_SCENARIO,
      low: null, mid: null, high: null, confidence: 0, effective_sample_size: 0,
    };
  }
  const mid = anchors.anchor_mid;
  return {
    universe: U.SUBJECT_ANCHOR_SCENARIO,
    available: true,
    unavailable_reason: null,
    value_classification: VC.SUBJECT_ANCHOR_SCENARIO,
    note: 'AVM/assessed/listing only — NOT transaction-supported market value.',
    low: roundMoney(mid * 0.85),
    mid: roundMoney(mid),
    high: roundMoney(mid * 1.1),
    confidence: 25,
    effective_sample_size: 0,
    accepted_independent_transaction_count: 0,
    source_lineage: anchors.anchor_sources,
  };
}

function incomeUniverse(subjectRow, family, anchors) {
  const monthlyRent = num(subjectRow.monthly_rent) ?? num(subjectRow.rent_estimate);
  const noiKnown = num(subjectRow.noi_estimate);
  const capKnown = num(subjectRow.cap_rate);
  if (!monthlyRent && !noiKnown) {
    return {
      universe: U.INCOME_VALUE,
      available: false,
      unavailable_reason: 'no_rent_or_noi_inputs',
      value_classification: null,
      low: null, mid: null, high: null, confidence: 0, effective_sample_size: 0,
    };
  }
  const cap =
    capKnown && capKnown > 0.02 && capKnown < 0.2
      ? capKnown
      : DEFAULT_CAP_RATE[family] ?? DEFAULT_CAP_RATE.UNKNOWN;
  const noi = noiKnown ?? monthlyRent * 12 * 0.55; // EGI - ~45% opex (labeled)
  const value = noi / cap;
  const isCorroborationOnly =
    family === ASSET_FAMILIES.RESIDENTIAL_SINGLE || family === ASSET_FAMILIES.SMALL_MULTI;
  return {
    universe: U.INCOME_VALUE,
    available: true,
    unavailable_reason: null,
    value_classification: noiKnown && capKnown ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO,
    low: roundMoney(value * 0.9),
    mid: roundMoney(value),
    high: roundMoney(value * 1.1),
    cap_rate_used: cap,
    noi_used: roundMoney(noi),
    assumptions: [
      noiKnown ? 'noi=subject_noi_estimate' : 'noi=rent*12*0.55_opex_assumption',
      capKnown ? 'cap=subject_cap_rate' : `cap=default_${family}`,
    ],
    corroboration_only: isCorroborationOnly,
    confidence: noiKnown && capKnown ? 60 : 35,
    effective_sample_size: noiKnown ? 1 : 0,
    accepted_independent_transaction_count: 0,
  };
}

/** @returns {{ universes: Record<string, object>, family: string }} */
export function buildValuationUniverses(subjectRow = {}, qualification, buyerPurchases = [], now = new Date()) {
  const subjectLane = qualification?.anchors?.lane ?? classifyAssetLane(subjectRow).lane;
  const family = LANE_FAMILY[subjectLane] ?? ASSET_FAMILIES.UNKNOWN;
  const accepted = qualification?.accepted ?? [];

  // Enrich each accepted comp with channel/value/similarity/weight.
  const enriched = accepted
    .filter((a) => a.raw && num(a.consideration) !== null)
    .map((a) => {
      const raw = a.raw;
      const { channel, universe } = classifyChannel(raw);
      const consideration = num(a.consideration);
      const physical = physicalSimilarity(subjectRow, raw, family);
      const geo = geographicSimilarity(subjectRow, raw);
      const months = monthsBetween(raw.sale_date ?? raw.purchase_date ?? raw.mls_sold_date, now);
      const recency = recencyScore(months);
      const rel = compReliability({
        qualification_score: a.score,
        independence_score: 100, // already de-packaged/de-duped at qualification
        asset_match: a.comp_lane === subjectLane ? 1 : 0.6,
        physical_match: physical,
        geographic_match: geo.score,
        recency,
        completeness: physical, // physical completeness proxy
      });
      const csqft = num(raw.building_square_feet) ?? num(raw.sqft);
      return {
        address: a.address,
        consideration,
        channel,
        evidence_role: raw.evidence_role ?? null,
        universe,
        adjusted_value: adjustedValue(subjectRow, raw, consideration, family),
        ppsf: csqft && csqft > 0 && consideration ? consideration / csqft : null,
        physical_match: physical,
        geographic_match: geo.score,
        distance_miles: geo.distance_miles,
        recency,
        qualification_score: a.score,
        weight: rel.weight,
        reliability_factors: rel.factors,
      };
    });

  const byUniverse = (name) => enriched.filter((e) => e.universe === name);

  const universes = {
    [U.LOCAL_INVESTOR_VALUE]: buildUniverse(U.LOCAL_INVESTOR_VALUE, byUniverse(U.LOCAL_INVESTOR_VALUE)),
    [U.INSTITUTIONAL_VALUE]: buildUniverse(U.INSTITUTIONAL_VALUE, byUniverse(U.INSTITUTIONAL_VALUE)),
    [U.RETAIL_MLS_VALUE]: buildUniverse(U.RETAIL_MLS_VALUE, byUniverse(U.RETAIL_MLS_VALUE)),
    [U.PUBLIC_RECORD_ARM_LENGTH_VALUE]: buildUniverse(
      U.PUBLIC_RECORD_ARM_LENGTH_VALUE,
      byUniverse(U.PUBLIC_RECORD_ARM_LENGTH_VALUE),
    ),
    [U.INCOME_VALUE]: incomeUniverse(subjectRow, family, qualification?.anchors ?? {}),
    [U.SUBJECT_ANCHOR_SCENARIO]: subjectAnchorScenario(qualification?.anchors ?? {}),
  };

  // LIQUIDATION_VALUE — derived from the strongest available market universe.
  const liquidationBase =
    universes[U.LOCAL_INVESTOR_VALUE].mid ??
    universes[U.PUBLIC_RECORD_ARM_LENGTH_VALUE].mid ??
    universes[U.INSTITUTIONAL_VALUE].mid ??
    universes[U.RETAIL_MLS_VALUE].mid;
  const distressedComps = enriched.filter((e) => e.universe === U.LIQUIDATION_VALUE);
  if (distressedComps.length) {
    universes[U.LIQUIDATION_VALUE] = buildUniverse(U.LIQUIDATION_VALUE, distressedComps);
  } else if (liquidationBase) {
    universes[U.LIQUIDATION_VALUE] = {
      universe: U.LIQUIDATION_VALUE,
      available: true,
      unavailable_reason: null,
      value_classification: VC.PROVISIONAL_SCENARIO,
      low: roundMoney(liquidationBase * LIQUIDATION_FACTOR * 0.9),
      mid: roundMoney(liquidationBase * LIQUIDATION_FACTOR),
      high: roundMoney(liquidationBase * LIQUIDATION_FACTOR * 1.05),
      derived_from: 'market_value_x_liquidation_factor',
      liquidation_factor: LIQUIDATION_FACTOR,
      confidence: 30,
      effective_sample_size: 0,
      accepted_independent_transaction_count: 0,
    };
  } else {
    universes[U.LIQUIDATION_VALUE] = {
      universe: U.LIQUIDATION_VALUE,
      available: false,
      unavailable_reason: 'no_market_basis_for_liquidation',
      low: null, mid: null, high: null, confidence: 0, effective_sample_size: 0,
    };
  }

  return { universes, family, subject_lane: subjectLane };
}
