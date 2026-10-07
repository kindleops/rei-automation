/**
 * ACQUISITION ENGINE V3 (MERGED) — canonical corpus candidates.
 *
 * Source: comp_private.comp_canonical_transactions (recorded deeds + MLS, to the
 * latest import) through the PROPOSED read model
 *   comp_private.mv_v3_sales_candidates + public.get_v3_sales_candidates(...)
 *   public.get_v3_subject_geography(...)
 * (tmp/acq-os/D/PROPOSED_v3_sales_candidates.sql — NOT applied). Until the SQL
 * is applied the loader falls back to the legacy get_comp_candidates_for_subject
 * path (the frozen v_recent_sold_comps pool) and says so in its diagnostics;
 * the shadow backtest feeds the same contract from the read-only harness
 * (scripts/acquisition-v3-merged-shadow-backtest.mjs).
 *
 * One read returns two things:
 *   candidates         the V3 transaction-qualification set (normalizeCandidate
 *                      contract, RPC-like ranked top 100) for the non-investor
 *                      universes (retail MLS, institutional, public record)
 *   investor_evidence  every canonical row inside the lane radius for the merged
 *                      LOCAL_INVESTOR_VALUE rules (investorCompRules.js)
 * Pure helpers are exported for tests; I/O is injectable.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { normalizeCandidate } from './compIdentityEnrichment.js';
import { loadV3CompCandidates } from './compCandidateLoader.js';
import { laneFor, haversineMiles, resolveSubjectGeography } from './investorCompRules.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const realUnits = (v) => (num(v) !== null && num(v) > 0 ? num(v) : null);
const MF_TYPES = ['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'];

export const CANONICAL_CANDIDATE_RPC = 'get_v3_sales_candidates';
export const CANONICAL_SUBJECT_GEO_RPC = 'get_v3_subject_geography';
export const V3_TOP_CANDIDATES = 100;

function monthsBefore(asOf, m) {
  const x = new Date(`${day(asOf)}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() - m);
  return x.toISOString().slice(0, 10);
}

const assetClassOf = (r) => {
  const u = num(r.units) ?? 0;
  if (r.property_type === 'Apartment' && u >= 5) return 'apartment';
  if (MF_TYPES.includes(r.property_type) || u >= 2) return 'multifamily';
  return 'single_family';
};

/**
 * Canonical row -> the normalizeCandidate contract (0535f629 harness adapter).
 * Buyer identity: the recorded deed buyer name when present; otherwise a labelled
 * synthetic entity ONLY where the corpus itself records an investor flag, an
 * entity owner of record linked to that sale, or a cash purchase. Anything else
 * stays identity-unresolved. The full canonical row rides along as canonical_row.
 */
export function canonicalRowToCandidate(r, subject) {
  const mls = r.source === 'mls';
  const ownerEntity = r.owner_linked === true && r.owner_corporate === true;
  let name = r.buyer ? String(r.buyer) : null;
  let basis = name ? 'recorded_buyer_name' : null;
  if (!name && r.is_investor) { name = 'RECORDED INVESTOR BUYER LLC'; basis = 'synthetic_recorded_investor_flag'; }
  else if (!name && ownerEntity) { name = 'OWNER OF RECORD ENTITY LLC'; basis = 'synthetic_owner_entity_linked_to_sale'; }
  else if (!name && r.is_cash_purchase) { name = 'RECORDED CASH BUYER LLC'; basis = 'synthetic_recorded_cash_purchase'; }
  const corporate = Boolean(r.is_investor || ownerEntity || r.is_cash_purchase || (r.buyer_kind && /corp|llc|company|entity|trust/i.test(r.buyer_kind)));
  const d = haversineMiles(num(subject?.latitude), num(subject?.longitude), num(r.lat), num(r.lng));
  const c = {
    comp_id: r.comp_id, property_id: r.property_id, address: r.address, zip: r.zip, city: r.city, state: r.state,
    latitude: num(r.lat), longitude: num(r.lng), asset_class: assetClassOf(r), property_type: r.property_type,
    units_count: num(r.units) > 0 ? num(r.units) : null, sqft: num(r.sqft), beds: num(r.beds), baths: num(r.baths), year_built: num(r.year_built),
    sale_price: num(r.price), sale_date: day(r.sold_on), mls_sold_price: mls ? num(r.price) : null, mls_sold_date: mls ? day(r.sold_on) : null,
    building_condition: null, distance_miles: d === null ? null : Math.round(d * 100) / 100,
    similarity_score: null,
  };
  const raw = name || r.doc_type
    ? { id: r.comp_id, owner_name: name, is_corporate_owner: corporate, document_type: r.doc_type ?? '', sale_price: num(r.price), mls_sold_price: c.mls_sold_price, subdivision_name: r.subdivision_name ?? null }
    : null;
  const out = normalizeCandidate(c, raw, null);
  out.estimated_repair_cost = num(r.estimated_repair_cost);
  out.estimated_value = num(r.estimated_value);
  out._canonical = { buyer_basis: basis, source: r.source, buyer_class: r.buyer_class ?? null };
  return out;
}

