/**
 * CHAMPION REPLICA (offline). Re-implements ONLY the production candidate
 * SEARCH -- the RPC get_comp_candidates_for_subject (fixed window, top-100 by
 * asset_rank, then structural similarity, then sale date, then distance;
 * apps/api/supabase/migrations/20260927210000_comp_candidates_spatial_prefilter.sql)
 * -- with a strict as-of upper bound the production RPC lacks. Scoring,
 * recency, eligibility, outliers, selection and valuation are the production
 * engine's own functions, IMPORTED (never copied): any fix to the engine
 * (e.g. the month-boundary recency step) is picked up automatically, and a
 * pinned engine version can be injected to compare before/after.
 *
 * Point-in-time inputs: the subject row carries no sale price, no vendor
 * estimated_value and no estimated_repair_cost (all post-dated vendor
 * snapshots), so the engine's fallback valuation cannot leak the label and
 * the repair-difference adjustment is inactive for every comp. `fidelity: true`
 * re-enables the import-time repair estimates ONLY to show the replica
 * reproduces production's stored valuations; backtests never set it.
 */
import * as productionEngine from '../../../acquisition/acquisitionDecisionEngine.js';

export const CHAMPION_REPLICA_VERSION = 'champion-replica-v0.1.0';
const EARTH_RADIUS_MILES_RPC = 3958.8;

/** RPC subject normalized_asset_class for a record that has no pool row (the RPC's properties branch). */
export function rpcAssetClassFromProperty(propertyType, units) {
  const type = String(propertyType ?? '');
  const u = Number(units ?? 0) || 0;
  if (type === 'Apartment' && u >= 5) return 'apartment';
  if (['Multi-Family', 'Apartment', 'Duplex', 'Triplex', 'Quadruplex'].includes(type)) return 'multifamily';
  if (u >= 2) return 'multifamily';
  return 'single_family';
}

/** normalized_asset_class as the RPC would see it for a snapshot record. */
export function rpcAssetClass(record) {
  if (record.src === 'pool') return record.nac ?? null;
  const fam = record.nac;
  if (fam === 'mobile_home' || fam === 'condo' || fam === 'land' || fam === 'commercial') return fam;
  if (fam === 'apartment' || fam === 'multifamily' || fam === 'single_family') return fam;
  return rpcAssetClassFromProperty(record.property_type, record.units);
}

function rpcDistanceMiles(sLat, sLng, cLat, cLng) {
  const r = Math.PI / 180;
  const x = Math.cos(sLat * r) * Math.cos(cLat * r) * Math.cos(cLng * r - sLng * r) + Math.sin(sLat * r) * Math.sin(cLat * r);
  return EARTH_RADIUS_MILES_RPC * Math.acos(Math.min(1, Math.max(-1, x)));
}

const c0 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 0 : Number(v));

/** The RPC's similarity_score, term for term (coalesce-to-0 semantics included). */
export function rpcSimilarity(subject, comp) {
  const sSqft = c0(subject.sqft);
  const score =
    100 -
    Math.min(35, (Math.abs(c0(comp.sqft) - sSqft) / Math.max(subject.sqft ?? 1, 1)) * 35) -
    Math.min(15, Math.abs(c0(comp.beds) - c0(subject.beds)) * 5) -
    Math.min(15, Math.abs(c0(comp.baths) - c0(subject.baths)) * 5) -
    Math.min(20, Math.abs(c0(comp.year_built) - c0(subject.year_built)) / 5) -
    (comp.nac !== null && comp.nac !== undefined && comp.nac === subject.nac ? 0 : 20);
  return Math.max(0, Math.round(score * 100) / 100);
}

function rpcFamily(nac) {
  return nac === 'multifamily' || nac === 'apartment' ? 'multi' : 'single';
}

/** The RPC's asset_rank. */
export function rpcAssetRank(subject, comp) {
  const sFamily = rpcFamily(subject.nac);
  if (rpcFamily(comp.nac) !== sFamily) return 2;
  const compUnits = Math.max(Number(comp.units) || 1, 1);
  if (sFamily === 'single' && compUnits <= 1) return 0;
  const subjectUnits = Math.max(Number(subject.units) || 1, 1);
  if (sFamily === 'multi' && compUnits / subjectUnits >= 0.35 && compUnits / subjectUnits <= 2.75) return 0;
  return 1;
}

