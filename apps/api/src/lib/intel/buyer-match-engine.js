/**
 * Geospatial buyer-match intelligence engine (Supabase-native).
 *
 * Drives matching from buyer_purchase_events_v2 via the get_buyer_match_candidates
 * RPC (proximity-weighted, progressive geographic fallback), enriches with the
 * buyer_geo_rollups_v2 demand rollup and nearby comps, scores subject-level
 * demand / liquidity / confidence, and persists buyer_match_runs +
 * buyer_match_candidates.
 *
 * This is the real intelligence layer that replaces the prior Podio-only engine
 * (lib/domain/buyers/match-engine.js never touched these Supabase tables).
 */
import {
  normalizeZip,
  normalizeState,
  normalizeAssetClass,
  normalizeMarket,
} from './normalize.js';
import {
  loadCanonicalSubjectProperty,
  flattenSubjectForConsumers,
} from '@/lib/domain/comp-intelligence/canonical-subject-property.js';
import { buildCanonicalBuyerDemand } from './buyer-match-demand.js';
import {
  BUYER_MATCH_MODEL_VERSION,
  BUYER_MATCH_DATA_VERSION,
  buildIdempotencyKey,
  findFreshBuyerMatchResult,
  jobSnapshotFromSubject,
} from './buyer-match-job-service.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, min = 0, max = 100) => Math.min(Math.max(Number(v) || 0, min), max);

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

/**
 * Normalize an arbitrary subject-property payload into the canonical filter set
 * the engine and RPC operate on.
 */
export function normalizeSubject(subject = {}) {
  const lat = num(subject.lat ?? subject.latitude);
  const lng = num(subject.lng ?? subject.longitude);
  const zip = normalizeZip(subject.zip ?? subject.property_zip);
  const state = normalizeState(subject.state ?? subject.property_state);
  const market = normalizeMarket(
    subject.market,
    subject.city ?? subject.property_city,
    subject.state ?? subject.property_state,
  );
  const asset_class = normalizeAssetClass(
    subject.asset_class ?? subject.normalized_asset_class ?? subject.property_type,
  );
  return {
    property_id: subject.property_id ?? null,
    address: subject.address ?? subject.property_address_full ?? null,
    lat,
    lng,
    zip,
    market,
    state,
    county: subject.county ?? subject.county_name ?? null,
    asset_class,
    property_type: subject.property_type ?? null,
    estimated_value: num(subject.estimated_value),
    arv: num(subject.arv),
    beds: num(subject.beds),
    baths: num(subject.baths),
    sqft: num(subject.sqft),
    units: num(subject.units ?? subject.units_count),
    radius_miles: num(subject.radius_miles) ?? 25,
  };
}

/** Fetch the best-available demand rollup using progressive geographic fallback. */
async function fetchBuyerRollup(supabase, subject) {
  const asset = subject.asset_class || 'all';
  const attempts = [
    subject.zip ? { geo_level: 'zip', geo_key: subject.zip, asset } : null,
    subject.zip ? { geo_level: 'zip', geo_key: subject.zip, asset: 'all' } : null,
    subject.market ? { geo_level: 'market', geo_key: subject.market, asset } : null,
    subject.market ? { geo_level: 'market', geo_key: subject.market, asset: 'all' } : null,
    subject.state ? { geo_level: 'state', geo_key: subject.state, asset } : null,
    subject.state ? { geo_level: 'state', geo_key: subject.state, asset: 'all' } : null,
  ].filter(Boolean);

  for (const a of attempts) {
    const { data, error } = await supabase
      .from('buyer_geo_rollups_v2')
      .select('*')
      .eq('geo_level', a.geo_level)
      .eq('geo_key', a.geo_key)
      .eq('normalized_asset_class', a.asset)
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      return { rollup: data, rollup_level: `${a.geo_level}:${a.asset}` };
    }
  }
  return { rollup: null, rollup_level: null };
}