/** Rank like get_comp_candidates_for_subject (similarity, recency, distance); top N. */
export function rpcLikeRank(subject, cands, limit = V3_TOP_CANDIDATES) {
  const s = subject ?? {};
  const sim = (c) => 100 - Math.min(35, (Math.abs((c.building_square_feet ?? 0) - (s.sqft ?? 0)) / Math.max(s.sqft ?? 1, 1)) * 35)
    - Math.min(15, Math.abs((c.total_bedrooms ?? 0) - (s.beds ?? 0)) * 5) - Math.min(15, Math.abs((c.total_baths ?? 0) - (s.baths ?? 0)) * 5)
    - Math.min(20, Math.abs((c.year_built ?? 0) - (s.year_built ?? 0)) / 5);
  return cands.map((c) => ({ c, k: sim(c) }))
    .sort((a, b) => b.k - a.k || String(b.c.sale_date).localeCompare(String(a.c.sale_date)) || a.c.distance_miles - b.c.distance_miles)
    .slice(0, limit).map((x) => ({ ...x.c, similarity_score: Math.max(0, Math.round(x.k * 100) / 100) }));
}

/**
 * Canonical row -> the production engine comp shape, so the engine's own comp
 * gates (normalizePropertyFeatures + evaluateCompEligibility) run on every
 * merged investor candidate (ported from currentSalesValuationV2.toEngineComp).
 */
export function canonicalRowToEngineComp(row, subject) {
  const mls = row.source === 'mls';
  const repairKnown = num(row.estimated_repair_cost) !== null;
  const subjectRepairs = num(subject?.estimated_repairs);
  return {
    id: row.comp_id,
    property_id: row.property_id,
    property_address_full: row.address,
    property_address_city: row.city,
    property_address_state: row.state,
    property_address_zip: row.zip,
    latitude: num(row.lat),
    longitude: num(row.lng),
    sale_price: num(row.price),
    sale_date: day(row.sold_on),
    mls_sold_price: mls ? num(row.price) : null,
    mls_sold_date: mls ? day(row.sold_on) : null,
    property_type: row.property_type,
    units_count: realUnits(row.units),
    total_bedrooms: num(row.beds),
    total_baths: num(row.baths),
    building_square_feet: num(row.sqft),
    year_built: num(row.year_built),
    estimated_value: num(row.estimated_value),
    estimated_repair_cost: repairKnown ? num(row.estimated_repair_cost) : subjectRepairs,
    distance_miles: row.distance_miles,
    source: 'mv_map_market_sales',
  };
}

/**
 * The investor-rules subject: normalized engine facts + the subject's tract /
 * county / subdivision (own record first, then the same-point parcel, then the
 * majority of parcels within 0.2 mi) + the REAL unit count (never inferred).
 */
export function investorSubjectFrom({ subject = {}, raw = {}, own = null, neighbors = [] } = {}) {
  const o = own ?? {
    census_tract: raw.situs_census_tract ?? null,
    subdivision_name: raw.subdivision_name ?? null,
    county_name: raw.property_address_county_name ?? raw.property_county_name ?? null,
    lot_sqft: raw.lot_square_feet ?? null,
    units: raw.units_count ?? null,
    property_type: raw.property_type ?? null,
  };
  const geo = resolveSubjectGeography({ own: o, neighbors });
  const mfType = MF_TYPES.includes(o?.property_type);
  const units = num(o?.units) > 0 ? num(o.units) : null;
  return {
    property_id: String(subject.property_id ?? raw.property_id ?? ''),
    latitude: num(subject.latitude), longitude: num(subject.longitude),
    sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built,
    estimated_repairs: subject.estimated_repairs,
    census_tract: geo.census_tract, fips: geo.fips, subdivision_name: geo.subdivision_name,
    lot_sqft: num(o?.lot_sqft),
    units: mfType || (units ?? 0) >= 2 ? units : null,
    condition: raw.building_condition ?? null,
    geo_basis: geo.basis,
  };
}

/**
 * MV-precomputed multi-parcel consideration counts (proposed columns
 * bulk_parcels_zip / bulk_parcels_city) -> the bulkOf predicate. Falls back to
 * null when the columns are absent (then the caller supplies bulkRows).
 */
