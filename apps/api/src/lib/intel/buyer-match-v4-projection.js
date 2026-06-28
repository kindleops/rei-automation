/**
 * Buyer Match V4 — read-only canonical UI projection.
 * Phase 1: truthful states, no global entity-count fallback, no browser-side authority.
 *
 * Phase 4 follow-up: rehydrate purchase events + rollup when serving cached runs
 * (see buyer-match-engine.js cache path returning comps:[] and buyer_rollup:null).
 */
import { buildBuyerMatchIntel } from './buyer-match-engine.js';
import { buildCanonicalBuyerDemand } from './buyer-match-demand.js';
import { findFreshBuyerMatchResult } from './buyer-match-job-service.js';
import { buildIdempotencyKey } from './buyer-match-job-service.js';

export const BUYER_MATCH_V4_VERSION = 'buyer_match_v4.0';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.7559 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function mapFallbackLevel(level) {
  const map = {
    zip: 'EXACT_ZIP',
    zip_asset: 'EXACT_ZIP',
    radius: 'RADIUS',
    market: 'MARKET',
    market_asset: 'MARKET',
    county: 'COUNTY',
    state: 'STATE',
    state_asset: 'STATE',
    none: 'NONE',
  };
  return map[String(level ?? 'none').toLowerCase()] ?? 'NONE';
}

export function mapBuyerArchetype(candidate = {}) {
  if (candidate.buyer_type === 'institutional') return 'Verified institutional buyer';
  if (candidate.is_corporate_buyer || candidate.buyer_type === 'corporate') return 'Corporate repeat buyer';
  if (candidate.is_repeat_buyer) return 'Local investor';
  if (candidate.buyer_type === 'trust') return 'Trust';
  if (candidate.buyer_type === 'individual') return 'Individual';
  return 'Unknown';
}

export function mapInstitutionalStatus(candidate = {}) {
  if (candidate.buyer_type === 'institutional') return 'VERIFIED_INSTITUTIONAL';
  if (candidate.is_corporate_buyer || candidate.buyer_type === 'corporate') return 'CORPORATE';
  return null;
}

export function buildReasonSummary(candidate = {}) {
  const parts = [];
  if (candidate.reason_for_match) {
    parts.push(String(candidate.reason_for_match));
  } else {
    if (num(candidate.zip_purchase_count) > 0) {
      parts.push(`${candidate.zip_purchase_count} purchases in this ZIP`);
    }
    if (num(candidate.matched_purchase_count) > 0) {
      parts.push(`${candidate.matched_purchase_count} matched purchases near subject`);
    }
    if (candidate.last_purchase_date) {
      parts.push(`last purchase ${candidate.last_purchase_date}`);
    }
  }
  return parts.slice(0, 4);
}

function resolveAcquisitionContext(subject = {}, context = {}) {
  const v3 = context.acquisition_v3 ?? context.acquisition_decision ?? {};
  const valueContract = v3.value_contract ?? v3.outputs?.value_contract ?? {};
  const buyerExit =
    valueContract.qualified_buyer_exit ??
    valueContract.scenario_buyer_exit ??
    v3.buyer_exit ??
    v3.qualified_buyer_exit ??
    null;
  const marketValue =
    num(valueContract.qualified_market_value?.mid) ??
    num(valueContract.scenario_market_value?.mid) ??
    num(v3.qualified_market_value?.mid) ??
    num(subject.estimated_value) ??
    null;

  const hasV3 =
    marketValue !== null ||
    buyerExit?.conservative != null ||
    buyerExit?.base != null ||
    v3.strategy != null ||
    v3.execution_state != null;

  return {
    marketValue,
    buyerExitLow: num(buyerExit?.conservative ?? buyerExit?.low),
    buyerExitBase: num(buyerExit?.base ?? buyerExit?.mid),
    buyerExitHigh: num(buyerExit?.optimistic ?? buyerExit?.high),
    strategy: v3.strategy ?? v3.basis_strategy ?? context.strategy ?? null,
    executionState: v3.execution_state ?? context.execution_state ?? null,
    repairEstimate: num(context.repair_estimate ?? subject.estimated_repair_cost),
    source: hasV3 ? 'ACQUISITION_ENGINE_V3' : 'UNAVAILABLE',
  };
}

