/**
 * CURRENT-SALES VALUATION v2 — SHADOW ONLY (owner-approved 2026-10-04).
 *
 * Values a subject from the canonical recorded sales (public.mv_map_market_sales)
 * with the production acquisition engine, side by side with the frozen engine
 * pool. Nothing here is wired into scoring, offers, crons or routes, and
 * nothing here writes. The production engine is imported, never modified: its
 * default behaviour is byte-identical (tests/unit/current-sales-valuation-v2.test.mjs).
 *
 * WHY v2. The 2026-10-04 shadow comparison (259 subjects) showed the quick
 * connector (buyer-match nearest-100) lowered values a median 13.7% and offers
 * 18.5%, ~74% of it one artifact: canonical sales carry no repair estimate and
 * the engine reads an unknown comp repair cost as $0, marking every comp down
 * by the subject's whole repair estimate. v2 fixes the evidence, not the engine:
 *
 *   1. Unknown comp repairs are UNKNOWN: no repair adjustment (the comp carries
 *      the subject's estimate so repair_difference = 0), reason recorded.
 *   2. Candidates are ranked exactly like get_comp_candidates_for_subject
 *      (asset rank, clamped similarity, recency, distance; top 100), in JS.
 *   3. One economic sale per parcel and date (MLS close > recorded deed > other).
 *   4. Bulk / portfolio / non-arm's-length deeds and implausible considerations
 *      are excluded from valuation evidence.
 *   5. Minimum-comp guard for 5+ units: fewer than 3 selected comps is not a
 *      comp-backed value (the engine's own no-comps path is used instead).
 *   6. Every candidate keeps its exact inclusion / exclusion reason.
 *   7. (v2.1, owner 2026-10-04: "real positive unit count or no price-per-unit
 *      calculation. No inferred 1. No invented values.") A unit count is a
 *      fact only when it is a real positive number on the record; null, 0 and
 *      negatives are UNKNOWN and are never turned into 1. Per-unit pricing needs
 *      a real count on BOTH sides (the engine's own guard, now fed only real
 *      counts); for a 5+ unit subject a comp with an unknown count is excluded
 *      outright, because without it nothing ties the sale's price to a door count.
 */
import {
  calculateAcquisitionDecision,
  normalizePropertyFeatures,
} from '../acquisitionDecisionEngine.js';

export const CURRENT_SALES_V2 = Object.freeze({
  version: 'current-sales-valuation-v2.1-shadow',
  source: 'mv_map_market_sales',
  candidateLimit: 100, // the RPC's p_limit
  bulkCheckDepth: 600, // ranked rows whose consideration is checked for multi-parcel deeds
  readCap: 8000,
  minCompsMf5: 3,
  mf5Units: 5,
  maxPriceToValue: 10, // the engine already rejects < 0.25 (nominal); this is the high side
  // Measured 2026-10-04: the corpus records ~365 sales a day, so a round price
  // on one date repeats across the country by coincidence. Multi-parcel
  // consideration is therefore judged locally: 2+ parcels in one zip, or 3+ in
  // one city. (Corpus-wide counts flagged 12% of a Minneapolis radius.)
  bulkSameCityParcels: 3,
  bulkSameZipParcels: 2,
});

export const V2_REASONS = Object.freeze({
  unpriced: 'v2_unpriced_activity_only',
  duplicate: 'v2_duplicate_economic_sale',
  nonArms: 'v2_non_arms_length',
  portfolio: 'v2_portfolio_deed',
  bulk: 'v2_bulk_multi_parcel_consideration',
  ratio: 'v2_price_to_value_implausible',
  outsideRadius: 'v2_outside_radius',
  unitsUnknownMf5: 'v2_unit_count_unknown_for_5plus_subject',
  outsideLimit: 'v2_outside_candidate_limit',
  guard: 'v2_min_comp_guard_mf5',
});

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