/** Nearby sold comps from recently_sold_properties (zip-first, then distance-ranked). */
async function fetchComps(supabase, subject, limit = 12) {
  const select =
    'id,property_address_full,property_address_city,property_address_state,property_address_zip,' +
    'sale_price,sale_date,total_bedrooms,total_baths,building_square_feet,price_per_sqft,' +
    'latitude,longitude,property_type';

  let rows = [];
  if (subject.lat !== null && subject.lng !== null) {
    const d = 0.4; // ~27mi bounding box
    const { data } = await supabase
      .from('recently_sold_properties')
      .select(select)
      .gte('latitude', subject.lat - d)
      .lte('latitude', subject.lat + d)
      .gte('longitude', subject.lng - d)
      .lte('longitude', subject.lng + d)
      .limit(400);
    rows = data ?? [];
  }
  if (rows.length === 0 && subject.zip) {
    const { data } = await supabase
      .from('recently_sold_properties')
      .select(select)
      .eq('property_address_zip', subject.zip)
      .limit(200);
    rows = data ?? [];
  }

  return rows
    .map((r) => {
      const distance_miles =
        subject.lat !== null && r.latitude && r.longitude
          ? haversineMiles(subject.lat, subject.lng, num(r.latitude), num(r.longitude))
          : null;
      return {
        id: String(r.id),
        address: r.property_address_full || 'Address Unknown',
        city: r.property_address_city || undefined,
        state: r.property_address_state || undefined,
        zip: r.property_address_zip || undefined,
        sold_price: num(r.sale_price),
        sold_date: r.sale_date || null,
        beds: num(r.total_bedrooms),
        baths: num(r.total_baths),
        sqft: num(r.building_square_feet),
        ppsf: num(r.price_per_sqft),
        latitude: num(r.latitude),
        longitude: num(r.longitude),
        property_type: r.property_type || undefined,
        source_type: 'RECENTLY_SOLD',
        distance_miles: distance_miles !== null ? Math.round(distance_miles * 100) / 100 : null,
      };
    })
    .sort((a, b) => {
      if (a.distance_miles === null) return 1;
      if (b.distance_miles === null) return -1;
      return a.distance_miles - b.distance_miles;
    })
    .slice(0, limit);
}

/** Compute subject-level demand / liquidity / confidence from candidates + rollup. */
function scoreSubject(candidates, rollup, fallbackLevel) {
  const topScores = candidates.slice(0, 5).map((c) => num(c.total_match_score) || 0);
  const avgTop = topScores.length ? topScores.reduce((s, v) => s + v, 0) / topScores.length : 0;
  const heat = num(rollup?.buyer_heat_score) ?? 0;
  const liquidity = num(rollup?.liquidity_score) ?? (candidates.length >= 20 ? 80 : candidates.length >= 5 ? 55 : candidates.length > 0 ? 35 : 0);

  let demand_score = null;
  if (candidates.length > 0) {
    demand_score = Math.round(clamp(0.55 * avgTop + 0.45 * heat));
  } else if (rollup) {
    demand_score = Math.round(clamp(num(rollup.investor_demand_score) ?? heat));
  }

  // Confidence: how trustworthy is this match? Driven by locality + buyer depth.
  const localityWeight =
    fallbackLevel === 'zip' ? 1.0 :
    fallbackLevel === 'radius' ? 0.85 :
    fallbackLevel === 'market' ? 0.6 :
    fallbackLevel === 'county' ? 0.45 :
    fallbackLevel === 'state' ? 0.3 : 0;
  const depthWeight =
    candidates.length >= 20 ? 1.0 :
    candidates.length >= 10 ? 0.8 :
    candidates.length >= 5 ? 0.6 :
    candidates.length > 0 ? 0.4 : 0;
  const confidence = Math.round(clamp(100 * localityWeight * depthWeight));

  return { demand_score, liquidity_score: Math.round(liquidity), confidence };
}

/**
 * Main entry point. Resolves a subject property's buyer demand intelligence and
 * (optionally) persists a run + candidate rows.
 *
 * @param {object}  args
 * @param {object}  args.supabase   Supabase service-role client
 * @param {object}  args.subject    Raw subject-property payload
 * @param {boolean} [args.persist]  Persist buyer_match_runs + candidates (default true)
 * @param {number}  [args.limit]    Max buyers to return (default 25)
 */
