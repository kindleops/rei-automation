/**
 * IC8 comp micro-market CHALLENGER: comp selection + valuation (offline
 * research prototype; the production engine stays CHAMPION).
 *
 * Selection order (owner, 2026-10-01): asset eligibility first, then the
 * learned micro-market, then structural similarity, recency, and physical
 * distance.
 *   1. Hard gates: as-of, same property, sale validity, asset family,
 *      unit-count credibility, improved vs vacant, condo vs detached, size.
 *   2. Adaptive radius from local transaction density (urban tighter, rural
 *      broader).
 *   3. Micro-market tiers: same micro-market -> adjacent similar ->
 *      other micro-market without a learned barrier / unknown -> across a
 *      discontinuity (last resort, explicitly coded).
 *   4. Within a tier: structural similarity, then recency, then effective
 *      distance (lexicographic weights in rankScore).
 * Valuation:
 *   - time adjustment from the as-of market index, log-size elasticity
 *     (never linear scaling), shrunk micro-market location adjustment;
 *   - retail and investor regimes valued SEPARATELY, regime-unknown evidence
 *     valued separately and labelled; never silently blended;
 *   - value interval from the weighted dispersion of adjusted comps plus a
 *     bootstrap SE of the weighted median.
 * Every candidate in the search universe receives structured reason codes.
 * Pure and deterministic.
 */
import { haversineMiles, KM_PER_MILE } from './geo.js';
import { REASON, reason } from './reason-codes.js';
import { sameProperty, subtractMonths, daysBetween } from './comp-records.js';
import { bootstrapWeightedMedianSe, hashString, normInv, weightedMedian, weightedQuantile, round } from './stats.js';

export const CHALLENGER_VERSION = 'comp-micromarket-challenger-v0.1.0';

export const CHALLENGER_PARAMS = Object.freeze({
  maxRadiusMiles: 12,
  radiusLadderMiles: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12],
  densityTargetComps: 12,
  densityWindowMonths: 12,
  radiusExtension: 2,
  lookbackMonths: 24,
  sizeRatio: { sfr: [0.6, 1.6], mf_2_4: [0.5, 2.0] },
  unitRatio: [0.5, 2.0],
  maxComps: 10,
  minComps: 5,
  minValueComps: 3,
  tierWeight: { T1: 1, T2: 0.85, T3: 0.5, TU: 0.5, T4: 0.25 },
  outlierZ: 3,
  outlierMinScale: 0.1,
  sigmaFloor: 0.08,
  locationShrinkK: 10,
  similarMaxGap: 0.08,
  discontinuityMinGap: 0.15,
  bootstrapIterations: 200,
  intervals: [0.5, 0.8],
  // Pseudo-comp weight of the pooled micro-market level (cell -> micro-market
  // -> ZIP -> market) in the final log value; 0 = comps only.
  layerPriorK: 0,
});

const SUPPORTED_SUBJECT_FAMILIES = new Set(['sfr', 'mf_2_4']);

function ageMonthsExact(saleDate, asOf) {
  return Math.max(0, daysBetween(asOf, saleDate) / 30.4375);
}