export function bulkOfFromRowColumns(rows = []) {
  if (!rows.some((r) => r.bulk_parcels_zip != null || r.bulk_parcels_city != null)) return null;
  return (row) => (num(row.bulk_parcels_city) ?? 1) >= 3 || (num(row.bulk_parcels_zip) ?? 1) >= 2;
}

/**
 * Assemble { candidates, investor_evidence } from canonical rows (pure).
 * rows: canonical rows (MV shape); subject: normalized engine subject.
 */
export function assembleCanonicalCandidates({ rows = [], subject = {}, investorSubject, asOf, bulkRows = null }) {
  const lane = laneFor(investorSubject);
  const lat = num(subject.latitude);
  const lng = num(subject.longitude);
  const inRadius = rows.filter((r) => {
    const d = haversineMiles(lat, lng, num(r.lat), num(r.lng));
    return d !== null && d < lane.radiusMiles;
  });
  const kept = inRadius
    .filter((r) => String(r.property_id) !== String(subject.property_id) && r.is_arms_length !== false && !(num(r.portfolio_size) >= 2))
    .map((r) => canonicalRowToCandidate(r, subject));
  const candidates = rpcLikeRank(subject, kept);
  return {
    candidates,
    investor_evidence: {
      subject: investorSubject,
      rows: inRadius,
      bulkRows: bulkRows ?? [],
      bulkOf: bulkOfFromRowColumns(inRadius),
      asOf: day(asOf),
      lane: lane.lane,
    },
    diagnostics: {
      corpus: 'comp_canonical_transactions',
      lane: lane.lane,
      radius_miles: lane.radiusMiles,
      months: lane.months,
      read_rows: rows.length,
      lane_rows: inRadius.length,
      candidate_count: candidates.length,
      newest_sale: inRadius.map((r) => day(r.sold_on)).filter(Boolean).sort().pop() ?? null,
      buyer_basis: candidates.reduce((o, c) => { const k = c._canonical?.buyer_basis ?? 'unresolved'; o[k] = (o[k] ?? 0) + 1; return o; }, {}),
    },
  };
}

const RPC_MISSING = new Set(['PGRST202', '42883', 'PGRST205', '42P01']);

/**
 * Production loader (merged engine). Prefers the PROPOSED canonical RPCs; when
 * they are not applied yet it returns the legacy V3 loader output with
 * diagnostics.corpus = 'legacy_rpc_fallback' and NO investor_evidence (the
 * merged engine then runs its offer math on the legacy universe, labelled).
 */
export async function loadV3MergedCandidates(subject, deps = {}) {
  const db = deps.db ?? getDefaultSupabaseClient();
  const now = deps.now ?? new Date();
  const asOf = day(deps.asOf ?? new Date(now.getTime() + 86_400_000));
  const lat = num(subject?.latitude);
  const lng = num(subject?.longitude);
  const t0 = Date.now();
  const legacy = async (reason) => {
    const out = await loadV3CompCandidates(subject, deps);
    return { ...out, investor_evidence: null, diagnostics: { ...out.diagnostics, corpus: 'legacy_rpc_fallback', fallback_reason: reason } };
  };
  if (lat === null || lng === null) return legacy('subject_no_coordinates');
  const raw = subject.raw ?? {};
  const rpc = deps.runCanonicalRpc ?? (async (name, params) => {
    const { data, error } = await db.rpc(name, params);
    if (error) throw error;
    return data ?? [];
  });
  let geoRows;
  try {
    geoRows = await rpc(CANONICAL_SUBJECT_GEO_RPC, { p_property_id: String(subject.property_id ?? ''), p_lat: lat, p_lng: lng });
  } catch (error) {
    if (RPC_MISSING.has(String(error?.code ?? ''))) return legacy('canonical_rpc_not_applied');
    throw error;
  }
  const own = (geoRows ?? []).find((g) => g.is_subject) ?? null;
  const neighbors = (geoRows ?? []).filter((g) => !g.is_subject);
  const investorSubject = investorSubjectFrom({ subject, raw, own, neighbors });
  const lane = laneFor(investorSubject);
  const rows = await rpc(CANONICAL_CANDIDATE_RPC, {
    p_lat: lat,
    p_lng: lng,
    p_radius_miles: lane.radiusMiles,
    p_since: monthsBefore(asOf, lane.months),
    p_as_of: asOf,
    p_lane: lane.lane === 'sfr' ? 'sfr' : 'mf',
    p_limit: lane.readCap,
  });
  const out = assembleCanonicalCandidates({ rows, subject, investorSubject, asOf });
  return { ...out, diagnostics: { ...out.diagnostics, source_latency_ms: Date.now() - t0, query_count: 2, truncated: rows.length >= lane.readCap, retrieval_tier: `canonical_rpc_${lane.lane}_${lane.radiusMiles}mi_${lane.months}mo` } };
}