function countActiveBuyers(candidates, days) {
  const cutoff = Date.now() - days * 86_400_000;
  return candidates.filter((c) => {
    if (!c.last_purchase_date) return false;
    return new Date(c.last_purchase_date).getTime() >= cutoff;
  }).length;
}

function countInstitutional(candidates) {
  return candidates.filter((c) => c.buyer_type === 'institutional').length;
}

async function loadLocalPurchaseEvents(supabase, subject, buyerEntityIds = []) {
  const select =
    'id,buyer_entity_id,buyer_key,property_address_full,latitude,longitude,purchase_date,purchase_price,normalized_asset_class,property_zip';
  const limit = 250;
  let rows = [];

  if (subject.zip) {
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(select)
      .eq('property_zip', subject.zip)
      .not('purchase_price', 'is', null)
      .order('purchase_date', { ascending: false })
      .limit(limit);
    rows = data ?? [];
  }

  if (rows.length === 0 && subject.lat !== null && subject.lng !== null) {
    const d = 0.35;
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(select)
      .gte('latitude', subject.lat - d)
      .lte('latitude', subject.lat + d)
      .gte('longitude', subject.lng - d)
      .lte('longitude', subject.lng + d)
      .not('purchase_price', 'is', null)
      .order('purchase_date', { ascending: false })
      .limit(limit);
    rows = data ?? [];
  }

  if (rows.length === 0 && subject.market) {
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(select)
      .eq('market', subject.market)
      .not('purchase_price', 'is', null)
      .order('purchase_date', { ascending: false })
      .limit(limit);
    rows = data ?? [];
  }

  if (buyerEntityIds.length > 0 && rows.length < 20) {
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(select)
      .in('buyer_entity_id', buyerEntityIds.slice(0, 25))
      .not('purchase_price', 'is', null)
      .order('purchase_date', { ascending: false })
      .limit(limit);
    const extra = data ?? [];
    const seen = new Set(rows.map((r) => r.id));
    for (const row of extra) {
      if (!seen.has(row.id)) rows.push(row);
    }
  }

  return rows;
}

function mapPurchaseEvents(rows, subject) {
  return rows.map((row) => {
    const lat = num(row.latitude);
    const lng = num(row.longitude);
    const distanceMiles =
      subject.lat !== null && subject.lng !== null && lat !== null && lng !== null
        ? Math.round(haversineMiles(subject.lat, subject.lng, lat, lng) * 100) / 100
        : null;
    return {
      eventId: String(row.id),
      buyerId: row.buyer_entity_id ?? row.buyer_key ?? 'unknown',
      address: row.property_address_full || 'Address unavailable',
      latitude: lat,
      longitude: lng,
      purchaseDate: row.purchase_date ?? null,
      purchasePrice: num(row.purchase_price),
      assetLane: row.normalized_asset_class ?? null,
      distanceMiles,
      source: 'buyer_purchase_events_v2',
    };
  });
}