/**
 * Resolve subject via canonical Comp Intelligence contract when property_id is present.
 */
export async function resolveBuyerMatchSubject(rawSubject = {}, context = {}, deps = {}) {
  const propertyId = rawSubject.property_id ?? context.property_id ?? null;
  if (propertyId) {
    const loaded = await loadCanonicalSubjectProperty(propertyId, context, deps);
    if (loaded.ok && loaded.subject) {
      const flat = flattenSubjectForConsumers(loaded.subject);
      return {
        ...normalizeSubject({ ...flat, ...rawSubject }),
        coordinate_source: loaded.subject.coordinate_source,
        coordinate_confidence: loaded.subject.coordinate_confidence,
        is_subject_resolved: loaded.subject.is_subject_resolved,
        is_market_fallback: loaded.subject.is_market_fallback,
        canonical_address: flat.canonical_address,
        master_owner_id: flat.master_owner_id,
        opportunity_id: flat.opportunity_id,
        thread_key: flat.thread_key,
        valuation_snapshot_id: context.valuation_snapshot_id ?? null,
        contract_version: loaded.subject.contract_version,
      };
    }
  }
  return normalizeSubject(rawSubject);
}

export async function buildBuyerMatchIntel({
  supabase,
  subject: rawSubject,
  context = {},
  persist = true,
  limit = 25,
  skip_cache = false,
  source_event = 'property_selected',
  deps = {},
}) {
  const startedAt = Date.now();
  const subject = await resolveBuyerMatchSubject(rawSubject, context, { ...deps, db: deps.db ?? supabase });

  const idempotency_key = buildIdempotencyKey({
    property_id: subject.property_id,
    valuation_snapshot_id: subject.valuation_snapshot_id,
  });

  if (!skip_cache && persist && subject.property_id) {
    const cached = await findFreshBuyerMatchResult(supabase, {
      property_id: subject.property_id,
      idempotency_key,
    });
    if (cached) {
      const { data: cachedCandidates } = await supabase
        .from('buyer_match_candidates')
        .select('*')
        .eq('buyer_match_run_id', cached.buyer_match_run_id)
        .order('match_score', { ascending: false })
        .limit(limit);
      const snapshot = cached.selected_property_snapshot ?? {};
      const demand = buildCanonicalBuyerDemand({
        candidates: cachedCandidates ?? [],
        demand_score: cached.demand_score,
        liquidity_score: snapshot.liquidity_score ?? null,
        confidence: snapshot.confidence ?? 0,
        fallback_level: snapshot.fallback_level ?? 'none',
        coordinates_unavailable: !subject.is_subject_resolved,
        generated_at: cached.created_at,
      });
      return {
        subject,
        run_id: cached.buyer_match_run_id,
        top_buyers: cachedCandidates ?? [],
        buyer_matches: cachedCandidates ?? [],
        buyer_rollup: null,
        rollup_level: snapshot.rollup_level ?? null,
        comps: [],
        liquidity: snapshot.liquidity_score,
        liquidity_score: snapshot.liquidity_score,
        demand_score: cached.demand_score,
        confidence: snapshot.confidence ?? 0,
        fallback_level: snapshot.fallback_level ?? 'none',
        buyer_count: cached.buyer_count ?? 0,
        high_fit_count: cached.high_fit_count ?? 0,
        best_buyer_grade: cached.best_buyer_grade ?? null,
        buyer_demand: demand,
        cached: true,
        idempotency_key,
        model_version: BUYER_MATCH_MODEL_VERSION,
        source_counts: {
          buyers: cached.buyer_count ?? 0,
          matches: cached.buyer_count ?? 0,
          high_fit: cached.high_fit_count ?? 0,
          comps: 0,
          fallback_level: snapshot.fallback_level ?? 'none',
          rollup_level: snapshot.rollup_level ?? null,
        },
        generated_at: cached.created_at,
        query_ms: Date.now() - startedAt,
      };
    }
  }

  // 1. Core geospatial match
  const { data: candidates, error: rpcError } = await supabase.rpc('get_buyer_match_candidates', {
    p_property_id: subject.property_id,
    p_lat: subject.lat,
    p_lng: subject.lng,
    p_zip: subject.zip,
    p_market: subject.market,
    p_state: subject.state,
    p_county: subject.county,
    p_asset_class: subject.asset_class,
    p_estimated_value: subject.estimated_value,
    p_radius_miles: subject.radius_miles,
    p_limit: limit,
  });
  if (rpcError) throw rpcError;

  const topBuyers = candidates ?? [];
  const fallbackLevel = topBuyers[0]?.fallback_level ?? 'none';
  const highFitCount = topBuyers.filter((c) => c.match_grade === 'A+' || c.match_grade === 'A').length;

  // 2. Demand rollup + comps (parallel)
  const [{ rollup, rollup_level }, comps] = await Promise.all([
    fetchBuyerRollup(supabase, subject),
    fetchComps(supabase, subject),
  ]);

  // 3. Subject-level scoring
  const { demand_score, liquidity_score, confidence } = scoreSubject(topBuyers, rollup, fallbackLevel);

  const source_counts = {
    buyers: topBuyers.length,
    matches: topBuyers.length,
    high_fit: highFitCount,
    comps: comps.length,
    fallback_level: fallbackLevel,
    rollup_level,
    rollup_purchase_count: num(rollup?.purchase_count) ?? 0,
    rollup_buyer_count: num(rollup?.buyer_count) ?? 0,
  };

  const buyer_demand = buildCanonicalBuyerDemand({
    candidates: topBuyers,
    rollup,
    demand_score,
    liquidity_score,
    confidence,
    fallback_level: fallbackLevel,
    coordinates_unavailable: subject.is_subject_resolved === false,
    subject_incomplete: !subject.property_id || !subject.zip,
    generated_at: new Date().toISOString(),
  });

  // 4. Persist run + candidates
  let run_id = null;
  let persistedCandidates = topBuyers;
  if (persist) {
    const persistResult = await persistRun({
      supabase,
      subject,
      topBuyers,
      rollup,
      demand_score,
      liquidity_score,
      confidence,
      fallbackLevel,
      highFitCount,
      rollup_level,
      idempotency_key,
      source_event,
    });
    run_id = persistResult.run_id;
    persistedCandidates = persistResult.candidates;
  }

  return {
    subject,
    run_id,
    top_buyers: persistedCandidates,
    buyer_matches: persistedCandidates,
    buyer_rollup: rollup,
    rollup_level,
    comps,
    liquidity: liquidity_score,
    liquidity_score,
    demand_score,
    confidence,
    fallback_level: fallbackLevel,
    buyer_count: topBuyers.length,
    high_fit_count: highFitCount,
    best_buyer_grade: topBuyers[0]?.match_grade ?? null,
    buyer_demand,
    idempotency_key,
    model_version: BUYER_MATCH_MODEL_VERSION,
    data_version: BUYER_MATCH_DATA_VERSION,
    source_counts,
    generated_at: new Date().toISOString(),
    query_ms: Date.now() - startedAt,
  };
}