/** Hard gates. Returns an array of reasons (empty = passes). */
export function gateComp(subject, comp, { asOf, lookbackStart, params = CHALLENGER_PARAMS }) {
  const out = [];
  if (!(comp.known_date < asOf)) out.push(reason(REASON.NOT_PRIOR_TO_AS_OF, { known_date: comp.known_date }));
  if (sameProperty(subject, comp) || comp.id === subject.id) out.push(reason(REASON.SAME_PROPERTY));
  if (comp.dedup_role === 'loser') out.push(reason(REASON.DUPLICATE_RECORD));
  if (!Number.isFinite(comp.lat) || !Number.isFinite(comp.lng)) out.push(reason(REASON.NO_COORDINATES));
  if (!comp.valid) out.push(reason(REASON.SALE_INVALID, { why: comp.invalid_reasons }));
  if (comp.family === 'sfr_unit_count_not_credible') out.push(reason(REASON.UNIT_COUNT_NOT_CREDIBLE, { units: comp.units, sqft: comp.sqft }));
  if (comp.family === 'land' && subject.family !== 'land') out.push(reason(REASON.IMPROVED_VS_VACANT));
  else if (comp.family !== subject.family && comp.family !== 'sfr_unit_count_not_credible') {
    out.push(reason(REASON.ASSET_FAMILY_MISMATCH, { subject_family: subject.family, comp_family: comp.family }));
  }
  if (subject.family === 'mf_2_4' && comp.family === 'mf_2_4' && subject.units && comp.units) {
    const ratio = comp.units / subject.units;
    if (ratio < params.unitRatio[0] || ratio > params.unitRatio[1]) out.push(reason(REASON.UNIT_BAND_MISMATCH, { unit_ratio: round(ratio, 2) }));
  }
  if (Boolean(subject.attached) !== Boolean(comp.attached) && comp.family === subject.family) {
    out.push(reason(REASON.CONDO_VS_DETACHED, { subject_attached: Boolean(subject.attached), comp_attached: Boolean(comp.attached) }));
  }
  if (!comp.sqft) out.push(reason(REASON.SIZE_UNKNOWN));
  else if (subject.sqft) {
    const band = params.sizeRatio[subject.family] ?? params.sizeRatio.sfr;
    const ratio = comp.sqft / subject.sqft;
    if (ratio < band[0] || ratio > band[1]) out.push(reason(REASON.SIZE_INCOMPATIBLE, { sqft_ratio: round(ratio, 2) }));
  }
  if (comp.sale_date < lookbackStart) out.push(reason(REASON.STALE_SALE, { sale_date: comp.sale_date, lookback_start: lookbackStart }));
  return out;
}

/**
 * Structural similarity -> recency -> physical (effective) distance.
 * Lower is better. Structural terms dominate; distance is last.
 */
export function rankScore(subject, comp, { effKm, radiusKm, asOf }) {
  const structural =
    Math.abs(Math.log(comp.sqft / subject.sqft)) / 0.15 +
    (subject.year_built && comp.year_built ? Math.abs(subject.year_built - comp.year_built) / 20 : 0.5) +
    (subject.beds !== null && comp.beds !== null ? 0.35 * Math.abs(subject.beds - comp.beds) : 0.2) +
    (subject.baths !== null && comp.baths !== null ? 0.35 * Math.abs(subject.baths - comp.baths) : 0.2);
  const recency = ageMonthsExact(comp.sale_date, asOf) / 9;
  const distance = Math.min(3, effKm / Math.max(radiusKm, 0.4));
  return { score: 1.0 * structural + 0.6 * recency + 0.35 * distance, structural, recency, distance };
}

function adaptiveRadius(passing, params) {
  const ladder = params.radiusLadderMiles;
  const counts = {};
  for (const r of ladder) counts[r] = 0;
  for (const c of passing) {
    if (!c.recentForDensity) continue;
    for (const r of ladder) if (c.distanceMi <= r) counts[r] += 1;
  }
  let radius = ladder[ladder.length - 1];
  for (const r of ladder) {
    if (counts[r] >= params.densityTargetComps) {
      radius = r;
      break;
    }
  }
  const densityClass = radius <= 0.75 ? 'dense' : radius <= 2 ? 'urban' : radius <= 6 ? 'suburban' : 'sparse';
  return { radiusMi: radius, densityClass, counts };
}

/**
 * Micro-market tier of a comp relative to the subject (support-aware):
 *   T1 same micro-market; T2 adjacent and similar (gap small or not
 *   significant); T3 other micro-market, no learned barrier and no supported
 *   large gap; T4 path crosses a learned discontinuity, or a supported gap
 *   >= discontinuityMinGap; TU micro-market unknown on either side.
 */
export function microMarketTier(subjectMm, rel, model, params = CHALLENGER_PARAMS) {
  if (subjectMm === null || rel.micro_market_id === null || rel.anchor === 'none') return { tier: 'TU', pair: null };
  if (rel.micro_market_id === subjectMm) return { tier: 'T1', pair: null };
  const pair = model.comparePair(subjectMm, rel.micro_market_id);
  if (!rel.reachable || (rel.crossings ?? 0) > 0) return { tier: 'T4', pair };
  const absGap = Math.abs(pair.gap);
  if (absGap >= params.discontinuityMinGap && pair.significant) return { tier: 'T4', pair };
  if (pair.adjacent && (absGap <= params.similarMaxGap || !pair.significant)) return { tier: 'T2', pair };
  return { tier: 'T3', pair };
}