function mapRankedBuyers(candidates, confidence = 0) {
  return candidates.map((c) => {
    const low = num(c.likely_exit_low) ?? (num(c.median_purchase_price) ? Math.round(num(c.median_purchase_price) * 0.92) : null);
    const base = num(c.median_purchase_price) ?? num(c.avg_purchase_price);
    const high = num(c.likely_exit_high) ?? (num(c.median_purchase_price) ? Math.round(num(c.median_purchase_price) * 1.05) : null);
    return {
      buyerId: c.buyer_entity_id ?? c.buyer_key ?? c.buyer_name,
      buyerName: c.buyer_name ?? c.buyer_display_name ?? 'Unknown buyer',
      entityType: c.buyer_type ?? null,
      buyerArchetype: mapBuyerArchetype(c),
      institutionalStatus: mapInstitutionalStatus(c),
      matchScore: num(c.total_match_score ?? c.match_score),
      matchGrade: c.match_grade ?? null,
      matchConfidence: confidence,
      reasonSummary: buildReasonSummary(c),
      likelyBidLow: low,
      likelyBidBase: base,
      likelyBidHigh: high,
      purchases90d: null,
      purchases180d: num(c.purchase_count_180d),
      purchases365d: num(c.purchase_count_365d),
      lastPurchaseAt: c.last_purchase_date ?? null,
      nearestPurchaseMiles: num(c.distance_miles),
      contactReadiness: 'ENRICHMENT_REQUIRED',
    };
  });
}

export function resolveMarketDataState({
  subject,
  candidates,
  purchaseEvents,
  cached,
  cacheIncomplete,
  intelError,
  rollup,
}) {
  if (intelError) return 'ERROR';
  if (!subject.is_subject_resolved && subject.lat === null && subject.lng === null && !subject.zip) {
    return 'SUBJECT_COORDINATES_REQUIRED';
  }
  const localFallback = mapFallbackLevel(candidates[0]?.fallback_level ?? 'none');
  const hasLocalBuyers = candidates.length > 0 && localFallback !== 'STATE' && localFallback !== 'NONE';
  const hasLocalEvents = purchaseEvents.length > 0 && localFallback !== 'STATE';

  if (!hasLocalBuyers && candidates.length === 0 && purchaseEvents.length === 0) {
    if (localFallback === 'STATE' || localFallback === 'MARKET') {
      return candidates.length > 0 ? 'PARTIAL' : 'NO_LOCAL_DATA';
    }
    return 'NO_LOCAL_DATA';
  }
  if (cacheIncomplete || (cached && purchaseEvents.length === 0 && candidates.length > 0)) {
    return 'PARTIAL';
  }
  if (!hasLocalEvents && candidates.length > 0) return 'PARTIAL';
  if (localFallback === 'STATE' || localFallback === 'MARKET') return 'PARTIAL';
  if (!rollup && candidates.length > 0) return 'PARTIAL';
  return 'READY';
}

/**
 * Build the V4 projection (read-only). Uses persist:false for live intel unless
 * serving a fresh cached run row (read-only SELECT).
 */