/** Persist a buyer_match_runs row + buyer_match_candidates rows (real schema). */
async function persistRun({
  supabase, subject, topBuyers, rollup, demand_score, liquidity_score,
  confidence, fallbackLevel, highFitCount, rollup_level,
  idempotency_key, source_event = 'property_selected',
}) {
  const snapshot = jobSnapshotFromSubject(subject, {
    idempotency_key,
    model_version: BUYER_MATCH_MODEL_VERSION,
    data_version: BUYER_MATCH_DATA_VERSION,
    valuation_snapshot_id: subject.valuation_snapshot_id ?? null,
    fallback_level: fallbackLevel,
    rollup_level,
    liquidity_score,
    confidence,
    top_buyer_count: topBuyers.length,
    source_event,
  });

  const { data: run, error: runError } = await supabase
    .from('buyer_match_runs')
    .insert({
      property_id: subject.property_id,
      run_status: 'complete',
      selected_property_snapshot: snapshot,
      buyer_count: topBuyers.length,
      high_fit_count: highFitCount,
      demand_score,
      best_buyer_grade: topBuyers[0]?.match_grade ?? null,
    })
    .select('buyer_match_run_id')
    .single();
  if (runError) throw runError;

  const run_id = run.buyer_match_run_id;

  if (topBuyers.length === 0) return { run_id, candidates: [] };

  const rows = topBuyers.map((c) => ({
    buyer_match_run_id: run_id,
    property_id: subject.property_id,
    buyer_entity_id: c.buyer_entity_id,
    buyer_display_name: c.buyer_name,
    buyer_type: c.buyer_type,
    match_score: num(c.total_match_score),
    match_grade: c.match_grade,
    buyer_type_match: subject.asset_class
      ? (c.preferred_asset_classes || []).some((p) => normalizeAssetClass(p) === subject.asset_class)
      : null,
    market_match_score: num(c.market_match_score),
    asset_match_score: num(c.asset_match_score),
    price_match_score: num(c.price_match_score),
    distance_match_score: num(c.market_match_score),
    recency_score: num(c.recency_score),
    repeat_buyer_score: num(c.repeat_buyer_score),
    spread_fit_score: num(c.spread_fit_score),
    reason_for_match: c.reason_for_match,
    suggested_dispo_price: num(c.avg_purchase_price)
      ? Math.round(num(c.avg_purchase_price) * 0.92)
      : null,
    buyer_response_status: 'not_contacted',
    selected: false,
    // Rich display data the candidates table has no dedicated columns for:
    metadata: {
      buyer_key: c.buyer_key,
      distance_miles: num(c.distance_miles),
      matched_purchase_count: num(c.matched_purchase_count),
      zip_purchase_count: num(c.zip_purchase_count),
      market_purchase_count: num(c.market_purchase_count),
      statewide_purchase_count: num(c.statewide_purchase_count),
      avg_purchase_price: num(c.avg_purchase_price),
      median_purchase_price: num(c.median_purchase_price),
      max_purchase_price: num(c.max_purchase_price),
      likely_exit_low: num(c.likely_exit_low),
      likely_exit_high: num(c.likely_exit_high),
      purchase_count: num(c.purchase_count),
      purchase_count_180d: num(c.purchase_count_180d),
      purchase_count_365d: num(c.purchase_count_365d),
      last_purchase_date: c.last_purchase_date,
      first_purchase_date: c.first_purchase_date,
      is_corporate_buyer: c.is_corporate_buyer,
      is_repeat_buyer: c.is_repeat_buyer,
      institutional_score: num(c.institutional_score),
      volume_score: num(c.volume_score),
      mailing_city: c.mailing_city,
      mailing_state: c.mailing_state,
      mailing_zip: c.mailing_zip,
      markets_active: c.markets_active,
      zips_active: c.zips_active,
      counties_active: c.counties_active,
      preferred_asset_classes: c.preferred_asset_classes,
      velocity_score: num(c.velocity_score),
      investor_score: num(c.investor_score),
      avg_potential_spread: num(c.avg_potential_spread),
      fallback_level: c.fallback_level,
    },
  }));

  const { data: inserted, error: candError } = await supabase
    .from('buyer_match_candidates')
    .insert(rows)
    .select('buyer_match_candidate_id, buyer_entity_id');
  if (candError) throw candError;

  // Stitch the inserted PKs back onto the enriched RPC rows for the response.
  const idByEntity = new Map((inserted ?? []).map((r) => [r.buyer_entity_id, r.buyer_match_candidate_id]));
  const candidates = topBuyers.map((c) => ({
    ...c,
    total_match_score: num(c.total_match_score),
    buyer_match_candidate_id: idByEntity.get(c.buyer_entity_id) ?? null,
    buyer_match_run_id: run_id,
    buyer_response_status: 'not_contacted',
    selected: false,
  }));

  return { run_id, candidates };
}

export default { buildBuyerMatchIntel, normalizeSubject, resolveBuyerMatchSubject };
