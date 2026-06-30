/**
 * Buyer Match V4 — read-only canonical UI projection.
 * Phase 2: buyer family identity, transaction truth, unified aggregations.
 */
import { buildBuyerMatchIntel } from './buyer-match-engine.js';
import { buildCanonicalBuyerDemand } from './buyer-match-demand.js';
import { findFreshBuyerMatchResult, buildIdempotencyKey } from './buyer-match-job-service.js';
import {
  buildBuyerFamilyProjections,
  isVerifiedInstitutional,
  isBuilder,
  isEligibleDispositionFamily,
} from './buyer-match-v4-identity.js';
import {
  buildCanonicalPurchaseEvents,
  countGeocodedEvents,
} from './buyer-match-v4-transactions.js';
import {
  aggregateFamilyActivity,
  buildMarketIntelligenceCounts,
  familyToRankedBuyer,
  repairBidRange,
} from './buyer-match-v4-aggregations.js';

export const BUYER_MATCH_V4_VERSION = 'buyer_match_v4.1';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

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

/** @deprecated Phase 2 uses buyerClass — kept for legacy tests */
export function mapBuyerArchetype(candidate = {}) {
  if (candidate.buyer_type === 'institutional') return 'Verified institutional buyer';
  if (candidate.is_corporate_buyer || candidate.buyer_type === 'corporate') return 'Corporate repeat buyer';
  if (candidate.is_repeat_buyer) return 'Local investor';
  if (candidate.buyer_type === 'trust') return 'Trust';
  if (candidate.buyer_type === 'individual') return 'Individual';
  return 'Unknown';
}