export async function buildBuyerMatchV4Projection({
  supabase,
  property_id,
  context = {},
  refresh = false,
}) {
  const startedAt = Date.now();
  let intel = null;
  let intelError = null;
  let cached = false;
  let cacheIncomplete = false;
  let generatedAt = new Date().toISOString();

  try {
    intel = await buildBuyerMatchIntel({
      supabase,
      subject: { property_id, ...(context.subject_overrides ?? {}) },
      context,
      persist: false,
      skip_cache: refresh,
      source_event: 'buyer_match_v4_projection',
    });
    cached = Boolean(intel.cached);
    generatedAt = intel.generated_at ?? generatedAt;
    cacheIncomplete = cached && (!intel.buyer_rollup || (intel.comps?.length ?? 0) === 0);
  } catch (error) {
    intelError = error?.message ?? 'projection_failed';
  }

  const subject = intel?.subject ?? {
    property_id,
    address: context.canonical_address ?? null,
    lat: null,
    lng: null,
    asset_class: null,
    zip: null,
    market: null,
    is_subject_resolved: false,
  };

  const candidates = intel?.top_buyers ?? intel?.buyer_matches ?? [];
  const buyerDemand = intel?.buyer_demand ?? buildCanonicalBuyerDemand({
    candidates,
    rollup: intel?.buyer_rollup,
    demand_score: intel?.demand_score,
    liquidity_score: intel?.liquidity_score,
    confidence: intel?.confidence,
    fallback_level: intel?.fallback_level ?? 'none',
    source_failure: Boolean(intelError),
    coordinates_unavailable: subject.is_subject_resolved === false,
  });

  const buyerEntityIds = candidates.map((c) => c.buyer_entity_id).filter(Boolean);
  const purchaseEventRows = intelError
    ? []
    : await loadLocalPurchaseEvents(supabase, subject, buyerEntityIds);
  const purchaseEvents = mapPurchaseEvents(purchaseEventRows, subject);
  const mappedPurchaseEventCount = purchaseEvents.filter(
    (e) => e.latitude !== null && e.longitude !== null,
  ).length;

  const acquisitionContext = resolveAcquisitionContext(subject, context);
  const fallbackLevel = mapFallbackLevel(intel?.fallback_level ?? candidates[0]?.fallback_level ?? 'none');
  const highFitCount = candidates.filter((c) => c.match_grade === 'A+' || c.match_grade === 'A').length;
  const dataState = resolveMarketDataState({
    subject,
    candidates,
    purchaseEvents,
    cached,
    cacheIncomplete,
    intelError,
    rollup: intel?.buyer_rollup,
  });

  const bidRange = buyerDemand.likely_buyer_price_range ?? null;

  return {
    version: BUYER_MATCH_V4_VERSION,
    subject: {
      propertyId: subject.property_id ?? property_id,
      canonicalAddress: subject.canonical_address ?? subject.address ?? 'Address unavailable',
      latitude: subject.lat ?? null,
      longitude: subject.lng ?? null,
      assetLane: subject.asset_class ?? null,
      propertySubtype: subject.property_type ?? null,
      acquisitionContext,
    },
    market: {
      dataState,
      fallbackLevel,
      verifiedBuyerCount: candidates.length > 0 ? candidates.length : null,
      highFitBuyerCount: highFitCount > 0 ? highFitCount : null,
      activeBuyerCount90d: candidates.length > 0 ? countActiveBuyers(candidates, 90) : null,
      activeBuyerCount180d: candidates.length > 0 ? countActiveBuyers(candidates, 180) : null,
      institutionalBuyerCount: countInstitutional(candidates) || null,
      repeatBuyerCount: buyerDemand.repeat_buyer_count ?? null,
      verifiedPurchaseEventCount: purchaseEvents.length > 0 ? purchaseEvents.length : null,
      mappedPurchaseEventCount: mappedPurchaseEventCount > 0 ? mappedPurchaseEventCount : null,
      likelyBidLow: bidRange?.low ?? null,
      likelyBidBase: bidRange ? Math.round((bidRange.low + bidRange.high) / 2) : null,
      likelyBidHigh: bidRange?.high ?? null,
      liquidityScore: intel?.liquidity_score ?? buyerDemand.liquidity_score ?? null,
      demandScore: intel?.demand_score ?? buyerDemand.demand_score ?? null,
      refreshedAt: generatedAt,
      cacheIncomplete: cacheIncomplete || undefined,
    },
    rankedBuyers: mapRankedBuyers(candidates, intel?.confidence ?? 0),
    purchaseEvents,
    institutionalActivity: [],
    shortlist: [],
    meta: {
      cached,
      query_ms: Date.now() - startedAt,
      model_version: intel?.model_version ?? null,
      error: intelError,
      phase4_cache_note: cacheIncomplete
        ? 'Cached run missing rollup/comps — Phase 4 will rehydrate purchase events in cache path'
        : undefined,
    },
  };
}

export async function peekCachedRunFreshness(supabase, property_id, valuation_snapshot_id = null) {
  const idempotency_key = buildIdempotencyKey({ property_id, valuation_snapshot_id });
  return findFreshBuyerMatchResult(supabase, { property_id, idempotency_key });
}

export default {
  buildBuyerMatchV4Projection,
  BUYER_MATCH_V4_VERSION,
  mapFallbackLevel,
  mapBuyerArchetype,
  resolveMarketDataState,
};