const TIER_CODE = {
  T1: REASON.SAME_MICRO_MARKET,
  T2: REASON.ADJACENT_SIMILAR_MICRO_MARKET,
  T3: REASON.OTHER_MICRO_MARKET_NO_BARRIER,
  TU: REASON.MICRO_MARKET_UNKNOWN,
  T4: REASON.CROSS_DISCONTINUITY_FALLBACK,
};
const REGIME_CODE = { retail: REASON.REGIME_RETAIL, investor: REASON.REGIME_INVESTOR, unknown: REASON.REGIME_UNKNOWN };

function valueFromComps(selected, { subject, asOf, dispersionFloor, params, regime, layerPrior }) {
  const values = selected.map((c) => c.adjLog);
  const weights = selected.map((c) => c.weight);
  const compCenter = weightedMedian(values, weights);
  const sumW = weights.reduce((s, w) => s + w, 0);
  const nEff = sumW > 0 ? (sumW * sumW) / weights.reduce((s, w) => s + w * w, 0) : 0;
  const k = layerPrior && Number.isFinite(layerPrior.log) ? params.layerPriorK : 0;
  const center = k > 0 ? (nEff * compCenter + k * layerPrior.log) / (nEff + k) : compCenter;
  const absDev = values.map((v) => Math.abs(v - center));
  const spread = 1.4826 * (weightedMedian(absDev, weights) ?? 0);
  // A handful of similar comps can agree by chance; a single new sale still
  // varies around its micro-market level by at least the layer's measured
  // within-micro-market dispersion.
  const sigmaComp = Math.max(spread, dispersionFloor, params.sigmaFloor);
  const seComps = bootstrapWeightedMedianSe(values, weights, {
    iterations: params.bootstrapIterations,
    seed: hashString(`${subject.id}|${asOf}|${regime}`),
  }) ?? sigmaComp;
  const se = k > 0 ? (seComps * nEff) / (nEff + k) : seComps;
  const sigmaPred = Math.sqrt(sigmaComp * sigmaComp + se * se);
  const intervals = {};
  for (const level of params.intervals) {
    const z = normInv(0.5 + level / 2);
    intervals[`p${Math.round(level * 100)}`] = [Math.round(Math.exp(center - z * sigmaPred)), Math.round(Math.exp(center + z * sigmaPred))];
  }
  const totalW = weights.reduce((s, w) => s + w, 0);
  const tierShare = {};
  for (const c of selected) tierShare[c.tier] = (tierShare[c.tier] ?? 0) + c.weight / totalW;
  return {
    value: Math.round(Math.exp(center)),
    log_center: center,
    comp_value: Math.round(Math.exp(compCenter)),
    layer_prior: k > 0 ? { value: Math.round(Math.exp(layerPrior.log)), tier: layerPrior.tier, weight_share: round(k / (nEff + k), 3) } : null,
    n_eff: round(nEff, 2),
    sigma_pred: round(sigmaPred, 4),
    sigma_comp: round(sigmaComp, 4),
    se_center: round(se, 4),
    intervals,
    weighted_q10: Math.round(Math.exp(weightedQuantile(values, weights, 0.1))),
    weighted_q90: Math.round(Math.exp(weightedQuantile(values, weights, 0.9))),
    n_comps: selected.length,
    tier_weight_share: Object.fromEntries(Object.entries(tierShare).map(([k, v]) => [k, round(v, 3)])),
  };
}

/**
 * Value one subject.
 * @param {object} input
 *   subject     internal sale/property (comp-records.toSale shape; needs lat,
 *               lng, family, sqft; beds/baths/year_built optional)
 *   asOf        'YYYY-MM-DD'; only comps with known_date < asOf are usable
 *   candidates  internal sales near the subject (the caller may pre-filter
 *               by maxRadiusMiles; anything farther is ignored and counted)
 *   model       micro-market model built as of a date <= asOf
 */