/** @deprecated Phase 2 uses buyerClass */
export function mapInstitutionalStatus(candidate = {}) {
  if (candidate.buyer_type === 'institutional' && num(candidate.institutional_score) >= 70) {
    return 'VERIFIED_INSTITUTIONAL';
  }
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

function countActiveFamilies(families, days) {
  const cutoff = Date.now() - days * 86_400_000;
  return families.filter((f) => {
    const d = f.match?.lastPurchaseAt;
    if (!d) return false;
    return new Date(d).getTime() >= cutoff;
  }).length;
}

const EVENT_SELECT =
  'id,buyer_entity_id,buyer_key,buyer_name,buyer_type,is_corporate_buyer,' +
  'comp_property_id,raw_id,property_address_full,property_zip,market,' +
  'latitude,longitude,purchase_date,recording_date,purchase_price,purchase_price_source,' +
  'document_type,normalized_asset_class,property_type,source,source_dedup_key';

async function loadLocalPurchaseEvents(supabase, subject, buyerEntityIds = []) {
  const limit = 250;
  let rows = [];

  if (subject.zip) {
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(EVENT_SELECT)
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
      .select(EVENT_SELECT)
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
      .select(EVENT_SELECT)
      .eq('market', subject.market)
      .not('purchase_price', 'is', null)
      .order('purchase_date', { ascending: false })
      .limit(limit);
    rows = data ?? [];
  }

  if (buyerEntityIds.length > 0 && rows.length < 20) {
    const { data } = await supabase
      .from('buyer_purchase_events_v2')
      .select(EVENT_SELECT)
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

async function loadBuyerEntities(supabase, buyerKeys = []) {
  const keys = [...new Set(buyerKeys.filter(Boolean))].slice(0, 50);
  if (!keys.length) return [];
  const { data } = await supabase
    .from('buyer_entities_v2')
    .select(
      'id,buyer_key,buyer_name,normalized_buyer_name,buyer_type,is_corporate_buyer,is_repeat_buyer,' +
      'purchase_count,purchase_count_180d,purchase_count_365d,markets_active,zips_active,' +
      'preferred_asset_classes,median_purchase_price,avg_purchase_price,investor_score,velocity_score',
    )
    .in('buyer_key', keys);
  return data ?? [];
}

export function resolveMarketDataState({
  subject,
  families,
  candidates,
  purchaseEvents,
  cached,
  cacheIncomplete,
  intelError,
  rollup,
}) {
  const familyList = families ?? candidates ?? [];
  if (intelError) return 'ERROR';
  if (!subject.is_subject_resolved && subject.lat === null && subject.lng === null && !subject.zip) {
    return 'SUBJECT_COORDINATES_REQUIRED';
  }
  const localFallback = mapFallbackLevel(
    familyList[0]?.match?.candidate?.fallback_level ?? familyList[0]?.fallback_level ?? 'none',
  );
  const hasLocalBuyers = familyList.length > 0 && localFallback !== 'STATE' && localFallback !== 'NONE';
  const hasLocalEvents = purchaseEvents.length > 0 && localFallback !== 'STATE';

  if (!hasLocalBuyers && familyList.length === 0 && purchaseEvents.length === 0) {
    if (localFallback === 'STATE' || localFallback === 'MARKET') {
      return familyList.length > 0 ? 'PARTIAL' : 'NO_LOCAL_DATA';
    }
    return 'NO_LOCAL_DATA';
  }
  if (cacheIncomplete || (cached && purchaseEvents.length === 0 && familyList.length > 0)) {
    return 'PARTIAL';
  }
  if (!hasLocalEvents && familyList.length > 0) return 'PARTIAL';
  if (localFallback === 'STATE' || localFallback === 'MARKET') return 'PARTIAL';
  if (!rollup && familyList.length > 0) return 'PARTIAL';
  return 'READY';
}

function buildInstitutionalPlatforms(families, events) {
  return families
    .filter((f) => isVerifiedInstitutional(f))
    .map((f) => {
      const activity = aggregateFamilyActivity(f.buyerFamilyId, events, null, 25);
      const bids = repairBidRange(f.match?.likelyBidLow, f.match?.likelyBidBase, f.match?.likelyBidHigh);
      return {
        platformId: f.buyerFamilyId,
        platformName: f.displayName,
        parentPlatform: f.parentPlatform,
        platformType: f.classification?.buyerClass ?? 'UNKNOWN',
        institutionalSubtype: f.classification?.institutionalSubtype ?? null,
        legalEntities: f.legalEntities,
        activity,
        matchGrade: f.match?.matchGrade ?? null,
        matchScore: f.match?.matchScore ?? null,
        likelyBidLow: bids.low,
        likelyBidBase: bids.base,
        likelyBidHigh: bids.high,
        strategyProfile: {
          targetAssetTypes: f.match?.entity?.preferred_asset_classes ?? [],
          targetZips: f.match?.entity?.zips_active ?? [],
          targetMarkets: f.match?.entity?.markets_active ?? [],
          typicalPriceMin: num(f.match?.entity?.preferred_price_min),
          typicalPriceMax: num(f.match?.entity?.preferred_price_max),
          singleAssetVsPackage: {
            singleAssetPct: activity.singleAssetPct,
            packagePct: activity.packagePct,
          },
          inferred: true,
        },
      };
    });
}

/**
 * Build the V4 projection (read-only).
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

  const buyerKeys = candidates.map((c) => c.buyer_key).filter(Boolean);
  const buyerEntityIds = candidates.map((c) => c.buyer_entity_id).filter(Boolean);
  const entityRows = intelError ? [] : await loadBuyerEntities(supabase, buyerKeys);
  const entityByKey = new Map(entityRows.map((e) => [e.buyer_key, e]));

  const buyerFamilies = buildBuyerFamilyProjections(candidates, entityByKey);

  const familyByEntity = new Map();
  const buyerClassByFamily = new Map();
  for (const f of buyerFamilies) {
    buyerClassByFamily.set(f.buyerFamilyId, f.classification?.buyerClass ?? 'UNKNOWN');
    if (f.buyerFamilyId) familyByEntity.set(f.buyerFamilyId, f.buyerFamilyId);
    for (const le of f.legalEntities) {
      if (le.entityId) familyByEntity.set(le.entityId, f.buyerFamilyId);
    }
    const bk = f.match?.candidate?.buyer_key;
    if (bk) familyByEntity.set(bk, f.buyerFamilyId);
  }

  const purchaseEventRows = intelError
    ? []
    : await loadLocalPurchaseEvents(supabase, subject, buyerEntityIds);
  const purchaseEvents = buildCanonicalPurchaseEvents(
    purchaseEventRows,
    subject,
    familyByEntity,
    buyerClassByFamily,
  );
  const mappedPurchaseEventCount = countGeocodedEvents(purchaseEvents);

  const rankedBuyers = buyerFamilies
    .filter((f) => isEligibleDispositionFamily(f))
    .map((f) => {
      const activity = aggregateFamilyActivity(f.buyerFamilyId, purchaseEvents, subject.zip, subject.radius_miles ?? 25);
      return familyToRankedBuyer(f, activity);
    })
    .sort((a, b) => (num(b.matchScore) ?? 0) - (num(a.matchScore) ?? 0));

  const institutionalPlatforms = buildInstitutionalPlatforms(buyerFamilies, purchaseEvents);
  const marketCounts = buildMarketIntelligenceCounts(buyerFamilies, purchaseEvents);

  const acquisitionContext = resolveAcquisitionContext(subject, context);
  const fallbackLevel = mapFallbackLevel(intel?.fallback_level ?? candidates[0]?.fallback_level ?? 'none');
  const highFitCount = rankedBuyers.filter((b) => b.matchGrade === 'A+' || b.matchGrade === 'A').length;
  const dataState = resolveMarketDataState({
    subject,
    families: buyerFamilies,
    purchaseEvents,
    cached,
    cacheIncomplete,
    intelError,
    rollup: intel?.buyer_rollup,
  });

  const bidRange = repairBidRange(
    buyerDemand.likely_buyer_price_range?.low,
    buyerDemand.likely_buyer_price_range
      ? Math.round((buyerDemand.likely_buyer_price_range.low + buyerDemand.likely_buyer_price_range.high) / 2)
      : null,
    buyerDemand.likely_buyer_price_range?.high,
  );

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
      verifiedBuyerCount: marketCounts.eligibleBuyerFamilies,
      highFitBuyerCount: marketCounts.highFitFamilies,
      activeBuyerCount30d: buyerFamilies.length > 0 ? countActiveFamilies(buyerFamilies, 30) : null,
      activeBuyerCount90d: buyerFamilies.length > 0 ? countActiveFamilies(buyerFamilies, 90) : null,
      activeBuyerCount180d: buyerFamilies.length > 0 ? countActiveFamilies(buyerFamilies, 180) : null,
      institutionalBuyerCount: marketCounts.institutionalPlatforms,
      localRegionalBuyerCount: marketCounts.localRegionalFamilies,
      builderBuyerCount: marketCounts.builderFamilies,
      governmentNonMarketCount: marketCounts.governmentNonMarketFamilies,
      unresolvedIdentityCount: marketCounts.unresolvedIdentities,
      repeatBuyerCount: buyerDemand.repeat_buyer_count ?? null,
      verifiedPurchaseEventCount: marketCounts.uniquePurchaseEvents,
      mappedPurchaseEventCount: mappedPurchaseEventCount > 0 ? mappedPurchaseEventCount : null,
      uniquePurchasedAssetCount: marketCounts.uniquePurchasedAssets,
      packageEventCount: marketCounts.packageEventCount,
      packageAssetCount: marketCounts.packageAssetCount,
      qualifiedSingleAssetCount: marketCounts.qualifiedSingleAssetCount,
      likelyBidLow: bidRange.low,
      likelyBidBase: bidRange.base,
      likelyBidHigh: bidRange.high,
      liquidityScore: intel?.liquidity_score ?? buyerDemand.liquidity_score ?? null,
      demandScore: intel?.demand_score ?? buyerDemand.demand_score ?? null,
      refreshedAt: generatedAt,
      cacheIncomplete: cacheIncomplete || undefined,
      ...marketCounts,
    },
    buyerFamilies,
    rankedBuyers,
    purchaseEvents,
    institutionalPlatforms,
    institutionalActivity: institutionalPlatforms,
    shortlist: [],
    meta: {
      cached,
      query_ms: Date.now() - startedAt,
      model_version: intel?.model_version ?? null,
      error: intelError,
      geocodedEventCount: mappedPurchaseEventCount,
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