export function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => !Number.isFinite(v))) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The RPC's class vocabulary for a canonical sale (land/other kept distinct). */
export function rpcAssetClass(propertyType, units) {
  const t = text(propertyType);
  if (t === 'Vacant Land') return 'land';
  if (t === 'Other') return 'other';
  if (t === 'Apartment' && (num(units) ?? 0) >= 5) return 'apartment';
  if (['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(t)) return 'multifamily';
  if ((num(units) ?? 0) >= 2) return 'multifamily';
  return 'single_family';
}

/** get_comp_candidates_for_subject similarity, verbatim (clamped at 0, 2 dp). */
export function rpcSimilarity(subject, comp) {
  const z = (v) => num(v) ?? 0;
  const raw = 100
    - Math.min(35, (Math.abs(z(comp.sqft) - z(subject.sqft)) / Math.max(num(subject.sqft) ?? 1, 1)) * 35)
    - Math.min(15, Math.abs(z(comp.beds) - z(subject.beds)) * 5)
    - Math.min(15, Math.abs(z(comp.baths) - z(subject.baths)) * 5)
    - Math.min(20, Math.abs(z(comp.year_built) - z(subject.year_built)) / 5)
    - (comp.cls === subject.cls ? 0 : 20);
  return Math.max(0, Math.round(raw * 100) / 100);
}

/** get_comp_candidates_for_subject asset_rank (+ land/other last for a built subject). */
export function rpcAssetRank(subject, comp) {
  if ((comp.cls === 'land' || comp.cls === 'other') && subject.cls !== 'land' && subject.cls !== 'other') return 3;
  const multi = (c) => c === 'multifamily' || c === 'apartment';
  const subjectFamily = multi(subject.cls) ? 'multi' : 'single';
  const compFamily = multi(comp.cls) ? 'multi' : 'single';
  if (compFamily !== subjectFamily) return 2;
  // v2.1: the RPC's coalesce(nullif(units, 0), 1) is NOT reproduced. An unknown
  // count is unknown: it never ranks as a 1-unit match.
  const compUnits = realUnits(comp.units);
  const subjectUnits = realUnits(subject.units);
  if (subjectFamily === 'single') {
    if (compUnits === null) return 0; // single-family by its recorded type, count not asserted
    return compUnits <= 1 ? 0 : 1;
  }
  if (compUnits === null || subjectUnits === null) return 1; // no unit band can be judged
  const ratio = compUnits / subjectUnits;
  return ratio >= 0.35 && ratio <= 2.75 ? 0 : 1;
}

/** A unit count is a fact only when it is a real positive number. Never defaults. */
export function realUnits(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/** RPC order: asset rank asc, similarity desc, sale date desc, distance asc. */
export function rankLikeEngineRpc(subjectKey, rows) {
  return rows
    .map((r) => {
      const c = { cls: rpcAssetClass(r.property_type, r.units), sqft: r.sqft, beds: r.beds, baths: r.baths, year_built: r.year_built, units: r.units };
      return { ...r, rpc_asset_rank: rpcAssetRank(subjectKey, c), rpc_similarity: rpcSimilarity(subjectKey, c) };
    })
    .sort((a, b) => a.rpc_asset_rank - b.rpc_asset_rank
      || b.rpc_similarity - a.rpc_similarity
      || String(b.sold_on).localeCompare(String(a.sold_on))
      || (a.distance_miles ?? 1e9) - (b.distance_miles ?? 1e9)
      || String(a.comp_id).localeCompare(String(b.comp_id)));
}

/** The subject in the RPC's terms (class from the record's own vocabulary). */
export function subjectRankKey(rawSubject = {}, subject = {}) {
  return {
    cls: rpcAssetClass(rawSubject.property_type, rawSubject.units_count),
    sqft: subject.sqft, beds: subject.beds, baths: subject.baths, year_built: subject.year_built,
    units: realUnits(rawSubject.units_count),
  };
}

const SOURCE_PREFERENCE = (r) => (r.source === 'mls' ? 0 : String(r.comp_id).startsWith('t:') ? 1 : 2);

/** One economic sale per parcel and date. Returns { kept, duplicates:[{row, kept_id}] }. */
export function dedupeEconomicSales(rows) {
  const groups = new Map();
  for (const r of rows) {
    const parcel = text(r.property_id) || `addr:${text(r.address).toLowerCase()}`;
    const key = `${parcel}|${day(r.sold_on)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const kept = [];
  const duplicates = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => SOURCE_PREFERENCE(a) - SOURCE_PREFERENCE(b) || String(a.comp_id).localeCompare(String(b.comp_id)));
    kept.push(ordered[0]);
    for (const d of ordered.slice(1)) duplicates.push({ row: d, kept_id: ordered[0].comp_id });
  }
  return { kept, duplicates };
}

/**
 * Multi-parcel consideration: the same (date, price) recorded on 2+ parcels in
 * one zip or 3+ in one city (the engine's own package arithmetic, applied to the
 * whole canonical corpus rather than one subject's 100-row list).
 * bulkRows: [{ sold_on, price, zip, city, state, parcels }] grouped by date, price, zip, city, state.
 */
export function bulkConsiderationIndex(bulkRows = []) {
  const sameCity = new Map();
  const sameZip = new Map();
  const cityKey = (r) => `${text(r.city).toLowerCase()}|${text(r.state).toUpperCase()}`;
  for (const b of bulkRows) {
    const key = `${day(b.sold_on)}|${num(b.price)}`;
    const n = num(b.parcels) ?? 0;
    sameCity.set(`${key}|${cityKey(b)}`, (sameCity.get(`${key}|${cityKey(b)}`) ?? 0) + n);
    const z = `${key}|${text(b.zip).slice(0, 5)}`;
    sameZip.set(z, (sameZip.get(z) ?? 0) + n);
  }
  return (row) => {
    const key = `${day(row.sold_on)}|${num(row.price)}`;
    const cityCount = sameCity.get(`${key}|${cityKey(row)}`) ?? 1;
    const zipCount = sameZip.get(`${key}|${text(row.zip).slice(0, 5)}`) ?? 1;
    const bulk = cityCount >= CURRENT_SALES_V2.bulkSameCityParcels || zipCount >= CURRENT_SALES_V2.bulkSameZipParcels;
    return { bulk, same_city_parcels: cityCount, same_zip_parcels: zipCount };
  };
}

/** Evidence qualification (deed-level). Returns the exclusion reasons, [] when usable. */
export function qualificationReasons(row, bulkOf = null, subjectUnits = null) {
  const reasons = [];
  const sUnits = realUnits(subjectUnits);
  if (sUnits !== null && sUnits >= CURRENT_SALES_V2.mf5Units && realUnits(row.units) === null) reasons.push(V2_REASONS.unitsUnknownMf5);
  if (row.is_arms_length === false) reasons.push(V2_REASONS.nonArms);
  if ((num(row.portfolio_size) ?? 1) >= 2) reasons.push(V2_REASONS.portfolio);
  const ev = num(row.estimated_value);
  if (ev && ev > 0 && num(row.price) / ev > CURRENT_SALES_V2.maxPriceToValue) reasons.push(V2_REASONS.ratio);
  if (bulkOf && bulkOf(row).bulk) reasons.push(V2_REASONS.bulk);
  return reasons;
}

/** Canonical sale -> the row shape the engine normalizes. Unknown repairs stay unknown. */
export function toEngineComp(row, subject) {
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
    units_count: realUnits(row.units), // never 0, never an inferred 1
    total_bedrooms: num(row.beds),
    total_baths: num(row.baths),
    building_square_feet: num(row.sqft),
    year_built: num(row.year_built),
    estimated_value: num(row.estimated_value),
    // UNKNOWN, not $0: carrying the subject's own estimate makes the engine's
    // repair_difference exactly 0 for this comp. When the subject has none
    // either, both stay null and the engine skips the adjustment itself.
    estimated_repair_cost: repairKnown ? num(row.estimated_repair_cost) : subjectRepairs,
    distance_miles: row.distance_miles,
    source: CURRENT_SALES_V2.source,
    _v2: {
      repair_basis: repairKnown ? 'comp_estimate' : subjectRepairs === null ? 'both_unknown' : 'unknown_no_adjustment',
      rpc_similarity: row.rpc_similarity ?? null,
      rpc_asset_rank: row.rpc_asset_rank ?? null,
      rank: row.v2_rank ?? null,
      txn_id: row.txn_id ?? null,
      doc_type: row.doc_type ?? null,
      is_arms_length: row.is_arms_length ?? null,
      portfolio_size: row.portfolio_size ?? null,
      price_source: row.price_source ?? null,
      sale_source: row.source ?? null,
    },
  };
}

/**
 * Pure selection: raw MV rows in the bbox -> the engine candidate list and a
 * full ledger of what was excluded and why. `bulkOf` may be null when the
 * multi-parcel check has not been run (then the caller runs it on
 * `needsBulkCheck` and calls again).
 */
export function selectCurrentSalesCandidates({ rows, subject, rawSubject, radiusMiles, bulkOf = null }) {
  const key = subjectRankKey(rawSubject, subject);
  const ledger = [];
  const inRadius = [];
  let outsideRadius = 0;
  for (const r of rows) {
    const d = haversineMiles(num(subject.latitude), num(subject.longitude), num(r.lat), num(r.lng));
    if (d === null || d > radiusMiles) { outsideRadius += 1; continue; }
    inRadius.push({ ...r, distance_miles: Math.round(d * 100) / 100 });
  }
  const priced = [];
  for (const r of inRadius) {
    if (num(r.price) > 0) priced.push(r);
    else ledger.push({ row: r, status: 'excluded', reasons: [V2_REASONS.unpriced] });
  }
  const { kept, duplicates } = dedupeEconomicSales(priced);
  for (const d of duplicates) ledger.push({ row: d.row, status: 'excluded', reasons: [V2_REASONS.duplicate], kept_id: d.kept_id });
  const ranked = rankLikeEngineRpc(key, kept);
  const candidates = [];
  let rank = 0;
  for (const r of ranked) {
    rank += 1;
    const row = { ...r, v2_rank: rank };
    const reasons = qualificationReasons(row, bulkOf, rawSubject?.units_count ?? subject?.units);
    if (reasons.length) { ledger.push({ row, status: 'excluded', reasons }); continue; }
    if (candidates.length >= CURRENT_SALES_V2.candidateLimit) { ledger.push({ row, status: 'excluded', reasons: [V2_REASONS.outsideLimit] }); continue; }
    candidates.push(row);
  }
  return {
    candidates,
    ledger,
    needsBulkCheck: ranked.slice(0, CURRENT_SALES_V2.bulkCheckDepth).map((r) => ({ sold_on: day(r.sold_on), price: num(r.price) })),
    census: { rows_read: rows.length, outside_radius: outsideRadius, in_radius: inRadius.length, priced: priced.length, economic_sales: kept.length, duplicates: duplicates.length },
  };
}

/** Is this decision comp-backed under the 5+ unit guard? */
export function minCompGuardApplies(subject, decision) {
  const units = num(subject?.units);
  if (!(units !== null && units >= CURRENT_SALES_V2.mf5Units)) return false;
  return (decision?.selected_comps?.length ?? 0) < CURRENT_SALES_V2.minCompsMf5;
}

/**
 * The guard as a decision transform, usable on either pool: a 5+ unit subject
 * with fewer than 3 selected comps is re-run through the engine's own no-comps
 * path (record-estimate fallback, confidence cap) instead of trusting 1-2 sales.
 */
export function withMinCompGuard({ subject, buyerPurchases = [], now, decision, decide = calculateAcquisitionDecision }) {
  if (!minCompGuardApplies(subject, decision)) return { decision, guard: { applied: false } };
  const guarded = decide({ subject, comps: [], buyerPurchases, now, v3Enabled: false });
  return { decision: guarded, guard: { applied: true, reason: V2_REASONS.guard, selected_before: decision.selected_comps.length } };
}

/** Full v2 valuation for one subject from already-read rows. Pure; no I/O. */
export function valueWithCurrentSalesV2({ rawSubject, subject: maybeSubject, rows, bulkRows = [], radiusMiles, buyerPurchases = [], now, decide = calculateAcquisitionDecision }) {
  const subject = maybeSubject?.asset_family ? maybeSubject : normalizePropertyFeatures(rawSubject, { source: 'properties', now });
  const bulkOf = bulkConsiderationIndex(bulkRows);
  const sel = selectCurrentSalesCandidates({ rows, subject, rawSubject, radiusMiles, bulkOf });
  const comps = sel.candidates.map((r) => toEngineComp(r, subject));
  const decision = decide({ subject, comps, buyerPurchases, now, v3Enabled: false });
  const guarded = withMinCompGuard({ subject, buyerPurchases, now, decision, decide });
  return { subject, decision, guarded: guarded.decision, guard: guarded.guard, ledger: sel.ledger, census: sel.census, candidates: sel.candidates };
}

// ── read-only SQL (the caller runs these in BEGIN READ ONLY, statement_timeout 30s) ──

/** $1 lat, $2 lng, $3 radius mi, $4 since (incl), $5 as-of (excl), $6 cap. */
export const CURRENT_SALES_ROWS_SQL = `
select comp_id, txn_id, source, sold_on::text sold_on, price::float8 price, lat, lng, property_id, address, city, state, zip,
  property_type, beds::float8 beds, baths::float8 baths, sqft::float8 sqft, year_built, units::float8 units,
  estimated_value::float8 estimated_value, portfolio_size, doc_type, is_arms_length, buyer_class, price_source
from public.mv_map_market_sales
where sold_on >= $4::date and sold_on < $5::date
  and lat between $1::float8 - $3::float8 / 68.5 and $1::float8 + $3::float8 / 68.5
  and lng between $2::float8 - $3::float8 / (68.5 * greatest(cos(radians($1::float8)), 0.05))
              and $2::float8 + $3::float8 / (68.5 * greatest(cos(radians($1::float8)), 0.05))
order by sold_on desc
limit $6`;

/** $1 dates[], $2 prices[] -> parcels per (date, price, zip, city, state) across the whole corpus. */
export const BULK_CONSIDERATION_SQL = `
with k as (select distinct d, p from unnest($1::date[], $2::float8[]) as t(d, p))
select m.sold_on::text sold_on, m.price::float8 price, left(m.zip, 5) zip, m.city, m.state, count(distinct m.property_id)::int parcels
from public.mv_map_market_sales m join k on m.sold_on = k.d and m.price::float8 = k.p
group by 1, 2, 3, 4, 5`;

/**
 * The frozen engine pool AS OF a date (backtest only): get_comp_candidates_for_subject
 * verbatim, with current_date -> $5 and sales strictly before $5, returning the
 * engine's detail columns too ($1 subject id, $2 radius, $3 months, $4 limit).
 */
export const OLD_POOL_AS_OF_SQL = `
with subject as (
  select property_id, latitude, longitude, normalized_asset_class, property_type, total_bedrooms, total_baths, building_square_feet, year_built, units_count
  from public.v_recent_sold_comps where property_id = $1
  union all
  select property_id, latitude, longitude,
    case when property_type = 'Apartment' and coalesce(units_count, 0) >= 5 then 'apartment'
         when property_type in ('Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex') then 'multifamily'
         when coalesce(units_count, 0) >= 2 then 'multifamily' else 'single_family' end,
    property_type, total_bedrooms, total_baths, building_square_feet, year_built::numeric, units_count::numeric
  from public.properties
  where property_id = $1 and not exists (select 1 from public.v_recent_sold_comps where property_id = $1)
  limit 1
),
subject_family as (
  select s.*, case when s.normalized_asset_class in ('multifamily', 'apartment') then 'multi' else 'single' end as family,
    greatest(coalesce(nullif(s.units_count, 0), 1), 1)::numeric as family_units
  from subject s
),
candidates as (
  select c.*,
    (3958.8 * acos(least(1, greatest(-1, cos(radians(s.latitude)) * cos(radians(c.latitude)) * cos(radians(c.longitude) - radians(s.longitude))
      + sin(radians(s.latitude)) * sin(radians(c.latitude)))))) as distance_raw,
    (100::numeric
      - least(35::numeric, abs(coalesce(c.building_square_feet, 0) - coalesce(s.building_square_feet, 0)) / greatest(coalesce(s.building_square_feet, 1), 1) * 35)
      - least(15::numeric, abs(coalesce(c.total_bedrooms, 0) - coalesce(s.total_bedrooms, 0)) * 5)
      - least(15::numeric, abs(coalesce(c.total_baths, 0) - coalesce(s.total_baths, 0)) * 5)
      - least(20::numeric, abs(coalesce(c.year_built, 0) - coalesce(s.year_built, 0)) / 5)
      - case when c.normalized_asset_class = s.normalized_asset_class then 0::numeric else 20::numeric end) as similarity_raw,
    case when (case when c.normalized_asset_class in ('multifamily', 'apartment') then 'multi' else 'single' end) <> s.family then 2
         when s.family = 'single' and coalesce(nullif(c.units_count, 0), 1) <= 1 then 0
         when s.family = 'multi' and greatest(coalesce(nullif(c.units_count, 0), 1), 1) / s.family_units between 0.35 and 2.75 then 0
         else 1 end as asset_rank
  from public.v_recent_sold_comps c cross join subject_family s
  where c.is_usable_comp = true
    and c.latitude between s.latitude - ($2 / 68.5) and s.latitude + ($2 / 68.5)
    and c.longitude between s.longitude - ($2 / (68.5 * greatest(cos(radians(s.latitude::double precision)), 0.05)))
                        and s.longitude + ($2 / (68.5 * greatest(cos(radians(s.latitude::double precision)), 0.05)))
    and c.property_id is distinct from s.property_id
    and c.sale_date >= $5::date - make_interval(months => $3)
    and c.sale_date < $5::date
    and c.latitude is not null and c.longitude is not null
)
select id::text as comp_id, property_id, property_address_full as address, property_address_city as city, property_address_state as state,
  property_address_zip as zip, latitude::float8 latitude, longitude::float8 longitude, sale_price::float8 sale_price, sale_date::text sale_date,
  mls_sold_price::float8 mls_sold_price, mls_sold_date::text mls_sold_date, estimated_value::float8 estimated_value,
  normalized_asset_class, property_type, property_class, total_bedrooms::float8 total_bedrooms, total_baths::float8 total_baths,
  building_square_feet::float8 building_square_feet, lot_square_feet::float8 lot_square_feet, units_count::float8 units_count,
  year_built::float8 year_built, effective_year_built::float8 effective_year_built, building_condition, construction_type,
  estimated_repair_cost::float8 estimated_repair_cost, renovation_level_classification, computed_ppsf::float8 computed_ppsf,
  comp_confidence_score::float8 comp_confidence_score, deal_grade, property_address_county_name, subdivision_name, school_district_name,
  zoning, flood_zone, building_quality, exterior_walls, interior_walls, floor_cover, roof_cover, roof_type, basement, garage, pool, porch,
  patio, deck, driveway, stories, style, air_conditioning, heating_type, heating_fuel_type, sewer, water,
  round(distance_raw::numeric, 2)::float8 as distance_miles,
  greatest(0::numeric, round(similarity_raw::numeric, 2))::float8 as similarity_score
from candidates
where distance_raw <= $2
order by asset_rank asc, greatest(0::numeric, round(similarity_raw::numeric, 2)) desc nulls last, sale_date desc nulls last, distance_raw asc
limit least(greatest($4, 1), 100)`;

/** OLD_POOL_AS_OF_SQL rows -> the engine loader's merged comp shape. */
export function oldPoolRowToEngineComp(row) {
  return { ...row, id: row.comp_id, address: row.address, distance_miles: row.distance_miles, source: 'v_recent_sold_comps' };
}

export default {
  CURRENT_SALES_V2, V2_REASONS, valueWithCurrentSalesV2, selectCurrentSalesCandidates, dedupeEconomicSales,
  qualificationReasons, bulkConsiderationIndex, rankLikeEngineRpc, toEngineComp, withMinCompGuard, minCompGuardApplies, realUnits,
};