export function valueSubjectChallenger({ subject, asOf, candidates, model, params = CHALLENGER_PARAMS }) {
  const flags = [];
  const lookbackStart = subtractMonths(asOf, params.lookbackMonths);
  const densityStart = subtractMonths(asOf, params.densityWindowMonths);
  const result = {
    model: 'comp_micromarket',
    version: CHALLENGER_VERSION,
    as_of: asOf,
    layer_as_of: model?.asOf ?? null,
    subject_assignment: null,
    adaptive_radius: null,
    values: { retail: null, investor: null, unknown_regime: null },
    headline: null,
    comps: [],
    outside_universe: 0,
    flags,
  };
  if (!SUPPORTED_SUBJECT_FAMILIES.has(subject.family)) {
    flags.push(reason(REASON.SUBJECT_FAMILY_UNSUPPORTED, { family: subject.family }));
    flags.push(reason(REASON.INSUFFICIENT_EVIDENCE));
    return result;
  }
  if (!subject.sqft) {
    flags.push(reason(REASON.SUBJECT_SIZE_UNKNOWN));
    flags.push(reason(REASON.INSUFFICIENT_EVIDENCE));
    return result;
  }
  if (model && model.asOf > asOf) throw new Error('micro_market_layer_after_as_of');

  const assignment = model.assign(subject.lat, subject.lng, subject.zip);
  result.subject_assignment = assignment;
  if (assignment.confidence === 'unknown') flags.push(reason(REASON.SUBJECT_MICRO_MARKET_UNKNOWN, { tier: assignment.tier }));

  // 1) universe + hard gates
  const universe = [];
  for (const comp of candidates) {
    if (!Number.isFinite(comp.lat) || !Number.isFinite(comp.lng)) continue;
    const distanceMi = haversineMiles(subject.lat, subject.lng, comp.lat, comp.lng);
    if (distanceMi > params.maxRadiusMiles) {
      result.outside_universe += 1;
      continue;
    }
    const gates = gateComp(subject, comp, { asOf, lookbackStart, params });
    universe.push({ comp, distanceMi, gates, recentForDensity: comp.sale_date >= densityStart && comp.known_date < asOf });
  }
  universe.sort((a, b) => a.distanceMi - b.distanceMi || (a.comp.id < b.comp.id ? -1 : 1));
  const passing = universe.filter((u) => u.gates.length === 0);

  // 2) adaptive radius from local density of eligible evidence
  const radius = adaptiveRadius(passing, params);
  const searchMi = Math.min(params.maxRadiusMiles, radius.radiusMi * params.radiusExtension);
  result.adaptive_radius = { radius_mi: radius.radiusMi, search_radius_mi: searchMi, density_class: radius.densityClass, eligible_recent_counts: radius.counts };

  // 3) micro-market relation for every eligible comp inside the search radius
  const dist = model.distancesFrom(subject.lat, subject.lng);
  const subjectMm = assignment.micro_market_id;
  const radiusKm = radius.radiusMi * KM_PER_MILE;
  const pools = { retail: [], investor: [], unknown: [] };
  for (const u of universe) {
    if (u.gates.length) continue;
    if (u.distanceMi > searchMi) continue;
    const rel = dist.to(u.comp.lat, u.comp.lng);
    const { tier, pair } = microMarketTier(subjectMm, rel, model, params);
    u.rel = { ...rel, levelGap: pair ? pair.gap : 0, gapSignificant: pair ? pair.significant : null, boundaryClass: pair?.boundary_class ?? null };
    u.tier = tier;
    const effKm = Number.isFinite(rel.effKm) ? rel.effKm : rel.geoKm * 4;
    u.rank = rankScore(subject, u.comp, { effKm, radiusKm, asOf });
    pools[u.comp.regime].push(u);
  }

  // 4) per-regime tiered fill
  const tierOrder = ['T1', 'T2', 'T3', 'TU', 'T4'];
  const subjectMmSd = subjectMm !== null ? model.microMarket(subjectMm)?.sd ?? 0 : 0;
  const dispersionFloor = Math.max(model.sigmaMicroMarket ?? model.market.sigmaWithin, subjectMmSd);
  const beta = model.market.beta;
  const regimeKey = { retail: 'retail', investor: 'investor', unknown: 'unknown_regime' };
  for (const regime of ['retail', 'investor', 'unknown']) {
    const pool = pools[regime];
    const byTier = Object.fromEntries(tierOrder.map((t) => [t, pool.filter((u) => u.tier === t).sort((a, b) => a.rank.score - b.rank.score || (a.comp.id < b.comp.id ? -1 : 1))]));
    const chosen = [];
    for (const tier of tierOrder) {
      // Same/adjacent-similar micro-markets fill up to maxComps; broader tiers
      // only top up to minComps. With no subject micro-market at all, the
      // hierarchy has bottomed out at pure distance and TU fills normally.
      const cap = tier === 'T1' || tier === 'T2' || (tier === 'TU' && subjectMm === null) ? params.maxComps : params.minComps;
      let usedFromTier = 0;
      for (const u of byTier[tier]) {
        if (chosen.length < cap) {
          chosen.push(u);
          usedFromTier += 1;
          continue;
        }
        const gapPct = round((Math.exp(u.rel.levelGap) - 1) * 100, 1);
        if (usedFromTier > 0) u.exclusion = reason(REASON.RANK_BELOW_CUTOFF, { tier, cap });
        else if (tier === 'T4') u.exclusion = reason(REASON.ACROSS_DISCONTINUITY, { ppsf_gap_pct: gapPct, crossings: u.rel.crossings });
        else if (tier === 'T3') u.exclusion = reason(REASON.OTHER_MICRO_MARKET, { ppsf_gap_pct: gapPct });
        else u.exclusion = reason(REASON.LOWER_TIER_NOT_NEEDED, { tier });
      }
    }

    // adjustments and weights
    for (const u of chosen) {
      const c = u.comp;
      const time = model.market.timeAdjust(c.sale_date);
      const size = beta * Math.log(subject.sqft / c.sqft);
      let location = 0;
      if (u.tier !== 'T1' && subjectMm !== null && u.rel.micro_market_id !== null && u.rel.micro_market_id !== subjectMm) {
        const ms = model.microMarket(subjectMm);
        const mc = model.microMarket(u.rel.micro_market_id);
        const nEff = 2 / (1 / Math.max(ms.n, 1) + 1 / Math.max(mc.n, 1));
        location = (nEff / (nEff + params.locationShrinkK)) * (ms.level - mc.level);
      }
      u.adj = { time: round(time, 4), size: round(size, 4), location: round(location, 4) };
      u.adjLog = Math.log(c.price) + time + size + location;
      u.weight = params.tierWeight[u.tier] * Math.exp(-u.rank.score / 2);
    }
    // robust outlier screen centred on THIS regime's selected set
    let kept = chosen;
    if (chosen.length >= params.minComps) {
      const center = weightedMedian(chosen.map((u) => u.adjLog), chosen.map((u) => u.weight));
      const scale = Math.max(params.outlierMinScale, 1.4826 * (weightedMedian(chosen.map((u) => Math.abs(u.adjLog - center)), chosen.map((u) => u.weight)) ?? 0));
      kept = [];
      for (const u of chosen) {
        const z = (u.adjLog - center) / scale;
        if (Math.abs(z) > params.outlierZ) u.exclusion = reason(REASON.PRICE_OUTLIER_WITHIN_REGIME, { robust_z: round(z, 2) });
        else kept.push(u);
      }
    }
    if (kept.length < params.minValueComps) {
      for (const u of kept) u.exclusion = reason(REASON.REGIME_EVIDENCE_INSUFFICIENT, { regime, n: kept.length });
      continue;
    }
    for (const u of kept) u.included = true;
    const layerPrior = assignment.tier !== 'market' || (model.summary.evidence_sales ?? 0) > 0
      ? { log: assignment.level + beta * (Math.log(subject.sqft) - Math.log(model.market.refSqft)) + (model.market.rho[regime] ?? 0), tier: assignment.tier }
      : null;
    const valued = valueFromComps(
      kept.map((u) => ({ adjLog: u.adjLog, weight: u.weight, tier: u.tier })),
      { subject, asOf, dispersionFloor, params, regime, layerPrior },
    );
    const nearShare = (valued.tier_weight_share.T1 ?? 0) + (valued.tier_weight_share.T2 ?? 0);
    const crossShare = valued.tier_weight_share.T4 ?? 0;
    valued.support = kept.length >= 6 && nearShare >= 0.6 && assignment.confidence !== 'unknown' ? 'strong' : 'weak';
    valued.cross_discontinuity_weight_share = crossShare;
    result.values[regimeKey[regime]] = valued;
  }

  // 5) headline (an ARV-style single number): retail when strongly supported,
  // else regime-unknown, else retail/unknown with weak support; an investor
  // value is the headline only when it is the only evidence, and says so.
  const { retail, unknown_regime: unknownRegime, investor } = result.values;
  let basis = null;
  if (retail?.support === 'strong') basis = 'retail';
  else if (unknownRegime?.support === 'strong') basis = 'unknown_regime';
  else if (retail) basis = 'retail';
  else if (unknownRegime) basis = 'unknown_regime';
  else if (investor) basis = 'investor';
  if (basis) {
    const v = result.values[basis];
    result.headline = { basis, value: v.value, p50: v.intervals.p50, p80: v.intervals.p80, support: v.support, sigma_pred: v.sigma_pred, n_comps: v.n_comps };
    flags.push(reason(basis === 'retail' ? REASON.HEADLINE_RETAIL : basis === 'investor' ? REASON.HEADLINE_FROM_INVESTOR_REGIME : REASON.HEADLINE_FROM_UNKNOWN_REGIME));
    if (v.support !== 'strong') flags.push(reason(REASON.LOW_SUPPORT, { n_comps: v.n_comps }));
    if ((v.cross_discontinuity_weight_share ?? 0) > 0) flags.push(reason(REASON.CROSS_DISCONTINUITY_EVIDENCE_USED, { weight_share: round(v.cross_discontinuity_weight_share, 3) }));
  } else {
    flags.push(reason(REASON.INSUFFICIENT_EVIDENCE));
  }

  // 6) a structured reason for every candidate in the universe
  for (const u of universe) {
    const entry = {
      id: u.comp.id,
      included: Boolean(u.included),
      regime: u.comp.regime,
      family: u.comp.family,
      zip: u.comp.zip,
      sale_date: u.comp.sale_date,
      price: u.comp.price,
      sqft: u.comp.sqft,
      distance_mi: round(u.distanceMi, 3),
      reasons: [],
    };
    if (u.gates.length) {
      entry.reasons = u.gates;
    } else if (u.distanceMi > searchMi) {
      entry.reasons = [reason(REASON.OUTSIDE_ADAPTIVE_RADIUS, { distance_mi: round(u.distanceMi, 2), radius_mi: searchMi })];
    } else {
      entry.tier = u.tier;
      entry.micro_market_id = u.rel.micro_market_id;
      entry.effective_km = Number.isFinite(u.rel.effKm) ? round(u.rel.effKm, 2) : null;
      entry.crossings = u.rel.crossings;
      entry.ppsf_gap_pct = round((Math.exp(u.rel.levelGap) - 1) * 100, 1);
      const regimeReason = reason(REGIME_CODE[u.comp.regime]);
      if (u.included) {
        entry.weight = round(u.weight, 4);
        entry.adjusted_price = Math.round(Math.exp(u.adjLog));
        entry.adjustments = u.adj;
        const tierReason = u.tier === 'T4'
          ? reason(TIER_CODE.T4, { ppsf_gap_pct: entry.ppsf_gap_pct, crossings: u.rel.crossings })
          : reason(TIER_CODE[u.tier]);
        entry.reasons = [tierReason, regimeReason];
        if (u.adj.location !== 0) entry.reasons.push(reason(REASON.LOCATION_ADJUSTED, { log_adjustment: u.adj.location }));
        if (u.distanceMi > radius.radiusMi) entry.reasons.push(reason(REASON.ADAPTIVE_RADIUS_EXTENDED, { distance_mi: round(u.distanceMi, 2), radius_mi: radius.radiusMi }));
      } else {
        const fallback = u.tier === 'T4'
          ? reason(REASON.ACROSS_DISCONTINUITY, { ppsf_gap_pct: entry.ppsf_gap_pct, crossings: u.rel.crossings })
          : reason(REASON.LOWER_TIER_NOT_NEEDED, { tier: u.tier });
        entry.reasons = [u.exclusion ?? fallback, regimeReason];
      }
    }
    result.comps.push(entry);
  }
  return result;
}

/**
 * The micro-market layer is rebuilt once per calendar month: the layer for a
 * subject sold on D is built as of the first day of D's month, so it only
 * ever uses sales strictly before D.
 */
export function layerAsOfFor(dateText) {
  return `${dateText.slice(0, 7)}-01`;
}