function subtractMonthsPg(dateText, months) {
  const y = Number(dateText.slice(0, 4));
  const m = Number(dateText.slice(5, 7)) - 1;
  const d = Number(dateText.slice(8, 10));
  const target = y * 12 + m - months;
  const ty = Math.floor(target / 12);
  const tm = target - ty * 12;
  const day = Math.min(d, new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate());
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Discover the engine's search windows from its own exported eligibility gate
 * (eligibilityLimits is not exported), so the replica follows production.
 */
export function probeEngineWindows(engine = productionEngine) {
  const now = new Date('2026-01-15T12:00:00Z');
  const probe = (subjectRow) => {
    const subject = engine.normalizePropertyFeatures(subjectRow, { source: 'properties', now });
    const passes = (extra) => {
      const comp = engine.normalizePropertyFeatures({ ...subjectRow, property_id: 'probe-comp', sale_price: 200_000 }, { source: 'v_recent_sold_comps', now });
      const verdict = engine.evaluateCompEligibility(subject, { ...comp, ...extra }, now, {});
      return !verdict.reasons.includes('outside_radius') && !verdict.reasons.includes('sale_too_old');
    };
    let radius = null;
    for (let d = 0.5; d <= 30; d += 0.5) if (passes({ distance_miles: d, sale_age_months: 1 })) radius = d;
    let months = null;
    for (let m = 1; m <= 96; m += 1) if (passes({ distance_miles: 0.1, sale_age_months: m })) months = m;
    return { family: subject.asset_family, radius_miles: radius, months_back: months };
  };
  const base = { latitude: 40, longitude: -90, property_address_zip: '00000', building_square_feet: 1500, total_bedrooms: 3, total_baths: 2, year_built: 1960 };
  return {
    residential: probe({ ...base, property_id: 'probe-sfr', property_type: 'Single Family', units_count: 1 }),
    multifamily: probe({ ...base, property_id: 'probe-mf', property_type: 'Multi-Family', units_count: 3, building_square_feet: 3000 }),
  };
}

/**
 * Engine-shaped subject row from a sale record: attributes only, no price, no
 * vendor value. `fidelity` (replica-vs-production check only) passes the
 * import-time vendor repair estimate the production engine reads.
 */
export function subjectRowFromRecord(record, { fidelity = false } = {}) {
  return {
    property_id: record.pid ?? record.id,
    latitude: record.lat,
    longitude: record.lng,
    property_address_zip: record.zip,
    property_address_state: record.state,
    property_type: record.property_type,
    normalized_asset_class: rpcAssetClass(record),
    units_count: record.units,
    building_square_feet: record.sqft,
    total_bedrooms: record.beds,
    total_baths: record.baths,
    year_built: record.year_built,
    effective_year_built: record.eff_year_built ?? null,
    lot_square_feet: record.lot_sqft,
    ...(record.eng ?? {}),
    estimated_value: null,
    estimated_repair_cost: fidelity ? record.est_repairs ?? null : null,
  };
}

/** Engine-shaped comp row (the RPC row merged with RPC_COMP_DETAIL_SELECT columns). */
export function compRowFromRecord(record, distanceMiles, { fidelity = false } = {}) {
  return {
    ...(record.eng ?? {}),
    id: record.id,
    comp_id: record.id,
    property_id: record.pid,
    address: null,
    property_address_zip: record.zip,
    property_address_state: record.state,
    latitude: record.lat,
    longitude: record.lng,
    normalized_asset_class: rpcAssetClass(record),
    property_type: record.property_type,
    total_bedrooms: record.beds,
    total_baths: record.baths,
    building_square_feet: record.sqft,
    lot_square_feet: record.lot_sqft,
    units_count: record.units,
    year_built: record.year_built,
    effective_year_built: record.eff_year_built ?? null,
    sale_price: record.src === 'pool' ? record.view_sale_price ?? record.price : record.price,
    sale_date: record.deed_date ?? record.sale_date,
    mls_sold_price: record.mls_price ?? null,
    mls_sold_date: record.mls_date ?? null,
    estimated_value: record.est_value ?? null,
    estimated_repair_cost: fidelity ? record.est_repairs ?? null : null,
    distance_miles: Math.round(distanceMiles * 100) / 100,
    source: 'v_recent_sold_comps',
  };
}

/**
 * Offline RPC: candidates for `subjectRecord` among `records` as of `asOf`.
 * `records` are snapshot records (raw schema). Production filters are kept
 * (usable comp, distinct property, window lower bound on the view's
 * sale_date, radius) and the as-of bound known_date < asOf is added.
 */
export function championSearch({ subjectRecord, asOf, records, windows }) {
  const subject = {
    nac: rpcAssetClass(subjectRecord),
    sqft: subjectRecord.sqft ?? null,
    beds: subjectRecord.beds ?? null,
    baths: subjectRecord.baths ?? null,
    year_built: subjectRecord.year_built ?? null,
    units: subjectRecord.units ?? null,
  };
  const window = rpcFamily(subject.nac) === 'multi' ? windows.multifamily : windows.residential;
  const lowerBound = subtractMonthsPg(asOf, window.months_back);
  const rows = [];
  for (const r of records) {
    if (!r.usable_comp || !(r.known_date < asOf)) continue;
    if (subjectRecord.pid && r.pid === subjectRecord.pid) continue;
    if (r.id === subjectRecord.id) continue;
    const windowDate = r.deed_date ?? r.sale_date;
    if (!(windowDate >= lowerBound)) continue;
    const d = rpcDistanceMiles(subjectRecord.lat, subjectRecord.lng, r.lat, r.lng);
    if (d > window.radius_miles) continue;
    const comp = { nac: rpcAssetClass(r), sqft: r.sqft, beds: r.beds, baths: r.baths, year_built: r.year_built, units: r.units };
    rows.push({ r, d, rank: rpcAssetRank(subject, comp), sim: rpcSimilarity(subject, comp), date: windowDate });
  }
  rows.sort((a, b) =>
    a.rank - b.rank ||
    b.sim - a.sim ||
    (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
    a.d - b.d ||
    (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  return { window, lower_bound: lowerBound, total_in_window: rows.length, candidates: rows.slice(0, 100) };
}

/**
 * Value one subject with the production engine on replica candidates.
 * Returns the engine's own valuation plus geography diagnostics.
 */
export function valueSubjectChampion({ subjectRecord, asOf, records, windows, engine = productionEngine, fidelity = false }) {
  const search = championSearch({ subjectRecord, asOf, records, windows });
  const comps = search.candidates.map((c) => compRowFromRecord(c.r, c.d, { fidelity }));
  const decision = engine.calculateAcquisitionDecision({
    subject: subjectRowFromRecord(subjectRecord, { fidelity }),
    comps,
    buyerPurchases: [],
    now: new Date(`${asOf}T12:00:00.000Z`),
    v3Enabled: false,
  });
  const valuation = decision.valuation ?? {};
  const method = valuation.calculation?.method ?? null;
  const byId = new Map(search.candidates.map((c) => [c.r.id, c.r]));
  const selected = (decision.selected_comps ?? []).map((s) => {
    const rec = byId.get(s.comp?.source_id);
    return {
      id: s.comp?.source_id ?? null,
      weight: s.weight,
      adjusted_price: s.adjusted_price,
      distance_miles: s.comp?.distance_miles ?? null,
      zip: rec?.zip ?? null,
      lat: rec?.lat ?? null,
      lng: rec?.lng ?? null,
      sale_source: s.comp?.sale_source ?? null,
      src: rec?.src ?? null,
    };
  });
  const rejected = {};
  for (const r of decision.rejected_comps ?? []) {
    const key = r.reasons?.[0] ?? 'rejected';
    rejected[key] = (rejected[key] ?? 0) + 1;
  }
  return {
    replica: CHAMPION_REPLICA_VERSION,
    value: method === 'weighted_adjusted_comp_value' ? valuation.mid : null,
    low: method === 'weighted_adjusted_comp_value' ? valuation.low : null,
    high: method === 'weighted_adjusted_comp_value' ? valuation.high : null,
    confidence: valuation.confidence ?? null,
    method,
    window: search.window,
    raw_candidate_count: search.candidates.length,
    in_window_count: search.total_in_window,
    selected,
    rejected_by_reason: rejected,
    outlier_method: decision.evidence?.outlier_method ?? null,
  };
}
